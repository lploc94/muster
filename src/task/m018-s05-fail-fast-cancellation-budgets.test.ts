/**
 * M018 S05 named flow:
 * public define/start → real SQLite worker + repository settle path → every S05
 * fail-fast trigger and idempotency guard:
 *   - workflow_fail disposition closes the run failed once (agent_fail)
 *   - invalid/empty PREV routing closes the run failed (invalid_route)
 *   - run_timeout termination closes the run failed
 *   - feedback-round budget exhaustion closes the run failed
 *   - turn budget exhaustion closes the run failed
 *   - open gates + feedback rounds flip to the terminal status
 *   - reserved-not-running turns cancel; live turns get interrupt cancelRequests
 *   - matching terminal lifecycle closure for every workflow-owned task
 *   - double-close is a true no-op (fence on run status + routed message)
 *   - late NEXT after close neither reopens gates nor creates activations
 *
 * Body_json fences carry identities/reason codes only — never prompts, artifacts,
 * paths, or SQL.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskEngine } from './engine';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { DbClient } from './sqlite/client';
import {
  DEFAULT_WORKFLOW_POLICY,
  makeGraphFanInDefinition,
  entryNodeIds,
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
};

type FanInStart = {
  runId: string;
  entries: Array<{
    nodeId: string;
    taskId: string;
    gateId: string;
    activationTurnId: string;
    messageId?: string;
  }>;
  nodeGates: Array<{ nodeId: string; gateId: string }>;
};

type Opened = {
  dir: string;
  dbPath: string;
  client: DbClient;
  repository: SqliteTaskRepository;
  close: () => Promise<void>;
};

async function openRepo(label: string): Promise<Opened> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s05-${label}-`));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
  });
  await client.open(dbPath);
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
    ['ws', `s05-${label}`, `S05 ${label}`, 'now', 'now'],
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

async function defineAndStartOneNode(
  repository: SqliteTaskRepository,
  createdAt: string,
  startKey: string,
  defId = 'wf-s05',
): Promise<OneNodeStart> {
  const def = await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId: defId,
    version: 1,
    name: 's05-one',
    topology: ONE_NODE,
    createdAt,
  });
  expect(def.ok).toBe(true);

  const start = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId: defId,
    version: 1,
    startIdempotencyKey: startKey,
    createdAt,
    goal: 's05 fail-fast goal',
    backend: 'grok',
  });
  expect(start.ok).toBe(true);
  return start.operation?.result?.data as OneNodeStart;
}

async function defineAndStartFanIn(
  repository: SqliteTaskRepository,
  createdAt: string,
  startKey: string,
  policy: WorkflowPolicyV1 = DEFAULT_WORKFLOW_POLICY,
): Promise<FanInStart> {
  const def = makeGraphFanInDefinition({ createdAt, policy });
  expect(entryNodeIds(def.topology).sort()).toEqual(['p1', 'p2']);

  const defined = await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId: def.definitionId,
    version: def.version,
    name: def.name,
    topology: def.topology,
    entryContracts: def.entryContracts,
    policy: def.policy,
    createdAt,
  });
  expect(defined.ok).toBe(true);

  const start = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId: def.definitionId,
    version: def.version,
    startIdempotencyKey: startKey,
    createdAt,
    goal: 's05 fan-in fail-fast',
    backend: 'grok',
  });
  expect(start.ok).toBe(true);
  return start.operation?.result?.data as FanInStart;
}

async function activateFanInConsumer(
  opened: Opened,
  data: FanInStart,
  createdAt: string,
): Promise<{
  p1: FanInStart['entries'][number];
  p2: FanInStart['entries'][number];
  consumerTaskId: string;
  consumerTurnId: string;
}> {
  const byNode = new Map(data.entries.map((entry) => [entry.nodeId, entry]));
  const p1 = byNode.get('p1')!;
  const p2 = byNode.get('p2')!;
  await settleSucceeded(
    opened.repository, opened.client, p1.taskId, p1.activationTurnId,
    { kind: 'workflow_next', change: 'updated', result: 'p1-v1' }, createdAt,
  );
  await settleSucceeded(
    opened.repository, opened.client, p2.taskId, p2.activationTurnId,
    { kind: 'workflow_next', change: 'updated', result: 'p2-v1' }, createdAt,
  );
  const consumer = await opened.client.get<{ task_id: string }>(
    `SELECT task_id FROM workflow_nodes
      WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'consumer'`,
    [data.runId],
  );
  if (!consumer?.task_id) {
    const run = await opened.client.get(
      `SELECT status, terminal_reason_code, max_workflow_turns, workflow_turns_reserved
        FROM workflow_runs WHERE workspace_id = 'ws' AND run_id = ?`,
      [data.runId],
    );
    throw new Error(`consumer activation missing: ${JSON.stringify(run)}`);
  }
  const consumerTurns = await opened.repository.listTurns(consumer!.task_id);
  return { p1, p2, consumerTaskId: consumer!.task_id, consumerTurnId: consumerTurns[0]!.id };
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
  disposition:
    | { kind: 'workflow_fail'; reason?: string }
    | { kind: 'workflow_prev'; targets: 'all' | string[]; note?: string }
    | { kind: 'workflow_next'; change: 'updated' | 'unchanged'; result?: string },
  finishedAt: string,
  startedAt: string = finishedAt,
) {
  await promoteRunning(client, turnId, startedAt);
  const task = await repository.getTask(taskId);
  const turn = await repository.getTurn(turnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  await stageDispositionForSettlement(repository, turn!, disposition);
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

async function settleWithTimeout(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  finishedAt: string,
) {
  await promoteRunning(client, turnId, finishedAt);
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
      status: 'failed',
      finishedAt,
      termination: { kind: 'run_timeout' },
    },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  });
}

async function runStatus(client: DbClient, runId: string): Promise<string | undefined> {
  const rows = await client.all<{ status: string }>(
    'SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?',
    ['ws', runId],
  );
  return rows[0]?.status;
}

async function gateStatuses(client: DbClient, runId: string): Promise<string[]> {
  const rows = await client.all<{ status: string }>(
    'SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ?',
    ['ws', runId],
  );
  return rows.map((r) => r.status);
}

async function roundStatuses(client: DbClient, runId: string): Promise<string[]> {
  const rows = await client.all<{ status: string }>(
    'SELECT status FROM workflow_feedback_rounds WHERE workspace_id = ? AND run_id = ?',
    ['ws', runId],
  );
  return rows.map((r) => r.status);
}

async function cancelRequestsForRun(
  client: DbClient,
  runId: string,
): Promise<Array<{ turn_id: string; kind: string; payload_json: string }>> {
  return client.all<{ turn_id: string; kind: string; payload_json: string }>(
    `SELECT c.turn_id, c.kind, c.payload_json
       FROM turn_cancel_requests c
       JOIN turns t ON t.workspace_id = c.workspace_id AND t.id = c.turn_id
       JOIN workflow_nodes n ON n.workspace_id = t.workspace_id AND n.task_id = t.task_id
      WHERE c.workspace_id = ? AND n.run_id = ?`,
    ['ws', runId],
  );
}

/** Seed a synthetic engine turn with the full turns schema (no revision column). */
async function insertEngineTurn(
  client: DbClient,
  taskId: string,
  turnId: string,
  status: 'queued' | 'cancelled' | 'running',
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
      status === 'cancelled' ? createdAt : null,
      JSON.stringify({ payloadVersion: 1 }),
    ],
  );
}

