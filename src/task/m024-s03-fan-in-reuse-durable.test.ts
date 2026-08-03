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
      // A terminal artifact can exist on a run later marked failed, but it is not
      // a reusable "done" result. Reject it before the consumer claims any rows.
      await client.run(
        `UPDATE workflow_runs SET status = 'failed' WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, producers[0]!.runId],
      );
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

      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'five-inputs', version: 1,
        startIdempotencyKey: 'failed-source', createdAt: '2026-08-01T00:00:09.000Z',
        reuse: [{ nodeId: 'one', fromRun: producers[0]!.runId }],
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      })).resolves.toMatchObject({ ok: false, conflict: true, reason: 'node reuse reference unresolved' });
      await client.run(
        `UPDATE workflow_runs SET status = 'succeeded' WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, producers[0]!.runId],
      );

      const started = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'five-inputs', version: 1,
        startIdempotencyKey: 'fan-in', createdAt: '2026-08-01T00:00:10.000Z',
        reuse: producers.map((producer, index) => ({ nodeId: ['one', 'two', 'three', 'four'][index]!, fromRun: producer.runId })),
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const consumer = started.operation!.result.data as { runId: string };

      await expect(client.all<{ node_id: string; task_id: string | null; status: string }>(
        `SELECT node_id, task_id, status FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        [WORKSPACE_ID, consumer.runId],
      )).resolves.toEqual([
        { node_id: 'five', task_id: expect.any(String), status: 'active' },
        { node_id: 'four', task_id: null, status: 'reused' },
        { node_id: 'one', task_id: null, status: 'reused' },
        { node_id: 'three', task_id: null, status: 'reused' },
        { node_id: 'two', task_id: null, status: 'reused' },
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
        reuse: largeProducers.map((producer, index) => ({ nodeId: ['one', 'two', 'three', 'four'][index]!, fromRun: producer.runId })),
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
