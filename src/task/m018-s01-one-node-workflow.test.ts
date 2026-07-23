/**
 * M018 S01 named flow:
 * fresh store → public bridge define/start → one ordinary queued entry turn.
 * Uses real SQLite worker + authenticated MCP dispatch + existing scheduler readiness.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CredentialRegistry } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { TaskEngine, type EngineEvent } from './engine';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { parseTaskTypeRegistry } from './task-types';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { canPromoteTurn } from './scheduler';
import { DbClient } from './sqlite/client';
import type { TaskStoreFile } from './types';
import {
  DEFAULT_WORKFLOW_POLICY,
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
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  await client.open(dbPath);
  const repository = new SqliteTaskRepository(client, 'ws');
  return {
    dir,
    dbPath,
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
    expect(startWorkflowLedgerKey('start-key-1')).toBe('start_workflow:workspace:start-key-1');
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

  it('one-node top-level updated success and replay', async () => {
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
      expect(
        await ctx.client.get(
          `SELECT source_kind, producer_run_id, producer_node_id, producer_task_id,
                  producing_turn_id, caller_task_id, caller_turn_id,
                  engine_start_operation_key
             FROM workflow_artifact_sources
            WHERE workspace_id = ? AND run_id = ?`,
          ['ws', payload.runId],
        ),
      ).toEqual({
        source_kind: 'engine_start',
        producer_run_id: null,
        producer_node_id: null,
        producer_task_id: null,
        producing_turn_id: null,
        caller_task_id: null,
        caller_turn_id: null,
        engine_start_operation_key: startWorkflowLedgerKey('idem-entry-1'),
      });

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

      await ctx.client.run(
        `UPDATE turns SET status = 'running', started_at = ?
          WHERE workspace_id = ? AND id = ?`,
        ['2026-07-19T00:00:01.000Z', 'ws', payload.activationTurnId],
      );
      const runningTurn = await ctx.repository.getTurn(payload.activationTurnId);
      const currentTask = await ctx.repository.getTask(payload.entryTaskId);
      expect(runningTurn).toBeTruthy();
      expect(currentTask).toBeTruthy();
      const disposition = {
        kind: 'workflow_next' as const,
        change: 'updated' as const,
        result: 'terminal result',
      };
      await stageDispositionForSettlement(ctx.repository, runningTurn!, disposition);
      const settleCommand = {
        kind: 'settleTurnAndApplyEffects' as const,
        workspaceId: 'ws',
        expectedTaskRevision: currentTask!.revision,
        task: {
          ...currentTask!,
          updatedAt: '2026-07-19T00:00:02.000Z',
        },
        turn: {
          ...runningTurn!,
          status: 'succeeded' as const,
          finishedAt: '2026-07-19T00:00:02.000Z',
          disposition,
        },
        expectedStatuses: ['running' as const],
        relatedTurns: [],
        messages: [
          {
            id: `${payload.activationTurnId}:0`,
            taskId: payload.entryTaskId,
            turnId: payload.activationTurnId,
            role: 'assistant' as const,
            state: 'complete' as const,
            order: 0,
            content: 'Detailed workflow output that the caller must receive.',
            createdAt: '2026-07-19T00:00:01.500Z',
          },
          {
            id: `${payload.activationTurnId}:1`,
            taskId: payload.entryTaskId,
            turnId: payload.activationTurnId,
            role: 'assistant' as const,
            state: 'complete' as const,
            order: 1,
            content: 'terminal result',
            createdAt: '2026-07-19T00:00:01.600Z',
          },
        ],
      };
      await expect(ctx.repository.execute(settleCommand)).resolves.toMatchObject({ changed: true });
      await expect(ctx.repository.execute(settleCommand)).resolves.toMatchObject({ changed: false });
      expect(
        await ctx.client.get(
          `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
          ['ws', payload.runId],
        ),
      ).toMatchObject({ status: 'succeeded' });
      expect(
        await ctx.client.get(
          `SELECT status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
          ['ws', payload.runId],
        ),
      ).toMatchObject({ status: 'succeeded' });
      expect(
        await ctx.client.get(
          `SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ?`,
          ['ws', payload.runId],
        ),
      ).toMatchObject({ status: 'consumed' });
      const nextArtifacts = await ctx.client.all<{ kind: string; payload_json: string }>(
        `SELECT kind, payload_json FROM workflow_artifacts
          WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'`,
        ['ws', payload.runId],
      );
      expect(nextArtifacts).toHaveLength(1);
      expect(nextArtifacts[0]?.kind).toBe('next_result');
      expect(nextArtifacts[0]?.payload_json).toContain('terminal result');
      expect(nextArtifacts[0]?.payload_json).not.toContain('Detailed workflow output that the caller must receive.');
      await expect(ctx.repository.getTask(payload.entryTaskId)).resolves.toMatchObject({
        lifecycle: 'succeeded',
        lifecycleAuthority: { kind: 'workflow', runId: payload.runId },
      });
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('implicitly routes the final assistant message as NEXT when the model omits a disposition', async () => {
    const ctx = await openRepo('implicit-next');
    let engine: TaskEngine | undefined;
    try {
      const createdAt = new Date().toISOString();
      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-implicit-next',
        version: 1,
        name: 'implicit-next',
        topology: TOPOLOGY,
        createdAt,
      });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-implicit-next',
        version: 1,
        startIdempotencyKey: 'implicit-next-1',
        createdAt,
        goal: 'fallback route',
        backend: 'grok',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const payload = started.operation!.result.data as { runId: string; entryTaskId: string; activationTurnId: string };

      engine = await TaskEngine.loadAsync({
        repository: ctx.repository,
        workspaceId: 'ws',
        credentialRegistry: new CredentialRegistry(),
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
          yield { type: 'assistantDelta', messageId: 'implicit-draft', content: 'intermediate answer' };
          yield { type: 'assistantDelta', messageId: 'implicit-final', content: 'final workflow answer' };
          yield { type: 'turnCompleted' };
        },
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await engine.whenIdle();
        const current = await ctx.repository.getTurn(payload.activationTurnId);
        if (current?.status === 'succeeded' || current?.status === 'failed' || current?.status === 'cancelled') {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      await expect(ctx.repository.getTurn(payload.activationTurnId)).resolves.toMatchObject({
        status: 'succeeded',
        disposition: {
          kind: 'workflow_next',
          change: 'updated',
          result: 'final workflow answer',
        },
      });
      await expect(ctx.client.get(
        `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({ status: 'succeeded' });
      const artifacts = await ctx.client.all<{ kind: string; payload_json: string }>(
        `SELECT kind, payload_json FROM workflow_artifacts
           WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'`,
        ['ws', payload.runId],
      );
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.kind).toBe('next_result');
      expect(artifacts[0]?.payload_json).toContain('final workflow answer');
      expect(artifacts[0]?.payload_json).not.toContain('intermediate answer');
      await expect(ctx.repository.listTurns(payload.entryTaskId)).resolves.toHaveLength(1);
      await expect(ctx.client.get(
        `SELECT status FROM turn_disposition_claims WHERE workspace_id = ? AND turn_id = ?`,
        ['ws', payload.activationTurnId],
      )).resolves.toMatchObject({ status: 'consumed' });
    } finally {
      await engine?.shutdown().catch(() => undefined);
      await ctx.close();
    }
  }, 30_000);

  it('commits an explicit NEXT message before interrupting the provider turn', async () => {
    const ctx = await openRepo('explicit-next-interrupt');
    let engine: TaskEngine | undefined;
    let releaseToolCompletion!: () => void;
    const toolCompletionGate = new Promise<void>((resolve) => { releaseToolCompletion = resolve; });
    let toolStarted!: () => void;
    const toolStartedGate = new Promise<void>((resolve) => { toolStarted = resolve; });
    try {
      const createdAt = new Date().toISOString();
      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-explicit-next',
        version: 1,
        name: 'explicit-next',
        topology: TOPOLOGY,
        createdAt,
      });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-explicit-next',
        version: 1,
        startIdempotencyKey: 'explicit-next-1',
        createdAt,
        goal: 'route explicitly',
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      const credentials = new CredentialRegistry();
      engine = await TaskEngine.loadAsync({
        repository: ctx.repository,
        workspaceId: 'ws',
        credentialRegistry: credentials,
        makeBackend: (name) => ({
          name,
          capabilities: {
            supportsMCP: true,
            supportsReasoning: false,
            supportsDetailedToolEvents: true,
          },
          run: async function* () {},
        }),
        runTurn: async function* (_backend, options) {
          await options.onBeforePrompt?.();
          yield { type: 'sessionStarted', sessionId: 'explicit-next-session' };
          yield {
            type: 'toolStarted',
            toolCallId: 'workflow-next-call',
            name: 'muster_bridge_workflow_next',
            kind: 'mcp',
            input: { message: 'official workflow result' },
          };
          toolStarted();
          await toolCompletionGate;
          yield {
            type: 'toolCompleted',
            toolCallId: 'workflow-next-call',
            outcome: 'success',
            output: { staged: true },
          };
          if (options.signal?.aborted) {
            yield {
              type: 'assistantDelta',
              messageId: 'provider-interruption',
              content: '*Conversation interrupted*',
            };
            yield { type: 'error', message: 'cancelled', isCancellation: true };
          }
        },
      });

      await toolStartedGate;
      const token = credentials.issue({
        rootId: payload.entryTaskId,
        callerTaskId: payload.entryTaskId,
        turnId: payload.activationTurnId,
        attemptId: 'explicit-next-attempt',
        allowedActions: new Set(['workflow_next']),
        ttlMs: 60_000,
      });
      const credential = credentials.verify(token)!;
      const routed = dispatch(
        'workflow_next',
        { opId: 'explicit-next-op', change: 'updated', message: 'official workflow result' },
        credential,
      );
      expect(routed.ok).toBe(true);
      if (!routed.ok) return;
      await expect(engine.handleToolCall(
        credential,
        'workflow_next',
        routed.command,
      )).resolves.toEqual({ ok: true, result: { staged: true } });

      releaseToolCompletion();
      await engine.whenIdle();

      await expect(ctx.repository.getTurn(payload.activationTurnId)).resolves.toMatchObject({
        status: 'succeeded',
        disposition: {
          kind: 'workflow_next',
          change: 'updated',
          result: 'official workflow result',
        },
      });
      const messages = (await ctx.repository.listMessages(payload.entryTaskId))
        .filter((message) => message.turnId === payload.activationTurnId)
        .map((message) => message.content);
      expect(messages.filter((message) => message === 'official workflow result')).toHaveLength(1);
      expect(messages).not.toContain('*Conversation interrupted*');
      await expect(ctx.client.get(
        `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      releaseToolCompletion();
      await engine?.shutdown().catch(() => undefined);
      await ctx.close();
    }
  }, 30_000);

  it('walks configured workflow fallbacks without retrying attempted bindings', async () => {
    const ctx = await openRepo('runtime-fallback');
    let engine: TaskEngine | undefined;
    try {
      const createdAt = new Date().toISOString();
      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-runtime-fallback',
        version: 1,
        name: 'runtime-fallback',
        topology: TOPOLOGY,
        createdAt,
      });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-runtime-fallback',
        version: 1,
        startIdempotencyKey: 'runtime-fallback-1',
        createdAt,
        goal: 'recover this workflow activation',
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      const calls: Array<{ backend: string; resumeId?: string; prompt: string }> = [];
      engine = await TaskEngine.loadAsync({
        repository: ctx.repository,
        workspaceId: 'ws',
        credentialRegistry: new CredentialRegistry(),
        makeBackend: (name) => ({
          name,
          capabilities: {
            supportsMCP: true,
            supportsReasoning: false,
            supportsDetailedToolEvents: false,
          },
          run: async function* () {},
        }),
        getRuntimeFallbacks: () => [
          { backend: 'grok' },
          { backend: 'codex', model: 'gpt-fallback' },
          { backend: 'grok' },
          { backend: 'opencode' },
        ],
        getHostEnvironment: () => ({
          cwd: process.cwd(),
          trusted: true,
          availableBackends: ['grok', 'codex', 'opencode'],
          models: {
            codex: { options: [{ value: 'gpt-fallback', name: 'Fallback' }] },
          },
        }),
        runTurn: async function* (backend, options) {
          calls.push({ backend: backend.name, resumeId: options.resumeId, prompt: options.prompt });
          await options.onBeforePrompt?.();
          if (backend.name !== 'opencode') {
            yield { type: 'sessionStarted', sessionId: `${backend.name}-failed-session` };
            yield { type: 'error', message: 'provider unavailable' };
            return;
          }
          yield { type: 'sessionStarted', sessionId: 'opencode-target-session' };
          yield { type: 'assistantDelta', messageId: 'fallback-result', content: 'recovered result' };
          yield { type: 'turnCompleted' };
        },
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        await engine.whenIdle();
        const run = await ctx.client.get<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
          ['ws', payload.runId],
        );
        if (run?.status === 'succeeded') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      expect(calls.map((call) => call.backend)).toEqual(['grok', 'codex', 'opencode']);
      expect(calls[1]?.resumeId).toBeUndefined();
      expect(calls[1]?.prompt).toContain('[runtime-fallback-recovery]');
      expect(calls[2]?.resumeId).toBeUndefined();
      expect(calls[2]?.prompt).toContain('[runtime-fallback-recovery]');
      const turns = await ctx.repository.listTurns(payload.entryTaskId);
      expect(turns).toHaveLength(3);
      expect(turns[0]).toMatchObject({ id: payload.activationTurnId, status: 'failed' });
      expect(turns[1]).toMatchObject({
        status: 'failed',
        trigger: 'retry',
        retryOf: payload.activationTurnId,
        runtimeEpoch: 2,
      });
      expect(turns[2]).toMatchObject({
        status: 'succeeded',
        trigger: 'retry',
        retryOf: turns[1]!.id,
        runtimeEpoch: 3,
      });
      expect(turns[1]?.inputs.some((input) => input.kind === 'recovery')).toBe(true);
      expect(turns[2]?.inputs.some((input) => input.kind === 'recovery')).toBe(true);
      await expect(ctx.repository.getTask(payload.entryTaskId)).resolves.toMatchObject({
        lifecycle: 'succeeded',
        backend: 'opencode',
        runtimeEpoch: 3,
        handoff: {
          source: { backend: 'codex', model: 'gpt-fallback', runtimeEpoch: 2 },
          target: { backend: 'opencode', runtimeEpoch: 3 },
          continuation: { status: 'consumed', turnId: turns[2]!.id },
        },
      });
      expect((await ctx.repository.getTask(payload.entryTaskId))?.runtimeRecovery).toBeUndefined();
      await expect(ctx.client.get(
        `SELECT status, execution_turn_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({ status: 'consumed', execution_turn_id: turns[2]!.id });
    } finally {
      await engine?.shutdown().catch(() => undefined);
      await ctx.close();
    }
  }, 30_000);

  it('commits a staged NEXT when the provider errors after the disposition', async () => {
    const ctx = await openRepo('staged-next-wins');
    let engine: TaskEngine | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let promptStarted!: () => void;
    const startedPrompt = new Promise<void>((resolve) => { promptStarted = resolve; });
    try {
      const createdAt = new Date().toISOString();
      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-staged-next-wins',
        version: 1,
        name: 'staged-next-wins',
        topology: TOPOLOGY,
        createdAt,
      });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-staged-next-wins',
        version: 1,
        startIdempotencyKey: 'staged-next-wins-1',
        createdAt,
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      const events: EngineEvent[] = [];
      engine = await TaskEngine.loadAsync({
        repository: ctx.repository,
        workspaceId: 'ws',
        credentialRegistry: new CredentialRegistry(),
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
          await options.onBeforePrompt?.();
          yield { type: 'sessionStarted', sessionId: 'staged-next-session' };
          promptStarted();
          await gate;
          yield { type: 'error', message: 'late provider disconnect' };
        },
        emit: (event) => events.push(event),
      });

      await startedPrompt;
      await expect(engine.stageDispositionAsync(
        payload.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'durable result' },
        'staged-next-before-error',
      )).resolves.toEqual({ ok: true, value: undefined });
      release();
      await engine.whenIdle();

      await expect(ctx.repository.getTurn(payload.activationTurnId)).resolves.toMatchObject({
        status: 'succeeded',
        disposition: { kind: 'workflow_next', result: 'durable result' },
      });
      await expect(ctx.client.get(
        `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({ status: 'succeeded' });
      expect(events.some((event) => event.type === 'turnDone')).toBe(true);
      expect(events.some((event) => event.type === 'turnError')).toBe(false);
    } finally {
      release();
      await engine?.shutdown().catch(() => undefined);
      await ctx.close();
    }
  }, 30_000);

  it('same-operation concurrent define and start converge to one immutable definition and run', async () => {
    const first = await openRepo('concurrent-define-start');
    const secondClient = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await secondClient.open(first.dbPath);
      const second = new SqliteTaskRepository(secondClient, 'ws');
      const createdAt = '2026-07-22T12:00:00.000Z';
      const defineResults = await Promise.all([
        first.repository.execute({
          kind: 'defineWorkflowVersion',
          workspaceId: 'ws',
          definitionId: 'wf-concurrent',
          version: 1,
          name: 'concurrent',
          topology: TOPOLOGY,
          createdAt,
        }),
        second.execute({
          kind: 'defineWorkflowVersion',
          workspaceId: 'ws',
          definitionId: 'wf-concurrent',
          version: 1,
          name: 'concurrent',
          topology: TOPOLOGY,
          createdAt,
        }),
      ]);
      expect(defineResults.every((result) => result.ok)).toBe(true);
      expect(defineResults.map((result) => result.changed).sort()).toEqual([false, true]);

      await expect(second.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-concurrent',
        version: 1,
        name: 'conflicting semantics',
        topology: TOPOLOGY,
        createdAt,
      })).resolves.toMatchObject({ ok: false, conflict: true });

      const startResults = await Promise.all([
        first.repository.execute({
          kind: 'startWorkflowRun',
          workspaceId: 'ws',
          definitionId: 'wf-concurrent',
          version: 1,
          startIdempotencyKey: 'same-concurrent-start',
          createdAt,
          goal: 'same concurrent start',
          backend: 'grok',
        }),
        second.execute({
          kind: 'startWorkflowRun',
          workspaceId: 'ws',
          definitionId: 'wf-concurrent',
          version: 1,
          startIdempotencyKey: 'same-concurrent-start',
          createdAt,
          goal: 'same concurrent start',
          backend: 'grok',
        }),
      ]);
      expect(startResults.every((result) => result.ok)).toBe(true);
      expect(startResults.map((result) => result.changed).sort()).toEqual([false, true]);
      const runIds = startResults.map(
        (result) => (result.operation?.result?.data as { runId: string }).runId,
      );
      expect(new Set(runIds).size).toBe(1);
      await expect(first.client.all(
        `SELECT definition_id, name FROM workflow_definitions
          WHERE workspace_id = ? AND definition_id = ?`,
        ['ws', 'wf-concurrent'],
      )).resolves.toEqual([{ definition_id: 'wf-concurrent', name: 'concurrent' }]);
      await expect(first.client.all(
        `SELECT run_id FROM workflow_runs
          WHERE workspace_id = ? AND definition_id = ?`,
        ['ws', 'wf-concurrent'],
      )).resolves.toHaveLength(1);
    } finally {
      await secondClient.close().catch(() => undefined);
      await first.close();
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

  it('M018 S01 flow: public one-node workflow activation on a fresh store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s01-named-'));
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
    try {
      await client.open(dbPath);
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
      let adapterRun = 0;
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
          adapterRun += 1;
          if (adapterRun === 1) {
            await gate;
          } else if (adapterRun === 2) {
            yield { type: 'assistantDelta', messageId: 'workflow-detail', content: 'Detailed result for the receiving coordinator.' };
            yield { type: 'assistantDelta', messageId: 'workflow-result', content: 'workflow complete' };
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
        allowedActions: new Set(['define_workflow', 'start_workflow', 'inspect_workflow_run']),
        attemptId: 'att-s01',
        ttlMs: 60_000,
      });
      const context = credentials.verify(token)!;

      const defineRouted = dispatch(
        'define_workflow',
        {
          workflowKey: 'wf-public',
          name: 'public-one-node',
          nodes: [{ nodeKey: 'entry', taskType: 'worker' }],
          inputs: [{ to: 'entry', name: 'request' }],
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

      const editContext = { ...context, turnId: `${turnId}-definition-edit` };
      const revisedRouted = dispatch(
        'define_workflow',
        {
          workflowKey: 'wf-public',
          name: 'public-one-node-revised',
          nodes: [{ nodeKey: 'entry', taskType: 'worker' }],
          inputs: [{ to: 'entry', name: 'request' }],
        },
        editContext,
      );
      expect(revisedRouted.ok).toBe(true);
      if (!revisedRouted.ok) return;
      await expect(engine.handleToolCall(
        editContext,
        'define_workflow',
        revisedRouted.command,
      )).resolves.toMatchObject({
        ok: true,
        result: { changed: true, definitionId: 'wf-public', version: 2 },
      });
      await expect(repository.getLatestWorkflowDefinition('wf-public', taskId))
        .resolves.toMatchObject({ version: 2, name: 'public-one-node-revised' });

      const startRouted = dispatch(
        'start_workflow',
        {
          workflow: 'wf-public',
          instanceKey: 'public-start-1',
          goal: 'activate one-node via bridge',
          inputs: [
            { node: 'entry', input: 'request', value: 'review this change' },
          ],
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
      let completion = await repository.getWorkflowRunCompletion(payload.runId, taskId);
      for (
        let attempt = 0;
        attempt < 100 && (!completion || completion.runStatus === 'running');
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        completion = await repository.getWorkflowRunCompletion(payload.runId, taskId);
      }
      expect(completion).toMatchObject({
        runStatus: 'succeeded',
        workflowNext: {
          change: 'updated',
          result: 'workflow complete',
        },
        terminalResult: {
          runId: payload.runId,
          artifactRevision: 1,
        },
      });
      await expect(repository.resolveWorkflowInputArtifacts(
        payload.activationTurnId,
        taskId,
        ['request'],
      )).resolves.toEqual([
        expect.objectContaining({
          inputRef: 'request',
          artifactRevision: 1,
        }),
      ]);

      const entryTurn = await repository.getTurn(payload.activationTurnId);
      expect(entryTurn).toMatchObject({
        id: payload.activationTurnId,
        taskId: payload.entryTaskId,
        status: 'succeeded',
        trigger: 'engine',
      });
      const entryTask = await repository.getTask(payload.entryTaskId);
      expect(entryTask).toMatchObject({
        id: payload.entryTaskId,
        parentId: taskId,
        releaseState: 'released',
        lifecycle: 'succeeded',
        backend: 'grok',
        lifecycleAuthority: { kind: 'workflow', runId: payload.runId },
      });
      expect((await repository.getTask(taskId))?.lifecycle).toBe('open');
      expect(
        await client.get(
          `SELECT owner_root_task_id, caller_task_id, caller_turn_id, policy_json,
                  started_at, deadline_at
             FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
          [workspaceId, payload.runId],
        ),
      ).toMatchObject({
        owner_root_task_id: taskId,
        caller_task_id: taskId,
        caller_turn_id: turnId,
        policy_json: JSON.stringify({
          ...DEFAULT_WORKFLOW_POLICY,
          maxDepth: 7,
          maxTaskCount: 32,
          maxConcurrency: 15,
        }),
        started_at: expect.any(String),
        deadline_at: expect.any(String),
      });
      expect(
        await client.get(
          `SELECT artifact.kind, artifact.payload_json, source.source_kind,
                  source.caller_task_id, source.caller_turn_id
             FROM workflow_artifacts artifact
             JOIN workflow_artifact_sources source
               ON source.workspace_id = artifact.workspace_id
              AND source.run_id = artifact.run_id
              AND source.artifact_id = artifact.artifact_id
              AND source.artifact_revision = artifact.revision
              WHERE artifact.workspace_id = ? AND artifact.run_id = ? AND artifact.kind = 'workflow_input'`,
          [workspaceId, payload.runId],
        ),
      ).toMatchObject({
        kind: 'workflow_input',
        payload_json: expect.stringContaining('review this change'),
        source_kind: 'caller_turn',
        caller_task_id: taskId,
        caller_turn_id: turnId,
      });
      expect(
        await client.get(
          `SELECT content FROM messages WHERE workspace_id = ? AND id = ?`,
          [workspaceId, payload.entryMessageId],
        ),
      ).toMatchObject({
        content: '[workflow-entry]\ninputRef="request" utf8Bytes=18\nreview this change',
      });
      expect(
        await client.get(
          `SELECT definition_id, definition_version, fingerprint, run_id
             FROM workflow_start_claims
            WHERE workspace_id = ? AND owner_task_id = ? AND caller_task_id = ?`,
          [workspaceId, taskId, taskId],
        ),
      ).toMatchObject({
        definition_id: 'wf-public',
        definition_version: 2,
        fingerprint: expect.any(String),
        run_id: payload.runId,
      });

      release();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await repository.getTurn(turnId))?.status === 'succeeded') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await expect(repository.getTurn(turnId)).resolves.toMatchObject({ status: 'succeeded' });

      let firstResumeTurnId: string | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const row = await client.get<{ resume_turn_id?: string }>(
          `SELECT json_extract(payload_json, '$.resumeTurnId') AS resume_turn_id
             FROM workflow_continuations
            WHERE workspace_id = ? AND run_id = ? AND kind = 'start_wait'
            ORDER BY created_at, continuation_id
            LIMIT 1`,
          [workspaceId, payload.runId],
        );
        firstResumeTurnId = row?.resume_turn_id;
        if (firstResumeTurnId && (await repository.getTurn(firstResumeTurnId))?.status === 'running') {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(firstResumeTurnId).toEqual(expect.any(String));
      await expect(repository.getTurn(firstResumeTurnId!)).resolves.toMatchObject({
        status: 'running',
        workflowResume: { kind: 'start_workflow', runId: payload.runId },
      });
      const resumeMessage = (await repository.listMessages(taskId)).find(
        (message) => message.turnId === firstResumeTurnId && message.role === 'system',
      );
      expect(resumeMessage?.content).toContain('workflow complete');
      expect(resumeMessage?.content).not.toContain('Detailed result for the receiving coordinator.');

      const replayToken = credentials.issue({
        rootId: taskId,
        callerTaskId: taskId,
        turnId: firstResumeTurnId!,
        allowedActions: new Set(['start_workflow']),
        attemptId: 'att-s01-replay',
        ttlMs: 60_000,
      });
      const replayContext = credentials.verify(replayToken)!;

      // The same instanceKey from a later turn reuses the run and creates that
      // turn's own deterministic terminal continuation.
      const replayRouted = dispatch(
        'start_workflow',
        {
          workflow: 'wf-public',
          instanceKey: 'public-start-1',
          goal: 'activate one-node via bridge',
          inputs: [
            { node: 'entry', input: 'request', value: 'review this change' },
          ],
        },
        replayContext,
      );
      expect(replayRouted.ok).toBe(true);
      if (!replayRouted.ok) return;
      const replayed = await engine.handleToolCall(
        replayContext,
        'start_workflow',
        replayRouted.command,
      );
      expect(replayed).toMatchObject({
        ok: true,
        result: {
           changed: false,
           replay: true,
           activationTurnId: payload.activationTurnId,
         },
      });
      expect(await repository.listTurns(payload.entryTaskId)).toHaveLength(1);
      let replayContinuations: Array<{ caller_turn_id: string; status: string }> = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        replayContinuations = await client.all<{ caller_turn_id: string; status: string }>(
          `SELECT caller_turn_id, status
             FROM workflow_continuations
            WHERE workspace_id = ? AND run_id = ? AND kind = 'start_wait'
            ORDER BY created_at, continuation_id`,
          [workspaceId, payload.runId],
        );
        if (
          replayContinuations.length === 2 &&
          replayContinuations.some((row) =>
            row.caller_turn_id === firstResumeTurnId && row.status === 'resolved')
        ) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      expect(replayContinuations).toEqual(expect.arrayContaining([
        expect.objectContaining({ caller_turn_id: turnId, status: 'consumed' }),
        expect.objectContaining({ caller_turn_id: firstResumeTurnId, status: 'resolved' }),
      ]));
    } finally {
      release();
      releaseResume();
      await engine?.whenIdle?.().catch(() => undefined);
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
