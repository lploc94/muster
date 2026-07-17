import { describe, expect, it, vi } from 'vitest';
import { buildRepositorySnapshot } from './repository-snapshot';
import { JsonTaskRepository, SqliteTaskRepository } from '../task/repository';
import { TaskStore } from '../task/store';
import type { MusterTask, TaskStoreFile } from '../task/types';
import { DbClient } from '../task/sqlite/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function task(id: string, parentId: string | null = null): MusterTask {
  return {
    id,
    role: parentId ? 'worker' : 'coordinator',
    lifecycle: 'open',
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
  it('projects metadata plus focused transcript without reading the migration envelope', async () => {
    const filePath = `/tmp/muster-repository-snapshot-${Date.now()}-${Math.random()}.json`;
    const store = TaskStore.load({ filePath });
    store.commit((draft: TaskStoreFile) => {
      draft.tasks.root = task('root');
      draft.tasks.child = task('child', 'root');
      draft.tasks.other = task('other');
      draft.turns.childTurn = {
        id: 'childTurn', taskId: 'child', sequence: 1, status: 'succeeded', trigger: 'user',
        inputs: [{ kind: 'message', messageId: 'childMessage' }], createdAt: '2026-07-17T00:00:01.000Z',
      };
      // Historical turns on an unrelated task must stay out of the bounded
      // tree projection; only the focused task gets its complete turn map.
      draft.turns.otherOld = {
        id: 'otherOld', taskId: 'other', sequence: 1, status: 'succeeded', trigger: 'user',
        inputs: [], createdAt: '2026-07-16T00:00:01.000Z',
      };
      draft.turns.otherLatest = {
        id: 'otherLatest', taskId: 'other', sequence: 2, status: 'succeeded', trigger: 'user',
        inputs: [], createdAt: '2026-07-17T00:00:01.000Z',
      };
      draft.messages.childMessage = {
        id: 'childMessage', taskId: 'child', role: 'user', content: 'focused', state: 'complete',
        createdAt: '2026-07-17T00:00:02.000Z',
      };
      draft.messages.otherMessage = {
        id: 'otherMessage', taskId: 'other', role: 'user', content: 'must stay out', state: 'complete',
        createdAt: '2026-07-17T00:00:03.000Z',
      };
      return { ok: true };
    });
    const repository = new JsonTaskRepository(store, 'ws');
    const migrationReader = vi.spyOn(repository, 'readEnvelopeForMigration').mockRejectedValue(
      new Error('snapshot must not materialize migration envelope'),
    );
    try {
      const projection = await buildRepositorySnapshot(repository, 'ws', 'child', new Map());
      expect(projection.snapshot.rootTasks.map((summary) => summary.id)).toEqual(['other', 'root']);
      expect(projection.snapshot.subtree?.map((summary) => summary.id)).toEqual(['root', 'child']);
      expect(projection.snapshot.transcript?.map((item) => item.id)).toEqual(['childMessage']);
      expect(Object.keys(projection.observation.turns).sort()).toEqual(['childTurn', 'otherLatest']);
      expect(JSON.stringify(projection.observation)).not.toContain('must stay out');
      expect(projection.snapshot.storeRevision).toBe(store.getFile().revision);
      expect(migrationReader).not.toHaveBeenCalled();
    } finally {
      migrationReader.mockRestore();
      try { await import('node:fs').then((fs) => fs.unlinkSync(filePath)); } catch { /* cleanup */ }
    }
  });

  it('uses the same bounded projection contract on SQLite', async () => {
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
