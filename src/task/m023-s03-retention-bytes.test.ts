import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { SQLITE_SCHEMA_VERSION } from './sqlite/schema';
import type { MusterTask } from './types';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const WORKSPACE_ID = 'ws';

type DurableTable = 'tasks' | 'turns' | 'messages' | 'operations';

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

async function rowCounts(client: DbClient): Promise<Record<DurableTable, number>> {
  const tables: readonly DurableTable[] = ['tasks', 'turns', 'messages', 'operations'];
  const entries = await Promise.all(tables.map(async (table) => {
    const row = await client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`,
      [WORKSPACE_ID],
    );
    return [table, row?.count ?? 0] as const;
  }));
  return Object.fromEntries(entries) as Record<DurableTable, number>;
}

function toolCallBytes(report: Awaited<ReturnType<DbClient['storageReport']>>): number {
  return report.tables.find((table) => table.name === 'tool_calls')?.bytes ?? 0;
}

describe('M023 S03 retention byte and schema invariants', () => {
  it('uses storageReport and reclaimStorage to prove retention removes tool-call bytes without schema or durable-row movement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m023-s03-retention-bytes-'));
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        'INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)',
        [WORKSPACE_ID, 'm023-s03-retention-bytes', 'M023 S03 retention bytes', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const task = makeTerminalTask('m023-s03-terminal');
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task });

      for (const sequence of [1, 2, 3]) {
        const turnId = `turn-${sequence}`;
        await repository.execute({
          kind: 'createTurn', workspaceId: WORKSPACE_ID,
          turn: {
            id: turnId, taskId: task.id, sequence, status: 'succeeded', trigger: 'user', inputs: [],
            createdAt: `2026-07-16T00:00:0${sequence}.000Z`, finishedAt: `2026-07-16T00:00:1${sequence}.000Z`,
          },
        });
        await repository.execute({
          kind: 'appendMessage', workspaceId: WORKSPACE_ID,
          message: {
            id: `message-${sequence}`, taskId: task.id, turnId, role: 'assistant', content: `message ${sequence}`,
            state: 'complete', order: 0, createdAt: `2026-07-16T00:00:2${sequence}.000Z`,
          },
        });
        await repository.execute({
          kind: 'claimOperation', workspaceId: WORKSPACE_ID, ledgerKey: `${turnId}:operation`,
          entry: { fingerprint: `operation-${sequence}`, result: { ok: true, data: { sequence } } },
          createdAt: `2026-07-16T00:00:3${sequence}.000Z`,
        });
      }

      // Each entry and its combined payload stay inside T01's bounded-evidence
      // limits, so the retention proof exercises the valid transformation path.
      const largeDiff = 'x'.repeat(120 * 1024);
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: WORKSPACE_ID, taskId: task.id,
        toolCalls: [1, 2].map((sequence) => ({
          id: `turn-${sequence}:edit`, taskId: task.id, turnId: `turn-${sequence}`, toolCallId: 'edit', order: 0,
          name: 'edit_file', kind: 'builtin' as const, status: 'success' as const,
          fileChanges: [0, 1].map((part) => ({
            path: `src/old-${sequence}-${part}.ts`, oldText: largeDiff, newText: largeDiff,
          })),
          createdAt: `2026-07-16T00:00:4${sequence}.000Z`, updatedAt: `2026-07-16T00:00:4${sequence}.000Z`,
        })).concat([{
          id: 'turn-3:edit', taskId: task.id, turnId: 'turn-3', toolCallId: 'edit', order: 0,
          name: 'edit_file', kind: 'builtin' as const, status: 'success' as const,
          fileChanges: [{ path: 'src/current.ts', oldText: 'before', newText: 'after' }],
          createdAt: '2026-07-16T00:00:43.000Z', updatedAt: '2026-07-16T00:00:43.000Z',
        }]),
      });

      expect(SQLITE_SCHEMA_VERSION).toBe(8);
      expect(await client.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
      const durableRowsBefore = await rowCounts(client);
      const reportBefore = await client.storageReport();
      const bytesBefore = toolCallBytes(reportBefore);
      expect(bytesBefore).toBeGreaterThan(0);

      await expect(repository.execute({
        kind: 'applyRetention', workspaceId: WORKSPACE_ID, taskId: task.id, keepLatestTurns: 1,
      })).resolves.toMatchObject({ ok: true, changed: true, retentionEntriesStripped: 4 });

      const reportAfterRetention = await client.storageReport();
      expect(toolCallBytes(reportAfterRetention)).toBeLessThan(bytesBefore);
      await expect(rowCounts(client)).resolves.toEqual(durableRowsBefore);
      await expect(client.pragma('user_version')).resolves.toBe(SQLITE_SCHEMA_VERSION);

      // S02 owns file reclamation and its before/after file-size metadata; do
      // not infer a second file measurement from the S01 report surface.
      const reclaim = await client.reclaimStorage();
      expect(reclaim.mode).toBe('incremental');
      expect(reclaim.fileBytesAfter).toBeLessThan(reclaim.fileBytesBefore);
      expect(await client.pragma('user_version')).toBe(SQLITE_SCHEMA_VERSION);
      expect(SQLITE_SCHEMA_VERSION).toBe(8);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
