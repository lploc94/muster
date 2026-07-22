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
import { executeToolCommand, type GraphEngineDeps } from './engine-graph';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { TaskStoreFile } from './types';
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
  const start = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId: def.definitionId,
    version: def.version,
    startIdempotencyKey: startKey,
    createdAt,
    goal: 's07 status projection',
    backend: 'grok',
  });
  expect(start.ok).toBe(true);
  return start.operation?.result?.data as StartPayload;
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
  if (/"topology"|nodes\s*:\s*\[|edges\s*:\s*\[/.test(text)) {
    hits.push('topology');
  }
  if (/"payload_json"|"body_json"|"prompt"|"result":\s*"/.test(text)) {
    hits.push('body-like');
  }
  return hits;
}

function assertBoundedProjection(w: WorkflowTaskStatusProjection): void {
  expect(w.runId).toMatch(/^wfr_/);
  expect(typeof w.definitionId).toBe('string');
  expect(w.definitionId.length).toBeGreaterThan(0);
  expect(Number.isInteger(w.definitionVersion)).toBe(true);
  expect(typeof w.runStatus).toBe('string');
  expect(typeof w.policy.maxWorkflowTurns).toBe('number');
  expect(typeof w.origin).toBe('string');
  expect(typeof w.nodeId).toBe('string');
  expect(Array.isArray(w.gates)).toBe(true);
  expect(Array.isArray(w.feedbackRounds)).toBe(true);
  expect(Array.isArray(w.continuations)).toBe(true);
  expect(Array.isArray(w.diagnostics)).toBe(true);
  for (const g of w.gates) {
    expect(typeof g.gateId).toBe('string');
    expect(typeof g.status).toBe('string');
    expect(typeof g.required).toBe('number');
    expect(typeof g.satisfied).toBe('number');
    expect(g.satisfied).toBeLessThanOrEqual(g.required || g.satisfied);
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
  expect(run).not.toHaveProperty('topology');
  expect(run).not.toHaveProperty('payload_json');
  expect(run).not.toHaveProperty('body_json');
  expect(run).not.toHaveProperty('prompt');
  expect(forbiddenLeak(run)).toEqual([]);
}

function makeStore(file: TaskStoreFile) {
  return {
    getFile: () => file,
  };
}

function makeMinimalDeps(
  file: TaskStoreFile,
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
      await ctx.client.run(
        `UPDATE workflow_runs
            SET owner_root_task_id = ?, caller_task_id = ?, caller_turn_id = ?
          WHERE workspace_id = ? AND run_id = ?`,
        [p1.taskId, p1.taskId, p1.activationTurnId, 'ws', data.runId],
      );
      expect(p1).toBeTruthy();

      const projection = await ctx.repository.getWorkflowStatusForTask(p1.taskId);
      expect(projection).toBeTruthy();
      assertBoundedProjection(projection!);
      expect(projection!.runId).toBe(data.runId);
      expect(projection!.definitionId).toBe('wf-fan');
      expect(projection!.definitionVersion).toBe(1);
      expect(projection!.runStatus).toBe('running');
      expect(projection!.origin).toBe('top_level');
      expect(projection!.parentRunId).toBeUndefined();
      expect(projection!.nodeId).toBe('p1');
      // Fan-in: entry gates satisfied (engine_start), consumer gate open with 2 required.
      expect(projection!.gates.length).toBeGreaterThanOrEqual(1);
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

      const inspection = await ctx.repository.inspectWorkflowRun(data.runId, p1.taskId);
      expect(inspection).toBeTruthy();
      assertBoundedRunInspection(inspection!);
      expect(inspection!.nodes.map((node) => node.nodeId).sort()).toEqual(['consumer', 'p1', 'p2']);
      expect(inspection!.activations.map((activation) => activation.nodeId).sort()).toEqual(['p1', 'p2']);
      await expect(
        ctx.repository.inspectWorkflowRun(data.runId, 'different-root'),
      ).resolves.toBeUndefined();
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
      await ctx.client.run(
        `UPDATE workflow_runs
            SET owner_root_task_id = ?, caller_task_id = ?, caller_turn_id = ?
          WHERE workspace_id = ? AND run_id = ?`,
        [p1.taskId, p1.taskId, p1.activationTurnId, 'ws', data.runId],
      );
      const task = await ctx.repository.getTask(p1.taskId);
      const turn = await ctx.repository.getTurn(p1.activationTurnId);
      expect(task).toBeTruthy();
      expect(turn).toBeTruthy();

      const file: TaskStoreFile = {
        version: 1,
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
          rootId: p1.taskId,
          allowedActions: new Set(['read_subtree', 'inspect_workflow_run']),
        },
        { kind: 'inspect_workflow_run', runId: data.runId },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const inspection = result.result as WorkflowRunInspectionProjection;
      assertBoundedRunInspection(inspection);
      expect(inspection.runId).toBe(data.runId);
      expect(inspection.nodes.map((node) => node.nodeId).sort()).toEqual(['consumer', 'p1', 'p2']);
      expect(JSON.stringify(inspection)).not.toContain('topology');
      expect(JSON.stringify(inspection)).not.toContain('payload_json');

      await expect(executeToolCommand(
        deps,
        {
          callerTaskId: task!.id,
          turnId: turn!.id,
          rootId: 'different-root',
          allowedActions: new Set(['inspect_workflow_run']),
        },
        { kind: 'inspect_workflow_run', runId: data.runId },
      )).resolves.toEqual({ ok: false, error: 'workflow run not found' });
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('projects parent linkage for child runs and open feedback round when present', async () => {
    const ctx = await openRepo('parent-round');
    try {
      const createdAt = '2026-07-21T00:20:00.000Z';
      // Parent top-level run
      const parentStart = await defineAndStartFanIn(
        ctx.repository,
        createdAt,
        's07-parent-1',
      );
      // Manually insert a child run row linked to parent for projection contract
      // (full child invoke is S06; here we only prove parent linkage read).
      const childRunId = 'wfr_s07_child_proj_1';
      await ctx.client.run(
        `INSERT INTO workflow_runs (
           workspace_id, run_id, definition_id, definition_version, status, origin,
           parent_run_id, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          'ws',
          childRunId,
          'wf-fan',
          1,
          'running',
          'child',
          parentStart.runId,
          createdAt,
          createdAt,
        ],
      );
      // Use a distinct child task; workflow ownership forbids one task belonging to two runs.
      const p2 = parentStart.entries.find((e) => e.nodeId === 'p2')!;
      const parentTask = await ctx.repository.getTask(p2.taskId);
      const childTaskId = 's07-child-projection-task';
      await ctx.repository.execute({
        kind: 'createTask',
        workspaceId: 'ws',
        task: {
          ...parentTask!,
          id: childTaskId,
          parentId: p2.taskId,
          revision: 0,
          createdAt,
          updatedAt: createdAt,
        },
      });
      await ctx.client.run(
        `INSERT INTO workflow_nodes (workspace_id, run_id, node_id, task_id, status)
         VALUES (?,?,?,?,?)`,
        ['ws', childRunId, 'entry', childTaskId, 'open'],
      );

      const childProj = await ctx.repository.getWorkflowStatusForTask(childTaskId);
      expect(childProj).toBeTruthy();
      assertBoundedProjection(childProj!);
      expect(childProj!.runId).toBe(childRunId);
      expect(childProj!.origin).toBe('child');
      expect(childProj!.parentRunId).toBe(parentStart.runId);

      // Open feedback round on parent consumer path
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
                        owner_root_task_id = ?, caller_task_id = ?, caller_turn_id = ?,
                        updated_at = ?
                  WHERE workspace_id = ? AND run_id = ?`,
          params: [
            data.runId,
            artifactId,
            p1.taskId,
            p1.taskId,
            p1.activationTurnId,
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
      const runInspection = await ctx.repository.inspectWorkflowRun(data.runId, p1.taskId);
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
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(ctx.repository.getTurn(p1.activationTurnId)).resolves.toBeUndefined();
      await expect(ctx.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      )).resolves.toBeUndefined();
      await expect(ctx.client.get(
        `SELECT artifact_id FROM workflow_artifact_sources
          WHERE workspace_id = ? AND artifact_id = ?`,
        ['ws', artifactId],
      )).resolves.toBeUndefined();
      await expect(ctx.repository.getWorkflowStatusForTask(p1.taskId)).resolves.toBeUndefined();
      await expect(ctx.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 30_000);
});
