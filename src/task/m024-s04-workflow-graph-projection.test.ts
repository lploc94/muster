import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { stageDispositionForSettlement } from './m018-test-helpers';
import type { MusterTask, TurnDisposition } from './types';

const WORKSPACE_ID = 'ws';
const NOW = '2026-08-01T00:00:00.000Z';

function rootTask(): MusterTask {
  return {
    id: 'root-1', role: 'coordinator', lifecycle: 'open', releaseState: 'released',
    goal: 'coordinate five-node graph projection', parentId: null, prerequisites: [],
    backend: 'grok', capabilities: [], executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0, createdAt: NOW, updatedAt: NOW, releasedAt: NOW,
  };
}

async function settleSucceeded(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  disposition: TurnDisposition,
) {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
    ['2026-08-01T00:00:01.000Z', WORKSPACE_ID, turnId],
  );
  const [task, turn] = await Promise.all([repository.getTask(taskId), repository.getTurn(turnId)]);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  await stageDispositionForSettlement(repository, turn!, disposition);
  return repository.execute({
    kind: 'settleTurnAndApplyEffects', workspaceId: WORKSPACE_ID,
    expectedTaskRevision: task!.revision,
    task: { ...task!, lifecycle: 'succeeded', updatedAt: '2026-08-01T00:00:01.000Z' },
    turn: { ...turn!, status: 'succeeded', finishedAt: '2026-08-01T00:00:01.000Z', disposition },
    expectedStatuses: ['running'], relatedTurns: [], messages: [],
  });
}

describe('M024 S04 workflow graph projection', () => {
  it('reads the durable S03 five-node reuse closure and its reused edge density from on-disk SQLite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s04-graph-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'm024-s04-graph', 'M024 S04 graph', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: rootTask() });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: { id: 'root-turn', taskId: 'root-1', sequence: 1, status: 'running', trigger: 'user', inputs: [], createdAt: NOW, startedAt: NOW },
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'wf-four', version: 1,
        name: 'produce four', topology: { kind: 'one_node_v1', nodes: [{ nodeId: 'four' }], entryNodeId: 'four' }, createdAt: NOW,
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'wf-five-chain', version: 1,
        name: 'five node chain', createdAt: NOW,
        topology: {
          kind: 'graph_v1', nodes: ['one', 'two', 'three', 'four', 'five'].map((nodeId) => ({ nodeId })),
          edges: [
            { fromNodeId: 'one', toNodeId: 'two', inputRef: 'one_result' },
            { fromNodeId: 'two', toNodeId: 'three', inputRef: 'two_result' },
            { fromNodeId: 'three', toNodeId: 'four', inputRef: 'three_result' },
            { fromNodeId: 'four', toNodeId: 'five', inputRef: 'four_result' },
          ],
        },
      });

      const producerStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-four', version: 1,
        startIdempotencyKey: 'producer-four', createdAt: NOW,
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(producerStart).toMatchObject({ ok: true, changed: true });
      const producer = producerStart.operation!.result.data as {
        runId: string; entryTaskId: string; activationTurnId: string;
      };
      await expect(settleSucceeded(
        repository, client, producer.entryTaskId, producer.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'four reusable result' },
      )).resolves.toMatchObject({ ok: true, changed: true });

      const consumerStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-five-chain', version: 1,
        startIdempotencyKey: 'consumer-five-chain', createdAt: '2026-08-01T00:00:02.000Z',
        reuse: [{ nodeId: 'four', fromRun: producer.runId }],
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(consumerStart).toMatchObject({ ok: true, changed: true });
      const consumer = consumerStart.operation!.result.data as { runId: string };
      const five = await client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'five'`,
        [WORKSPACE_ID, consumer.runId],
      );
      expect(five?.task_id).toEqual(expect.any(String));
      await expect(client.all(
        `SELECT node_id, task_id, status FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual([
        { node_id: 'five', task_id: five!.task_id, status: 'active' },
        { node_id: 'four', task_id: null, status: 'reused' },
        { node_id: 'one', task_id: null, status: 'reused' },
        { node_id: 'three', task_id: null, status: 'reused' },
        { node_id: 'two', task_id: null, status: 'reused' },
      ]);

      const graph = await repository.getWorkflowGraphForTask(five!.task_id);
      expect(graph).toEqual({
        runId: consumer.runId,
        nodes: [
          { nodeId: 'five', status: 'active' },
          { nodeId: 'four', status: 'reused' },
          { nodeId: 'one', status: 'reused' },
          { nodeId: 'three', status: 'reused' },
          { nodeId: 'two', status: 'reused' },
        ],
        edges: [
          { fromNodeId: 'one', toNodeId: 'two', inputRef: 'one_result' },
          { fromNodeId: 'two', toNodeId: 'three', inputRef: 'two_result' },
          { fromNodeId: 'three', toNodeId: 'four', inputRef: 'three_result' },
          { fromNodeId: 'four', toNodeId: 'five', inputRef: 'four_result' },
        ],
        activeGate: expect.objectContaining({ status: 'satisfied', required: 1, satisfied: 1 }),
        feedbackRounds: [],
        childRuns: [],
        reuse: { nodeCount: 4, edgeCount: 4 },
        diagnostics: [],
      });
      await expect(client.get(
        `SELECT fill.artifact_run_id FROM workflow_gate_bindings binding
         JOIN workflow_gate_fills fill ON fill.workspace_id = binding.workspace_id AND fill.run_id = binding.run_id
          AND fill.gate_id = binding.gate_id AND fill.input_ref = binding.input_ref
         WHERE binding.workspace_id = ? AND binding.run_id = ? AND binding.producer_node_id = 'four'`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual({ artifact_run_id: producer.runId });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
