import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../bridge/credentials';
import { durableDispositionClaim } from './disposition-claim';
import { executeToolCommand, type GraphEngineDeps } from './engine-graph';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
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

function makeTask(): MusterTask {
  return {
    id: 'task',
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

function makeTurn(id: string, sequence: number): TaskTurn {
  return {
    id,
    taskId: 'task',
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
): Promise<void> {
  const runId = `run-${turn.id}`;
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
    {
      sql: `INSERT INTO workflow_runs (
              workspace_id, run_id, definition_id, definition_version,
              status, origin, created_at, updated_at
            ) VALUES ('ws', ?, ?, 1, 'running', 'top_level', ?, ?)`,
      params: [runId, `definition-${turn.id}`, turn.createdAt, turn.createdAt],
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
              source_gate_id, primary_turn_id, message_id, execution_turn_id,
              created_at, updated_at
            ) VALUES ('ws', ?, ?, 'node', 'entry_start', 'running',
                      'entry-gate', ?, ?, ?, ?, ?)`,
      params: [
        runId,
        `activation-${turn.id}`,
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
    const broad = new Set(['workflow_next', 'workflow_prev', 'workflow_fail', 'invoke_child_workflow']);
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

  it('child workflow start applies host policy before staging and freezes effective clamps', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-child-policy-'));
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
      id: 'root-child-policy',
      role: 'coordinator',
      capabilities: ['create_child'],
    };
    const turn: TaskTurn = {
      ...makeTurn('turn-child-policy', 1),
      taskId: root.id,
    };
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    for (const [definitionId, contract] of [
      ['wf-child-policy-source', true],
      ['wf-child-policy', true],
    ] as const) {
      await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId,
        version: 1,
        name: definitionId,
        topology: {
          kind: 'workflow',
          inputs: contract
            ? [{ name: 'request', semanticKind: 'request', entryNodeId: 'entry', inputRef: 'request' }]
            : [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
          nodes: [{ nodeId: 'entry', role: 'worker', backend: 'grok' }],
          edges: [],
        },
        entryContracts: contract
          ? [{ entryNodeId: 'entry', inputRef: 'request', expectedArtifactKind: 'workflow_input' }]
          : [],
        policy: DEFAULT_WORKFLOW_POLICY,
        ownerRootTaskId: root.id,
        createdAt: '2026-07-22T03:00:00.000Z',
      });
    }
    await client.transaction([
      {
        sql: `INSERT INTO workflow_runs (
                workspace_id, run_id, definition_id, definition_version, status, origin,
                owner_root_task_id, caller_task_id, caller_turn_id, created_at, updated_at
              ) VALUES ('ws', 'child-policy-source-run', 'wf-child-policy-source', 1,
                        'running', 'top_level', ?, ?, ?, ?, ?)`,
        params: [root.id, root.id, turn.id, root.createdAt, root.createdAt],
      },
      {
        sql: `INSERT INTO workflow_artifacts (
                workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                revision, kind, payload_json, created_at
              ) VALUES ('ws', 'child-policy-source-run', 'child-policy-input', NULL,
                        'request', 1, 'workflow_input', '{"value":"input"}', ?)`,
        params: [root.createdAt],
      },
      {
        sql: `INSERT INTO workflow_artifact_sources (
                workspace_id, run_id, artifact_id, artifact_revision, source_kind,
                caller_task_id, caller_turn_id
              ) VALUES ('ws', 'child-policy-source-run', 'child-policy-input', 1,
                        'caller_turn', ?, ?)`,
        params: [root.id, turn.id],
      },
      {
        sql: `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
              VALUES ('ws', 'child-policy-source-run', 'entry', ?, 'active')`,
        params: [root.id],
      },
      {
        sql: `INSERT INTO workflow_dependency_gates (
                workspace_id, run_id, gate_id, consumer_node_id, status,
                activation_id, reserved_turn_id, aggregate_message_id
              ) VALUES ('ws', 'child-policy-source-run', 'source-gate', 'entry',
                        'satisfied', 'source-activation', ?, 'source-message')`,
        params: [turn.id],
      },
      {
        sql: `INSERT INTO workflow_gate_bindings (
                workspace_id, run_id, gate_id, input_ref, producer_node_id, required_kind
              ) VALUES ('ws', 'child-policy-source-run', 'source-gate', 'request', NULL,
                        'workflow_input')`,
      },
      {
        sql: `INSERT INTO workflow_gate_fills (
                workspace_id, run_id, gate_id, input_ref, artifact_run_id,
                artifact_id, artifact_revision, filled_at
              ) VALUES ('ws', 'child-policy-source-run', 'source-gate', 'request', NULL,
                        'child-policy-input', 1, ?)`,
        params: [root.createdAt],
      },
      {
        sql: `INSERT INTO messages (
                id, workspace_id, task_id, turn_id, role, state, ordering,
                content, created_at, payload_json
              ) VALUES ('source-message', 'ws', ?, ?, 'system', 'assigned', 0,
                        '[source activation]', ?, '{"payloadVersion":1}')`,
        params: [root.id, turn.id, root.createdAt],
      },
      {
        sql: `INSERT INTO workflow_activations (
                workspace_id, run_id, activation_id, node_id, kind, status,
                source_gate_id, primary_turn_id, message_id, execution_turn_id,
                created_at, updated_at
              ) VALUES ('ws', 'child-policy-source-run', 'source-activation', 'entry',
                        'entry_start', 'running', 'source-gate', ?, 'source-message', ?, ?, ?)`,
        params: [turn.id, turn.id, root.createdAt, root.createdAt],
      },
    ]);

    const command = {
      kind: 'invoke_child_workflow' as const,
      opId: 'invoke-child-policy',
      childDefinitionId: 'wf-child-policy',
      childDefinitionVersion: 1,
      entryBindings: [{
        name: 'request',
        fromInputRef: 'request',
      }],
    };
    const context = {
      callerTaskId: root.id,
      turnId: turn.id,
      rootId: root.id,
      allowedActions: new Set(['invoke_child_workflow']),
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
    const unavailable = await executeToolCommand(
      graphDeps(repository, root, turn, {
        getHostEnvironment: () => ({ ...hostSnapshot, availableBackends: [] }),
        makeBackend: () => mcpBackend,
      }),
      context,
      command,
    );
    expect(unavailable).toMatchObject({ ok: false });
    expect(unavailable.ok ? '' : unavailable.error).toContain('backend_unavailable');
    await expect(client.get(
      `SELECT turn_id FROM turn_disposition_claims
        WHERE workspace_id = 'ws' AND turn_id = ?`,
      [turn.id],
    )).resolves.toBeUndefined();

    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      maxDepth: 4,
      maxChildrenPerTask: 6,
      maxChildrenPerRoot: 6,
      maxTurnsPerTask: 3,
      maxConcurrentTurns: 2,
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
    )).resolves.toEqual({ ok: true, result: { staged: true } });
    const stagedTurn = await repository.getTurn(turn.id);
    expect(stagedTurn?.disposition).toMatchObject({
      kind: 'workflow_next',
      route: {
        kind: 'child_workflow',
        effectivePolicy: {
          maxTurnsPerTask: 3,
          maxDepth: 3,
          maxTaskCount: 6,
          maxConcurrency: 2,
        },
      },
    });

    const durableTask = await repository.getTask(root.id);
    await expect(repository.execute({
      kind: 'settleTurnAndApplyEffects',
      workspaceId: 'ws',
      expectedTaskRevision: durableTask!.revision,
      task: { ...durableTask!, updatedAt: '2026-07-22T03:00:02.000Z' },
      turn: {
        ...stagedTurn!,
        status: 'succeeded',
        finishedAt: '2026-07-22T03:00:02.000Z',
      },
      expectedStatuses: ['running'],
      relatedTurns: [],
      messages: [],
    })).resolves.toMatchObject({ changed: true });
    await expect(client.get<{
      max_turns_per_task: number;
      max_children: number;
      max_depth: number;
      max_concurrency: number;
    }>(
      `SELECT max_turns_per_task, max_children, max_depth, max_concurrency
         FROM workflow_runs
        WHERE workspace_id = 'ws' AND origin = 'child'`,
    )).resolves.toMatchObject({
      max_turns_per_task: 3,
      max_children: 6,
      max_depth: 3,
      max_concurrency: 2,
    });
  });
});
