import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { routeRequestWorkflowGraph } from '../host/workflow-graph-route';
import { buildWorkflowGraphView } from '../host/workflow-graph';
import { parseWorkflowGraphResult } from '../shared/workflow-graph-wire';
import { buildWorkflowGraphPanelView } from '../../webview/src/lib/workflow-graph-view';
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
        // Bind-only reuse: every ancestor of the live node is bound explicitly to the
        // producing execution, so the projection's reused set is fully accounted for.
        reuse: ['one', 'two', 'three', 'four'].map((destinationNodeId) => ({
          destinationNodeId,
          sourceRunId: producer.runId,
          sourceNodeId: 'four',
          sourceTaskId: producer.entryTaskId,
        })),
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(consumerStart).toMatchObject({ ok: true, changed: true });
      const consumer = consumerStart.operation!.result.data as { runId: string };
      await client.run(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 65
         ) INSERT INTO workflow_runs (
           workspace_id, run_id, definition_id, definition_version, status, origin,
           parent_run_id, owner_root_task_id, caller_task_id, caller_turn_id,
           continuation_id, policy_json, max_feedback_rounds, max_turns_per_task,
           max_workflow_turns, max_children, max_depth, max_concurrency,
           max_aggregate_bytes, feedback_rounds_reserved, workflow_turns_reserved,
           children_reserved, started_at, deadline_at, created_at, updated_at
         ) SELECT workspace_id, printf('child-run-%03d', sequence.n), definition_id,
                  definition_version, 'running', 'child', run_id, owner_root_task_id,
                  caller_task_id, caller_turn_id, NULL, policy_json,
                  max_feedback_rounds, max_turns_per_task, max_workflow_turns,
                  max_children, max_depth, max_concurrency, max_aggregate_bytes,
                  0, 0, 0, NULL, NULL, '2026-08-01T00:00:03.000Z',
                  '2026-08-01T00:00:03.000Z'
             FROM workflow_runs CROSS JOIN sequence
            WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, consumer.runId],
      );
      const five = await client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'five'`,
        [WORKSPACE_ID, consumer.runId],
      );
      expect(five?.task_id).toEqual(expect.any(String));
      const bound = {
        source_run_id: producer.runId,
        source_node_id: 'four',
        source_task_id: producer.entryTaskId,
      };
      await expect(client.all(
        `SELECT node_id, task_id, status, source_run_id, source_node_id, source_task_id
           FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual([
        {
          node_id: 'five', task_id: five!.task_id, status: 'active',
          source_run_id: null, source_node_id: null, source_task_id: null,
        },
        { node_id: 'four', task_id: null, status: 'reused', ...bound },
        { node_id: 'one', task_id: null, status: 'reused', ...bound },
        { node_id: 'three', task_id: null, status: 'reused', ...bound },
        { node_id: 'two', task_id: null, status: 'reused', ...bound },
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
        childRuns: expect.arrayContaining([{ runId: 'child-run-001', status: 'running' }]),
        reuse: { nodeCount: 4, edgeCount: 4 },
        diagnostics: [{ code: 'workflow_graph_child_runs_truncated' }],
      });
      const hostGraph = await buildWorkflowGraphView(repository, five!.task_id);
      const outcome = await routeRequestWorkflowGraph(
        { type: 'requestWorkflowGraph', requestId: 'graph-request-1', taskId: five!.task_id },
        {
          getFocused: () => ({ taskId: five!.task_id, generation: 1 }),
          buildWorkflowGraph: async () => hostGraph,
        },
      );
      expect(outcome.kind).toBe('message');
      const result = parseWorkflowGraphResult((outcome as { message: unknown }).message);
      expect(result).toMatchObject({ ok: true });
      const panel = buildWorkflowGraphPanelView((result as Extract<typeof result, { ok: true }>).graph);
      expect(panel.nodes.filter((node) => node.reused)).toHaveLength(4);
      expect(panel.activeGate).toMatchObject({ satisfied: 1, required: 1 });
      expect(panel.childRuns).toHaveLength(64);
      expect(panel.childRuns[0]).toEqual({ id: 'child-run-001', status: 'running', statusLabel: 'Running' });
      expect(panel.reuseSummary).toMatchObject({ nodeCount: 4, edgeCount: 4 });
      expect(panel.degradedRead.diagnostics).toEqual(['Child workflow runs were truncated']);

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
