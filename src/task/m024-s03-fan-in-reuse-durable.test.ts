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
    goal: 'coordinate fan-in reuse', parentId: null, prerequisites: [], backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 }, revision: 0,
    createdAt: NOW, updatedAt: NOW, releasedAt: NOW,
  };
}

async function settleSucceeded(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  result: string,
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
  const disposition: TurnDisposition = { kind: 'workflow_next', change: 'updated', result };
  await stageDispositionForSettlement(repository, turn!, disposition);
  return repository.execute({
    kind: 'settleTurnAndApplyEffects', workspaceId: WORKSPACE_ID,
    expectedTaskRevision: task!.revision,
    task: { ...task!, lifecycle: 'succeeded', updatedAt: finishedAt },
    turn: { ...turn!, status: 'succeeded', finishedAt, disposition },
    expectedStatuses: ['running'], relatedTurns: [], messages: [],
  });
}

async function produce(
  repository: SqliteTaskRepository,
  client: DbClient,
  nodeId: string,
  result: string,
  index: number,
  runKey = '',
) {
  const definitionId = `producer-${nodeId}`;
  await repository.execute({
    kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId, version: 1,
    name: `produce ${nodeId}`,
    topology: { kind: 'one_node_v1', nodes: [{ nodeId }], entryNodeId: nodeId },
    createdAt: NOW,
  });
  const started = await repository.execute({
    kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId, version: 1,
    startIdempotencyKey: `start-${nodeId}${runKey}`, createdAt: NOW,
    ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
  });
  expect(started).toMatchObject({ ok: true, changed: true });
  const run = started.operation!.result.data as { runId: string; entryTaskId: string; activationTurnId: string };
  await expect(settleSucceeded(
    repository, client, run.entryTaskId, run.activationTurnId, result,
    `2026-08-01T00:00:0${index}.000Z`,
  )).resolves.toMatchObject({ ok: true, changed: true });
  return run;
}

