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
import { stageDispositionForSettlement } from './m018-test-helpers';
import { DbClient } from './sqlite/client';
import {
  DEFAULT_WORKFLOW_POLICY,
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

async function defineAndStartFanIn(
  repository: SqliteTaskRepository,
  createdAt: string,
  startKey: string,
  policy = DEFAULT_WORKFLOW_POLICY,
): Promise<StartPayload> {
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
        entryContracts: [],
        policy: DEFAULT_WORKFLOW_POLICY,
      },
      ctx,
    );
    expect(ok.ok).toBe(true);

    const prevAll = dispatch(
      'workflow_prev',
      { opId: 'prev-all-1', targets: 'all', message: 'revise' },
      ctx,
    );
    expect(prevAll.ok).toBe(true);
    if (prevAll.ok) {
      expect(prevAll.command).toMatchObject({
        kind: 'workflow_prev',
        targets: 'all',
        message: 'revise',
      });
    }

    const prevTargeted = dispatch(
      'workflow_prev',
      { opId: 'prev-t-1', targets: ['from_p1'], message: 'revise p1' },
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
      { opId: 'prev-empty', targets: [], message: 'revise' },
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
      expect(p1Feedback.workflowActivation).toMatchObject({
        runId: data.runId,
        nodeId: 'p1',
        kind: 'feedback_request',
        activationStatus: 'queued',
      });
      expect(p1Feedback.sequence).toBeGreaterThan(1);
      expect(p2Feedback.sequence).toBeGreaterThan(1);

      await ctx.client.run(
        `UPDATE workflow_routed_messages
            SET body_json = ?
          WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
        [
          JSON.stringify({
            kind: 'feedback_request',
            schema: 1,
            roundId: 'contradictory-round',
            requesterNodeId: 'p1',
            targetNodeId: 'p2',
          }),
          'ws',
          data.runId,
          deriveFeedbackRequestMessageId(data.runId, roundId, 'p1'),
        ],
      );

      const p1FeedbackMsg = (await ctx.repository.listMessages(p1.taskId)).find(
        (m) => m.turnId === p1Feedback.id,
      );
      expect(p1FeedbackMsg?.id).toBe(
        deriveFeedbackTargetMessageId(data.runId, roundId, 'p1'),
      );
      expect(p1FeedbackMsg?.content).toContain(roundId);
      expect(p1FeedbackMsg?.content).toContain('[feedback]\nplease revise');

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
      expect(roundAfterFinal).toMatchObject({ status: 'satisfied' });
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
      expect(resumeContent).toContain('from_p1=p1-v2');
      expect(resumeContent).toContain('from_p2=p2-v2');

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
        await ctx.client.get(
          `SELECT status FROM workflow_feedback_rounds
            WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
          ['ws', data.runId, roundId],
        ),
      ).toMatchObject({ status: 'consumed' });
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

  it('nested PREV preserves outer response authority across requester resume and reload', async () => {
    const opened = await openRepo('nested-prev');
    let reopened: Awaited<ReturnType<typeof reopenDb>> | undefined;
    try {
      const createdAt = '2026-07-22T10:00:00.000Z';
      const topology = {
        kind: 'graph_v1' as const,
        nodes: [{ nodeId: 'a' }, { nodeId: 'b' }, { nodeId: 'c' }],
        edges: [
          { fromNodeId: 'a', toNodeId: 'b', inputRef: 'from_a' },
          { fromNodeId: 'b', toNodeId: 'c', inputRef: 'from_b' },
        ],
      };
      await expect(opened.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-nested-prev',
        version: 1,
        name: 'nested prev',
        topology,
        entryContracts: [],
        policy: DEFAULT_WORKFLOW_POLICY,
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await opened.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-nested-prev',
        version: 1,
        startIdempotencyKey: 'nested-prev-start',
        createdAt,
        goal: 'nested prev',
        backend: 'grok',
      });
      const data = started.operation?.result?.data as StartPayload;
      const aEntry = data.entries.find((entry) => entry.nodeId === 'a')!;
      await settleSucceeded(
        opened.repository,
        opened.client,
        aEntry.taskId,
        aEntry.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'a-v1' },
        '2026-07-22T10:01:00.000Z',
      );

      const bNode = await opened.client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'b'`,
        [data.runId],
      );
      const bTaskId = bNode!.task_id;
      const bActivation = (await opened.repository.listTurns(bTaskId))[0]!;
      await settleSucceeded(
        opened.repository,
        opened.client,
        bTaskId,
        bActivation.id,
        { kind: 'workflow_next', change: 'updated', result: 'b-v1' },
        '2026-07-22T10:02:00.000Z',
      );

      const cNode = await opened.client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'c'`,
        [data.runId],
      );
      const cTaskId = cNode!.task_id;
      const cActivation = (await opened.repository.listTurns(cTaskId))[0]!;
      await settleSucceeded(
        opened.repository,
        opened.client,
        cTaskId,
        cActivation.id,
        { kind: 'workflow_prev', targets: ['from_b'], note: 'revise b' },
        '2026-07-22T10:03:00.000Z',
      );
      const outerRound = await opened.client.get<{ round_id: string }>(
        `SELECT round_id FROM workflow_feedback_rounds
          WHERE workspace_id = 'ws' AND run_id = ? AND requester_node_id = 'c'`,
        [data.runId],
      );
      const bFeedbackTurn = (await opened.repository.listTurns(bTaskId)).find(
        (turn) => turn.id === deriveFeedbackTargetTurnId(data.runId, outerRound!.round_id, 'b'),
      )!;
      expect(bFeedbackTurn.workflowActivation).toMatchObject({
        kind: 'feedback_request',
        nodeId: 'b',
      });

      await settleSucceeded(
        opened.repository,
        opened.client,
        bTaskId,
        bFeedbackTurn.id,
        { kind: 'workflow_prev', targets: ['from_a'], note: 'revise a first' },
        '2026-07-22T10:04:00.000Z',
      );
      const innerRound = await opened.client.get<{
        round_id: string;
        inherited_round_id: string | null;
        inherited_target_id: string | null;
      }>(
        `SELECT round_id, inherited_round_id, inherited_target_id
           FROM workflow_feedback_rounds
          WHERE workspace_id = 'ws' AND run_id = ? AND requester_node_id = 'b'`,
        [data.runId],
      );
      expect(innerRound).toMatchObject({
        inherited_round_id: outerRound!.round_id,
        inherited_target_id: expect.any(String),
      });

      const aFeedbackTurnId = deriveFeedbackTargetTurnId(data.runId, innerRound!.round_id, 'a');
      await settleSucceeded(
        opened.repository,
        opened.client,
        aEntry.taskId,
        aFeedbackTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'a-v2' },
        '2026-07-22T10:05:00.000Z',
      );
      const bResumeTurnId = deriveFeedbackResumeTurnId(data.runId, innerRound!.round_id);

      await opened.client.close();
      reopened = await reopenDb(opened.dbPath);
      const bResume = await reopened.repository.getTurn(bResumeTurnId);
      expect(bResume?.workflowActivation).toMatchObject({
        kind: 'feedback_resume',
        nodeId: 'b',
        hasInheritedFeedbackResponse: true,
      });
      await reopened.client.run(
        `UPDATE turns SET status = 'running', started_at = ?
          WHERE workspace_id = 'ws' AND id = ?`,
        ['2026-07-22T10:06:00.000Z', bResumeTurnId],
      );
      const runningBResume = await reopened.repository.getTurn(bResumeTurnId);
      await expect(reopened.repository.execute({
        kind: 'stageDisposition',
        workspaceId: 'ws',
        turnId: bResumeTurnId,
        opId: 'nested-prev-unchanged',
        turn: {
          ...runningBResume!,
          disposition: { kind: 'workflow_next', change: 'unchanged' },
        },
        expectedStatuses: ['running'],
      })).resolves.toMatchObject({ changed: true });
      await settleSucceeded(
        reopened.repository,
        reopened.client,
        bTaskId,
        bResumeTurnId,
        { kind: 'workflow_next', change: 'unchanged' },
        '2026-07-22T10:06:00.000Z',
      );

      await expect(reopened.client.get<{ status: string }>(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = 'ws' AND run_id = ? AND round_id = ?`,
        [data.runId, innerRound!.round_id],
      )).resolves.toEqual({ status: 'consumed' });
      await expect(reopened.client.get<{ status: string }>(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = 'ws' AND run_id = ? AND round_id = ?`,
        [data.runId, outerRound!.round_id],
      )).resolves.toEqual({ status: 'satisfied' });
      const cResumes = (await reopened.repository.listTurns(cTaskId)).filter(
        (turn) => turn.id !== cActivation.id,
      );
      expect(cResumes).toHaveLength(1);
      expect(cResumes[0]!.id).toBe(deriveFeedbackResumeTurnId(data.runId, outerRound!.round_id));
      const cResumeMessage = (await reopened.repository.listMessages(cTaskId)).find(
        (message) => message.turnId === cResumes[0]!.id,
      );
      expect(cResumeMessage?.content).toContain('from_b=b-v1');
    } finally {
      await reopened?.close();
      await opened.close();
    }
  }, 45_000);

  it('late round-N response cannot satisfy round-N-plus-one', async () => {
    const opened = await openRepo('late-prior-round');
    try {
      const createdAt = '2026-07-22T11:00:00.000Z';
      const data = await defineAndStartFanIn(
        opened.repository,
        createdAt,
        'late-prior-round-start',
      );
      const { p1, p2, consumerTaskId, consumerActivationTurnId } = await activateConsumer(
        opened.repository,
        opened.client,
        data,
      );
      await settleSucceeded(
        opened.repository,
        opened.client,
        consumerTaskId,
        consumerActivationTurnId,
        { kind: 'workflow_prev', targets: 'all', note: 'round one' },
        '2026-07-22T11:01:00.000Z',
      );
      const firstRound = await opened.client.get<{ round_id: string }>(
        `SELECT round_id FROM workflow_feedback_rounds
          WHERE workspace_id = 'ws' AND run_id = ?`,
        [data.runId],
      );
      const p1FirstFeedbackId = deriveFeedbackTargetTurnId(data.runId, firstRound!.round_id, 'p1');
      const p2FirstFeedbackId = deriveFeedbackTargetTurnId(data.runId, firstRound!.round_id, 'p2');
      await settleSucceeded(
        opened.repository,
        opened.client,
        p1.taskId,
        p1FirstFeedbackId,
        { kind: 'workflow_next', change: 'updated', result: 'p1-round-one' },
        '2026-07-22T11:02:00.000Z',
      );
      await settleSucceeded(
        opened.repository,
        opened.client,
        p2.taskId,
        p2FirstFeedbackId,
        { kind: 'workflow_next', change: 'updated', result: 'p2-round-one' },
        '2026-07-22T11:03:00.000Z',
      );
      const firstResumeId = deriveFeedbackResumeTurnId(data.runId, firstRound!.round_id);
      await settleSucceeded(
        opened.repository,
        opened.client,
        consumerTaskId,
        firstResumeId,
        { kind: 'workflow_prev', targets: 'all', note: 'round two' },
        '2026-07-22T11:04:00.000Z',
      );

      const rounds = await opened.client.all<{ round_id: string; status: string }>(
        `SELECT round_id, status FROM workflow_feedback_rounds
          WHERE workspace_id = 'ws' AND run_id = ? ORDER BY round_id`,
        [data.runId],
      );
      expect(rounds).toHaveLength(2);
      const secondRound = rounds.find((round) => round.round_id !== firstRound!.round_id)!;
      expect(secondRound.status).toBe('open');

      await settleSucceeded(
        opened.repository,
        opened.client,
        p1.taskId,
        p1FirstFeedbackId,
        { kind: 'workflow_next', change: 'updated', result: 'late-round-one' },
        '2026-07-22T11:05:00.000Z',
      );

      await expect(opened.client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = 'ws' AND run_id = ? AND round_id = ?
          ORDER BY target_node_id`,
        [data.runId, secondRound.round_id],
      )).resolves.toEqual([
        { target_node_id: 'p1', status: 'pending' },
        { target_node_id: 'p2', status: 'pending' },
      ]);
      await expect(opened.client.get(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = 'ws' AND run_id = ? AND round_id = ?`,
        [data.runId, secondRound.round_id],
      )).resolves.toEqual({ status: 'open' });
      expect(await opened.repository.listTurns(consumerTaskId)).toHaveLength(2);
      await expect(opened.client.all(
        `SELECT message_id FROM workflow_routed_messages
          WHERE workspace_id = 'ws' AND run_id = ? AND feedback_round_id = ?
            AND kind = 'feedback_response'`,
        [data.runId, secondRound.round_id],
      )).resolves.toHaveLength(0);
    } finally {
      await opened.close();
    }
  }, 30_000);

  it('concurrent final feedback responses build one exact aggregate', async () => {
    const first = await openRepo('prev-concurrent-final');
    const secondClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await secondClient.open(first.dbPath);
      const second = new SqliteTaskRepository(secondClient, 'ws');
      const createdAt = '2026-07-22T06:00:00.000Z';
      const data = await defineAndStartFanIn(first.repository, createdAt, 's04-concurrent-final');
      const { p1, p2, consumerTaskId, consumerActivationTurnId } = await activateConsumer(
        first.repository,
        first.client,
        data,
      );
      await settleSucceeded(
        first.repository,
        first.client,
        consumerTaskId,
        consumerActivationTurnId,
        { kind: 'workflow_prev', targets: 'all', note: 'concurrent' },
        '2026-07-22T06:01:00.000Z',
      );
      const p1Feedback = (await first.repository.listTurns(p1.taskId)).find(
        (turn) => turn.id !== p1.activationTurnId && turn.status === 'queued',
      );
      const p2Feedback = (await first.repository.listTurns(p2.taskId)).find(
        (turn) => turn.id !== p2.activationTurnId && turn.status === 'queued',
      );
      expect(p1Feedback).toBeTruthy();
      expect(p2Feedback).toBeTruthy();

      const results = await Promise.all([
        settleSucceeded(
          first.repository,
          first.client,
          p1.taskId,
          p1Feedback!.id,
          { kind: 'workflow_next', change: 'updated', result: 'p1-concurrent' },
          '2026-07-22T06:02:00.000Z',
        ),
        settleSucceeded(
          second,
          secondClient,
          p2.taskId,
          p2Feedback!.id,
          { kind: 'workflow_next', change: 'updated', result: 'p2-concurrent' },
          '2026-07-22T06:02:00.000Z',
        ),
      ]);
      expect(results.every((result) => result.changed === true)).toBe(true);

      const round = await first.client.get<{ round_id: string; status: string }>(
        `SELECT round_id, status FROM workflow_feedback_rounds
          WHERE workspace_id = 'ws' AND run_id = ?`,
        [data.runId],
      );
      expect(round?.status).toBe('satisfied');
      const resumes = (await first.repository.listTurns(consumerTaskId)).filter(
        (turn) => turn.id !== consumerActivationTurnId,
      );
      expect(resumes).toHaveLength(1);
      const messages = (await first.repository.listMessages(consumerTaskId)).filter(
        (message) => message.turnId === resumes[0]!.id,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe(
        '[workflow-feedback-resume] from_p1=p1-concurrent from_p2=p2-concurrent',
      );
      expect(messages[0]!.content).not.toMatch(/missing|\[artifact /);
      expect(
        await first.client.all(
          `SELECT activation_id FROM workflow_activations
            WHERE workspace_id = 'ws' AND run_id = ? AND feedback_round_id = ?
              AND kind = 'feedback_resume'`,
          [data.runId, round!.round_id],
        ),
      ).toHaveLength(1);
    } finally {
      await secondClient.close().catch(() => undefined);
      await first.close();
    }
  }, 30_000);

  it('feedback aggregate enforces the exact UTF-8 byte boundary', async () => {
    const expectedAggregate = '[workflow-feedback-resume] from_p1=é from_p2=value-two';
    const exactBytes = Buffer.byteLength(expectedAggregate, 'utf8');

    for (const overflow of [false, true]) {
      const ctx = await openRepo(overflow ? 'feedback-overflow' : 'feedback-exact');
      try {
        const createdAt = '2026-07-22T08:00:00.000Z';
        const policy = {
          ...DEFAULT_WORKFLOW_POLICY,
          maxArtifactBytes: 16,
          maxAggregateBytes: exactBytes - (overflow ? 1 : 0),
        };
        const data = await defineAndStartFanIn(
          ctx.repository,
          createdAt,
          `feedback-boundary-${overflow ? 'over' : 'exact'}`,
          policy,
        );
        const { p1, p2, consumerTaskId, consumerActivationTurnId } = await activateConsumer(
          ctx.repository,
          ctx.client,
          data,
        );
        await expect(settleSucceeded(
          ctx.repository,
          ctx.client,
          consumerTaskId,
          consumerActivationTurnId,
          { kind: 'workflow_prev', targets: 'all', note: 'boundary' },
          '2026-07-22T08:01:00.000Z',
        )).resolves.toMatchObject({ changed: true });
        const p1Feedback = (await ctx.repository.listTurns(p1.taskId)).find(
          (turn) => turn.id !== p1.activationTurnId && turn.status === 'queued',
        );
        const p2Feedback = (await ctx.repository.listTurns(p2.taskId)).find(
          (turn) => turn.id !== p2.activationTurnId && turn.status === 'queued',
        );
        await expect(settleSucceeded(
          ctx.repository,
          ctx.client,
          p1.taskId,
          p1Feedback!.id,
          { kind: 'workflow_next', change: 'updated', result: 'é' },
          '2026-07-22T08:02:00.000Z',
        )).resolves.toMatchObject({ changed: true });
        await expect(settleSucceeded(
          ctx.repository,
          ctx.client,
          p2.taskId,
          p2Feedback!.id,
          { kind: 'workflow_next', change: 'updated', result: 'value-two' },
          '2026-07-22T08:03:00.000Z',
        )).resolves.toMatchObject({ changed: true });

        const run = await ctx.client.get<{ status: string; terminal_reason_code: string | null }>(
          `SELECT status, terminal_reason_code FROM workflow_runs
            WHERE workspace_id = 'ws' AND run_id = ?`,
          [data.runId],
        );
        const round = await ctx.client.get<{ round_id: string; status: string }>(
          `SELECT round_id, status FROM workflow_feedback_rounds
            WHERE workspace_id = 'ws' AND run_id = ?`,
          [data.runId],
        );
        const resumes = (await ctx.repository.listTurns(consumerTaskId)).filter(
          (turn) => turn.id !== consumerActivationTurnId,
        );
        const resumeActivations = await ctx.client.all(
          `SELECT activation_id FROM workflow_activations
            WHERE workspace_id = 'ws' AND run_id = ? AND feedback_round_id = ?
              AND kind = 'feedback_resume'`,
          [data.runId, round!.round_id],
        );

        if (overflow) {
          expect(run).toEqual({ status: 'failed', terminal_reason_code: 'aggregate_too_large' });
          expect(round?.status).toBe('failed');
          expect(resumes).toHaveLength(0);
          expect(resumeActivations).toHaveLength(0);
        } else {
          expect(run).toEqual({ status: 'running', terminal_reason_code: null });
          expect(round?.status).toBe('satisfied');
          expect(resumes).toHaveLength(1);
          expect(resumeActivations).toHaveLength(1);
          const message = (await ctx.repository.listMessages(consumerTaskId)).find(
            (candidate) => candidate.turnId === resumes[0]!.id,
          );
          expect(message?.content).toBe(expectedAggregate);
          expect(Buffer.byteLength(message!.content, 'utf8')).toBe(policy.maxAggregateBytes);
        }
      } finally {
        await ctx.close();
      }
    }
  }, 45_000);

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
      expect(roundFinal).toMatchObject({ status: 'satisfied' });

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
      expect(roundFinal).toMatchObject({ status: 'satisfied' });

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
