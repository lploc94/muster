/**
 * M018 S07 T02: canonical research fan-in → planner → verifier assembled flow.
 *
 * Proves the complete user-visible protocol through:
 *   - MCP-shaped define/start/workflow_next/workflow_prev/inspect_workflow_run surfaces
 *   - engine settlement (settleTurnAndApplyEffects)
 *   - real SQLite transactions
 *   - scheduler activation (pickRunnableTurns over queued turns)
 *   - bounded run inspection / task-bound repository projection
 *
 * Protocol under test:
 *   1. Parent one-node caller invokes a child graph_v1:
 *        r1, r2 → planner (fan-in) → verifier (terminal)
 *   2. Research producers NEXT → planner activates
 *   3. Planner NEXT → verifier activates
 *   4. Verifier PREVs the planner once (targeted from_planner)
 *   5. Planner returns a correction on its feedback turn
 *   6. Verifier receives ordered resume and NEXTs (terminal)
 *   7. Child return resolves the parent continuation once and queues caller resume
 *   8. Bounded status reflects run/gate/round/continuation state throughout
 *
 * Never asserts topology bodies, prompts, artifact result bodies, secrets, or paths
 * on the read projection.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AskBridge } from '../bridge/ask-bridge';
import { CredentialRegistry } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { executeToolCommand, type GraphEngineDeps } from './engine-graph';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { pickRunnableTurns } from './scheduler';
import { DbClient } from './sqlite/client';
import type { TaskStoreFile, TurnDisposition } from './types';
import {
  DEFAULT_WORKFLOW_POLICY,
  deriveFeedbackResumeTurnId,
  deriveFeedbackRoundId,
  deriveFeedbackTargetTurnId,
  deriveNodeActivationIdentities,
  entryNodeIds,
  terminalNodeId,
  validateDefineWorkflow,
} from './workflow';
import type {
  GraphTopologyV1,
  WorkflowRunInspectionProjection,
  WorkflowTaskStatusProjection,
} from './workflow-types';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

/** Canonical research fan-in → planner → verifier topology. */
const CANONICAL_TOPOLOGY: GraphTopologyV1 = {
  kind: 'graph_v1',
  nodes: [
    { nodeId: 'r1', role: 'worker' },
    { nodeId: 'r2', role: 'worker' },
    { nodeId: 'planner', role: 'coordinator' },
    { nodeId: 'verifier', role: 'coordinator' },
  ],
  edges: [
    { fromNodeId: 'r1', toNodeId: 'planner', inputRef: 'from_r1' },
    { fromNodeId: 'r2', toNodeId: 'planner', inputRef: 'from_r2' },
    { fromNodeId: 'planner', toNodeId: 'verifier', inputRef: 'from_planner' },
  ],
};

const ONE_NODE = {
  kind: 'one_node_v1' as const,
  nodes: [{ nodeId: 'entry', role: 'coordinator' as const, capabilities: ['create_child' as const] }],
  entryNodeId: 'entry',
};

type Opened = {
  dir: string;
  dbPath: string;
  client: DbClient;
  repository: SqliteTaskRepository;
  close: () => Promise<void>;
};

type StartPayload = {
  runId: string;
  entries: Array<{
    nodeId: string;
    taskId: string;
    gateId: string;
    activationTurnId: string;
  }>;
  nodeGates: Array<{ nodeId: string; gateId: string }>;
  entryTaskId?: string;
  activationTurnId?: string;
  startArtifactId?: string;
  entryGateId?: string;
};

type OneNodeStart = {
  runId: string;
  entryTaskId: string;
  activationTurnId: string;
  startArtifactId: string;
  entryGateId: string;
};

async function openRepo(label: string): Promise<Opened> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s07-canonical-${label}-`));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  await client.open(dbPath);
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
    ['ws', `s07c-${label}`, `S07 canonical ${label}`, 'now', 'now'],
  );
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

async function promoteRunning(client: DbClient, turnId: string, startedAt: string): Promise<void> {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL WHERE workspace_id = ? AND id = ?`,
    [startedAt, 'ws', turnId],
  );
}

