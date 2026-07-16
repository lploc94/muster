import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskEngine } from './engine';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask } from './types';

describe('TaskEngine repository-only boundary', () => {
  it('dispatches and settles with SQLite without a TaskStore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-repository-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'engine-repository', displayName: 'Engine repository', createdAt: 'now', lastOpenedAt: 'now' });
      const task: MusterTask = {
        id: 'repository-task', role: 'worker', lifecycle: 'open', goal: 'run through sqlite',
        parentId: null, dependencies: [], backend: 'fake', capabilities: [],
        executionPolicy: { maxTurns: 4, maxAutomaticRetries: 0 }, releaseState: 'released',
        revision: 0, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
      };
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: {
        id: 'repository-turn', taskId: task.id, sequence: 1, status: 'queued', trigger: 'engine',
        inputs: [], createdAt: '2026-07-16T00:00:01.000Z', runtimeEpoch: 1,
      } });
      const engine = await TaskEngine.loadAsync({
        repository, workspaceId: 'ws', makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        runTurn: async function* () { yield { type: 'turnCompleted' }; },
        clock: () => '2026-07-16T00:00:02.000Z',
      });
      await expect(engine.resumeQueuedTurnAsync(task.id, 'repository-turn')).resolves.toEqual({ ok: true, value: undefined });
      await engine.whenIdle();
      await expect(repository.getTurn('repository-turn')).resolves.toMatchObject({ status: 'succeeded' });
      await expect(repository.getRuntimeClaim('repository-turn')).resolves.toBeUndefined();
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
