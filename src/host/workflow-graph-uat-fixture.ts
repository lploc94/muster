/**
 * Seeds one deterministic named-composition fixture through the real repository so
 * a native Extension Development Host has a genuine focused workflow task to
 * request a graph for.
 *
 * A single-node producer exports a named result which becomes the public input
 * of a five-node chain. Every write goes
 * through `repository.execute`, so the durable state is the state production
 * would have produced — no hand-built rows.
 *
 * The focus task is discovered from durable `workflow_nodes` state rather than
 * predicted by the fixture.
 */
import type { TaskRepository } from '../task/repository';
import type { MusterTask, TaskTurn } from '../task/types';

/** Minimal raw-SQL surface used to stage the activation turn and locate the live node. */
export type WorkflowGraphFixtureClient = {
  run(sql: string, params?: readonly unknown[]): Promise<unknown>;
  get<T>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
};

export type WorkflowGraphFixtureRepository = Pick<
  TaskRepository,
  'execute' | 'getTask' | 'getTurn'
>;

export const WORKFLOW_GRAPH_FIXTURE_ROOT_TASK_ID = 'uat-workflow-graph-root';
const ROOT_TURN_ID = 'uat-workflow-graph-root-turn';
const PRODUCER_DEFINITION_ID = 'uat-wf-producer';
const CHAIN_DEFINITION_ID = 'uat-wf-five-chain';
const CHAIN_NODES = ['one', 'two', 'three', 'four', 'five'] as const;
/** The named composition activates the chain entry first. */
const LIVE_NODE_ID = 'one';
const PRODUCER_NODE_ID = 'produce';

/** Bounded seed result: the task the harness should focus, plus shape counters. */
export type WorkflowGraphFixtureResult = {
  /** The active entry node's task — the task the harness focuses. */
  focusTaskId: string;
  /** Node ids are fixture-local constants, safe to report for assertion. */
  liveNodeId: string;
  reusedNodeCount: number;
  liveNodeCount: number;
};

function iso(offsetMs: number): string {
  return new Date(Date.UTC(2026, 7, 2, 0, 0, 0) + offsetMs).toISOString();
}

/**
 * A released coordinator, matching the shape M024/S04 proved a workflow can be
 * started from. `makeTask` is intentionally not reused: it yields a draft worker.
 */
function fixtureRootTask(): MusterTask {
  return {
    id: WORKFLOW_GRAPH_FIXTURE_ROOT_TASK_ID,
    role: 'coordinator',
    lifecycle: 'open',
    releaseState: 'released',
    goal: 'UAT workflow graph coordinator',
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: iso(0),
    updatedAt: iso(0),
    releasedAt: iso(0),
  };
}

/**
 * Drives a queued activation turn to a succeeded `workflow_next` result so the
 * producer run reaches terminal and exposes a reusable artifact.
 */
async function settleWithNextResult(
  repository: WorkflowGraphFixtureRepository,
  client: WorkflowGraphFixtureClient,
  workspaceId: string,
  taskId: string,
  turnId: string,
  result: string,
): Promise<void> {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
    [iso(1_000), workspaceId, turnId],
  );
  const [task, turn] = await Promise.all([repository.getTask(taskId), repository.getTurn(turnId)]);
  if (!task || !turn) {
    throw new Error('workflow graph fixture could not read its own activation turn');
  }

  const disposition = { kind: 'workflow_next', change: 'updated', result } as const;
  await repository.execute({
    kind: 'stageDisposition',
    workspaceId,
    turnId: turn.id,
    opId: `uat-workflow-graph-settle:${turn.id}`,
    turn: { ...turn, disposition },
    expectedStatuses: ['running'],
    expectedRuntimeEpoch: turn.runtimeEpoch,
  });
  await repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId,
    expectedTaskRevision: task.revision,
    task: { ...task, lifecycle: 'succeeded', updatedAt: iso(1_000) },
    turn: { ...turn, status: 'succeeded', finishedAt: iso(1_000), disposition },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  });
}

/**
 * Creates the producer run, settles it, then starts a five-node chain from its
 * named result. Returns the active entry node's task id, read back
 * from durable state rather than predicted.
 */