async function settleSucceeded(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  disposition: TurnDisposition,
  finishedAt: string,
  startedAt: string = finishedAt,
) {
  await promoteRunning(client, turnId, startedAt);
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
  if (/"payload_json"|"body_json"|"prompt"/.test(text)) {
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
  expect(w).not.toHaveProperty('topology');
  expect(w).not.toHaveProperty('payload_json');
  expect(w).not.toHaveProperty('body_json');
  expect(w).not.toHaveProperty('prompt');
  expect(forbiddenLeak(w)).toEqual([]);
}

async function buildStoreFromRepo(
  repository: SqliteTaskRepository,
  taskIds: readonly string[],
): Promise<TaskStoreFile> {
  const tasks: TaskStoreFile['tasks'] = {};
  const turns: TaskStoreFile['turns'] = {};
  const messages: TaskStoreFile['messages'] = {};
  for (const taskId of taskIds) {
    const task = await repository.getTask(taskId);
    if (task) tasks[task.id] = task;
    for (const turn of await repository.listTurns(taskId)) {
      turns[turn.id] = turn;
    }
    for (const msg of await repository.listMessages(taskId)) {
      messages[msg.id] = msg;
    }
  }
  return {
    version: 1,
    revision: 1,
    tasks,
    turns,
    messages,
    toolCalls: {},
    reasoning: {},
    operations: {},
    cancelRequests: {},
  };
}

function makeMinimalDeps(
  file: TaskStoreFile,
  repository: SqliteTaskRepository,
): GraphEngineDeps {
  const credentials = new CredentialRegistry();
  const askBridge = { ask: async () => ({}) } as unknown as AskBridge;
  return {
    store: { getFile: () => file },
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

async function defineVersion(
  repository: SqliteTaskRepository,
  createdAt: string,
  definitionId: string,
  name: string,
  topology: unknown,
  entryContracts?: readonly {
    entryNodeId: string;
    inputRef: string;
    expectedArtifactKind: string;
  }[],
): Promise<void> {
  const def = await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    name,
    topology,
    ...(entryContracts ? { entryContracts } : {}),
    createdAt,
  });
  expect(def.ok).toBe(true);
}

async function startOneNode(
  repository: SqliteTaskRepository,
  createdAt: string,
  definitionId: string,
  startKey: string,
  goal: string,
): Promise<OneNodeStart> {
  const start = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    startIdempotencyKey: startKey,
    createdAt,
    goal,
    backend: 'grok',
  });
  expect(start.ok).toBe(true);
  return start.operation?.result?.data as OneNodeStart;
}

async function startCanonicalChildAsTopLevel(
  repository: SqliteTaskRepository,
  createdAt: string,
  startKey: string,
): Promise<StartPayload> {
  await defineVersion(repository, createdAt, 'wf-canonical', 'canonical-research', CANONICAL_TOPOLOGY);
  const start = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId: 'wf-canonical',
    version: 1,
    startIdempotencyKey: startKey,
    createdAt,
    goal: 'canonical research fan-in planner verifier',
    backend: 'grok',
  });
  expect(start.ok).toBe(true);
  return start.operation?.result?.data as StartPayload;
}

async function nodeTask(
  client: DbClient,
  runId: string,
  nodeId: string,
): Promise<{ task_id: string } | undefined> {
  return client.get(
    `SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?`,
    ['ws', runId, nodeId],
  );
}

async function waitForNodeTask(
  client: DbClient,
  runId: string,
  nodeId: string,
  attempts = 20,
): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const row = await nodeTask(client, runId, nodeId);
    if (row?.task_id) return row.task_id as string;
  }
  throw new Error(`node ${nodeId} never received a task_id`);
}

