/**
 * M018 S06 named flow:
 * public define/start → real SQLite worker + repository settle path →
 * child-workflow invocation + durable single-resume return:
 *   - invoke_child_workflow atomically starts a child run (origin='child')
 *     with parent_run_id, pending continuation, and caller return gate
 *   - foreign/missing entry binding aborts with zero child rows
 *   - child terminal NEXT resolves the continuation once and queues exactly
 *     one caller resume turn (child_return fence)
 *   - duplicate terminal delivery / reload is a no-op for resume
 *   - child FAIL flips continuation to failed once and emits bounded caller attention
 *   - caller lifecycle stays open (unsealed) across invoke and return
 *
 * Body_json fences carry identities/reason codes only — never prompts, artifacts,
 * paths, or SQL.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask, TaskTurn, TurnDisposition } from './types';
import {
  DEFAULT_WORKFLOW_POLICY,
  maximumWorkflowEntryAggregateBytes,
  type WorkflowPolicyV1,
} from './workflow';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

const ONE_NODE = {
  kind: 'one_node_v1' as const,
  nodes: [{ nodeId: 'entry' }],
  entryNodeId: 'entry',
};

type OneNodeStart = {
  runId: string;
  entryTaskId: string;
  activationTurnId: string;
  startArtifactId: string;
  entryGateId: string;
};

type Opened = {
  dir: string;
  dbPath: string;
  client: DbClient;
  repository: SqliteTaskRepository;
  close: () => Promise<void>;
};

async function openRepo(label: string): Promise<Opened> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s06-${label}-`));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
  });
  await client.open(dbPath);
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
    ['ws', `s06-${label}`, `S06 ${label}`, 'now', 'now'],
  );
  const repository = new SqliteTaskRepository(client, 'ws');
  return {
    dir,
    dbPath,
    client,
    repository,
    async close() {
      await client.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function defineVersion(
  repository: SqliteTaskRepository,
  createdAt: string,
  definitionId: string,
  name: string,
  entryArtifactKind?: string,
  policy: WorkflowPolicyV1 = DEFAULT_WORKFLOW_POLICY,
): Promise<void> {
  const def = await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    name,
    topology: ONE_NODE,
    ...(entryArtifactKind
      ? {
          entryContracts: [{
            entryNodeId: 'entry',
            inputRef: 'engine_start',
            expectedArtifactKind: entryArtifactKind,
          }],
        }
      : {}),
    policy,
    createdAt,
  });
  expect(def.ok).toBe(true);
}

async function startOneNode(
  repository: SqliteTaskRepository,
  createdAt: string,
  definitionId: string,
  startKey: string,
  goal: string,
): Promise<OneNodeStart> {
  const start = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    startIdempotencyKey: startKey,
    createdAt,
    goal,
    backend: 'grok',
  });
  expect(start.ok).toBe(true);
  return start.operation?.result?.data as OneNodeStart;
}

async function promoteRunning(
  client: DbClient,
  turnId: string,
  startedAt: string,
): Promise<void> {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL WHERE workspace_id = ? AND id = ?`,
    [startedAt, 'ws', turnId],
  );
}

async function settleSucceeded(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  disposition: TurnDisposition,
  finishedAt: string,
  startedAt: string = finishedAt,
) {
  await promoteRunning(client, turnId, startedAt);
  const task = await repository.getTask(taskId);
  const turn = await repository.getTurn(turnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  return repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: 'ws',
    expectedTaskRevision: task!.revision,
    task: { ...task!, updatedAt: finishedAt },
    turn: {
      ...turn!,
      status: 'succeeded',
      finishedAt,
      disposition,
    },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  });
}

async function runRow(
  client: DbClient,
  runId: string,
): Promise<
  | {
      status: string;
      origin: string;
      parent_run_id: string | null;
      definition_id: string;
    }
  | undefined
> {
  return client.get(
    `SELECT status, origin, parent_run_id, definition_id
       FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
    ['ws', runId],
  );
}

async function childRunsForParent(
  client: DbClient,
  parentRunId: string,
): Promise<
  Array<{
    run_id: string;
    status: string;
    origin: string;
    parent_run_id: string | null;
    definition_id: string;
  }>
> {
  return client.all(
    `SELECT run_id, status, origin, parent_run_id, definition_id
       FROM workflow_runs
      WHERE workspace_id = ? AND parent_run_id = ?`,
    ['ws', parentRunId],
  );
}

async function continuationsForRun(
  client: DbClient,
  runId: string,
): Promise<
  Array<{
    continuation_id: string;
    status: string;
    kind: string;
    payload_json: string;
  }>
> {
  return client.all(
    `SELECT continuation_id, status, kind, payload_json
       FROM workflow_continuations
      WHERE workspace_id = ? AND run_id = ?`,
    ['ws', runId],
  );
}

async function routedKinds(
  client: DbClient,
  runId: string,
): Promise<string[]> {
  const rows = await client.all<{ kind: string }>(
    `SELECT kind FROM workflow_routed_messages
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY created_at, message_id`,
    ['ws', runId],
  );
  return rows.map((r) => r.kind);
}

async function entryTaskForRun(
  client: DbClient,
  runId: string,
): Promise<{ task_id: string; node_id: string } | undefined> {
  return client.get(
    `SELECT task_id, node_id FROM workflow_nodes
      WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry' AND task_id IS NOT NULL`,
    ['ws', runId],
  );
}

async function queuedTurnsForTask(
  client: DbClient,
  taskId: string,
): Promise<Array<{ id: string; status: string; sequence: number }>> {
  return client.all(
    `SELECT id, status, sequence FROM turns
      WHERE workspace_id = ? AND task_id = ? AND status = 'queued'
      ORDER BY sequence`,
    ['ws', taskId],
  );
}

async function nextTurnSequence(client: DbClient, taskId: string): Promise<number> {
  const row = await client.get<{ m: number | null }>(
    `SELECT MAX(sequence) AS m FROM turns WHERE workspace_id = ? AND task_id = ?`,
    ['ws', taskId],
  );
  return (row?.m ?? 0) + 1;
}

async function insertEngineTurn(
  client: DbClient,
  taskId: string,
  turnId: string,
  status: 'queued' | 'running',
  createdAt: string,
  sequence: number,
): Promise<void> {
  await client.run(
    `INSERT INTO turns (
       id, workspace_id, task_id, sequence, status, trigger,
       created_at, started_at, settled_at, payload_json
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      turnId,
      'ws',
      taskId,
      sequence,
      status,
      'engine',
      createdAt,
      status === 'running' ? createdAt : null,
      null,
      JSON.stringify({ payloadVersion: 1 }),
    ],
  );
}

async function seedNodeArtifact(
  client: DbClient,
  runId: string,
  taskId: string,
  turnId: string,
  artifactId: string,
  createdAt: string,
): Promise<void> {
  const activation = await client.get<{ activation_id: string }>(
    `SELECT activation_id FROM workflow_activations
      WHERE workspace_id = ? AND run_id = ? AND execution_turn_id = ?`,
    ['ws', runId, turnId],
  );
  expect(activation?.activation_id).toBeTruthy();
  await client.transaction([
    {
      sql: `INSERT INTO workflow_artifacts (
              workspace_id, run_id, artifact_id, producer_node_id, logical_name,
              revision, kind, payload_json, created_at
            ) VALUES (?,?,?,?,?,1,'next_result',?,?)`,
      params: ['ws', runId, artifactId, 'entry', 'nested-input', '{"value":"nested input"}', createdAt],
    },
    {
      sql: `INSERT INTO workflow_artifact_sources (
              workspace_id, run_id, artifact_id, artifact_revision, source_kind,
              producer_run_id, producer_node_id, producer_task_id,
              producing_turn_id, producing_activation_id
            ) VALUES (?,?,?,1,'workflow_node',?,?,?,?,?)`,
      params: [
        'ws', runId, artifactId, runId, 'entry', taskId, turnId, activation!.activation_id,
      ],
    },
  ]);
}

async function startThreeLevelChain(opened: Opened, label: string): Promise<{
  runIds: [string, string, string];
  taskIds: [string, string, string];
  turnIds: [string, string, string];
}> {
  const createdAt = '2026-07-22T10:00:00.000Z';
  const topDefinition = `wf-${label}-top`;
  const middleDefinition = `wf-${label}-middle`;
  const leafDefinition = `wf-${label}-leaf`;
  await defineVersion(opened.repository, createdAt, topDefinition, `${label} top`);
  await defineVersion(opened.repository, createdAt, middleDefinition, `${label} middle`, 'engine_start');
  await defineVersion(opened.repository, createdAt, leafDefinition, `${label} leaf`, 'next_result');
  const top = await startOneNode(
    opened.repository,
    createdAt,
    topDefinition,
    `${label}-top-start`,
    `${label} top`,
  );

  await settleSucceeded(
    opened.repository,
    opened.client,
    top.entryTaskId,
    top.activationTurnId,
    {
      kind: 'workflow_next',
      change: 'updated',
      route: {
        kind: 'child_workflow',
        childDefinitionId: middleDefinition,
        childDefinitionVersion: 1,
        entryBindings: [{
          childEntryNodeId: 'entry',
          inputRef: 'engine_start',
          artifactId: top.startArtifactId,
          artifactRevision: 1,
        }],
        childIdempotencyKey: `${label}-middle-child`,
      },
    },
    '2026-07-22T10:01:00.000Z',
  );
  const middleRun = (await childRunsForParent(opened.client, top.runId))[0]!;
  const middleEntry = (await entryTaskForRun(opened.client, middleRun.run_id))!;
  const middleTurn = (await queuedTurnsForTask(opened.client, middleEntry.task_id))[0]!;
  const middleArtifactId = `${label}-middle-artifact`;
  await seedNodeArtifact(
    opened.client,
    middleRun.run_id,
    middleEntry.task_id,
    middleTurn.id,
    middleArtifactId,
    '2026-07-22T10:01:30.000Z',
  );
  await settleSucceeded(
    opened.repository,
    opened.client,
    middleEntry.task_id,
    middleTurn.id,
    {
      kind: 'workflow_next',
      change: 'updated',
      route: {
        kind: 'child_workflow',
        childDefinitionId: leafDefinition,
        childDefinitionVersion: 1,
        entryBindings: [{
          childEntryNodeId: 'entry',
          inputRef: 'engine_start',
          artifactId: middleArtifactId,
          artifactRevision: 1,
        }],
        childIdempotencyKey: `${label}-leaf-child`,
      },
    },
    '2026-07-22T10:02:00.000Z',
  );
  const leafRun = (await childRunsForParent(opened.client, middleRun.run_id))[0]!;
  const leafEntry = (await entryTaskForRun(opened.client, leafRun.run_id))!;
  const leafTurn = (await queuedTurnsForTask(opened.client, leafEntry.task_id))[0]!;
  return {
    runIds: [top.runId, middleRun.run_id, leafRun.run_id],
    taskIds: [top.entryTaskId, middleEntry.task_id, leafEntry.task_id],
    turnIds: [top.activationTurnId, middleTurn.id, leafTurn.id],
  };
}

describe('M018 S06 child-workflow continuation (named flow)', () => {
  it('an ordinary root coordinator invokes a child and resumes through its return gate', async () => {
    const opened = await openRepo('root-caller');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      await defineVersion(opened.repository, createdAt, 'wf-source', 'source');
      await defineVersion(opened.repository, createdAt, 'wf-child', 'child', 'next_result');
      const root: MusterTask = {
        id: 'root-caller',
        role: 'coordinator',
        lifecycle: 'open',
        releaseState: 'released',
        goal: 'invoke child',
        parentId: null,
        dependencies: [],
        backend: 'grok',
        capabilities: ['create_child'],
        executionPolicy: { maxTurns: 20, maxAutomaticRetries: 1 },
        runtimeEpoch: 1,
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      };
      const rootTurn: TaskTurn = {
        id: 'root-caller-turn',
        taskId: root.id,
        sequence: 1,
        trigger: 'user',
        status: 'running',
        runtimeEpoch: 1,
        inputs: [],
        createdAt,
        startedAt: createdAt,
      };
      await opened.repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
      await opened.repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: rootTurn });
      await opened.client.transaction([
        {
          sql: `INSERT INTO workflow_runs (
                  workspace_id, run_id, definition_id, definition_version, status, origin,
                  owner_root_task_id, caller_task_id, caller_turn_id, created_at, updated_at
                ) VALUES ('ws', 'root-source-run', 'wf-source', 1, 'running', 'top_level',
                          ?, ?, ?, ?, ?)`,
          params: [root.id, root.id, rootTurn.id, createdAt, createdAt],
        },
        {
          sql: `INSERT INTO workflow_artifacts (
                  workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                  revision, kind, payload_json, created_at
                ) VALUES ('ws', 'root-source-run', 'root-input', NULL, 'input', 1,
                          'next_result', '{"value":"root input"}', ?)`,
          params: [createdAt],
        },
        {
          sql: `INSERT INTO workflow_artifact_sources (
                  workspace_id, run_id, artifact_id, artifact_revision, source_kind,
                  caller_task_id, caller_turn_id
                ) VALUES ('ws', 'root-source-run', 'root-input', 1, 'caller_turn', ?, ?)`,
          params: [root.id, rootTurn.id],
        },
      ]);

      const invocation: TurnDisposition = {
        kind: 'workflow_next',
        change: 'updated',
        route: {
          kind: 'child_workflow',
          childDefinitionId: 'wf-child',
          childDefinitionVersion: 1,
          entryBindings: [{
            childEntryNodeId: 'entry',
            inputRef: 'engine_start',
            artifactId: 'root-input',
            artifactRevision: 1,
          }],
          childIdempotencyKey: 'root-child-1',
        },
      };
      const staleInvocation: TurnDisposition = {
        ...invocation,
        route: invocation.kind === 'workflow_next' && invocation.route
          ? {
              ...invocation.route,
              entryBindings: invocation.route.entryBindings.map((binding) => ({
                ...binding,
                artifactRevision: 2,
              })),
            }
          : undefined,
      };
      await expect(opened.repository.execute({
        kind: 'stageDisposition',
        workspaceId: 'ws',
        turnId: rootTurn.id,
        opId: 'invoke-root-child-stale',
        turn: { ...rootTurn, disposition: staleInvocation },
        expectedStatuses: ['running'],
        expectedRuntimeEpoch: 1,
      })).resolves.toMatchObject({
        changed: false,
        reason: 'workflow disposition is not authorized for the current route',
      });
      await expect(opened.repository.execute({
        kind: 'stageDisposition',
        workspaceId: 'ws',
        turnId: rootTurn.id,
        opId: 'invoke-root-child',
        turn: { ...rootTurn, disposition: invocation },
        expectedStatuses: ['running'],
        expectedRuntimeEpoch: 1,
      })).resolves.toMatchObject({ changed: true });
      await expect(settleSucceeded(
        opened.repository,
        opened.client,
        root.id,
        rootTurn.id,
        invocation,
        '2026-07-20T00:00:01.000Z',
        createdAt,
      )).resolves.toMatchObject({ ok: true, changed: true });

      const childRun = await opened.client.get<{ run_id: string }>(
        `SELECT run_id FROM workflow_runs
          WHERE workspace_id = 'ws' AND origin = 'child' AND caller_task_id = ?`,
        [root.id],
      );
      expect(childRun?.run_id).toBeTruthy();
      const childEntry = await entryTaskForRun(opened.client, childRun!.run_id);
      expect(childEntry?.task_id).toBeTruthy();
      await expect(opened.repository.getTask(childEntry!.task_id)).resolves.toMatchObject({
        parentId: root.id,
      });

      const childTurn = await opened.client.get<{ id: string }>(
        `SELECT id FROM turns WHERE workspace_id = 'ws' AND task_id = ? AND status = 'queued'`,
        [childEntry!.task_id],
      );
      await expect(settleSucceeded(
        opened.repository,
        opened.client,
        childEntry!.task_id,
        childTurn!.id,
        { kind: 'workflow_next', change: 'updated', result: 'child result' },
        '2026-07-20T00:00:02.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });

      await expect(queuedTurnsForTask(opened.client, root.id)).resolves.toHaveLength(1);
      await expect(opened.client.get<{ status: string }>(
        `SELECT status FROM workflow_return_gates
          WHERE workspace_id = 'ws' AND child_run_id = ?`,
        [childRun!.run_id],
      )).resolves.toMatchObject({ status: 'satisfied' });
      await expect(opened.client.get<{ status: string; outcome: string }>(
        `SELECT status, outcome FROM workflow_continuations
          WHERE workspace_id = 'ws' AND child_run_id = ?`,
        [childRun!.run_id],
      )).resolves.toMatchObject({ status: 'resolved', outcome: 'succeeded' });

      const resumeTurns = await queuedTurnsForTask(opened.client, root.id);
      expect(resumeTurns).toHaveLength(1);
      await opened.repository.execute({
        kind: 'claimOperation', workspaceId: 'ws', ledgerKey: `${rootTurn.id}:retention-proof`,
        entry: { fingerprint: 'root-retention-proof', result: { ok: true } },
        createdAt: '2026-07-20T00:00:03.000Z',
      });
      const settledRoot = await opened.repository.getTask(root.id);
      await opened.repository.execute({
        kind: 'upsertTask', workspaceId: 'ws',
        task: {
          ...settledRoot!, lifecycle: 'succeeded', finishedAt: '2026-07-20T00:00:03.000Z',
          updatedAt: '2026-07-20T00:00:03.000Z', revision: settledRoot!.revision + 1,
        },
      });
      await opened.client.run(
        `UPDATE workflow_runs SET status = 'succeeded', updated_at = ?
          WHERE workspace_id = 'ws' AND run_id = 'root-source-run'`,
        ['2026-07-20T00:00:03.000Z'],
      );
      await expect(opened.repository.execute({
        kind: 'applyRetention', workspaceId: 'ws', taskId: root.id, keepLatestTurns: 0,
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(opened.repository.getTurn(rootTurn.id)).resolves.toBeDefined();
      await expect(opened.repository.getTurn(resumeTurns[0]!.id)).resolves.toBeDefined();
      await expect(opened.repository.getOperation(`${rootTurn.id}:retention-proof`)).resolves.toMatchObject({
        fingerprint: 'root-retention-proof',
      });
      await expect(opened.client.get<{ status: string }>(
        `SELECT status FROM workflow_return_gates
          WHERE workspace_id = 'ws' AND child_run_id = ?`,
        [childRun!.run_id],
      )).resolves.toMatchObject({ status: 'satisfied' });
    } finally {
      await opened.close();
    }
  });

  it('invoke_child_workflow atomically starts child + pending continuation; foreign binding creates zero child rows', async () => {
    const opened = await openRepo('invoke');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      await defineVersion(opened.repository, createdAt, 'wf-caller', 'caller');
      await defineVersion(opened.repository, createdAt, 'wf-child', 'child', 'engine_start');
      const caller = await startOneNode(
        opened.repository,
        createdAt,
        'wf-caller',
        's06-invoke-caller',
        'caller goal',
      );
      expect(caller.startArtifactId).toBeTruthy();

      // Foreign binding: artifact id not owned by the caller run → zero child rows.
      const foreign = await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        caller.activationTurnId,
        {
          kind: 'workflow_next',
          change: 'updated',
          route: {
            kind: 'child_workflow',
            childDefinitionId: 'wf-child',
            childDefinitionVersion: 1,
            entryBindings: [
              {
                childEntryNodeId: 'entry',
                inputRef: 'engine_start',
                artifactId: 'wfa_not_owned_by_caller',
                artifactRevision: 1,
              },
            ],
            childIdempotencyKey: 's06-foreign-1',
          },
        },
        '2026-07-20T00:00:01.000Z',
      );
      expect(foreign.ok).toBe(true);
      expect(await childRunsForParent(opened.client, caller.runId)).toHaveLength(0);
      expect(await continuationsForRun(opened.client, caller.runId)).toHaveLength(0);

      const staleTurnId = `${caller.activationTurnId}-stale`;
      await insertEngineTurn(
        opened.client,
        caller.entryTaskId,
        staleTurnId,
        'queued',
        '2026-07-20T00:00:02.000Z',
        await nextTurnSequence(opened.client, caller.entryTaskId),
      );
      await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        staleTurnId,
        {
          kind: 'workflow_next',
          change: 'updated',
          route: {
            kind: 'child_workflow',
            childDefinitionId: 'wf-child',
            childDefinitionVersion: 1,
            entryBindings: [{
              childEntryNodeId: 'entry',
              inputRef: 'engine_start',
              artifactId: caller.startArtifactId,
              artifactRevision: 2,
            }],
            childIdempotencyKey: 's06-stale-1',
          },
        },
        '2026-07-20T00:00:02.500Z',
      );
      expect(await childRunsForParent(opened.client, caller.runId)).toHaveLength(0);
      expect(await continuationsForRun(opened.client, caller.runId)).toHaveLength(0);

      // Successful invoke on a fresh turn after foreign and stale rejects.
      const okTurnId = `${caller.activationTurnId}-ok`;
      const okSeq = await nextTurnSequence(opened.client, caller.entryTaskId);
      await insertEngineTurn(
        opened.client,
        caller.entryTaskId,
        okTurnId,
        'queued',
        '2026-07-20T00:00:03.000Z',
        okSeq,
      );
      const ok = await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        okTurnId,
        {
          kind: 'workflow_next',
          change: 'updated',
          route: {
            kind: 'child_workflow',
            childDefinitionId: 'wf-child',
            childDefinitionVersion: 1,
            entryBindings: [
              {
                childEntryNodeId: 'entry',
                inputRef: 'engine_start',
                artifactId: caller.startArtifactId,
                artifactRevision: 1,
              },
            ],
            childIdempotencyKey: 's06-child-1',
          },
        },
        '2026-07-20T00:00:04.000Z',
      );
      expect(ok.ok).toBe(true);
      expect(ok.changed).toBe(true);

      const children = await childRunsForParent(opened.client, caller.runId);
      expect(children).toHaveLength(1);
      expect(children[0]!.origin).toBe('child');
      expect(children[0]!.parent_run_id).toBe(caller.runId);
      expect(children[0]!.definition_id).toBe('wf-child');
      // Child run is non-terminal after invoke (open or running once entry activates).
      expect(['open', 'running']).toContain(children[0]!.status);

      const conts = await continuationsForRun(opened.client, caller.runId);
      expect(conts).toHaveLength(1);
      expect(conts[0]!.status).toBe('pending');

      const callerKinds = await routedKinds(opened.client, caller.runId);
      expect(callerKinds).toContain('child_invocation');
      await expect(opened.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM workflow_dependency_gates dependency_gate
           JOIN workflow_return_gates return_gate
             ON return_gate.workspace_id = dependency_gate.workspace_id
            AND return_gate.return_gate_id = dependency_gate.gate_id
          WHERE dependency_gate.workspace_id = 'ws' AND dependency_gate.run_id = ?`,
        [caller.runId],
      )).resolves.toEqual({ count: 0 });

      // Caller lifecycle stays open (no seal on invoke).
      const callerTask = await opened.repository.getTask(caller.entryTaskId);
      expect(callerTask?.lifecycle).toBe('open');

      // Child entry activation exists (queued turn).
      const childEntry = await entryTaskForRun(opened.client, children[0]!.run_id);
      expect(childEntry?.task_id).toBeTruthy();
      const childQueued = await queuedTurnsForTask(opened.client, childEntry!.task_id);
      expect(childQueued.length).toBeGreaterThanOrEqual(1);
    } finally {
      await opened.close();
    }
  }, 45_000);

  it('fails the caller when an effective child policy cannot bound entry framing', async () => {
    const opened = await openRepo('entry-bound');
    try {
      const createdAt = '2026-07-22T08:00:00.000Z';
      const maxArtifactBytes = 64;
      const exactAggregateBytes = maximumWorkflowEntryAggregateBytes(
        [{ inputRef: 'engine_start' }],
        maxArtifactBytes,
      );
      const childPolicy = {
        ...DEFAULT_WORKFLOW_POLICY,
        maxArtifactBytes,
        maxAggregateBytes: exactAggregateBytes,
      };
      await defineVersion(opened.repository, createdAt, 'wf-entry-bound-caller', 'caller');
      await defineVersion(
        opened.repository,
        createdAt,
        'wf-entry-bound-child',
        'child',
        'engine_start',
        childPolicy,
      );
      const caller = await startOneNode(
        opened.repository,
        createdAt,
        'wf-entry-bound-caller',
        'entry-bound-caller',
        'entry bound',
      );

      await expect(settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        caller.activationTurnId,
        {
          kind: 'workflow_next',
          change: 'updated',
          route: {
            kind: 'child_workflow',
            childDefinitionId: 'wf-entry-bound-child',
            childDefinitionVersion: 1,
            entryBindings: [{
              childEntryNodeId: 'entry',
              inputRef: 'engine_start',
              artifactId: caller.startArtifactId,
              artifactRevision: 1,
            }],
            childIdempotencyKey: 'entry-bound-child',
            effectivePolicy: {
              ...childPolicy,
              maxAggregateBytes: exactAggregateBytes - 1,
            },
          },
        },
        '2026-07-22T08:01:00.000Z',
      )).resolves.toMatchObject({ changed: true });

      await expect(opened.client.get<{ status: string; terminal_reason_code: string | null }>(
        `SELECT status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = 'ws' AND run_id = ?`,
        [caller.runId],
      )).resolves.toEqual({ status: 'failed', terminal_reason_code: 'aggregate_too_large' });
      expect(await childRunsForParent(opened.client, caller.runId)).toHaveLength(0);
      expect(await continuationsForRun(opened.client, caller.runId)).toHaveLength(0);
    } finally {
      await opened.close();
    }
  }, 45_000);

  it('child terminal NEXT resolves continuation once and queues exactly one caller resume; redelivery is a no-op', async () => {
    const opened = await openRepo('return');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      await defineVersion(opened.repository, createdAt, 'wf-caller-r', 'caller-r');
      await defineVersion(opened.repository, createdAt, 'wf-child-r', 'child-r', 'engine_start');
      const caller = await startOneNode(
        opened.repository,
        createdAt,
        'wf-caller-r',
        's06-return-caller',
        'caller return goal',
      );

      const invoke = await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        caller.activationTurnId,
        {
          kind: 'workflow_next',
          change: 'updated',
          route: {
            kind: 'child_workflow',
            childDefinitionId: 'wf-child-r',
            childDefinitionVersion: 1,
            entryBindings: [
              {
                childEntryNodeId: 'entry',
                inputRef: 'engine_start',
                artifactId: caller.startArtifactId,
                artifactRevision: 1,
              },
            ],
            childIdempotencyKey: 's06-return-child',
          },
        },
        '2026-07-20T00:00:01.000Z',
      );
      expect(invoke.ok).toBe(true);

      const children = await childRunsForParent(opened.client, caller.runId);
      expect(children).toHaveLength(1);
      const childRunId = children[0]!.run_id;
      const childEntry = await entryTaskForRun(opened.client, childRunId);
      expect(childEntry?.task_id).toBeTruthy();
      const childQueued = await queuedTurnsForTask(opened.client, childEntry!.task_id);
      expect(childQueued.length).toBeGreaterThanOrEqual(1);
      const childTurnId = childQueued[0]!.id;

      // Terminal NEXT on the child (one-node entry is terminal) → single caller resume.
      const next = await settleSucceeded(
        opened.repository,
        opened.client,
        childEntry!.task_id,
        childTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'child-done' },
        '2026-07-20T00:00:02.000Z',
      );
      expect(next.ok).toBe(true);
      expect(next.changed).toBe(true);

      const conts = await continuationsForRun(opened.client, caller.runId);
      expect(conts).toHaveLength(1);
      expect(conts[0]!.status).toBe('resolved');

      const callerKinds = await routedKinds(opened.client, caller.runId);
      expect(callerKinds.filter((k) => k === 'child_return')).toHaveLength(1);

      const resumeTurns = await queuedTurnsForTask(opened.client, caller.entryTaskId);
      expect(resumeTurns).toHaveLength(1);
      const resumeTurnId = resumeTurns[0]!.id;

      // Child lifecycle remains open (return never seals child).
      const childTask = await opened.repository.getTask(childEntry!.task_id);
      expect(childTask?.lifecycle).toBe('open');
      const childRun = await runRow(opened.client, childRunId);
      expect(childRun?.status).toBe('succeeded');

      // Duplicate terminal delivery on a second turn: no second resume / return fence.
      const redTurnId = `${childTurnId}-redeliver`;
      const redSeq = await nextTurnSequence(opened.client, childEntry!.task_id);
      await insertEngineTurn(
        opened.client,
        childEntry!.task_id,
        redTurnId,
        'queued',
        '2026-07-20T00:00:03.000Z',
        redSeq,
      );
      const redeliver = await settleSucceeded(
        opened.repository,
        opened.client,
        childEntry!.task_id,
        redTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'child-done-again' },
        '2026-07-20T00:00:03.000Z',
      );
      expect(redeliver.ok).toBe(true);

      const conts2 = await continuationsForRun(opened.client, caller.runId);
      expect(conts2).toHaveLength(1);
      expect(conts2[0]!.status).toBe('resolved');
      expect(
        (await routedKinds(opened.client, caller.runId)).filter((k) => k === 'child_return'),
      ).toHaveLength(1);
      const resumeTurns2 = await queuedTurnsForTask(opened.client, caller.entryTaskId);
      expect(resumeTurns2).toHaveLength(1);
      expect(resumeTurns2[0]!.id).toBe(resumeTurnId);

      await expect(settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        resumeTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'caller-done' },
        '2026-07-20T00:00:04.000Z',
      )).resolves.toMatchObject({ changed: true });
      await expect(opened.client.get<{ continuation_status: string; return_gate_status: string }>(
        `SELECT continuation.status AS continuation_status,
                return_gate.status AS return_gate_status
           FROM workflow_continuations continuation
           JOIN workflow_return_gates return_gate
             ON return_gate.workspace_id = continuation.workspace_id
            AND return_gate.continuation_run_id = continuation.run_id
            AND return_gate.continuation_id = continuation.continuation_id
          WHERE continuation.workspace_id = 'ws' AND continuation.child_run_id = ?`,
        [childRunId],
      )).resolves.toEqual({
        continuation_status: 'consumed',
        return_gate_status: 'consumed',
      });
    } finally {
      await opened.close();
    }
  }, 45_000);

  it('child return aggregate accepts the exact byte limit and fails one byte over', async () => {
    const maxAggregateBytes = 262_144;
    const policy = {
      ...DEFAULT_WORKFLOW_POLICY,
      maxArtifactBytes: 131_072,
      maxAggregateBytes,
    };

    for (const overflow of [false, true]) {
      const opened = await openRepo(overflow ? 'return-overflow' : 'return-exact');
      try {
        const createdAt = '2026-07-22T09:00:00.000Z';
        const callerDefinition = overflow ? 'wf-caller-overflow' : 'wf-caller-exact';
        const childDefinition = overflow ? 'wf-child-overflow' : 'wf-child-exact';
        await defineVersion(opened.repository, createdAt, callerDefinition, 'caller', undefined, policy);
        await defineVersion(opened.repository, createdAt, childDefinition, 'child', 'engine_start', policy);
        const caller = await startOneNode(
          opened.repository,
          createdAt,
          callerDefinition,
          `return-boundary-caller-${overflow ? 'over' : 'exact'}`,
          'return boundary',
        );
        await expect(settleSucceeded(
          opened.repository,
          opened.client,
          caller.entryTaskId,
          caller.activationTurnId,
          {
            kind: 'workflow_next',
            change: 'updated',
            route: {
              kind: 'child_workflow',
              childDefinitionId: childDefinition,
              childDefinitionVersion: 1,
              entryBindings: [{
                childEntryNodeId: 'entry',
                inputRef: 'engine_start',
                artifactId: caller.startArtifactId,
                artifactRevision: 1,
              }],
              childIdempotencyKey: `return-boundary-child-${overflow ? 'over' : 'exact'}`,
            },
          },
          '2026-07-22T09:01:00.000Z',
        )).resolves.toMatchObject({ changed: true });
        const children = await childRunsForParent(opened.client, caller.runId);
        expect(children).toHaveLength(1);
        const childRunId = children[0]!.run_id;
        const childEntry = await entryTaskForRun(opened.client, childRunId);
        const childTurn = (await queuedTurnsForTask(opened.client, childEntry!.task_id))[0]!;
        const prefix = `[workflow-child-return] childRunId=${childRunId} change=updated\n`;
        const result = 'x'.repeat(
          maxAggregateBytes - Buffer.byteLength(prefix, 'utf8') + (overflow ? 1 : 0),
        );

        await expect(settleSucceeded(
          opened.repository,
          opened.client,
          childEntry!.task_id,
          childTurn.id,
          { kind: 'workflow_next', change: 'updated', result },
          '2026-07-22T09:02:00.000Z',
        )).resolves.toMatchObject({ changed: true });

        const childRun = await opened.client.get<{ status: string; terminal_reason_code: string | null }>(
          `SELECT status, terminal_reason_code FROM workflow_runs
            WHERE workspace_id = 'ws' AND run_id = ?`,
          [childRunId],
        );
        const continuation = await opened.client.get<{ status: string; reason_code: string | null }>(
          `SELECT status, reason_code FROM workflow_continuations
            WHERE workspace_id = 'ws' AND child_run_id = ?`,
          [childRunId],
        );
        const resumes = await queuedTurnsForTask(opened.client, caller.entryTaskId);

        if (overflow) {
          expect(childRun).toEqual({ status: 'failed', terminal_reason_code: 'aggregate_too_large' });
          expect(continuation).toEqual({ status: 'failed', reason_code: 'aggregate_too_large' });
          expect(resumes).toHaveLength(0);
        } else {
          expect(childRun).toEqual({ status: 'succeeded', terminal_reason_code: null });
          expect(continuation?.status).toBe('resolved');
          expect(resumes).toHaveLength(1);
          const message = (await opened.repository.listMessages(caller.entryTaskId)).find(
            (candidate) => candidate.turnId === resumes[0]!.id,
          );
          expect(Buffer.byteLength(message!.content, 'utf8')).toBe(maxAggregateBytes);
          expect(message!.content).toBe(prefix + result);
        }
      } finally {
        await opened.close();
      }
    }
  }, 45_000);

  it('reload after child return does not duplicate resume; child fail propagates continuation once', async () => {
    const opened = await openRepo('reload-fail');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      await defineVersion(opened.repository, createdAt, 'wf-caller-f', 'caller-f');
      await defineVersion(opened.repository, createdAt, 'wf-child-f', 'child-f', 'engine_start');
      const caller = await startOneNode(
        opened.repository,
        createdAt,
        'wf-caller-f',
        's06-fail-caller',
        'caller fail goal',
      );

      // --- happy return + reload no-op ---
      const invoke = await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        caller.activationTurnId,
        {
          kind: 'workflow_next',
          change: 'updated',
          route: {
            kind: 'child_workflow',
            childDefinitionId: 'wf-child-f',
            childDefinitionVersion: 1,
            entryBindings: [
              {
                childEntryNodeId: 'entry',
                inputRef: 'engine_start',
                artifactId: caller.startArtifactId,
                artifactRevision: 1,
              },
            ],
            childIdempotencyKey: 's06-fail-child-ok',
          },
        },
        '2026-07-20T00:00:01.000Z',
      );
      expect(invoke.ok).toBe(true);
      const children = await childRunsForParent(opened.client, caller.runId);
      expect(children).toHaveLength(1);
      const childRunId = children[0]!.run_id;
      const childEntry = await entryTaskForRun(opened.client, childRunId);
      const childQueued = await queuedTurnsForTask(opened.client, childEntry!.task_id);
      const childTurnId = childQueued[0]!.id;

      await settleSucceeded(
        opened.repository,
        opened.client,
        childEntry!.task_id,
        childTurnId,
        { kind: 'workflow_next', change: 'unchanged', result: 'ok' },
        '2026-07-20T00:00:02.000Z',
      );
      const resumeBefore = await queuedTurnsForTask(opened.client, caller.entryTaskId);
      expect(resumeBefore).toHaveLength(1);

      // Simulate extension reload: new repository on same DB, redeliver child NEXT.
      const reloaded = new SqliteTaskRepository(opened.client, 'ws');
      const redTurnId = `${childTurnId}-reload`;
      const redSeq = await nextTurnSequence(opened.client, childEntry!.task_id);
      await insertEngineTurn(
        opened.client,
        childEntry!.task_id,
        redTurnId,
        'queued',
        '2026-07-20T00:00:03.000Z',
        redSeq,
      );
      const reloadSettle = await settleSucceeded(
        reloaded,
        opened.client,
        childEntry!.task_id,
        redTurnId,
        { kind: 'workflow_next', change: 'unchanged', result: 'ok-reload' },
        '2026-07-20T00:00:03.000Z',
      );
      expect(reloadSettle.ok).toBe(true);
      const resumeAfter = await queuedTurnsForTask(opened.client, caller.entryTaskId);
      expect(resumeAfter).toHaveLength(1);
      expect(resumeAfter[0]!.id).toBe(resumeBefore[0]!.id);
      expect(
        (await continuationsForRun(opened.client, caller.runId)).map((c) => c.status),
      ).toEqual(['resolved']);

      // --- nested failure path on a second caller invoke ---
      await defineVersion(opened.repository, createdAt, 'wf-child-f2', 'child-f2', 'engine_start');
      // Second caller turn after first resume is still queued; use a new engine turn.
      const failCallerTurn = `${caller.activationTurnId}-fail-invoke`;
      const failSeq = await nextTurnSequence(opened.client, caller.entryTaskId);
      await insertEngineTurn(
        opened.client,
        caller.entryTaskId,
        failCallerTurn,
        'queued',
        '2026-07-20T00:00:04.000Z',
        failSeq,
      );
      // Consume the resume turn first so caller is free for a second invoke path:
      // settle resume as idle, then invoke again.
      const resumeSettle = await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        resumeBefore[0]!.id,
        { kind: 'idle' },
        '2026-07-20T00:00:04.500Z',
      );
      expect(resumeSettle.ok).toBe(true);

      const invoke2 = await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        failCallerTurn,
        {
          kind: 'workflow_next',
          change: 'updated',
          route: {
            kind: 'child_workflow',
            childDefinitionId: 'wf-child-f2',
            childDefinitionVersion: 1,
            entryBindings: [
              {
                childEntryNodeId: 'entry',
                inputRef: 'engine_start',
                artifactId: caller.startArtifactId,
                artifactRevision: 1,
              },
            ],
            childIdempotencyKey: 's06-fail-child-2',
          },
        },
        '2026-07-20T00:00:05.000Z',
      );
      expect(invoke2.ok).toBe(true);

      const children2 = await childRunsForParent(opened.client, caller.runId);
      expect(children2.length).toBeGreaterThanOrEqual(2);
      const failingChild = children2.find((c) => c.definition_id === 'wf-child-f2');
      expect(failingChild).toBeTruthy();
      const failEntry = await entryTaskForRun(opened.client, failingChild!.run_id);
      const failQueued = await queuedTurnsForTask(opened.client, failEntry!.task_id);
      expect(failQueued.length).toBeGreaterThanOrEqual(1);

      const failSettle = await settleSucceeded(
        opened.repository,
        opened.client,
        failEntry!.task_id,
        failQueued[0]!.id,
        { kind: 'workflow_fail', reason: 'child blew up' },
        '2026-07-20T00:00:06.000Z',
      );
      expect(failSettle.ok).toBe(true);
      expect(await runRow(opened.client, failingChild!.run_id)).toMatchObject({
        status: 'failed',
      });

      const contsAfterFail = await continuationsForRun(opened.client, caller.runId);
      const failedCont = contsAfterFail.find((c) => c.status === 'failed');
      expect(failedCont).toBeTruthy();

      const callerTask = await opened.repository.getTask(caller.entryTaskId);
      expect(callerTask?.lifecycle).toBe('open');
      expect(callerTask?.attention?.code).toBe('workflow_run_failed');
      expect(String(callerTask?.attention?.message ?? '')).toMatch(
        /agent_fail|child|failed/,
      );

      // Double-close child fail is a no-op for continuation status.
      const fail2Turn = `${failQueued[0]!.id}-again`;
      const fail2Seq = await nextTurnSequence(opened.client, failEntry!.task_id);
      await insertEngineTurn(
        opened.client,
        failEntry!.task_id,
        fail2Turn,
        'queued',
        '2026-07-20T00:00:07.000Z',
        fail2Seq,
      );
      const fail2 = await settleSucceeded(
        opened.repository,
        opened.client,
        failEntry!.task_id,
        fail2Turn,
        { kind: 'workflow_fail', reason: 'again' },
        '2026-07-20T00:00:07.000Z',
      );
      expect(fail2.ok).toBe(true);
      const failedConts = (await continuationsForRun(opened.client, caller.runId)).filter(
        (c) => c.status === 'failed',
      );
      expect(failedConts).toHaveLength(1);
    } finally {
      await opened.close();
    }
  }, 60_000);

  it('three-level child failure recursively closes every run and boundary once', async () => {
    const opened = await openRepo('recursive-fail');
    try {
      const chain = await startThreeLevelChain(opened, 'recursive-fail');
      await expect(settleSucceeded(
        opened.repository,
        opened.client,
        chain.taskIds[2],
        chain.turnIds[2],
        { kind: 'workflow_fail', reason: 'deep failure' },
        '2026-07-22T10:03:00.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });

      const runPlaceholders = chain.runIds.map(() => '?').join(',');
      const runs = await opened.client.all<{ status: string; terminal_reason_code: string }>(
        `SELECT status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id IN (${runPlaceholders}) ORDER BY run_id`,
        ['ws', ...chain.runIds],
      );
      expect(runs).toHaveLength(3);
      expect(runs.every((run) => run.status === 'failed' && run.terminal_reason_code === 'agent_fail')).toBe(true);

      const continuations = await opened.client.all<{
        status: string;
        outcome: string;
        reason_code: string;
        result_artifact_id: string | null;
      }>(
        `SELECT status, outcome, reason_code, result_artifact_id
           FROM workflow_continuations WHERE workspace_id = ? ORDER BY continuation_id`,
        ['ws'],
      );
      expect(continuations).toHaveLength(2);
      expect(continuations.every((continuation) =>
        continuation.status === 'failed'
        && continuation.outcome === 'failed'
        && continuation.reason_code === 'agent_fail'
        && continuation.result_artifact_id === null)).toBe(true);
      const returnGates = await opened.client.all<{ status: string; result_artifact_id: string | null }>(
        `SELECT status, result_artifact_id FROM workflow_return_gates
          WHERE workspace_id = ? ORDER BY return_gate_id`,
        ['ws'],
      );
      expect(returnGates).toHaveLength(2);
      expect(returnGates.every((gate) => gate.status === 'failed' && gate.result_artifact_id === null)).toBe(true);

      const activeWaits = await opened.client.get<{ count: number }>(
        `SELECT
           (SELECT COUNT(*) FROM workflow_dependency_gates
             WHERE workspace_id = ? AND run_id IN (${runPlaceholders}) AND status IN ('open','satisfied'))
           + (SELECT COUNT(*) FROM workflow_feedback_rounds
             WHERE workspace_id = ? AND run_id IN (${runPlaceholders}) AND status IN ('open','satisfied'))
           + (SELECT COUNT(*) FROM workflow_return_gates
             WHERE workspace_id = ? AND status IN ('open','satisfied')) AS count`,
        ['ws', ...chain.runIds, 'ws', ...chain.runIds, 'ws'],
      );
      expect(activeWaits?.count).toBe(0);
      const queued = await opened.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM turns
          WHERE workspace_id = ? AND task_id IN (?,?,?) AND status = 'queued'`,
        ['ws', ...chain.taskIds],
      );
      expect(queued?.count).toBe(0);

      const attention = await opened.client.all<{ id: string }>(
        `SELECT id FROM tasks
          WHERE workspace_id = ? AND id IN (?,?,?)
            AND json_extract(payload_json, '$.attention.code') = 'workflow_run_failed'`,
        ['ws', ...chain.taskIds],
      );
      expect(attention).toEqual([{ id: chain.taskIds[0] }]);
      for (const taskId of chain.taskIds) {
        await expect(opened.repository.getTask(taskId)).resolves.toMatchObject({ lifecycle: 'open' });
      }

      const reloaded = new SqliteTaskRepository(opened.client, 'ws');
      const lateTurnId = `${chain.turnIds[2]}-redelivery`;
      await insertEngineTurn(
        opened.client,
        chain.taskIds[2],
        lateTurnId,
        'queued',
        '2026-07-22T10:04:00.000Z',
        await nextTurnSequence(opened.client, chain.taskIds[2]),
      );
      await settleSucceeded(
        reloaded,
        opened.client,
        chain.taskIds[2],
        lateTurnId,
        { kind: 'workflow_fail', reason: 'duplicate deep failure' },
        '2026-07-22T10:04:00.000Z',
      );
      const afterReplay = await opened.client.all<{ status: string }>(
        `SELECT status FROM workflow_continuations WHERE workspace_id = ?`,
        ['ws'],
      );
      expect(afterReplay).toHaveLength(2);
      expect(afterReplay.every((continuation) => continuation.status === 'failed')).toBe(true);
    } finally {
      await opened.close();
    }
  }, 60_000);

  it('three-level child cancellation preserves lifecycle authority and typed cancellation', async () => {
    const opened = await openRepo('recursive-cancel');
    try {
      const chain = await startThreeLevelChain(opened, 'recursive-cancel');
      const at = '2026-07-22T11:03:00.000Z';
      const leafTask = await opened.repository.getTask(chain.taskIds[2]);
      const leafTurn = await opened.repository.getTurn(chain.turnIds[2]);
      expect(leafTask).toBeTruthy();
      expect(leafTurn).toBeTruthy();
      await expect(opened.repository.execute({
        kind: 'applyTaskLifecycle',
        workspaceId: 'ws',
        taskId: leafTask!.id,
        expectedTaskRevision: leafTask!.revision,
        task: {
          ...leafTask!,
          lifecycle: 'cancelled',
          revision: leafTask!.revision + 1,
          updatedAt: at,
        },
        turns: [{ ...leafTurn!, status: 'cancelled', finishedAt: at }],
        expectedTurns: [{ id: leafTurn!.id, status: 'queued' }],
      })).resolves.toMatchObject({ ok: true, changed: true });

      const runPlaceholders = chain.runIds.map(() => '?').join(',');
      const runs = await opened.client.all<{ status: string; terminal_reason_code: string }>(
        `SELECT status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id IN (${runPlaceholders})`,
        ['ws', ...chain.runIds],
      );
      expect(runs).toHaveLength(3);
      expect(runs.every((run) =>
        run.status === 'cancelled' && run.terminal_reason_code === 'required_target_cancelled')).toBe(true);
      const continuations = await opened.client.all<{
        status: string;
        outcome: string;
        reason_code: string;
        result_artifact_id: string | null;
      }>(
        `SELECT status, outcome, reason_code, result_artifact_id
          FROM workflow_continuations WHERE workspace_id = ?`,
        ['ws'],
      );
      expect(continuations).toHaveLength(2);
      expect(continuations.every((continuation) =>
        continuation.status === 'cancelled'
        && continuation.outcome === 'cancelled'
        && continuation.reason_code === 'required_target_cancelled'
        && continuation.result_artifact_id === null)).toBe(true);
      const returnGates = await opened.client.all<{ status: string }>(
        `SELECT status FROM workflow_return_gates WHERE workspace_id = ?`,
        ['ws'],
      );
      expect(returnGates).toHaveLength(2);
      expect(returnGates.every((gate) => gate.status === 'cancelled')).toBe(true);
      await expect(opened.repository.getTask(chain.taskIds[0])).resolves.toMatchObject({ lifecycle: 'open' });
      await expect(opened.repository.getTask(chain.taskIds[1])).resolves.toMatchObject({ lifecycle: 'open' });
      await expect(opened.repository.getTask(chain.taskIds[2])).resolves.toMatchObject({ lifecycle: 'cancelled' });

      const reloaded = new SqliteTaskRepository(opened.client, 'ws');
      await expect(reloaded.execute({
        kind: 'applyTaskLifecycle',
        workspaceId: 'ws',
        taskId: leafTask!.id,
        expectedTaskRevision: leafTask!.revision,
        task: {
          ...leafTask!,
          lifecycle: 'cancelled',
          revision: leafTask!.revision + 1,
          updatedAt: at,
        },
        turns: [],
        expectedTurns: [{ id: leafTurn!.id, status: 'queued' }],
      })).resolves.toMatchObject({ changed: false });
      await expect(opened.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_continuations WHERE workspace_id = ?`,
        ['ws'],
      )).resolves.toMatchObject({ count: 2 });
    } finally {
      await opened.close();
    }
  }, 60_000);
});
