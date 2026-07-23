import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../bridge/credentials';
import { executeToolCommand, type GraphEngineDeps } from './engine-graph';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { EngineProjection, MusterTask, TaskTurn, TurnDisposition } from './types';
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

async function bindWorkflowActivation(client: DbClient, turn: TaskTurn): Promise<void> {
  const runId = `run-${turn.id}`;
  const messageId = `message-${turn.id}`;
  await client.transaction([
    {
      sql: `INSERT INTO workflow_definitions (
              workspace_id, definition_id, version, name, entry_node_id,
              topology_json, fingerprint, created_at
            ) VALUES ('ws', ?, 1, 'Disposition race', 'node', ?, ?, ?)`,
      params: [
        `definition-${turn.id}`,
        JSON.stringify({ kind: 'one_node_v1', nodes: [{ nodeId: 'node' }], entryNodeId: 'node' }),
        `fingerprint-${turn.id}`,
        turn.createdAt,
      ],
    },
    {
      sql: `INSERT INTO workflow_definition_nodes (
              workspace_id, definition_id, definition_version, node_id, ordinal, is_terminal
            ) VALUES ('ws', ?, 1, 'node', 0, 1)`,
      params: [`definition-${turn.id}`],
    },
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
    await bindWorkflowActivation(firstClient, turn);

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
    await bindWorkflowActivation(firstClient, turn);

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
      { kind: 'workflow_next', opId: 'unbound-next', change: 'updated', result: 'x' },
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
    await bindWorkflowActivation(client, active);
    await expect(executeToolCommand(
      graphDeps(repository, task, active),
      { callerTaskId: task.id, turnId: active.id, rootId: task.id, allowedActions: broad },
      { kind: 'workflow_next', opId: 'initial-unchanged', change: 'unchanged' },
    )).resolves.toEqual({
      ok: false,
      error: 'workflow_next unchanged requires a feedback-request activation',
    });
    await expect(executeToolCommand(
      graphDeps(repository, task, active),
      { callerTaskId: task.id, turnId: active.id, rootId: task.id, allowedActions: broad },
      { kind: 'workflow_next', opId: 'active-next', change: 'updated', result: 'x' },
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
          kind: 'one_node_v1',
          entryNodeId: 'entry',
          nodes: [{ nodeId: 'entry', role: 'worker', backend: 'unsupported' }],
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
        kind: 'one_node_v1',
        entryNodeId: 'entry',
        nodes: [{ nodeId: 'entry', role: 'worker', backend: 'grok' }],
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
      entryInputs: [],
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
      ['wf-child-policy-source', false],
      ['wf-child-policy', true],
    ] as const) {
      await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId,
        version: 1,
        name: definitionId,
        topology: {
          kind: 'one_node_v1',
          entryNodeId: 'entry',
          nodes: [{ nodeId: 'entry', role: 'worker', backend: 'grok' }],
        },
        entryContracts: contract
          ? [{ entryNodeId: 'entry', inputRef: 'request', expectedArtifactKind: 'next_result' }]
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
                        'request', 1, 'next_result', '{"value":"input"}', ?)`,
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
    ]);

    const command = {
      kind: 'invoke_child_workflow' as const,
      opId: 'invoke-child-policy',
      childDefinitionId: 'wf-child-policy',
      childDefinitionVersion: 1,
      entryBindings: [{
        childEntryNodeId: 'entry',
        inputRef: 'request',
        artifactId: 'child-policy-input',
        artifactRevision: 1,
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
