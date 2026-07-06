import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, TaskStore, migrate } from './store';
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

  it('does not reclaim a malformed lock file', () => {
    const { filePath } = makeTempStore();
    fs.writeFileSync(`${filePath}.lock`, 'not-json', 'utf8');
    const store = TaskStore.load({ filePath, lockMaxWaitMs: 50, lockRetryMs: 10 });
    const commit = store.commit(() => ({ ok: true }));
    expect(commit).toEqual({
      ok: false,
      reason: 'io_error',
      detail: 'could not acquire store lock',
    });
    fs.unlinkSync(`${filePath}.lock`);
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

  it('preserves corrupt files instead of overwriting them', () => {
    const { dir, filePath } = makeTempStore();
    fs.writeFileSync(filePath, '{not json', 'utf8');

    expect(() => TaskStore.load({ filePath })).toThrow(/Corrupt task store preserved/);
    const corruptFiles = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(corruptFiles.length).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{not json');
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