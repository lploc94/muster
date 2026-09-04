/**
 * M018 S07 T01: bounded workflow inspection projections.
 *
 * Contract:
 * - repository getWorkflowStatusForTask joins nodes → runs → gates/rounds/continuations
 * - inspect_workflow_run surfaces bounded run policy/status/reason, nodes, gates,
 *   recoverable activations, active feedback rounds, continuations, and diagnostics
 * - never leaks topology, prompts, artifact bodies, secrets, or absolute paths
 *
 * Uses real SQLite worker + repository; graph tool surface via executeToolCommand.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import { buildRepositorySnapshot } from '../host/repository-snapshot';
import { routeExportTask, TASK_EXPORT_ERROR_MESSAGES } from '../host/task-export-route';
import { executeToolCommand, type GraphEngineDeps } from './engine-graph';
import { RepositoryProjection } from './repository-projection';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { DbClient } from './sqlite/client';
import type { EngineProjection, MusterTask } from './types';
import { makeGraphFanInDefinition, entryNodeIds } from './workflow';
import type {
  WorkflowRunInspectionProjection,
  WorkflowTaskStatusProjection,
} from './workflow-types';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

type Opened = {
  dir: string;
  client: DbClient;
  repository: SqliteTaskRepository;
  close: () => Promise<void>;
};

async function openRepo(label: string): Promise<Opened> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s07-${label}-`));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  await client.open(dbPath);
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
    ['ws', `s07-${label}`, `S07 ${label}`, 'now', 'now'],
  );
  const repository = new SqliteTaskRepository(client, 'ws');
  return {
    dir,
    client,
    repository,
    async close() {
      await client.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type StartPayload = {
  runId: string;
  ownerRootTaskId: string;
  entries: Array<{ nodeId: string; taskId: string; gateId: string; activationTurnId: string }>;
  nodeGates: Array<{ nodeId: string; gateId: string }>;
};

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
  const ownerRootTaskId = `s07-root-${startKey}`;
  const callerTurnId = `s07-turn-${startKey}`;
  await repository.execute({
    kind: 'createTask', workspaceId: 'ws',
    task: {
      id: ownerRootTaskId, role: 'coordinator', lifecycle: 'open', releaseState: 'released',
      goal: 's07 root', parentId: null, prerequisites: [], backend: 'grok',
      capabilities: ['create_child'], executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 },
      revision: 0, createdAt, updatedAt: createdAt, releasedAt: createdAt,
    },
  });
  await repository.execute({
    kind: 'createTurn', workspaceId: 'ws',
    turn: { id: callerTurnId, taskId: ownerRootTaskId, sequence: 1, status: 'running', trigger: 'user', inputs: [], createdAt, startedAt: createdAt },
  });
  const start = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId: def.definitionId,
    version: def.version,
    startIdempotencyKey: startKey,
    createdAt,
    goal: 's07 status projection',
    backend: 'grok',
    ownerRootTaskId,
    callerTaskId: ownerRootTaskId,
    callerTurnId,
  });
  expect(start.ok).toBe(true);
  return { ...(start.operation?.result?.data as StartPayload), ownerRootTaskId };
}

function forbiddenLeak(value: unknown): string[] {
  const text = JSON.stringify(value);
  const hits: string[] = [];
  if (/[A-Za-z]:\\/.test(text) || /\/tmp\//.test(text) || /\\\\/.test(text)) {
    hits.push('absolute-path-like');
  }
  if (/SELECT |INSERT |DELETE |UPDATE /i.test(text)) {
    hits.push('sql');
  }
  if (/api[_-]?key|credentials|secret/i.test(text)) {
    hits.push('secret-like');
  }
  if (/"payload_json"|"body_json"|"prompt"|"result":\s*"/.test(text)) {
    hits.push('body-like');
  }
  return hits;
}

function assertBoundedProjection(w: WorkflowTaskStatusProjection): void {
  expect(w.runId).toMatch(/^wfr_/);
  expect(typeof w.definitionId).toBe('string');
  expect(w.definitionId?.length).toBeGreaterThan(0);
  expect(Number.isInteger(w.definitionVersion)).toBe(true);
  expect(typeof w.runStatus).toBe('string');
  expect(typeof w.policy.maxWorkflowTurns).toBe('number');
  expect(w).not.toHaveProperty('origin');
  expect(typeof w.nodeId).toBe('string');
  expect(Array.isArray(w.gates)).toBe(true);
  expect(Array.isArray(w.feedbackRounds)).toBe(true);
  expect(Array.isArray(w.continuations)).toBe(true);
  expect(Array.isArray(w.diagnostics)).toBe(true);
  for (const g of w.gates) {
    expect(typeof g.gateId).toBe('string');
    expect(typeof g.consumerNodeId).toBe('string');
    expect(typeof g.status).toBe('string');
    expect(typeof g.required).toBe('number');
    expect(typeof g.satisfied).toBe('number');
    expect(g.satisfied).toBeLessThanOrEqual(g.required || g.satisfied);
    expect(Array.isArray(g.inputs)).toBe(true);
  }
  // No forbidden fields on the projection object itself.
  expect(w).not.toHaveProperty('topology');
  expect(w).not.toHaveProperty('payload_json');
  expect(w).not.toHaveProperty('body_json');
  expect(w).not.toHaveProperty('prompt');
  expect(forbiddenLeak(w)).toEqual([]);
}

function assertBoundedRunInspection(run: WorkflowRunInspectionProjection): void {
  expect(run.runId).toMatch(/^wfr_/);
  expect(typeof run.definitionId).toBe('string');
  expect(Number.isInteger(run.definitionVersion)).toBe(true);
  expect(typeof run.runStatus).toBe('string');
  expect(Array.isArray(run.nodes)).toBe(true);
  expect(Array.isArray(run.gates)).toBe(true);
  expect(Array.isArray(run.activations)).toBe(true);
  expect(Array.isArray(run.feedbackRounds)).toBe(true);
  expect(Array.isArray(run.continuations)).toBe(true);
  expect(Array.isArray(run.diagnostics)).toBe(true);
  expect(run).not.toHaveProperty('tasks');
  expect(run).not.toHaveProperty('payload_json');
  expect(run).not.toHaveProperty('body_json');
  expect(run).not.toHaveProperty('prompt');
  expect(run).not.toHaveProperty('origin');
  expect(forbiddenLeak(run)).toEqual([]);
}

function makeStore(file: EngineProjection) {
  return {
    getFile: () => file,
    getTask: (taskId: string) => file.tasks[taskId],
    getTurnsForTask: (taskId: string) => Object.values(file.turns)
      .filter((turn) => turn.taskId === taskId),
    viewStatusOf: () => undefined,
  };
}

function makeMinimalDeps(
  file: EngineProjection,
  repository: SqliteTaskRepository,
): GraphEngineDeps {
  const credentials = new CredentialRegistry();
  const askBridge = {
    ask: async () => ({}),
  } as unknown as AskBridge;
  return {
    store: makeStore(file),
    repository,
    workspaceId: 'ws',
    makeBackend: () => {
      throw new Error('backend not used');
    },
    credentials,
    askBridge,
    bridgePort: 0,
    liveRuns: new Map(),
    pendingAskPromises: new Map(),
    onScheduleTurn: () => undefined,
    leaseOwnerAlive: () => false,
    ownsLease: () => false,
    writeCancelRequest: () => undefined,
  };
}

describe('M018 S07 bounded workflow status projection', () => {
  it('returns undefined for unbound tasks; projects run/gate state for bound tasks', async () => {
    const ctx = await openRepo('repo-read');
    try {
      // Unbound task id → undefined (no throw).
      expect(await ctx.repository.getWorkflowStatusForTask('not-a-workflow-task')).toBeUndefined();
      expect(await ctx.repository.getWorkflowStatusForTask('')).toBeUndefined();

      const createdAt = '2026-07-21T00:00:00.000Z';
      const data = await defineAndStartFanIn(ctx.repository, createdAt, 's07-status-1');
      const byNode = new Map(data.entries.map((e) => [e.nodeId, e]));
      const p1 = byNode.get('p1')!;
      expect(p1).toBeTruthy();

      const projection = await ctx.repository.getWorkflowStatusForTask(p1.taskId);
      expect(projection).toBeTruthy();
      assertBoundedProjection(projection!);
      expect(projection!.runId).toBe(data.runId);
      expect(projection!.definitionId).toBe('wf-fan');
      expect(projection!.definitionVersion).toBe(1);
      expect(projection!.runStatus).toBe('running');
      expect(projection!.nodeId).toBe('p1');
      // Fan-in: entry gates satisfied (engine_start), consumer gate open with 2 required.
      expect(projection!.gates.length).toBeGreaterThanOrEqual(1);
      expect(projection!.gates.find((g) => g.consumerNodeId === 'consumer')).toMatchObject({
        status: 'open',
        required: 2,
        satisfied: 0,
        inputs: [
          { inputRef: 'from_p1', producerNodeId: 'p1', state: 'pending' },
          { inputRef: 'from_p2', producerNodeId: 'p2', state: 'pending' },
        ],
      });
      const p1Gate = projection!.gates.find((g) => g.gateId === p1.gateId);
      expect(p1Gate).toBeTruthy();
      expect(p1Gate!.status).toBe('satisfied');
      expect(p1Gate!.required).toBeGreaterThanOrEqual(1);
      expect(p1Gate!.satisfied).toBeGreaterThanOrEqual(1);
      expect(projection!.activeGate).toEqual(p1Gate);
      expect(projection!.activation).toMatchObject({
        status: 'queued',
        sourceGateId: p1.gateId,
        executionTurnId: p1.activationTurnId,
      });
      expect(projection!.feedbackRounds).toEqual([]);
      expect(projection!.continuations).toEqual([]);
      expect(projection!.diagnostics).toEqual([]);

      const inspection = await ctx.repository.inspectWorkflowRun(data.runId, data.ownerRootTaskId);
      expect(inspection).toBeTruthy();
      assertBoundedRunInspection(inspection!);
      expect(inspection!.nodes.map((node) => node.nodeId).sort()).toEqual(['consumer', 'p1', 'p2']);
      expect(inspection!.nodes.find((node) => node.nodeId === 'p1')).not.toHaveProperty('taskId');
      expect(inspection!.activations.map((activation) => activation.nodeId).sort()).toEqual(['p1', 'p2']);
      await expect(
        ctx.repository.inspectWorkflowRun(data.runId, 'different-root'),
      ).resolves.toBeUndefined();
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('fails closed when the run-owned authority digest is corrupted', async () => {
    const ctx = await openRepo('corrupt-authority');
    try {
      const createdAt = '2026-07-21T00:05:00.000Z';
      const data = await defineAndStartFanIn(ctx.repository, createdAt, 's07-corrupt-authority');
      const entry = data.entries.find((candidate) => candidate.nodeId === 'p1')!;
      const projection = await ctx.repository.getWorkflowStatusForTask(entry.taskId);
      expect(projection).toMatchObject({ runId: data.runId, nodeId: 'p1', runStatus: 'running' });
      await ctx.client.run(
        `UPDATE workflow_runs SET authority_fingerprint = ?
           WHERE workspace_id = ? AND run_id = ?`,
        ['a'.repeat(64), 'ws', data.runId],
      );
      await expect(ctx.repository.getWorkflowStatusForTask(entry.taskId)).resolves.toBeUndefined();
      await expect(ctx.repository.getWorkflowGraphForTask(entry.taskId)).resolves.toMatchObject({
        runStatus: 'running',
        diagnostics: [{ code: 'workflow_graph_topology_undecodable' }],
      });
      await expect(ctx.repository.inspectWorkflowRun(data.runId, entry.taskId)).resolves.toBeUndefined();
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('inspect_workflow_run returns only owned bounded run diagnostics', async () => {
    const ctx = await openRepo('status-tool');
    try {
      const createdAt = '2026-07-21T00:10:00.000Z';
      const data = await defineAndStartFanIn(ctx.repository, createdAt, 's07-status-tool-1');
      const p1 = data.entries.find((e) => e.nodeId === 'p1')!;
      const task = await ctx.repository.getTask(p1.taskId);
      const turn = await ctx.repository.getTurn(p1.activationTurnId);
      expect(task).toBeTruthy();
      expect(turn).toBeTruthy();

      const file: EngineProjection = {
        schemaVersion: 1,
        revision: 1,
        tasks: { [task!.id]: task! },
        turns: { [turn!.id]: turn! },
        messages: {},
        toolCalls: {},
        reasoning: {},
        operations: {},
        cancelRequests: {},
      };

      const deps = makeMinimalDeps(file, ctx.repository);
      const result = await executeToolCommand(
        deps,
        {
          callerTaskId: task!.id,
          turnId: turn!.id,
          rootId: data.ownerRootTaskId,
          allowedActions: new Set(['read_subtree', 'inspect_workflow_run']),
        },
        { kind: 'inspect_workflow_run', runId: data.runId },
      );
      expect(result).toEqual({ ok: false, error: 'workflow read is not authorized for the current caller' });

      await expect(executeToolCommand(
        deps,
        {
          callerTaskId: task!.id,
          turnId: turn!.id,
          rootId: 'different-root',
          allowedActions: new Set(['inspect_workflow_run']),
        },
        { kind: 'inspect_workflow_run', runId: data.runId },
      )).resolves.toEqual({ ok: false, error: 'workflow read is not authorized for the current caller' });
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('projects an open feedback round when present', async () => {
    const ctx = await openRepo('parent-round');
    try {
      const createdAt = '2026-07-21T00:20:00.000Z';
      const parentStart = await defineAndStartFanIn(
        ctx.repository,
        createdAt,
        's07-parent-1',
      );
      const p1 = parentStart.entries.find((e) => e.nodeId === 'p1')!;
      const roundId = 'wfrd_s07_open_round_1';
      await ctx.client.run(
        `INSERT INTO workflow_feedback_rounds (
           workspace_id, run_id, round_id, requester_node_id, requester_task_id,
           status, join_mode, created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
        ['ws', parentStart.runId, roundId, 'consumer', p1.taskId, 'open', 'all', createdAt],
      );
      const withRound = await ctx.repository.getWorkflowStatusForTask(p1.taskId);
      expect(withRound?.feedbackRounds).toEqual([
        {
          roundId,
          status: 'open',
          joinMode: 'all',
          role: 'requester',
          required: 0,
          responded: 0,
        },
      ]);
      assertBoundedProjection(withRound!);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('reports terminal integrity drift and prunes terminal workflow history with transcript retention', async () => {
    const ctx = await openRepo('terminal-prune');
    try {
      const createdAt = '2026-07-21T00:30:00.000Z';
      const data = await defineAndStartFanIn(ctx.repository, createdAt, 's07-terminal-prune-1');
      const p1 = data.entries.find((entry) => entry.nodeId === 'p1')!;
      const artifactId = 'wfa_s07_terminal_prune';
      await ctx.client.transaction([
        {
          sql: `INSERT INTO workflow_artifacts (
                  workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                  revision, kind, payload_json, created_at
                ) VALUES (?,?,?,?,?,?,?,?,?)`,
          params: ['ws', data.runId, artifactId, 'p1', 'next_result', 1, 'next_result', '{}', createdAt],
        },
        {
          sql: `INSERT INTO workflow_artifact_sources (
                  workspace_id, run_id, artifact_id, artifact_revision, source_kind,
                  producer_run_id, producer_node_id, producer_task_id, producing_turn_id,
                  producing_activation_id, caller_task_id, caller_turn_id,
                  engine_start_operation_key
                )
                SELECT ?, ?, ?, 1, 'workflow_node', ?, ?, ?, ?, activation_id,
                       NULL, NULL, NULL
                  FROM workflow_activations
                 WHERE workspace_id = ? AND run_id = ? AND execution_turn_id = ?`,
          params: [
            'ws', data.runId, artifactId, data.runId, 'p1', p1.taskId, p1.activationTurnId,
            'ws', data.runId, p1.activationTurnId,
          ],
        },
        {
          sql: `UPDATE turns SET status = 'succeeded', settled_at = ?
                 WHERE workspace_id = ? AND task_id IN (
                   SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ?
                 )`,
          params: ['2026-07-21T00:31:00.000Z', 'ws', 'ws', data.runId],
        },
        {
          sql: `UPDATE workflow_activations SET status = 'consumed', updated_at = ?
                 WHERE workspace_id = ? AND run_id = ?`,
          params: ['2026-07-21T00:31:00.000Z', 'ws', data.runId],
        },
        {
          sql: `UPDATE workflow_dependency_gates SET status = 'failed'
                 WHERE workspace_id = ? AND run_id = ?`,
          params: ['ws', data.runId],
        },
         {
           sql: `UPDATE workflow_runs
                    SET status = 'failed', terminal_reason_code = 'agent_fail',
                        terminal_result_run_id = ?, terminal_result_artifact_id = ?,
                        terminal_result_artifact_revision = 1,
                        updated_at = ?
                  WHERE workspace_id = ? AND run_id = ?`,
          params: [
            data.runId,
            artifactId,
            '2026-07-21T00:31:00.000Z',
            'ws',
            data.runId,
          ],
        },
      ]);

      const nodes = await ctx.client.all<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL`,
        ['ws', data.runId],
      );
      for (const node of nodes) {
        const task = await ctx.repository.getTask(node.task_id);
        expect(task).toBeTruthy();
        await ctx.repository.execute({
          kind: 'upsertTask',
          workspaceId: 'ws',
          task: {
            ...task!,
            lifecycle: 'succeeded',
            finishedAt: '2026-07-21T00:32:00.000Z',
            updatedAt: '2026-07-21T00:32:00.000Z',
            revision: task!.revision + 1,
          },
        });
      }

      const gateId = data.nodeGates[0]!.gateId;
      await ctx.client.run(
        `UPDATE workflow_dependency_gates SET status = 'open'
          WHERE workspace_id = ? AND run_id = ? AND gate_id = ?`,
        ['ws', data.runId, gateId],
      );
      const corrupt = await ctx.repository.getWorkflowStatusForTask(p1.taskId);
      expect(corrupt?.runStatus).toBe('failed');
      expect(corrupt?.terminalReason).toBe('agent_fail');
      expect(corrupt?.diagnostics).toContainEqual({ code: 'terminal_run_has_live_gate' });
      expect(forbiddenLeak(corrupt)).toEqual([]);
      const runInspection = await ctx.repository.inspectWorkflowRun(data.runId, data.ownerRootTaskId);
      expect(runInspection?.terminalResult).toEqual({
        runId: data.runId,
        artifactId,
        artifactRevision: 1,
      });
      expect(runInspection?.diagnostics).toContainEqual({ code: 'terminal_run_has_live_gate' });
      expect(forbiddenLeak(runInspection)).toEqual([]);
      await expect(ctx.repository.execute({
        kind: 'applyRetention',
        workspaceId: 'ws',
        taskId: p1.taskId,
        keepLatestTurns: 0,
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(ctx.repository.getTurn(p1.activationTurnId)).resolves.toBeDefined();
      await ctx.client.run(
        `UPDATE workflow_dependency_gates SET status = 'failed'
          WHERE workspace_id = ? AND run_id = ? AND gate_id = ?`,
        ['ws', data.runId, gateId],
      );

      await expect(ctx.repository.execute({
        kind: 'applyRetention',
        workspaceId: 'ws',
        taskId: p1.taskId,
        keepLatestTurns: 0,
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(ctx.repository.getTurn(p1.activationTurnId)).resolves.toBeDefined();

      // Retention must not delete the durable run envelope. Its start claim and
      // operation ledger are replay identities, while artifacts remain immutable
      // workflow evidence. This fixture has no routed transport body to strip.
      await expect(ctx.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: 'ws',
      })).resolves.toMatchObject({ ok: true, changed: false, strippedWorkflowMessageBodies: 0 });
      await expect(ctx.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      )).resolves.toMatchObject({ run_id: data.runId });
      await expect(ctx.client.get(
        `SELECT artifact_id FROM workflow_artifact_sources
          WHERE workspace_id = ? AND artifact_id = ?`,
        ['ws', artifactId],
      )).resolves.toMatchObject({ artifact_id: artifactId });
      await expect(ctx.repository.getWorkflowStatusForTask(p1.taskId)).resolves.toBeDefined();
      await expect(ctx.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('projects bounded display title and durable decision repair attempt state after reload', async () => {
    const ctx = await openRepo('decision-repair-projection');
    let reopened: DbClient | undefined;
    try {
      const createdAt = '2026-08-01T00:00:00.000Z';
      const base = makeGraphFanInDefinition({
        definitionId: 'wf-decision-projection',
        createdAt,
      });
      const secretCondition = 'PRIVATE_CONDITION_TEXT_MUST_NOT_CROSS';
      const definition = {
        ...base,
        topology: {
          ...base.topology,
          nodes: base.topology.nodes.map((node) => node.nodeId === 'p1'
            ? {
                ...node,
                title: 'Repair planner',
                outcome: {
                  kind: 'agent' as const,
                  requireExplicitDisposition: true,
                  next: { when: secretCondition },
                  fail: { when: 'No safe route remains.' },
                },
              }
            : node),
        },
      };
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: definition.definitionId,
        version: definition.version,
        name: definition.name,
        topology: definition.topology,
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: definition.definitionId,
        version: definition.version,
        startIdempotencyKey: 'decision-projection-start',
        createdAt,
        goal: 'project durable decision state',
        backend: 'grok',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const data = started.operation?.result?.data as StartPayload;
      const p1 = data.entries.find((entry) => entry.nodeId === 'p1')!;
      const activation = await ctx.client.get<{ activation_id: string }>(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ? AND node_id = ?`,
        ['ws', data.runId, 'p1'],
      );
      expect(activation).toBeTruthy();

      await ctx.client.run(
        `UPDATE turns SET status = 'succeeded', settled_at = ?,
                          payload_json = json_set(payload_json, '$.status', 'succeeded')
          WHERE workspace_id = ? AND id = ?`,
        ['2026-08-01T00:00:01.000Z', 'ws', p1.activationTurnId],
      );
      const correctionTurnId = 'turn-decision-projection-attempt-2';
      await expect(ctx.repository.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: {
          id: correctionTurnId,
          taskId: p1.taskId,
          sequence: 2,
          trigger: 'engine',
          status: 'queued',
          inputs: [],
          createdAt: '2026-08-01T00:00:02.000Z',
        },
      })).resolves.toMatchObject({ ok: true, changed: true });
      await ctx.client.transaction([
        {
          sql: `INSERT INTO workflow_decision_repairs (
                  workspace_id, run_id, activation_id, status, attempts_used,
                  last_attempt_turn_id, last_error_code, last_response_message_id,
                  next_repair_turn_id, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'ws', data.runId, activation!.activation_id, 'open', 1,
            p1.activationTurnId, 'decision_invalid', null, correctionTurnId,
            '2026-08-01T00:00:02.000Z', '2026-08-01T00:00:02.000Z',
          ],
        },
        {
          sql: `UPDATE workflow_activations
                   SET execution_turn_id = ?, status = 'queued', updated_at = ?
                 WHERE workspace_id = ? AND run_id = ? AND activation_id = ?`,
          params: [
            correctionTurnId, '2026-08-01T00:00:02.000Z',
            'ws', data.runId, activation!.activation_id,
          ],
        },
      ]);

      const expectedDecision = {
        status: 'correcting',
        attempt: 2,
        maxAttempts: 3,
      };
      await expect(ctx.repository.getWorkflowStatusForTask(p1.taskId)).resolves.toMatchObject({
        nodeId: 'p1',
        title: 'Repair planner',
        decisionGate: 'required',
        decision: expectedDecision,
        activation: { executionTurnId: correctionTurnId },
      });
      const graph = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
      expect(graph?.nodes).toHaveLength(3);
      expect(graph?.nodes.find((node) => node.nodeId === 'p1')).toMatchObject({
        title: 'Repair planner',
        decisionGate: 'required',
        decision: expectedDecision,
      });
      expect(JSON.stringify(graph)).not.toContain(secretCondition);
      expect(JSON.stringify(graph)).not.toMatch(/last_response|last_error|activation_id|turn-decision/);

      await ctx.client.close();
      reopened = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
      await reopened.open(path.join(ctx.dir, 'muster.sqlite3'));
      const reloadedRepository = new SqliteTaskRepository(reopened, 'ws');
      await expect(reloadedRepository.getWorkflowStatusForTask(p1.taskId)).resolves.toMatchObject({
        title: 'Repair planner',
        decisionGate: 'required',
        decision: expectedDecision,
      });
      await expect(reloadedRepository.getWorkflowGraphForTask(p1.taskId)).resolves.toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: 'p1', decision: expectedDecision }),
        ]),
      });
    } finally {
      await reopened?.close().catch(() => undefined);
      await ctx.client.close().catch(() => undefined);
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('retries the complete status read when decision exhaustion closes the run concurrently', async () => {
    const ctx = await openRepo('decision-exhaustion-read-race');
    const peer = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    try {
      await peer.open(path.join(ctx.dir, 'muster.sqlite3'));
      const createdAt = '2026-08-01T00:10:00.000Z';
      const base = makeGraphFanInDefinition({
        definitionId: 'wf-decision-exhaustion-read-race',
        createdAt,
      });
      const definition = {
        ...base,
        topology: {
          ...base.topology,
          nodes: base.topology.nodes.map((node) => node.nodeId === 'p1'
            ? {
                ...node,
                outcome: {
                  kind: 'agent' as const,
                  requireExplicitDisposition: true,
                  next: { when: 'Proceed safely.' },
                  fail: { when: 'No safe route remains.' },
                },
              }
            : node),
        },
      };
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: definition.definitionId,
        version: definition.version,
        name: definition.name,
        topology: definition.topology,
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: definition.definitionId,
        version: definition.version,
        startIdempotencyKey: 'decision-exhaustion-read-race',
        createdAt,
        goal: 'read one coherent terminal decision state',
        backend: 'grok',
      });
      const data = started.operation?.result?.data as StartPayload;
      const p1 = data.entries.find((entry) => entry.nodeId === 'p1')!;
      const activation = await ctx.client.get<{ activation_id: string }>(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ? AND node_id = ?`,
        ['ws', data.runId, 'p1'],
      );
      expect(activation).toBeTruthy();
      await ctx.client.run(
        `INSERT INTO workflow_decision_repairs (
           workspace_id, run_id, activation_id, status, attempts_used,
           last_attempt_turn_id, last_error_code, last_response_message_id,
           next_repair_turn_id, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'ws', data.runId, activation!.activation_id, 'open', 2,
          p1.activationTurnId, 'decision_invalid', null, p1.activationTurnId,
          createdAt, createdAt,
        ],
      );

      const originalAll = ctx.client.all.bind(ctx.client);
      let decisionReads = 0;
      let exhausted = false;
      (ctx.client as unknown as { all: typeof ctx.client.all }).all = async (sql, params) => {
        if (
          sql.includes('FROM workflow_activations activation')
          && sql.includes('LEFT JOIN workflow_decision_repairs repair')
        ) {
          decisionReads += 1;
          if (!exhausted) {
            exhausted = true;
            await peer.transaction([
              {
                sql: `UPDATE turns
                         SET status = 'failed', settled_at = ?,
                             payload_json = json_set(payload_json, '$.status', 'failed')
                       WHERE workspace_id = ? AND task_id IN (
                         SELECT task_id FROM workflow_nodes
                          WHERE workspace_id = ? AND run_id = ?
                       ) AND status IN ('queued', 'running', 'waiting_user')`,
                params: ['2026-08-01T00:10:01.000Z', 'ws', 'ws', data.runId],
              },
              {
                sql: `UPDATE workflow_activations
                         SET status = 'failed', updated_at = ?
                       WHERE workspace_id = ? AND run_id = ?
                         AND status IN ('queued', 'running')`,
                params: ['2026-08-01T00:10:01.000Z', 'ws', data.runId],
              },
              {
                sql: `UPDATE workflow_decision_repairs
                         SET status = 'exhausted', attempts_used = 3,
                             next_repair_turn_id = NULL, updated_at = ?
                       WHERE workspace_id = ? AND run_id = ? AND activation_id = ?`,
                params: [
                  '2026-08-01T00:10:01.000Z', 'ws', data.runId, activation!.activation_id,
                ],
              },
              {
                sql: `UPDATE workflow_runs
                         SET status = 'failed', terminal_reason_code = 'decision_invalid', updated_at = ?
                       WHERE workspace_id = ? AND run_id = ?`,
                params: ['2026-08-01T00:10:01.000Z', 'ws', data.runId],
              },
              {
                sql: `INSERT INTO workspace_revisions (workspace_id, revision) VALUES (?, 1)
                      ON CONFLICT(workspace_id) DO UPDATE
                      SET revision = workspace_revisions.revision + 1`,
                params: ['ws'],
              },
            ]);
          }
        }
        return originalAll(sql, params);
      };

      const projection = await ctx.repository.getWorkflowStatusForTask(p1.taskId);
      expect(decisionReads).toBe(2);
      expect(projection).toMatchObject({
        runStatus: 'failed',
        terminalReason: 'decision_invalid',
        decision: { status: 'exhausted', attempt: 3, maxAttempts: 3 },
      });
    } finally {
      await peer.close().catch(() => undefined);
      await ctx.close();
    }
  }, 30_000);

  it('projects host-only workflow graph topology and lifecycle for a task-bound run', async () => {
    const ctx = await openRepo('host-graph');
    try {
      expect(await ctx.repository.getWorkflowGraphForTask('not-a-workflow-task')).toBeUndefined();
      const createdAt = '2026-08-01T00:00:00.000Z';
      const data = await defineAndStartFanIn(ctx.repository, createdAt, 's04-host-graph-1');
      const p1 = data.entries.find((entry) => entry.nodeId === 'p1')!;

      const graph = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
      expect(graph).toMatchObject({
        runStatus: 'running',
        nodes: expect.arrayContaining([
          {
            nodeId: 'p1', workflowNodeStatus: 'active', executionActivity: 'queued',
            displayState: 'queued', progressBucket: 'queued',
            decisionGate: 'required',
            decision: { status: 'waiting', attempt: 1, maxAttempts: 3 },
          },
          {
            nodeId: 'p2', workflowNodeStatus: 'active', executionActivity: 'queued',
            displayState: 'queued', progressBucket: 'queued',
            decisionGate: 'required',
            decision: { status: 'waiting', attempt: 1, maxAttempts: 3 },
          },
          {
            nodeId: 'consumer', workflowNodeStatus: 'pending', executionActivity: 'none',
            displayState: 'blocked', progressBucket: 'blocked', reason: 'waiting_for_inputs',
            decisionGate: 'required',
          },
        ]),
        edges: expect.arrayContaining([
          {
            fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'from_p1',
            contributionState: 'pending',
          },
          {
            fromNodeId: 'p2', toNodeId: 'consumer', inputRef: 'from_p2',
            contributionState: 'pending',
          },
        ]),
        gates: expect.arrayContaining([
          expect.objectContaining({
            consumerNodeId: 'consumer', required: 2, satisfied: 0,
            inputs: expect.arrayContaining([
              { inputRef: 'from_p1', producerNodeId: 'p1', state: 'pending' },
              { inputRef: 'from_p2', producerNodeId: 'p2', state: 'pending' },
            ]),
          }),
        ]),
        activeGate: expect.objectContaining({ consumerNodeId: 'p1', status: 'satisfied' }),
        progress: {
          total: 3, completed: 0, queued: 2, executing: 0, waiting: 0,
          blocked: 1, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
          frontierNodeIds: ['consumer', 'p1', 'p2'], activeNodeIds: [],
        },
        feedbackRounds: [],
        reuse: { nodeCount: 0, edgeCount: 0 },
        diagnostics: [],
      });

      await ctx.client.run(
        `UPDATE turns SET status = 'succeeded', settled_at = ?,
                          payload_json = json_set(payload_json, '$.status', 'succeeded')
          WHERE workspace_id = 'ws' AND id = ?`,
        ['2026-08-01T00:00:00.500Z', p1.activationTurnId],
      );
      const awaitingRoute = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
      expect(awaitingRoute?.nodes.find((node) => node.nodeId === 'p1')).toMatchObject({
        workflowNodeStatus: 'active', executionActivity: 'completed',
        displayState: 'waiting', progressBucket: 'waiting', reason: 'awaiting_workflow_route',
      });
      expect(awaitingRoute?.progress).toMatchObject({ completed: 0, waiting: 1 });
      expect(awaitingRoute?.progress.frontierNodeIds).toEqual(['consumer', 'p1', 'p2']);
      await ctx.client.run(
        `UPDATE turns SET status = 'interrupted',
                          payload_json = json_set(payload_json, '$.status', 'interrupted')
          WHERE workspace_id = 'ws' AND id = ?`,
        [p1.activationTurnId],
      );
      const interrupted = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
      expect(interrupted?.nodes.find((node) => node.nodeId === 'p1')).toMatchObject({
        executionActivity: 'failed', displayState: 'failed', progressBucket: 'failed',
      });
      for (const workflowNodeStatus of ['cancelled', 'skipped'] as const) {
        await ctx.client.run(
          `UPDATE workflow_nodes SET status = ?
            WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'p1'`,
          [workflowNodeStatus, data.runId],
        );
        const authoritativeTerminalNode = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
        expect(authoritativeTerminalNode?.nodes.find((node) => node.nodeId === 'p1')).toMatchObject({
          workflowNodeStatus,
          executionActivity: 'failed',
          displayState: workflowNodeStatus,
          progressBucket: workflowNodeStatus,
        });
      }
      await ctx.client.run(
        `UPDATE workflow_nodes SET status = 'active'
          WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'p1'`,
        [data.runId],
      );
      await ctx.client.run(
        `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL,
                          payload_json = json_set(payload_json, '$.status', 'running')
          WHERE workspace_id = 'ws' AND id = ?`,
        ['2026-08-01T00:00:01.000Z', p1.activationTurnId],
      );
      const p2 = data.entries.find((entry) => entry.nodeId === 'p2')!;
      await ctx.client.run(
        `UPDATE turns SET status = 'running', started_at = ?
          WHERE workspace_id = 'ws' AND id = ?`,
        ['2026-08-01T00:00:01.000Z', p2.activationTurnId],
      );
      const concurrentlyExecuting = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
      expect(concurrentlyExecuting?.progress.activeNodeIds).toEqual(['p1', 'p2']);
      expect(concurrentlyExecuting?.progress.executing).toBe(2);
      await ctx.client.run(
        `UPDATE turns SET status = 'waiting_user'
          WHERE workspace_id = 'ws' AND id = ?`,
        [p2.activationTurnId],
      );
      const executing = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
      expect(executing?.nodes.find((node) => node.nodeId === 'p1')).toMatchObject({
        workflowNodeStatus: 'active',
        executionActivity: 'executing',
        displayState: 'executing',
        progressBucket: 'executing',
      });
      expect(executing?.progress.activeNodeIds).toEqual(['p1']);
      expect(executing?.nodes.find((node) => node.nodeId === 'p2')).toMatchObject({
        executionActivity: 'waiting_feedback',
        displayState: 'waiting',
        progressBucket: 'waiting',
      });
      expect(executing?.progress.frontierNodeIds).toEqual(['consumer', 'p1', 'p2']);

      await ctx.client.run(
        `UPDATE workflow_nodes SET status = 'succeeded'
          WHERE workspace_id = 'ws' AND run_id = ? AND node_id IN ('p1','p2')`,
        [data.runId],
      );
      await ctx.client.run(
        `UPDATE turns SET status = 'succeeded', settled_at = ?,
                          payload_json = json_set(payload_json, '$.status', 'succeeded')
          WHERE workspace_id = 'ws' AND id = ?`,
        ['2026-08-01T00:00:02.000Z', p2.activationTurnId],
      );
      const crossAxis = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
      expect(crossAxis?.nodes.find((node) => node.nodeId === 'p1')).toMatchObject({
        workflowNodeStatus: 'succeeded',
        executionActivity: 'executing',
        displayState: 'completed',
        progressBucket: 'completed',
      });
      expect(crossAxis?.nodes.find((node) => node.nodeId === 'p2')).toMatchObject({
        workflowNodeStatus: 'succeeded',
        executionActivity: 'completed',
        displayState: 'completed',
      });
      expect(crossAxis?.nodes.find((node) => node.nodeId === 'consumer')).toMatchObject({
        workflowNodeStatus: 'pending',
        executionActivity: 'none',
        displayState: 'blocked',
        progressBucket: 'blocked',
        reason: 'waiting_for_inputs',
      });
      expect(crossAxis?.progress).toMatchObject({
        total: 3, completed: 2, executing: 0, notStarted: 0,
        queued: 0, waiting: 0, blocked: 1, failed: 0, cancelled: 0, skipped: 0,
      });
      expect(crossAxis?.progress.activeNodeIds).toEqual([]);

      const consumer = await ctx.client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'consumer'`,
        [data.runId],
      );
      for (const lifecycle of ['cancelled', 'skipped'] as const) {
        await ctx.client.transaction([
          {
            sql: `UPDATE workflow_nodes SET status = ?
                   WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'consumer'`,
            params: [lifecycle, data.runId],
          },
          {
            sql: `UPDATE tasks SET lifecycle = ?,
                           payload_json = json_set(payload_json, '$.lifecycle', ?)
                   WHERE workspace_id = 'ws' AND id = ?`,
            params: [lifecycle, lifecycle, consumer!.task_id],
          },
        ]);
        const state = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
        expect(state?.nodes.find((node) => node.nodeId === 'consumer')?.displayState).toBe(lifecycle);
      }
      await ctx.client.transaction([
        {
          sql: `UPDATE workflow_nodes SET status = 'pending'
                 WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'consumer'`,
          params: [data.runId],
        },
        {
          sql: `UPDATE tasks SET lifecycle = 'open',
                         payload_json = json_set(payload_json, '$.lifecycle', 'open')
                 WHERE workspace_id = 'ws' AND id = ?`,
          params: [consumer!.task_id],
        },
      ]);
      await ctx.client.run(
        `UPDATE workflow_nodes SET status = 'active'
          WHERE workspace_id = 'ws' AND run_id = ? AND node_id = 'p1'`,
        [data.runId],
      );
      const p1Task = await ctx.repository.getTask(p1.taskId);
      const p1Turn = await ctx.repository.getTurn(p1.activationTurnId);
      const failureDisposition = { kind: 'workflow_fail' as const, reason: 'matrix failure' };
      await stageDispositionForSettlement(ctx.repository, p1Turn!, failureDisposition);
      await expect(ctx.repository.execute({
        kind: 'settleTurnAndApplyEffects',
        workspaceId: 'ws',
        expectedTaskRevision: p1Task!.revision,
        task: { ...p1Task!, updatedAt: '2026-08-01T00:00:03.000Z' },
        turn: {
          ...p1Turn!, status: 'succeeded', finishedAt: '2026-08-01T00:00:03.000Z',
          disposition: failureDisposition,
        },
        expectedStatuses: ['running'],
        relatedTurns: [],
        messages: [],
      })).resolves.toMatchObject({ changed: true });
      const terminalMatrix = await ctx.repository.getWorkflowGraphForTask(p1.taskId);
      expect(terminalMatrix?.nodes.map((node) => [node.nodeId, node.displayState])).toEqual([
        ['consumer', 'failed'],
        ['p1', 'failed'],
        ['p2', 'completed'],
      ]);
      expect(terminalMatrix?.progress).toMatchObject({
        total: 3, completed: 1, queued: 0, executing: 0, waiting: 0,
        blocked: 0, notStarted: 0, failed: 2, cancelled: 0, skipped: 0,
      });
      const terminalInspection = await ctx.repository.inspectWorkflowRun(data.runId, data.ownerRootTaskId);
      expect(terminalInspection?.runStatus).toBe('failed');
      expect(terminalInspection?.diagnostics).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 30_000);
});
