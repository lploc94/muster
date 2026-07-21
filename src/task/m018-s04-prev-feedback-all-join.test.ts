/**
 * M018 S04 named flow:
 * two-producer fan-in graph_v1 → public define/start → producer NEXT settlements
 * → consumer PREV all opens one feedback round + one FIFO feedback turn per producer
 * → partial response leaves round open with no resume
 * → final response atomically satisfies the round and queues one ordered aggregate
 *   resume turn using frozen dependency declaration order (from_p1 then from_p2)
 * → redelivery after operations-ledger prune is a true no-op
 * → full extension reload between partial and final responses does not duplicate
 *   or lose the join
 *
 * Uses real SQLite worker + repository settle path + public define surface.
 * Body_json fences carry identities only — never note/result bodies, SQL, paths,
 * or credentials.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CredentialRegistry } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import {
  deriveFeedbackRequestMessageId,
  deriveFeedbackResponseMessageId,
  deriveFeedbackResumeMessageId,
  deriveFeedbackResumeTurnId,
  deriveFeedbackRoundId,
  deriveFeedbackTargetMessageId,
  deriveFeedbackTargetTurnId,
  deriveProducerArtifactId,
  entryNodeIds,
  makeGraphFanInDefinition,
} from './workflow';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

const FAN_IN_TOPOLOGY = {
  kind: 'graph_v1' as const,
  nodes: [{ nodeId: 'p1' }, { nodeId: 'p2' }, { nodeId: 'consumer' }],
  edges: [
    { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'from_p1' },
    { fromNodeId: 'p2', toNodeId: 'consumer', inputRef: 'from_p2' },
  ],
};

type StartPayload = {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s04-${label}-`));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
  });
  await client.open(dbPath);
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

async function reopenDb(dbPath: string): Promise<{
  client: DbClient;
  repository: SqliteTaskRepository;
  close: () => Promise<void>;
}> {
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
  });
  await client.open(dbPath);
  const repository = new SqliteTaskRepository(client, 'ws');
  return {
    client,
    repository,
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

type PrevDisposition =
  | { kind: 'workflow_next'; change: 'updated' | 'unchanged'; result?: string }
  | { kind: 'workflow_prev'; targets: 'all' | string[]; note?: string };

async function settleSucceeded(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  disposition: PrevDisposition,
  finishedAt: string,
  startedAt: string = finishedAt,
) {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL WHERE workspace_id = ? AND id = ?`,
    [startedAt, 'ws', turnId],
  );
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

async function defineAndStartFanIn(
  repository: SqliteTaskRepository,
  createdAt: string,
  startKey: string,
): Promise<StartPayload> {
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
    goal: 's04 prev all-join goal',
    backend: 'grok',
  });
  expect(start.ok).toBe(true);
  return start.operation?.result?.data as StartPayload;
}

async function activateConsumer(
  repository: SqliteTaskRepository,
  client: DbClient,
  data: StartPayload,
): Promise<{
  p1: StartPayload['entries'][number];
  p2: StartPayload['entries'][number];
  consumerTaskId: string;
  consumerActivationTurnId: string;
}> {
  const byNode = new Map(data.entries.map((e) => [e.nodeId, e]));
  const p1 = byNode.get('p1')!;
  const p2 = byNode.get('p2')!;
  expect(p1).toBeTruthy();
  expect(p2).toBeTruthy();

  expect(
    (
      await settleSucceeded(
        repository,
        client,
        p1.taskId,
        p1.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'p1-v1' },
        '2026-07-19T00:01:00.000Z',
      )
    ).changed,
  ).toBe(true);
  expect(
    (
      await settleSucceeded(
        repository,
        client,
        p2.taskId,
        p2.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'p2-v1' },
        '2026-07-19T00:02:00.000Z',
      )
    ).changed,
  ).toBe(true);

  const consumerNode = await client.get(
    'SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
    ['ws', data.runId, 'consumer'],
  );
  const consumerTaskId = consumerNode!.task_id as string;
  const consumerTurns = await repository.listTurns(consumerTaskId);
  expect(consumerTurns).toHaveLength(1);
  return {
    p1,
    p2,
    consumerTaskId,
    consumerActivationTurnId: consumerTurns[0]!.id,
  };
}

describe('M018 S04 PREV feedback ALL-join', () => {
  it('public define accepts graph_v1 fan-in and MCP workflow_prev rejects empty targets', () => {
    const credentials = new CredentialRegistry();
    const token = credentials.issue({
      rootId: 'root',
      callerTaskId: 'root',
      turnId: 'turn-1',
      attemptId: 'att-1',
      allowedActions: new Set(['define_workflow', 'workflow_prev']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;

    const ok = dispatch(
      'define_workflow',
      {
        opId: 'def-s04-fan-1',
        definitionId: 'wf-s04-fan',
        version: 1,
        name: 'fan-in',
        topology: FAN_IN_TOPOLOGY,
      },
      ctx,
    );
    expect(ok.ok).toBe(true);

    const prevAll = dispatch(
      'workflow_prev',
      { opId: 'prev-all-1', targets: 'all', note: 'revise' },
      ctx,
    );
    expect(prevAll.ok).toBe(true);
    if (prevAll.ok) {
      expect(prevAll.command).toMatchObject({
        kind: 'workflow_prev',
        targets: 'all',
        note: 'revise',
      });
    }

    const prevTargeted = dispatch(
      'workflow_prev',
      { opId: 'prev-t-1', targets: ['from_p1'] },
      ctx,
    );
    expect(prevTargeted.ok).toBe(true);
    if (prevTargeted.ok) {
      expect(prevTargeted.command).toMatchObject({
        kind: 'workflow_prev',
        targets: ['from_p1'],
      });
    }

    const empty = dispatch(
      'workflow_prev',
      { opId: 'prev-empty', targets: [] },
      ctx,
    );
    expect(empty.ok).toBe(false);
  });

  it('PREV ALL-join: open round, partial no resume, final ordered resume, redelivery no-op, identities only', async () => {
    const ctx = await openRepo('prev-all-join');
    try {
      const createdAt = '2026-07-19T00:00:00.000Z';
      const data = await defineAndStartFanIn(ctx.repository, createdAt, 's04-prev-fan-1');
      const { p1, p2, consumerTaskId, consumerActivationTurnId } = await activateConsumer(
        ctx.repository,
        ctx.client,
        data,
      );

      // Consumer PREV all → one open round + one pending target per producer.
      const prev = await settleSucceeded(
        ctx.repository,
        ctx.client,
        consumerTaskId,
        consumerActivationTurnId,
        { kind: 'workflow_prev', targets: 'all', note: 'please revise' },
        '2026-07-19T00:03:00.000Z',
      );
      expect(prev.ok).toBe(true);
      expect(prev.changed).toBe(true);

      const rounds = await ctx.client.all(
        `SELECT round_id, requester_node_id, status, join_mode
           FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      );
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({
        requester_node_id: 'consumer',
        status: 'open',
        join_mode: 'all',
      });
      const roundId = rounds[0]!.round_id as string;
      expect(roundId).toBe(
        deriveFeedbackRoundId(data.runId, 'consumer', consumerActivationTurnId),
      );

      const targets = await ctx.client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
          ORDER BY target_node_id`,
        ['ws', data.runId, roundId],
      );
      expect(targets).toEqual([
        { target_node_id: 'p1', status: 'pending' },
        { target_node_id: 'p2', status: 'pending' },
      ]);

      // Durable feedback_request fences carry identities only (no note / SQL / paths).
      const requestFences = await ctx.client.all(
        `SELECT message_id, kind, source_node_id, destination_node_id, body_json
           FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_request'
          ORDER BY destination_node_id`,
        ['ws', data.runId],
      );
      expect(requestFences).toHaveLength(2);
      for (const row of requestFences) {
        expect(row.source_node_id).toBe('consumer');
        expect(row.message_id).toBe(
          deriveFeedbackRequestMessageId(data.runId, roundId, row.destination_node_id as string),
        );
        const body = String(row.body_json);
        expect(body).toContain('feedback_request');
        expect(body).toContain(roundId);
        expect(body).not.toContain('please revise');
        expect(body).not.toMatch(/SELECT |INSERT |DELETE /i);
        expect(body).not.toMatch(/[A-Za-z]:\\|\/tmp\/|credentials|api[_-]?key/i);
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(parsed).toMatchObject({
          kind: 'feedback_request',
          schema: 1,
          roundId,
          requesterNodeId: 'consumer',
          targetNodeId: row.destination_node_id,
        });
        expect(parsed).not.toHaveProperty('note');
        expect(parsed).not.toHaveProperty('result');
      }

      // Feedback turns append to existing producer FIFOs (sequence > activation).
      const p1TurnsAfterPrev = await ctx.repository.listTurns(p1.taskId);
      const p2TurnsAfterPrev = await ctx.repository.listTurns(p2.taskId);
      expect(p1TurnsAfterPrev).toHaveLength(2);
      expect(p2TurnsAfterPrev).toHaveLength(2);
      const p1Feedback = p1TurnsAfterPrev.find((t) => t.id !== p1.activationTurnId)!;
      const p2Feedback = p2TurnsAfterPrev.find((t) => t.id !== p2.activationTurnId)!;
      expect(p1Feedback.id).toBe(deriveFeedbackTargetTurnId(data.runId, roundId, 'p1'));
      expect(p2Feedback.id).toBe(deriveFeedbackTargetTurnId(data.runId, roundId, 'p2'));
      expect(p1Feedback.status).toBe('queued');
      expect(p1Feedback.trigger).toBe('engine');
      expect(p1Feedback.sequence).toBeGreaterThan(1);
      expect(p2Feedback.sequence).toBeGreaterThan(1);

      const p1FeedbackMsg = (await ctx.repository.listMessages(p1.taskId)).find(
        (m) => m.turnId === p1Feedback.id,
      );
      expect(p1FeedbackMsg?.id).toBe(
        deriveFeedbackTargetMessageId(data.runId, roundId, 'p1'),
      );
      expect(p1FeedbackMsg?.content).toContain(roundId);

      // Requester has no resume while the round is partial.
      expect(await ctx.repository.listTurns(consumerTaskId)).toHaveLength(1);

      // PREV redelivery after operations-ledger prune is a true no-op.
      await ctx.client.run(
        `DELETE FROM operations WHERE workspace_id = ? AND ledger_key GLOB ?`,
        ['ws', `${consumerActivationTurnId}:*`],
      );
      const prevAgain = await settleSucceeded(
        ctx.repository,
        ctx.client,
        consumerTaskId,
        consumerActivationTurnId,
        { kind: 'workflow_prev', targets: 'all', note: 'please revise again' },
        '2026-07-19T00:03:30.000Z',
      );
      expect(prevAgain.ok).toBe(true);
      expect(
        await ctx.client.all(
          `SELECT round_id FROM workflow_feedback_rounds WHERE workspace_id = ? AND run_id = ?`,
          ['ws', data.runId],
        ),
      ).toHaveLength(1);
      expect(await ctx.repository.listTurns(p1.taskId)).toHaveLength(2);
      expect(await ctx.repository.listTurns(p2.taskId)).toHaveLength(2);
      expect(
        await ctx.client.all(
          `SELECT message_id FROM workflow_routed_messages
            WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_request'`,
          ['ws', data.runId],
        ),
      ).toHaveLength(2);

      // Partial response: p1 answers via workflow_next on its feedback turn.
      const partial = await settleSucceeded(
        ctx.repository,
        ctx.client,
        p1.taskId,
        p1Feedback.id,
        { kind: 'workflow_next', change: 'updated', result: 'p1-v2' },
        '2026-07-19T00:04:00.000Z',
      );
      expect(partial.ok).toBe(true);
      expect(partial.changed).toBe(true);

      const targetsAfterPartial = await ctx.client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
          ORDER BY target_node_id`,
        ['ws', data.runId, roundId],
      );
      expect(targetsAfterPartial).toEqual([
        { target_node_id: 'p1', status: 'responded' },
        { target_node_id: 'p2', status: 'pending' },
      ]);
      const roundAfterPartial = await ctx.client.get(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', data.runId, roundId],
      );
      expect(roundAfterPartial).toMatchObject({ status: 'open' });
      expect(await ctx.repository.listTurns(consumerTaskId)).toHaveLength(1);

      // Feedback response is NOT a forward contribution (no second consumer activation).
      const responseFencesPartial = await ctx.client.all(
        `SELECT message_id, kind, body_json FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_response'`,
        ['ws', data.runId],
      );
      expect(responseFencesPartial).toHaveLength(1);
      expect(responseFencesPartial[0]!.message_id).toBe(
        deriveFeedbackResponseMessageId(data.runId, roundId, 'p1'),
      );
      const responseBody = String(responseFencesPartial[0]!.body_json);
      expect(responseBody).toContain('feedback_response');
      expect(responseBody).not.toContain('p1-v2');
      expect(responseBody).not.toMatch(/SELECT |INSERT |DELETE /i);
      const responseParsed = JSON.parse(responseBody) as Record<string, unknown>;
      expect(responseParsed).toMatchObject({
        kind: 'feedback_response',
        schema: 1,
        roundId,
        targetNodeId: 'p1',
        requesterNodeId: 'consumer',
        artifactId: deriveProducerArtifactId(data.runId, 'p1'),
        artifactRevision: 2,
      });
      expect(responseParsed).not.toHaveProperty('result');

      // Final response: p2 closes the ALL-join and queues one ordered resume.
      const final = await settleSucceeded(
        ctx.repository,
        ctx.client,
        p2.taskId,
        p2Feedback.id,
        { kind: 'workflow_next', change: 'updated', result: 'p2-v2' },
        '2026-07-19T00:05:00.000Z',
      );
      expect(final.ok).toBe(true);
      expect(final.changed).toBe(true);

      const roundAfterFinal = await ctx.client.get(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', data.runId, roundId],
      );
      expect(roundAfterFinal).toMatchObject({ status: 'consumed' });
      const targetsAfterFinal = await ctx.client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
          ORDER BY target_node_id`,
        ['ws', data.runId, roundId],
      );
      expect(targetsAfterFinal.every((t) => t.status === 'responded')).toBe(true);

      const consumerTurnsAfter = await ctx.repository.listTurns(consumerTaskId);
      expect(consumerTurnsAfter).toHaveLength(2);
      const resume = consumerTurnsAfter.find((t) => t.id !== consumerActivationTurnId)!;
      expect(resume.id).toBe(deriveFeedbackResumeTurnId(data.runId, roundId));
      expect(resume.status).toBe('queued');
      expect(resume.trigger).toBe('engine');
      expect(resume.sequence).toBeGreaterThan(1);

      const resumeMessages = (await ctx.repository.listMessages(consumerTaskId)).filter(
        (m) => m.turnId === resume.id,
      );
      expect(resumeMessages).toHaveLength(1);
      expect(resumeMessages[0]!.id).toBe(deriveFeedbackResumeMessageId(data.runId, roundId));
      const resumeContent = resumeMessages[0]!.content;
      expect(resumeContent.startsWith('[workflow-feedback-resume]')).toBe(true);
      // Frozen dependency declaration order: from_p1 then from_p2 (not arrival order).
      expect(resumeContent.indexOf('from_p1=')).toBeLessThan(resumeContent.indexOf('from_p2='));
      const p1Artifact = deriveProducerArtifactId(data.runId, 'p1');
      const p2Artifact = deriveProducerArtifactId(data.runId, 'p2');
      expect(resumeContent).toContain('from_p1=p1-v2');
      expect(resumeContent).toContain(`from_p2=[artifact ${p2Artifact}@2]`);

      // Response redelivery after ledger prune is a no-op (no second resume).
      await ctx.client.run(
        `DELETE FROM operations WHERE workspace_id = ? AND ledger_key GLOB ?`,
        ['ws', `${p2Feedback.id}:*`],
      );
      const responseAgain = await settleSucceeded(
        ctx.repository,
        ctx.client,
        p2.taskId,
        p2Feedback.id,
        { kind: 'workflow_next', change: 'updated', result: 'p2-v2-again' },
        '2026-07-19T00:06:00.000Z',
      );
      expect(responseAgain.ok).toBe(true);
      expect(
        await ctx.client.all(
          `SELECT message_id FROM workflow_routed_messages
            WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_response'`,
          ['ws', data.runId],
        ),
      ).toHaveLength(2);
      expect(await ctx.repository.listTurns(consumerTaskId)).toHaveLength(2);

      // Lifecycles stay open (PREV never seals requester or targets).
      expect((await ctx.repository.getTask(p1.taskId))?.lifecycle).toBe('open');
      expect((await ctx.repository.getTask(p2.taskId))?.lifecycle).toBe('open');
      expect((await ctx.repository.getTask(consumerTaskId))?.lifecycle).toBe('open');

      // Targeted PREV with foreign inputRef rejects without opening another round.
      const invalidPrev = await settleSucceeded(
        ctx.repository,
        ctx.client,
        consumerTaskId,
        resume.id,
        { kind: 'workflow_prev', targets: ['not_a_binding'] },
        '2026-07-19T00:07:00.000Z',
      );
      expect(invalidPrev.ok).toBe(true);
      expect(
        await ctx.client.all(
          `SELECT round_id FROM workflow_feedback_rounds WHERE workspace_id = ? AND run_id = ?`,
          ['ws', data.runId],
        ),
      ).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('reload between partial and final response preserves open round and yields one resume', async () => {
    const first = await openRepo('prev-reload');
    let dbPath = first.dbPath;
    let runId = '';
    let roundId = '';
    let p2TaskId = '';
    let p2FeedbackTurnId = '';
    let consumerTaskId = '';
    let consumerActivationTurnId = '';
    try {
      const createdAt = '2026-07-19T10:00:00.000Z';
      const data = await defineAndStartFanIn(first.repository, createdAt, 's04-prev-reload-1');
      runId = data.runId;
      const activated = await activateConsumer(first.repository, first.client, data);
      consumerTaskId = activated.consumerTaskId;
      consumerActivationTurnId = activated.consumerActivationTurnId;
      p2TaskId = activated.p2.taskId;

      const prev = await settleSucceeded(
        first.repository,
        first.client,
        consumerTaskId,
        consumerActivationTurnId,
        { kind: 'workflow_prev', targets: 'all', note: 'reload-safe revise' },
        '2026-07-19T10:03:00.000Z',
      );
      expect(prev.ok).toBe(true);

      const round = await first.client.get(
        `SELECT round_id, status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', runId],
      );
      expect(round).toMatchObject({ status: 'open' });
      roundId = round!.round_id as string;

      const p1FeedbackId = deriveFeedbackTargetTurnId(runId, roundId, 'p1');
      p2FeedbackTurnId = deriveFeedbackTargetTurnId(runId, roundId, 'p2');

      // Partial: only p1 responds before reload.
      const partial = await settleSucceeded(
        first.repository,
        first.client,
        activated.p1.taskId,
        p1FeedbackId,
        { kind: 'workflow_next', change: 'updated', result: 'p1-reload-v2' },
        '2026-07-19T10:04:00.000Z',
      );
      expect(partial.ok).toBe(true);
      expect(await first.repository.listTurns(consumerTaskId)).toHaveLength(1);

      // Full extension reload: close client, reopen, TaskEngine.loadAsync.
      await first.client.close();
    } finally {
      // Keep db file; only close first client (already closed above if happy path).
      try {
        await first.client.close();
      } catch {
        /* already closed */
      }
    }

    // Full extension reload: new DbClient + repository over the same SQLite file
    // (same surface S03 uses — durable state lives in the DB, not in-process engine cache).
    const reopened = await reopenDb(dbPath);
    try {
      // Open round + partial target state survives reload.
      const roundAfterReload = await reopened.client.get(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', runId, roundId],
      );
      expect(roundAfterReload).toMatchObject({ status: 'open' });
      const targetsAfterReload = await reopened.client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
          ORDER BY target_node_id`,
        ['ws', runId, roundId],
      );
      expect(targetsAfterReload).toEqual([
        { target_node_id: 'p1', status: 'responded' },
        { target_node_id: 'p2', status: 'pending' },
      ]);
      expect(await reopened.repository.listTurns(consumerTaskId)).toHaveLength(1);

      // Final response after reload satisfies the round once.
      const final = await settleSucceeded(
        reopened.repository,
        reopened.client,
        p2TaskId,
        p2FeedbackTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'p2-reload-v2' },
        '2026-07-19T10:05:00.000Z',
      );
      expect(final.ok).toBe(true);

      const roundFinal = await reopened.client.get(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', runId, roundId],
      );
      expect(roundFinal).toMatchObject({ status: 'consumed' });

      const consumerTurns = await reopened.repository.listTurns(consumerTaskId);
      expect(consumerTurns).toHaveLength(2);
      const resume = consumerTurns.find((t) => t.id !== consumerActivationTurnId)!;
      expect(resume.id).toBe(deriveFeedbackResumeTurnId(runId, roundId));
      expect(resume.status).toBe('queued');

      const resumeMsg = (await reopened.repository.listMessages(consumerTaskId)).find(
        (m) => m.turnId === resume.id,
      );
      expect(resumeMsg?.content.startsWith('[workflow-feedback-resume]')).toBe(true);
      expect(resumeMsg!.content.indexOf('from_p1=')).toBeLessThan(
        resumeMsg!.content.indexOf('from_p2='),
      );

      // No duplicate request/response fences across reload.
      expect(
        await reopened.client.all(
          `SELECT message_id FROM workflow_routed_messages
            WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_request'`,
          ['ws', runId],
        ),
      ).toHaveLength(2);
      expect(
        await reopened.client.all(
          `SELECT message_id FROM workflow_routed_messages
            WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_response'`,
          ['ws', runId],
        ),
      ).toHaveLength(2);
    } finally {
      await reopened.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  }, 45_000);

  it('targeted PREV from_p1 only opens one target and single response resumes requester', async () => {
    const ctx = await openRepo('prev-targeted');
    try {
      const createdAt = '2026-07-19T11:00:00.000Z';
      const data = await defineAndStartFanIn(ctx.repository, createdAt, 's04-prev-targeted-1');
      const { p1, p2, consumerTaskId, consumerActivationTurnId } = await activateConsumer(
        ctx.repository,
        ctx.client,
        data,
      );

      const prev = await settleSucceeded(
        ctx.repository,
        ctx.client,
        consumerTaskId,
        consumerActivationTurnId,
        { kind: 'workflow_prev', targets: ['from_p1'] },
        '2026-07-19T11:03:00.000Z',
      );
      expect(prev.ok).toBe(true);

      const rounds = await ctx.client.all(
        `SELECT round_id, join_mode, status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      );
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({ join_mode: 'all', status: 'open' });
      const roundId = rounds[0]!.round_id as string;

      const targets = await ctx.client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', data.runId, roundId],
      );
      expect(targets).toEqual([{ target_node_id: 'p1', status: 'pending' }]);

      // Only p1 receives a feedback turn; p2 FIFO unchanged.
      expect(await ctx.repository.listTurns(p1.taskId)).toHaveLength(2);
      expect(await ctx.repository.listTurns(p2.taskId)).toHaveLength(1);

      const p1FeedbackId = deriveFeedbackTargetTurnId(data.runId, roundId, 'p1');
      const response = await settleSucceeded(
        ctx.repository,
        ctx.client,
        p1.taskId,
        p1FeedbackId,
        { kind: 'workflow_next', change: 'updated', result: 'p1-only-v2' },
        '2026-07-19T11:04:00.000Z',
      );
      expect(response.ok).toBe(true);

      const roundFinal = await ctx.client.get(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', data.runId, roundId],
      );
      expect(roundFinal).toMatchObject({ status: 'consumed' });

      const consumerTurns = await ctx.repository.listTurns(consumerTaskId);
      expect(consumerTurns).toHaveLength(2);
      const resume = consumerTurns.find((t) => t.id !== consumerActivationTurnId)!;
      expect(resume.id).toBe(deriveFeedbackResumeTurnId(data.runId, roundId));

      // p2 still has only its activation turn (never received feedback).
      expect(await ctx.repository.listTurns(p2.taskId)).toHaveLength(1);
      expect((await ctx.repository.getTask(p1.taskId))?.lifecycle).toBe('open');
      expect((await ctx.repository.getTask(consumerTaskId))?.lifecycle).toBe('open');
    } finally {
      await ctx.close();
    }
  }, 30_000);
});
