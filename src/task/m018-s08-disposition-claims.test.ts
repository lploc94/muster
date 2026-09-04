import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../bridge/credentials';
import { executeToolCommand, type GraphEngineDeps } from './engine-graph';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { DbClient, DbWorkerError } from './sqlite/client';
import type { EngineProjection, MusterTask, TaskTurn, TurnDisposition } from './types';
import type { WorkflowAgentOutcome } from './workflow-types';
import { DEFAULT_WORKFLOW_POLICY } from './workflow';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const clients: DbClient[] = [];
const tempDirs: string[] = [];
const CREATED_AT = '2026-07-22T02:00:00.000Z';

const AGENT_OUTCOME: WorkflowAgentOutcome = {
  kind: 'agent',
  requireExplicitDisposition: true,
  next: { when: 'The result is complete.' },
  fail: { when: 'The result cannot be produced.' },
};

type StartEntry = {
  nodeId: string;
  taskId: string;
  activationTurnId: string;
  gateId?: string;
};

type StartPayload = {
  runId: string;
  entries: StartEntry[];
  nodeGates?: Array<{ nodeId: string; gateId: string }>;
};

type Opened = {
  dir: string;
  dbPath: string;
  client: DbClient;
  repository: SqliteTaskRepository;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeClient(options: {
  faultCapability?: boolean;
  faultPlan?: { code: 'full' | 'io' | 'busy' | 'readonly'; operation: 'transaction'; remaining: number };
} = {}): DbClient {
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
    ...(options.faultCapability ? { faultCapability: true } : {}),
    ...(options.faultPlan ? { faultPlan: options.faultPlan } : {}),
  });
  clients.push(client);
  return client;
}

async function openRepo(label: string, client = makeClient()): Promise<Opened> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s08-${label}-`));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'muster.sqlite3');
  await client.open(dbPath);
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
     VALUES ('ws', ?, ?, ?, ?)`,
    [label, label, CREATED_AT, CREATED_AT],
  );
  return { dir, dbPath, client, repository: new SqliteTaskRepository(client, 'ws') };
}

function oneNodeDefinition(definitionId: string, outcome: WorkflowAgentOutcome = AGENT_OUTCOME) {
  return {
    definitionId,
    version: 1,
    name: `Definition ${definitionId}`,
    topology: {
      kind: 'workflow' as const,
      inputs: [],
      outputs: [{ name: 'result', semanticKind: 'result', sourceNodeId: 'node' }],
      nodes: [{ nodeId: 'node', title: 'Stable node', outcome }],
      edges: [],
    },
    entryContracts: [],
    policy: DEFAULT_WORKFLOW_POLICY,
    createdAt: CREATED_AT,
  };
}

async function defineAndStart(
  repository: SqliteTaskRepository,
  definitionId: string,
  startKey: string,
  outcome: WorkflowAgentOutcome = AGENT_OUTCOME,
): Promise<{ definitionId: string; data: StartPayload; entry: StartEntry }> {
  const definition = oneNodeDefinition(definitionId, outcome);
  await expect(repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    ...definition,
  })).resolves.toMatchObject({ ok: true, changed: true });
  const started = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    startIdempotencyKey: startKey,
    createdAt: CREATED_AT,
    goal: 'disposition claim fixture',
    backend: 'grok',
  });
  expect(started).toMatchObject({ ok: true, changed: true });
  const data = started.operation?.result?.data as StartPayload;
  expect(data.runId).toBeTruthy();
  expect(data.entries).toHaveLength(1);
  return { definitionId, data, entry: data.entries[0]! };
}

async function markRunning(client: DbClient, entry: StartEntry, at = '2026-07-22T02:00:01.000Z'): Promise<void> {
  await client.transaction([
    {
      sql: `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL
             WHERE workspace_id = 'ws' AND id = ?`,
      params: [at, entry.activationTurnId],
    },
    {
      sql: `UPDATE workflow_activations SET status = 'running', updated_at = ?
             WHERE workspace_id = 'ws' AND execution_turn_id = ?`,
      params: [at, entry.activationTurnId],
    },
  ]);
}

