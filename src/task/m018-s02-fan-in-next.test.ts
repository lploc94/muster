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
import { canPromoteTurn } from './scheduler';
import { DbClient } from './sqlite/client';
import type { TaskStoreFile } from './types';
import { entryNodeIds, makeGraphFanInDefinition } from './workflow';

const FAN_IN_TOPOLOGY = {
  kind: 'graph_v1' as const,
  nodes: [{ nodeId: 'p1' }, { nodeId: 'p2' }, { nodeId: 'consumer' }],
  edges: [
    { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'from_p1' },
    { fromNodeId: 'p2', toNodeId: 'consumer', inputRef: 'from_p2' },
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
        opId: 'def-fan-1',
        definitionId: 'wf-fan',
        version: 1,
        name: 'fan-in',
        topology: FAN_IN_TOPOLOGY,
      },
      ctx,
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.command).toMatchObject({
      kind: 'define_workflow',
      definitionId: 'wf-fan',
      topology: FAN_IN_TOPOLOGY,
    });

    const bad = dispatch(
      'define_workflow',
      {
        opId: 'def-fan-bad',
        definitionId: 'wf-bad',
        version: 1,
        name: 'bad',
        topology: {
          kind: 'graph_v1',
          nodes: [{ nodeId: 'only' }],
          edges: [],
        },
      },
      ctx,
    );
    expect(bad.ok).toBe(false);
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
        return ctx.repository.execute({
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

      const consumerNodeAfterFirst = await ctx.client.get(
        'SELECT task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
        ['ws', data.runId, 'consumer'],
      );
      expect(consumerNodeAfterFirst).toMatchObject({ task_id: null, status: 'pending' });
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

      const consumerTask = await ctx.repository.getTask(String(consumerNode!.task_id));
      expect(consumerTask).toMatchObject({
        lifecycle: 'open',
        releaseState: 'released',
        backend: 'grok',
      });

      const consumerTurns = await ctx.repository.listTurns(consumerTask!.id);
      expect(consumerTurns).toHaveLength(1);
      expect(consumerTurns[0]).toMatchObject({
        status: 'queued',
        trigger: 'engine',
        sequence: 1,
      });

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
        runTurn: async function* () {
          await gate;
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
        allowedActions: new Set(['define_workflow', 'start_workflow', 'get_task_status']),
        ttlMs: 60_000,
      });
      const context = credentials.verify(token)!;

      const defineRouted = dispatch(
        'define_workflow',
        {
          opId: 'bridge-def-fan',
          definitionId: 'wf-public-fan',
          version: 1,
          name: 'public-fan-in',
          topology: FAN_IN_TOPOLOGY,
        },
        context,
      );
      expect(defineRouted.ok).toBe(true);
      if (!defineRouted.ok) return;
      const defined = await engine.handleToolCall(
        context,
        'define_workflow',
        defineRouted.command,
      );
      expect(defined).toMatchObject({
        ok: true,
        result: { changed: true, definitionId: 'wf-public-fan' },
      });

      const startRouted = dispatch(
        'start_workflow',
        {
          opId: 'bridge-start-fan',
          definitionId: 'wf-public-fan',
          version: 1,
          startIdempotencyKey: 'public-fan-start-1',
          goal: 'activate fan-in via bridge',
          backend: 'grok',
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
      };
      expect(payload.runId).toBeTruthy();
      expect(payload.entries?.map((e) => e.nodeId).sort()).toEqual(['p1', 'p2']);

      const nodes = await client.all(
        'SELECT node_id, task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? ORDER BY node_id',
        [workspaceId, payload.runId],
      );
      expect(nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ node_id: 'p1', status: 'active' }),
          expect.objectContaining({ node_id: 'p2', status: 'active' }),
          expect.objectContaining({ node_id: 'consumer', status: 'pending', task_id: null }),
        ]),
      );

      const consumerGate = payload.nodeGates?.find((g) => g.nodeId === 'consumer');
      expect(consumerGate).toBeTruthy();
      const gateRow = await client.get(
        'SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        [workspaceId, payload.runId, consumerGate!.gateId],
      );
      expect(gateRow).toMatchObject({ status: 'open' });

      for (const entry of payload.entries ?? []) {
        const turn = await repository.getTurn(entry.activationTurnId);
        expect(turn).toMatchObject({
          id: entry.activationTurnId,
          taskId: entry.taskId,
          status: 'queued',
          trigger: 'engine',
        });
      }
    } finally {
      release();
      await engine?.whenIdle?.().catch(() => undefined);
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
