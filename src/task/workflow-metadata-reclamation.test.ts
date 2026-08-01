import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask } from './types';
import { makeGraphFanInDefinition } from './workflow';

const WORKSPACE_ID = 'ws';
const NOW = '2026-07-28T00:00:00.000Z';

function terminalTask(id: string): MusterTask {
  return {
    id, role: 'worker', lifecycle: 'succeeded', releaseState: 'draft', goal: id,
    parentId: null, prerequisites: [], backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 }, revision: 0,
    createdAt: NOW, updatedAt: NOW,
  };
}

async function rowCounts(client: DbClient): Promise<Record<'tasks' | 'turns' | 'messages' | 'operations', number>> {
  const tables = ['tasks', 'turns', 'messages', 'operations'] as const;
  const entries = await Promise.all(tables.map(async (table) => {
    const row = await client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`, [WORKSPACE_ID],
    );
    return [table, row?.count ?? 0] as const;
  }));
  return Object.fromEntries(entries) as Record<(typeof tables)[number], number>;
}

async function startWorkflowRun(repository: SqliteTaskRepository, key: string): Promise<string> {
  const result = await repository.execute({
    kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-fan', version: 1,
    startIdempotencyKey: key, createdAt: NOW, goal: 'metadata reclamation fixture', backend: 'grok',
  });
  expect(result.ok).toBe(true);
  return (result.operation?.result?.data as { runId: string }).runId;
}

async function terminalizeRun(client: DbClient, repository: SqliteTaskRepository, runId: string): Promise<void> {
  await client.transaction([
    {
      sql: `UPDATE turns SET status = 'succeeded', settled_at = ?
              WHERE workspace_id = ? AND task_id IN (
                SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ?
              )`,
      params: [NOW, WORKSPACE_ID, WORKSPACE_ID, runId],
    },
    {
      sql: `UPDATE workflow_activations SET status = 'consumed', updated_at = ?
              WHERE workspace_id = ? AND run_id = ?`,
      params: [NOW, WORKSPACE_ID, runId],
    },
    {
      sql: `UPDATE workflow_dependency_gates SET status = 'failed'
              WHERE workspace_id = ? AND run_id = ?`,
      params: [WORKSPACE_ID, runId],
    },
    {
      sql: `UPDATE workflow_runs SET status = 'failed', terminal_reason_code = 'agent_fail', updated_at = ?
              WHERE workspace_id = ? AND run_id = ?`,
      params: [NOW, WORKSPACE_ID, runId],
    },
  ]);
  const nodes = await client.all<{ task_id: string }>(
    `SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL`,
    [WORKSPACE_ID, runId],
  );
  for (const { task_id } of nodes) {
    const task = await repository.getTask(task_id);
    expect(task).toBeTruthy();
    await repository.execute({
      kind: 'upsertTask', workspaceId: WORKSPACE_ID,
      task: { ...task!, lifecycle: 'succeeded', finishedAt: NOW, updatedAt: NOW, revision: task!.revision + 1 },
    });
  }
}

describe('terminal workflow metadata reclamation', () => {
  it('removes only safely terminal workflow runs and preserves durable rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-metadata-reclamation-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'workflow-metadata-reclamation', 'Workflow metadata reclamation', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const task = terminalTask('durable-task');
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: { id: 'durable-turn', taskId: task.id, sequence: 1, status: 'succeeded', trigger: 'user', inputs: [], createdAt: NOW, finishedAt: NOW },
      });
      await repository.execute({
        kind: 'appendMessage', workspaceId: WORKSPACE_ID,
        message: { id: 'durable-message', taskId: task.id, turnId: 'durable-turn', role: 'assistant', content: 'durable transcript', state: 'complete', order: 0, createdAt: NOW },
      });
      await repository.execute({
        kind: 'claimOperation', workspaceId: WORKSPACE_ID, ledgerKey: 'durable-operation',
        entry: { fingerprint: 'durable-fingerprint', result: { ok: true, data: {} } }, createdAt: NOW,
      });
      const definition = makeGraphFanInDefinition({ createdAt: NOW });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: definition.definitionId,
        version: definition.version, name: definition.name, topology: definition.topology, createdAt: NOW,
      });
      const safeRunId = await startWorkflowRun(repository, 'safe');
      const liveGateRunId = await startWorkflowRun(repository, 'live-gate');
      const liveActivationRunId = await startWorkflowRun(repository, 'live-activation');

      // A safely terminal run has no live liveness relation. The gate case represents
      // terminal integrity drift; a queued activation remains on a running run because
      // schema triggers correctly forbid terminal runs with live activations.
      await terminalizeRun(client, repository, safeRunId);
      await terminalizeRun(client, repository, liveGateRunId);
      const liveGate = await client.get<{ gate_id: string }>(
        `SELECT gate_id FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? LIMIT 1`,
        [WORKSPACE_ID, liveGateRunId],
      );
      await client.run(
        `UPDATE workflow_dependency_gates SET status = 'open'
          WHERE workspace_id = ? AND run_id = ? AND gate_id = ?`,
        [WORKSPACE_ID, liveGateRunId, liveGate!.gate_id],
      );

      const before = await rowCounts(client);
      const result = await repository.execute({ kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID });

      expect(result).toMatchObject({ ok: true, changed: true, reclaimedWorkflowRuns: 1 });
      await expect(client.all<{ run_id: string }>(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? ORDER BY run_id`, [WORKSPACE_ID],
      )).resolves.toEqual([{ run_id: liveActivationRunId }, { run_id: liveGateRunId }].sort((a, b) => a.run_id.localeCompare(b.run_id)));
      await expect(rowCounts(client)).resolves.toEqual(before);
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
