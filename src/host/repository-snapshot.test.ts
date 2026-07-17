import { describe, expect, it } from 'vitest';
import { buildRepositorySnapshot } from './repository-snapshot';
import { SqliteTaskRepository } from '../task/repository';
import type { MusterTask } from '../task/types';
import { DbClient } from '../task/sqlite/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function task(id: string, parentId: string | null = null): MusterTask {
  return {
    id,
    role: parentId ? 'worker' : 'coordinator',
    lifecycle: 'open',
    releaseState: 'draft',
    goal: id,
    parentId,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

describe('buildRepositorySnapshot', () => {
  it('projects metadata plus the focused transcript from SQLite queries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-snapshot-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, '../task/sqlite/worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'snapshot', displayName: 'Snapshot',
        createdAt: 'now', lastOpenedAt: 'now',
      });
      const root = task('sqlite-root');
      const child = task('sqlite-child', root.id);
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws',
        turn: {
          id: 'sqlite-turn', taskId: child.id, sequence: 1, status: 'succeeded', trigger: 'user',
          inputs: [{ kind: 'message', messageId: 'sqlite-message' }], createdAt: '2026-07-17T00:00:01.000Z',
        },
      });
      await repository.execute({
        kind: 'appendMessage', workspaceId: 'ws',
        message: {
          id: 'sqlite-message', taskId: child.id, role: 'user', content: 'sqlite focused',
          state: 'complete', createdAt: '2026-07-17T00:00:02.000Z',
        },
      });
      const projection = await buildRepositorySnapshot(repository, 'ws', child.id, new Map());
      expect(projection.snapshot.subtree?.map((summary) => summary.id)).toEqual([root.id, child.id]);
      expect(projection.snapshot.transcript?.map((item) => item.id)).toEqual(['sqlite-message']);
      expect(projection.snapshot.storeRevision).toBeGreaterThan(0);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