async function stage(
  repository: SqliteTaskRepository,
  turn: TaskTurn,
  opId: string,
  disposition: TurnDisposition,
) {
  return stageDispositionForSettlement(repository, turn, disposition, opId);
}

async function settle(
  repository: SqliteTaskRepository,
  entry: StartEntry,
  disposition: TurnDisposition,
  finishedAt = '2026-07-22T02:00:03.000Z',
) {
  const task = await repository.getTask(entry.taskId);
  const turn = await repository.getTurn(entry.activationTurnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  await expect(stage(repository, turn!, `stage:${entry.activationTurnId}`, disposition))
    .resolves.toMatchObject({ changed: true });
  return repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: 'ws',
    expectedTaskRevision: task!.revision,
    task: { ...task!, updatedAt: finishedAt },
    turn: { ...turn!, status: 'succeeded', finishedAt, disposition },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  });
}

function makeTask(id = 'ordinary-task'): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'released',
    goal: 'ordinary task',
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    runtimeEpoch: 1,
    revision: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function makeTurn(id: string, taskId: string): TaskTurn {
  return {
    id,
    taskId,
    sequence: 1,
    status: 'running',
    trigger: 'engine',
    runtimeEpoch: 1,
    inputs: [],
    createdAt: '2026-07-22T02:00:01.000Z',
    startedAt: '2026-07-22T02:00:02.000Z',
  };
}

function graphDeps(
  repository: SqliteTaskRepository,
  task: MusterTask,
  turn: TaskTurn,
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
    makeBackend: () => { throw new Error('backend not used'); },
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
  };
}