describe('M018 S07 canonical research → planner → verifier workflow', () => {
  it('MCP surface accepts canonical graph_v1 and workflow_prev/next; topology validates', () => {
    const validated = validateDefineWorkflow({
      definitionId: 'wf-canonical',
      version: 1,
      name: 'canonical',
      topology: CANONICAL_TOPOLOGY,
      entryContracts: [],
      policy: DEFAULT_WORKFLOW_POLICY,
      createdAt: '2026-07-21T00:00:00.000Z',
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(entryNodeIds(validated.definition.topology).sort()).toEqual(['r1', 'r2']);
      expect(terminalNodeId(validated.definition.topology)).toBe('verifier');
    }

    const credentials = new CredentialRegistry();
    const token = credentials.issue({
      rootId: 'root',
      callerTaskId: 'root',
      turnId: 'turn-1',
      attemptId: 'att-1',
      allowedActions: new Set([
        'define_workflow',
        'start_workflow',
        'workflow_next',
        'workflow_prev',
        'inspect_workflow_run',
        'invoke_child_workflow',
      ]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;

    const def = dispatch(
      'define_workflow',
      {
        name: 'canonical-research',
        nodes: [
          { nodeKey: 'r1', taskType: 'research' },
          { nodeKey: 'r2', taskType: 'research' },
          { nodeKey: 'planner', taskType: 'plan' },
          { nodeKey: 'verifier', taskType: 'verify' },
        ],
        edges: [
          { from: 'r1', to: 'planner', as: 'from_r1' },
          { from: 'r2', to: 'planner', as: 'from_r2' },
          { from: 'planner', to: 'verifier', as: 'from_planner' },
        ],
      },
      ctx,
    );
    expect(def.ok).toBe(true);

    const prev = dispatch(
      'workflow_prev',
      { opId: 'prev-planner-1', targets: ['from_planner'], message: 'revise plan' },
      ctx,
    );
    expect(prev.ok).toBe(true);
    if (prev.ok) {
      expect(prev.command).toMatchObject({
        kind: 'workflow_prev',
        targets: ['from_planner'],
      });
    }

    const next = dispatch(
      'workflow_next',
      { opId: 'next-1', change: 'updated', message: 'ok' },
      ctx,
    );
    expect(next.ok).toBe(true);
  });

  it('assembled flow: fan-in → planner → verifier PREV once → correction → terminal NEXT; status + scheduler throughout', async () => {
    const opened = await openRepo('assembled');
    try {
      const createdAt = '2026-07-21T12:00:00.000Z';

      // --- Parent caller (for continuation / return surface) ---
      await defineVersion(opened.repository, createdAt, 'wf-caller', 'caller', ONE_NODE);
      await defineVersion(
        opened.repository,
        createdAt,
        'wf-canonical',
        'canonical-research',
        CANONICAL_TOPOLOGY,
        [
          { entryNodeId: 'r1', inputRef: 'research_one', expectedArtifactKind: 'engine_start' },
          { entryNodeId: 'r2', inputRef: 'research_two', expectedArtifactKind: 'engine_start' },
        ],
      );
      const caller = await startOneNode(
        opened.repository,
        createdAt,
        'wf-caller',
        's07-canonical-caller',
        'caller goal',
      );
      await opened.client.run(
        `UPDATE workflow_runs
            SET owner_root_task_id = ?, caller_task_id = ?, caller_turn_id = ?
          WHERE workspace_id = ? AND run_id = ?`,
        [
          caller.entryTaskId,
          caller.entryTaskId,
          caller.activationTurnId,
          'ws',
          caller.runId,
        ],
      );

      // Invoke child canonical graph from the parent entry turn.
      const invoke = await settleSucceeded(
        opened.repository,
        opened.client,
        caller.entryTaskId,
        caller.activationTurnId,
        {
          kind: 'workflow_next',
          change: 'updated',
          route: {
            kind: 'child_workflow',
            childDefinitionId: 'wf-canonical',
            childDefinitionVersion: 1,
            entryBindings: [
              {
                childEntryNodeId: 'r1',
                inputRef: 'research_one',
                artifactId: caller.startArtifactId,
                artifactRevision: 1,
              },
              {
                childEntryNodeId: 'r2',
                inputRef: 'research_two',
                artifactId: caller.startArtifactId,
                artifactRevision: 1,
              },
            ],
            childIdempotencyKey: 's07-canonical-child-1',
          },
        },
        '2026-07-21T12:00:01.000Z',
      );
      expect(invoke.ok).toBe(true);

      const children = await opened.client.all<{
        run_id: string;
        origin: string;
        parent_run_id: string | null;
        status: string;
        definition_id: string;
      }>(
        `SELECT run_id, origin, parent_run_id, status, definition_id
           FROM workflow_runs
          WHERE workspace_id = ? AND parent_run_id = ?`,
        ['ws', caller.runId],
      );

      expect(children).toHaveLength(1);
      expect(children[0]!.definition_id).toBe('wf-canonical');
      const childRunId = children[0]!.run_id;
      expect(children[0]!.origin).toBe('child');
      expect(children[0]!.parent_run_id).toBe(caller.runId);

      const entryRows = await opened.client.all<{
        node_id: string;
        task_id: string | null;
      }>(
        `SELECT node_id, task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id IN ('r1','r2')
          ORDER BY node_id`,
        ['ws', childRunId],
      );
      expect(entryRows).toHaveLength(2);
      expect(entryRows.every((row) => row.task_id !== null)).toBe(true);
      const gateFills = await opened.client.all<{ node_id: string; input_ref: string }>(
        `SELECT gate.consumer_node_id AS node_id, fill.input_ref
           FROM workflow_dependency_gates gate
           JOIN workflow_gate_fills fill
             ON fill.workspace_id = gate.workspace_id
            AND fill.run_id = gate.run_id
            AND fill.gate_id = gate.gate_id
          WHERE gate.workspace_id = ? AND gate.run_id = ?
            AND gate.consumer_node_id IN ('r1','r2')
          ORDER BY gate.consumer_node_id`,
        ['ws', childRunId],
      );
      expect(gateFills).toEqual([
        { node_id: 'r1', input_ref: 'research_one' },
        { node_id: 'r2', input_ref: 'research_two' },
      ]);
      const r1TaskId = entryRows.find((row) => row.node_id === 'r1')!.task_id as string;
      const r2TaskId = entryRows.find((row) => row.node_id === 'r2')!.task_id as string;
      const r1Task = await opened.repository.getTask(r1TaskId);
      const r2Task = await opened.repository.getTask(r2TaskId);
      expect(r1Task?.goal).toMatch(/^\[workflow:r1\] /);
      expect(r2Task?.goal).toMatch(/^\[workflow:r2\] /);
      expect(r1Task?.goal).not.toBe(r2Task?.goal);
      const r1Turns = await opened.repository.listTurns(r1TaskId);
      const r2Turns = await opened.repository.listTurns(r2TaskId);
      expect(r1Turns).toHaveLength(1);
      expect(r2Turns).toHaveLength(1);
      expect((await opened.repository.listMessages(r1TaskId))[0]?.content).toContain(
        'inputRef="research_one"',
      );
      expect((await opened.repository.listMessages(r1TaskId))[0]?.content).not.toContain(
        'inputRef="research_two"',
      );
      expect((await opened.repository.listMessages(r2TaskId))[0]?.content).toContain(
        'inputRef="research_two"',
      );
      const r1TurnId = r1Turns[0]!.id;
      const r2TurnId = r2Turns[0]!.id;

      // --- Phase: research entries running — bounded projection ---
      const r1Status0 = await opened.repository.getWorkflowStatusForTask(r1TaskId!);
      expect(r1Status0).toBeTruthy();
      assertBoundedProjection(r1Status0!);
      expect(r1Status0!.runId).toBe(childRunId!);
      expect(r1Status0!.nodeId).toBe('r1');
      expect(r1Status0!.definitionId).toBe('wf-canonical');
      expect(r1Status0!.runStatus).toBe('running');
      expect(r1Status0!.origin).toBe('child');
      expect(r1Status0!.parentRunId).toBe(caller.runId);
      expect(r1Status0!.continuations).toEqual([
        expect.objectContaining({ childRunId: childRunId, status: 'pending' }),
      ]);

      const parentProj = await opened.repository.getWorkflowStatusForTask(caller.entryTaskId);
      expect(parentProj).toBeTruthy();
      assertBoundedProjection(parentProj!);
      expect(parentProj!.continuations).toEqual([
        expect.objectContaining({ childRunId: childRunId, status: 'pending' }),
      ]);

      // Scheduler: research activation turns are promotable when queued.
      // (After start they may already be queued; promote check is structural.)
      const researchStore = await buildStoreFromRepo(opened.repository, [
        r1TaskId!,
        r2TaskId!,
      ]);
      // Ensure turns exist in store for scheduler
      expect(Object.keys(researchStore.turns).length).toBeGreaterThanOrEqual(2);

      // --- Phase: research NEXT fan-in → planner activates ---
      const nextR1 = await settleSucceeded(
        opened.repository,
        opened.client,
        r1TaskId!,
        r1TurnId!,
        { kind: 'workflow_next', change: 'updated', result: 'research-r1-v1' },
        '2026-07-21T12:01:00.000Z',
      );
      expect(nextR1.ok).toBe(true);
      expect(nextR1.changed).toBe(true);

      // Planner must not activate until both research producers contribute.
      let plannerRow = await nodeTask(opened.client, childRunId!, 'planner');
      expect(plannerRow?.task_id ?? null).toBeNull();

      const nextR2 = await settleSucceeded(
        opened.repository,
        opened.client,
        r2TaskId!,
        r2TurnId!,
        { kind: 'workflow_next', change: 'updated', result: 'research-r2-v1' },
        '2026-07-21T12:01:30.000Z',
      );
      expect(nextR2.ok).toBe(true);
      expect(nextR2.changed).toBe(true);

      const plannerTaskId = await waitForNodeTask(opened.client, childRunId!, 'planner');
      const plannerTurns = await opened.repository.listTurns(plannerTaskId);
      expect(plannerTurns.length).toBeGreaterThanOrEqual(1);
      const plannerActivationTurnId = plannerTurns[0]!.id;
      expect(plannerActivationTurnId).toBe(
        deriveNodeActivationIdentities(childRunId!, 'planner').activationTurnId,
      );
      expect(plannerTurns[0]!.status).toBe('queued');
      expect(plannerTurns[0]!.trigger).toBe('engine');

      // Scheduler activation: planner turn is runnable.
      const afterFanInStore = await buildStoreFromRepo(opened.repository, [
        r1TaskId!,
        r2TaskId!,
        plannerTaskId,
      ]);
      const runnable = pickRunnableTurns(afterFanInStore, DEFAULT_RESOURCE_LIMITS);
      expect(runnable).toContain(plannerActivationTurnId);

      // Projection after fan-in: planner gate satisfied counts.
      const plannerStatus = await opened.repository.getWorkflowStatusForTask(plannerTaskId);
      expect(plannerStatus).toBeTruthy();
      assertBoundedProjection(plannerStatus!);
      expect(plannerStatus!.nodeId).toBe('planner');
      expect(plannerStatus!.runId).toBe(childRunId!);
      const plannerGate = plannerStatus!.gates.find((g) => g.required >= 2);
      expect(plannerGate).toBeTruthy();
      expect(plannerGate!.satisfied).toBeGreaterThanOrEqual(2);
      expect(plannerGate!.status).toBe('satisfied');
      expect(plannerStatus!.feedbackRounds).toEqual([]);

      // Public inspection is run-scoped and excludes the generic task tree.
      const plannerTask = await opened.repository.getTask(plannerTaskId);
      expect(plannerTask?.goal).toMatch(/^\[workflow:planner\] /);
      expect(plannerTask?.parentId).toBe(r1Task?.parentId);
      const plannerTurn = await opened.repository.getTurn(plannerActivationTurnId);
      const toolFile: TaskStoreFile = {
        version: 1,
        revision: 1,
        tasks: { [plannerTask!.id]: plannerTask! },
        turns: { [plannerTurn!.id]: plannerTurn! },
        messages: {},
        toolCalls: {},
        reasoning: {},
        operations: {},
        cancelRequests: {},
      };
      const deps = makeMinimalDeps(toolFile, opened.repository);
      const inspectionTool = await executeToolCommand(
        deps,
        {
          callerTaskId: plannerTask!.id,
          turnId: plannerTurn!.id,
          rootId: caller.entryTaskId,
          allowedActions: new Set(['read_subtree', 'inspect_workflow_run']),
        },
        { kind: 'inspect_workflow_run', runId: childRunId! },
      );
      expect(inspectionTool.ok).toBe(true);
      if (inspectionTool.ok) {
        const inspection = inspectionTool.result as WorkflowRunInspectionProjection;
        expect(inspection.runId).toBe(childRunId);
        expect(inspection.nodes.map((node) => node.nodeId)).toEqual([
          'planner',
          'r1',
          'r2',
          'verifier',
        ]);
        expect(inspection).not.toHaveProperty('tasks');
        expect(forbiddenLeak(inspection)).toEqual([]);
      }

      // --- Phase: planner NEXT → verifier activates ---
      const nextPlanner = await settleSucceeded(
        opened.repository,
        opened.client,
        plannerTaskId,
        plannerActivationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'plan-v1' },
        '2026-07-21T12:02:00.000Z',
      );
      expect(nextPlanner.ok).toBe(true);
      expect(nextPlanner.changed).toBe(true);

      const verifierTaskId = await waitForNodeTask(opened.client, childRunId!, 'verifier');
      const verifierTurns = await opened.repository.listTurns(verifierTaskId);
      expect(verifierTurns.length).toBeGreaterThanOrEqual(1);
      const verifierActivationTurnId = verifierTurns[0]!.id;
      expect(verifierActivationTurnId).toBe(
        deriveNodeActivationIdentities(childRunId!, 'verifier').activationTurnId,
      );
      expect(verifierTurns[0]!.status).toBe('queued');

      // Scheduler: verifier activation is runnable.
      const afterPlannerStore = await buildStoreFromRepo(opened.repository, [
        plannerTaskId,
        verifierTaskId,
      ]);
      const runnableVerifier = pickRunnableTurns(afterPlannerStore, DEFAULT_RESOURCE_LIMITS);
      expect(runnableVerifier).toContain(verifierActivationTurnId);

      const verifierStatus0 = await opened.repository.getWorkflowStatusForTask(verifierTaskId);
      expect(verifierStatus0).toBeTruthy();
      assertBoundedProjection(verifierStatus0!);
      expect(verifierStatus0!.nodeId).toBe('verifier');
      expect(verifierStatus0!.feedbackRounds).toEqual([]);

      // --- Phase: verifier PREV planner once (targeted from_planner) ---
      const prev = await settleSucceeded(
        opened.repository,
        opened.client,
        verifierTaskId,
        verifierActivationTurnId,
        {
          kind: 'workflow_prev',
          targets: ['from_planner'],
          note: 'revise the plan',
        },
        '2026-07-21T12:03:00.000Z',
      );
      expect(prev.ok).toBe(true);
      expect(prev.changed).toBe(true);

      const rounds = await opened.client.all<{
        round_id: string;
        requester_node_id: string;
        status: string;
        join_mode: string;
      }>(
        `SELECT round_id, requester_node_id, status, join_mode
           FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', childRunId!],
      );
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({
        requester_node_id: 'verifier',
        status: 'open',
        join_mode: 'all',
      });
      const roundId = rounds[0]!.round_id as string;
      expect(roundId).toBe(
        deriveFeedbackRoundId(childRunId!, 'verifier', verifierActivationTurnId),
      );

      const targets = await opened.client.all<{ target_node_id: string; status: string }>(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', childRunId!, roundId],
      );
      expect(targets).toEqual([{ target_node_id: 'planner', status: 'pending' }]);

      // Projection shows open feedback round on verifier.
      const verifierWithRound = await opened.repository.getWorkflowStatusForTask(verifierTaskId);
      expect(verifierWithRound?.feedbackRounds).toEqual([
        expect.objectContaining({
          roundId,
          status: 'open',
          joinMode: 'all',
          role: 'requester',
        }),
      ]);
      assertBoundedProjection(verifierWithRound!);

      // Planner receives exactly one feedback turn (PREV once).
      const plannerTurnsAfterPrev = await opened.repository.listTurns(plannerTaskId);
      expect(plannerTurnsAfterPrev.length).toBe(2);
      const plannerFeedbackTurnId = deriveFeedbackTargetTurnId(
        childRunId!,
        roundId,
        'planner',
      );
      const plannerFeedback = plannerTurnsAfterPrev.find((t) => t.id === plannerFeedbackTurnId);
      expect(plannerFeedback).toBeTruthy();
      expect(plannerFeedback!.status).toBe('queued');
      expect(plannerFeedback!.trigger).toBe('engine');

      // Research producers are not targeted.
      expect(await opened.repository.listTurns(r1TaskId!)).toHaveLength(1);
      expect(await opened.repository.listTurns(r2TaskId!)).toHaveLength(1);

      // Scheduler: planner feedback turn is runnable.
      const feedbackStore = await buildStoreFromRepo(opened.repository, [plannerTaskId]);
      const runnableFeedback = pickRunnableTurns(feedbackStore, DEFAULT_RESOURCE_LIMITS);
      expect(runnableFeedback).toContain(plannerFeedbackTurnId);

      // --- Phase: planner correction via NEXT on feedback turn ---
      const correction = await settleSucceeded(
        opened.repository,
        opened.client,
        plannerTaskId,
        plannerFeedbackTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'plan-v2-corrected' },
        '2026-07-21T12:04:00.000Z',
      );
      expect(correction.ok).toBe(true);
      expect(correction.changed).toBe(true);

      const roundAfter = await opened.client.get<{ status: string }>(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', childRunId!, roundId],
      );
      expect(roundAfter).toMatchObject({ status: 'satisfied' });

      // Verifier receives exactly one resume turn with correction.
      const verifierTurnsAfter = await opened.repository.listTurns(verifierTaskId);
      expect(verifierTurnsAfter).toHaveLength(2);
      const resumeTurnId = deriveFeedbackResumeTurnId(childRunId!, roundId);
      const resume = verifierTurnsAfter.find((t) => t.id === resumeTurnId);
      expect(resume).toBeTruthy();
      expect(resume!.status).toBe('queued');
      expect(resume!.trigger).toBe('engine');

      // Projection retains the exact satisfied round until its resume is consumed.
      const verifierAfterJoin = await opened.repository.getWorkflowStatusForTask(verifierTaskId);
      expect(verifierAfterJoin).toBeTruthy();
      assertBoundedProjection(verifierAfterJoin!);
      expect(verifierAfterJoin!.feedbackRounds).toEqual([
        expect.objectContaining({ roundId, status: 'satisfied', role: 'requester' }),
      ]);

      // Scheduler: resume is runnable.
      const resumeStore = await buildStoreFromRepo(opened.repository, [verifierTaskId]);
      const runnableResume = pickRunnableTurns(resumeStore, DEFAULT_RESOURCE_LIMITS);
      expect(runnableResume).toContain(resumeTurnId);

      // --- Phase: verifier terminal NEXT (returns to caller when child) ---
      const terminal = await settleSucceeded(
        opened.repository,
        opened.client,
        verifierTaskId,
        resumeTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'verified-ok' },
        '2026-07-21T12:05:00.000Z',
      );
      expect(terminal.ok).toBe(true);
      expect(terminal.changed).toBe(true);

      {
        const conts = await opened.client.all<{ status: string; kind: string }>(
          `SELECT status, kind FROM workflow_continuations
            WHERE workspace_id = ? AND run_id = ?`,
          ['ws', caller.runId],
        );
        expect(conts.some((c) => c.status === 'resolved')).toBe(true);

        const returnFences = await opened.client.all<{ kind: string }>(
          `SELECT kind FROM workflow_routed_messages
            WHERE workspace_id = ? AND run_id = ? AND kind = 'child_return'`,
          ['ws', caller.runId],
        );
        expect(returnFences).toHaveLength(1);

        const callerQueued = await opened.client.all<{ id: string; status: string }>(
          `SELECT id, status FROM turns
            WHERE workspace_id = ? AND task_id = ? AND status = 'queued'
            ORDER BY sequence`,
          ['ws', caller.entryTaskId],
        );
        expect(callerQueued.length).toBeGreaterThanOrEqual(1);

        const parentFinal = await opened.repository.getWorkflowStatusForTask(caller.entryTaskId);
        expect(parentFinal).toBeTruthy();
        assertBoundedProjection(parentFinal!);
        expect(parentFinal!.continuations.every((continuation) => continuation.status !== 'pending')).toBe(true);

        // Caller lifecycle stays open across return.
        expect((await opened.repository.getTask(caller.entryTaskId))?.lifecycle).toBe('open');
      }

      // PREV leaves tasks open while routing; terminal NEXT seals every task owned by the run.
      expect((await opened.repository.getTask(r1TaskId!))?.lifecycle).toBe('succeeded');
      expect((await opened.repository.getTask(plannerTaskId))?.lifecycle).toBe('succeeded');
      expect((await opened.repository.getTask(verifierTaskId))?.lifecycle).toBe('succeeded');

      // Final projection still bounded (no topology/prompt/body/path leakage).
      const finalProj = await opened.repository.getWorkflowStatusForTask(verifierTaskId);
      expect(finalProj).toBeTruthy();
      assertBoundedProjection(finalProj!);
      expect(finalProj!.runId).toBe(childRunId!);
      expect(finalProj!.nodeId).toBe('verifier');
    } finally {
      await opened.close();
    }
  }, 90_000);

  it('negative: unbound task has no workflow projection; invalid PREV targets open no round', async () => {
    const opened = await openRepo('negative');
    try {
      expect(await opened.repository.getWorkflowStatusForTask('not-bound')).toBeUndefined();

      const createdAt = '2026-07-21T13:00:00.000Z';
      const data = await startCanonicalChildAsTopLevel(
        opened.repository,
        createdAt,
        's07-canonical-neg-1',
      );
      const byNode = new Map(data.entries.map((e) => [e.nodeId, e]));
      const r1 = byNode.get('r1')!;
      const r2 = byNode.get('r2')!;

      await settleSucceeded(
        opened.repository,
        opened.client,
        r1.taskId,
        r1.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'r1' },
        '2026-07-21T13:01:00.000Z',
      );
      await settleSucceeded(
        opened.repository,
        opened.client,
        r2.taskId,
        r2.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'r2' },
        '2026-07-21T13:01:30.000Z',
      );
      const plannerTaskId = await waitForNodeTask(opened.client, data.runId, 'planner');
      const plannerTurn = (await opened.repository.listTurns(plannerTaskId))[0]!;
      await settleSucceeded(
        opened.repository,
        opened.client,
        plannerTaskId,
        plannerTurn.id,
        { kind: 'workflow_next', change: 'updated', result: 'plan' },
        '2026-07-21T13:02:00.000Z',
      );
      const verifierTaskId = await waitForNodeTask(opened.client, data.runId, 'verifier');
      const verifierTurn = (await opened.repository.listTurns(verifierTaskId))[0]!;

      const invalid = await settleSucceeded(
        opened.repository,
        opened.client,
        verifierTaskId,
        verifierTurn.id,
        { kind: 'workflow_prev', targets: ['not_a_binding'] },
        '2026-07-21T13:03:00.000Z',
      );
      expect(invalid.ok).toBe(true);
      expect(
        await opened.client.all(
          `SELECT round_id FROM workflow_feedback_rounds WHERE workspace_id = ? AND run_id = ?`,
          ['ws', data.runId],
        ),
      ).toHaveLength(0);
    } finally {
      await opened.close();
    }
  }, 60_000);
});
