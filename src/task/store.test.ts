import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  sanitizeHandoffFailureMessage,
  TaskStore,
  migrate,
  sleep,
} from './store';
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

  it('migrates v4 → v5: releaseState + brief from goal; goal preserved', () => {
    const withTurn = sampleTask('with-turn');
    withTurn.goal = 'legacy goal A';
    withTurn.description = 'desc A';
    const noTurn = sampleTask('no-turn');
    noTurn.goal = 'legacy goal B';
    const v4: TaskStoreFile = {
      schemaVersion: 4,
      revision: 2,
      tasks: { 'with-turn': withTurn, 'no-turn': noTurn },
      turns: {
        t1: {
          id: 't1',
          taskId: 'with-turn',
          sequence: 1,
          trigger: 'user',
          status: 'succeeded',
          inputs: [],
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      },
      messages: {},
      operations: {},
      cancelRequests: {},
      toolCalls: {},
      reasoning: {},
      sendReceipts: {},
    };
    const migrated = migrate(v4, CURRENT_SCHEMA_VERSION);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.tasks['with-turn']?.goal).toBe('legacy goal A');
    expect(migrated.tasks['with-turn']?.releaseState).toBe('released');
    expect(migrated.tasks['with-turn']?.brief?.objective).toBe('legacy goal A');
    expect(migrated.tasks['with-turn']?.brief?.context).toBe('desc A');
    expect(migrated.tasks['no-turn']?.releaseState).toBe('draft');
    expect(migrated.tasks['no-turn']?.brief?.objective).toBe('legacy goal B');
    // Never invent turns for draft tasks.
    expect(Object.values(migrated.turns).filter((t) => t.taskId === 'no-turn')).toHaveLength(0);
  });

  it('migrates v6 disposition_repair_pending + queued repair turn → awaiting_parent_seal without repair turns', () => {
    const now = '2026-07-17T12:00:00.000Z';
    const child = sampleTask('child-1');
    child.parentId = 'root-1';
    child.role = 'worker';
    child.executionPolicy = { maxTurns: 10, maxAutomaticRetries: 1 };
    child.executionEpoch = 1;
    child.attention = {
      code: 'disposition_repair_pending',
      message: 'missing disposition; repair turn scheduled',
      at: now,
      sourceTurnId: 'turn-child-1',
    };
    // No completionCandidate yet — legacy repair path never stored one.

    const root = sampleTask('root-1');
    root.parentId = null;
    root.executionPolicy = { maxTurns: 10, maxAutomaticRetries: 1 };
    root.executionEpoch = 1;

    const v6: TaskStoreFile = {
      schemaVersion: 6,
      revision: 9,
      tasks: { 'root-1': root, 'child-1': child },
      turns: {
        'turn-child-1': {
          id: 'turn-child-1',
          taskId: 'child-1',
          sequence: 1,
          trigger: 'user',
          status: 'succeeded',
          inputs: [],
          executionEpoch: 1,
          createdAt: now,
          finishedAt: now,
        },
        'turn-child-1-disposition-repair': {
          id: 'turn-child-1-disposition-repair',
          taskId: 'child-1',
          sequence: 2,
          trigger: 'engine',
          status: 'queued',
          inputs: ['msg-repair'],
          executionEpoch: 1,
          createdAt: now,
        },
      },
      messages: {
        'msg-repair': {
          id: 'msg-repair',
          taskId: 'child-1',
          role: 'user',
          content: 'Please call complete_task or fail_task.',
          state: 'assigned',
          createdAt: now,
          turnId: 'turn-child-1-disposition-repair',
        },
      },
      operations: {},
      cancelRequests: {},
      toolCalls: {},
      reasoning: {},
      sendReceipts: {},
    };

    const migrated = migrate(v6, CURRENT_SCHEMA_VERSION);
    expect(migrated.schemaVersion).toBe(7);
    expect(CURRENT_SCHEMA_VERSION).toBe(7);

    const migratedChild = migrated.tasks['child-1'];
    expect(migratedChild?.attention?.code).toBe('awaiting_parent_seal');
    expect(migratedChild?.attention?.code).not.toBe('disposition_repair_pending');
    expect(migratedChild?.attention?.sourceTurnId).toBe('turn-child-1');
    expect(migratedChild?.completionCandidate).toMatchObject({
      version: 1,
      sourceTurnId: 'turn-child-1',
      reason: 'missing_disposition',
    });
    expect(migratedChild?.completionCandidate?.summary.length).toBeGreaterThan(0);

    // No scheduled repair turn remains; source turn is preserved.
    expect(migrated.turns['turn-child-1-disposition-repair']).toBeUndefined();
    expect(
      Object.keys(migrated.turns).some((id) => id.endsWith('-disposition-repair')),
    ).toBe(false);
    expect(migrated.turns['turn-child-1']?.status).toBe('succeeded');
    expect(migrated.messages['msg-repair']).toBeUndefined();

    // Root without repair state is untouched.
    expect(migrated.tasks['root-1']?.attention).toBeUndefined();
  });

  it('migrates v6 root disposition_repair_pending by clearing attention (no seal request)', () => {
    const now = '2026-07-17T12:00:00.000Z';
    const root = sampleTask('root-only');
    root.parentId = null;
    root.executionPolicy = { maxTurns: 10, maxAutomaticRetries: 1 };
    root.executionEpoch = 1;
    root.attention = {
      code: 'disposition_repair_pending',
      message: 'missing disposition; repair turn scheduled',
      at: now,
      sourceTurnId: 'turn-root-1',
    };
    const v6: TaskStoreFile = {
      schemaVersion: 6,
      revision: 2,
      tasks: { 'root-only': root },
      turns: {
        'turn-root-1-disposition-repair': {
          id: 'turn-root-1-disposition-repair',
          taskId: 'root-only',
          sequence: 2,
          trigger: 'engine',
          status: 'running',
          inputs: [],
          executionEpoch: 1,
          createdAt: now,
          startedAt: now,
        },
      },
      messages: {},
      operations: {},
      cancelRequests: {},
      toolCalls: {},
      reasoning: {},
      sendReceipts: {},
    };
    const migrated = migrate(v6, CURRENT_SCHEMA_VERSION);
    expect(migrated.tasks['root-only']?.attention).toBeUndefined();
    expect(migrated.tasks['root-only']?.completionCandidate).toBeUndefined();
    expect(migrated.turns['turn-root-1-disposition-repair']).toBeUndefined();
  });

  it('v7 migration preserves finished historical repair turns and non-repair attention', () => {
    const now = '2026-07-17T12:00:00.000Z';
    const child = sampleTask('child-hist');
    child.parentId = 'root-hist';
    child.role = 'worker';
    child.executionPolicy = { maxTurns: 10, maxAutomaticRetries: 1 };
    child.executionEpoch = 1;
    child.attention = {
      code: 'awaiting_parent_answer',
      message: 'waiting for parent answers',
      at: now,
      sourceTurnId: 'turn-q',
    };
    const v6: TaskStoreFile = {
      schemaVersion: 6,
      revision: 3,
      tasks: { 'child-hist': child },
      turns: {
        'turn-old-disposition-repair': {
          id: 'turn-old-disposition-repair',
          taskId: 'child-hist',
          sequence: 3,
          trigger: 'engine',
          status: 'succeeded',
          inputs: [],
          executionEpoch: 1,
          createdAt: now,
          finishedAt: now,
        },
      },
      messages: {},
      operations: {},
      cancelRequests: {},
      toolCalls: {},
      reasoning: {},
      sendReceipts: {},
    };
    const migrated = migrate(v6, CURRENT_SCHEMA_VERSION);
    expect(migrated.schemaVersion).toBe(7);
    // Finished historical repair turns are not re-scheduled; keep transcript history.
    expect(migrated.turns['turn-old-disposition-repair']?.status).toBe('succeeded');
    // Unrelated attention codes must not be rewritten.
    expect(migrated.tasks['child-hist']?.attention?.code).toBe('awaiting_parent_answer');
    expect(migrated.tasks['child-hist']?.completionCandidate).toBeUndefined();
  });

  it('migrates v5 execution policy, epoch, and freezes legacy live deadlines', () => {
    const defaults = sampleTask('defaults');
    defaults.executionPolicy = {
      maxTurns: 50,
      maxAutomaticRetries: 2,
      turnTimeoutMs: 300_000,
      taskTimeoutMs: 1_800_000,
    };
    const custom = sampleTask('custom');
    custom.executionPolicy = {
      maxTurns: 80,
      maxAutomaticRetries: 3,
      turnTimeoutMs: 900_000,
      taskTimeoutMs: 9_999_999,
    };
    const v5: TaskStoreFile = {
      schemaVersion: 5,
      revision: 1,
      tasks: { defaults, custom },
      turns: {
        live: {
          id: 'live',
          taskId: 'defaults',
          sequence: 1,
          trigger: 'user',
          status: 'running',
          inputs: [],
          createdAt: '2026-07-16T00:00:00.000Z',
          startedAt: '2026-07-16T00:01:00.000Z',
        },
      },
      messages: {},
      operations: {},
      cancelRequests: {},
      toolCalls: {},
      reasoning: {},
      sendReceipts: {},
    };
    const migrated = migrate(v5, CURRENT_SCHEMA_VERSION);
    expect(migrated.tasks.defaults?.executionPolicy).toEqual({
      maxTurns: 50,
      maxAutomaticRetries: 2,
    });
    expect(migrated.tasks.custom?.executionPolicy).toEqual({
      maxTurns: 80,
      maxAutomaticRetries: 3,
      runTimeoutOverrideMs: 900_000,
    });
    expect(migrated.tasks.defaults?.executionEpoch).toBe(1);
    expect(migrated.turns.live).toMatchObject({
      executionEpoch: 1,
      effectiveRunLimitMs: 300_000,
      runDeadlineAt: '2026-07-16T00:06:00.000Z',
    });
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

  it('legacy tasks without handoff remain valid across load and commit', () => {
    const { filePath } = makeTempStore();
    const legacy: TaskStoreFile = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 2,
      tasks: { 'task-1': sampleTask('task-1') },
      turns: {},
      messages: {},
      operations: {},
      cancelRequests: {},
      toolCalls: {},
      reasoning: {},
      sendReceipts: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy), 'utf8');

    const store = TaskStore.load({ filePath });
    const task = store.getTask('task-1');
    expect(task).toBeDefined();
    expect(task?.handoff).toBeUndefined();

    const commit = store.commit((draft) => {
      draft.tasks['task-2'] = sampleTask('task-2');
      return { ok: true };
    });
    expect(commit.ok).toBe(true);
    expect(store.getTask('task-1')?.handoff).toBeUndefined();
    expect(store.getTask('task-2')?.handoff).toBeUndefined();
  });

  it('strips malformed handoff on load (fail closed) without quarantining the store', () => {
    const { filePath } = makeTempStore();
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 1,
      tasks: {
        'task-1': {
          ...sampleTask('task-1'),
          handoff: {
            // missing required fields / wrong types
            version: 1,
            operationId: 42,
            phase: 'not-a-phase',
            source: 'claude',
            target: null,
            conversationContext: { status: 'ready' },
            createdAt: '2026-07-06T00:00:00.000Z',
            updatedAt: '2026-07-06T00:00:00.000Z',
          },
        },
        'task-2': {
          ...sampleTask('task-2'),
          handoff: {
            version: 1,
            operationId: 'hop-ok',
            phase: 'completed',
            source: { backend: 'claude-cli' },
            target: { backend: 'codex', sessionId: 'tgt' },
            conversationContext: {
              status: 'ready',
              messageCount: 2,
              contentDigest: 'ok',
              exportedAt: '2026-07-06T00:05:00.000Z',
            },
            createdAt: '2026-07-06T00:00:00.000Z',
            updatedAt: '2026-07-06T00:05:00.000Z',
            finishedAt: '2026-07-06T00:05:00.000Z',
            completion: {
              completedAt: '2026-07-06T00:05:00.000Z',
              boundBackend: 'codex',
              boundSessionId: 'tgt',
            },
          },
        },
      },
      turns: {},
      messages: {},
      operations: {},
      cancelRequests: {},
      toolCalls: {},
      reasoning: {},
      sendReceipts: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(raw), 'utf8');

    const store = TaskStore.load({ filePath });
    expect(store.isCorrupt()).toBe(false);
    // Malformed handoff is dropped; the task itself remains loadable.
    expect(store.getTask('task-1')?.handoff).toBeUndefined();
    expect(store.getTask('task-1')?.id).toBe('task-1');
    // Obsolete v1 records are stripped even when structurally valid; the task
    // binding itself is preserved and no hidden recovery is resumed.
    expect(store.getTask('task-2')?.handoff).toBeUndefined();
  });

  it('redacts multi-token headers and quoted secret assignments', () => {
    const auth = sanitizeHandoffFailureMessage('Authorization: Bearer topsecret');
    expect(auth).toContain('[redacted]');
    expect(auth).not.toContain('topsecret');
    expect(auth).not.toContain('Bearer topsecret');

    const cookie = sanitizeHandoffFailureMessage('Cookie: session=abc; refresh=def');
    expect(cookie).toContain('[redacted]');
    expect(cookie).not.toContain('session=abc');
    expect(cookie).not.toContain('refresh=def');

    const quoted = sanitizeHandoffFailureMessage('PASSWORD="hunter two" AWS_SECRET_ACCESS_KEY=\'s3cr3t\'');
    expect(quoted).not.toContain('hunter two');
    expect(quoted).not.toContain('s3cr3t');
    expect(quoted).toMatch(/PASSWORD\s*=\s*\[redacted\]/i);
  });

});
