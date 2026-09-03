import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../bridge/credentials';
import { durableDispositionClaim } from './disposition-claim';
import { deriveEntityId, executeToolCommand, type GraphEngineDeps } from './engine-graph';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { SqliteTaskRepository } from './repository';
import { canPromoteTurn } from './scheduler';
import { DbClient } from './sqlite/client';
import { applySuccessfulTurn } from './transitions';
import type { EngineProjection, MusterTask, TaskTurn, TurnDisposition } from './types';
import type { WorkflowAgentOutcome } from './workflow-types';
import { DEFAULT_WORKFLOW_POLICY } from './workflow';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const clients: DbClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeClient(): DbClient {
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  return client;
}

function makeTask(id = 'task'): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'released',
    goal: 'disposition race',
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    runtimeEpoch: 1,
    revision: 0,
    createdAt: '2026-07-22T02:00:00.000Z',
    updatedAt: '2026-07-22T02:00:00.000Z',
  };
}

function makeTurn(id: string, sequence: number, taskId = 'task'): TaskTurn {
  return {
    id,
    taskId,
    sequence,
    status: 'running',
    trigger: 'engine',
    runtimeEpoch: 1,
    inputs: [],
    createdAt: '2026-07-22T02:00:01.000Z',
    startedAt: '2026-07-22T02:00:02.000Z',
  };
}

async function stage(
  repository: SqliteTaskRepository,
  turn: TaskTurn,
  opId: string,
  disposition: TurnDisposition,
) {
  return repository.execute({
    kind: 'stageDisposition',
    workspaceId: 'ws',
    turnId: turn.id,
    opId,
    turn: { ...turn, disposition },
    expectedStatuses: ['running'],
    expectedRuntimeEpoch: 1,
  });
}