export async function seedWorkflowGraphFixture(
  repository: WorkflowGraphFixtureRepository,
  client: WorkflowGraphFixtureClient,
  workspaceId: string,
): Promise<WorkflowGraphFixtureResult> {
  await repository.execute({ kind: 'createTask', workspaceId, task: fixtureRootTask() });
  await repository.execute({
    kind: 'createTurn',
    workspaceId,
    turn: {
      id: ROOT_TURN_ID,
      taskId: WORKFLOW_GRAPH_FIXTURE_ROOT_TASK_ID,
      sequence: 1,
      status: 'running',
      trigger: 'user',
      inputs: [],
      createdAt: iso(0),
      startedAt: iso(0),
    } as TaskTurn,
  });

  await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId,
    definitionId: PRODUCER_DEFINITION_ID,
    version: 1,
    name: 'UAT producer',
    topology: {
      kind: 'workflow',
      inputs: [],
       outputs: [{ name: 'result', semanticKind: 'result', sourceNodeId: PRODUCER_NODE_ID }],
       nodes: [{
         nodeId: PRODUCER_NODE_ID,
         outcome: {
           kind: 'agent',
           requireExplicitDisposition: true,
           next: { when: 'The producer result is ready.' },
           fail: { when: 'The producer result cannot be produced.' },
         },
       }],
      edges: [],
    },
    createdAt: iso(0),
  });
  await repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId,
    definitionId: CHAIN_DEFINITION_ID,
    version: 1,
    name: 'UAT five node chain',
    createdAt: iso(0),
    topology: {
      kind: 'workflow',
      inputs: [{ name: 'seed', semanticKind: 'result', entryNodeId: 'one', inputRef: 'seed' }],
       outputs: CHAIN_NODES.map((nodeId, index) => ({
         name: nodeId === 'five' ? 'result' : `${nodeId}Result`,
         semanticKind: nodeId === 'five' ? 'result' : `checkpoint.${index + 1}`,
         sourceNodeId: nodeId,
       })),
       nodes: CHAIN_NODES.map((nodeId) => ({
         nodeId,
         outcome: {
           kind: 'agent' as const,
           requireExplicitDisposition: true,
           next: { when: `The ${nodeId} result is ready.` },
           fail: { when: `The ${nodeId} result cannot be produced.` },
         },
       })),
      edges: [
        { fromNodeId: 'one', toNodeId: 'two', inputRef: 'one_result' },
        { fromNodeId: 'two', toNodeId: 'three', inputRef: 'two_result' },
        { fromNodeId: 'three', toNodeId: 'four', inputRef: 'three_result' },
        { fromNodeId: 'four', toNodeId: 'five', inputRef: 'four_result' },
      ],
    },
    entryContracts: [{ entryNodeId: 'one', inputRef: 'seed', expectedArtifactKind: 'workflow_input' }],
  });

  const producerStart = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId,
    definitionId: PRODUCER_DEFINITION_ID,
    version: 1,
    startIdempotencyKey: 'uat-workflow-graph-producer',
    createdAt: iso(0),
    ownerRootTaskId: WORKFLOW_GRAPH_FIXTURE_ROOT_TASK_ID,
    callerTaskId: WORKFLOW_GRAPH_FIXTURE_ROOT_TASK_ID,
    callerTurnId: ROOT_TURN_ID,
  });
  const producer = producerStart.operation?.result.data as
    | { runId: string; entryTaskId: string; activationTurnId: string }
    | undefined;
  if (!producer?.runId) {
    throw new Error(
      `workflow graph fixture producer run did not start (reason=${String(
        (producerStart as { reason?: unknown }).reason ?? 'unknown',
      )})`,
    );
  }

  await settleWithNextResult(
    repository,
    client,
    workspaceId,
    producer.entryTaskId,
    producer.activationTurnId,
    'UAT reusable producer result',
  );

  const consumerStart = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId,
    definitionId: CHAIN_DEFINITION_ID,
    version: 1,
    startIdempotencyKey: 'uat-workflow-graph-consumer',
    createdAt: iso(2_000),
    inputs: [{ name: 'seed', fromRun: producer.runId, output: 'result' }],
    ownerRootTaskId: WORKFLOW_GRAPH_FIXTURE_ROOT_TASK_ID,
    callerTaskId: WORKFLOW_GRAPH_FIXTURE_ROOT_TASK_ID,
    callerTurnId: ROOT_TURN_ID,
  });
  const consumer = consumerStart.operation?.result.data as { runId: string } | undefined;
  if (!consumer?.runId) {
    throw new Error(
      `workflow graph fixture consumer run did not start (reason=${String(
        (consumerStart as { reason?: unknown }).reason ?? 'unknown',
      )})`,
    );
  }

  // Read the active entry back from durable state. Pending nodes retain durable
  // shell tasks but only the entry is active.
  const nodes = await client.all<{ node_id: string; task_id: string | null; status: string }>(
    `SELECT node_id, task_id, status FROM workflow_nodes
      WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
    [workspaceId, consumer.runId],
  );
  const live = nodes.filter((node) => node.status === 'active');
  const reused = nodes.filter((node) => node.status === 'reused');
  if (live.length !== 1 || live[0]!.node_id !== LIVE_NODE_ID || !live[0]!.task_id) {
    throw new Error(
      `workflow graph fixture expected exactly one live node '${LIVE_NODE_ID}', found ${live.length}`,
    );
  }
  if (reused.length !== 0) throw new Error('workflow graph fixture unexpectedly created reused nodes');

  return {
    focusTaskId: live[0]!.task_id,
    liveNodeId: LIVE_NODE_ID,
    reusedNodeCount: reused.length,
    liveNodeCount: live.length,
  };
}