describe('M018 universal durable disposition claims', () => {
  it('keeps cross-family claims single-winner under concurrent delivery', async () => {
    const first = await openRepo('cross-family-first');
    const secondClient = makeClient();
    await secondClient.open(first.dbPath);
    const second = new SqliteTaskRepository(secondClient, 'ws');
    const started = await defineAndStart(first.repository, 'wf-cross-family', 'cross-family');
    await markRunning(first.client, started.entry);
    const turn = await first.repository.getTurn(started.entry.activationTurnId);
    expect(turn).toBeTruthy();

    const results = await Promise.all([
      stage(first.repository, turn!, 'op-complete', { kind: 'complete', result: 'done' }),
      stage(second, turn!, 'op-next', { kind: 'workflow_next', change: 'updated', result: 'next' }),
    ]);
    expect(results.filter((result) => result.changed === true)).toHaveLength(1);
    expect(results.filter((result) => result.conflict === true)).toHaveLength(1);
    await expect(first.client.all<{ op_id: string; family: string; kind: string; status: string }>(
      `SELECT op_id, family, kind, status FROM turn_disposition_claims
        WHERE workspace_id = 'ws' AND turn_id = ?`,
      [turn!.id],
    )).resolves.toHaveLength(1);
  });

  it('keeps a valid route authoritative over invalid and later claims', async () => {
    const ctx = await openRepo('valid-route');
    const started = await defineAndStart(ctx.repository, 'wf-valid-route', 'valid-route');
    await markRunning(ctx.client, started.entry);
    const turn = await ctx.repository.getTurn(started.entry.activationTurnId);
    expect(turn).toBeTruthy();

    await expect(stage(ctx.repository, turn!, 'invalid-prev', {
      kind: 'workflow_prev', targets: ['missing-node'], note: 'invalid',
    })).resolves.toMatchObject({ changed: false });
    await expect(stage(ctx.repository, turn!, 'valid-next', {
      kind: 'workflow_next', change: 'updated', result: 'declared result',
    })).resolves.toMatchObject({ changed: true });
    await expect(stage(ctx.repository, turn!, 'late-fail', {
      kind: 'workflow_fail', reason: 'too late',
    })).resolves.toMatchObject({ changed: false });
    await expect(ctx.client.all(
      `SELECT family, kind, status FROM turn_disposition_claims
        WHERE workspace_id = 'ws' AND turn_id = ?`,
      [turn!.id],
    )).resolves.toEqual([{ family: 'workflow', kind: 'next', status: 'staged' }]);
  });

  it('closes an explicit failure from frozen authority and preserves its bounded closure', async () => {
    const ctx = await openRepo('explicit-failure');
    const started = await defineAndStart(ctx.repository, 'wf-explicit-failure', 'explicit-failure');
    await markRunning(ctx.client, started.entry);
    const reason = 'node-reported failure: choose a different independent action';
    await expect(settle(ctx.repository, started.entry, { kind: 'workflow_fail', reason }))
      .resolves.toMatchObject({ changed: true });

    const run = await ctx.client.get<{
      status: string;
      terminal_reason_code: string;
      closure_id: string;
    }>(
      `SELECT status, terminal_reason_code, closure_id FROM workflow_runs
        WHERE workspace_id = 'ws' AND run_id = ?`,
      [started.data.runId],
    );
    expect(run).toMatchObject({ status: 'failed', terminal_reason_code: 'agent_fail' });
    expect(run?.closure_id).toBeTruthy();
    const closure = await ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = 'ws' AND run_id = ? AND kind = 'run_closure'`,
      [started.data.runId],
    );
    expect(closure).toBeTruthy();
    expect(JSON.parse(closure!.body_json)).toMatchObject({
      payloadVersion: 1,
      detail: { source: 'workflow_fail', report: { text: reason } },
    });
    expect(await ctx.repository.getWorkflowExecutionContext(started.entry.activationTurnId)).toBeUndefined();
  });

  it('rejects workflow claims on ordinary turns and never creates a claim row', async () => {
    const ctx = await openRepo('ordinary-turn');
    const task = makeTask();
    const turn = makeTurn('ordinary-turn', task.id);
    await ctx.repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    await ctx.repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    await expect(stage(ctx.repository, turn, 'ordinary-workflow-next', {
      kind: 'workflow_next', change: 'updated', result: 'not authorized',
    })).resolves.toMatchObject({ changed: false });
    await expect(stage(ctx.repository, turn, 'ordinary-workflow-fail', {
      kind: 'workflow_fail', reason: 'not authorized',
    })).resolves.toMatchObject({ changed: false });
    await expect(ctx.client.get(
      `SELECT turn_id FROM turn_disposition_claims WHERE workspace_id = 'ws' AND turn_id = ?`,
      [turn.id],
    )).resolves.toBeUndefined();
  });

  it('revalidates broad workflow credentials against durable activation authority', async () => {
    const ctx = await openRepo('activation-authority');
    const task = makeTask('activation-task');
    const turn = makeTurn('activation-turn', task.id);
    await ctx.repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
    await ctx.repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
    const deps = graphDeps(ctx.repository, task, turn);
    const context = {
      callerTaskId: task.id,
      turnId: turn.id,
      rootId: task.id,
      allowedActions: new Set(['workflow_next', 'workflow_prev', 'workflow_fail']),
    };
    await expect(executeToolCommand(deps, context, {
      kind: 'workflow_next', opId: 'unbound-next', change: 'updated', message: 'x',
    })).resolves.toEqual({
      ok: false,
      error: 'workflow_next is not authorized for the current workflow context',
    });
    expect(context.allowedActions.has('workflow_fail')).toBe(true);
  });

  it('fails closed when the run digest or an immutable authority row is corrupted', async () => {
    const digestCtx = await openRepo('corrupt-digest');
    const digestRun = await defineAndStart(digestCtx.repository, 'wf-corrupt-digest', 'corrupt-digest');
    await digestCtx.client.run(
      `UPDATE workflow_runs SET authority_fingerprint = ?
        WHERE workspace_id = 'ws' AND run_id = ?`,
      ['a'.repeat(64), digestRun.data.runId],
    );
    await expect(digestCtx.repository.getWorkflowExecutionContext(digestRun.entry.activationTurnId))
      .resolves.toBeUndefined();

    const nodeCtx = await openRepo('corrupt-node');
    const nodeRun = await defineAndStart(nodeCtx.repository, 'wf-corrupt-node', 'corrupt-node');
    await nodeCtx.client.run('DROP TRIGGER trg_workflow_run_nodes_immutable_update');
    await nodeCtx.client.run(
      `UPDATE workflow_run_node_specs SET outcome_json = ?
        WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'node'`,
      [JSON.stringify({ ...AGENT_OUTCOME, fail: { when: 'changed after start' } }), nodeRun.data.runId],
    );
    await expect(nodeCtx.repository.getWorkflowExecutionContext(nodeRun.entry.activationTurnId))
      .resolves.toBeUndefined();
  });

  it('retains the accepted run snapshot when a later definition version differs', async () => {
    const ctx = await openRepo('snapshot-version');
    const started = await defineAndStart(ctx.repository, 'wf-snapshot-version', 'snapshot-version');
    const changedOutcome: WorkflowAgentOutcome = {
      ...AGENT_OUTCOME,
      next: { when: 'a later definition must not change this run' },
    };
    await expect(ctx.repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      ...oneNodeDefinition('wf-snapshot-version', changedOutcome),
      version: 2,
    })).resolves.toMatchObject({ ok: true, changed: true });
    await expect(ctx.client.get<{ outcome_json: string }>(
      `SELECT outcome_json FROM workflow_run_node_specs
        WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'node'`,
      [started.data.runId],
    )).resolves.toMatchObject({ outcome_json: JSON.stringify(AGENT_OUTCOME) });
  });

  it('rolls back a failed reclamation transaction and succeeds on a clean retry', async () => {
    const setup = await openRepo('reclamation-fault-setup');
    const started = await defineAndStart(setup.repository, 'wf-reclamation-fault', 'reclamation-fault');
    await markRunning(setup.client, started.entry);
    await expect(settle(setup.repository, started.entry, {
      kind: 'workflow_fail', reason: 'reclamation fault fixture',
    })).resolves.toMatchObject({ changed: true });
    await setup.client.run(
      `INSERT INTO workflow_routed_messages (
         workspace_id, run_id, message_id, source_node_id, destination_node_id,
         kind, body_json, created_at
       ) VALUES ('ws', ?, 'transport-message', 'node', 'node', 'terminal_next', ?, ?)`,
      [started.data.runId, '{"transport":"must strip"}', CREATED_AT],
    );
    const dbPath = setup.dbPath;
    await setup.client.close();

    const faultClient = makeClient({
      faultCapability: true,
      faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
    });
    await faultClient.open(dbPath);
    const faultRepository = new SqliteTaskRepository(faultClient, 'ws');
    await expect(faultRepository.execute({
      kind: 'reclaimTerminalWorkflowMetadata', workspaceId: 'ws',
    })).rejects.toBeInstanceOf(DbWorkerError);
    await faultClient.close();

    const retryClient = makeClient();
    await retryClient.open(dbPath);
    const retryRepository = new SqliteTaskRepository(retryClient, 'ws');
    await expect(retryRepository.execute({
      kind: 'reclaimTerminalWorkflowMetadata', workspaceId: 'ws',
    })).resolves.toMatchObject({ changed: true, strippedWorkflowMessageBodies: 1 });
    await expect(retryClient.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = 'ws' AND run_id = ? AND message_id = 'transport-message'`,
      [started.data.runId],
    )).resolves.toEqual({ body_json: '{"retentionStripped":true}' });
    await expect(retryClient.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
  });
});