async function bindWorkflowActivation(
  repository: SqliteTaskRepository,
  client: DbClient,
  turn: TaskTurn,
  outcome?: WorkflowAgentOutcome,
  options: {
    origin?: 'top_level' | 'child';
    activationStatus?: 'queued' | 'running' | 'failed' | 'interrupted';
    activationKind?: 'entry_start' | 'child_return';
  } = {},
): Promise<void> {
  const runId = `run-${turn.id}`;
  const origin = options.origin ?? 'top_level';
  const parentRunId = origin === 'child' ? `parent-${runId}` : null;
  const activationKind = options.activationKind ?? 'entry_start';
  const messageId = `message-${turn.id}`;
  await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId: `definition-${turn.id}`,
    version: 1,
    name: 'Disposition race',
    topology: {
      kind: 'workflow',
      inputs: [],
      outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'node' }],
      nodes: [{ nodeId: 'node', ...(outcome ? { outcome } : {}) }],
      edges: [],
    },
    entryContracts: [],
    policy: DEFAULT_WORKFLOW_POLICY,
    createdAt: turn.createdAt,
  });
  await client.transaction([
    ...(parentRunId
      ? [{
          sql: `INSERT INTO workflow_runs (
                  workspace_id, run_id, definition_id, definition_version,
                  status, origin, created_at, updated_at
                ) VALUES ('ws', ?, ?, 1, 'running', 'top_level', ?, ?)`,
          params: [parentRunId, `definition-${turn.id}`, turn.createdAt, turn.createdAt],
        }]
      : []),
    {
      sql: `INSERT INTO workflow_runs (
              workspace_id, run_id, definition_id, definition_version,
              status, origin, parent_run_id, created_at, updated_at
            ) VALUES ('ws', ?, ?, 1, 'running', ?, ?, ?, ?)`,
      params: [
        runId,
        `definition-${turn.id}`,
        origin,
        parentRunId,
        turn.createdAt,
        turn.createdAt,
      ],
    },
    {
      sql: `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
            VALUES ('ws', ?, 'node', ?, 'active')`,
      params: [runId, turn.taskId],
    },
    {
      sql: `INSERT INTO messages (
              id, workspace_id, task_id, turn_id, role, state, ordering,
              content, created_at, payload_json
            ) VALUES (?, 'ws', ?, ?, 'system', 'assigned', 0, '[activation]', ?, '{"payloadVersion":1}')`,
      params: [messageId, turn.taskId, turn.id, turn.createdAt],
    },
    {
       sql: `INSERT INTO workflow_activations (
               workspace_id, run_id, activation_id, node_id, kind, status,
               source_gate_id, continuation_id, return_gate_id,
               primary_turn_id, message_id, execution_turn_id,
               created_at, updated_at
             ) VALUES ('ws', ?, ?, 'node', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        runId,
        `activation-${turn.id}`,
        activationKind,
        options.activationStatus ?? 'running',
        activationKind === 'entry_start' ? 'entry-gate' : null,
        activationKind === 'child_return' ? `continuation-${turn.id}` : null,
        activationKind === 'child_return' ? `return-gate-${turn.id}` : null,
        turn.id,
        messageId,
        turn.id,
        turn.createdAt,
        turn.createdAt,
      ],
    },
  ]);
}

function graphDeps(
  repository: SqliteTaskRepository,
  task: MusterTask,
  turn: TaskTurn,
  overrides: Partial<GraphEngineDeps> = {},
): GraphEngineDeps {
  const file: EngineProjection = {
    schemaVersion: 1,
    revision: 1,
    tasks: { [task.id]: task },
    turns: { [turn.id]: turn },
    messages: {},
    toolCalls: {},
    reasoning: {},
    operations: {},
    cancelRequests: {},
  };
  return {
    store: {
      getFile: () => file,
      getTask: (taskId) => file.tasks[taskId],
      getTurnsForTask: (taskId) => Object.values(file.turns).filter((candidate) => candidate.taskId === taskId),
      viewStatusOf: () => undefined,
    },
    repository,
    workspaceId: 'ws',
    makeBackend: () => {
      throw new Error('backend not used');
    },
    credentials: new CredentialRegistry(),
    askBridge: { ask: async () => ({}) } as unknown as GraphEngineDeps['askBridge'],
    bridgePort: 0,
    liveRuns: new Map(),
    pendingAskPromises: new Map(),
    onScheduleTurn: () => undefined,
    leaseOwnerAlive: () => false,
    ownsLease: () => false,
    writeCancelRequest: () => undefined,
    isWorkspaceTrusted: () => true,
    ...overrides,
  };
}

describe('M018 universal durable disposition claims', () => {
  it('fails closed for persisted schema-7 child activations across execution paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-legacy-child-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');

    const queuedTask = makeTask('legacy-child-queued-task');
    const queuedTurn = { ...makeTurn('legacy-child-queued-turn', 1, queuedTask.id), status: 'queued' as const };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: queuedTask });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: queuedTurn });
    await bindWorkflowActivation(repository, client, queuedTurn, undefined, {
      origin: 'child',
      activationStatus: 'queued',
    });

    await expect(repository.getWorkflowExecutionContext(queuedTurn.id)).resolves.toBeUndefined();
    await expect(repository.getTurn(queuedTurn.id)).resolves.toBeUndefined();
    await expect(repository.listTurnActivityForTasks([queuedTask.id])).resolves.toEqual([]);
    await expect(repository.listQueuedTurns(queuedTask.id)).resolves.toEqual([]);
    await expect(repository.execute({
      kind: 'claimTurn',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      startedAt: '2026-07-22T02:00:02.000Z',
      rootTaskId: queuedTask.id,
      maxConcurrentTurns: 10,
      maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'promoteTurn',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      startedAt: '2026-07-22T02:00:02.000Z',
    })).resolves.toMatchObject({ changed: false });
    await client.transaction([
      {
        sql: `UPDATE turns SET status = 'running', started_at = ?
               WHERE workspace_id = 'ws' AND id = ?`,
        params: ['2026-07-22T02:00:02.000Z', queuedTurn.id],
      },
      {
        sql: `UPDATE workflow_activations SET status = 'running', updated_at = ?
               WHERE workspace_id = 'ws' AND execution_turn_id = ?`,
        params: ['2026-07-22T02:00:02.000Z', queuedTurn.id],
      },
    ]);
    const activeChildTurn: TaskTurn = {
      ...queuedTurn,
      status: 'running',
      startedAt: '2026-07-22T02:00:02.000Z',
    };
    await expect(repository.execute({
      kind: 'stageDisposition',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      opId: 'legacy-child-stage',
      turn: {
        ...activeChildTurn,
        disposition: { kind: 'workflow_next', change: 'updated', result: 'must not route' },
      },
      expectedStatuses: ['running'],
      expectedRuntimeEpoch: 1,
    })).resolves.toMatchObject({ changed: false });

    const failedTask = makeTask('legacy-child-failed-task');
    const failedTurn = {
      ...makeTurn('legacy-child-failed-turn', 1, failedTask.id),
      status: 'failed' as const,
      finishedAt: '2026-07-22T02:00:03.000Z',
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: failedTask });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: failedTurn });
    await bindWorkflowActivation(repository, client, failedTurn, undefined, {
      origin: 'child',
      activationStatus: 'failed',
    });
    await expect(repository.execute({
      kind: 'recoverWorkflowActivation',
      workspaceId: 'ws',
      runId: `run-${failedTurn.id}`,
      activationId: `activation-${failedTurn.id}`,
      failedTurnId: failedTurn.id,
      recoveryOperationId: 'legacy-child-recovery',
      fingerprint: 'legacy-child-recovery-v1',
      instruction: 'Must not recover retired nested workflow state.',
      expectedActivationStatus: 'failed',
      createdAt: '2026-07-22T02:00:04.000Z',
    })).resolves.toMatchObject({ changed: false });

    const runningTask = makeTask('legacy-child-running-task');
    const runningTurn = makeTurn('legacy-child-running-turn', 1, runningTask.id);
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: runningTask });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: runningTurn });
    await bindWorkflowActivation(repository, client, runningTurn, undefined, { origin: 'child' });
    await expect(repository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: runningTask.revision,
      task: { ...runningTask, updatedAt: '2026-07-22T02:00:05.000Z' },
      turn: {
        ...runningTurn,
        status: 'succeeded',
        finishedAt: '2026-07-22T02:00:05.000Z',
      },
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({ changed: false });
    await expect(client.get<{ status: string }>(
      `SELECT status FROM workflow_activations
        WHERE workspace_id = 'ws' AND run_id = ? AND activation_id = ?`,
      [`run-${runningTurn.id}`, `activation-${runningTurn.id}`],
    )).resolves.toEqual({ status: 'running' });
  });

  it('keeps persisted schema-7 child-return activations hidden and inert', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-legacy-child-return-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const task = makeTask('legacy-child-return-task');
    const pendingMessageId = 'legacy-child-return-pending-message';
    const queuedTurn = {
      ...makeTurn('legacy-child-return-turn', 1, task.id),
      status: 'queued' as const,
      startedAt: undefined,
      holdAutoPromote: true,
      inputs: [{ kind: 'message' as const, messageId: pendingMessageId }],
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: queuedTurn });
    await client.run(
      `INSERT INTO messages (
         id, workspace_id, task_id, turn_id, role, state, ordering,
         content, created_at, payload_json
       ) VALUES (?, 'ws', ?, ?, 'user', 'pending', 0, 'original pending message', ?, '{"payloadVersion":1}')`,
      [pendingMessageId, task.id, queuedTurn.id, queuedTurn.createdAt],
    );
    await bindWorkflowActivation(repository, client, queuedTurn, {
      kind: 'agent',
      requireExplicitDisposition: true,
      next: { when: 'The result is ready.' },
    }, {
      origin: 'top_level',
      activationStatus: 'queued',
      activationKind: 'child_return',
    });
    const runId = `run-${queuedTurn.id}`;
    const activationId = `activation-${queuedTurn.id}`;
    await client.run(
      `UPDATE workflow_runs
          SET owner_root_task_id = ?, caller_task_id = ?, caller_turn_id = ?
        WHERE workspace_id = 'ws' AND run_id = ?`,
      [task.id, task.id, queuedTurn.id, runId],
    );
    await client.transaction([
      {
        sql: `INSERT INTO runtime_claims
                (workspace_id, turn_id, owner_id, claimed_at, heartbeat_at, expires_at)
              VALUES ('ws', ?, 'legacy-runtime-owner', ?, ?, ?)`,
        params: [
          queuedTurn.id,
          '2026-07-22T02:00:01.000Z',
          '2026-07-22T02:00:01.000Z',
          '2099-01-01T00:00:00.000Z',
        ],
      },
      {
        sql: `INSERT INTO turn_cancel_requests
                (workspace_id, turn_id, task_id, kind, op_id, requested_by, requested_at, payload_json)
              VALUES ('ws', ?, ?, 'cancel', 'legacy-cancel', 'legacy-worker', ?, '{"payloadVersion":1}')`,
        params: [queuedTurn.id, task.id, '2026-07-22T02:00:01.000Z'],
      },
    ]);

    await expect(repository.getTurn(queuedTurn.id)).resolves.toBeUndefined();
    await expect(repository.listTurns(task.id)).resolves.toEqual([]);
    await expect(repository.listTurnActivityForTasks([task.id])).resolves.toEqual([]);
    await expect(repository.listQueuedTurns(task.id)).resolves.toEqual([]);
    await expect(repository.listMessages(task.id)).resolves.toEqual([]);
    await expect(repository.listActiveTurnInputMessages([task.id])).resolves.toEqual([]);
    await expect(repository.getRuntimeClaim(queuedTurn.id)).resolves.toBeUndefined();
    await expect(repository.getCancelRequest(queuedTurn.id)).resolves.toBeUndefined();
    await expect(repository.getWorkflowExecutionContext(queuedTurn.id)).resolves.toBeUndefined();
    await expect(repository.getWorkflowStatusForTask(task.id)).resolves.not.toHaveProperty('activation');
    await expect(repository.inspectWorkflowRun(runId, task.id)).resolves.toMatchObject({ activations: [] });
    await expect(repository.getWorkflowGraphForTask(task.id)).resolves.toMatchObject({
      nodes: [expect.objectContaining({ nodeId: 'node', executionActivity: 'none' })],
    });

    const retainedDisposition: TurnDisposition = { kind: 'complete', result: 'legacy result' };
    const retainedClaim = durableDispositionClaim({
      turnId: queuedTurn.id,
      taskId: task.id,
      runtimeEpoch: queuedTurn.runtimeEpoch,
      opId: 'legacy-disposition',
      disposition: retainedDisposition,
    });
    const retainedOperationKey = `${queuedTurn.id}:legacy-operation`;
    await client.transaction([
      {
        sql: `INSERT INTO operations
                (workspace_id, ledger_key, fingerprint, result_json, created_at)
              VALUES ('ws', ?, 'legacy-operation-fingerprint', ?, ?)`,
        params: [
          retainedOperationKey,
          JSON.stringify({ payloadVersion: 1, result: { ok: true, data: { retained: true } } }),
          '2026-07-22T02:00:02.250Z',
        ],
      },
      {
        sql: `INSERT INTO turn_disposition_claims (
               workspace_id, turn_id, task_id, runtime_epoch, op_id, family, kind,
               fingerprint, payload_json, status, created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,'staged',?,?)`,
        params: [
          'ws', retainedClaim.turnId, retainedClaim.taskId, retainedClaim.runtimeEpoch,
          retainedClaim.opId, retainedClaim.family, retainedClaim.kind,
          retainedClaim.fingerprint, retainedClaim.payloadJson,
          '2026-07-22T02:00:02.250Z', '2026-07-22T02:00:02.250Z',
        ],
      },
    ]);
    await expect(repository.getOperation(retainedOperationKey)).resolves.toBeUndefined();
    await expect(repository.listOperationsForTurns([queuedTurn.id])).resolves.toEqual([]);
    await expect(repository.execute({
      kind: 'deleteOperationsForTurn',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'putOperation',
      workspaceId: 'ws',
      ledgerKey: retainedOperationKey,
      entry: {
        fingerprint: 'replacement-fingerprint',
        result: { ok: true, data: { mustNotOverwrite: true } },
      },
      createdAt: '2026-07-22T02:00:02.400Z',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'claimOperation',
      workspaceId: 'ws',
      ledgerKey: retainedOperationKey,
      entry: {
        fingerprint: 'replacement-claim-fingerprint',
        result: { ok: true, data: { mustNotReplay: true } },
      },
      createdAt: '2026-07-22T02:00:02.450Z',
    })).resolves.toMatchObject({ changed: false, reason: 'retired workflow state' });
    await expect(repository.execute({
      kind: 'completeGraphTask',
      workspaceId: 'ws',
      expectedTasks: [],
      tasks: [],
      turns: [],
      deleteOperationKeys: [retainedOperationKey],
    })).resolves.toMatchObject({ changed: false });
    const graphOperationKey = `${queuedTurn.id}:graph-replay`;
    const graphClaim = durableDispositionClaim({
      turnId: queuedTurn.id,
      taskId: task.id,
      runtimeEpoch: queuedTurn.runtimeEpoch,
      opId: 'graph-replay',
      disposition: retainedDisposition,
    });
    await expect(repository.execute({
      kind: 'completeGraphTask',
      workspaceId: 'ws',
      expectedTasks: [],
      tasks: [],
      turns: [{ ...queuedTurn, disposition: retainedDisposition }],
      operation: {
        ledgerKey: graphOperationKey,
        entry: {
          fingerprint: 'graph-replay-fingerprint',
          result: { ok: true, data: { mustNotPersist: true } },
        },
        createdAt: '2026-07-22T02:00:02.500Z',
      },
      dispositionClaim: graphClaim,
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.getOperation(graphOperationKey)).resolves.toBeUndefined();
    await expect(client.get(
      `SELECT fingerprint FROM operations WHERE workspace_id = 'ws' AND ledger_key = ?`,
      [retainedOperationKey],
    )).resolves.toEqual({ fingerprint: 'legacy-operation-fingerprint' });

    await expect(repository.execute({
      kind: 'applyTaskLifecycle',
      workspaceId: 'ws',
      taskId: task.id,
      expectedTaskRevision: task.revision,
      task: {
        ...task,
        lifecycle: 'cancelled',
        revision: task.revision + 1,
        updatedAt: '2026-07-22T02:00:02.750Z',
        finishedAt: '2026-07-22T02:00:02.750Z',
      },
      turns: [{
        ...queuedTurn,
        status: 'cancelled',
        finishedAt: '2026-07-22T02:00:02.750Z',
        inputs: [],
      }],
    })).resolves.toMatchObject({ changed: false });
    await expect(client.get(
      `SELECT lifecycle, revision FROM tasks WHERE workspace_id = 'ws' AND id = ?`,
      [task.id],
    )).resolves.toEqual({ lifecycle: 'open', revision: task.revision });
    await expect(client.get(
      `SELECT status FROM turns WHERE workspace_id = 'ws' AND id = ?`,
      [queuedTurn.id],
    )).resolves.toEqual({ status: 'queued' });
    await expect(client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM turn_inputs WHERE workspace_id = 'ws' AND turn_id = ?`,
      [queuedTurn.id],
    )).resolves.toEqual({ count: 1 });

    await expect(repository.execute({
      kind: 'upsertTurn',
      workspaceId: 'ws',
      turn: {
        ...queuedTurn,
        status: 'cancelled',
        finishedAt: '2026-07-22T02:00:02.500Z',
      },
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'clearQueuedTurnHold',
      workspaceId: 'ws',
      taskId: task.id,
      turnId: queuedTurn.id,
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'editQueuedMessage',
      workspaceId: 'ws',
      taskId: task.id,
      turnId: queuedTurn.id,
      content: 'must not edit',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'deleteQueuedTurnAndMessages',
      workspaceId: 'ws',
      taskId: task.id,
      turnId: queuedTurn.id,
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'upsertMessage',
      workspaceId: 'ws',
      message: {
        id: `message-${queuedTurn.id}`,
        taskId: task.id,
        turnId: queuedTurn.id,
        role: 'system',
        state: 'assigned',
        order: 0,
        content: 'must not overwrite activation message',
        createdAt: queuedTurn.createdAt,
      },
      updatedAt: '2026-07-22T02:00:02.500Z',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'appendMessage',
      workspaceId: 'ws',
      message: {
        id: 'legacy-child-return-direct-message',
        taskId: task.id,
        turnId: queuedTurn.id,
        role: 'assistant',
        state: 'complete',
        order: 1,
        content: 'must not append',
        createdAt: '2026-07-22T02:00:02.500Z',
      },
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'appendTranscriptBatch',
      workspaceId: 'ws',
      taskId: task.id,
      messages: [{
        id: 'legacy-child-return-transcript-message',
        taskId: task.id,
        turnId: queuedTurn.id,
        role: 'assistant',
        state: 'complete',
        order: 2,
        content: 'must not persist',
        createdAt: '2026-07-22T02:00:02.500Z',
      }],
      toolCalls: [{
        id: 'legacy-child-return-tool',
        taskId: task.id,
        turnId: queuedTurn.id,
        toolCallId: 'legacy-tool',
        order: 3,
        name: 'legacy_tool',
        status: 'success',
        createdAt: '2026-07-22T02:00:02.500Z',
        updatedAt: '2026-07-22T02:00:02.500Z',
      }],
      reasoning: [{
        id: 'legacy-child-return-reasoning',
        taskId: task.id,
        turnId: queuedTurn.id,
        order: 4,
        content: 'must not persist',
        createdAt: '2026-07-22T02:00:02.500Z',
        updatedAt: '2026-07-22T02:00:02.500Z',
      }],
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'putCancelRequest',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      request: {
        kind: 'interrupt',
        by: 'replacement-worker',
        opId: 'replacement-cancel',
        at: '2026-07-22T02:00:02.500Z',
      },
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'deleteCancelRequest',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'heartbeatRuntime',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      ownerId: 'legacy-runtime-owner',
      heartbeatAt: '2026-07-22T02:00:02.500Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'releaseRuntime',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      ownerId: 'legacy-runtime-owner',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'deleteMessage',
      workspaceId: 'ws',
      messageId: `message-${queuedTurn.id}`,
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'deleteTurn',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
    })).resolves.toMatchObject({ changed: false });

    const forgedTurn = {
      ...queuedTurn,
      workflowActivation: {
        runId,
        activationId,
        nodeId: 'node',
        kind: 'child_return',
        runStatus: 'running',
        activationStatus: 'queued',
        isTerminalNode: true,
        hasDirectDependencies: false,
        hasOpenFeedbackRound: false,
        hasPendingContinuation: false,
        hasInheritedFeedbackResponse: false,
      },
    } as unknown as TaskTurn;
    const forgedProjection: EngineProjection = {
      schemaVersion: 1,
      revision: 1,
      tasks: { [task.id]: task },
      turns: { [queuedTurn.id]: forgedTurn },
      messages: {},
      toolCalls: {},
      reasoning: {},
      operations: {},
      cancelRequests: {},
    };
    expect(canPromoteTurn(forgedProjection, queuedTurn.id, DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'workflow activation kind is retired',
    });
    await expect(repository.execute({
      kind: 'claimRuntime',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      ownerId: 'legacy-child-return-owner',
      claimedAt: '2026-07-22T02:00:02.000Z',
      heartbeatAt: '2026-07-22T02:00:02.000Z',
      expiresAt: '2026-07-22T02:01:02.000Z',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'promoteTurn',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      startedAt: '2026-07-22T02:00:02.000Z',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'claimTurn',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      startedAt: '2026-07-22T02:00:02.000Z',
      rootTaskId: task.id,
      maxConcurrentTurns: 10,
      maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: false });

    await client.transaction([
      {
        sql: `UPDATE turns SET status = 'running', started_at = ?
               WHERE workspace_id = 'ws' AND id = ?`,
        params: ['2026-07-22T02:00:02.000Z', queuedTurn.id],
      },
      {
        sql: `UPDATE workflow_activations SET status = 'running', updated_at = ?
               WHERE workspace_id = 'ws' AND activation_id = ?`,
        params: ['2026-07-22T02:00:02.000Z', activationId],
      },
    ]);
    const runningTurn = {
      ...queuedTurn,
      status: 'running' as const,
      startedAt: '2026-07-22T02:00:02.000Z',
    };
    await expect(repository.execute({
      kind: 'reconcileOrphanTurn',
      workspaceId: 'ws',
      taskId: task.id,
      expectedTaskRevision: task.revision,
      expectedTurnStatus: 'running',
      task: {
        ...task,
        revision: task.revision + 1,
        updatedAt: '2026-07-22T02:00:02.750Z',
      },
      turn: {
        ...runningTurn,
        status: 'interrupted',
        finishedAt: '2026-07-22T02:00:02.750Z',
        inputs: [],
      },
      heldTurns: [],
    })).resolves.toMatchObject({ changed: false });
    await expect(client.get(
      `SELECT status FROM turns WHERE workspace_id = 'ws' AND id = ?`,
      [queuedTurn.id],
    )).resolves.toEqual({ status: 'running' });
    await expect(client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM turn_inputs WHERE workspace_id = 'ws' AND turn_id = ?`,
      [queuedTurn.id],
    )).resolves.toEqual({ count: 1 });
    await expect(stage(repository, runningTurn, 'legacy-child-return-stage', {
      kind: 'workflow_next',
      change: 'updated',
      result: 'must not route',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'settleTurn',
      workspaceId: 'ws',
      turnId: queuedTurn.id,
      status: 'failed',
      finishedAt: '2026-07-22T02:00:03.000Z',
      error: 'must remain inert',
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: task.revision,
      task: { ...task, updatedAt: '2026-07-22T02:00:03.000Z' },
      turn: {
        ...runningTurn,
        status: 'succeeded',
        finishedAt: '2026-07-22T02:00:03.000Z',
      },
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({ changed: false });

    await client.transaction([
      {
        sql: `UPDATE turns SET status = 'failed', settled_at = ?
               WHERE workspace_id = 'ws' AND id = ?`,
        params: ['2026-07-22T02:00:04.000Z', queuedTurn.id],
      },
      {
        sql: `UPDATE workflow_activations SET status = 'failed', updated_at = ?
               WHERE workspace_id = 'ws' AND activation_id = ?`,
        params: ['2026-07-22T02:00:04.000Z', activationId],
      },
    ]);
    await expect(repository.execute({
      kind: 'recoverWorkflowActivation',
      workspaceId: 'ws',
      runId,
      activationId,
      failedTurnId: queuedTurn.id,
      recoveryOperationId: 'legacy-child-return-recovery',
      fingerprint: 'legacy-child-return-recovery-v1',
      instruction: 'Must not recover retired child-return state.',
      expectedActivationStatus: 'failed',
      createdAt: '2026-07-22T02:00:05.000Z',
    })).resolves.toMatchObject({ changed: false });

    await expect(client.get(
      `SELECT activation.kind, activation.status AS activation_status,
              turn.status AS turn_status, message.content
         FROM workflow_activations activation
         JOIN turns turn ON turn.workspace_id = activation.workspace_id
                        AND turn.id = activation.execution_turn_id
         JOIN messages message ON message.workspace_id = activation.workspace_id
                              AND message.id = activation.message_id
        WHERE activation.workspace_id = 'ws' AND activation.activation_id = ?`,
      [activationId],
    )).resolves.toEqual({
      kind: 'child_return',
      activation_status: 'failed',
      turn_status: 'failed',
      content: '[activation]',
    });
    await expect(client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM runtime_claims WHERE workspace_id = 'ws' AND turn_id = ?`,
      [queuedTurn.id],
    )).resolves.toEqual({ count: 1 });
    await expect(client.get(
      `SELECT heartbeat_at, expires_at FROM runtime_claims
        WHERE workspace_id = 'ws' AND turn_id = ?`,
      [queuedTurn.id],
    )).resolves.toEqual({
      heartbeat_at: '2026-07-22T02:00:01.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    await expect(client.get(
      `SELECT op_id, kind, requested_by FROM turn_cancel_requests
        WHERE workspace_id = 'ws' AND turn_id = ?`,
      [queuedTurn.id],
    )).resolves.toEqual({ op_id: 'legacy-cancel', kind: 'cancel', requested_by: 'legacy-worker' });
    await expect(client.get(
      `SELECT json_extract(payload_json, '$.holdAutoPromote') AS held
         FROM turns WHERE workspace_id = 'ws' AND id = ?`,
      [queuedTurn.id],
    )).resolves.toEqual({ held: 1 });
    await expect(client.get(
      `SELECT content FROM messages WHERE workspace_id = 'ws' AND id = ?`,
      [pendingMessageId],
    )).resolves.toEqual({ content: 'original pending message' });
    await expect(client.get<{ count: number }>(
      `SELECT (
         (SELECT COUNT(*) FROM messages WHERE workspace_id = 'ws' AND id IN (
           'legacy-child-return-direct-message', 'legacy-child-return-transcript-message'
         )) +
         (SELECT COUNT(*) FROM tool_calls WHERE workspace_id = 'ws' AND id = 'legacy-child-return-tool') +
         (SELECT COUNT(*) FROM reasoning_segments WHERE workspace_id = 'ws' AND id = 'legacy-child-return-reasoning')
       ) AS count`,
    )).resolves.toEqual({ count: 0 });
    await expect(client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM operations WHERE workspace_id = 'ws'
        AND ledger_key LIKE '%legacy-child-return-recovery%'`,
    )).resolves.toEqual({ count: 0 });
  });

  it('keeps retained child-return rows byte-preserved while closing active top-level work', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-legacy-child-return-closure-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const task = makeTask('legacy-child-return-closure-task');
    const retainedTurn = {
      ...makeTurn('legacy-child-return-closure-retained', 1, task.id),
      status: 'queued' as const,
      startedAt: undefined,
      inputs: [{ kind: 'message' as const, messageId: 'retained-input-message' }],
    };
    const activeTurn = {
      ...makeTurn('legacy-child-return-closure-active', 2, task.id),
      status: 'queued' as const,
      startedAt: undefined,
      createdAt: '2026-07-22T02:00:03.000Z',
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: retainedTurn });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: activeTurn });
    await bindWorkflowActivation(repository, client, retainedTurn, undefined, {
      origin: 'top_level',
      activationStatus: 'failed',
      activationKind: 'child_return',
    });
    const retainedRepairId = `activation-${retainedTurn.id}`;
    await client.run(
      `INSERT INTO workflow_decision_repairs (
         workspace_id, run_id, activation_id, status, attempts_used,
         last_attempt_turn_id, last_error_code, last_response_message_id,
         next_repair_turn_id, created_at, updated_at
       ) VALUES ('ws', ?, ?, 'open', 1, ?, 'decision_missing', NULL, ?, ?, ?)`,
      [
        `run-${retainedTurn.id}`,
        retainedRepairId,
        retainedTurn.id,
        retainedTurn.id,
        '2026-07-22T02:00:02.500Z',
        '2026-07-22T02:00:02.500Z',
      ],
    );
    const retainedTurnBefore = await client.get(
      `SELECT status, settled_at, payload_json FROM turns WHERE workspace_id = 'ws' AND id = ?`,
      [retainedTurn.id],
    );
    const retainedInputsBefore = await client.all(
      `SELECT * FROM turn_inputs WHERE workspace_id = 'ws' AND turn_id = ? ORDER BY ordering`,
      [retainedTurn.id],
    );
    const retainedRepairBefore = await client.get(
      `SELECT status, attempts_used, last_attempt_turn_id, last_error_code,
              last_response_message_id, next_repair_turn_id, created_at, updated_at
         FROM workflow_decision_repairs
        WHERE workspace_id = 'ws' AND run_id = ? AND activation_id = ?`,
      [`run-${retainedTurn.id}`, retainedRepairId],
    );

    await expect(repository.execute({
      kind: 'applyTaskLifecycle',
      workspaceId: 'ws',
      taskId: task.id,
      expectedTaskRevision: task.revision,
      task: {
        ...task,
        lifecycle: 'cancelled',
        revision: task.revision + 1,
        updatedAt: '2026-07-22T02:00:04.000Z',
        finishedAt: '2026-07-22T02:00:04.000Z',
      },
      turns: [{
        ...activeTurn,
        status: 'cancelled',
        finishedAt: '2026-07-22T02:00:04.000Z',
      }],
      expectedTurns: [{ id: activeTurn.id, status: 'queued', runtimeEpoch: 1 }],
    })).resolves.toMatchObject({ changed: true });

    await expect(client.get(
      `SELECT status, settled_at, payload_json FROM turns WHERE workspace_id = 'ws' AND id = ?`,
      [retainedTurn.id],
    )).resolves.toEqual(retainedTurnBefore);
    await expect(client.all(
      `SELECT * FROM turn_inputs WHERE workspace_id = 'ws' AND turn_id = ? ORDER BY ordering`,
      [retainedTurn.id],
    )).resolves.toEqual(retainedInputsBefore);
    await expect(client.get(
      `SELECT status, attempts_used, last_attempt_turn_id, last_error_code,
              last_response_message_id, next_repair_turn_id, created_at, updated_at
         FROM workflow_decision_repairs
        WHERE workspace_id = 'ws' AND run_id = ? AND activation_id = ?`,
      [`run-${retainedTurn.id}`, retainedRepairId],
    )).resolves.toEqual(retainedRepairBefore);
    await expect(client.get(
      `SELECT status FROM workflow_activations
        WHERE workspace_id = 'ws' AND execution_turn_id = ?`,
      [retainedTurn.id],
    )).resolves.toEqual({ status: 'failed' });
    await expect(client.get(
      `SELECT status FROM turns WHERE workspace_id = 'ws' AND id = ?`,
      [activeTurn.id],
    )).resolves.toEqual({ status: 'cancelled' });
  });

  it('ignores a newer terminal child-return when projecting visible terminal activity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-legacy-child-return-activity-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const task = makeTask('legacy-child-return-activity-task');
    const visibleTerminal = {
      ...makeTurn('visible-terminal-turn', 1, task.id),
      status: 'succeeded' as const,
      finishedAt: '2026-07-22T02:00:03.000Z',
    };
    const retiredTerminal = {
      ...makeTurn('retired-terminal-turn', 2, task.id),
      status: 'succeeded' as const,
      createdAt: '2026-07-22T02:00:04.000Z',
      startedAt: '2026-07-22T02:00:04.000Z',
      finishedAt: '2026-07-22T02:00:05.000Z',
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: visibleTerminal });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: retiredTerminal });
    await bindWorkflowActivation(repository, client, retiredTerminal, undefined, {
      origin: 'top_level',
      activationStatus: 'failed',
      activationKind: 'child_return',
    });

    await expect(repository.listTurnActivityForTasks([task.id])).resolves.toMatchObject([
      { id: visibleTerminal.id, status: 'succeeded' },
    ]);
  });

  it('does not let retained child-return turns or leases block ordinary scheduling', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-legacy-child-return-claims-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const task = {
      ...makeTask('legacy-child-return-claim-task'),
      executionPolicy: { maxTurns: 1, maxAutomaticRetries: 1 },
    };
    const retiredTurn = {
      ...makeTurn('legacy-child-return-blocker', 1, task.id),
      status: 'queued' as const,
      startedAt: undefined,
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: retiredTurn });
    await bindWorkflowActivation(repository, client, retiredTurn, undefined, {
      origin: 'top_level',
      activationStatus: 'queued',
      activationKind: 'child_return',
    });
    await client.transaction([
      {
        sql: `INSERT INTO session_claims (workspace_id, session_id, turn_id, claimed_at)
              VALUES ('ws', 'shared-session', ?, ?)`,
        params: [retiredTurn.id, '2026-07-22T02:00:01.000Z'],
      },
      {
        sql: `INSERT INTO resource_claims (workspace_id, resource_key, task_id, turn_id, claimed_at)
              VALUES ('ws', 'git', ?, ?, ?)`,
        params: [task.id, retiredTurn.id, '2026-07-22T02:00:01.000Z'],
      },
    ]);
    const candidate = {
      ...makeTurn('ordinary-after-child-return', 2, task.id),
      status: 'queued' as const,
      startedAt: undefined,
      createdAt: '2026-07-22T02:00:03.000Z',
    };
    await expect(repository.execute({
      kind: 'queueTaskTurn',
      workspaceId: 'ws',
      expectedTaskRevision: task.revision,
      maxTurnsPerTask: 1,
      task,
      turn: candidate,
    })).resolves.toMatchObject({ changed: true });
    await expect(repository.countTurnsForTaskEpoch(task.id, 1)).resolves.toBe(1);

    await client.transaction([
      {
        sql: `UPDATE turns SET status = 'running', started_at = ?
               WHERE workspace_id = 'ws' AND id = ?`,
        params: ['2026-07-22T02:00:02.000Z', retiredTurn.id],
      },
      {
        sql: `UPDATE workflow_activations SET status = 'running', updated_at = ?
               WHERE workspace_id = 'ws' AND execution_turn_id = ?`,
        params: ['2026-07-22T02:00:02.000Z', retiredTurn.id],
      },
    ]);
    await expect(repository.execute({
      kind: 'claimTurn',
      workspaceId: 'ws',
      turnId: candidate.id,
      startedAt: '2026-07-22T02:00:04.000Z',
      rootTaskId: task.id,
      maxConcurrentTurns: 1,
      maxConcurrentPerRoot: 1,
      maxConcurrentPerBackend: 1,
      sessionId: 'shared-session',
      resourceKeys: ['git'],
    })).resolves.toMatchObject({ changed: true });
    await expect(client.get(
      `SELECT status FROM turns WHERE workspace_id = 'ws' AND id = ?`,
      [candidate.id],
    )).resolves.toEqual({ status: 'running' });
    await expect(client.get(
      `SELECT turn_id FROM session_claims WHERE workspace_id = 'ws' AND session_id = 'shared-session'`,
    )).resolves.toEqual({ turn_id: candidate.id });
    await expect(client.get(
      `SELECT turn_id FROM resource_claims WHERE workspace_id = 'ws' AND resource_key = 'git'`,
    )).resolves.toEqual({ turn_id: candidate.id });
    await expect(client.get(
      `SELECT activation.kind, activation.status AS activation_status, turn.status AS turn_status
         FROM workflow_activations activation
         JOIN turns turn ON turn.workspace_id = activation.workspace_id
                        AND turn.id = activation.execution_turn_id
        WHERE activation.workspace_id = 'ws' AND activation.execution_turn_id = ?`,
      [retiredTurn.id],
    )).resolves.toEqual({
      kind: 'child_return',
      activation_status: 'running',
      turn_status: 'running',
    });
  });

  it('hides delegated descendants and every retained activation retry attempt from active surfaces', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-retired-lineage-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');

    const retiredOwner = makeTask('retired-child-run-owner');
    const lifecycleDescendant = {
      ...makeTask('retired-child-run-lifecycle-descendant'),
      parentId: retiredOwner.id,
    };
    const graphDescendant = {
      ...makeTask('retired-child-run-graph-descendant'),
      parentId: lifecycleDescendant.id,
    };
    const ownerTurn = {
      ...makeTurn('retired-child-run-owner-turn', 1, retiredOwner.id),
      status: 'failed' as const,
      finishedAt: '2026-07-22T02:00:03.000Z',
    };
    const lifecycleTurn = {
      ...makeTurn('retired-child-run-lifecycle-turn', 1, lifecycleDescendant.id),
      status: 'queued' as const,
      startedAt: undefined,
    };
    const graphTurn = {
      ...makeTurn('retired-child-run-graph-turn', 1, graphDescendant.id),
      status: 'queued' as const,
      startedAt: undefined,
    };
    for (const task of [retiredOwner, lifecycleDescendant, graphDescendant]) {
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    }
    for (const turn of [ownerTurn, lifecycleTurn, graphTurn]) {
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    }
    await bindWorkflowActivation(repository, client, ownerTurn, undefined, {
      origin: 'child',
      activationStatus: 'failed',
    });

    await expect(repository.getTask(retiredOwner.id)).resolves.toBeUndefined();
    await expect(repository.getTask(lifecycleDescendant.id)).resolves.toBeUndefined();
    await expect(repository.getTask(graphDescendant.id)).resolves.toBeUndefined();
    await expect(repository.getTurn(lifecycleTurn.id)).resolves.toBeUndefined();
    await expect(repository.listQueuedTurns(graphDescendant.id)).resolves.toEqual([]);
    await expect(repository.listSubtree(retiredOwner.id)).resolves.toEqual([]);

    await expect(repository.execute({
      kind: 'applyTaskLifecycle',
      workspaceId: 'ws',
      taskId: lifecycleDescendant.id,
      expectedTaskRevision: lifecycleDescendant.revision,
      task: {
        ...lifecycleDescendant,
        lifecycle: 'cancelled',
        revision: lifecycleDescendant.revision + 1,
        updatedAt: '2026-07-22T02:00:04.000Z',
        finishedAt: '2026-07-22T02:00:04.000Z',
      },
      turns: [],
    })).resolves.toMatchObject({ changed: false });
    await expect(repository.execute({
      kind: 'completeGraphTask',
      workspaceId: 'ws',
      expectedTasks: [{ id: graphDescendant.id, revision: graphDescendant.revision }],
      tasks: [{
        ...graphDescendant,
        goal: 'must not mutate a retired descendant',
        revision: graphDescendant.revision + 1,
        updatedAt: '2026-07-22T02:00:04.000Z',
      }],
      turns: [],
    })).resolves.toMatchObject({ changed: false });
    await expect(client.get(
      `SELECT lifecycle, goal, revision FROM tasks WHERE workspace_id = 'ws' AND id = ?`,
      [lifecycleDescendant.id],
    )).resolves.toEqual({
      lifecycle: lifecycleDescendant.lifecycle,
      goal: lifecycleDescendant.goal,
      revision: lifecycleDescendant.revision,
    });
    await expect(client.get(
      `SELECT lifecycle, goal, revision FROM tasks WHERE workspace_id = 'ws' AND id = ?`,
      [graphDescendant.id],
    )).resolves.toEqual({
      lifecycle: graphDescendant.lifecycle,
      goal: graphDescendant.goal,
      revision: graphDescendant.revision,
    });

    const lineageTask = makeTask('retired-child-return-lineage-task');
    const primaryTurn = {
      ...makeTurn('retired-lineage-primary', 1, lineageTask.id),
      status: 'failed' as const,
      finishedAt: '2026-07-22T02:00:03.000Z',
    };
    const earlierRetry = {
      ...makeTurn('retired-lineage-retry-one', 2, lineageTask.id),
      status: 'failed' as const,
      retryOf: primaryTurn.id,
      createdAt: '2026-07-22T02:00:04.000Z',
      startedAt: '2026-07-22T02:00:04.000Z',
      finishedAt: '2026-07-22T02:00:05.000Z',
    };
    const currentRetry = {
      ...makeTurn('retired-lineage-retry-two', 3, lineageTask.id),
      status: 'queued' as const,
      retryOf: earlierRetry.id,
      createdAt: '2026-07-22T02:00:06.000Z',
      startedAt: undefined,
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: lineageTask });
    for (const turn of [primaryTurn, earlierRetry, currentRetry]) {
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    }
    await bindWorkflowActivation(repository, client, primaryTurn, undefined, {
      origin: 'top_level',
      activationStatus: 'failed',
      activationKind: 'child_return',
    });
    await client.transaction([
      {
        sql: `UPDATE workflow_activations
                 SET execution_turn_id = ?, status = 'queued', updated_at = ?
               WHERE workspace_id = 'ws' AND activation_id = ?`,
        params: [currentRetry.id, currentRetry.createdAt, `activation-${primaryTurn.id}`],
      },
      {
        sql: `INSERT INTO messages (
                id, workspace_id, task_id, turn_id, role, state, ordering,
                content, created_at, payload_json
              ) VALUES ('retired-lineage-retry-message', 'ws', ?, ?, 'assistant',
                        'complete', 0, 'must stay hidden', ?, '{"payloadVersion":1}')`,
        params: [lineageTask.id, earlierRetry.id, earlierRetry.createdAt],
      },
    ]);

    for (const turn of [primaryTurn, earlierRetry, currentRetry]) {
      await expect(repository.getTurn(turn.id)).resolves.toBeUndefined();
    }
    await expect(repository.listTurns(lineageTask.id)).resolves.toEqual([]);
    await expect(repository.listTurnActivityForTasks([lineageTask.id])).resolves.toEqual([]);
    await expect(repository.listMessages(lineageTask.id)).resolves.toEqual([]);
    await expect(repository.countTurnsForTaskEpoch(lineageTask.id, 1)).resolves.toBe(0);
    await expect(repository.countRetryDepth(currentRetry.id)).resolves.toBe(0);
    await expect(repository.getMaxTurnSequence(lineageTask.id)).resolves.toBe(0);
  });

  it('does not confuse colon-delimited active turn prefixes with retired operation owners', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-operation-prefix-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const task = makeTask('operation-prefix-task');
    const visibleTurn = {
      ...makeTurn('operation-prefix', 1, task.id),
      status: 'succeeded' as const,
      finishedAt: '2026-07-22T02:00:03.000Z',
    };
    const retiredTurn = {
      ...makeTurn('operation-prefix:retired', 2, task.id),
      status: 'failed' as const,
      finishedAt: '2026-07-22T02:00:04.000Z',
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: visibleTurn });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: retiredTurn });
    await bindWorkflowActivation(repository, client, retiredTurn, undefined, {
      origin: 'top_level',
      activationStatus: 'failed',
      activationKind: 'child_return',
    });
    const retiredKey = `${retiredTurn.id}:operation`;
    await client.run(
      `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
       VALUES ('ws', ?, 'retired-prefix-fingerprint', ?, ?)`,
      [
        retiredKey,
        JSON.stringify({ payloadVersion: 1, result: { ok: true, data: { retained: true } } }),
        '2026-07-22T02:00:05.000Z',
      ],
    );

    await expect(repository.listOperationsForTurns([visibleTurn.id])).resolves.toEqual([]);
    await expect(repository.execute({
      kind: 'deleteOperationsForTurn',
      workspaceId: 'ws',
      turnId: visibleTurn.id,
    })).resolves.toMatchObject({ changed: false });
    await expect(client.get(
      `SELECT fingerprint FROM operations WHERE workspace_id = 'ws' AND ledger_key = ?`,
      [retiredKey],
    )).resolves.toEqual({ fingerprint: 'retired-prefix-fingerprint' });
  });

  it('purges obsolete child-return state before every task deletion path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-retired-delete-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');

    const seedProtectedTask = async (label: string, parentId: string | null = null) => {
      const task = { ...makeTask(`${label}-task`), parentId };
      const turn = {
        ...makeTurn(`${label}-turn`, 1, task.id),
        status: 'failed' as const,
        finishedAt: '2026-07-22T02:00:03.000Z',
      };
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
      await bindWorkflowActivation(repository, client, turn, undefined, {
        origin: 'top_level',
        activationStatus: 'failed',
        activationKind: 'child_return',
      });
      await client.transaction([
        {
          sql: `INSERT INTO workflow_continuations (
                  workspace_id, run_id, continuation_id,
                  caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
                  child_run_id, return_gate_id, kind, status,
                  payload_json, created_at, updated_at
                ) VALUES ('ws', ?, ?, ?, ?, ?, 'node', ?, ?, 'child_wait', 'pending', '{}', ?, ?)`,
          params: [
            `run-${turn.id}`,
            `continuation-${turn.id}`,
            task.id,
            turn.id,
            `run-${turn.id}`,
            `run-${turn.id}`,
            `return-gate-${turn.id}`,
            turn.createdAt,
            turn.createdAt,
          ],
        },
        {
          sql: `INSERT INTO workflow_return_gates (
                  workspace_id, return_gate_id, continuation_run_id, continuation_id,
                  caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
                  child_run_id, status, return_activation_run_id, return_activation_id,
                  return_message_id, execution_turn_id, created_at, updated_at
                ) VALUES ('ws', ?, ?, ?, ?, ?, ?, 'node', ?, 'consumed', ?, ?, ?, ?, ?, ?)`,
          params: [
            `return-gate-${turn.id}`,
            `run-${turn.id}`,
            `continuation-${turn.id}`,
            task.id,
            turn.id,
            `run-${turn.id}`,
            `run-${turn.id}`,
            `run-${turn.id}`,
            `activation-${turn.id}`,
            `message-${turn.id}`,
            turn.id,
            turn.createdAt,
            turn.createdAt,
          ],
        },
        {
          sql: `INSERT INTO workflow_dependency_gates (
                  workspace_id, run_id, gate_id, consumer_node_id, status,
                  activation_id, reserved_turn_id, aggregate_message_id
                ) VALUES ('ws', ?, ?, 'node', 'failed', NULL, NULL, NULL)`,
          params: [`run-${turn.id}`, `dependency-gate-${turn.id}`],
        },
        {
          sql: `UPDATE tasks SET lifecycle = 'succeeded', updated_at = ?
                 WHERE workspace_id = 'ws' AND id = ?`,
          params: ['2026-07-22T02:00:04.000Z', task.id],
        },
        {
          sql: `UPDATE workflow_nodes SET status = 'failed'
                 WHERE workspace_id = 'ws' AND run_id = ?`,
          params: [`run-${turn.id}`],
        },
        {
          sql: `UPDATE workflow_runs
                   SET status = 'failed', terminal_reason_code = 'agent_fail', updated_at = ?
                 WHERE workspace_id = 'ws' AND run_id = ?`,
          params: ['2026-07-22T02:00:04.000Z', `run-${turn.id}`],
        },
      ]);
      return { task, turn };
    };

    const direct = await seedProtectedTask('retired-delete-direct');
    const ancestorRoot = {
      ...makeTask('retired-delete-ancestor-root'),
      lifecycle: 'succeeded' as const,
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: ancestorRoot });
    const ancestorChild = await seedProtectedTask('retired-delete-ancestor-child', ancestorRoot.id);
    const graph = await seedProtectedTask('retired-delete-graph');
    const remediation = await seedProtectedTask('retired-delete-remediation');
    const history = await seedProtectedTask('retired-delete-history');
    const preservedRoot = makeTask('retired-delete-preserved-root');
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: preservedRoot });

    const results = [
      await repository.execute({
        kind: 'deleteTask', workspaceId: 'ws', taskId: direct.task.id,
      }),
      await repository.execute({
        kind: 'deleteTaskSubtree', workspaceId: 'ws', rootTaskId: ancestorRoot.id,
      }),
      await repository.execute({
        kind: 'completeGraphTask',
        workspaceId: 'ws',
        expectedTasks: [],
        tasks: [],
        turns: [],
        deleteTaskIds: [graph.task.id],
      }),
      await repository.execute({
        kind: 'applyVerdictRemediation',
        workspaceId: 'ws',
        expectedTaskRevisions: [{ id: remediation.task.id, revision: remediation.task.revision }],
        tasks: [],
        turns: [],
        messages: [],
        deletedTaskIds: [remediation.task.id],
      }),
      await repository.execute({
        kind: 'clearHistory',
        workspaceId: 'ws',
        preserveRootTaskId: preservedRoot.id,
      }),
    ];
    expect(results).toEqual(results.map(() => expect.objectContaining({ ok: true, changed: true })));

    const deletedTaskIds = [
      direct.task.id,
      ancestorRoot.id,
      ancestorChild.task.id,
      graph.task.id,
      remediation.task.id,
      history.task.id,
    ];
    await expect(client.all<{ id: string }>(
      `SELECT id FROM tasks WHERE workspace_id = 'ws'
        AND id IN (${deletedTaskIds.map(() => '?').join(',')}) ORDER BY id`,
      deletedTaskIds,
    )).resolves.toEqual([]);
    await expect(client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workflow_activations WHERE workspace_id = 'ws'
        AND activation_id IN (${deletedTaskIds.map(() => '?').join(',')})`,
      deletedTaskIds.map((id) => `activation-${id.replace(/-task$/, '-turn')}`),
    )).resolves.toEqual({ count: 0 });
    await expect(client.get<{ id: string }>(
      `SELECT id FROM tasks WHERE workspace_id = 'ws' AND id = ?`, [preservedRoot.id],
    )).resolves.toEqual({ id: preservedRoot.id });
    await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
  });

  it('cross-family disposition races have exactly one winner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = makeClient();
    const secondClient = makeClient();
    await firstClient.open(dbPath);
    await secondClient.open(dbPath);
    await firstClient.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const first = new SqliteTaskRepository(firstClient, 'ws');
    const second = new SqliteTaskRepository(secondClient, 'ws');
    await first.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask() });
    const turn = makeTurn('turn-race', 1);
    await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    await bindWorkflowActivation(first, firstClient, turn);

    const results = await Promise.all([
      stage(first, turn, 'op-complete', { kind: 'complete', result: 'done' }),
      stage(second, turn, 'op-next', { kind: 'workflow_next', change: 'updated', result: 'next' }),
    ]);
    expect(results.filter((result) => result.changed === true)).toHaveLength(1);
    expect(results.filter((result) => result.conflict === true)).toHaveLength(1);

    const claims = await firstClient.all<{
      op_id: string;
      family: string;
      kind: string;
      status: string;
    }>(
      `SELECT op_id, family, kind, status
         FROM turn_disposition_claims
        WHERE workspace_id = 'ws' AND turn_id = 'turn-race'`,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).toBe('staged');
    expect([
      { op_id: 'op-complete', family: 'ordinary', kind: 'complete', status: 'staged' },
      { op_id: 'op-next', family: 'workflow', kind: 'next', status: 'staged' },
    ]).toContainEqual(claims[0]);

    await first.execute({
      kind: 'settleTurn',
      workspaceId: 'ws',
      turnId: turn.id,
      status: 'failed',
      finishedAt: '2026-07-22T02:00:03.000Z',
      error: 'adapter failed',
    });
    await expect(
      firstClient.get<{ status: string }>(
        `SELECT status FROM turn_disposition_claims WHERE workspace_id = 'ws' AND turn_id = ?`,
        [turn.id],
      ),
    ).resolves.toMatchObject({ status: 'discarded' });
  });

  it('keeps one declared valid route authoritative across concurrent invalid and valid calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-outcome-race-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = makeClient();
    const secondClient = makeClient();
    await firstClient.open(dbPath);
    await secondClient.open(dbPath);
    await firstClient.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const first = new SqliteTaskRepository(firstClient, 'ws');
    const second = new SqliteTaskRepository(secondClient, 'ws');
    await first.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask() });
    const turn = makeTurn('turn-outcome-race', 1);
    await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    await bindWorkflowActivation(first, firstClient, turn, {
      kind: 'agent',
      requireExplicitDisposition: true,
      next: { when: 'The result is ready.' },
    });

    const [invalid, valid] = await Promise.all([
      stage(first, turn, 'op-invalid-fail', {
        kind: 'workflow_fail',
        reason: 'undeclared route',
      }),
      stage(second, turn, 'op-valid-next', {
        kind: 'workflow_next',
        change: 'updated',
        result: 'declared result',
      }),
    ]);
    expect(invalid).toMatchObject({ changed: false });
    expect(valid).toMatchObject({ changed: true });
    await expect(firstClient.all(
      `SELECT family, kind, status FROM turn_disposition_claims
        WHERE workspace_id = ? AND turn_id = ?`,
      ['ws', turn.id],
    )).resolves.toEqual([{ family: 'workflow', kind: 'next', status: 'staged' }]);
    const repairRows = await firstClient.all<{
      status: string;
      attempts_used: number;
      last_error_code: string | null;
    }>(
      `SELECT status, attempts_used, last_error_code
         FROM workflow_decision_repairs
        WHERE workspace_id = ? AND run_id = ?`,
      ['ws', `run-${turn.id}`],
    );
    expect(repairRows.length).toBeLessThanOrEqual(1);
    if (repairRows[0]) {
      expect(repairRows[0]).toEqual({
        status: 'open',
        attempts_used: 0,
        last_error_code: 'decision_invalid',
      });
    }

    await expect(stage(first, turn, 'op-invalid-after-valid', {
      kind: 'workflow_fail',
      reason: 'still undeclared',
    })).resolves.toMatchObject({ changed: false });
    await expect(firstClient.all(
      `SELECT family, kind, status FROM turn_disposition_claims
        WHERE workspace_id = ? AND turn_id = ?`,
      ['ws', turn.id],
    )).resolves.toEqual([{ family: 'workflow', kind: 'next', status: 'staged' }]);

    const validRaceTask = { ...makeTask(), id: 'task-two-valid-race' };
    await first.execute({ kind: 'createTask', workspaceId: 'ws', task: validRaceTask });
    const validRaceTurn = {
      ...makeTurn('turn-two-valid-race', 1),
      taskId: validRaceTask.id,
    };
    await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn: validRaceTurn });
    await bindWorkflowActivation(first, firstClient, validRaceTurn, {
      kind: 'agent',
      requireExplicitDisposition: true,
      next: { when: 'The result is ready.' },
    });
    const validRace = await Promise.all([
      stage(first, validRaceTurn, 'op-valid-a', {
        kind: 'workflow_next',
        change: 'updated',
        result: 'result a',
      }),
      stage(second, validRaceTurn, 'op-valid-b', {
        kind: 'workflow_next',
        change: 'updated',
        result: 'result b',
      }),
    ]);
    expect(validRace.filter((result) => result.changed === true)).toHaveLength(1);
    expect(validRace.filter((result) => result.conflict === true)).toHaveLength(1);
    await expect(firstClient.all(
      `SELECT family, kind, status FROM turn_disposition_claims
        WHERE workspace_id = ? AND turn_id = ?`,
      ['ws', validRaceTurn.id],
    )).resolves.toEqual([{ family: 'workflow', kind: 'next', status: 'staged' }]);
  });

  it('settles a valid claim committed while a stale settlement waits for the SQLite writer lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-settlement-claim-lock-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const claimClient = makeClient();
    const settlementClient = makeClient();
    await claimClient.open(dbPath);
    await settlementClient.open(dbPath);
    await claimClient.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const claimRepository = new SqliteTaskRepository(claimClient, 'ws');
    const settlementRepository = new SqliteTaskRepository(settlementClient, 'ws');
    const createdAt = '2026-07-22T02:00:00.000Z';
    await claimRepository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'definition-settlement-claim-lock',
      version: 1,
      name: 'Settlement claim lock',
      topology: {
        kind: 'workflow',
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'consumer' }],
        nodes: [{
          nodeId: 'producer',
          outcome: {
            kind: 'agent',
            requireExplicitDisposition: true,
            next: { when: 'The result is ready.' },
          },
        }, { nodeId: 'consumer' }],
        edges: [{ fromNodeId: 'producer', toNodeId: 'consumer', inputRef: 'source' }],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
      createdAt,
    });
    const started = await claimRepository.execute({
      kind: 'startWorkflowRun',
      workspaceId: 'ws',
      definitionId: 'definition-settlement-claim-lock',
      version: 1,
      startIdempotencyKey: 'settlement-claim-lock',
      createdAt,
      backend: 'grok',
    });
    const data = started.operation!.result.data as {
      runId: string;
      entryTaskId: string;
      activationTurnId: string;
    };
    await expect(claimRepository.execute({
      kind: 'claimTurn',
      workspaceId: 'ws',
      turnId: data.activationTurnId,
      startedAt: '2026-07-22T02:00:01.000Z',
      rootTaskId: data.entryTaskId,
      maxConcurrentTurns: 10,
      maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: true });
    const taskPayloadRow = await claimClient.get<{ payload_json: string }>(
      `SELECT payload_json FROM tasks WHERE workspace_id = ? AND id = ?`,
      ['ws', data.entryTaskId],
    );
    const taskPayload = JSON.parse(taskPayloadRow!.payload_json) as Record<string, unknown>;
    taskPayload.outcomeProposal = {
      kind: 'fail',
      error: 'stale proposal',
      proposedByTurnId: 'older-turn',
      proposedAt: '2026-07-22T01:59:00.000Z',
    };
    await claimClient.run(
      `UPDATE tasks SET payload_json = ? WHERE workspace_id = ? AND id = ?`,
      [JSON.stringify(taskPayload), 'ws', data.entryTaskId],
    );

    const staleTask = await settlementRepository.getTask(data.entryTaskId);
    const staleTurn = await settlementRepository.getTurn(data.activationTurnId);
    const payloadRow = await claimClient.get<{ payload_json: string }>(
      `SELECT payload_json FROM turns WHERE workspace_id = ? AND id = ?`,
      ['ws', data.activationTurnId],
    );
    expect(staleTask).toBeTruthy();
    expect(staleTurn?.disposition).toBeUndefined();
    expect(payloadRow).toBeTruthy();
    const disposition: TurnDisposition = {
      kind: 'workflow_next',
      change: 'updated',
      result: 'accepted while settlement waited',
    };
    const claim = durableDispositionClaim({
      turnId: data.activationTurnId,
      taskId: data.entryTaskId,
      runtimeEpoch: staleTurn!.runtimeEpoch,
      opId: 'op-lock-winner',
      disposition,
    });
    const durablePayload = JSON.parse(payloadRow!.payload_json) as Record<string, unknown>;
    durablePayload.disposition = disposition;

    await claimClient.run('BEGIN IMMEDIATE TRANSACTION');
    const settlement = settlementRepository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: staleTask!.revision,
      task: { ...staleTask!, updatedAt: '2026-07-22T02:00:04.000Z' },
      turn: {
        ...staleTurn!,
        status: 'succeeded',
        finishedAt: '2026-07-22T02:00:04.000Z',
      },
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    });
    await claimClient.run(
      `UPDATE turns SET payload_json = ? WHERE workspace_id = ? AND id = ?`,
      [JSON.stringify(durablePayload), 'ws', data.activationTurnId],
    );
    await claimClient.run(
      `INSERT INTO turn_disposition_claims (
         workspace_id, turn_id, task_id, runtime_epoch, op_id, family, kind,
         fingerprint, payload_json, status, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,'staged',?,?)`,
      [
        'ws', claim.turnId, claim.taskId, claim.runtimeEpoch, claim.opId,
        claim.family, claim.kind, claim.fingerprint, claim.payloadJson,
        '2026-07-22T02:00:03.000Z', '2026-07-22T02:00:03.000Z',
      ],
    );
    await claimClient.run('COMMIT');

    await expect(settlement).resolves.toMatchObject({ changed: true });
    await expect(claimClient.get(
      `SELECT status FROM turn_disposition_claims WHERE workspace_id = ? AND turn_id = ?`,
      ['ws', data.activationTurnId],
    )).resolves.toEqual({ status: 'consumed' });
    await expect(claimClient.get(
      `SELECT status, attempts_used, last_error_code, next_repair_turn_id
         FROM workflow_decision_repairs WHERE workspace_id = ? AND run_id = ?`,
      ['ws', data.runId],
    )).resolves.toEqual({
      status: 'decided',
      attempts_used: 1,
      last_error_code: null,
      next_repair_turn_id: null,
    });
    await expect(claimRepository.listTurns(data.entryTaskId)).resolves.toHaveLength(1);
    const routedTask = await claimRepository.getTask(data.entryTaskId);
    expect(routedTask).toMatchObject({
      revision: staleTask!.revision + 1,
      updatedAt: '2026-07-22T02:00:04.000Z',
    });
    expect(routedTask?.outcomeProposal).toBeUndefined();
    await expect(claimClient.get(
      `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
      ['ws', data.runId],
    )).resolves.toEqual({ status: 'running' });
    await expect(settlementRepository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: staleTask!.revision,
      task: { ...staleTask!, updatedAt: '2026-07-22T02:00:04.000Z' },
      turn: {
        ...staleTurn!,
        status: 'succeeded',
        finishedAt: '2026-07-22T02:00:04.000Z',
      },
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({ changed: false });
  });

  it('same canonical disposition replays across operation ids and successful settlement consumes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-replay-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = makeClient();
    const secondClient = makeClient();
    await firstClient.open(dbPath);
    await secondClient.open(dbPath);
    await firstClient.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const first = new SqliteTaskRepository(firstClient, 'ws');
    const second = new SqliteTaskRepository(secondClient, 'ws');
    await first.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask() });
    const turn = makeTurn('turn-replay', 1);
    await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    await bindWorkflowActivation(first, firstClient, turn);

    const disposition = { kind: 'complete' as const, result: 'same' };
    const results = await Promise.all([
      stage(first, turn, 'op-a', disposition),
      stage(second, turn, 'op-b', disposition),
    ]);
    expect(results.filter((result) => result.changed === true)).toHaveLength(1);
    expect(results.every((result) => result.conflict !== true)).toBe(true);

    await expect(
      stage(second, turn, 'op-a', { kind: 'fail', error: 'changed' }),
    ).resolves.toMatchObject({ changed: false, conflict: true });

    await first.execute({
      kind: 'settleTurn',
      workspaceId: 'ws',
      turnId: turn.id,
      status: 'succeeded',
      finishedAt: '2026-07-22T02:00:04.000Z',
    });
    await expect(
      firstClient.get<{ status: string }>(
        `SELECT status FROM turn_disposition_claims WHERE workspace_id = 'ws' AND turn_id = ?`,
        [turn.id],
      ),
    ).resolves.toMatchObject({ status: 'consumed' });
  });

  it('settlement rejects missing and mismatched durable disposition claims', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-settlement-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const task = makeTask();
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });

    const missingTurn = makeTurn('turn-settle-missing', 1);
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: missingTurn });
    const complete = { kind: 'complete' as const, result: 'done' };
    await expect(repository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: task.revision,
      task: { ...task, updatedAt: '2026-07-22T02:00:03.000Z' },
      turn: {
        ...missingTurn,
        status: 'succeeded',
        finishedAt: '2026-07-22T02:00:03.000Z',
        disposition: complete,
      },
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({
      changed: false,
      conflict: true,
      reason: 'settlement requires a durable staged disposition',
    });
    await expect(repository.getTurn(missingTurn.id)).resolves.toMatchObject({ status: 'running' });

    const mismatchTurn = makeTurn('turn-settle-mismatch', 2);
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: mismatchTurn });
    await expect(stage(repository, mismatchTurn, 'op-complete', complete)).resolves.toMatchObject({
      changed: true,
    });
    await expect(repository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: task.revision,
      task: { ...task, updatedAt: '2026-07-22T02:00:04.000Z' },
      turn: {
        ...mismatchTurn,
        status: 'succeeded',
        finishedAt: '2026-07-22T02:00:04.000Z',
        disposition: { kind: 'fail', error: 'changed' },
      },
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({
      changed: false,
      conflict: true,
      reason: 'settlement disposition does not match the durable claim',
    });
    await expect(repository.getTurn(mismatchTurn.id)).resolves.toMatchObject({ status: 'running' });
    await expect(client.get<{ status: string }>(
      `SELECT status FROM turn_disposition_claims WHERE workspace_id = 'ws' AND turn_id = ?`,
      [mismatchTurn.id],
    )).resolves.toEqual({ status: 'staged' });

    const hostVerdict = {
      status: 'pass' as const,
      source: 'host' as const,
      testedRevision: 'rev-fixed',
      at: '2026-07-22T02:00:05.000Z',
    };

    const changedPayloadTurn = makeTurn('turn-settle-host-verdict-changed-result', 3);
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: changedPayloadTurn });
    await expect(stage(repository, changedPayloadTurn, 'op-host-verdict-changed', complete)).resolves.toMatchObject({
      changed: true,
    });
    await expect(repository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: task.revision,
      task: { ...task, updatedAt: '2026-07-22T02:00:05.000Z' },
      turn: {
        ...changedPayloadTurn,
        status: 'succeeded',
        finishedAt: '2026-07-22T02:00:05.000Z',
        disposition: { kind: 'complete', result: 'changed', verdict: hostVerdict },
      },
      claimedDisposition: complete,
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({
      changed: false,
      conflict: true,
      reason: 'host verdict override changed the claimed completion payload',
    });

    const workerVerdictTurn = makeTurn('turn-settle-worker-verdict', 4);
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: workerVerdictTurn });
    await expect(stage(repository, workerVerdictTurn, 'op-worker-verdict', complete)).resolves.toMatchObject({
      changed: true,
    });
    await expect(repository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: task.revision,
      task: { ...task, updatedAt: '2026-07-22T02:00:05.000Z' },
      turn: {
        ...workerVerdictTurn,
        status: 'succeeded',
        finishedAt: '2026-07-22T02:00:05.000Z',
        disposition: {
          ...complete,
          verdict: {
            status: 'pass',
            source: 'worker',
            at: '2026-07-22T02:00:05.000Z',
          },
        },
      },
      claimedDisposition: complete,
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({
      changed: false,
      conflict: true,
      reason: 'host verdict override changed the claimed completion payload',
    });

    const hostTask = makeTask('task-host-verdict');
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: hostTask });
    const hostOverrideTurn = makeTurn('turn-settle-host-verdict', 1, hostTask.id);
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: hostOverrideTurn });
    await expect(stage(repository, hostOverrideTurn, 'op-host-verdict', complete)).resolves.toMatchObject({
      changed: true,
    });
    const hostDisposition = { ...complete, verdict: hostVerdict };
    const hostSettlement = applySuccessfulTurn(
      hostTask,
      { ...hostOverrideTurn, disposition: hostDisposition },
      { now: '2026-07-22T02:00:06.000Z' },
    );
    expect(hostSettlement.ok).toBe(true);
    if (!hostSettlement.ok) return;
    await expect(repository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: hostTask.revision,
      task: hostSettlement.next.task,
      turn: hostSettlement.next.turn,
      claimedDisposition: complete,
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({ changed: true });
    await expect(repository.getTurn(hostOverrideTurn.id)).resolves.toMatchObject({
      status: 'succeeded',
      disposition: { kind: 'complete', result: 'done', verdict: hostVerdict },
    });
  });

  it('rejects a workflow disposition on a non-workflow turn without a claim', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-context-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask() });
    const turn = makeTurn('turn-unbound', 1);
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });

    await expect(
      stage(repository, turn, 'op-next', {
        kind: 'workflow_next',
        change: 'updated',
        result: 'not authorized',
      }),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      client.get(
        `SELECT turn_id FROM turn_disposition_claims
          WHERE workspace_id = 'ws' AND turn_id = ?`,
        [turn.id],
      ),
    ).resolves.toBeUndefined();
  });

  it('revalidates broad workflow credentials against durable activation context', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-execution-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const task = makeTask();
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });

    const unbound = makeTurn('turn-broad-unbound', 1);
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: unbound });
    const broad = new Set(['workflow_next', 'workflow_prev', 'workflow_fail']);
    await expect(executeToolCommand(
      graphDeps(repository, task, unbound),
      { callerTaskId: task.id, turnId: unbound.id, rootId: task.id, allowedActions: broad },
      { kind: 'workflow_next', opId: 'unbound-next', change: 'updated', message: 'x' },
    )).resolves.toEqual({
      ok: false,
      error: 'workflow_next is not authorized for the current workflow context',
    });

    await repository.execute({
      kind: 'settleTurn',
      workspaceId: 'ws',
      turnId: unbound.id,
      status: 'cancelled',
      finishedAt: '2026-07-22T02:00:03.000Z',
    });

    const active = makeTurn('turn-broad-active', 2);
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: active });
    await bindWorkflowActivation(repository, client, active);
    await expect(executeToolCommand(
      graphDeps(repository, task, active),
      { callerTaskId: task.id, turnId: active.id, rootId: task.id, allowedActions: broad },
      { kind: 'workflow_next', opId: 'initial-unchanged', change: 'unchanged', message: 'x' },
    )).resolves.toEqual({
      ok: false,
      error: 'workflow_next unchanged requires a feedback-request activation',
    });
    await expect(executeToolCommand(
      graphDeps(repository, task, active),
      { callerTaskId: task.id, turnId: active.id, rootId: task.id, allowedActions: broad },
      { kind: 'workflow_next', opId: 'active-next', change: 'updated', message: 'x' },
    )).resolves.toEqual({ ok: true, result: { staged: true } });
  });

  it('workflow start applies ordinary host policy and persists effective clamps', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-host-policy-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const root: MusterTask = {
      ...makeTask(),
      id: 'root-host-policy',
      role: 'coordinator',
      capabilities: ['create_child'],
    };
    const turn: TaskTurn = {
      ...makeTurn('turn-host-policy', 1),
      taskId: root.id,
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    const invalidDefinition = await executeToolCommand(
      graphDeps(repository, root, turn),
      {
        callerTaskId: root.id,
        turnId: turn.id,
        rootId: root.id,
        allowedActions: new Set(['define_workflow']),
      },
      {
        kind: 'define_workflow',
        opId: 'define-host-policy-invalid',
        definitionId: 'wf-host-policy-invalid',
        version: 1,
        name: 'invalid host requirement',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
          nodes: [{ nodeId: 'entry', role: 'worker', backend: 'unsupported' }],
          edges: [],
        },
        entryContracts: [],
        policy: DEFAULT_WORKFLOW_POLICY,
      },
    );
    expect(invalidDefinition).toMatchObject({ ok: false });
    expect(invalidDefinition.ok ? '' : invalidDefinition.error).toContain('backend_unsupported');
    await expect(repository.getWorkflowDefinition('wf-host-policy-invalid', 1)).resolves.toBeUndefined();
    await repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-host-policy',
      version: 1,
      name: 'host policy',
      topology: {
        kind: 'workflow',
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
        nodes: [{ nodeId: 'entry', role: 'worker', backend: 'grok' }],
        edges: [],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
      ownerRootTaskId: root.id,
      createdAt: '2026-07-22T02:00:00.000Z',
    });

    const command = {
      kind: 'start_workflow' as const,
      opId: 'start-host-policy',
      definitionId: 'wf-host-policy',
      version: 1,
      startIdempotencyKey: 'host-policy-start',
      backend: 'grok',
      inputs: [],
    };
    const context = {
      callerTaskId: root.id,
      turnId: turn.id,
      rootId: root.id,
      allowedActions: new Set(['start_workflow']),
    };
    const hostSnapshot = {
      cwd: dir,
      trusted: true,
      availableBackends: ['grok'],
      models: {},
    };
    const mcpBackend = {
      name: 'grok',
      capabilities: {
        supportsReasoning: true,
        supportsDetailedToolEvents: true,
        supportsMCP: true,
      },
      async *run() {},
    };

    await repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-host-policy-script',
      version: 1,
      name: 'host policy script',
      topology: {
        kind: 'workflow',
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'script' }],
        nodes: [{
          nodeId: 'script',
          backend: 'script',
          execution: {
            kind: 'script',
            interpreter: 'node',
            file: 'scripts/check.js',
            args: [],
          },
          outcome: {
            kind: 'exit',
            next: { when: { exitCode: 0 } },
            fail: { when: { exitCode: 'nonzero' } },
          },
        }],
        edges: [],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
      ownerRootTaskId: root.id,
      createdAt: '2026-07-22T02:00:00.000Z',
    });
    const hostRunDisabled = await executeToolCommand(
      graphDeps(repository, root, turn, {
        getHostEnvironment: () => hostSnapshot,
        allowLocalExecution: () => false,
        makeBackend: () => ({
          name: 'script',
          capabilities: {
            supportsReasoning: false,
            supportsDetailedToolEvents: false,
            supportsMCP: false,
          },
          async *run() {},
        }),
      }),
      {
        callerTaskId: root.id,
        turnId: turn.id,
        rootId: root.id,
        allowedActions: new Set(['start_workflow']),
      },
      {
        kind: 'start_workflow',
        opId: 'start-host-policy-script-disabled',
        definitionId: 'wf-host-policy-script',
        version: 1,
        startIdempotencyKey: 'host-policy-script-disabled',
        inputs: [],
      },
    );
    expect(hostRunDisabled).toMatchObject({ ok: false });
    expect(hostRunDisabled.ok ? '' : hostRunDisabled.error).toContain('host_run_disabled');

    const untrusted = await executeToolCommand(
      graphDeps(repository, root, turn, { isWorkspaceTrusted: () => false }),
      context,
      command,
    );
    expect(untrusted).toMatchObject({ ok: false });
    expect(untrusted.ok ? '' : untrusted.error).toContain('workspace_untrusted');

    const unavailable = await executeToolCommand(
      graphDeps(repository, root, turn, {
        getHostEnvironment: () => ({ ...hostSnapshot, availableBackends: [] }),
        makeBackend: () => mcpBackend,
      }),
      context,
      { ...command, opId: 'start-host-policy-unavailable' },
    );
    expect(unavailable).toMatchObject({ ok: false });
    expect(unavailable.ok ? '' : unavailable.error).toContain('backend_unavailable');

    const nonMcp = await executeToolCommand(
      graphDeps(repository, root, turn, {
        getHostEnvironment: () => hostSnapshot,
        makeBackend: () => ({
          ...mcpBackend,
          capabilities: { ...mcpBackend.capabilities, supportsMCP: false },
        }),
      }),
      context,
      { ...command, opId: 'start-host-policy-non-mcp' },
    );
    expect(nonMcp).toMatchObject({ ok: false });
    expect(nonMcp.ok ? '' : nonMcp.error).toContain('backend_not_mcp');
    await expect(client.get(
      `SELECT run_id FROM workflow_runs WHERE workspace_id = 'ws' AND definition_id = 'wf-host-policy'`,
    )).resolves.toBeUndefined();

    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      maxDepth: 4,
      maxChildrenPerTask: 5,
      maxChildrenPerRoot: 5,
      maxTurnsPerTask: 4,
      maxConcurrentTurns: 3,
      maxConcurrentPerRoot: 2,
      maxConcurrentPerBackend: 2,
    };
    await expect(executeToolCommand(
      graphDeps(repository, root, turn, {
        getHostEnvironment: () => hostSnapshot,
        makeBackend: () => mcpBackend,
        getResourceLimits: () => limits,
      }),
      context,
      command,
    )).resolves.toMatchObject({ ok: true });
    await expect(client.get<{
      max_turns_per_task: number;
      max_children: number;
      max_depth: number;
      max_concurrency: number;
    }>(
      `SELECT max_turns_per_task, max_children, max_depth, max_concurrency
         FROM workflow_runs
        WHERE workspace_id = 'ws' AND definition_id = 'wf-host-policy'`,
    )).resolves.toMatchObject({
      max_turns_per_task: 4,
      max_children: 5,
      max_depth: 3,
      max_concurrency: 2,
    });
  });

  it('rejects forged workflow mutations from an activation but preserves ordinary delegated waits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-root-boundary-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const root: MusterTask = {
      ...makeTask('root-authority'),
      role: 'coordinator',
      capabilities: ['create_child'],
    };
    const child: MusterTask = {
      ...makeTask('child-coordinator'),
      role: 'coordinator',
      capabilities: ['create_child'],
      parentId: 'root-authority',
    };
    const turn: TaskTurn = { ...makeTurn('child-turn', 1, child.id), trigger: 'user' };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    await bindWorkflowActivation(repository, client, turn);
    const activationTurn = await repository.getTurn(turn.id);
    expect(activationTurn?.workflowActivation).toMatchObject({
      runId: `run-${turn.id}`,
      nodeId: 'node',
    });
    await repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-root-only',
      version: 1,
      name: 'root only',
      topology: {
        kind: 'workflow',
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
        nodes: [{ nodeId: 'entry', role: 'worker', backend: 'grok' }],
        edges: [],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
      ownerRootTaskId: 'root-authority',
      createdAt: '2026-07-22T03:00:00.000Z',
    });
    const context = {
      callerTaskId: child.id,
      turnId: turn.id,
      rootId: 'root-authority',
      allowedActions: new Set([
        'define_workflow',
        'start_workflow',
        'delegate_task',
        'wait_for_tasks',
      ]),
    };
    const scheduledTurns: string[] = [];
    const deps = graphDeps(repository, child, turn, {
      getHostEnvironment: () => ({
        cwd: dir,
        trusted: true,
        availableBackends: ['grok'],
        models: {},
      }),
      makeBackend: () => ({
        name: 'grok',
        capabilities: {
          supportsReasoning: true,
          supportsDetailedToolEvents: true,
          supportsMCP: true,
        },
        async *run() {},
      }),
      getTaskTypeRegistry: () => ({
        status: 'ok',
        registry: new Map([
          ['ordinary-worker', { backend: 'grok', role: 'worker' as const }],
        ]),
        diagnostics: [],
      }),
      onScheduleTurn: (turnId) => scheduledTurns.push(turnId),
    });
    deps.store.getFile().tasks[root.id] = root;
    deps.store.getFile().turns[turn.id] = activationTurn!;

    await expect(executeToolCommand(deps, context, {
      kind: 'define_workflow',
      opId: 'forged-child-define',
      definitionId: 'wf-forged-child',
      version: 1,
      name: 'forged child',
      topology: {
        kind: 'workflow',
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
        nodes: [{ nodeId: 'entry', role: 'worker', backend: 'grok' }],
        edges: [],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
    })).resolves.toEqual({
      ok: false,
      error: 'define_workflow is not authorized for the current caller',
    });
    await expect(executeToolCommand(deps, context, {
      kind: 'start_workflow',
      opId: 'forged-child-start',
      definitionId: 'wf-root-only',
      version: 1,
      startIdempotencyKey: 'forged-child-start',
      inputs: [],
    })).resolves.toEqual({
      ok: false,
      error: 'start_workflow is not authorized for the current caller',
    });
    await expect(repository.getWorkflowDefinition('wf-forged-child', 1)).resolves.toBeUndefined();
    await expect(client.get(
      `SELECT run_id FROM workflow_runs
        WHERE workspace_id = 'ws' AND caller_task_id = ?`,
      [child.id],
    )).resolves.toBeUndefined();

    const delegateOpId = 'delegate-ordinary-child';
    const delegatedTaskId = deriveEntityId(turn.id, delegateOpId, 'task');
    const delegatedTurnId = deriveEntityId(turn.id, delegateOpId, 'turn');
    const delegated = await executeToolCommand(deps, context, {
      kind: 'delegate_task',
      opId: delegateOpId,
      spec: {
        goal: 'perform ordinary delegated work',
        taskType: 'ordinary-worker',
      },
      waitForCompletion: true,
    });
    expect(delegated).toMatchObject({ ok: true });
    expect(scheduledTurns).toEqual([delegatedTurnId]);
    await expect(repository.getTask(delegatedTaskId)).resolves.toMatchObject({
      parentId: child.id,
      role: 'worker',
      releaseState: 'released',
    });
    await expect(repository.getTurn(delegatedTurnId)).resolves.toMatchObject({
      taskId: delegatedTaskId,
      status: 'queued',
      trigger: 'engine',
    });
    await expect(repository.getTurn(turn.id)).resolves.toMatchObject({
      disposition: {
        kind: 'wait_tasks',
        taskIds: [delegatedTaskId],
      },
    });
  });

  it('rejects forged root workflow mutations from a persisted schema-7 child activation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-hidden-child-authority-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const caller: MusterTask = {
      ...makeTask('legacy-child-root-shaped-caller'),
      role: 'coordinator',
      capabilities: ['create_child'],
      parentId: null,
    };
    const turn: TaskTurn = {
      ...makeTurn('legacy-child-root-shaped-turn', 1, caller.id),
      trigger: 'user',
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: caller });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    await bindWorkflowActivation(repository, client, turn, undefined, { origin: 'child' });
    await expect(repository.getTurn(turn.id)).resolves.toBeUndefined();
    await repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-hidden-child-start-target',
      version: 1,
      name: 'hidden child start target',
      topology: {
        kind: 'workflow',
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
        nodes: [{ nodeId: 'entry', backend: 'grok' }],
        edges: [],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
      ownerRootTaskId: caller.id,
      createdAt: '2026-07-22T04:00:00.000Z',
    });
    const deps = graphDeps(repository, caller, turn, {
      getHostEnvironment: () => ({
        cwd: dir,
        trusted: true,
        availableBackends: ['grok'],
        models: {},
      }),
      makeBackend: () => ({
        name: 'grok',
        capabilities: {
          supportsReasoning: true,
          supportsDetailedToolEvents: true,
          supportsMCP: true,
        },
        async *run() {},
      }),
    });
    const context = {
      callerTaskId: caller.id,
      turnId: turn.id,
      rootId: caller.id,
      allowedActions: new Set(['define_workflow', 'start_workflow']),
    };

    await expect(executeToolCommand(deps, context, {
      kind: 'define_workflow',
      opId: 'hidden-child-define',
      definitionId: 'wf-hidden-child-forged-definition',
      version: 1,
      name: 'hidden child forged definition',
      topology: {
        kind: 'workflow',
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
        nodes: [{ nodeId: 'entry', backend: 'grok' }],
        edges: [],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
    })).resolves.toEqual({
      ok: false,
      error: 'define_workflow is not authorized for the current caller',
    });
    await expect(executeToolCommand(deps, context, {
      kind: 'start_workflow',
      opId: 'hidden-child-start',
      definitionId: 'wf-hidden-child-start-target',
      version: 1,
      startIdempotencyKey: 'hidden-child-start',
      inputs: [],
    })).resolves.toEqual({
      ok: false,
      error: 'start_workflow is not authorized for the current caller',
    });
    await expect(repository.getWorkflowDefinition(
      'wf-hidden-child-forged-definition',
      1,
    )).resolves.toBeUndefined();
    await expect(client.get(
      `SELECT run_id FROM workflow_runs
        WHERE workspace_id = 'ws' AND definition_id = 'wf-hidden-child-start-target'`,
    )).resolves.toBeUndefined();
    await expect(client.get(
      `SELECT ledger_key FROM operations
        WHERE workspace_id = 'ws' AND ledger_key IN (?, ?)`,
      [`${turn.id}:hidden-child-define`, `${turn.id}:hidden-child-start`],
    )).resolves.toBeUndefined();
  });

  it('rechecks public define and start callers inside the repository transaction', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-public-authority-race-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const setupRepository = new SqliteTaskRepository(client, 'ws');
    const defineCaller: MusterTask = {
      ...makeTask('define-race-root'),
      role: 'coordinator',
      capabilities: ['create_child'],
    };
    const defineTurn: TaskTurn = {
      ...makeTurn('define-race-turn', 1, defineCaller.id),
      trigger: 'user',
    };
    const startCaller: MusterTask = {
      ...makeTask('start-race-root'),
      role: 'coordinator',
      capabilities: ['create_child'],
    };
    const startTurn: TaskTurn = {
      ...makeTurn('start-race-turn', 1, startCaller.id),
      trigger: 'user',
    };
    for (const task of [defineCaller, startCaller]) {
      await setupRepository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    }
    for (const turn of [defineTurn, startTurn]) {
      await setupRepository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    }
    await setupRepository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-start-authority-race',
      version: 1,
      name: 'start authority race',
      topology: {
        kind: 'workflow',
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
        nodes: [{ nodeId: 'entry', backend: 'grok' }],
        edges: [],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
      ownerRootTaskId: startCaller.id,
      createdAt: '2026-07-22T05:00:00.000Z',
    });
    const backend = {
      name: 'grok',
      capabilities: {
        supportsReasoning: true,
        supportsDetailedToolEvents: true,
        supportsMCP: true,
      },
      async *run() {},
    };
    const host = {
      cwd: dir,
      trusted: true,
      availableBackends: ['grok'],
      models: {},
    };

    const defineRepository = new SqliteTaskRepository(client, 'ws');
    const executeDefine = defineRepository.execute.bind(defineRepository);
    defineRepository.execute = async (command) => {
      if (command.kind === 'defineWorkflowVersion' && command.publicOperation) {
        await client.run(
          `UPDATE tasks SET lifecycle = 'cancelled', updated_at = ?
            WHERE workspace_id = 'ws' AND id = ?`,
          ['2026-07-22T05:00:01.000Z', defineCaller.id],
        );
      }
      return executeDefine(command);
    };
    await expect(executeToolCommand(
      graphDeps(defineRepository, defineCaller, defineTurn, {
        getHostEnvironment: () => host,
        makeBackend: () => backend,
      }),
      {
        callerTaskId: defineCaller.id,
        turnId: defineTurn.id,
        rootId: defineCaller.id,
        allowedActions: new Set(['define_workflow']),
      },
      {
        kind: 'define_workflow',
        opId: 'define-after-preauthorization',
        definitionId: 'wf-define-authority-race',
        version: 1,
        name: 'define authority race',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
          nodes: [{ nodeId: 'entry', backend: 'grok' }],
          edges: [],
        },
        entryContracts: [],
        policy: DEFAULT_WORKFLOW_POLICY,
      },
    )).resolves.toEqual({
      ok: false,
      error: 'define_workflow is not authorized for the current caller',
    });

    const startRepository = new SqliteTaskRepository(client, 'ws');
    const executeStart = startRepository.execute.bind(startRepository);
    startRepository.execute = async (command) => {
      if (command.kind === 'startWorkflowRun' && command.publicOperation) {
        await client.run(
          `UPDATE turns SET status = 'succeeded', settled_at = ?
            WHERE workspace_id = 'ws' AND id = ?`,
          ['2026-07-22T05:00:02.000Z', startTurn.id],
        );
      }
      return executeStart(command);
    };
    await expect(executeToolCommand(
      graphDeps(startRepository, startCaller, startTurn, {
        getHostEnvironment: () => host,
        makeBackend: () => backend,
      }),
      {
        callerTaskId: startCaller.id,
        turnId: startTurn.id,
        rootId: startCaller.id,
        allowedActions: new Set(['start_workflow']),
      },
      {
        kind: 'start_workflow',
        opId: 'start-after-preauthorization',
        definitionId: 'wf-start-authority-race',
        version: 1,
        startIdempotencyKey: 'start-after-preauthorization',
        inputs: [],
      },
    )).resolves.toEqual({
      ok: false,
      error: 'start_workflow is not authorized for the current caller',
    });

    await expect(client.get(
      `SELECT definition_id FROM workflow_definitions
        WHERE workspace_id = 'ws' AND definition_id = 'wf-define-authority-race'`,
    )).resolves.toBeUndefined();
    await expect(client.get(
      `SELECT run_id FROM workflow_runs
        WHERE workspace_id = 'ws' AND definition_id = 'wf-start-authority-race'`,
    )).resolves.toBeUndefined();
    await expect(client.get(
      `SELECT ledger_key FROM operations
        WHERE workspace_id = 'ws' AND ledger_key IN (?, ?)`,
      [
        `${defineTurn.id}:define-after-preauthorization`,
        `${startTurn.id}:start-after-preauthorization`,
      ],
    )).resolves.toBeUndefined();
  });

  it('does not replay a define operation after the durable root loses authorization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-replay-authority-'));
    tempDirs.push(dir);
    const client = makeClient();
    await client.open(path.join(dir, 'muster.sqlite3'));
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    const root: MusterTask = {
      ...makeTask('replay-authority-root'),
      role: 'coordinator',
      capabilities: ['create_child'],
    };
    const turn: TaskTurn = {
      ...makeTurn('replay-authority-turn', 1, root.id),
      trigger: 'user',
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });

    const context = {
      callerTaskId: root.id,
      turnId: turn.id,
      rootId: root.id,
      allowedActions: new Set(['define_workflow']),
    };
    const command = {
      kind: 'define_workflow' as const,
      opId: 'replay-after-cancel',
      definitionId: 'wf-replay-after-cancel',
      version: 1,
      name: 'replay after cancel',
      topology: {
        kind: 'workflow' as const,
        inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
        nodes: [{ nodeId: 'entry', role: 'worker' as const, backend: 'grok' }],
        edges: [],
      },
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
    };
    const deps = graphDeps(repository, root, turn, {
      getHostEnvironment: () => ({
        cwd: dir,
        trusted: true,
        availableBackends: ['grok'],
        models: {},
      }),
      makeBackend: () => ({
        name: 'grok',
        capabilities: {
          supportsReasoning: true,
          supportsDetailedToolEvents: true,
          supportsMCP: true,
        },
        async *run() {},
      }),
    });

    await expect(executeToolCommand(deps, context, command)).resolves.toMatchObject({ ok: true });
    await client.run(
      `UPDATE tasks SET lifecycle = 'cancelled', updated_at = ?
        WHERE workspace_id = 'ws' AND id = ?`,
      ['2026-07-22T06:00:00.000Z', root.id],
    );

    await expect(executeToolCommand(deps, context, command)).resolves.toEqual({
      ok: false,
      error: 'define_workflow is not authorized for the current caller',
    });
  });
});
