/**
 * M018 S01 named flow:
 * fresh store → public bridge define/start → one ordinary queued entry turn.
 * Uses real SQLite worker + authenticated MCP dispatch + existing scheduler readiness.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
import type { EngineProjection } from './types';
import {
  DEFAULT_WORKFLOW_POLICY,
  deriveWorkflowDecisionRepairMessageId,
  deriveWorkflowDecisionRepairTurnId,
  deriveStartIdentities,
  entryNodeIds,
  fingerprintStartWorkflow,
  makeOneNodeDefinition,
  startWorkflowLedgerKey,
  validateStartWorkflow,
} from './workflow';

const TOPOLOGY = makeOneNodeDefinition().topology;

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

async function missingWorkflowDecisionSettlement(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  finishedAt: string,
) {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL
      WHERE workspace_id = ? AND id = ?`,
    [finishedAt, 'ws', turnId],
  );
  const task = await repository.getTask(taskId);
  const turn = await repository.getTurn(turnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  const command = {
    kind: 'settleTurnAndApplyEffects' as const,
    workspaceId: 'ws',
    expectedTaskRevision: task!.revision,
    task: { ...task!, updatedAt: finishedAt },
    turn: {
      ...turn!,
      status: 'succeeded' as const,
      finishedAt,
    },
    expectedStatuses: ['running' as const],
    relatedTurns: [],
    messages: [],
  };
  return {
    command,
    result: await repository.execute(command),
  };
}

type StrictDecisionRepairFixture = {
  runId: string;
  entryTaskId: string;
  activationTurnId: string;
  activationId: string;
  correctionTurnId: string;
};

async function startStrictDecisionRepair(
  repository: SqliteTaskRepository,
  client: DbClient,
  suffix: string,
  createdAt: string,
): Promise<StrictDecisionRepairFixture> {
  const definitionId = `wf-decision-rebind-${suffix}`;
  await expect(repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    name: `decision-rebind-${suffix}`,
    topology: {
      ...TOPOLOGY,
      nodes: [{
        ...TOPOLOGY.nodes[0]!,
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The result is complete.' },
        },
      }],
    },
    createdAt,
  })).resolves.toMatchObject({ ok: true, changed: true });
  const started = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    startIdempotencyKey: `decision-rebind-${suffix}`,
    createdAt,
    backend: 'grok',
  });
  const payload = started.operation!.result.data as {
    runId: string;
    entryTaskId: string;
    activationTurnId: string;
  };
  const activation = await client.get<{ activation_id: string }>(
    `SELECT activation_id FROM workflow_activations
      WHERE workspace_id = ? AND run_id = ?`,
    ['ws', payload.runId],
  );
  const activationId = activation!.activation_id;
  const correctionTurnId = deriveWorkflowDecisionRepairTurnId(activationId, 2);
  await expect(missingWorkflowDecisionSettlement(
    repository,
    client,
    payload.entryTaskId,
    payload.activationTurnId,
    new Date(Date.parse(createdAt) + 1_000).toISOString(),
  )).resolves.toMatchObject({ result: { changed: true } });
  await expect(repository.getTurn(correctionTurnId)).resolves.toMatchObject({ status: 'queued' });
  return { ...payload, activationId, correctionTurnId };
}

async function failDecisionCorrectionTurn(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  at: string,
  retry?: import('./types').TaskTurn,
): Promise<void> {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL
      WHERE workspace_id = ? AND id = ?`,
    [at, 'ws', turnId],
  );
  const task = await repository.getTask(taskId);
  const turn = await repository.getTurn(turnId);
  await expect(repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: 'ws',
    expectedTaskRevision: task!.revision,
    task: { ...task!, revision: task!.revision + 1, updatedAt: at },
    turn: {
      ...turn!,
      status: 'failed',
      failureClass: 'safe_to_retry',
      dispatchPhase: 'terminal_received',
      error: 'transient correction failure',
      finishedAt: at,
    },
    expectedStatuses: ['running'],
    relatedTurns: retry ? [retry] : [],
    messages: [],
  })).resolves.toMatchObject({ ok: true, changed: true });
}

async function settleCorrectedDecision(
  repository: SqliteTaskRepository,
  taskId: string,
  turnId: string,
  startedAt: string,
  finishedAt: string,
): Promise<void> {
  await expect(repository.execute({
    kind: 'claimTurn',
    workspaceId: 'ws',
    turnId,
    startedAt,
    rootTaskId: taskId,
    maxConcurrentTurns: 10,
    maxConcurrentPerRoot: 10,
    maxConcurrentPerBackend: 10,
    resourceKeys: [],
  })).resolves.toMatchObject({ ok: true, changed: true });
  const task = await repository.getTask(taskId);
  const turn = await repository.getTurn(turnId);
  const disposition = {
    kind: 'workflow_next' as const,
    change: 'updated' as const,
    result: 'corrected result',
  };
  await stageDispositionForSettlement(repository, turn!, disposition);
  await expect(repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: 'ws',
    expectedTaskRevision: task!.revision,
    task: { ...task!, revision: task!.revision + 1, updatedAt: finishedAt },
    turn: { ...turn!, status: 'succeeded', disposition, finishedAt },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  })).resolves.toMatchObject({ ok: true, changed: true });
}

describe('M018 S01 one-node workflow activation', () => {
  it('domain validates start input and derives stable activation identities', () => {
    const def = makeOneNodeDefinition();
    const valid = validateStartWorkflow({
      definitionId: def.definitionId,
      version: def.version,
      startIdempotencyKey: 'start-key-1',
      createdAt: '2026-07-19T00:00:00.000Z',
      entryNodeId: entryNodeIds(def.topology)[0]!,
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const ids = deriveStartIdentities({
      definitionId: def.definitionId,
      version: def.version,
      startIdempotencyKey: 'start-key-1',
      entryNodeId: entryNodeIds(def.topology)[0]!,
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

  it('persists a script execution descriptor on the materialized task without schema changes', async () => {
    const ctx = await openRepo('script-payload');
    try {
      const createdAt = '2026-08-22T00:00:00.000Z';
      const execution = {
        kind: 'script' as const,
        interpreter: 'node' as const,
        file: 'scripts/check.js',
        args: ['--format', 'json'],
      };
      const defined = await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-script-payload',
        version: 1,
        name: 'script payload',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'script' }],
          nodes: [{
            nodeId: 'script',
            backend: 'script',
            execution,
            outcome: {
              kind: 'exit',
              next: { when: { exitCode: 0 } },
              fail: { when: { exitCode: 'nonzero' } },
            },
          }],
          edges: [],
        },
        createdAt,
      });
      expect(defined.ok).toBe(true);

      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-script-payload',
        version: 1,
        startIdempotencyKey: 'script-payload-1',
        createdAt,
        goal: 'run script',
        backend: 'grok',
      });
      const payload = started.operation?.result?.data as { entryTaskId: string };
      await expect(ctx.repository.getTask(payload.entryTaskId)).resolves.toMatchObject({
        backend: 'script',
        execution,
      });
      const row = await ctx.client.get<{ payload_json: string }>(
        'SELECT payload_json FROM tasks WHERE workspace_id = ? AND id = ?',
        ['ws', payload.entryTaskId],
      );
      expect(JSON.parse(row!.payload_json).execution).toEqual(execution);
    } finally {
      await ctx.close();
    }
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

      const file: EngineProjection = {
        schemaVersion: 2,
        revision: 1,
        tasks: { [task!.id]: task! },
        turns: { [turns[0]!.id]: turns[0]! },
        messages: {},
        toolCalls: {},
        reasoning: {},
        operations: {},
        cancelRequests: {},
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
        topology: {
          ...TOPOLOGY,
          nodes: [{
            ...TOPOLOGY.nodes[0]!,
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: false,
              next: { when: 'The final response is ready.' },
            },
          }],
        },
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
      await expect(ctx.client.get(
        `SELECT status, attempts_used, last_error_code, next_repair_turn_id
           FROM workflow_decision_repairs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'decided',
        attempts_used: 1,
        last_error_code: null,
        next_repair_turn_id: null,
      });
    } finally {
      await engine?.shutdown().catch(() => undefined);
      await ctx.close();
    }
  }, 30_000);

  it('durably repairs a strict missing workflow decision twice and exhausts attempt three', async () => {
    const ctx = await openRepo('strict-decision-repair');
    let engine: TaskEngine | undefined;
    try {
      const createdAt = new Date().toISOString();
      const strictTopology = {
        ...TOPOLOGY,
        nodes: [{
          ...TOPOLOGY.nodes[0]!,
          outcome: {
            kind: 'agent' as const,
            requireExplicitDisposition: true,
            next: { when: 'The result is complete.' },
            fail: { when: 'The result cannot be produced.' },
          },
        }],
      };
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-strict-decision-repair',
        version: 1,
        name: 'strict-decision-repair',
        topology: strictTopology,
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-strict-decision-repair',
        version: 1,
        startIdempotencyKey: 'strict-decision-repair-1',
        createdAt,
        goal: 'produce a routed result',
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      const calls: Array<{ prompt: string; resumeId?: string }> = [];
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
          if (options.input.kind !== 'agent') throw new Error('expected agent input');
          calls.push({ prompt: options.input.prompt, resumeId: options.resumeId });
          await options.onBeforePrompt?.();
          yield { type: 'sessionStarted', sessionId: 'strict-decision-session' };
          yield {
            type: 'assistantDelta',
            messageId: `strict-response-${calls.length}`,
            content: `analysis without a route ${calls.length}`,
          };
          yield { type: 'turnCompleted' };
        },
      });

      for (let attempt = 0; attempt < 200; attempt += 1) {
        await engine.whenIdle();
        const run = await ctx.client.get<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
          ['ws', payload.runId],
        );
        if (run?.status === 'failed') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      expect(calls).toHaveLength(3);
      expect(calls[0]?.prompt).toContain('# Outcome contract');
      expect(calls[0]?.prompt).toContain('Use workflow_next when:\nThe result is complete.');
      expect(calls[0]?.prompt).toContain('Use workflow_fail when:\nThe result cannot be produced.');
      expect(calls[0]?.prompt).toContain('Explicit disposition is required.');
      expect(calls[1]?.prompt).toContain('# Workflow outcome required');
      expect(calls[1]?.prompt).toContain('This is decision attempt 2 of 3.');
      expect(calls[1]?.prompt).toContain('analysis without a route 1');
      expect(calls[2]?.prompt).toContain('This is decision attempt 3 of 3.');
      expect(calls[1]?.resumeId).toBe('strict-decision-session');
      expect(calls[2]?.resumeId).toBe('strict-decision-session');

      const turns = await ctx.repository.listTurns(payload.entryTaskId);
      expect(turns).toHaveLength(3);
      expect(turns.map((turn) => turn.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(new Set(turns.map((turn) => turn.id)).size).toBe(3);
      await expect(ctx.client.get(
        `SELECT status, attempts_used, last_attempt_turn_id, last_error_code,
                last_response_message_id, next_repair_turn_id
           FROM workflow_decision_repairs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'exhausted',
        attempts_used: 3,
        last_attempt_turn_id: turns[2]!.id,
        last_error_code: 'decision_missing',
        last_response_message_id: expect.any(String),
        next_repair_turn_id: null,
      });
      await expect(ctx.client.get(
        `SELECT status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({ status: 'failed', terminal_reason_code: 'decision_missing' });
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

  it('replays and reloads deterministic repair transitions without duplicate correction turns', async () => {
    const ctx = await openRepo('decision-repair-reload');
    const clients = [ctx.client];
    let repository = ctx.repository;
    let client = ctx.client;
    try {
      const createdAt = '2026-07-19T00:00:00.000Z';
      await expect(repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-decision-repair-reload',
        version: 1,
        name: 'decision-repair-reload',
        topology: {
          ...TOPOLOGY,
          nodes: [{
            ...TOPOLOGY.nodes[0]!,
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: true,
              next: { when: 'The result is complete.' },
            },
          }],
        },
        createdAt,
      })).resolves.toMatchObject({ changed: true });
      const started = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-decision-repair-reload',
        version: 1,
        startIdempotencyKey: 'decision-repair-reload-1',
        createdAt,
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      const activation = await client.get<{ activation_id: string }>(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      );
      const activationId = activation!.activation_id;
      const expectedSecondTurnId = deriveWorkflowDecisionRepairTurnId(activationId, 2);
      const expectedThirdTurnId = deriveWorkflowDecisionRepairTurnId(activationId, 3);

      const first = await missingWorkflowDecisionSettlement(
        repository,
        client,
        payload.entryTaskId,
        payload.activationTurnId,
        '2026-07-19T00:00:01.000Z',
      );
      expect(first.result).toMatchObject({ changed: true });
      await expect(repository.execute(first.command)).resolves.toMatchObject({ changed: false });
      await expect(repository.listTurns(payload.entryTaskId)).resolves.toHaveLength(2);
      await expect(repository.getTurn(expectedSecondTurnId)).resolves.toMatchObject({
        id: expectedSecondTurnId,
        status: 'queued',
        inputs: expect.arrayContaining([{
          kind: 'message',
          messageId: deriveWorkflowDecisionRepairMessageId(activationId, 2),
        }]),
      });

      await client.close();
      client = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      clients.push(client);
      await client.open(ctx.dbPath);
      repository = new SqliteTaskRepository(client, 'ws');
      await expect(repository.getTurn(expectedSecondTurnId)).resolves.toMatchObject({ status: 'queued' });

      const second = await missingWorkflowDecisionSettlement(
        repository,
        client,
        payload.entryTaskId,
        expectedSecondTurnId,
        '2026-07-19T00:00:02.000Z',
      );
      expect(second.result).toMatchObject({ changed: true });
      await expect(repository.execute(second.command)).resolves.toMatchObject({ changed: false });
      await expect(repository.listTurns(payload.entryTaskId)).resolves.toHaveLength(3);
      await expect(repository.getTurn(expectedThirdTurnId)).resolves.toMatchObject({
        id: expectedThirdTurnId,
        status: 'queued',
        inputs: expect.arrayContaining([{
          kind: 'message',
          messageId: deriveWorkflowDecisionRepairMessageId(activationId, 3),
        }]),
      });

      const third = await missingWorkflowDecisionSettlement(
        repository,
        client,
        payload.entryTaskId,
        expectedThirdTurnId,
        '2026-07-19T00:00:03.000Z',
      );
      expect(third.result).toMatchObject({ changed: true });
      await expect(repository.execute(third.command)).resolves.toMatchObject({ changed: false });
      const turns = await repository.listTurns(payload.entryTaskId);
      expect(turns.map((turn) => turn.id)).toEqual([
        payload.activationTurnId,
        expectedSecondTurnId,
        expectedThirdTurnId,
      ]);
      await expect(client.get(
        `SELECT status, attempts_used, last_attempt_turn_id, last_error_code,
                next_repair_turn_id
           FROM workflow_decision_repairs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'exhausted',
        attempts_used: 3,
        last_attempt_turn_id: expectedThirdTurnId,
        last_error_code: 'decision_missing',
        next_repair_turn_id: null,
      });
      await expect(client.get(
        `SELECT status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({ status: 'failed', terminal_reason_code: 'decision_missing' });
    } finally {
      await Promise.all(clients.map((candidate) => candidate.close().catch(() => undefined)));
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rebinds an open decision repair to a manual retry of its failed correction turn', async () => {
    const ctx = await openRepo('decision-repair-manual-retry');
    try {
      const createdAt = '2026-07-19T04:00:00.000Z';
      const fixture = await startStrictDecisionRepair(
        ctx.repository,
        ctx.client,
        'manual-retry',
        createdAt,
      );
      await failDecisionCorrectionTurn(
        ctx.repository,
        ctx.client,
        fixture.entryTaskId,
        fixture.correctionTurnId,
        '2026-07-19T04:00:02.000Z',
      );
      const failed = await ctx.repository.getTurn(fixture.correctionTurnId);
      const task = await ctx.repository.getTask(fixture.entryTaskId);
      const retryTurnId = `${fixture.correctionTurnId}-operational-retry`;
      const retry = {
        id: retryTurnId,
        taskId: fixture.entryTaskId,
        sequence: failed!.sequence + 1,
        trigger: 'retry' as const,
        status: 'queued' as const,
        retryOf: fixture.correctionTurnId,
        inputs: [...failed!.inputs],
        executionEpoch: failed!.executionEpoch,
        runtimeEpoch: failed!.runtimeEpoch,
        ...(failed!.workflowInstructions !== undefined
          ? { workflowInstructions: failed!.workflowInstructions }
          : {}),
        createdAt: '2026-07-19T04:00:03.000Z',
      };
      await expect(ctx.repository.execute({
        kind: 'retryTurn',
        workspaceId: 'ws',
        expectedTaskRevision: task!.revision,
        maxTurnsPerTask: 10,
        task: task!,
        turn: retry,
        reuseOriginalInputs: true,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(ctx.client.get(
        `SELECT status, attempts_used, next_repair_turn_id
          FROM workflow_decision_repairs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', fixture.runId],
      )).resolves.toEqual({
        status: 'open',
        attempts_used: 1,
        next_repair_turn_id: retryTurnId,
      });

      await settleCorrectedDecision(
        ctx.repository,
        fixture.entryTaskId,
        retryTurnId,
        '2026-07-19T04:00:04.000Z',
        '2026-07-19T04:00:05.000Z',
      );
      await expect(ctx.client.get(
        `SELECT status, attempts_used, next_repair_turn_id
          FROM workflow_decision_repairs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', fixture.runId],
      )).resolves.toEqual({ status: 'decided', attempts_used: 2, next_repair_turn_id: null });
    } finally {
      await ctx.close();
    }
  });

  it('rebinds an open decision repair to an automatic retry of its failed correction turn', async () => {
    const ctx = await openRepo('decision-repair-automatic-retry');
    try {
      const fixture = await startStrictDecisionRepair(
        ctx.repository,
        ctx.client,
        'automatic-retry',
        '2026-07-19T04:30:00.000Z',
      );
      const correction = await ctx.repository.getTurn(fixture.correctionTurnId);
      const retryTurnId = `${fixture.correctionTurnId}-automatic-retry`;
      const retry = {
        id: retryTurnId,
        taskId: fixture.entryTaskId,
        sequence: correction!.sequence + 1,
        trigger: 'retry' as const,
        status: 'queued' as const,
        retryOf: fixture.correctionTurnId,
        inputs: [...correction!.inputs],
        executionEpoch: correction!.executionEpoch,
        runtimeEpoch: correction!.runtimeEpoch,
        ...(correction!.workflowInstructions !== undefined
          ? { workflowInstructions: correction!.workflowInstructions }
          : {}),
        createdAt: '2026-07-19T04:30:02.000Z',
      };
      await failDecisionCorrectionTurn(
        ctx.repository,
        ctx.client,
        fixture.entryTaskId,
        fixture.correctionTurnId,
        '2026-07-19T04:30:02.000Z',
        retry,
      );
      await expect(ctx.client.get(
        `SELECT status, attempts_used, next_repair_turn_id
          FROM workflow_decision_repairs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', fixture.runId],
      )).resolves.toEqual({
        status: 'open',
        attempts_used: 1,
        next_repair_turn_id: retryTurnId,
      });

      await settleCorrectedDecision(
        ctx.repository,
        fixture.entryTaskId,
        retryTurnId,
        '2026-07-19T04:30:03.000Z',
        '2026-07-19T04:30:04.000Z',
      );
      await expect(ctx.client.get(
        `SELECT status, attempts_used, next_repair_turn_id
          FROM workflow_decision_repairs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', fixture.runId],
      )).resolves.toEqual({ status: 'decided', attempts_used: 2, next_repair_turn_id: null });
    } finally {
      await ctx.close();
    }
  });

  it('rebinds an open decision repair to a recovered correction turn after reload', async () => {
    const ctx = await openRepo('decision-repair-recovery-reload');
    const clients = [ctx.client];
    let repository = ctx.repository;
    let client = ctx.client;
    try {
      const fixture = await startStrictDecisionRepair(
        repository,
        client,
        'recovery-reload',
        '2026-07-19T05:00:00.000Z',
      );
      await failDecisionCorrectionTurn(
        repository,
        client,
        fixture.entryTaskId,
        fixture.correctionTurnId,
        '2026-07-19T05:00:02.000Z',
      );
      await client.close();
      client = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      clients.push(client);
      await client.open(ctx.dbPath);
      repository = new SqliteTaskRepository(client, 'ws');

      const recovered = await repository.execute({
        kind: 'recoverWorkflowActivation',
        workspaceId: 'ws',
        runId: fixture.runId,
        activationId: fixture.activationId,
        failedTurnId: fixture.correctionTurnId,
        recoveryOperationId: 'decision-repair-recovery-reload',
        fingerprint: 'decision-repair-recovery-reload-v1',
        instruction: 'Resume the interrupted correction attempt.',
        expectedActivationStatus: 'failed',
        createdAt: '2026-07-19T05:00:03.000Z',
      });
      expect(recovered).toMatchObject({ ok: true, changed: true });
      const recoveredTurnId = (recovered.operation!.result as {
        ok: true;
        data: { turnId: string };
      }).data.turnId;
      await expect(client.get(
        `SELECT status, attempts_used, next_repair_turn_id
          FROM workflow_decision_repairs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', fixture.runId],
      )).resolves.toEqual({
        status: 'open',
        attempts_used: 1,
        next_repair_turn_id: recoveredTurnId,
      });

      await settleCorrectedDecision(
        repository,
        fixture.entryTaskId,
        recoveredTurnId,
        '2026-07-19T05:00:04.000Z',
        '2026-07-19T05:00:05.000Z',
      );
      await expect(client.get(
        `SELECT status, attempts_used, next_repair_turn_id
          FROM workflow_decision_repairs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', fixture.runId],
      )).resolves.toEqual({ status: 'decided', attempts_used: 2, next_repair_turn_id: null });
    } finally {
      await Promise.all(clients.map((candidate) => candidate.close().catch(() => undefined)));
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('closes active and pending nodes plus an open repair when a run times out', async () => {
    const ctx = await openRepo('decision-repair-timeout-closure');
    try {
      const createdAt = '2026-07-19T06:00:00.000Z';
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-decision-repair-timeout-closure',
        version: 1,
        name: 'decision-repair-timeout-closure',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'sink' }],
          nodes: [{
            nodeId: 'decision',
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: true,
              next: { when: 'The result is complete.' },
            },
          }, { nodeId: 'sink' }],
          edges: [{ fromNodeId: 'decision', toNodeId: 'sink', inputRef: 'decision_result' }],
        },
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-decision-repair-timeout-closure',
        version: 1,
        startIdempotencyKey: 'decision-repair-timeout-closure',
        createdAt,
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      await expect(missingWorkflowDecisionSettlement(
        ctx.repository,
        ctx.client,
        payload.entryTaskId,
        payload.activationTurnId,
        '2026-07-19T06:00:01.000Z',
      )).resolves.toMatchObject({ result: { changed: true } });
      await ctx.client.run(
        `UPDATE workflow_runs SET deadline_at = ?
          WHERE workspace_id = ? AND run_id = ?`,
        ['2026-07-19T06:00:02.000Z', 'ws', payload.runId],
      );

      await expect(ctx.repository.execute({
        kind: 'reapWorkflowTimeouts',
        workspaceId: 'ws',
        now: '2026-07-19T06:00:03.000Z',
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(ctx.client.all(
        `SELECT node_id, status FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        ['ws', payload.runId],
      )).resolves.toEqual([
        { node_id: 'decision', status: 'failed' },
        { node_id: 'sink', status: 'failed' },
      ]);
      await expect(ctx.client.get(
        `SELECT status, attempts_used, next_repair_turn_id
          FROM workflow_decision_repairs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toEqual({
        status: 'exhausted',
        attempts_used: 3,
        next_repair_turn_id: null,
      });
      await expect(ctx.client.get(
        `SELECT status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toEqual({ status: 'failed', terminal_reason_code: 'run_timeout' });
    } finally {
      await ctx.close();
    }
  });

  it('uses the existing workflow budget closure instead of over-admitting a repair turn', async () => {
    const ctx = await openRepo('decision-repair-budget');
    try {
      const createdAt = '2026-07-19T00:00:00.000Z';
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-decision-repair-budget',
        version: 1,
        name: 'decision-repair-budget',
        topology: {
          ...TOPOLOGY,
          nodes: [{
            ...TOPOLOGY.nodes[0]!,
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: true,
              next: { when: 'The result is complete.' },
            },
          }],
        },
        policy: {
          ...DEFAULT_WORKFLOW_POLICY,
          maxTurnsPerTask: 1,
          maxWorkflowTurnsPerRun: 1,
        },
        createdAt,
      })).resolves.toMatchObject({ changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-decision-repair-budget',
        version: 1,
        startIdempotencyKey: 'decision-repair-budget-1',
        createdAt,
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      const settlement = await missingWorkflowDecisionSettlement(
        ctx.repository,
        ctx.client,
        payload.entryTaskId,
        payload.activationTurnId,
        '2026-07-19T00:00:01.000Z',
      );
      expect(settlement.result).toMatchObject({ changed: true });
      await expect(ctx.repository.listTurns(payload.entryTaskId)).resolves.toHaveLength(1);
      await expect(ctx.client.get(
        `SELECT status, attempts_used, last_attempt_turn_id, last_error_code,
                next_repair_turn_id
           FROM workflow_decision_repairs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'exhausted',
        attempts_used: 3,
        last_attempt_turn_id: payload.activationTurnId,
        last_error_code: 'decision_missing',
        next_repair_turn_id: null,
      });
      await expect(ctx.client.get(
        `SELECT status, terminal_reason_code, workflow_turns_reserved
           FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'failed',
        terminal_reason_code: 'turn_budget_exhausted',
        workflow_turns_reserved: 1,
      });
      const activation = await ctx.client.get<{ activation_id: string }>(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      );
      expect(activation).toBeTruthy();
      const rejectedRepairTurnId = deriveWorkflowDecisionRepairTurnId(activation!.activation_id, 2);
      const rejectedRepairMessageId = deriveWorkflowDecisionRepairMessageId(activation!.activation_id, 2);
      await expect(ctx.client.all(
        `SELECT entity_kind, entity_id FROM change_log
          WHERE workspace_id = ? AND entity_id IN (?, ?)`,
        ['ws', rejectedRepairTurnId, rejectedRepairMessageId],
      )).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('fails an expired decision attempt through the run-timeout path without queueing repair', async () => {
    const ctx = await openRepo('decision-repair-deadline');
    try {
      const createdAt = '2026-07-19T00:00:00.000Z';
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-decision-repair-deadline',
        version: 1,
        name: 'decision-repair-deadline',
        topology: {
          ...TOPOLOGY,
          nodes: [{
            ...TOPOLOGY.nodes[0]!,
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: true,
              next: { when: 'The result is complete.' },
            },
          }],
        },
        policy: { ...DEFAULT_WORKFLOW_POLICY, runTimeoutMs: 1_000 },
        createdAt,
      })).resolves.toMatchObject({ changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-decision-repair-deadline',
        version: 1,
        startIdempotencyKey: 'decision-repair-deadline-1',
        createdAt,
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      const settlement = await missingWorkflowDecisionSettlement(
        ctx.repository,
        ctx.client,
        payload.entryTaskId,
        payload.activationTurnId,
        '2026-07-19T00:00:01.000Z',
      );
      expect(settlement.result).toMatchObject({ changed: true });
      await expect(ctx.repository.listTurns(payload.entryTaskId)).resolves.toHaveLength(1);
      await expect(ctx.client.get(
        `SELECT status, attempts_used, last_attempt_turn_id, last_error_code,
                next_repair_turn_id
           FROM workflow_decision_repairs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'exhausted',
        attempts_used: 3,
        last_attempt_turn_id: payload.activationTurnId,
        last_error_code: 'decision_missing',
        next_repair_turn_id: null,
      });
      await expect(ctx.client.get(
        `SELECT status, terminal_reason_code, deadline_at
           FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'failed',
        terminal_reason_code: 'run_timeout',
        deadline_at: '2026-07-19T00:00:01.000Z',
      });
    } finally {
      await ctx.close();
    }
  });

  it('turns an optional authenticated invalid route into repair and accepts a valid second decision', async () => {
    const ctx = await openRepo('optional-invalid-decision-repair');
    let engine: TaskEngine | undefined;
    try {
      const createdAt = new Date().toISOString();
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-optional-invalid-decision-repair',
        version: 1,
        name: 'optional-invalid-decision-repair',
        topology: {
          ...TOPOLOGY,
          nodes: [{
            ...TOPOLOGY.nodes[0]!,
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: false,
              next: { when: 'The result is ready.' },
            },
          }],
        },
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-optional-invalid-decision-repair',
        version: 1,
        startIdempotencyKey: 'optional-invalid-decision-repair-1',
        createdAt,
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
      };
      const prompts: string[] = [];
      let freshSessionPrompt: string | undefined;
      const readiness = {
        beginAttempt: () => undefined,
        evaluate: (turnId: string, attemptId: string, generation: number) => ({
          ok: true as const,
          turnId,
          attemptId,
          generation,
          toolNames: [] as string[],
        }),
      } as unknown as import('../bridge/mcp-readiness').McpReadinessSupervisor;
      engine = await TaskEngine.loadAsync({
        repository: ctx.repository,
        workspaceId: 'ws',
        credentialRegistry: new CredentialRegistry(),
        bridgePort: 1,
        mcpReadiness: readiness,
        getBridgeGeneration: () => 1,
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
          if (options.input.kind !== 'agent') throw new Error('expected agent input');
          prompts.push(options.input.prompt);
          if (prompts.length === 2) {
            freshSessionPrompt = await options.mcpSetup?.buildFreshSessionPrompt?.({
              attempt: 2,
              maxAttempts: 2,
              recoveryMode: 'fresh_after_sticky',
              forceFreshSession: true,
              previousFailure: {
                code: 'session_load_failed',
                message: 'forced load failure',
              },
            });
          }
          await options.onBeforePrompt?.();
          const running = (await ctx.repository.listTurns(payload.entryTaskId))
            .find((turn) => turn.status === 'running');
          if (!running) throw new Error('running workflow decision turn missing');
          if (prompts.length === 1) {
            const credential = {
              credentialId: 'decision-invalid',
              rootId: payload.entryTaskId,
              callerTaskId: payload.entryTaskId,
              turnId: running.id,
              attemptId: 'attempt-1',
              allowedActions: new Set(['workflow_next'] as const),
              expiry: Date.now() + 60_000,
            };
            const rejected = dispatch(
              'workflow_fail',
              { reason: 'undeclared route' },
              credential,
            );
            expect(rejected.ok).toBe(false);
            if (rejected.ok) throw new Error('workflow_fail unexpectedly parsed');
            const recorded = await engine!.handleToolCall(
              credential,
              'workflow_fail',
              (rejected as typeof rejected & { invalidWorkflowAttempt: import('./coordinator-tools').ToolCommand })
                .invalidWorkflowAttempt,
            );
            expect(recorded).toMatchObject({ ok: true });
          } else {
            await expect(engine!.stageDispositionAsync(
              running.id,
              { kind: 'workflow_next', change: 'updated', result: 'valid repaired result' },
              'repair-valid-next',
            )).resolves.toMatchObject({ ok: true });
          }
          yield { type: 'sessionStarted', sessionId: 'optional-repair-session' };
          yield {
            type: 'assistantDelta',
            messageId: `optional-repair-response-${prompts.length}`,
            content: prompts.length === 1 ? 'invalid route response' : 'valid repaired result',
          };
          yield { type: 'turnCompleted' };
        },
      });

      for (let attempt = 0; attempt < 200; attempt += 1) {
        await engine.whenIdle();
        const run = await ctx.client.get<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
          ['ws', payload.runId],
        );
        if (run?.status === 'succeeded') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Your previous response attempted an invalid workflow outcome.');
      expect(prompts[1]).toContain('This is decision attempt 2 of 3.');
      expect(freshSessionPrompt).toContain('# Workflow decision context');
      expect(freshSessionPrompt).toContain('invalid route response');
      expect(freshSessionPrompt).toContain('This is decision attempt 2 of 3.');
      expect(freshSessionPrompt).toContain('Use workflow_next when:');
      const turns = await ctx.repository.listTurns(payload.entryTaskId);
      expect(turns).toHaveLength(2);
      expect(turns[0]?.disposition).toBeUndefined();
      expect(turns[1]?.disposition).toMatchObject({
        kind: 'workflow_next',
        result: 'valid repaired result',
      });
      await expect(ctx.client.get(
        `SELECT status, attempts_used, last_attempt_turn_id, last_error_code,
                next_repair_turn_id
           FROM workflow_decision_repairs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'decided',
        attempts_used: 2,
        last_attempt_turn_id: turns[1]!.id,
        last_error_code: null,
        next_repair_turn_id: null,
      });
      await expect(ctx.client.get(
        `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      await engine?.shutdown().catch(() => undefined);
      await ctx.close();
    }
  }, 30_000);

  it('does not restore optional implicit NEXT after an undeclared route and exhausts missing corrections', async () => {
    const ctx = await openRepo('optional-invalid-missing-repair');
    let engine: TaskEngine | undefined;
    try {
      const createdAt = new Date().toISOString();
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-optional-invalid-missing-repair',
        version: 1,
        name: 'optional-invalid-missing-repair',
        topology: {
          ...TOPOLOGY,
          nodes: [{
            ...TOPOLOGY.nodes[0]!,
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: false,
              next: { when: 'The result is ready.' },
            },
          }],
        },
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-optional-invalid-missing-repair',
        version: 1,
        startIdempotencyKey: 'optional-invalid-missing-repair-1',
        createdAt,
        backend: 'grok',
      });
      const payload = started.operation!.result.data as {
        runId: string;
        entryTaskId: string;
      };
      const prompts: string[] = [];
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
          if (options.input.kind !== 'agent') throw new Error('expected agent input');
          prompts.push(options.input.prompt);
          await options.onBeforePrompt?.();
          if (prompts.length === 1) {
            const running = (await ctx.repository.listTurns(payload.entryTaskId))
              .find((turn) => turn.status === 'running');
            if (!running) throw new Error('running workflow decision turn missing');
            await expect(engine!.stageDispositionAsync(
              running.id,
              { kind: 'workflow_fail', reason: 'undeclared route' },
              'optional-undeclared-fail',
            )).resolves.toMatchObject({ ok: false });
          }
          yield { type: 'sessionStarted', sessionId: 'optional-invalid-missing-session' };
          yield {
            type: 'assistantDelta',
            messageId: `optional-invalid-missing-response-${prompts.length}`,
            content: `response without an accepted route ${prompts.length}`,
          };
          yield { type: 'turnCompleted' };
        },
      });

      for (let attempt = 0; attempt < 200; attempt += 1) {
        await engine.whenIdle();
        const run = await ctx.client.get<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
          ['ws', payload.runId],
        );
        if (run?.status === 'failed') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      expect(prompts).toHaveLength(3);
      expect(prompts[1]).toContain('Your previous response attempted an invalid workflow outcome.');
      expect(prompts[2]).toContain('Your previous response did not select a workflow outcome.');
      const turns = await ctx.repository.listTurns(payload.entryTaskId);
      expect(turns).toHaveLength(3);
      expect(turns.every((turn) => turn.disposition === undefined)).toBe(true);
      await expect(ctx.client.get(
        `SELECT status, attempts_used, last_attempt_turn_id, last_error_code,
                next_repair_turn_id
           FROM workflow_decision_repairs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({
        status: 'exhausted',
        attempts_used: 3,
        last_attempt_turn_id: turns[2]!.id,
        last_error_code: 'decision_missing',
        next_repair_turn_id: null,
      });
      await expect(ctx.client.get(
        `SELECT status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', payload.runId],
      )).resolves.toMatchObject({ status: 'failed', terminal_reason_code: 'decision_missing' });
      await expect(ctx.client.get(
        `SELECT COUNT(*) AS count FROM turn_disposition_claims
          WHERE workspace_id = ? AND task_id = ?`,
        ['ws', payload.entryTaskId],
      )).resolves.toMatchObject({ count: 0 });
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
      const fallbackInstructions = 'Keep the frozen workflow instructions on every fallback attempt.';
      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-runtime-fallback',
        version: 1,
        name: 'runtime-fallback',
        topology: {
          ...TOPOLOGY,
          nodes: [{
            ...TOPOLOGY.nodes[0],
            instructions: {
              kind: 'inline',
              content: fallbackInstructions,
              sha256: createHash('sha256').update(fallbackInstructions).digest('hex'),
            },
          }],
        },
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
          if (options.input.kind !== 'agent') throw new Error('expected agent input');
          calls.push({ backend: backend.name, resumeId: options.resumeId, prompt: options.input.prompt });
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
      expect(calls.every((call) => call.prompt.includes(fallbackInstructions))).toBe(true);
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
      expect(turns.every((turn) => turn.workflowInstructions === fallbackInstructions)).toBe(true);
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
          manifest: {
            schema: 'muster.workflow/v2',
            name: 'public-one-node',
            inputs: [{ name: 'request', kind: 'request', to: 'entry', inputRef: 'request' }],
            outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
            nodes: [{ nodeKey: 'entry', taskType: 'worker' }],
            edges: [],
          },
        },
        context,
      );
      expect(defineRouted.ok).toBe(true);
      if (!defineRouted.ok) return;
      expect(defineRouted.command).toMatchObject({
        kind: 'define_workflow',
        definitionId: expect.stringMatching(/^workflow-[a-f0-9]{32}$/),
      });
      if (
        defineRouted.command.kind !== 'define_workflow' ||
        !('definitionId' in defineRouted.command)
      ) return;
      const firstDefinitionId = defineRouted.command.definitionId;
      const defined = await engine.handleToolCall(
        context,
        'define_workflow',
        defineRouted.command,
      );
      expect(defined).toMatchObject({
        ok: true,
        result: { changed: true, definitionId: firstDefinitionId, version: 1 },
      });

      const editContext = { ...context, turnId: `${turnId}-definition-edit` };
      const revisedRouted = dispatch(
        'define_workflow',
        {
          manifest: {
            schema: 'muster.workflow/v2',
            name: 'public-one-node-revised',
            inputs: [{ name: 'request', kind: 'request', to: 'entry', inputRef: 'request' }],
            outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
            nodes: [{ nodeKey: 'entry', taskType: 'worker' }],
            edges: [],
          },
        },
        editContext,
      );
      expect(revisedRouted.ok).toBe(true);
      if (!revisedRouted.ok) return;
      if (
        revisedRouted.command.kind !== 'define_workflow' ||
        !('definitionId' in revisedRouted.command)
      ) return;
      const revisedDefinitionId = revisedRouted.command.definitionId;
      expect(revisedDefinitionId).not.toBe(firstDefinitionId);
      await expect(engine.handleToolCall(
        editContext,
        'define_workflow',
        revisedRouted.command,
      )).resolves.toMatchObject({
        ok: true,
        result: { changed: true, definitionId: revisedDefinitionId, version: 1 },
      });
      await expect(repository.getLatestWorkflowDefinition(revisedDefinitionId, taskId))
        .resolves.toMatchObject({ version: 1, name: 'public-one-node-revised' });

      const startRouted = dispatch(
        'start_workflow',
        {
          workflow: `${revisedDefinitionId}@1`,
          goal: 'activate one-node via bridge',
          inputs: [
            { name: 'request', value: 'review this change' },
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
        definition_id: revisedDefinitionId,
        definition_version: 1,
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

    } finally {
      release();
      releaseResume();
      await engine?.whenIdle?.().catch(() => undefined);
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
