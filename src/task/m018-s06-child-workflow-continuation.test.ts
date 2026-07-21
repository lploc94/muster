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
import type { TurnDisposition } from './types';

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
): Promise<void> {
  const def = await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    name,
    topology: ONE_NODE,
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

describe('M018 S06 child-workflow continuation (named flow)', () => {
  it('invoke_child_workflow atomically starts child + pending continuation; foreign binding creates zero child rows', async () => {
    const opened = await openRepo('invoke');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      await defineVersion(opened.repository, createdAt, 'wf-caller', 'caller');
      await defineVersion(opened.repository, createdAt, 'wf-child', 'child');
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
          kind: 'invoke_child_workflow',
          childDefinitionId: 'wf-child',
          childDefinitionVersion: 1,
          entryBindings: [
            { inputRef: 'engine_start', artifactId: 'wfa_not_owned_by_caller' },
          ],
          childIdempotencyKey: 's06-foreign-1',
        },
        '2026-07-20T00:00:01.000Z',
      );
      expect(foreign.ok).toBe(true);
      expect(await childRunsForParent(opened.client, caller.runId)).toHaveLength(0);
      expect(await continuationsForRun(opened.client, caller.runId)).toHaveLength(0);

      // Successful invoke on a fresh turn after foreign reject.
      const okTurnId = `${caller.activationTurnId}-ok`;
      const okSeq = await nextTurnSequence(opened.client, caller.entryTaskId);
      await insertEngineTurn(
        opened.client,
        caller.entryTaskId,
        okTurnId,
        'queued',
        '2026-07-20T00:00:02.000Z',
        okSeq,
      );
      const ok = await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        okTurnId,
        {
          kind: 'invoke_child_workflow',
          childDefinitionId: 'wf-child',
          childDefinitionVersion: 1,
          entryBindings: [
            { inputRef: 'engine_start', artifactId: caller.startArtifactId },
          ],
          childIdempotencyKey: 's06-child-1',
        },
        '2026-07-20T00:00:03.000Z',
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

  it('child terminal NEXT resolves continuation once and queues exactly one caller resume; redelivery is a no-op', async () => {
    const opened = await openRepo('return');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      await defineVersion(opened.repository, createdAt, 'wf-caller-r', 'caller-r');
      await defineVersion(opened.repository, createdAt, 'wf-child-r', 'child-r');
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
          kind: 'invoke_child_workflow',
          childDefinitionId: 'wf-child-r',
          childDefinitionVersion: 1,
          entryBindings: [
            { inputRef: 'engine_start', artifactId: caller.startArtifactId },
          ],
          childIdempotencyKey: 's06-return-child',
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
    } finally {
      await opened.close();
    }
  }, 45_000);

  it('reload after child return does not duplicate resume; child fail propagates continuation once', async () => {
    const opened = await openRepo('reload-fail');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      await defineVersion(opened.repository, createdAt, 'wf-caller-f', 'caller-f');
      await defineVersion(opened.repository, createdAt, 'wf-child-f', 'child-f');
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
          kind: 'invoke_child_workflow',
          childDefinitionId: 'wf-child-f',
          childDefinitionVersion: 1,
          entryBindings: [
            { inputRef: 'engine_start', artifactId: caller.startArtifactId },
          ],
          childIdempotencyKey: 's06-fail-child-ok',
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
      await defineVersion(opened.repository, createdAt, 'wf-child-f2', 'child-f2');
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
          kind: 'invoke_child_workflow',
          childDefinitionId: 'wf-child-f2',
          childDefinitionVersion: 1,
          entryBindings: [
            { inputRef: 'engine_start', artifactId: caller.startArtifactId },
          ],
          childIdempotencyKey: 's06-fail-child-2',
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
});
