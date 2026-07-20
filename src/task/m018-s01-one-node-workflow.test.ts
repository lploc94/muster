/**
 * M018 S01 named flow:
 * populated v7 migration → public bridge define/start → one ordinary queued entry turn.
 * Uses real SQLite worker + authenticated MCP dispatch + existing scheduler readiness.
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
import { writePopulatedV7Fixture, POPULATED_V7_FIXTURE_MARKER } from './sqlite/v7-fixture';
import type { TaskStoreFile } from './types';
import {
  deriveStartIdentities,
  fingerprintStartWorkflow,
  makeOneNodeDefinition,
  startWorkflowLedgerKey,
  validateStartWorkflow,
} from './workflow';

const TOPOLOGY = {
  kind: 'one_node_v1' as const,
  nodes: [{ nodeId: 'entry' }],
  entryNodeId: 'entry',
};

async function openRepo(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s01-${label}-`));
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

describe('M018 S01 one-node workflow activation', () => {
  it('domain validates start input and derives stable activation identities', () => {
    const def = makeOneNodeDefinition();
    const valid = validateStartWorkflow({
      definitionId: def.definitionId,
      version: def.version,
      startIdempotencyKey: 'start-key-1',
      createdAt: '2026-07-19T00:00:00.000Z',
      entryNodeId: def.topology.entryNodeId,
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const ids = deriveStartIdentities({
      definitionId: def.definitionId,
      version: def.version,
      startIdempotencyKey: 'start-key-1',
      entryNodeId: def.topology.entryNodeId,
    });
    expect(ids.runId).toMatch(/^wfr_/);
    expect(ids.activationTurnId).toMatch(/^wftn_/);
    expect(ids.entryTaskId).toMatch(/^wft_/);
    expect(startWorkflowLedgerKey('start-key-1')).toBe('start_workflow:start-key-1');
    expect(
      fingerprintStartWorkflow({
        definitionId: def.definitionId,
        version: def.version,
        startIdempotencyKey: 'start-key-1',
        entryNodeId: 'entry',
        goal: 'one-node',
        backend: 'grok',
      }),
    ).toEqual(expect.any(String));
    expect(
      validateStartWorkflow({
        definitionId: '',
        version: 1,
        startIdempotencyKey: 'k',
        createdAt: '2026-07-19T00:00:00.000Z',
        entryNodeId: 'entry',
      }).ok,
    ).toBe(false);
    expect(
      validateStartWorkflow({
        definitionId: 'wf',
        version: 1,
        startIdempotencyKey: '',
        createdAt: '2026-07-19T00:00:00.000Z',
        entryNodeId: 'entry',
      }).ok,
    ).toBe(false);
  });

  it('define + start produces exactly one durable satisfied entry activation turn', async () => {
    const ctx = await openRepo('start');
    try {
      const createdAt = '2026-07-19T00:00:00.000Z';
      const defined = await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology: TOPOLOGY,
        createdAt,
      });
      expect(defined.ok).toBe(true);
      expect(defined.changed).toBe(true);

      const start = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'idem-entry-1',
        createdAt,
        goal: 'run one-node',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      expect(start.changed).toBe(true);
      const payload = start.operation?.result?.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
        entryGateId: string;
        entryGateStatus: string;
        entryMessageId: string;
      };
      expect(payload).toMatchObject({
        entryGateStatus: 'satisfied',
        definitionId: 'wf-one',
        version: 1,
      });
      expect(payload.runId).toBeTruthy();
      expect(payload.activationTurnId).toBeTruthy();

      const runs = await ctx.client.all(
        'SELECT run_id, status, definition_id, definition_version FROM workflow_runs WHERE workspace_id = ?',
        ['ws'],
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        run_id: payload.runId,
        status: 'running',
        definition_id: 'wf-one',
        definition_version: 1,
      });

      const gates = await ctx.client.all(
        'SELECT gate_id, consumer_node_id, status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ?',
        ['ws', payload.runId],
      );
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({
        gate_id: payload.entryGateId,
        consumer_node_id: 'entry',
        status: 'satisfied',
      });

      const nodes = await ctx.client.all(
        'SELECT node_id, task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ?',
        ['ws', payload.runId],
      );
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({
        node_id: 'entry',
        task_id: payload.entryTaskId,
        status: 'active',
      });

      const task = await ctx.repository.getTask(payload.entryTaskId);
      expect(task).toMatchObject({
        id: payload.entryTaskId,
        parentId: null,
        lifecycle: 'open',
        releaseState: 'released',
        backend: 'grok',
      });

      const turns = await ctx.repository.listTurns(payload.entryTaskId);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        id: payload.activationTurnId,
        status: 'queued',
        trigger: 'engine',
        sequence: 1,
      });
      expect(turns[0]!.inputs).toEqual([
        { kind: 'message', messageId: payload.entryMessageId },
      ]);

      const queued = await ctx.repository.listQueuedTurns(payload.entryTaskId);
      expect(queued).toHaveLength(1);

      const file: TaskStoreFile = {
        schemaVersion: 2,
        revision: 1,
        tasks: { [task!.id]: task! },
        turns: { [turns[0]!.id]: turns[0]! },
        messages: {},
      };
      expect(canPromoteTurn(file, payload.activationTurnId, DEFAULT_RESOURCE_LIMITS)).toEqual({
        ok: true,
      });

      // Idempotent replay: same key, no second turn/run.
      const replay = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'idem-entry-1',
        createdAt: '2099-01-01T00:00:00.000Z',
        goal: 'run one-node',
        backend: 'grok',
      });
      expect(replay.ok).toBe(true);
      expect(replay.changed).toBe(false);
      expect(replay.operation?.result?.data).toMatchObject({
        runId: payload.runId,
        activationTurnId: payload.activationTurnId,
        replay: true,
      });
      expect(
        await ctx.client.all('SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws']),
      ).toHaveLength(1);
      expect(await ctx.repository.listTurns(payload.entryTaskId)).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('fails closed without partial rows when definition is missing or start key conflicts', async () => {
    const ctx = await openRepo('fail');
    try {
      const createdAt = '2026-07-19T00:00:00.000Z';
      const missing = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-missing',
        version: 1,
        startIdempotencyKey: 'idem-missing',
        createdAt,
      });
      expect(missing.ok).toBe(false);
      expect(missing.conflict).toBe(true);
      expect(missing.reason).toMatch(/definition not found/i);
      expect(
        await ctx.client.all('SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws']),
      ).toHaveLength(0);
      expect(
        await ctx.client.all('SELECT id FROM tasks WHERE workspace_id = ?', ['ws']),
      ).toHaveLength(0);

      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-a',
        version: 1,
        name: 'a',
        topology: TOPOLOGY,
        createdAt,
      });
      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-b',
        version: 1,
        name: 'b',
        topology: TOPOLOGY,
        createdAt,
      });
      const first = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-a',
        version: 1,
        startIdempotencyKey: 'shared-key',
        createdAt,
        goal: 'a',
        backend: 'grok',
      });
      expect(first.ok).toBe(true);
      const conflict = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-b',
        version: 1,
        startIdempotencyKey: 'shared-key',
        createdAt,
        goal: 'b',
        backend: 'grok',
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.conflict).toBe(true);
      expect(conflict.reason).toMatch(/fingerprint conflict|start fingerprint conflict/i);
      expect(
        await ctx.client.all('SELECT run_id, definition_id FROM workflow_runs WHERE workspace_id = ?', [
          'ws',
        ]),
      ).toEqual([expect.objectContaining({ definition_id: 'wf-a' })]);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('M018 S01 flow: populated v7 migration to one-node workflow activation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s01-named-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const fixture = writePopulatedV7Fixture(dbPath);
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
      // Migration preserved the fixture marker message on the owned v7 workspace.
      const markers = await client.all(
        `SELECT content FROM messages WHERE workspace_id = ? AND content = ?`,
        [fixture.workspaceId, POPULATED_V7_FIXTURE_MARKER],
      );
      expect(markers).toHaveLength(1);

      // Public define/start runs in a fresh workspace on the same migrated DB so
      // the proof is vertical (v7→v8 store + bridge activation) without coupling
      // to fixture payload shapes that only exist for migration data survival.
      const workspaceId = 'ws-m018-s01-bridge';
      const repository = new SqliteTaskRepository(client, workspaceId);
      await repository.execute({
        kind: 'upsertWorkspace',
        workspaceId,
        identityKey: 'm018-s01-bridge',
        displayName: 'M018 S01 bridge',
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
        goal: 'coordinate workflow define/start',
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
        allowedActions: new Set(['define_workflow', 'start_workflow', 'get_task_status']),
        ttlMs: 60_000,
      });
      const context = credentials.verify(token)!;

      const topology = {
        kind: 'one_node_v1' as const,
        nodes: [{ nodeId: 'entry' }],
        entryNodeId: 'entry',
      };
      const defineRouted = dispatch(
        'define_workflow',
        {
          opId: 'bridge-def-1',
          definitionId: 'wf-public',
          version: 1,
          name: 'public-one-node',
          topology,
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
      expect(defined).toMatchObject({ ok: true, result: { changed: true, definitionId: 'wf-public' } });

      const startRouted = dispatch(
        'start_workflow',
        {
          opId: 'bridge-start-1',
          definitionId: 'wf-public',
          version: 1,
          startIdempotencyKey: 'public-start-1',
          goal: 'activate one-node via bridge',
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
        entryTaskId: string;
        activationTurnId: string;
        entryGateStatus: string;
        entryMessageId: string;
      };
      expect(payload.entryGateStatus).toBe('satisfied');

      const entryTurn = await repository.getTurn(payload.activationTurnId);
      expect(entryTurn).toMatchObject({
        id: payload.activationTurnId,
        taskId: payload.entryTaskId,
        status: 'queued',
        trigger: 'engine',
      });
      const entryTask = await repository.getTask(payload.entryTaskId);
      expect(entryTask).toMatchObject({
        id: payload.entryTaskId,
        releaseState: 'released',
        lifecycle: 'open',
        backend: 'grok',
      });

      const file: TaskStoreFile = {
        schemaVersion: 2,
        revision: 1,
        tasks: { [entryTask!.id]: entryTask! },
        turns: { [entryTurn!.id]: entryTurn! },
        messages: {},
      };
      expect(canPromoteTurn(file, payload.activationTurnId, DEFAULT_RESOURCE_LIMITS)).toEqual({
        ok: true,
      });

      // Same start key through public surface is a no-op (no second turn).
      const replayRouted = dispatch(
        'start_workflow',
        {
          opId: 'bridge-start-replay',
          definitionId: 'wf-public',
          version: 1,
          startIdempotencyKey: 'public-start-1',
          goal: 'activate one-node via bridge',
          backend: 'grok',
        },
        context,
      );
      expect(replayRouted.ok).toBe(true);
      if (!replayRouted.ok) return;
      const replayed = await engine.handleToolCall(
        context,
        'start_workflow',
        replayRouted.command,
      );
      expect(replayed).toMatchObject({
        ok: true,
        result: { changed: false, replay: true, activationTurnId: payload.activationTurnId },
      });
      expect(await repository.listTurns(payload.entryTaskId)).toHaveLength(1);
    } finally {
      release();
      await engine?.whenIdle?.().catch(() => undefined);
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
