import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import type { MusterTask } from './types';
import { DbClient } from './sqlite/client';

function makeTask(id: string, lifecycle: MusterTask['lifecycle'] = 'succeeded'): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle,
    releaseState: 'draft',
    goal: id,
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

describe('retention file evidence', () => {
  it('strips bounded file-change diff bytes from terminal turns beyond the retained window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-retention-file-evidence-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'retention-file-evidence', 'Retention file evidence', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      const task = makeTask('terminal-file-evidence');
      const oldTurn = {
        id: 'old-turn', taskId: task.id, sequence: 1, status: 'succeeded' as const, trigger: 'user' as const,
        inputs: [], createdAt: '2026-07-16T00:00:01.000Z', finishedAt: '2026-07-16T00:00:02.000Z',
      };
      const retainedTurn = {
        id: 'retained-turn', taskId: task.id, sequence: 2, status: 'succeeded' as const, trigger: 'user' as const,
        inputs: [], createdAt: '2026-07-16T00:00:03.000Z', finishedAt: '2026-07-16T00:00:04.000Z',
      };
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: oldTurn });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: retainedTurn });
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id,
        toolCalls: [{
          id: 'old-turn:edit', taskId: task.id, turnId: oldTurn.id, toolCallId: 'edit', order: 0,
          name: 'edit_file', kind: 'builtin', status: 'success',
          fileChanges: [{ path: 'src/example.ts', oldText: 'before\nline', newText: 'after\nline' }],
          createdAt: '2026-07-16T00:00:02.000Z', updatedAt: '2026-07-16T00:00:02.000Z',
        }, {
          id: 'retained-turn:edit', taskId: task.id, turnId: retainedTurn.id, toolCallId: 'edit', order: 0,
          name: 'edit_file', kind: 'builtin', status: 'success',
          fileChanges: [{ path: 'src/current.ts', oldText: 'current before', newText: 'current after' }],
          createdAt: '2026-07-16T00:00:04.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
        }],
      });

      await repository.execute({ kind: 'applyRetention', workspaceId: 'ws', taskId: task.id, keepLatestTurns: 1 });

      const tools = await repository.listToolCalls(task.id);
      expect(tools.find((tool) => tool.turnId === oldTurn.id)?.fileChanges).toEqual([{
        path: 'src/example.ts', oldText: null, newText: '', oldLineCount: 2, newLineCount: 2,
        retentionTruncated: true,
      }]);
      expect(tools.find((tool) => tool.turnId === retainedTurn.id)?.fileChanges).toEqual([{
        path: 'src/current.ts', oldText: 'current before', newText: 'current after',
      }]);
      expect((await repository.listTurns(task.id)).map((turn) => turn.id)).toEqual([oldTurn.id, retainedTurn.id]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('strips bounded file-change diff bytes from settled turns of an open task without touching its running turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-retention-open-file-evidence-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'retention-open-file-evidence', 'Retention open file evidence', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      const task = makeTask('open-file-evidence', 'open');
      const settledTurn = {
        id: 'settled-turn', taskId: task.id, sequence: 1, status: 'succeeded' as const, trigger: 'user' as const,
        inputs: [], createdAt: '2026-07-16T00:00:01.000Z', finishedAt: '2026-07-16T00:00:02.000Z',
      };
      const runningTurn = {
        id: 'running-turn', taskId: task.id, sequence: 2, status: 'running' as const, trigger: 'user' as const,
        inputs: [], createdAt: '2026-07-16T00:00:03.000Z', startedAt: '2026-07-16T00:00:04.000Z',
      };
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: settledTurn });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: runningTurn });
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id,
        toolCalls: [{
          id: 'settled-turn:edit', taskId: task.id, turnId: settledTurn.id, toolCallId: 'edit', order: 0,
          name: 'edit_file', kind: 'builtin', status: 'success',
          output: 'aged output '.repeat(30_000),
          fileChanges: [{ path: 'src/settled.ts', oldText: 'settled before', newText: 'settled after' }],
          createdAt: '2026-07-16T00:00:02.000Z', updatedAt: '2026-07-16T00:00:02.000Z',
        }, {
          id: 'running-turn:edit', taskId: task.id, turnId: runningTurn.id, toolCallId: 'edit', order: 0,
          name: 'edit_file', kind: 'builtin', status: 'success',
          fileChanges: [{ path: 'src/running.ts', oldText: 'live before', newText: 'live after' }],
          createdAt: '2026-07-16T00:00:04.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
        }],
      });

      await expect(repository.execute({
        kind: 'applyRetention', workspaceId: 'ws', taskId: task.id, keepLatestTurns: 1,
        maxStoredOutputChars: 200_000,
      })).resolves.toMatchObject({ ok: true, changed: true, retentionEntriesStripped: 1 });

      const tools = await repository.listToolCalls(task.id);
      expect(tools.find((tool) => tool.turnId === settledTurn.id)?.fileChanges).toEqual([{
        path: 'src/settled.ts', oldText: null, newText: '', oldLineCount: 1, newLineCount: 1,
        retentionTruncated: true,
      }]);
      expect(tools.find((tool) => tool.turnId === settledTurn.id)?.output).toContain('[output truncated by retention policy]');
      expect(tools.find((tool) => tool.turnId === runningTurn.id)?.fileChanges).toEqual([{
        path: 'src/running.ts', oldText: 'live before', newText: 'live after',
      }]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
