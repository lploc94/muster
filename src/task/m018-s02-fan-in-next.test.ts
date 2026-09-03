/**
 * M018 S02 named flow:
 * two-producer fan-in graph_v1 → public define/start → producer NEXT settlements
 * → partial fill leaves consumer absent → final contribution closes gate and queues
 * exactly one deterministic aggregate consumer turn without sealing producers.
 * Uses real SQLite worker + repository settle path + public define surface.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CredentialRegistry } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { TaskEngine } from './engine';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { parseTaskTypeRegistry } from './task-types';
import { SqliteTaskRepository } from './repository';
import { RepositoryProjection, withRepositoryProjection } from './repository-projection';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { canPromoteTurn } from './scheduler';
import { DbClient } from './sqlite/client';
import type { TaskStoreFile } from './types';
import {
  DEFAULT_WORKFLOW_POLICY,
  entryNodeIds,
  makeGraphFanInDefinition,
  validateDefineWorkflow,
} from './workflow';

const FAN_IN_TOPOLOGY = {
  kind: 'workflow' as const,
  inputs: [],
  outputs: [
    { name: 'p1Result', semanticKind: 'checkpoint.p1', sourceNodeId: 'p1' },
    { name: 'p2Result', semanticKind: 'checkpoint.p2', sourceNodeId: 'p2' },
    { name: 'result', semanticKind: 'result', sourceNodeId: 'consumer' },
  ],
  nodes: [
    {
      nodeId: 'p1',
      outcome: {
        kind: 'agent' as const,
        requireExplicitDisposition: true as const,
        next: { when: 'The producer result is ready.' },
        fail: { when: 'The producer cannot be completed.' },
      },
    },
    {
      nodeId: 'p2',
      outcome: {
        kind: 'agent' as const,
        requireExplicitDisposition: true as const,
        next: { when: 'The producer result is ready.' },
        fail: { when: 'The producer cannot be completed.' },
      },
    },
    {
      nodeId: 'consumer',
      outcome: {
        kind: 'agent' as const,
        requireExplicitDisposition: true as const,
        next: { when: 'The consumer result is ready.' },
        fail: { when: 'The consumer cannot be completed.' },
        prev: [{
          when: 'The consumer needs correction.',
          targets: ['from_p1', 'from_p2'],
          feedback: 'required' as const,
        }],
      },
    },
  ],
  edges: [
    { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'from_p1', expectedArtifactKind: 'next_result' },
    { fromNodeId: 'p2', toNodeId: 'consumer', inputRef: 'from_p2', expectedArtifactKind: 'next_result' },
  ],
};

async function openRepo(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s02-${label}-`));
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  await client.open(path.join(dir, 'muster.sqlite3'));
  const repository = new SqliteTaskRepository(client, 'ws');
  return {
    dir,
    client,
    repository,
    async close() {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('M018 S02 fan-in NEXT activation', () => {
  it('public define accepts graph_v1 fan-in topology and rejects malformed graphs', () => {
    const credentials = new CredentialRegistry();
    const token = credentials.issue({
      rootId: 'root',
      callerTaskId: 'root',
      turnId: 'turn-1',
      attemptId: 'att-1',
      allowedActions: new Set(['define_workflow']),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;

    const ok = dispatch(
      'define_workflow',
      {
        manifest: {
          schema: 'muster.workflow/v2',
          name: 'fan-in',
          inputs: [],
           outputs: [
             { name: 'p1Result', kind: 'checkpoint.p1', from: 'p1' },
             { name: 'p2Result', kind: 'checkpoint.p2', from: 'p2' },
             { name: 'result', kind: 'result', from: 'consumer' },
           ],
          nodes: FAN_IN_TOPOLOGY.nodes.map((node) => ({
            nodeKey: node.nodeId,
            taskType: 'worker',
            outcome: node.outcome,
          })),
          edges: FAN_IN_TOPOLOGY.edges.map((edge) => ({
            from: edge.fromNodeId,
            to: edge.toNodeId,
            inputRef: edge.inputRef,
          })),
        },
      },
      ctx,
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.command).toMatchObject({
      kind: 'define_workflow',
      topology: FAN_IN_TOPOLOGY,
    });

    const bad = dispatch(
      'define_workflow',
      {
        name: 'bad',
        nodes: [{ nodeKey: 'only', taskType: 'worker' }, { nodeKey: 'orphan', taskType: 'worker' }],
      },
      ctx,
    );
    expect(bad.ok).toBe(false);

    const fanOut = dispatch(
      'define_workflow',
      {
        manifest: {
          schema: 'muster.workflow/v2',
          name: 'fan-out-bad',
          inputs: [],
          outputs: [
            { name: 'leftResult', kind: 'result', from: 'left' },
            { name: 'rightResult', kind: 'result', from: 'right' },
          ],
          nodes: [
            { nodeKey: 'source', taskType: 'worker' },
            { nodeKey: 'left', taskType: 'worker' },
            { nodeKey: 'right', taskType: 'worker' },
          ],
          edges: [
            { from: 'source', to: 'left', inputRef: 'from_source' },
            { from: 'source', to: 'right', inputRef: 'from_source' },
          ],
        },
      },
      ctx,
    );
    expect(fanOut.ok).toBe(false);
  });

  it('two-producer fan-in NEXT: partial fill leaves consumer absent; final fill queues one aggregate turn without sealing producers', async () => {
    const ctx = await openRepo('fan-in-next');
    try {
      const createdAt = '2026-07-19T12:00:00.000Z';
      const def = makeGraphFanInDefinition({ createdAt });
      expect(entryNodeIds(def.topology).sort()).toEqual(['p1', 'p2']);

      const defined = await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: def.definitionId,
        version: def.version,
        name: def.name,
        topology: def.topology,
        createdAt,
      });
      expect(defined.ok).toBe(true);
      expect(defined.changed).toBe(true);

      const start = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: def.definitionId,
        version: def.version,
        startIdempotencyKey: 'fan-start-1',
        createdAt,
        goal: 'fan-in next',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      expect(start.changed).toBe(true);
      const data = start.operation?.result?.data as {
        runId: string;
        entries: Array<{
          nodeId: string;
          taskId: string;
          gateId: string;
          activationTurnId: string;
          messageId: string;
        }>;
        nodeGates: Array<{ nodeId: string; gateId: string }>;
      };
      expect(data.runId).toBeTruthy();
      expect(data.entries.map((e) => e.nodeId).sort()).toEqual(['p1', 'p2']);

      const consumerGate = data.nodeGates.find((g) => g.nodeId === 'consumer');
      expect(consumerGate).toBeTruthy();
      const p1 = data.entries.find((e) => e.nodeId === 'p1')!;
      const p2 = data.entries.find((e) => e.nodeId === 'p2')!;
      await expect(ctx.repository.getTask(p1.taskId)).resolves.toMatchObject({
        goal: '[workflow:p1] fan-in next',
      });
      await expect(ctx.repository.getTask(p2.taskId)).resolves.toMatchObject({
        goal: '[workflow:p2] fan-in next',
      });
      const projection = await RepositoryProjection.load(ctx.repository, 'ws');
      const projectedRepository = withRepositoryProjection(ctx.repository, projection);

      const settleProducer = async (
        entry: { taskId: string; activationTurnId: string },
        result: string,
        finishedAt: string,
      ) => {
        await ctx.client.run(
          `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
          [createdAt, 'ws', entry.activationTurnId],
        );
        const task = await ctx.repository.getTask(entry.taskId);
         const turn = await ctx.repository.getTurn(entry.activationTurnId);
         expect(task).toBeTruthy();
         expect(turn).toBeTruthy();
         expect(turn?.workflowActivation?.isTerminalNode).toBe(false);
         const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result };
        await stageDispositionForSettlement(projectedRepository, turn!, disposition);
        return projectedRepository.execute({
          kind: 'settleTurnAndApplyEffects',
          workspaceId: 'ws',
          expectedTaskRevision: task!.revision,
          task: {
            ...task!,
            updatedAt: finishedAt,
          },
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
      };

      const first = await settleProducer(p1, 'p1-result', '2026-07-19T12:01:00.000Z');
      expect(first.ok).toBe(true);
      expect(first.changed).toBe(true);

      const fillsAfterFirst = await ctx.client.all(
        'SELECT input_ref FROM workflow_gate_fills WHERE workspace_id = ? AND run_id = ? AND gate_id = ? ORDER BY input_ref',
        ['ws', data.runId, consumerGate!.gateId],
      );
      expect(fillsAfterFirst).toEqual([{ input_ref: 'from_p1' }]);

      const gateAfterFirst = await ctx.client.get(
        'SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        ['ws', data.runId, consumerGate!.gateId],
      );
      expect(gateAfterFirst).toMatchObject({ status: 'open' });
      await expect(ctx.client.get(
        'SELECT status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
        ['ws', data.runId, 'p1'],
      )).resolves.toEqual({ status: 'succeeded' });

      const consumerNodeAfterFirst = await ctx.client.get(
        'SELECT task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
        ['ws', data.runId, 'consumer'],
      );
      expect(consumerNodeAfterFirst?.task_id).toBeTruthy();
      expect(consumerNodeAfterFirst).toMatchObject({ status: 'pending' });
      const consumerShellId = String(consumerNodeAfterFirst!.task_id);
      await expect(ctx.repository.getTask(consumerShellId)).resolves.toMatchObject({
        lifecycle: 'open',
        releaseState: 'released',
        workflowShell: { runId: data.runId, nodeId: 'consumer', gateId: consumerGate!.gateId },
      });
      expect(await ctx.repository.listTurns(consumerShellId)).toHaveLength(0);
      expect((await ctx.repository.getTask(p1.taskId))?.lifecycle).toBe('open');

      const second = await settleProducer(p2, 'p2-result', '2026-07-19T12:02:00.000Z');
      expect(second.ok).toBe(true);
      expect(second.changed).toBe(true);

      const fillsAfterSecond = await ctx.client.all(
        'SELECT input_ref FROM workflow_gate_fills WHERE workspace_id = ? AND run_id = ? AND gate_id = ? ORDER BY input_ref',
        ['ws', data.runId, consumerGate!.gateId],
      );
      expect(fillsAfterSecond).toEqual([{ input_ref: 'from_p1' }, { input_ref: 'from_p2' }]);

      const gateAfterSecond = await ctx.client.get(
        'SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        ['ws', data.runId, consumerGate!.gateId],
      );
      expect(gateAfterSecond).toMatchObject({ status: 'satisfied' });

      const consumerNode = await ctx.client.get(
        'SELECT task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
        ['ws', data.runId, 'consumer'],
      );
      expect(consumerNode?.task_id).toBeTruthy();
      expect(consumerNode).toMatchObject({ status: 'active' });
      expect(second.affectedTaskIds).toContain(String(consumerNode!.task_id));
      expect(projection.getTask(String(consumerNode!.task_id))).toBeTruthy();

      const consumerTask = await ctx.repository.getTask(String(consumerNode!.task_id));
      expect(consumerTask).toMatchObject({
        lifecycle: 'open',
        releaseState: 'released',
        backend: 'grok',
        goal: '[workflow:consumer] fan-in next',
      });

      const consumerTurns = await ctx.repository.listTurns(consumerTask!.id);
      expect(consumerTurns).toHaveLength(1);
       expect(consumerTurns[0]).toMatchObject({
         status: 'queued',
         trigger: 'engine',
         sequence: 1,
       });
       await expect(ctx.repository.getTurn(consumerTurns[0]!.id)).resolves.toMatchObject({
         workflowActivation: { isTerminalNode: true },
       });
       expect(projection.getFile().turns[consumerTurns[0]!.id]).toMatchObject({ status: 'queued' });

      const msgId = consumerTurns[0]!.inputs.find((i) => i.kind === 'message')?.messageId;
      expect(msgId).toBeTruthy();
      const msg = await ctx.client.get(
        'SELECT content FROM messages WHERE workspace_id = ? AND id = ?',
        ['ws', msgId],
      );
      const content = String((msg as { content?: string } | undefined)?.content ?? '');
      expect(content.indexOf('from_p1=')).toBeGreaterThanOrEqual(0);
      expect(content.indexOf('from_p2=')).toBeGreaterThanOrEqual(0);
      expect(content.indexOf('from_p1=')).toBeLessThan(content.indexOf('from_p2='));

      await expect(ctx.repository.getTask(p1.taskId)).resolves.toMatchObject({ lifecycle: 'open' });
      await expect(ctx.repository.getTask(p2.taskId)).resolves.toMatchObject({ lifecycle: 'open' });

      const file: TaskStoreFile = {
        schemaVersion: 2,
        revision: 1,
        tasks: { [consumerTask!.id]: consumerTask! },
        turns: { [consumerTurns[0]!.id]: consumerTurns[0]! },
        messages: {},
      };
      expect(canPromoteTurn(file, consumerTurns[0]!.id, DEFAULT_RESOURCE_LIMITS)).toEqual({
        ok: true,
      });

      // Consumer activation remains exactly one after both producers settle.
      expect(await ctx.repository.listTurns(consumerTask!.id)).toHaveLength(1);
      expect(
        await ctx.client.all(
          'SELECT input_ref FROM workflow_gate_fills WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
          ['ws', data.runId, consumerGate!.gateId],
        ),
      ).toHaveLength(2);
    } finally {
      await ctx.close();
    }
  }, 45_000);

  it('three-producer fan-in concurrent final fills', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s02-concurrent-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    const secondClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await firstClient.open(dbPath);
      await secondClient.open(dbPath);
      const first = new SqliteTaskRepository(firstClient, 'ws');
      const second = new SqliteTaskRepository(secondClient, 'ws');
      const topology = {
        kind: 'workflow' as const,
        inputs: [],
        outputs: [
          { name: 'p1Result', semanticKind: 'checkpoint.p1', sourceNodeId: 'p1' },
          { name: 'p2Result', semanticKind: 'checkpoint.p2', sourceNodeId: 'p2' },
          { name: 'p3Result', semanticKind: 'checkpoint.p3', sourceNodeId: 'p3' },
          { name: 'result', semanticKind: 'result', sourceNodeId: 'consumer' },
        ],
        nodes: [
          {
            nodeId: 'p1',
            outcome: {
              kind: 'agent' as const,
              requireExplicitDisposition: true as const,
              next: { when: 'The producer result is ready.' },
              fail: { when: 'The producer cannot be completed.' },
            },
          },
          {
            nodeId: 'p2',
            outcome: {
              kind: 'agent' as const,
              requireExplicitDisposition: true as const,
              next: { when: 'The producer result is ready.' },
              fail: { when: 'The producer cannot be completed.' },
            },
          },
          {
            nodeId: 'p3',
            outcome: {
              kind: 'agent' as const,
              requireExplicitDisposition: true as const,
              next: { when: 'The producer result is ready.' },
              fail: { when: 'The producer cannot be completed.' },
            },
          },
          {
            nodeId: 'consumer',
            outcome: {
              kind: 'agent' as const,
              requireExplicitDisposition: true as const,
              next: { when: 'The consumer result is ready.' },
              fail: { when: 'The consumer cannot be completed.' },
            },
          },
        ],
        edges: [
          { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'from_p1' },
          { fromNodeId: 'p2', toNodeId: 'consumer', inputRef: 'from_p2' },
          { fromNodeId: 'p3', toNodeId: 'consumer', inputRef: 'from_p3' },
        ],
      };
      const createdAt = '2026-07-22T05:00:00.000Z';
      await first.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-three',
        version: 1,
        name: 'three',
        topology,
        createdAt,
      });
      const started = await first.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-three',
        version: 1,
        startIdempotencyKey: 'three-start',
        createdAt,
        goal: 'three producer fan-in',
        backend: 'grok',
      });
      const data = started.operation?.result.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
        nodeGates: Array<{ nodeId: string; gateId: string }>;
      };
      const entries = new Map(data.entries.map((entry) => [entry.nodeId, entry]));
      const gateId = data.nodeGates.find((gate) => gate.nodeId === 'consumer')!.gateId;

      const commandFor = async (
        repository: SqliteTaskRepository,
        nodeId: string,
        result: string,
        finishedAt: string,
      ) => {
        const entry = entries.get(nodeId)!;
        await firstClient.run(
          `UPDATE turns SET status = 'running', started_at = ?
            WHERE workspace_id = 'ws' AND id = ?`,
          [createdAt, entry.activationTurnId],
        );
        const task = await repository.getTask(entry.taskId);
        const turn = await repository.getTurn(entry.activationTurnId);
        const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result };
        await stageDispositionForSettlement(repository, turn!, disposition);
        return {
          kind: 'settleTurnAndApplyEffects' as const,
          workspaceId: 'ws',
          expectedTaskRevision: task!.revision,
          task: { ...task!, updatedAt: finishedAt },
          turn: {
            ...turn!,
            status: 'succeeded' as const,
            finishedAt,
            disposition,
          },
          expectedStatuses: ['running' as const],
          relatedTurns: [],
          messages: [],
        };
      };

      await first.execute(await commandFor(first, 'p1', 'value-one', '2026-07-22T05:01:00.000Z'));
      const p2 = await commandFor(first, 'p2', 'value-two', '2026-07-22T05:02:00.000Z');
      const p3 = await commandFor(second, 'p3', 'value-three', '2026-07-22T05:02:00.000Z');
      const finalResults = await Promise.all([first.execute(p2), second.execute(p3)]);
      expect(finalResults.every((result) => result.changed === true)).toBe(true);

      const gate = await firstClient.get<{ status: string }>(
        `SELECT status FROM workflow_dependency_gates
          WHERE workspace_id = 'ws' AND run_id = ? AND gate_id = ?`,
        [data.runId, gateId],
      );
      expect(gate?.status).toBe('satisfied');
      const consumer = await firstClient.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'consumer'`,
        [data.runId],
      );
      expect(finalResults.some((result) => result.affectedTaskIds?.includes(consumer!.task_id))).toBe(true);
      const turns = await first.listTurns(consumer!.task_id);
      expect(turns).toHaveLength(1);
      const messageId = turns[0]!.inputs.find((input) => input.kind === 'message')?.messageId;
      const message = await firstClient.get<{ content: string }>(
        `SELECT content FROM messages WHERE workspace_id = 'ws' AND id = ?`,
        [messageId!],
      );
      expect(message?.content).toBe(
        '[workflow-aggregate] from_p1=value-one from_p2=value-two from_p3=value-three',
      );
      expect(message?.content).not.toMatch(/missing|\[artifact /);
      expect(
        await firstClient.all(
          `SELECT activation_id FROM workflow_activations
            WHERE workspace_id = 'ws' AND run_id = ? AND source_gate_id = ?`,
          [data.runId, gateId],
        ),
      ).toHaveLength(1);
      await expect(firstClient.get(
        `SELECT workflow_turns_reserved FROM workflow_runs
          WHERE workspace_id = 'ws' AND run_id = ?`,
        [data.runId],
      )).resolves.toEqual({ workflow_turns_reserved: 4 });
    } finally {
      await Promise.all([
        firstClient.close().catch(() => undefined),
        secondClient.close().catch(() => undefined),
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it('concurrent stale final fill at the turn limit fails closed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s02-concurrent-budget-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    const secondClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await firstClient.open(dbPath);
      await secondClient.open(dbPath);
      const first = new SqliteTaskRepository(firstClient, 'ws');
      const second = new SqliteTaskRepository(secondClient, 'ws');
      const createdAt = '2026-07-22T05:30:00.000Z';
      await first.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-concurrent-budget',
        version: 1,
        name: 'concurrent budget',
        topology: FAN_IN_TOPOLOGY,
        policy: { ...DEFAULT_WORKFLOW_POLICY, maxWorkflowTurnsPerRun: 2 },
        createdAt,
      });
      const started = await first.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-concurrent-budget',
        version: 1,
        startIdempotencyKey: 'concurrent-budget-start',
        createdAt,
        goal: 'concurrent budget',
        backend: 'grok',
      });
      const data = started.operation!.result.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
      };
      const entries = new Map(data.entries.map((entry) => [entry.nodeId, entry]));
      const commandFor = async (
        repository: SqliteTaskRepository,
        client: DbClient,
        nodeId: 'p1' | 'p2',
        finishedAt: string,
      ) => {
        const entry = entries.get(nodeId)!;
        await client.run(
          `UPDATE turns SET status = 'running', started_at = ?
            WHERE workspace_id = 'ws' AND id = ?`,
          [createdAt, entry.activationTurnId],
        );
        const task = await repository.getTask(entry.taskId);
        const turn = await repository.getTurn(entry.activationTurnId);
        const disposition = {
          kind: 'workflow_next' as const,
          change: 'updated' as const,
          result: `${nodeId} result`,
        };
        await stageDispositionForSettlement(repository, turn!, disposition);
        return {
          kind: 'settleTurnAndApplyEffects' as const,
          workspaceId: 'ws',
          expectedTaskRevision: task!.revision,
          task: { ...task!, updatedAt: finishedAt },
          turn: { ...turn!, status: 'succeeded' as const, finishedAt, disposition },
          expectedStatuses: ['running' as const],
          relatedTurns: [],
          messages: [],
        };
      };
      const p1 = await commandFor(first, firstClient, 'p1', '2026-07-22T05:31:00.000Z');
      const p2 = await commandFor(second, secondClient, 'p2', '2026-07-22T05:31:00.000Z');
      let transactionArrivals = 0;
      let releaseTransactions!: () => void;
      const transactionBarrier = new Promise<void>((resolve) => {
        releaseTransactions = resolve;
      });
      const stalePlannerRepository = (client: DbClient) => new SqliteTaskRepository({
        all: (sql, params) => client.all(sql, params),
        get: (sql, params) => client.get(sql, params),
        run: (sql, params) => client.run(sql, params),
        pragma: (pragma) => client.pragma(pragma),
        transaction: async (statements, options) => {
          transactionArrivals += 1;
          if (transactionArrivals === 2) releaseTransactions();
          await transactionBarrier;
          return client.transaction(statements, options);
        },
      }, 'ws');
      const staleFirst = stalePlannerRepository(firstClient);
      const staleSecond = stalePlannerRepository(secondClient);
      const results = await Promise.all([staleFirst.execute(p1), staleSecond.execute(p2)]);
      const consumer = await firstClient.get<{ task_id: string; status: string }>(
        `SELECT task_id, status FROM workflow_nodes
          WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'consumer'`,
        [data.runId],
      );
      expect(results.some((result) => result.affectedTaskIds?.includes(consumer!.task_id))).toBe(true);
      await expect(firstClient.get(
        `SELECT status, terminal_reason_code, workflow_turns_reserved
           FROM workflow_runs WHERE workspace_id = 'ws' AND run_id = ?`,
        [data.runId],
      )).resolves.toEqual({
        status: 'failed',
        terminal_reason_code: 'turn_budget_exhausted',
        workflow_turns_reserved: 2,
      });
      expect((await first.getTask(consumer!.task_id))?.lifecycle).toBe('failed');
      expect(await first.listTurns(consumer!.task_id)).toHaveLength(0);
      await expect(firstClient.all(
        `SELECT status FROM workflow_dependency_gates
          WHERE workspace_id = 'ws' AND run_id = ? AND status IN ('open', 'satisfied')`,
        [data.runId],
      )).resolves.toEqual([]);
    } finally {
      await Promise.all([
        firstClient.close().catch(() => undefined),
        secondClient.close().catch(() => undefined),
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it('different final gates share one remaining run turn slot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s02-two-gate-budget-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    const secondClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await firstClient.open(dbPath);
      await secondClient.open(dbPath);
      const first = new SqliteTaskRepository(firstClient, 'ws');
      const second = new SqliteTaskRepository(secondClient, 'ws');
      const createdAt = '2026-07-22T05:40:00.000Z';
      await first.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-two-gate-budget',
        version: 1,
        name: 'two gate budget',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [
            { name: 'p1Result', semanticKind: 'checkpoint.p1', sourceNodeId: 'p1' },
            { name: 'p2Result', semanticKind: 'checkpoint.p2', sourceNodeId: 'p2' },
            { name: 'c1Result', semanticKind: 'result.c1', sourceNodeId: 'c1' },
            { name: 'c2Result', semanticKind: 'result.c2', sourceNodeId: 'c2' },
          ],
          nodes: [
            {
              nodeId: 'p1',
              outcome: {
                kind: 'agent' as const,
                requireExplicitDisposition: true as const,
                next: { when: 'The producer result is ready.' },
                fail: { when: 'The producer cannot be completed.' },
              },
            },
            {
              nodeId: 'p2',
              outcome: {
                kind: 'agent' as const,
                requireExplicitDisposition: true as const,
                next: { when: 'The producer result is ready.' },
                fail: { when: 'The producer cannot be completed.' },
              },
            },
            {
              nodeId: 'c1',
              outcome: {
                kind: 'agent' as const,
                requireExplicitDisposition: true as const,
                next: { when: 'The first consumer result is ready.' },
                fail: { when: 'The first consumer cannot be completed.' },
              },
            },
            {
              nodeId: 'c2',
              outcome: {
                kind: 'agent' as const,
                requireExplicitDisposition: true as const,
                next: { when: 'The second consumer result is ready.' },
                fail: { when: 'The second consumer cannot be completed.' },
              },
            },
          ],
          edges: [
            { fromNodeId: 'p1', toNodeId: 'c1', inputRef: 'from_p1' },
            { fromNodeId: 'p2', toNodeId: 'c2', inputRef: 'from_p2' },
          ],
        },
        policy: { ...DEFAULT_WORKFLOW_POLICY, maxWorkflowTurnsPerRun: 3 },
        createdAt,
      });
      const started = await first.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-two-gate-budget',
        version: 1,
        startIdempotencyKey: 'two-gate-budget-start',
        createdAt,
        goal: 'two gate budget',
        backend: 'grok',
      });
      const data = started.operation!.result.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
      };
      const entries = new Map(data.entries.map((entry) => [entry.nodeId, entry]));
      const commandFor = async (
        repository: SqliteTaskRepository,
        client: DbClient,
        nodeId: 'p1' | 'p2',
      ) => {
        const entry = entries.get(nodeId)!;
        await client.run(
          `UPDATE turns SET status='running', started_at=? WHERE workspace_id='ws' AND id=?`,
          [createdAt, entry.activationTurnId],
        );
        const task = await repository.getTask(entry.taskId);
        const turn = await repository.getTurn(entry.activationTurnId);
        const disposition = {
          kind: 'workflow_next' as const,
          change: 'updated' as const,
          result: `${nodeId} result`,
        };
        await stageDispositionForSettlement(repository, turn!, disposition);
        return {
          kind: 'settleTurnAndApplyEffects' as const,
          workspaceId: 'ws',
          expectedTaskRevision: task!.revision,
          task: { ...task!, updatedAt: '2026-07-22T05:41:00.000Z' },
          turn: {
            ...turn!, status: 'succeeded' as const,
            finishedAt: '2026-07-22T05:41:00.000Z', disposition,
          },
          expectedStatuses: ['running' as const],
          relatedTurns: [],
          messages: [],
        };
      };
      const p1 = await commandFor(first, firstClient, 'p1');
      const p2 = await commandFor(second, secondClient, 'p2');
      let transactionArrivals = 0;
      let promotedBetweenPlanAndCommit = false;
      let releaseTransactions!: () => void;
      const transactionBarrier = new Promise<void>((resolve) => {
        releaseTransactions = resolve;
      });
      const stalePlannerRepository = (client: DbClient) => new SqliteTaskRepository({
        all: (sql, params) => client.all(sql, params),
        get: (sql, params) => client.get(sql, params),
        run: (sql, params) => client.run(sql, params),
        pragma: (pragma) => client.pragma(pragma),
        transaction: async (statements, options) => {
          transactionArrivals += 1;
          if (transactionArrivals === 2) releaseTransactions();
          await transactionBarrier;
          if (transactionArrivals >= 3 && !promotedBetweenPlanAndCommit) {
            promotedBetweenPlanAndCommit = true;
            await client.run(
              `UPDATE turns SET status='running', started_at=?
                WHERE workspace_id='ws' AND status='queued' AND task_id IN (
                  SELECT task_id FROM workflow_nodes
                   WHERE workspace_id='ws' AND run_id=? AND node_id IN ('c1','c2')
                )`,
              ['2026-07-22T05:41:30.000Z', data.runId],
            );
          }
          return client.transaction(statements, options);
        },
      }, 'ws');
      const results = await Promise.all([
        stalePlannerRepository(firstClient).execute(p1),
        stalePlannerRepository(secondClient).execute(p2),
      ]);
      expect(results.every((result) => result.changed)).toBe(true);
      await expect(firstClient.get(
        `SELECT status, terminal_reason_code, workflow_turns_reserved
           FROM workflow_runs WHERE workspace_id='ws' AND run_id=?`,
        [data.runId],
      )).resolves.toEqual({
        status: 'failed',
        terminal_reason_code: 'turn_budget_exhausted',
        workflow_turns_reserved: 3,
      });
      await expect(firstClient.get(
        `SELECT COUNT(*) AS count FROM turns
          WHERE workspace_id='ws' AND task_id IN (
            SELECT task_id FROM workflow_nodes
             WHERE workspace_id='ws' AND run_id=? AND node_id IN ('c1','c2')
          )`,
        [data.runId],
      )).resolves.toEqual({ count: 1 });
      expect(promotedBetweenPlanAndCommit).toBe(true);
      await expect(firstClient.get(
        `SELECT COUNT(*) AS count FROM turn_cancel_requests
          WHERE workspace_id='ws' AND kind='interrupt' AND task_id IN (
            SELECT task_id FROM workflow_nodes
             WHERE workspace_id='ws' AND run_id=? AND node_id IN ('c1','c2')
          )`,
        [data.runId],
      )).resolves.toEqual({ count: 1 });
      await expect(firstClient.get(
        `SELECT COUNT(*) AS count FROM workflow_activations
          WHERE workspace_id='ws' AND run_id=? AND node_id IN ('c1','c2')`,
        [data.runId],
      )).resolves.toEqual({ count: 1 });
    } finally {
      await Promise.all([
        firstClient.close().catch(() => undefined),
        secondClient.close().catch(() => undefined),
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it('aggregate exact byte limit and one-byte overflow', async () => {
    const expectedAggregate = '[workflow-aggregate] from_p1=é from_p2=value-two';
    const exactBytes = Buffer.byteLength(expectedAggregate, 'utf8');
    expect(exactBytes).toBeGreaterThan(expectedAggregate.length);

    for (const overflow of [false, true]) {
      const ctx = await openRepo(overflow ? 'aggregate-overflow' : 'aggregate-exact');
      try {
        const createdAt = '2026-07-22T07:00:00.000Z';
        const policy = {
          ...DEFAULT_WORKFLOW_POLICY,
          maxArtifactBytes: 16,
          maxAggregateBytes: exactBytes - (overflow ? 1 : 0),
        };
        const definition = makeGraphFanInDefinition({
          definitionId: overflow ? 'wf-aggregate-overflow' : 'wf-aggregate-exact',
          createdAt,
          policy,
        });
        await expect(ctx.repository.execute({
          kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: definition.definitionId,
          version: definition.version, name: definition.name, topology: definition.topology,
          entryContracts: definition.entryContracts, policy: definition.policy, createdAt,
        })).resolves.toMatchObject({ ok: true, changed: true });
        const start = await ctx.repository.execute({
          kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: definition.definitionId,
          version: definition.version, startIdempotencyKey: `aggregate-${overflow ? 'over' : 'exact'}`,
          createdAt, goal: 'aggregate boundary', backend: 'grok',
        });
        const data = start.operation?.result.data as {
          runId: string;
          entries: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
          nodeGates: Array<{ nodeId: string; gateId: string }>;
        };
        const entries = new Map(data.entries.map((entry) => [entry.nodeId, entry]));
        const gateId = data.nodeGates.find((gate) => gate.nodeId === 'consumer')!.gateId;
        const settle = async (nodeId: 'p1' | 'p2', result: string, finishedAt: string) => {
          const entry = entries.get(nodeId)!;
          await ctx.client.run(
            `UPDATE turns SET status = 'running', started_at = ?
              WHERE workspace_id = 'ws' AND id = ?`,
            [createdAt, entry.activationTurnId],
          );
          const task = await ctx.repository.getTask(entry.taskId);
          const turn = await ctx.repository.getTurn(entry.activationTurnId);
          const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result };
          await stageDispositionForSettlement(ctx.repository, turn!, disposition);
          return ctx.repository.execute({
            kind: 'settleTurnAndApplyEffects', workspaceId: 'ws', expectedTaskRevision: task!.revision,
            task: { ...task!, updatedAt: finishedAt },
            turn: {
              ...turn!, status: 'succeeded', finishedAt,
              disposition,
            },
            expectedStatuses: ['running'], relatedTurns: [], messages: [],
          });
        };

        await expect(settle('p1', 'é', '2026-07-22T07:01:00.000Z')).resolves.toMatchObject({ changed: true });
        await expect(settle('p2', 'value-two', '2026-07-22T07:02:00.000Z')).resolves.toMatchObject({ changed: true });

        const run = await ctx.client.get<{ status: string; terminal_reason_code: string | null }>(
          `SELECT status, terminal_reason_code FROM workflow_runs
            WHERE workspace_id = 'ws' AND run_id = ?`,
          [data.runId],
        );
        const gate = await ctx.client.get<{ status: string }>(
          `SELECT status FROM workflow_dependency_gates
            WHERE workspace_id = 'ws' AND run_id = ? AND gate_id = ?`,
          [data.runId, gateId],
        );
        const consumer = await ctx.client.get<{ task_id: string | null }>(
          `SELECT task_id FROM workflow_nodes
            WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'consumer'`,
          [data.runId],
        );
        const activations = await ctx.client.all(
          `SELECT activation_id FROM workflow_activations
            WHERE workspace_id = 'ws' AND run_id = ? AND source_gate_id = ?`,
          [data.runId, gateId],
        );

        if (overflow) {
          expect(run).toEqual({ status: 'failed', terminal_reason_code: 'aggregate_too_large' });
          expect(gate).toEqual({ status: 'failed' });
          expect(consumer?.task_id).toEqual(expect.any(String));
          expect(activations).toHaveLength(0);
          expect(await ctx.client.all(
            `SELECT id FROM messages WHERE workspace_id = 'ws' AND content LIKE '[workflow-aggregate]%'`,
          )).toHaveLength(0);
          const shellTask = await ctx.repository.getTask(consumer!.task_id!);
          expect(shellTask?.workflowShell).toMatchObject({ runId: data.runId, nodeId: 'consumer' });
          expect(shellTask?.lifecycle).toBe('failed');
          expect(await ctx.repository.listTurns(consumer!.task_id!)).toHaveLength(0);
          const revision = await ctx.repository.getWorkspaceRevision();
          const taskEffects = await ctx.client.all<{ entity_id: string }>(
            `SELECT entity_id FROM change_log
              WHERE workspace_id = 'ws' AND revision = ? AND entity_kind = 'task'`,
            [revision],
          );
          expect(taskEffects.map((row) => row.entity_id)).toContain(consumer!.task_id!);
        } else {
          expect(run).toEqual({ status: 'running', terminal_reason_code: null });
          expect(gate).toEqual({ status: 'satisfied' });
          expect(consumer?.task_id).toEqual(expect.any(String));
          expect(activations).toHaveLength(1);
          const messages = await ctx.repository.listMessages(consumer!.task_id!);
          expect(messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ content: expectedAggregate }),
          ]));
          expect(Buffer.byteLength(expectedAggregate, 'utf8')).toBe(policy.maxAggregateBytes);
          const consumerTask = await ctx.repository.getTask(consumer!.task_id!);
          expect(consumerTask?.workflowShell).toBeUndefined();
        }
      } finally {
        await ctx.close();
      }
    }
  }, 45_000);

  it('M018 S02 flow: public define graph_v1 + start activates only entry producers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s02-named-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    let engine: TaskEngine | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let releaseWorkflowWorkers!: () => void;
    const workflowWorkersGate = new Promise<void>((resolve) => {
      releaseWorkflowWorkers = resolve;
    });
    let runInvocation = 0;
    let workflowRefForTranscript = '';
    try {
      await client.open(dbPath);
      const workspaceId = 'ws-m018-s02-bridge';
      const repository = new SqliteTaskRepository(client, workspaceId);
      await repository.execute({
        kind: 'upsertWorkspace',
        workspaceId,
        identityKey: 'm018-s02-bridge',
        displayName: 'M018 S02 bridge',
        createdAt: '2026-07-19T00:00:00.000Z',
        lastOpenedAt: '2026-07-19T00:00:00.000Z',
      });
      const credentials = new CredentialRegistry();
      engine = await TaskEngine.loadAsync({
        repository,
        workspaceId,
        credentialRegistry: credentials,
        makeBackend: (name) => ({
          name,
          capabilities: {
            supportsMCP: true,
            supportsReasoning: false,
            supportsDetailedToolEvents: false,
          },
          run: async function* () {},
        }),
        runTurn: async function* (_backend, options) {
          runInvocation += 1;
          if (runInvocation === 1) {
            await gate;
            yield {
              type: 'toolStarted',
              toolCallId: 'start-workflow-call',
              name: 'muster_bridge_start_workflow',
              kind: 'mcp',
              input: { workflow: workflowRefForTranscript, inputs: [] },
            };
            yield {
              type: 'toolCompleted',
              toolCallId: 'start-workflow-call',
              outcome: 'success',
              output: { status: 'accepted' },
            };
            if (options.signal?.aborted) {
              yield {
                type: 'assistantDelta',
                messageId: 'codex-interruption-notice',
                content: '*Conversation interrupted*',
              };
              yield { type: 'error', message: 'cancelled', isCancellation: true };
            }
            return;
          }
          if (runInvocation <= 3) {
            await workflowWorkersGate;
          } else {
            await resumeGate;
          }
          yield { type: 'turnCompleted' };
        },
        getTaskTypeRegistry: () =>
          parseTaskTypeRegistry({
            worker: { backend: 'grok', role: 'worker', briefKind: 'generic' },
          }),
      });

      const started = await engine.startNewTask({
        goal: 'coordinate fan-in define/start',
        backend: 'grok',
        role: 'coordinator',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const { taskId, turnId } = started.value;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await repository.getTurn(turnId))?.status === 'running') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await expect(repository.getTurn(turnId)).resolves.toMatchObject({ status: 'running' });

      const token = credentials.issue({
        rootId: taskId,
        callerTaskId: taskId,
        turnId,
        attemptId: 'att-s02',
        allowedActions: new Set(['define_workflow', 'start_workflow', 'inspect_workflow_run']),
        ttlMs: 60_000,
      });
      const context = credentials.verify(token)!;

      const defineRouted = dispatch(
        'define_workflow',
        {
          manifest: {
            schema: 'muster.workflow/v2',
            name: 'public-fan-in',
            inputs: [],
             outputs: [
               { name: 'p1Result', kind: 'checkpoint.p1', from: 'p1' },
               { name: 'p2Result', kind: 'checkpoint.p2', from: 'p2' },
               { name: 'result', kind: 'result', from: 'consumer' },
             ],
            nodes: FAN_IN_TOPOLOGY.nodes.map((node) => ({
               nodeKey: node.nodeId,
               taskType: 'worker',
               outcome: node.outcome,
             })),
            edges: FAN_IN_TOPOLOGY.edges.map((edge) => ({
              from: edge.fromNodeId,
              to: edge.toNodeId,
              inputRef: edge.inputRef,
            })),
          },
        },
        context,
      );
      expect(defineRouted.ok).toBe(true);
      if (!defineRouted.ok) return;
      if (defineRouted.command.kind !== 'define_workflow') return;
      const definitionId = defineRouted.command.definitionId;
      workflowRefForTranscript = `${definitionId}@1`;
      const defined = await engine.handleToolCall(
        context,
        'define_workflow',
        defineRouted.command,
      );
      expect(defined).toMatchObject({
        ok: true,
        result: { changed: true, definitionId },
      });

      const startRouted = dispatch(
        'start_workflow',
        {
          workflow: workflowRefForTranscript,
          goal: 'activate fan-in via bridge',
          inputs: [],
        },
        context,
      );
      expect(startRouted.ok).toBe(true);
      if (!startRouted.ok) return;
      const startedWf = await engine.handleToolCall(
        context,
        'start_workflow',
        startRouted.command,
      );
      expect(startedWf.ok).toBe(true);
      if (!startedWf.ok) return;
      const payload = startedWf.result as {
        runId: string;
        entries?: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
        nodeGates?: Array<{ nodeId: string; gateId: string }>;
        changed: boolean;
      };
      expect(payload.runId).toBeTruthy();
      expect(payload.changed).toBe(true);
      expect(payload.entries?.map((e) => e.nodeId).sort()).toEqual(['p1', 'p2']);

      const pendingContinuation = await client.get<{
        continuation_id: string;
        status: string;
      }>(
        `SELECT continuation_id, status
           FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ? AND kind = 'start_wait'`,
        [workspaceId, payload.runId],
      );
      expect(pendingContinuation).toMatchObject({ status: 'pending' });

      release();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await repository.getTurn(turnId))?.status === 'succeeded') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await expect(repository.getTurn(turnId)).resolves.toMatchObject({ status: 'succeeded' });
      const suspendedTurnMessages = (await repository.listMessages(taskId))
        .filter((message) => message.turnId === turnId)
        .map((message) => message.content);
      expect(suspendedTurnMessages).toContain('*Workflow dispatched. Waiting for results...*');
      expect(suspendedTurnMessages).not.toContain('*Conversation interrupted*');

      const nodes = await client.all(
        'SELECT node_id, task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? ORDER BY node_id',
        [workspaceId, payload.runId],
      );
      expect(nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ node_id: 'p1', status: 'active' }),
          expect.objectContaining({ node_id: 'p2', status: 'active' }),
          expect.objectContaining({ node_id: 'consumer', status: 'pending', task_id: expect.any(String) }),
        ]),
      );
      const consumerNode = nodes.find((n: any) => n.node_id === 'consumer');
      const consumerTask = await repository.getTask(consumerNode!.task_id);
      expect(consumerTask?.workflowShell).toMatchObject({ runId: payload.runId, nodeId: 'consumer' });
      expect(await repository.listTurns(consumerNode!.task_id)).toHaveLength(0);

      const consumerGate = payload.nodeGates?.find((g) => g.nodeId === 'consumer');
      expect(consumerGate).toBeTruthy();
      const gateRow = await client.get(
        'SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        [workspaceId, payload.runId, consumerGate!.gateId],
      );
      expect(gateRow).toMatchObject({ status: 'open' });

      await engine.getRepository().execute({
        kind: 'reapWorkflowTimeouts',
        workspaceId,
        now: '2126-07-22T00:00:00.000Z',
      });
      releaseWorkflowWorkers();

      let resolvedContinuation: {
        status: string;
        resume_turn_id: string | null;
      } | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        resolvedContinuation = await client.get<{
          status: string;
          resume_turn_id: string | null;
        }>(
          `SELECT status, json_extract(payload_json, '$.resumeTurnId') AS resume_turn_id
             FROM workflow_continuations
            WHERE workspace_id = ? AND continuation_id = ?`,
          [workspaceId, pendingContinuation!.continuation_id],
        );
        if (resolvedContinuation?.status === 'resolved') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      expect(resolvedContinuation).toMatchObject({
        status: 'resolved',
        resume_turn_id: expect.any(String),
      });

      const completion = await repository.getWorkflowRunCompletion(payload.runId, taskId);
      expect(completion).toMatchObject({
        runStatus: 'failed',
        terminalReason: 'run_timeout',
      });
      const resumeTurn = await repository.getTurn(resolvedContinuation!.resume_turn_id!);
      expect(resumeTurn).toMatchObject({
        taskId,
        workflowResume: {
          kind: 'start_workflow',
          runId: payload.runId,
          continuationId: pendingContinuation!.continuation_id,
        },
      });
      expect(['queued', 'running']).toContain(resumeTurn?.status);
      await expect(engine.getRepository().execute({
        kind: 'resolveWorkflowStartContinuation',
        workspaceId,
        now: '2126-07-22T00:00:01.000Z',
      })).resolves.toMatchObject({ changed: false });
      const resumeCount = await client.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM turns WHERE workspace_id = ? AND id = ?',
        [workspaceId, resolvedContinuation!.resume_turn_id!],
      );
      expect(resumeCount?.count).toBe(1);

    } finally {
      release();
      releaseWorkflowWorkers();
      releaseResume();
      await engine?.shutdown().catch(() => undefined);
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
