/**
 * M018 S03 named flow:
 * two-producer fan-in graph_v1 → partial NEXT contribution →
 * (a) transaction-fault rollback at settle commit boundary,
 * (b) full reload (client.close + reopen + TaskEngine.loadAsync) between fills,
 * (c) operations-ledger prune + redelivery remains a true no-op under the
 * durable workflow_routed_messages contribution fence (D050 / R027).
 *
 * Uses real SQLite worker + repository settle path; fault injection is
 * explicit via DbClient faultCapability + faultPlan (never ambient env).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CredentialRegistry } from '../bridge/credentials';
import { TaskEngine } from './engine';
import { parseTaskTypeRegistry } from './task-types';
import { SqliteTaskRepository } from './repository';
import { DbClient, DbWorkerError } from './sqlite/client';
import {
  deriveNextContributionMessageId,
  deriveProducerArtifactId,
  deriveProducerArtifactRevision,
  entryNodeIds,
  makeGraphFanInDefinition,
} from './workflow';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

type StartPayload = {
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

type Opened = {
  dir: string;
  dbPath: string;
  client: DbClient;
  repository: SqliteTaskRepository;
  close: () => Promise<void>;
};

async function openRepo(
  label: string,
  opts: {
    faultCapability?: boolean;
    faultPlan?: { code: 'full' | 'io' | 'busy' | 'readonly'; operation: 'transaction'; remaining: number };
  } = {},
): Promise<Opened> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s03-${label}-`));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
    ...(opts.faultCapability
      ? {
          faultCapability: true,
          ...(opts.faultPlan ? { faultPlan: opts.faultPlan } : {}),
        }
      : {}),
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

async function defineAndStart(
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
  expect(defined.changed).toBe(true);

  const start = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId: def.definitionId,
    version: def.version,
    startIdempotencyKey: startKey,
    createdAt,
    goal: 's03 reload redelivery',
    backend: 'grok',
  });
  expect(start.ok).toBe(true);
  expect(start.changed).toBe(true);
  const data = start.operation?.result?.data as StartPayload;
  expect(data.runId).toBeTruthy();
  expect(data.entries.map((e) => e.nodeId).sort()).toEqual(['p1', 'p2']);
  return data;
}

async function markRunning(
  client: DbClient,
  turnId: string,
  startedAt: string,
): Promise<void> {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL
      WHERE workspace_id = ? AND id = ?`,
    [startedAt, 'ws', turnId],
  );
}

async function settleNext(
  repository: SqliteTaskRepository,
  entry: { taskId: string; activationTurnId: string },
  result: string,
  finishedAt: string,
) {
  const task = await repository.getTask(entry.taskId);
  const turn = await repository.getTurn(entry.activationTurnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  return repository.execute({
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
      disposition: { kind: 'workflow_next', change: 'updated', result },
    },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  });
}

async function workflowSnapshot(
  client: DbClient,
  repository: SqliteTaskRepository,
  runId: string,
  consumerGateId: string,
) {
  const revision = await repository.getWorkspaceRevision();
  // Contribution artifacts only — start-run seed artifacts are out of scope.
  const artifacts = await client.all(
    `SELECT producer_node_id, revision, kind FROM workflow_artifacts
      WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'
      ORDER BY producer_node_id, revision`,
    ['ws', runId],
  );
  const fills = await client.all(
    `SELECT input_ref, artifact_id, artifact_revision FROM workflow_gate_fills
      WHERE workspace_id = ? AND run_id = ? AND gate_id = ?
      ORDER BY input_ref`,
    ['ws', runId, consumerGateId],
  );
  const gate = await client.get(
    `SELECT status FROM workflow_dependency_gates
      WHERE workspace_id = ? AND run_id = ? AND gate_id = ?`,
    ['ws', runId, consumerGateId],
  );
  const nodes = await client.all(
    `SELECT node_id, task_id, status FROM workflow_nodes
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY node_id`,
    ['ws', runId],
  );
  const routed = await client.all(
    `SELECT message_id, kind, source_node_id, destination_node_id, body_json
       FROM workflow_routed_messages
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY source_node_id`,
    ['ws', runId],
  );
  return { revision, artifacts, fills, gate, nodes, routed };
}

describe('M018 S03 reload and redelivery safety', () => {
  it('transaction fault at NEXT settle rolls back atomically; turn stays live and resettleable', async () => {
    // Seed workflow without faults so define/start land cleanly.
    const seed = await openRepo('fault-seed');
    const createdAt = '2026-07-20T01:00:00.000Z';
    let data: StartPayload;
    let consumerGateId: string;
    let p1: StartPayload['entries'][number];
    let preFault: Awaited<ReturnType<typeof workflowSnapshot>>;
    try {
      data = await defineAndStart(seed.repository, createdAt, 's03-fault-1');
      consumerGateId = data.nodeGates.find((g) => g.nodeId === 'consumer')!.gateId;
      p1 = data.entries.find((e) => e.nodeId === 'p1')!;
      await markRunning(seed.client, p1.activationTurnId, createdAt);
      preFault = await workflowSnapshot(seed.client, seed.repository, data.runId, consumerGateId);
      expect(preFault.fills).toEqual([]);
      expect(preFault.gate).toMatchObject({ status: 'open' });
      expect(preFault.routed).toEqual([]);
      expect(
        preFault.nodes.find((n) => n.node_id === 'consumer'),
      ).toMatchObject({ task_id: null, status: 'pending' });
    } finally {
      // Keep the DB file; only close the client.
      await seed.client.close().catch(() => undefined);
    }

    // Reopen with an armed commit-boundary fault for the next transaction.
    const faultClient = new DbClient({
      workerPath: WORKER_TS,
      execArgv: TSX_ARGV,
      faultCapability: true,
      faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
    });
    try {
      await faultClient.open(seed.dbPath);
      const repository = new SqliteTaskRepository(faultClient, 'ws');
      const beforeRevision = await repository.getWorkspaceRevision();
      expect(beforeRevision).toBe(preFault.revision);

      await expect(
        settleNext(repository, p1, 'p1-should-not-persist', '2026-07-20T01:01:00.000Z'),
      ).rejects.toBeInstanceOf(DbWorkerError);

      // Workspace revision and workflow rows unchanged after fault.
      expect(await repository.getWorkspaceRevision()).toBe(beforeRevision);
      const afterFault = await workflowSnapshot(
        faultClient,
        repository,
        data.runId,
        consumerGateId,
      );
      expect(afterFault.revision).toBe(preFault.revision);
      expect(afterFault.artifacts).toEqual(preFault.artifacts);
      expect(afterFault.fills).toEqual(preFault.fills);
      expect(afterFault.gate).toEqual(preFault.gate);
      expect(afterFault.nodes).toEqual(preFault.nodes);
      expect(afterFault.routed).toEqual(preFault.routed);

      // Source turn remains live / resettleable (not terminal).
      const turnAfterFault = await repository.getTurn(p1.activationTurnId);
      expect(turnAfterFault?.status).toBe('running');
      expect(turnAfterFault?.finishedAt).toBeUndefined();
    } finally {
      await faultClient.close().catch(() => undefined);
    }

    // Reopen clean client: same pre-fault snapshot, then successful resettle.
    const recovered = await reopenDb(seed.dbPath);
    try {
      const afterReopen = await workflowSnapshot(
        recovered.client,
        recovered.repository,
        data.runId,
        consumerGateId,
      );
      expect(afterReopen.revision).toBe(preFault.revision);
      expect(afterReopen.fills).toEqual([]);
      expect(afterReopen.routed).toEqual([]);
      expect(afterReopen.gate).toMatchObject({ status: 'open' });
      expect(
        afterReopen.nodes.find((n) => n.node_id === 'consumer'),
      ).toMatchObject({ task_id: null, status: 'pending' });

      // Ensure turn is running for resettle (fault rolled back settle).
      await markRunning(recovered.client, p1.activationTurnId, '2026-07-20T01:02:00.000Z');
      const resettle = await settleNext(
        recovered.repository,
        p1,
        'p1-result',
        '2026-07-20T01:02:00.000Z',
      );
      expect(resettle.ok).toBe(true);
      expect(resettle.changed).toBe(true);

      const afterResettle = await workflowSnapshot(
        recovered.client,
        recovered.repository,
        data.runId,
        consumerGateId,
      );
      expect(afterResettle.fills).toEqual([
        expect.objectContaining({
          input_ref: 'from_p1',
          artifact_revision: deriveProducerArtifactRevision('updated'),
        }),
      ]);
      expect(afterResettle.gate).toMatchObject({ status: 'open' });
      expect(afterResettle.routed).toHaveLength(1);
      expect(afterResettle.routed[0]).toMatchObject({
        kind: 'next_contribution',
        source_node_id: 'p1',
        destination_node_id: 'consumer',
        message_id: deriveNextContributionMessageId(
          data.runId,
          consumerGateId,
          'from_p1',
          'p1',
        ),
      });
      // Partial fill never activates consumer.
      expect(
        afterResettle.nodes.find((n) => n.node_id === 'consumer'),
      ).toMatchObject({ task_id: null, status: 'pending' });
      expect(afterResettle.revision).toBeGreaterThan(preFault.revision);

      // body_json hygiene: identities only — no result body / SQL / paths.
      const body = String(afterResettle.routed[0]!.body_json);
      expect(body).not.toContain('p1-result');
      expect(body).not.toMatch(/SELECT |INSERT |DELETE /i);
      expect(body).toContain('next_contribution');
      expect(body).toContain('artifactRevision');
    } finally {
      await recovered.close();
      fs.rmSync(seed.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('reload between partial and final fill does not duplicate fill; final fill activates exactly once', async () => {
    const opened = await openRepo('reload');
    const createdAt = '2026-07-20T02:00:00.000Z';
    let data: StartPayload;
    let consumerGateId: string;
    let p1: StartPayload['entries'][number];
    let p2: StartPayload['entries'][number];
    let afterPartial: Awaited<ReturnType<typeof workflowSnapshot>>;
    try {
      data = await defineAndStart(opened.repository, createdAt, 's03-reload-1');
      consumerGateId = data.nodeGates.find((g) => g.nodeId === 'consumer')!.gateId;
      p1 = data.entries.find((e) => e.nodeId === 'p1')!;
      p2 = data.entries.find((e) => e.nodeId === 'p2')!;

      await markRunning(opened.client, p1.activationTurnId, createdAt);
      const first = await settleNext(
        opened.repository,
        p1,
        'p1-result',
        '2026-07-20T02:01:00.000Z',
      );
      expect(first.ok).toBe(true);
      expect(first.changed).toBe(true);

      afterPartial = await workflowSnapshot(
        opened.client,
        opened.repository,
        data.runId,
        consumerGateId,
      );
      expect(afterPartial.fills).toEqual([
        expect.objectContaining({ input_ref: 'from_p1', artifact_revision: 1 }),
      ]);
      expect(afterPartial.gate).toMatchObject({ status: 'open' });
      expect(afterPartial.routed).toHaveLength(1);
      expect(
        afterPartial.nodes.find((n) => n.node_id === 'consumer'),
      ).toMatchObject({ task_id: null, status: 'pending' });
    } finally {
      await opened.client.close().catch(() => undefined);
    }

    // Full reload: reopen store + TaskEngine.loadAsync (reconcile path).
    const reloaded = await reopenDb(opened.dbPath);
    let engine: TaskEngine | undefined;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const credentials = new CredentialRegistry();
      engine = await TaskEngine.loadAsync({
        repository: reloaded.repository,
        workspaceId: 'ws',
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
        runTurn: async function* () {
          await hold;
          yield { type: 'turnCompleted' };
        },
        getTaskTypeRegistry: () =>
          parseTaskTypeRegistry({
            worker: { backend: 'grok', role: 'worker', briefKind: 'generic' },
          }),
      });

      const afterReload = await workflowSnapshot(
        reloaded.client,
        reloaded.repository,
        data.runId,
        consumerGateId,
      );
      // Reload must not duplicate the partial fill or close the gate.
      expect(afterReload.fills).toEqual(afterPartial.fills);
      expect(afterReload.gate).toMatchObject({ status: 'open' });
      expect(afterReload.routed).toHaveLength(1);
      expect(afterReload.artifacts).toEqual([
        {
          producer_node_id: 'p1',
          revision: 1,
          kind: 'next_result',
        },
      ]);
      expect(
        afterReload.nodes.find((n) => n.node_id === 'consumer'),
      ).toMatchObject({ task_id: null, status: 'pending' });

      // Final contribution after reload closes gate and queues one consumer.
      await markRunning(reloaded.client, p2.activationTurnId, '2026-07-20T02:02:00.000Z');
      const second = await settleNext(
        reloaded.repository,
        p2,
        'p2-result',
        '2026-07-20T02:02:00.000Z',
      );
      expect(second.ok).toBe(true);
      expect(second.changed).toBe(true);

      const afterFinal = await workflowSnapshot(
        reloaded.client,
        reloaded.repository,
        data.runId,
        consumerGateId,
      );
      expect(afterFinal.fills.map((f) => f.input_ref).sort()).toEqual(['from_p1', 'from_p2']);
      expect(afterFinal.fills.every((f) => f.artifact_revision === 1)).toBe(true);
      expect(afterFinal.gate).toMatchObject({ status: 'satisfied' });
      expect(afterFinal.routed).toHaveLength(2);
      expect(afterFinal.artifacts).toEqual([
        { producer_node_id: 'p1', revision: 1, kind: 'next_result' },
        { producer_node_id: 'p2', revision: 1, kind: 'next_result' },
      ]);

      const consumerNode = afterFinal.nodes.find((n) => n.node_id === 'consumer');
      expect(consumerNode?.task_id).toEqual(expect.any(String));
      expect(consumerNode?.status).toBe('active');
      const consumerTaskId = String(consumerNode!.task_id);
      const consumerTurns = await reloaded.repository.listTurns(consumerTaskId);
      expect(consumerTurns).toHaveLength(1);
      expect(consumerTurns[0]).toMatchObject({
        status: 'queued',
        trigger: 'engine',
        sequence: 1,
      });
      const messages = await reloaded.repository.listMessages(consumerTaskId);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content.startsWith('[workflow-aggregate]')).toBe(true);

      // Producers remain open (NEXT does not seal lifecycle).
      expect((await reloaded.repository.getTask(p1.taskId))?.lifecycle).toBe('open');
      expect((await reloaded.repository.getTask(p2.taskId))?.lifecycle).toBe('open');
    } finally {
      release();
      await engine?.whenIdle?.().catch(() => undefined);
      await reloaded.close();
      fs.rmSync(opened.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('post-prune NEXT redelivery is a no-op under durable contribution fence', async () => {
    const ctx = await openRepo('post-prune');
    try {
      const createdAt = '2026-07-20T03:00:00.000Z';
      const data = await defineAndStart(ctx.repository, createdAt, 's03-prune-1');
      const consumerGateId = data.nodeGates.find((g) => g.nodeId === 'consumer')!.gateId;
      const p1 = data.entries.find((e) => e.nodeId === 'p1')!;
      const p2 = data.entries.find((e) => e.nodeId === 'p2')!;

      await markRunning(ctx.client, p1.activationTurnId, createdAt);
      expect(
        (await settleNext(ctx.repository, p1, 'p1-result', '2026-07-20T03:01:00.000Z')).ok,
      ).toBe(true);

      await markRunning(ctx.client, p2.activationTurnId, '2026-07-20T03:02:00.000Z');
      expect(
        (await settleNext(ctx.repository, p2, 'p2-result', '2026-07-20T03:02:00.000Z')).ok,
      ).toBe(true);

      const consumerNode = await ctx.client.get<{ task_id: string; status: string }>(
        `SELECT task_id, status FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = ?`,
        ['ws', data.runId, 'consumer'],
      );
      expect(consumerNode?.task_id).toEqual(expect.any(String));
      expect(consumerNode?.status).toBe('active');
      const consumerTaskId = consumerNode!.task_id;
      const consumerTurnsBefore = await ctx.repository.listTurns(consumerTaskId);
      expect(consumerTurnsBefore).toHaveLength(1);
      const activationTurnId = consumerTurnsBefore[0]!.id;
      const messagesBefore = await ctx.repository.listMessages(consumerTaskId);
      expect(messagesBefore).toHaveLength(1);
      const messageId = messagesBefore[0]!.id;

      const expectedFenceIds = [
        deriveNextContributionMessageId(data.runId, consumerGateId, 'from_p1', 'p1'),
        deriveNextContributionMessageId(data.runId, consumerGateId, 'from_p2', 'p2'),
      ].sort();
      const routedBefore = (
        await ctx.client.all<{ message_id: string }>(
          `SELECT message_id FROM workflow_routed_messages
            WHERE workspace_id = ? AND run_id = ?`,
          ['ws', data.runId],
        )
      )
        .map((r) => r.message_id)
        .sort();
      expect(routedBefore).toEqual(expectedFenceIds);

      // Deterministic revision: one artifact row per producer at revision 1.
      expect(
        await ctx.client.all(
          `SELECT producer_node_id, revision FROM workflow_artifacts
            WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'
            ORDER BY producer_node_id, revision`,
          ['ws', data.runId],
        ),
      ).toEqual([
        { producer_node_id: 'p1', revision: 1 },
        { producer_node_id: 'p2', revision: 1 },
      ]);
      expect(deriveProducerArtifactId(data.runId, 'p2')).toMatch(/^wfa_/);

      // Simulate retention prune of the producer turn's operations ledger.
      await ctx.client.run(
        `DELETE FROM operations WHERE workspace_id = ? AND ledger_key GLOB ?`,
        ['ws', `${p2.activationTurnId}:*`],
      );
      // Force turn back to live so settle path is re-entered.
      await markRunning(ctx.client, p2.activationTurnId, '2026-07-20T03:03:00.000Z');

      const postPrune = await settleNext(
        ctx.repository,
        p2,
        'p2-result-again',
        '2026-07-20T03:03:00.000Z',
      );
      expect(postPrune.ok).toBe(true);
      // Turn may re-settle, but contribution fence suppresses workflow side effects.

      const after = await workflowSnapshot(
        ctx.client,
        ctx.repository,
        data.runId,
        consumerGateId,
      );
      expect(after.gate).toMatchObject({ status: 'satisfied' });
      expect(after.fills).toHaveLength(2);
      expect(after.fills.map((f) => f.input_ref).sort()).toEqual(['from_p1', 'from_p2']);
      expect(after.fills.every((f) => f.artifact_revision === 1)).toBe(true);
      expect(after.artifacts).toHaveLength(2);
      expect(after.artifacts).toEqual([
        { producer_node_id: 'p1', revision: 1, kind: 'next_result' },
        { producer_node_id: 'p2', revision: 1, kind: 'next_result' },
      ]);

      const consumerTurnsAfter = await ctx.repository.listTurns(consumerTaskId);
      expect(consumerTurnsAfter).toHaveLength(1);
      expect(consumerTurnsAfter[0]?.id).toBe(activationTurnId);
      const messagesAfter = await ctx.repository.listMessages(consumerTaskId);
      expect(messagesAfter).toHaveLength(1);
      expect(messagesAfter[0]?.id).toBe(messageId);

      // Redelivery must not invent a second consumer node activation identity.
      const consumerNodeAfter = await ctx.client.get<{ task_id: string; status: string }>(
        `SELECT task_id, status FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = ?`,
        ['ws', data.runId, 'consumer'],
      );
      expect(consumerNodeAfter).toMatchObject({
        task_id: consumerTaskId,
        status: 'active',
      });

      // body_json still free of result text / SQL after redelivery path.
      for (const row of after.routed) {
        const body = String(row.body_json);
        expect(body).not.toContain('p2-result');
        expect(body).not.toContain('p2-result-again');
        expect(body).not.toMatch(/SELECT |INSERT |DELETE /i);
      }
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
