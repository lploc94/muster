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
 *   - one durable workflow_run_failed attention at the outer workflow boundary
 *   - task lifecycle stays open (unsealed)
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
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import {
  WORKFLOW_RUN_BUDGET_BOUNDS,
  clampWorkflowRunBudgets,
  makeGraphFanInDefinition,
  entryNodeIds,
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
): Promise<FanInStart> {
  const def = makeGraphFanInDefinition({ createdAt });
  expect(entryNodeIds(def.topology).sort()).toEqual(['p1', 'p2']);

  const defined = await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId: def.definitionId,
    version: def.version,
    name: def.name,
    topology: def.topology,
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
  it('workflow_fail closes run once, sets attention, leaves lifecycle open, is idempotent', async () => {
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
      expect(after?.lifecycle).toBe('open');
      expect(after?.attention?.code).toBe('workflow_run_failed');
      expect(String(after?.attention?.message ?? '')).toMatch(/agent_fail/);

      // Double-close via a second turn on the same open task is a no-op for run status.
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
      expect(after2?.lifecycle).toBe('open');
      expect(after2?.attention?.code).toBe('workflow_run_failed');
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('invalid PREV on entry closes run failed with invalid_route attention', async () => {
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
      expect(after?.lifecycle).toBe('open');
      expect(after?.attention?.code).toBe('workflow_run_failed');
      expect(String(after?.attention?.message ?? '')).toMatch(/invalid_route/);
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('run_timeout termination closes run failed with run_timeout attention', async () => {
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
      expect(after?.lifecycle).toBe('open');
      expect(after?.attention?.code).toBe('workflow_run_failed');
      expect(String(after?.attention?.message ?? '')).toMatch(/run_timeout/);
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('feedback-round budget exhaustion closes run failed', async () => {
    const opened = await openRepo('fb-budget');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartOneNode(
        opened.repository,
        createdAt,
        's05-fb-1',
        'wf-s05-fb',
      );
      const budgets = clampWorkflowRunBudgets();
      expect(budgets.maxFeedbackRoundsPerRun).toBe(
        WORKFLOW_RUN_BUDGET_BOUNDS.defaultMaxFeedbackRoundsPerRun,
      );

      // Seed more rounds than the host-clamped default bound with only the latest live.
      for (let i = 0; i <= budgets.maxFeedbackRoundsPerRun; i += 1) {
        await opened.client.run(
          `INSERT INTO workflow_feedback_rounds (
             workspace_id, run_id, round_id, requester_node_id, status, join_mode, created_at
           ) VALUES (?,?,?,?,?,?,?)`,
          [
            'ws',
            data.runId,
            `round-seed-${i}`,
            'entry',
            i === budgets.maxFeedbackRoundsPerRun ? 'open' : 'consumed',
            'all',
            createdAt,
          ],
        );
      }

      const settle = await settleSucceeded(
        opened.repository,
        opened.client,
        data.entryTaskId,
        data.activationTurnId,
        { kind: 'workflow_next', change: 'unchanged' },
        '2026-07-20T00:00:01.000Z',
      );
      expect(settle.ok).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');
      const after = await opened.repository.getTask(data.entryTaskId);
      expect(after?.lifecycle).toBe('open');
      expect(after?.attention?.code).toBe('workflow_run_failed');
      expect(String(after?.attention?.message ?? '')).toMatch(/feedback_budget_exhausted/);
      const rounds = await roundStatuses(opened.client, data.runId);
      expect(rounds.length).toBeGreaterThan(0);
      expect(rounds.every((s) =>
        s === 'failed' || s === 'open' || s === 'satisfied' || s === 'consumed')).toBe(true);
      // All previously open rounds must be closed failed by the atomic closure.
      const openLeft = rounds.filter((s) => s === 'open');
      expect(openLeft).toHaveLength(0);
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('turn budget exhaustion closes run failed', async () => {
    const opened = await openRepo('turn-budget');
    try {
      const createdAt = '2026-07-20T00:00:00.000Z';
      const data = await defineAndStartOneNode(
        opened.repository,
        createdAt,
        's05-turn-1',
        'wf-s05-turn',
      );
      const budgets = clampWorkflowRunBudgets();

      // Seed engine-triggered turns past the host-clamped default bound.
      // Activation turn already exists; add enough to exceed the bound.
      const existing = await opened.client.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM turns
          WHERE workspace_id = ? AND task_id = ? AND trigger = 'engine'`,
        ['ws', data.entryTaskId],
      );
      const need = budgets.maxWorkflowTurnsPerRun + 1 - (existing?.c ?? 0);
      let seq = await nextTurnSequence(opened.client, data.entryTaskId);
      for (let i = 0; i < need; i += 1) {
        await insertEngineTurn(
          opened.client,
          data.entryTaskId,
          `seed-turn-${i}`,
          'cancelled',
          createdAt,
          seq + i,
        );
      }

      const settle = await settleSucceeded(
        opened.repository,
        opened.client,
        data.entryTaskId,
        data.activationTurnId,
        { kind: 'workflow_next', change: 'unchanged' },
        '2026-07-20T00:00:01.000Z',
      );
      expect(settle.ok).toBe(true);
      expect(await runStatus(opened.client, data.runId)).toBe('failed');
      const after = await opened.repository.getTask(data.entryTaskId);
      expect(after?.lifecycle).toBe('open');
      expect(after?.attention?.code).toBe('workflow_run_failed');
      expect(String(after?.attention?.message ?? '')).toMatch(/turn_budget_exhausted/);
    } finally {
      await opened.close();
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

      // Exactly one outer-boundary task carries attention; workflow closure seals none.
      const p1Task = await opened.repository.getTask(p1.taskId);
      const p2Task = await opened.repository.getTask(p2.taskId);
      expect(p1Task?.lifecycle).toBe('open');
      expect(p2Task?.lifecycle).toBe('open');
      expect(p1Task?.attention?.code).toBe('workflow_run_failed');
      expect(String(p1Task?.attention?.message ?? '')).toMatch(/agent_fail/);
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
      expect(p1Task?.lifecycle).toBe('open');
      expect(p2Task?.lifecycle).toBe('open');
      expect(p1Task?.attention?.code).toBe('workflow_run_failed');
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
});
