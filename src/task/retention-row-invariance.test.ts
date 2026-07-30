import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import type { MusterTask } from './types';
import { DbClient } from './sqlite/client';

function makeTerminalTask(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'succeeded',
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

async function rowCounts(client: DbClient): Promise<Record<'tasks' | 'turns' | 'messages' | 'operations', number>> {
  const tables = ['tasks', 'turns', 'messages', 'operations'] as const;
  const entries = await Promise.all(tables.map(async (table) => {
    const row = await client.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`, ['ws']);
    return [table, row?.count ?? 0] as const;
  }));
  return Object.fromEntries(entries) as Record<(typeof tables)[number], number>;
}

describe('terminal retention row invariance', () => {
  it('does not delete task, turn, message, or operation rows beyond the retained-turn threshold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-retention-row-invariance-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'retention-row-invariance', 'Retention row invariance', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      const task = makeTerminalTask('terminal-row-invariance');
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });

      for (const sequence of [1, 2, 3]) {
        const turnId = `retention-turn-${sequence}`;
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: {
            id: turnId, taskId: task.id, sequence, status: 'succeeded', trigger: 'user', inputs: [],
            createdAt: `2026-07-16T00:00:0${sequence}.000Z`, finishedAt: `2026-07-16T00:00:1${sequence}.000Z`,
          },
        });
        await repository.execute({
          kind: 'appendMessage', workspaceId: 'ws',
          message: {
            id: `retention-message-${sequence}`, taskId: task.id, turnId, role: 'assistant',
            content: `message ${sequence}`, state: 'complete', order: 0,
            createdAt: `2026-07-16T00:00:2${sequence}.000Z`,
          },
        });
        await repository.execute({
          kind: 'claimOperation', workspaceId: 'ws', ledgerKey: `${turnId}:operation`,
          entry: { fingerprint: `retention-operation-${sequence}`, result: { ok: true, data: { sequence } } },
          createdAt: `2026-07-16T00:00:3${sequence}.000Z`,
        });
      }

      const before = await rowCounts(client);
      await repository.execute({ kind: 'applyRetention', workspaceId: 'ws', taskId: task.id, keepLatestTurns: 1 });

      await expect(rowCounts(client)).resolves.toEqual(before);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