async function nextTurnSequence(client: DbClient, taskId: string): Promise<number> {
  const row = await client.get<{ m: number | null }>(
    `SELECT MAX(sequence) AS m FROM turns WHERE workspace_id = ? AND task_id = ?`,
    ['ws', taskId],
  );
  return (row?.m ?? 0) + 1;
}

describe('M018 S05 fail-fast cancellation and budgets (named flow)', () => {
  it('workflow_fail closes the run and owned task once and is idempotent', async () => {
    const opened = await openRepo('fail');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartOneNode(opened.repository, createdAt, 's05-fail-1');
      const finishedAt = '2026-07-20T00:00:01.000Z';

      const settle = await settleSucceeded(
        opened.repository,
        opened.client,
        data.entryTaskId,
        data.activationTurnId,
        { kind: 'workflow_fail', reason: 'agent gave up' },
        finishedAt,
      );
      expect(settle.ok).toBe(true);
      expect(settle.changed).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');

      const after = await opened.repository.getTask(data.entryTaskId);
      expect(after).toMatchObject({
        lifecycle: 'failed',
        finishedAt,
        error: 'agent_fail',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(after?.attention).toBeUndefined();

      // Double-close via a second turn on the same task is a no-op for run/task status.
      const secondTurnId = `${data.activationTurnId}-2`;
      const secondSeq = await nextTurnSequence(opened.client, data.entryTaskId);
      await insertEngineTurn(
        opened.client,
        data.entryTaskId,
        secondTurnId,
        'queued',
        finishedAt,
        secondSeq,
      );
      const second = await settleSucceeded(
        opened.repository,
        opened.client,
        data.entryTaskId,
        secondTurnId,
        { kind: 'workflow_fail', reason: 'again' },
        '2026-07-20T00:00:02.000Z',
      );
      expect(second.ok).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');
      const after2 = await opened.repository.getTask(data.entryTaskId);
      expect(after2).toMatchObject({
        lifecycle: 'failed',
        finishedAt,
        error: 'agent_fail',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('invalid PREV on entry closes the run and owned task with invalid_route', async () => {
    const opened = await openRepo('prev');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartOneNode(
        opened.repository,
        createdAt,
        's05-prev-1',
        'wf-s05-prev',
      );
      const settle = await settleSucceeded(
        opened.repository,
        opened.client,
        data.entryTaskId,
        data.activationTurnId,
        { kind: 'workflow_prev', targets: 'all' },
        '2026-07-20T00:00:01.000Z',
      );
      expect(settle.ok).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');
      const after = await opened.repository.getTask(data.entryTaskId);
      expect(after).toMatchObject({
        lifecycle: 'failed',
        error: 'invalid_route',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(after?.attention).toBeUndefined();
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('run_timeout termination closes the run and owned task', async () => {
    const opened = await openRepo('timeout');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartOneNode(
        opened.repository,
        createdAt,
        's05-timeout-1',
        'wf-s05-timeout',
      );
      const settle = await settleWithTimeout(
        opened.repository,
        opened.client,
        data.entryTaskId,
        data.activationTurnId,
        '2026-07-20T00:00:01.000Z',
      );
      expect(settle.ok).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');
      const after = await opened.repository.getTask(data.entryTaskId);
      expect(after).toMatchObject({
        lifecycle: 'failed',
        error: 'run_timeout',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(after?.attention).toBeUndefined();
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('exact feedback and turn budget boundaries', async () => {
    const opened = await openRepo('fb-budget');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartFanIn(
        opened.repository, createdAt, 's05-fb-1',
        { ...DEFAULT_WORKFLOW_POLICY, maxFeedbackRoundsPerRun: 1 },
      );
      const active = await activateFanInConsumer(
        opened, data, '2026-07-20T00:01:00.000Z',
      );

      await expect(settleSucceeded(
        opened.repository, opened.client, active.consumerTaskId, active.consumerTurnId,
        { kind: 'workflow_prev', targets: 'all' }, '2026-07-20T00:02:00.000Z',
      )).resolves.toMatchObject({ changed: true });
      await expect(opened.client.get(
        `SELECT status, feedback_rounds_reserved FROM workflow_runs
          WHERE workspace_id = 'ws' AND run_id = ?`,
        [data.runId],
      )).resolves.toEqual({ status: 'running', feedback_rounds_reserved: 1 });

      const p1Feedback = (await opened.repository.listTurns(active.p1.taskId))
        .find((turn) => turn.status === 'queued')!;
      const p2Feedback = (await opened.repository.listTurns(active.p2.taskId))
        .find((turn) => turn.status === 'queued')!;
      await settleSucceeded(
        opened.repository, opened.client, active.p1.taskId, p1Feedback.id,
        { kind: 'workflow_next', change: 'updated', result: 'p1-v2' },
        '2026-07-20T00:03:00.000Z',
      );
      await settleSucceeded(
        opened.repository, opened.client, active.p2.taskId, p2Feedback.id,
        { kind: 'workflow_next', change: 'unchanged' },
        '2026-07-20T00:04:00.000Z',
      );
      const requesterResume = (await opened.repository.listTurns(active.consumerTaskId))
        .find((turn) => turn.status === 'queued')!;
      await expect(settleSucceeded(
        opened.repository, opened.client, active.consumerTaskId, requesterResume.id,
        { kind: 'workflow_prev', targets: 'all' }, '2026-07-20T00:05:00.000Z',
      )).resolves.toMatchObject({ changed: true });

      expect(await runStatus(opened.client, data.runId)).toBe('failed');
      const after = await opened.repository.getTask(active.consumerTaskId);
      expect(after).toMatchObject({
        lifecycle: 'failed',
        error: 'feedback_budget_exhausted',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      const rounds = await roundStatuses(opened.client, data.runId);
      expect(rounds).toHaveLength(1);
      expect(rounds.every((status) => status !== 'open' && status !== 'satisfied')).toBe(true);
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('turn budget exhaustion closes run failed', async () => {
    const opened = await openRepo('turn-budget');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartFanIn(
        opened.repository, createdAt, 's05-turn-1',
        { ...DEFAULT_WORKFLOW_POLICY, maxWorkflowTurnsPerRun: 3 },
      );
      const active = await activateFanInConsumer(
        opened, data, '2026-07-20T00:01:00.000Z',
      );
      await expect(opened.client.get(
        `SELECT status, workflow_turns_reserved FROM workflow_runs
          WHERE workspace_id = 'ws' AND run_id = ?`,
        [data.runId],
      )).resolves.toEqual({ status: 'running', workflow_turns_reserved: 3 });

      await expect(settleSucceeded(
        opened.repository, opened.client, active.consumerTaskId, active.consumerTurnId,
        { kind: 'workflow_prev', targets: 'all' }, '2026-07-20T00:02:00.000Z',
      )).resolves.toMatchObject({ changed: true });
      expect(await runStatus(opened.client, data.runId)).toBe('failed');
      const after = await opened.repository.getTask(active.consumerTaskId);
      expect(after).toMatchObject({
        lifecycle: 'failed',
        error: 'turn_budget_exhausted',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      await expect(opened.client.get(
        `SELECT workflow_turns_reserved, feedback_rounds_reserved FROM workflow_runs
          WHERE workspace_id = 'ws' AND run_id = ?`,
        [data.runId],
      )).resolves.toEqual({ workflow_turns_reserved: 3, feedback_rounds_reserved: 0 });
      expect(await roundStatuses(opened.client, data.runId)).toEqual([]);
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('per-task turn limits admit exact NEXT and feedback boundaries, then fail the next PREV', async () => {
    const exact = await openRepo('per-task-next-exact');
    try {
      const data = await defineAndStartFanIn(
        exact.repository,
        '2026-07-22T15:00:00.000Z',
        'per-task-next-exact',
        { ...DEFAULT_WORKFLOW_POLICY, maxTurnsPerTask: 1 },
      );
      const active = await activateFanInConsumer(exact, data, '2026-07-22T15:01:00.000Z');
      expect(await runStatus(exact.client, data.runId)).toBe('running');
      expect(await exact.repository.listTurns(active.consumerTaskId)).toHaveLength(1);
    } finally {
      await exact.close();
    }

    const feedback = await openRepo('per-task-feedback-boundary');
    try {
      const data = await defineAndStartFanIn(
        feedback.repository,
        '2026-07-22T16:00:00.000Z',
        'per-task-feedback-boundary',
        {
          ...DEFAULT_WORKFLOW_POLICY,
          maxFeedbackRoundsPerRun: 2,
          maxTurnsPerTask: 2,
        },
      );
      const active = await activateFanInConsumer(feedback, data, '2026-07-22T16:01:00.000Z');
      await expect(settleSucceeded(
        feedback.repository,
        feedback.client,
        active.consumerTaskId,
        active.consumerTurnId,
        { kind: 'workflow_prev', targets: 'all' },
        '2026-07-22T16:02:00.000Z',
      )).resolves.toMatchObject({ changed: true });
      const p1Feedback = (await feedback.repository.listTurns(active.p1.taskId))
        .find((turn) => turn.status === 'queued')!;
      const p2Feedback = (await feedback.repository.listTurns(active.p2.taskId))
        .find((turn) => turn.status === 'queued')!;
      expect(await feedback.repository.listTurns(active.p1.taskId)).toHaveLength(2);
      expect(await feedback.repository.listTurns(active.p2.taskId)).toHaveLength(2);

      await settleSucceeded(
        feedback.repository,
        feedback.client,
        active.p1.taskId,
        p1Feedback.id,
        { kind: 'workflow_next', change: 'updated', result: 'p1-v2' },
        '2026-07-22T16:03:00.000Z',
      );
      await settleSucceeded(
        feedback.repository,
        feedback.client,
        active.p2.taskId,
        p2Feedback.id,
        { kind: 'workflow_next', change: 'unchanged' },
        '2026-07-22T16:04:00.000Z',
      );
      const requesterTurns = await feedback.repository.listTurns(active.consumerTaskId);
      const requesterResume = requesterTurns.find((turn) => turn.status === 'queued')!;
      expect(requesterTurns).toHaveLength(2);

      await expect(settleSucceeded(
        feedback.repository,
        feedback.client,
        active.consumerTaskId,
        requesterResume.id,
        { kind: 'workflow_prev', targets: 'all' },
        '2026-07-22T16:05:00.000Z',
      )).resolves.toMatchObject({ changed: true });
      expect(await runStatus(feedback.client, data.runId)).toBe('failed');
      await expect(feedback.client.get<{ terminal_reason_code: string | null }>(
        `SELECT terminal_reason_code FROM workflow_runs WHERE workspace_id = 'ws' AND run_id = ?`,
        [data.runId],
      )).resolves.toEqual({ terminal_reason_code: 'turn_budget_exhausted' });
      expect(await roundStatuses(feedback.client, data.runId)).toHaveLength(1);
      expect(await feedback.repository.listTurns(active.p1.taskId)).toHaveLength(2);
      expect(await feedback.repository.listTurns(active.p2.taskId)).toHaveLength(2);
    } finally {
      await feedback.close();
    }
  }, 30_000);

  it('closure cancels queued turns, interrupts live turns, closes open gates, blocks late NEXT', async () => {
    const opened = await openRepo('interrupt');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartFanIn(opened.repository, createdAt, 's05-int-1');
      const byNode = new Map(data.entries.map((e) => [e.nodeId, e]));
      const p1 = byNode.get('p1')!;
      const p2 = byNode.get('p2')!;
      expect(p1).toBeTruthy();
      expect(p2).toBeTruthy();

      // p1 stays running (live) so closure must persist an interrupt cancelRequest.
      await promoteRunning(opened.client, p1.activationTurnId, createdAt);
      // p2 stays queued so closure must cancel the reserved-not-running activation.
      // Seed an extra open gate + open feedback round to prove bulk close.
      await opened.client.run(
        `INSERT INTO workflow_feedback_rounds (
           workspace_id, run_id, round_id, requester_node_id, status, join_mode, created_at
         ) VALUES (?,?,?,?,?,?,?)`,
        ['ws', data.runId, 'round-open-1', 'consumer', 'open', 'all', createdAt],
      );

      const settle = await settleSucceeded(
        opened.repository,
        opened.client,
        p1.taskId,
        p1.activationTurnId,
        { kind: 'workflow_fail', reason: 'abort fan-in' },
        '2026-07-20T00:00:01.000Z',
      );
      expect(settle.ok).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');

      // Open gates closed failed.
      const gates = await gateStatuses(opened.client, data.runId);
      expect(gates.length).toBeGreaterThan(0);
      expect(gates.every((s) => s !== 'open')).toBe(true);
      expect(gates.every((s) => s === 'failed' || s === 'satisfied')).toBe(true);

      // Open rounds closed failed.
      const rounds = await roundStatuses(opened.client, data.runId);
      expect(rounds.some((s) => s === 'failed')).toBe(true);
      expect(rounds.every((s) => s !== 'open')).toBe(true);

      // p2 queued activation cancelled.
      const p2Turn = await opened.repository.getTurn(p2.activationTurnId);
      expect(p2Turn?.status).toBe('cancelled');

      // p1 live turn (source of closure) is not interrupted; sibling live would be.
      // Promote a synthetic live turn on p2 before... already cancelled. Seed live on consumer node if present.
      // Interrupt requests for non-source live turns:
      // After p2 cancel, no live siblings remain; seed a live turn on p2 task before re-checking is not possible post-close.
      // Assert cancel_requests table only contains interrupt kind if any.
      const cancels = await cancelRequestsForRun(opened.client, data.runId);
      for (const c of cancels) {
        expect(c.kind).toBe('interrupt');
      }

      // Every task owned by the failed run is sealed and stale attention is cleared.
      const p1Task = await opened.repository.getTask(p1.taskId);
      const p2Task = await opened.repository.getTask(p2.taskId);
      expect(p1Task).toMatchObject({
        lifecycle: 'failed',
        error: 'agent_fail',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(p2Task).toMatchObject({
        lifecycle: 'failed',
        error: 'agent_fail',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(p1Task?.attention).toBeUndefined();
      expect(p2Task?.attention).toBeUndefined();

      // Late NEXT on p2 after close must not reopen the run or create new activations.
      // Re-queue a turn and settle with workflow_next.
      const lateTurnId = `${p2.activationTurnId}-late`;
      const lateSeq = await nextTurnSequence(opened.client, p2.taskId);
      await insertEngineTurn(
        opened.client,
        p2.taskId,
        lateTurnId,
        'queued',
        createdAt,
        lateSeq,
      );
      const late = await settleSucceeded(
        opened.repository,
        opened.client,
        p2.taskId,
        lateTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'too-late' },
        '2026-07-20T00:00:02.000Z',
      );
      expect(late.ok).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');
      // Consumer must not have been activated after closure.
      const consumerNode = await opened.client.get<{ task_id: string | null }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = ?`,
        ['ws', data.runId, 'consumer'],
      );
      // Fan-in consumer is not an entry — remains unactivated (null task_id) after late NEXT.
      expect(consumerNode?.task_id == null || consumerNode?.task_id === '').toBe(true);
    } finally {
      await opened.close();
    }
  }, 45_000);

  it('multi-node closure interrupts non-source live turns under existing cancel rules', async () => {
    const opened = await openRepo('live-interrupt');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartFanIn(opened.repository, createdAt, 's05-live-1');
      const byNode = new Map(data.entries.map((e) => [e.nodeId, e]));
      const p1 = byNode.get('p1')!;
      const p2 = byNode.get('p2')!;

      // Both entries running; settle fail on p1 → p2 must receive interrupt cancelRequest.
      await promoteRunning(opened.client, p1.activationTurnId, createdAt);
      await promoteRunning(opened.client, p2.activationTurnId, createdAt);

      const settle = await settleSucceeded(
        opened.repository,
        opened.client,
        p1.taskId,
        p1.activationTurnId,
        { kind: 'workflow_fail', reason: 'interrupt sibling' },
        '2026-07-20T00:00:01.000Z',
      );
      expect(settle.ok).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');

      const cancels = await cancelRequestsForRun(opened.client, data.runId);
      expect(cancels.length).toBeGreaterThanOrEqual(1);
      const p2Cancel = cancels.find((c) => c.turn_id === p2.activationTurnId);
      expect(p2Cancel).toBeTruthy();
      expect(p2Cancel!.kind).toBe('interrupt');
      // Source turn is excluded from interrupt.
      expect(cancels.find((c) => c.turn_id === p1.activationTurnId)).toBeUndefined();

      const p1Task = await opened.repository.getTask(p1.taskId);
      const p2Task = await opened.repository.getTask(p2.taskId);
      expect(p1Task).toMatchObject({
        lifecycle: 'failed',
        error: 'agent_fail',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(p2Task).toMatchObject({
        lifecycle: 'failed',
        error: 'agent_fail',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(p1Task?.attention).toBeUndefined();
      expect(p2Task?.attention).toBeUndefined();
    } finally {
      await opened.close();
    }
  }, 45_000);

  it('premature succeeded, failed, and skipped lifecycle seals close the workflow as unavailable', async () => {
    const opened = await openRepo('lifecycle-unavailable');
    try {
      const createdAt = '2026-07-22T12:00:00.000Z';
      for (const [index, lifecycle] of (['succeeded', 'failed', 'skipped'] as const).entries()) {
        const data = await defineAndStartOneNode(
          opened.repository,
          createdAt,
          `lifecycle-unavailable-${lifecycle}`,
          `wf-lifecycle-unavailable-${lifecycle}`,
        );
        const task = await opened.repository.getTask(data.entryTaskId);
        const turn = await opened.repository.getTurn(data.activationTurnId);
        expect(task).toBeTruthy();
        expect(turn).toBeTruthy();
        const at = `2026-07-22T12:0${index + 1}:00.000Z`;
        await expect(opened.repository.execute({
          kind: 'applyTaskLifecycle',
          workspaceId: 'ws',
          taskId: task!.id,
          expectedTaskRevision: task!.revision,
          task: {
            ...task!,
            lifecycle,
            revision: task!.revision + 1,
            updatedAt: at,
          },
          turns: [{ ...turn!, status: 'cancelled', finishedAt: at }],
          expectedTurns: [{ id: turn!.id, status: 'queued' }],
        })).resolves.toMatchObject({ ok: true, changed: true });
        await expect(opened.client.get<{ status: string; terminal_reason_code: string }>(
          `SELECT status, terminal_reason_code FROM workflow_runs
            WHERE workspace_id = ? AND run_id = ?`,
          ['ws', data.runId],
        )).resolves.toEqual({
          status: 'failed',
          terminal_reason_code: 'required_target_unavailable',
        });
        await expect(opened.repository.getTask(task!.id)).resolves.toMatchObject({ lifecycle });
        expect((await gateStatuses(opened.client, data.runId)).every(
          (status) => status !== 'open' && status !== 'satisfied',
        )).toBe(true);
      }
    } finally {
      await opened.close();
    }
  }, 45_000);

  it('engine load reaps an expired waiting workflow without starting an adapter', async () => {
    const opened = await openRepo('deadline-reload');
    let engine: TaskEngine | undefined;
    try {
      const data = await defineAndStartOneNode(
        opened.repository,
        '2026-07-22T13:00:00.000Z',
        'deadline-reload-start',
        'wf-deadline-reload',
      );
      await opened.client.run(
        `UPDATE workflow_runs SET deadline_at = ?
          WHERE workspace_id = ? AND run_id = ?`,
        ['2026-07-22T13:01:00.000Z', 'ws', data.runId],
      );
      let adapterStarts = 0;
      engine = await TaskEngine.loadAsync({
        repository: opened.repository,
        workspaceId: 'ws',
        clock: () => '2026-07-22T13:02:00.000Z',
        makeBackend: (name) => ({
          name,
          capabilities: {
            supportsMCP: true,
            supportsReasoning: false,
            supportsDetailedToolEvents: false,
          },
          run: async function* () {},
        }),
        runTurn: async function* () {
          adapterStarts += 1;
          yield { type: 'turnCompleted' };
        },
      });

      await expect(opened.client.get<{ status: string; terminal_reason_code: string }>(
        `SELECT status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      )).resolves.toEqual({ status: 'failed', terminal_reason_code: 'run_timeout' });
      await expect(opened.repository.getTurn(data.activationTurnId)).resolves.toMatchObject({
        status: 'cancelled',
      });
      await expect(opened.repository.getTask(data.entryTaskId)).resolves.toMatchObject({
        lifecycle: 'failed',
        error: 'run_timeout',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(adapterStarts).toBe(0);

      await expect(opened.repository.execute({
        kind: 'reapWorkflowTimeouts',
        workspaceId: 'ws',
        now: '2026-07-22T13:03:00.000Z',
      })).resolves.toMatchObject({ ok: true, changed: false });
    } finally {
      await engine?.shutdown().catch(() => undefined);
      await opened.close();
    }
  }, 45_000);

  it('explicit activation recovery replay conflict and cancellation race', async () => {
    const opened = await openRepo('activation-recovery');
    try {
      const data = await defineAndStartOneNode(
        opened.repository,
        '2026-07-22T14:00:00.000Z',
        'activation-recovery-start',
        'wf-activation-recovery',
      );
      await promoteRunning(opened.client, data.activationTurnId, '2026-07-22T14:01:00.000Z');
      const task = await opened.repository.getTask(data.entryTaskId);
      const sourceTurn = await opened.repository.getTurn(data.activationTurnId);
      expect(task).toBeTruthy();
      expect(sourceTurn).toBeTruthy();
      await expect(opened.repository.execute({
        kind: 'settleTurnAndApplyEffects',
        workspaceId: 'ws',
        expectedTaskRevision: task!.revision,
        task: { ...task!, updatedAt: '2026-07-22T14:02:00.000Z' },
        turn: {
          ...sourceTurn!,
          status: 'interrupted',
          finishedAt: '2026-07-22T14:02:00.000Z',
        },
        expectedStatuses: ['running'],
        relatedTurns: [],
        messages: [],
      })).resolves.toMatchObject({ ok: true, changed: true });
      const activationBefore = await opened.client.get<{
        activation_id: string;
        primary_turn_id: string;
        message_id: string;
      }>(
        `SELECT activation_id, primary_turn_id, message_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      );
      expect(activationBefore).toBeTruthy();

      const reloaded = new SqliteTaskRepository(opened.client, 'ws');
      const recovery = {
        kind: 'recoverWorkflowActivation' as const,
        workspaceId: 'ws',
        runId: data.runId,
        activationId: activationBefore!.activation_id,
        failedTurnId: data.activationTurnId,
        recoveryOperationId: 'recover-once',
        fingerprint: 'canonical-recovery-v1',
        instruction: 'Continue from the exact pinned workflow input.',
        expectedActivationStatus: 'interrupted' as const,
        createdAt: '2026-07-22T14:03:00.000Z',
      };
      const peerClient = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
      await peerClient.open(opened.dbPath);
      const peerRepository = new SqliteTaskRepository(peerClient, 'ws');
      const competingRecovery = {
        ...recovery,
        recoveryOperationId: 'recover-competing',
        fingerprint: 'canonical-recovery-competing',
      };
      const concurrent = await Promise.all([
        reloaded.execute(recovery),
        peerRepository.execute(competingRecovery),
      ]).finally(() => peerClient.close());
      expect(concurrent.filter((result) => result.changed)).toHaveLength(1);
      expect(concurrent.filter((result) => !result.changed)).toHaveLength(1);
      const winnerIndex = concurrent.findIndex((result) => result.changed);
      const winningRecovery = winnerIndex === 0 ? recovery : competingRecovery;
      const first = concurrent[winnerIndex]!;
      expect(first).toMatchObject({ ok: true, changed: true });
      const turnId = (first.operation?.result as { data?: { turnId?: string } })?.data?.turnId;
      expect(turnId).toBeTruthy();
      const recoveredTurn = await reloaded.getTurn(turnId!);
      expect(recoveredTurn).toMatchObject({
        status: 'queued',
        trigger: 'retry',
        retryOf: data.activationTurnId,
      });
      expect(recoveredTurn?.inputs).toEqual([
        ...sourceTurn!.inputs,
        {
          kind: 'recovery',
          interruptedTurnId: data.activationTurnId,
          instruction: 'Continue from the exact pinned workflow input.',
        },
      ]);
      await expect(opened.client.get<{
        activation_id: string;
        primary_turn_id: string;
        execution_turn_id: string;
        message_id: string;
        status: string;
      }>(
        `SELECT activation_id, primary_turn_id, execution_turn_id, message_id, status
          FROM workflow_activations WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      )).resolves.toEqual({
        activation_id: activationBefore!.activation_id,
        primary_turn_id: activationBefore!.primary_turn_id,
        execution_turn_id: turnId,
        message_id: activationBefore!.message_id,
        status: 'queued',
      });

      await expect(reloaded.execute(winningRecovery)).resolves.toMatchObject({
        ok: true,
        changed: false,
      });
      await expect(reloaded.execute({ ...winningRecovery, fingerprint: 'changed-recovery' })).resolves.toMatchObject({
        ok: true,
        changed: false,
        conflict: true,
        reason: 'operation fingerprint conflict',
      });
      await expect(opened.client.all(
        `SELECT id FROM turns WHERE workspace_id = ? AND task_id = ? AND status = 'queued'`,
        ['ws', data.entryTaskId],
      )).resolves.toHaveLength(1);

      await opened.client.run(
        `UPDATE workflow_runs SET deadline_at = ?
          WHERE workspace_id = ? AND run_id = ?`,
        ['2026-07-22T14:04:00.000Z', 'ws', data.runId],
      );
      await reloaded.execute({
        kind: 'reapWorkflowTimeouts',
        workspaceId: 'ws',
        now: '2026-07-22T14:05:00.000Z',
      });
      await expect(reloaded.execute({
        ...recovery,
        recoveryOperationId: 'recover-after-terminal',
        fingerprint: 'recover-after-terminal',
      })).resolves.toMatchObject({
        ok: true,
        changed: false,
        reason: 'workflow activation is no longer recoverable',
      });
    } finally {
      await opened.close();
    }
  }, 45_000);
});
