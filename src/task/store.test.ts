import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, TaskStore, migrate, sleep } from './store';
import type { MusterTask, TaskStoreFile } from './types';

const tempDirs: string[] = [];

function makeTempStore(): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-task-store-'));
  tempDirs.push(dir);
  return { dir, filePath: path.join(dir, '.muster-tasks.json') };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleTask(id: string): MusterTask {
  return {
    id,
    role: 'coordinator',
    lifecycle: 'open',
    goal: 'test',
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: {
      maxTurns: 10,
      maxAutomaticRetries: 1,
      turnTimeoutMs: 1_000,
      taskTimeoutMs: 5_000,
    },
    revision: 0,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
  };
}

describe('TaskStore', () => {
  it('initializes rev-0 on ENOENT and creates file on first commit', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    expect(store.getFile().revision).toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);

    const commit = store.commit((draft) => {
      draft.tasks['task-1'] = sampleTask('task-1');
      return { ok: true };
    });
    expect(commit.ok).toBe(true);
    if (commit.ok) {
      expect(commit.revision).toBe(1);
    }
    expect(fs.existsSync(filePath)).toBe(true);
  });

  function commitFromProcess(filePath: string, taskId: string): Promise<{ ok: boolean; revision: number }> {
    return new Promise((resolve, reject) => {
      const script = `
        import { TaskStore } from './src/task/store.ts';
        const store = TaskStore.load({ filePath: ${JSON.stringify(filePath)}, lockMaxWaitMs: 10_000 });
        const result = store.commit((draft) => {
          draft.tasks[${JSON.stringify(taskId)}] = ${JSON.stringify(sampleTask(taskId))};
          return { ok: true };
        });
        process.stdout.write(JSON.stringify({
          ok: result.ok,
          revision: result.ok ? result.revision : 0,
        }));
      `;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          cwd: path.resolve(__dirname, '../..'),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`child exited ${code}`));
          return;
        }
        resolve(JSON.parse(output) as { ok: boolean; revision: number });
      });
    });
  }

  it('serializes parallel commits from separate processes without lost updates', async () => {
    const { filePath } = makeTempStore();
    const [first, second] = await Promise.all([
      commitFromProcess(filePath, 'task-a'),
      commitFromProcess(filePath, 'task-b'),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const finalStore = TaskStore.load({ filePath });
    expect(finalStore.getFile().revision).toBe(2);
    expect(finalStore.getTask('task-a')).toBeDefined();
    expect(finalStore.getTask('task-b')).toBeDefined();
  }, 20_000);

  it('reclaims a malformed lock file left by a crashed writer', () => {
    const { filePath } = makeTempStore();
    fs.writeFileSync(`${filePath}.lock`, 'not-json', 'utf8');
    const store = TaskStore.load({ filePath, lockMaxWaitMs: 500, lockRetryMs: 10 });
    const commit = store.commit((draft) => {
      draft.tasks['task-1'] = sampleTask('task-1');
      return { ok: true };
    });
    expect(commit.ok).toBe(true);
  });

  it('reclaims an empty lock file left by a crash mid-acquire', () => {
    const { filePath } = makeTempStore();
    fs.writeFileSync(`${filePath}.lock`, '', 'utf8');
    const store = TaskStore.load({ filePath, lockMaxWaitMs: 500, lockRetryMs: 10 });
    const commit = store.commit((draft) => {
      draft.tasks['task-1'] = sampleTask('task-1');
      return { ok: true };
    });
    expect(commit.ok).toBe(true);
  });

  it('reclaims a lock from a dead pid', () => {
    const { filePath } = makeTempStore();
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99_999_999, token: 'dead' }), 'utf8');

    const store = TaskStore.load({ filePath, lockMaxWaitMs: 500 });
    const commit = store.commit((draft) => {
      draft.tasks['task-1'] = sampleTask('task-1');
      return { ok: true };
    });
    expect(commit.ok).toBe(true);
  });

  it('returns io_error when a live pid holds the lock', () => {
    const { filePath } = makeTempStore();
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live' }), 'utf8');

    const store = TaskStore.load({ filePath, lockMaxWaitMs: 50, lockRetryMs: 10 });
    const commit = store.commit(() => ({ ok: true }));
    expect(commit).toEqual({
      ok: false,
      reason: 'io_error',
      detail: 'could not acquire store lock',
    });
    fs.unlinkSync(lockPath);
  });

  it('runExclusive runs fn under the store lock and releases it afterward', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    // The critical section observes the lock held (a foreign acquire would fail here).
    const result = store.runExclusive(() => 'done');
    expect(result).toBe('done');
    // Lock released after runExclusive → a subsequent commit still succeeds (no deadlock).
    expect(
      store.commit((draft) => {
        draft.tasks['t'] = sampleTask('t');
        return { ok: true };
      }).ok,
    ).toBe(true);
  });

  it('runExclusive returns undefined (and skips fn) when a live pid holds the lock', () => {
    const { filePath } = makeTempStore();
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live' }), 'utf8');

    const store = TaskStore.load({ filePath, lockMaxWaitMs: 50, lockRetryMs: 10 });
    let ran = false;
    const result = store.runExclusive(() => {
      ran = true;
      return 'x';
    });
    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    fs.unlinkSync(lockPath);
  });

  it('load() recovers from a pre-existing corrupt store instead of bricking', () => {
    const { dir, filePath } = makeTempStore();
    fs.writeFileSync(filePath, '{not json', 'utf8');

    // Must NOT throw — a corrupt store at startup would otherwise disable the engine
    // with no observable recovery state.
    const store = TaskStore.load({ filePath });
    expect(store.isCorrupt()).toBe(true);
    expect(store.getRecoveryInfo()?.backupPath).toContain('.corrupt-');
    // In-memory falls back to an empty envelope; the corrupt bytes are quarantined once.
    expect(Object.keys(store.getFile().tasks).length).toBe(0);
    const corruptFiles = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(corruptFiles.length).toBe(1);
    // The user's corrupt data is preserved untouched — never auto-reset.
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{not json');
    // A commit must still refuse to overwrite the corrupt on-disk file.
    const attempt = store.commit((draft) => {
      draft.tasks['t'] = sampleTask('t');
      return { ok: true };
    });
    expect(attempt.ok).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{not json');
  });

  it('reload() surfaces external corruption without throwing and recovers when repaired', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    expect(
      store.commit((draft) => {
        draft.tasks['t'] = sampleTask('t');
        return { ok: true };
      }).ok,
    ).toBe(true);
    expect(store.isCorrupt()).toBe(false);

    // An external process corrupts the file; the watcher-driven reload must not throw.
    fs.writeFileSync(filePath, '{ broken', 'utf8');
    expect(() => store.reload()).not.toThrow();
    expect(store.isCorrupt()).toBe(true);
    expect(store.getRecoveryInfo()?.backupPath).toContain('.corrupt-');
    // Last-known-good in-memory state is retained during recovery.
    expect(store.getTask('t')?.id).toBe('t');

    // The file becomes readable again → reload clears the corruption signal.
    fs.writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 5, tasks: {}, turns: {}, messages: {} }),
      'utf8',
    );
    store.reload();
    expect(store.isCorrupt()).toBe(false);
    expect(store.getRecoveryInfo()).toBeUndefined();
    expect(store.getFile().revision).toBe(5);
  });

  it('quarantines a commit-time corruption once and exposes a recoverable signal', () => {
    const { dir, filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    // Establish a healthy store on disk.
    expect(
      store.commit((draft) => {
        draft.tasks['t'] = sampleTask('t');
        return { ok: true };
      }).ok,
    ).toBe(true);
    expect(store.isCorrupt()).toBe(false);

    // Corrupt the file out from under the store.
    fs.writeFileSync(filePath, '{ broken json', 'utf8');

    const first = store.commit(() => ({ ok: true }));
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason).toBe('store_corrupt');
      if (first.reason === 'store_corrupt') {
        expect(first.backupPath).toContain('.corrupt-');
      }
    }
    expect(store.isCorrupt()).toBe(true);
    expect(store.getRecoveryInfo()?.backupPath).toContain('.corrupt-');

    // Repeated commits against the SAME corruption must not accumulate backups.
    expect(store.commit(() => ({ ok: true })).ok).toBe(false);
    expect(store.commit(() => ({ ok: true })).ok).toBe(false);
    const corruptFiles = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(corruptFiles.length).toBe(1);

    // The user's corrupt data is preserved untouched — never auto-reset.
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{ broken json');
  });

  it('creates a distinct backup for a second, different corruption', () => {
    const { dir, filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['t'] = sampleTask('t');
      return { ok: true };
    });

    fs.writeFileSync(filePath, 'corruption-one', 'utf8');
    store.commit(() => ({ ok: true }));
    fs.writeFileSync(filePath, 'a-different-corruption', 'utf8');
    store.commit(() => ({ ok: true }));

    const corruptFiles = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(corruptFiles.length).toBe(2);
  });

  it('clears the corruption signal once the store is readable again', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['t'] = sampleTask('t');
      return { ok: true };
    });

    fs.writeFileSync(filePath, 'not json', 'utf8');
    expect(store.commit(() => ({ ok: true })).ok).toBe(false);
    expect(store.isCorrupt()).toBe(true);

    // User chooses to start fresh: remove the corrupt file.
    fs.unlinkSync(filePath);
    const recovered = store.commit((draft) => {
      draft.tasks['t2'] = sampleTask('t2');
      return { ok: true };
    });
    expect(recovered.ok).toBe(true);
    expect(store.isCorrupt()).toBe(false);
    expect(store.getRecoveryInfo()).toBeUndefined();
  });

  it('rejects unknown-newer schema versions', () => {
    const file: TaskStoreFile = {
      schemaVersion: CURRENT_SCHEMA_VERSION + 5,
      revision: 1,
      tasks: {},
      turns: {},
      messages: {},
    };
    expect(() => migrate(file, CURRENT_SCHEMA_VERSION)).toThrow(/newer than supported/);
  });

  it('migrates older schema fixtures on commit', () => {
    const { filePath } = makeTempStore();
    const legacy: TaskStoreFile = {
      schemaVersion: 0,
      revision: 3,
      tasks: { 'task-1': sampleTask('task-1') },
      turns: {},
      messages: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy), 'utf8');

    const store = TaskStore.load({ filePath });
    expect(store.getFile().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const commit = store.commit((draft) => {
      draft.tasks['task-2'] = sampleTask('task-2');
      return { ok: true };
    });
    expect(commit.ok).toBe(true);
    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getFile().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(reloaded.getFile().revision).toBe(4);
  });

  it('migrates a v2 fixture to v3 defaulting toolCalls/reasoning to empty', () => {
    const { filePath } = makeTempStore();
    const legacy = {
      schemaVersion: 2,
      revision: 7,
      tasks: { 'task-1': sampleTask('task-1') },
      turns: {},
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy), 'utf8');

    const store = TaskStore.load({ filePath });
    const file = store.getFile();
    expect(file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(file.toolCalls).toEqual({});
    expect(file.reasoning).toEqual({});
  });

  it('persists toolCalls/reasoning across commit and reload (retention writeback plumbing)', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['task-1'] = sampleTask('task-1');
      draft.toolCalls = {
        'turn-1:tc1': {
          id: 'turn-1:tc1',
          taskId: 'task-1',
          turnId: 'turn-1',
          toolCallId: 'tc1',
          order: 0,
          name: 'read',
          status: 'success',
          output: 'ok',
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        },
      };
      draft.reasoning = {
        'turn-1': {
          id: 'turn-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          content: 'thinking',
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        },
      };
      return { ok: true };
    });

    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getFile().toolCalls?.['turn-1:tc1']?.output).toBe('ok');
    expect(reloaded.getFile().reasoning?.['turn-1']?.content).toBe('thinking');
  });

  it('sleep() returns immediately for zero/negative durations (non-spinning)', () => {
    // The lock-retry sleep must be a no-op for <= 0 (guard), and a positive sleep must
    // park the thread for roughly the requested time without a CPU busy-wait.
    const zeroStart = Date.now();
    sleep(0);
    sleep(-25);
    expect(Date.now() - zeroStart).toBeLessThan(20);

    const posStart = Date.now();
    sleep(30);
    const elapsed = Date.now() - posStart;
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(500);
  });

  it('durably commits and round-trips through a fresh load with no leftover temp file', () => {
    const { dir, filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    const commit = store.commit((draft) => {
      draft.tasks['durable'] = sampleTask('durable');
      return { ok: true };
    });
    expect(commit.ok).toBe(true);

    // The fsync+rename write must leave no `.tmp` scratch file behind.
    const leftoverTemp = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    expect(leftoverTemp).toEqual([]);

    // A completely fresh TaskStore must observe the persisted data.
    const reloaded = TaskStore.load({ filePath });
    expect(reloaded.getTask('durable')?.id).toBe('durable');
    expect(reloaded.getFile().revision).toBe(1);
  });

  it('rebuilds derived indexes after each commit', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['root'] = sampleTask('root');
      return { ok: true };
    });
    expect(store.rootOf('root')).toBe('root');
    expect(store.viewStatusOf('root')).toBe('idle');

    store.commit((draft) => {
      draft.tasks['root'].lifecycle = 'succeeded';
      draft.tasks['root'].finishedAt = '2026-07-06T01:00:00.000Z';
      return { ok: true };
    });
    expect(store.viewStatusOf('root')).toBe('succeeded');
  });
});