describe('M024 S03 independent fan-in artifact reuse', () => {
  it('reuses a succeeded node from a source run that failed downstream', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s03-failed-source-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'm024-s03-failed-source', 'M024 S03 failed source', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: rootTask() });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: { id: 'root-turn', taskId: 'root-1', sequence: 1, status: 'running', trigger: 'user', inputs: [], createdAt: NOW, startedAt: NOW },
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'source-fails-late', version: 1,
        name: 'source fails late', topology: {
          kind: 'graph_v1', nodes: [{ nodeId: 'one' }, { nodeId: 'later' }],
          edges: [{ fromNodeId: 'one', toNodeId: 'later', inputRef: 'one_result' }],
        }, createdAt: NOW,
      });
      const sourceStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'source-fails-late', version: 1,
        startIdempotencyKey: 'source-fails-late', createdAt: NOW,
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(sourceStart).toMatchObject({ ok: true, changed: true });
      const source = sourceStart.operation!.result.data as { runId: string; entryTaskId: string; activationTurnId: string };
      await expect(settleSucceeded(
        repository, client, source.entryTaskId, source.activationTurnId,
        'one completed result', '2026-08-01T00:00:01.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });

      const later = await client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = 'later'`,
        [WORKSPACE_ID, source.runId],
      );
      expect(later?.task_id).toBeTruthy();
      const laterTurn = (await repository.listTurns(later!.task_id))[0]!;
      await client.run(
        `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
        ['2026-08-01T00:00:02.000Z', WORKSPACE_ID, laterTurn.id],
      );
      const laterTask = await repository.getTask(later!.task_id);
      const runningLaterTurn = await repository.getTurn(laterTurn.id);
      const failDisposition: TurnDisposition = { kind: 'workflow_fail', reason: 'downstream failed' };
      await stageDispositionForSettlement(repository, runningLaterTurn!, failDisposition);
      await expect(repository.execute({
        kind: 'settleTurnAndApplyEffects', workspaceId: WORKSPACE_ID,
        expectedTaskRevision: laterTask!.revision,
        task: { ...laterTask!, updatedAt: '2026-08-01T00:00:02.000Z' },
        turn: { ...runningLaterTurn!, status: 'succeeded', finishedAt: '2026-08-01T00:00:02.000Z', disposition: failDisposition },
        expectedStatuses: ['running'], relatedTurns: [], messages: [],
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(client.get(
        `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, source.runId],
      )).resolves.toEqual({ status: 'failed' });
      await expect(client.get(
        `SELECT turn.status
           FROM workflow_artifacts artifact
           JOIN workflow_artifact_sources source
             ON source.workspace_id = artifact.workspace_id
            AND source.run_id = artifact.run_id
            AND source.artifact_id = artifact.artifact_id
            AND source.artifact_revision = artifact.revision
           JOIN turns turn
             ON turn.workspace_id = source.workspace_id
            AND turn.id = source.producing_turn_id
            AND turn.task_id = source.producer_task_id
          WHERE artifact.workspace_id = ? AND artifact.run_id = ?
            AND artifact.producer_node_id = 'one' AND artifact.kind = 'next_result'`,
        [WORKSPACE_ID, source.runId],
      )).resolves.toEqual({ status: 'succeeded' });

      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'reuse-after-failure', version: 1,
        name: 'reuse after failure', topology: {
          kind: 'graph_v1', nodes: [{ nodeId: 'one' }, { nodeId: 'sink' }],
          edges: [{ fromNodeId: 'one', toNodeId: 'sink', inputRef: 'one_result' }],
        }, createdAt: NOW,
      });
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'reuse-after-failure', version: 1,
        startIdempotencyKey: 'reuse-succeeded-node', createdAt: '2026-08-01T00:00:03.000Z',
        reuse: [{
          destinationNodeId: 'one', sourceRunId: source.runId,
          sourceNodeId: 'one', sourceTaskId: source.entryTaskId,
        }],
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      })).resolves.toMatchObject({ ok: true, changed: true, affectedTaskIds: [expect.any(String)] });

      // Same reusable run and node, but a real task that did not produce that artifact.
      // The engine must honour the caller's exact execution rather than resolving the
      // newest artifact for the node id, which would silently accept this binding.
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'reuse-after-failure', version: 1,
        startIdempotencyKey: 'reuse-wrong-task', createdAt: '2026-08-01T00:00:03.500Z',
        reuse: [{
          destinationNodeId: 'one', sourceRunId: source.runId,
          sourceNodeId: 'one', sourceTaskId: later!.task_id,
        }],
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      })).resolves.toMatchObject({
        ok: false, conflict: true, reason: 'node reuse reference unresolved',
      });

      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'reuse-failed-node', version: 1,
        name: 'reuse failed node', topology: {
          kind: 'graph_v1', nodes: [{ nodeId: 'later' }, { nodeId: 'sink' }],
          edges: [{ fromNodeId: 'later', toNodeId: 'sink', inputRef: 'later_result' }],
        }, createdAt: NOW,
      });
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'reuse-failed-node', version: 1,
        startIdempotencyKey: 'reuse-failed-node', createdAt: '2026-08-01T00:00:04.000Z',
        reuse: [{
          destinationNodeId: 'later', sourceRunId: source.runId,
          sourceNodeId: 'later', sourceTaskId: later!.task_id,
        }],
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      })).resolves.toMatchObject({ ok: false, conflict: true, reason: 'node reuse reference unresolved' });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('fills a new fifth task from four independently completed producer runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s03-fan-in-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'm024-s03-fan-in', 'M024 S03 fan-in', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: rootTask() });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: { id: 'root-turn', taskId: 'root-1', sequence: 1, status: 'running', trigger: 'user', inputs: [], createdAt: NOW, startedAt: NOW },
      });

      const producers = await Promise.all(['one', 'two', 'three', 'four'].map((nodeId, index) =>
        produce(repository, client, nodeId, `${nodeId} prior result`, index + 1),
      ));
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'five-inputs', version: 1,
        name: 'combine four prior results',
        topology: {
          kind: 'graph_v1', nodes: ['one', 'two', 'three', 'four', 'five'].map((nodeId) => ({ nodeId })),
          edges: ['one', 'two', 'three', 'four'].map((fromNodeId) => ({
            fromNodeId, toNodeId: 'five', inputRef: `${fromNodeId}_result`,
          })),
        }, createdAt: NOW,
      });

      const started = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'five-inputs', version: 1,
        startIdempotencyKey: 'fan-in', createdAt: '2026-08-01T00:00:10.000Z',
        // Four destinations, four different source runs and executions: provenance has to
        // be recorded per node, not once per start.
        reuse: producers.map((producer, index) => ({
          destinationNodeId: ['one', 'two', 'three', 'four'][index]!,
          sourceRunId: producer.runId,
          sourceNodeId: ['one', 'two', 'three', 'four'][index]!,
          sourceTaskId: producer.entryTaskId,
        })),
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const consumer = started.operation!.result.data as { runId: string };

      const sourceOf = (nodeId: string) => {
        const index = ['one', 'two', 'three', 'four'].indexOf(nodeId);
        return {
          source_run_id: producers[index]!.runId,
          source_node_id: nodeId,
          source_task_id: producers[index]!.entryTaskId,
        };
      };
      await expect(client.all<{
        node_id: string; task_id: string | null; status: string;
        source_run_id: string | null; source_node_id: string | null; source_task_id: string | null;
      }>(
        `SELECT node_id, task_id, status, source_run_id, source_node_id, source_task_id
           FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual([
        {
          node_id: 'five', task_id: expect.any(String), status: 'active',
          source_run_id: null, source_node_id: null, source_task_id: null,
        },
        { node_id: 'four', task_id: null, status: 'reused', ...sourceOf('four') },
        { node_id: 'one', task_id: null, status: 'reused', ...sourceOf('one') },
        { node_id: 'three', task_id: null, status: 'reused', ...sourceOf('three') },
        { node_id: 'two', task_id: null, status: 'reused', ...sourceOf('two') },
      ]);
      await expect(client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_gate_fills
          WHERE workspace_id = ? AND run_id = ?`, [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual({ count: 4 });
      await expect(client.get<{ content: string }>(
        `SELECT message.content FROM messages message
           JOIN workflow_nodes node ON node.workspace_id = message.workspace_id AND node.task_id = message.task_id
          WHERE node.workspace_id = ? AND node.run_id = ? AND node.node_id = 'five'`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual({
        content: '[workflow-aggregate] one_result=one prior result two_result=two prior result three_result=three prior result four_result=four prior result',
      });
      await expect(client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = ? AND parent_id = ?`,
        [WORKSPACE_ID, 'root-1'],
      )).resolves.toEqual({ count: 5 });

      // Each artifact is individually within the default 256 KiB cap, but four
      // results plus labels and envelope exceed the default 1 MiB aggregate cap.
      // Rejection must happen before a second consumer run claims durable state.
      const largeProducers = await Promise.all(['one', 'two', 'three', 'four'].map((nodeId, index) =>
        produce(repository, client, nodeId, 'x'.repeat(262_144), index + 5, '-large'),
      ));
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'five-inputs', version: 1,
        startIdempotencyKey: 'fan-in-overflow', createdAt: '2026-08-01T00:00:11.000Z',
        reuse: largeProducers.map((producer, index) => ({
          destinationNodeId: ['one', 'two', 'three', 'four'][index]!,
          sourceRunId: producer.runId,
          sourceNodeId: ['one', 'two', 'three', 'four'][index]!,
          sourceTaskId: producer.entryTaskId,
        })),
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      })).resolves.toMatchObject({ ok: false, conflict: true, reason: 'reuse aggregate exceeds policy' });
      await expect(client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_runs WHERE workspace_id = ? AND definition_id = ?`,
        [WORKSPACE_ID, 'five-inputs'],
      )).resolves.toEqual({ count: 1 });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
