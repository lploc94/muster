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
    goal: 'coordinate five-node reuse', parentId: null, prerequisites: [], backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 }, revision: 0,
    createdAt: NOW, updatedAt: NOW, releasedAt: NOW,
  };
}

async function settleSucceeded(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  disposition: TurnDisposition,
  finishedAt: string,
) {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
    [finishedAt, WORKSPACE_ID, turnId],
  );
  const task = await repository.getTask(taskId);
  const turn = await repository.getTurn(turnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  await stageDispositionForSettlement(repository, turn!, disposition);
  return repository.execute({
    kind: 'settleTurnAndApplyEffects', workspaceId: WORKSPACE_ID,
    expectedTaskRevision: task!.revision,
    task: { ...task!, lifecycle: 'succeeded', updatedAt: finishedAt },
    turn: { ...turn!, status: 'succeeded', finishedAt, disposition },
    expectedStatuses: ['running'], relatedTurns: [], messages: [],
  });
}

function forbiddenProjectionLeak(value: unknown): string[] {
  const text = JSON.stringify(value);
  return [
    /[A-Za-z]:\\|\/tmp\/|\\\\/.test(text) && 'absolute-path-like',
    /"topology"|"edges"|"prompt"|"payload_json"|"body_json"/.test(text) && 'internal-body-like',
  ].filter((value): value is string => Boolean(value));
}

