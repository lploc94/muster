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
  it('strips only terminal transport payloads and preserves durable workflow rows', async () => {
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
      const secondSafeRunId = await startWorkflowRun(repository, 'safe-second');
      const pinnedProducerRunId = await startWorkflowRun(repository, 'pinned-producer');
      const pinConsumerRunId = await startWorkflowRun(repository, 'pin-consumer');
      const liveGateRunId = await startWorkflowRun(repository, 'live-gate');
      const liveActivationRunId = await startWorkflowRun(repository, 'live-activation');

      // A safely terminal run has no live liveness relation. The gate case represents
      // terminal integrity drift; a queued activation remains on a running run because
      // schema triggers correctly forbid terminal runs with live activations.
      await terminalizeRun(client, repository, safeRunId);
      await terminalizeRun(client, repository, secondSafeRunId);
      await terminalizeRun(client, repository, liveGateRunId);
      const consumerGate = await client.get<{ gate_id: string; input_ref: string }>(
        `SELECT gate.gate_id, binding.input_ref
           FROM workflow_dependency_gates gate
           JOIN workflow_gate_bindings binding
             ON binding.workspace_id = gate.workspace_id AND binding.run_id = gate.run_id
            AND binding.gate_id = gate.gate_id
          WHERE gate.workspace_id = ? AND gate.run_id = ?
            AND binding.producer_node_id = 'p1'
          LIMIT 1`,
        [WORKSPACE_ID, pinConsumerRunId],
      );
      expect(consumerGate).toBeTruthy();
      await client.transaction([
        {
          sql: `INSERT INTO workflow_artifacts (
                  workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                  revision, kind, payload_json, created_at
                ) VALUES (?,?,?,?,?,?,?,?,?)`,
          params: [WORKSPACE_ID, pinnedProducerRunId, 'cross-run-pinned-artifact', 'p1',
            'result', 1, 'next_result', '{}', NOW],
        },
        {
          sql: `INSERT INTO workflow_artifact_sources (
                  workspace_id, run_id, artifact_id, artifact_revision, source_kind,
                  producer_run_id, producer_node_id, producer_task_id, producing_turn_id,
                  producing_activation_id, caller_task_id, caller_turn_id,
                  engine_start_operation_key
                )
                SELECT ?, ?, ?, 1, 'workflow_node', ?, 'p1', node.task_id, activation.execution_turn_id,
                       activation.activation_id, NULL, NULL, NULL
                  FROM workflow_nodes node
                  JOIN workflow_activations activation
                    ON activation.workspace_id = node.workspace_id AND activation.run_id = node.run_id
                 WHERE node.workspace_id = ? AND node.run_id = ? AND node.node_id = 'p1'
                 LIMIT 1`,
          params: [WORKSPACE_ID, pinnedProducerRunId, 'cross-run-pinned-artifact', pinnedProducerRunId,
            WORKSPACE_ID, pinnedProducerRunId],
        },
        {
          sql: `DELETE FROM workflow_nodes
                 WHERE workspace_id = ? AND run_id = ? AND node_id = 'p1'`,
          params: [WORKSPACE_ID, pinConsumerRunId],
        },
        {
          sql: `INSERT INTO workflow_nodes (
                  workspace_id, run_id, node_id, task_id, status,
                  source_run_id, source_node_id, source_task_id,
                  source_artifact_id, source_artifact_revision
                )
                SELECT ?, ?, 'p1', NULL, 'reused', ?, 'p1', source.task_id, ?, 1
                  FROM workflow_nodes source
                 WHERE source.workspace_id = ? AND source.run_id = ? AND source.node_id = 'p1'`,
          params: [
            WORKSPACE_ID, pinConsumerRunId, pinnedProducerRunId,
            'cross-run-pinned-artifact', WORKSPACE_ID, pinnedProducerRunId,
          ],
        },
        {
          sql: `INSERT INTO workflow_gate_fills (
                  workspace_id, run_id, gate_id, input_ref, artifact_run_id,
                  artifact_id, artifact_revision, filled_at
                ) VALUES (?,?,?,?,?,?,?,?)`,
          params: [WORKSPACE_ID, pinConsumerRunId, consumerGate!.gate_id, consumerGate!.input_ref,
            pinnedProducerRunId, 'cross-run-pinned-artifact', 1, NOW],
        },
      ]);
      await terminalizeRun(client, repository, pinnedProducerRunId);
      const liveGate = await client.get<{ gate_id: string }>(
        `SELECT gate_id FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? LIMIT 1`,
        [WORKSPACE_ID, liveGateRunId],
      );
      await client.run(
        `UPDATE workflow_dependency_gates SET status = 'open'
          WHERE workspace_id = ? AND run_id = ? AND gate_id = ?`,
        [WORKSPACE_ID, liveGateRunId, liveGate!.gate_id],
      );

      await client.run(
        `INSERT INTO workflow_routed_messages (
           workspace_id, run_id, message_id, source_node_id, destination_node_id,
           kind, body_json, created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
        [WORKSPACE_ID, safeRunId, 'reclaimable-message', 'source', 'destination', 'terminal_next',
          '{"large":"transport payload"}', NOW],
      );
      const before = await rowCounts(client);
      const result = await repository.execute({ kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID });

      expect(result).toMatchObject({ ok: true, changed: true, strippedWorkflowMessageBodies: 1 });
      // Retention strips only routed transport bodies. It deliberately preserves
      // every workflow run: deleting a terminal run cascades its start claim while
      // the operation ledger remains, which breaks idempotent replay. Cross-run
      // artifact pins remain durable alongside the producer and consumer runs.
      await expect(client.all<{ run_id: string }>(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? ORDER BY run_id`, [WORKSPACE_ID],
      )).resolves.toEqual([
        safeRunId, secondSafeRunId, pinnedProducerRunId, pinConsumerRunId,
        liveGateRunId, liveActivationRunId,
      ].sort((left, right) => left.localeCompare(right)).map((run_id) => ({ run_id })));
      await expect(client.get<{ artifact_id: string }>(
        `SELECT artifact_id FROM workflow_artifacts
          WHERE workspace_id = ? AND run_id = ? AND artifact_id = ?`,
        [WORKSPACE_ID, pinnedProducerRunId, 'cross-run-pinned-artifact'],
      )).resolves.toEqual({ artifact_id: 'cross-run-pinned-artifact' });
      // This fixture starts a workspace-scoped run (no claim row). Its operation
      // ledger and run still survive, so replay never points at a deleted target.
      await expect(client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM operations WHERE workspace_id = ?`,
        [WORKSPACE_ID],
      )).resolves.toEqual({ count: before.operations });
      await expect(client.get<{ body_json: string }>(
        `SELECT body_json FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
        [WORKSPACE_ID, safeRunId, 'reclaimable-message'],
      )).resolves.toEqual({ body_json: '{"retentionStripped":true}' });
      await expect(rowCounts(client)).resolves.toEqual(before);
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
