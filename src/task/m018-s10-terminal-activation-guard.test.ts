import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { canPromoteTurn } from './scheduler';
import { DbClient } from './sqlite/client';
import type { EngineProjection, TaskTurn } from './types';

const clients: DbClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('M018 terminal workflow activation guards', () => {
  it('terminal run rejects stale activation but permits later ordinary turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s10-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    clients.push(client);
    await client.open(dbPath);
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-one',
      version: 1,
      name: 'one',
      topology: {
        kind: 'one_node_v1',
        nodes: [{ nodeId: 'entry' }],
        entryNodeId: 'entry',
      },
      createdAt: '2026-07-22T04:00:00.000Z',
    });
    const started = await repository.execute({
      kind: 'startWorkflowRun',
      workspaceId: 'ws',
      definitionId: 'wf-one',
      version: 1,
      startIdempotencyKey: 'terminal-guard',
      createdAt: '2026-07-22T04:00:00.000Z',
      goal: 'guard',
      backend: 'grok',
    });
    const data = started.operation?.result.data as {
      runId: string;
      entryTaskId: string;
      activationTurnId: string;
    };
    const task = await repository.getTask(data.entryTaskId);
    const activationTurn = await repository.getTurn(data.activationTurnId);
    expect(task).toBeTruthy();
    expect(activationTurn?.workflowActivation).toMatchObject({
      runId: data.runId,
      runStatus: 'running',
      activationStatus: 'queued',
    });

    await client.transaction([
      {
        sql: `UPDATE turns SET status = 'cancelled', settled_at = ?
              WHERE workspace_id = 'ws' AND id = ?`,
        params: ['2026-07-22T04:00:01.000Z', data.activationTurnId],
      },
      {
        sql: `UPDATE workflow_activations SET status = 'failed', updated_at = ?
              WHERE workspace_id = 'ws' AND execution_turn_id = ?`,
        params: ['2026-07-22T04:00:01.000Z', data.activationTurnId],
      },
      {
        sql: `UPDATE workflow_runs SET status = 'failed', updated_at = ?
              WHERE workspace_id = 'ws' AND run_id = ?`,
        params: ['2026-07-22T04:00:01.000Z', data.runId],
      },
    ]);
    const stale = await repository.getTurn(data.activationTurnId);
    const staleProjection: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { [task!.id]: task! },
      turns: { [stale!.id]: stale! },
      messages: {},
    };
    expect(canPromoteTurn(staleProjection, stale!.id, DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'turn is not queued',
    });
    await expect(repository.execute({
      kind: 'claimTurn',
      workspaceId: 'ws',
      turnId: stale!.id,
      startedAt: '2026-07-22T04:00:02.000Z',
      rootTaskId: task!.id,
      maxConcurrentTurns: 10,
      maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: false, reason: 'turn is no longer eligible' });

    const ordinary: TaskTurn = {
      id: 'ordinary-turn',
      taskId: task!.id,
      sequence: 2,
      status: 'queued',
      trigger: 'user',
      runtimeEpoch: task!.runtimeEpoch ?? 1,
      inputs: [],
      createdAt: '2026-07-22T04:00:04.000Z',
    };
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: ordinary });
    const reloadedTask = await repository.getTask(task!.id);
    const reloadedOrdinary = await repository.getTurn(ordinary.id);
    expect(reloadedOrdinary?.workflowActivation).toBeUndefined();
    const ordinaryProjection: EngineProjection = {
      schemaVersion: 2,
      revision: 2,
      tasks: { [task!.id]: reloadedTask! },
      turns: { [ordinary.id]: reloadedOrdinary! },
      messages: {},
    };
    expect(canPromoteTurn(ordinaryProjection, ordinary.id, DEFAULT_RESOURCE_LIMITS)).toEqual({ ok: true });
    await expect(repository.execute({
      kind: 'claimTurn',
      workspaceId: 'ws',
      turnId: ordinary.id,
      startedAt: '2026-07-22T04:00:05.000Z',
      rootTaskId: task!.id,
      maxConcurrentTurns: 10,
      maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: true });
  });

  it('terminal closure before the settlement write lock commits no stale workflow effect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s10-settle-lock-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    const secondClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    clients.push(firstClient, secondClient);
    await firstClient.open(dbPath);
    await secondClient.open(dbPath);
    const first = new SqliteTaskRepository(firstClient, 'ws');
    const second = new SqliteTaskRepository(secondClient, 'ws');
    const createdAt = '2026-07-22T04:30:00.000Z';
    await first.execute({
      kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-lock', version: 1,
      name: 'lock', topology: {
        kind: 'one_node_v1', nodes: [{ nodeId: 'entry' }], entryNodeId: 'entry',
      }, createdAt,
    });
    const started = await first.execute({
      kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-lock', version: 1,
      startIdempotencyKey: 'settlement-lock', createdAt, goal: 'settlement lock', backend: 'grok',
    });
    const data = started.operation?.result.data as {
      runId: string; entryTaskId: string; activationTurnId: string;
    };
    const task = await second.getTask(data.entryTaskId);
    await expect(first.execute({
      kind: 'claimTurn', workspaceId: 'ws', turnId: data.activationTurnId, startedAt: createdAt,
      rootTaskId: data.entryTaskId, maxConcurrentTurns: 10, maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 10, resourceKeys: [],
    })).resolves.toMatchObject({ changed: true });
    const turn = await second.getTurn(data.activationTurnId);
    const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result: 'must-not-route' };
    await stageDispositionForSettlement(second, turn!, disposition);

    await firstClient.run('BEGIN IMMEDIATE TRANSACTION');
    const settlement = second.execute({
      kind: 'settleTurnAndApplyEffects', workspaceId: 'ws', expectedTaskRevision: task!.revision,
      task: { ...task!, updatedAt: '2026-07-22T04:31:00.000Z' },
      turn: {
        ...turn!, status: 'succeeded', finishedAt: '2026-07-22T04:31:00.000Z',
        disposition,
      },
      expectedStatuses: ['running'], relatedTurns: [], messages: [],
    });
    await firstClient.run(
      `UPDATE workflow_activations SET status = 'failed', updated_at = ?
        WHERE workspace_id = 'ws' AND run_id = ?`,
      ['2026-07-22T04:30:30.000Z', data.runId],
    );
    await firstClient.run(
      `UPDATE workflow_dependency_gates SET status = 'failed'
        WHERE workspace_id = 'ws' AND run_id = ?`,
      [data.runId],
    );
    await firstClient.run(
      `UPDATE workflow_runs
          SET status = 'failed', terminal_reason_code = 'run_timeout', updated_at = ?
        WHERE workspace_id = 'ws' AND run_id = ?`,
      ['2026-07-22T04:30:30.000Z', data.runId],
    );
    await firstClient.run('COMMIT');

    await expect(settlement).resolves.toMatchObject({ changed: true });
    await expect(firstClient.all(
      `SELECT artifact_id FROM workflow_artifact_sources
        WHERE workspace_id = 'ws' AND run_id = ? AND producing_turn_id = ?`,
      [data.runId, data.activationTurnId],
    )).resolves.toEqual([]);
    await expect(firstClient.all(
      `SELECT message_id FROM workflow_routed_messages
        WHERE workspace_id = 'ws' AND run_id = ? AND kind = 'next_contribution'`,
      [data.runId],
    )).resolves.toEqual([]);
    await expect(firstClient.get(
      `SELECT status, terminal_reason_code FROM workflow_runs
        WHERE workspace_id = 'ws' AND run_id = ?`,
      [data.runId],
    )).resolves.toEqual({ status: 'failed', terminal_reason_code: 'run_timeout' });
  });

  it('workflow waits block unrelated claims and active runs reject runtime handoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s10-waits-'));
    tempDirs.push(dir);
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-waits',
      version: 1,
      name: 'waits',
      topology: {
        kind: 'one_node_v1',
        nodes: [{ nodeId: 'entry' }],
        entryNodeId: 'entry',
      },
      createdAt: '2026-07-22T05:00:00.000Z',
    });
    const started = await repository.execute({
      kind: 'startWorkflowRun',
      workspaceId: 'ws',
      definitionId: 'wf-waits',
      version: 1,
      startIdempotencyKey: 'workflow-waits',
      createdAt: '2026-07-22T05:00:00.000Z',
      goal: 'wait authority',
      backend: 'grok',
    });
    const data = started.operation?.result.data as {
      runId: string;
      entryTaskId: string;
      activationTurnId: string;
    };
    const task = await repository.getTask(data.entryTaskId);
    const activationTurn = await repository.getTurn(data.activationTurnId);
    expect(task).toBeTruthy();
    expect(activationTurn).toBeTruthy();

    await expect(repository.execute({
      kind: 'requestRuntimeHandoff',
      workspaceId: 'ws',
      taskId: task!.id,
      expectedTaskRevision: task!.revision,
      task: {
        ...task!,
        backend: 'codex',
        runtimeEpoch: (task!.runtimeEpoch ?? 1) + 1,
        revision: task!.revision + 1,
        updatedAt: '2026-07-22T05:00:01.000Z',
      },
      turns: [{ ...activationTurn!, runtimeEpoch: (task!.runtimeEpoch ?? 1) + 1 }],
      expectedTurns: [{
        id: activationTurn!.id,
        status: activationTurn!.status,
        runtimeEpoch: activationTurn!.runtimeEpoch,
      }],
      cancelRequests: [],
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.getTask(task!.id)).resolves.toMatchObject({
      backend: 'grok',
      revision: task!.revision,
    });

    await client.transaction([
      {
        sql: `UPDATE turns SET status = 'succeeded', settled_at = ?
               WHERE workspace_id = ? AND id = ?`,
        params: ['2026-07-22T05:00:02.000Z', 'ws', activationTurn!.id],
      },
      {
        sql: `UPDATE workflow_activations SET status = 'consumed', updated_at = ?
               WHERE workspace_id = ? AND execution_turn_id = ?`,
        params: ['2026-07-22T05:00:02.000Z', 'ws', activationTurn!.id],
      },
    ]);
    const ordinary: TaskTurn = {
      id: 'ordinary-wait-turn',
      taskId: task!.id,
      sequence: 2,
      status: 'queued',
      trigger: 'user',
      runtimeEpoch: task!.runtimeEpoch ?? 1,
      inputs: [],
      createdAt: '2026-07-22T05:00:03.000Z',
    };
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: ordinary });
    await client.run(
      `INSERT INTO workflow_feedback_rounds (
         workspace_id, run_id, round_id, requester_node_id, requester_task_id,
         requester_turn_id, status, join_mode, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        'ws', data.runId, 'round-wait', 'entry', task!.id, activationTurn!.id,
        'open', 'all', '2026-07-22T05:00:03.000Z',
      ],
    );
    const feedbackBlocked = await repository.getTurn(ordinary.id);
    const feedbackProjection: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { [task!.id]: task! },
      turns: { [ordinary.id]: feedbackBlocked! },
      messages: {},
    };
    expect(canPromoteTurn(feedbackProjection, ordinary.id, DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'waiting on workflow feedback',
    });
    await expect(repository.execute({
      kind: 'claimTurn', workspaceId: 'ws', turnId: ordinary.id,
      startedAt: '2026-07-22T05:00:04.000Z', rootTaskId: task!.id,
      maxConcurrentTurns: 10, maxConcurrentPerRoot: 10, maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: false, reason: 'turn is no longer eligible' });

    await client.run(
      `DELETE FROM workflow_feedback_rounds
        WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
      ['ws', data.runId, 'round-wait'],
    );
    const childRunId = 'wfr_wait_child';
    await client.transaction([
      {
        sql: `INSERT INTO workflow_runs (
                workspace_id, run_id, definition_id, definition_version, status,
                origin, parent_run_id, created_at, updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?)`,
        params: [
          'ws', childRunId, 'wf-waits', 1, 'running', 'child', data.runId,
          '2026-07-22T05:00:05.000Z', '2026-07-22T05:00:05.000Z',
        ],
      },
      {
        sql: `INSERT INTO workflow_continuations (
                workspace_id, run_id, continuation_id, caller_task_id, caller_turn_id,
                caller_run_id, caller_node_id, child_run_id, kind, status,
                payload_json, created_at, updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          'ws', data.runId, 'continuation-wait', task!.id, activationTurn!.id,
          data.runId, 'entry', childRunId, 'child_workflow', 'pending', '{}',
          '2026-07-22T05:00:05.000Z', '2026-07-22T05:00:05.000Z',
        ],
      },
    ]);
    const continuationBlocked = await repository.getTurn(ordinary.id);
    const continuationProjection: EngineProjection = {
      ...feedbackProjection,
      turns: { [ordinary.id]: continuationBlocked! },
    };
    expect(canPromoteTurn(continuationProjection, ordinary.id, DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'waiting on child workflow',
    });
    await expect(repository.execute({
      kind: 'claimTurn', workspaceId: 'ws', turnId: ordinary.id,
      startedAt: '2026-07-22T05:00:06.000Z', rootTaskId: task!.id,
      maxConcurrentTurns: 10, maxConcurrentPerRoot: 10, maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: false, reason: 'turn is no longer eligible' });
  });
});