describe('M024 S03 durable mid-tree reuse', () => {
  it('reuses one through four, activates and settles only five, pins the producer, and remains bounded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s03-durable-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'm024-s03-durable', 'M024 S03 durable', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: rootTask() });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: { id: 'root-turn', taskId: 'root-1', sequence: 1, status: 'running', trigger: 'user', inputs: [], createdAt: NOW, startedAt: NOW },
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'wf-four', version: 1,
        // Named unlike any chain node on purpose: reuse binds a source execution to a
        // destination node, so matching ids must not be what makes the binding resolve.
        name: 'produce four', topology: { kind: 'one_node_v1', nodes: [{ nodeId: 'produce' }], entryNodeId: 'produce' }, createdAt: NOW,
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'wf-five-chain', version: 1,
        name: 'five node chain', topology: {
          kind: 'graph_v1', nodes: ['one', 'two', 'three', 'four', 'five'].map((nodeId) => ({ nodeId })),
          edges: [
            { fromNodeId: 'one', toNodeId: 'two', inputRef: 'one_result' },
            { fromNodeId: 'two', toNodeId: 'three', inputRef: 'two_result' },
            { fromNodeId: 'three', toNodeId: 'four', inputRef: 'three_result' },
            { fromNodeId: 'four', toNodeId: 'five', inputRef: 'four_result' },
          ],
        }, createdAt: NOW,
      });

      const producerStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-four', version: 1,
        startIdempotencyKey: 'producer-four', createdAt: NOW, ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(producerStart).toMatchObject({ ok: true, changed: true });
      const producer = producerStart.operation!.result.data as { runId: string; entryTaskId: string; activationTurnId: string };
      await expect(settleSucceeded(
        repository, client, producer.entryTaskId, producer.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'four reusable result' }, '2026-08-01T00:00:01.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });
      const producerInspection = await repository.inspectWorkflowRun(producer.runId, 'root-1');
      expect(producerInspection?.nodes).toEqual([
        { nodeId: 'produce', status: 'succeeded', taskId: producer.entryTaskId },
      ]);
      const reusableTaskId = producerInspection!.nodes[0]!.taskId!;

      const consumerStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-five-chain', version: 1,
        startIdempotencyKey: 'consumer-five-chain', createdAt: '2026-08-01T00:00:02.000Z',
        // Every suppressed node is bound explicitly to the exact producing execution;
        // the partial-reuse fixture separately proves unbound ancestors materialize.
        reuse: ['one', 'two', 'three', 'four'].map((destinationNodeId) => ({
          destinationNodeId,
          sourceRunId: producer.runId,
          sourceNodeId: 'produce',
          sourceTaskId: reusableTaskId,
        })),
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(consumerStart).toMatchObject({ ok: true, changed: true });
      // Reuse suppresses topology entry `one` and materializes consumer `five`
      // through its prefilled boundary gate. That exact task must be reported so
      // the in-memory projection and scheduler can see it without a full reload.
      const consumer = consumerStart.operation!.result.data as { runId: string };

      const nodes = await client.all<{
        node_id: string; task_id: string | null; status: string;
        source_run_id: string | null; source_node_id: string | null; source_task_id: string | null;
        source_artifact_id: string | null; source_artifact_revision: number | null;
      }>(
        `SELECT node_id, task_id, status, source_run_id, source_node_id, source_task_id,
                source_artifact_id, source_artifact_revision
           FROM workflow_nodes
         WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        [WORKSPACE_ID, consumer.runId],
      );
      // Each reused node records the caller-bound source execution, so provenance is
      // durable rather than re-derived from "latest row for this node id".
      const boundSource = {
        source_run_id: producer.runId,
        source_node_id: 'produce',
        source_task_id: reusableTaskId,
        source_artifact_id: expect.any(String),
        source_artifact_revision: 1,
      };
      expect(nodes).toEqual([
        {
          node_id: 'five', task_id: expect.any(String), status: 'active',
          source_run_id: null, source_node_id: null, source_task_id: null,
          source_artifact_id: null, source_artifact_revision: null,
        },
        { node_id: 'four', task_id: null, status: 'reused', ...boundSource },
        { node_id: 'one', task_id: null, status: 'reused', ...boundSource },
        { node_id: 'three', task_id: null, status: 'reused', ...boundSource },
        { node_id: 'two', task_id: null, status: 'reused', ...boundSource },
      ]);
      const liveFive = nodes.find((node) => node.node_id === 'five');
      expect(liveFive?.task_id).toEqual(expect.any(String));
      expect(consumerStart.affectedTaskIds).toEqual([liveFive!.task_id!]);
      await expect(client.get(
        `SELECT workflow_turns_reserved FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual({ workflow_turns_reserved: 1 });
      await expect(client.get(
        `SELECT COUNT(*) AS count FROM workflow_activations
         WHERE workspace_id = ? AND run_id = ? AND node_id IN ('one', 'two', 'three', 'four')`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual({ count: 0 });
      await expect(client.get(
        `SELECT binding.required_kind, fill.artifact_run_id FROM workflow_gate_bindings binding
         JOIN workflow_gate_fills fill ON fill.workspace_id = binding.workspace_id AND fill.run_id = binding.run_id
          AND fill.gate_id = binding.gate_id AND fill.input_ref = binding.input_ref
         WHERE binding.workspace_id = ? AND binding.run_id = ? AND binding.producer_node_id = 'four'`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual({ required_kind: 'next_result', artifact_run_id: producer.runId });

      const five = await client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = 'five'`,
        [WORKSPACE_ID, consumer.runId],
      );
      expect(five?.task_id).toBeTruthy();
      const fiveTurn = (await repository.listTurns(five!.task_id))[0]!;
      await expect(settleSucceeded(
        repository, client, five!.task_id, fiveTurn.id,
        { kind: 'workflow_next', change: 'updated', result: 'five terminal result' }, '2026-08-01T00:00:03.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });

      await expect(client.get(
        `SELECT status, terminal_result_run_id, terminal_result_artifact_id, terminal_result_artifact_revision
         FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`, [WORKSPACE_ID, consumer.runId],
      )).resolves.toMatchObject({
        status: 'succeeded', terminal_result_run_id: consumer.runId,
        terminal_result_artifact_id: expect.any(String), terminal_result_artifact_revision: 1,
      });
      const inspection = await repository.inspectWorkflowRun(consumer.runId, 'root-1');
      const status = await repository.getWorkflowStatusForTask(five!.task_id);
      expect(inspection?.nodes).toEqual([
        { nodeId: 'five', status: 'succeeded', taskId: five!.task_id },
        { nodeId: 'four', status: 'reused' },
        { nodeId: 'one', status: 'reused' },
        { nodeId: 'three', status: 'reused' },
        { nodeId: 'two', status: 'reused' },
      ]);
      expect(status).toMatchObject({ runId: consumer.runId, nodeId: 'five', runStatus: 'succeeded' });
      expect(forbiddenProjectionLeak(inspection)).toEqual([]);
      expect(forbiddenProjectionLeak(status)).toEqual([]);
      expect(inspection?.diagnostics).not.toContainEqual({ code: 'terminal_run_has_live_gate' });
      await expect(client.all(
        `SELECT consumer_node_id, status FROM workflow_dependency_gates
          WHERE workspace_id = ? AND run_id = ? ORDER BY consumer_node_id`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual([
        { consumer_node_id: 'five', status: 'consumed' },
        { consumer_node_id: 'four', status: 'consumed' },
        { consumer_node_id: 'one', status: 'consumed' },
        { consumer_node_id: 'three', status: 'consumed' },
        { consumer_node_id: 'two', status: 'consumed' },
      ]);

      // The reused producer artifact stays addressable across a reclamation pass:
      // the shared pin predicate excludes runs whose artifacts another run references.
      await expect(repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
      })).resolves.toMatchObject({ ok: true });
      await expect(client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`, [WORKSPACE_ID, producer.runId],
      )).resolves.toEqual({ run_id: producer.runId });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
