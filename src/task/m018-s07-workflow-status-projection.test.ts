/**
 * M018 S07 T01: bounded workflow status projection on get_task_status.
 *
 * Contract:
 * - repository getWorkflowStatusForTask joins nodes → runs → gates/rounds/continuations
 * - get_task_status surfaces a bounded `workflow` section (runId, definitionId+version,
 *   run status, per-gate satisfied/required, active feedback round, continuation,
 *   parent linkage / origin)
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
import type { WorkflowTaskStatusProjection } from './workflow-types';

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
  expect(typeof w.origin).toBe('string');
  expect(typeof w.nodeId).toBe('string');
  expect(Array.isArray(w.gates)).toBe(true);
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
      expect(projection!.activeFeedbackRound).toBeUndefined();
      expect(projection!.continuation).toBeUndefined();
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('get_task_status surfaces bounded workflow section without topology/prompt/body/path leakage', async () => {
    const ctx = await openRepo('status-tool');
    try {
      const createdAt = '2026-07-21T00:10:00.000Z';
      const data = await defineAndStartFanIn(ctx.repository, createdAt, 's07-status-tool-1');
      const p1 = data.entries.find((e) => e.nodeId === 'p1')!;
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
          rootId: task!.id,
          allowedActions: new Set(['read_subtree', 'get_task_status']),
        },
        { kind: 'get_task_status' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const payload = result.result as {
        root: string;
        tasks: unknown[];
        workflow?: WorkflowTaskStatusProjection;
      };
      expect(payload.root).toBe(task!.id);
      expect(payload.workflow).toBeTruthy();
      assertBoundedProjection(payload.workflow!);
      expect(payload.workflow!.runId).toBe(data.runId);
      expect(payload.workflow!.nodeId).toBe('p1');
      // Full tool result must stay free of forbidden leakage classes.
      expect(forbiddenLeak(payload)).toEqual([]);
      expect(JSON.stringify(payload)).not.toContain('topology');
      expect(JSON.stringify(payload)).not.toContain('payload_json');
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
      // Use a distinct child task; schema v9 forbids one task belonging to two runs.
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
           workspace_id, run_id, round_id, requester_node_id, status, join_mode, created_at
         ) VALUES (?,?,?,?,?,?,?)`,
        ['ws', parentStart.runId, roundId, 'consumer', 'open', 'all', createdAt],
      );
      const withRound = await ctx.repository.getWorkflowStatusForTask(p1.taskId);
      expect(withRound?.activeFeedbackRound).toEqual({
        roundId,
        status: 'open',
        joinMode: 'all',
      });
      assertBoundedProjection(withRound!);
    } finally {
      await ctx.close();
    }
  }, 30_000);
});
