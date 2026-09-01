/**
 * Shared workflow graph host↔webview contract (M024/S05).
 * Pure data validation only: no VS Code, repository, filesystem, or MCP imports.
 */

export const WORKFLOW_GRAPH_REQUEST_ID_MAX = 128;
export const WORKFLOW_GRAPH_TASK_ID_MAX = 512;
export const WORKFLOW_GRAPH_ID_MAX = 512;
export const WORKFLOW_GRAPH_COLLECTION_MAX = 128;
export const WORKFLOW_GRAPH_NODES_MAX = 64;
export const WORKFLOW_GRAPH_EDGES_MAX = 128;
export const WORKFLOW_GRAPH_GATES_MAX = 64;
export const WORKFLOW_GRAPH_GATE_INPUTS_MAX = 64;
export const WORKFLOW_GRAPH_FEEDBACK_ROUNDS_MAX = 32;
export const WORKFLOW_GRAPH_CHILD_RUNS_MAX = 64;
export const WORKFLOW_GRAPH_DIAGNOSTICS_MAX = 8;
export const WORKFLOW_GRAPH_TITLE_MAX = 200;

export const WORKFLOW_GRAPH_ERROR_CODES = [
  'invalidRequest',
  'notInWorkflow',
  'unavailable',
] as const;
export type WorkflowGraphErrorCode = (typeof WORKFLOW_GRAPH_ERROR_CODES)[number];

/** The only S04 degraded-read diagnostics that may cross into the webview. */
export const WORKFLOW_GRAPH_DIAGNOSTIC_CODES = [
  'workflow_graph_topology_undecodable',
  'workflow_graph_nodes_truncated',
  'workflow_graph_edges_truncated',
  'workflow_graph_gates_truncated',
  'workflow_graph_child_runs_truncated',
] as const;
export type WorkflowGraphDiagnosticCode = (typeof WORKFLOW_GRAPH_DIAGNOSTIC_CODES)[number];

export type WorkflowGraphWireInputState = 'supplied_live' | 'supplied_reused' | 'pending' | 'blocking';
export type WorkflowGraphWireRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type WorkflowGraphWireNodeStatus =
  | 'pending' | 'active' | 'reused' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export type WorkflowGraphWireGateStatus = 'open' | 'satisfied' | 'consumed' | 'failed' | 'cancelled';
export type WorkflowGraphWireExecutionActivity =
  | 'none' | 'queued' | 'executing' | 'waiting_feedback'
  | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type WorkflowGraphWireDisplayState =
  | 'queued' | 'executing' | 'waiting' | 'completed' | 'reused'
  | 'blocked' | 'not_started' | 'failed' | 'cancelled' | 'skipped';
export type WorkflowGraphWireProgressBucket = Exclude<WorkflowGraphWireDisplayState, 'reused'>;
export type WorkflowGraphWireDecisionGate = 'optional' | 'required';
export interface WorkflowGraphWireDecision {
  status: 'waiting' | 'correcting' | 'decided' | 'exhausted';
  attempt: 1 | 2 | 3;
  maxAttempts: 3;
}
export interface WorkflowGraphWireNode {
  nodeId: string;
  title?: string;
  workflowNodeStatus: WorkflowGraphWireNodeStatus;
  executionActivity: WorkflowGraphWireExecutionActivity;
  displayState: WorkflowGraphWireDisplayState;
  progressBucket: WorkflowGraphWireProgressBucket;
  reason?: 'waiting_for_inputs' | 'run_closed_before_activation' | 'awaiting_workflow_route';
  decisionGate?: WorkflowGraphWireDecisionGate;
  decision?: WorkflowGraphWireDecision;
  reused: boolean;
}
export interface WorkflowGraphWireEdge {
  fromNodeId: string;
  toNodeId: string;
  inputRef: string;
  contributionState: WorkflowGraphWireInputState;
  reused: boolean;
}
export interface WorkflowGraphWireGateInput {
  inputRef: string;
  producerNodeId: string;
  state: WorkflowGraphWireInputState;
}
export interface WorkflowGraphWireGate {
  consumerNodeId: string;
  status: WorkflowGraphWireGateStatus;
  satisfied: number;
  required: number;
  inputs: WorkflowGraphWireGateInput[];
}
export interface WorkflowGraphWireProgress {
  total: number;
  completed: number;
  queued: number;
  executing: number;
  waiting: number;
  blocked: number;
  notStarted: number;
  failed: number;
  cancelled: number;
  skipped: number;
  frontierNodeIds: string[];
  activeNodeIds: string[];
}
export interface WorkflowGraphWireFeedbackRound {
  requesterNodeId: string;
  status: 'open' | 'satisfied';
  joinMode: 'all';
  required: number;
  responded: number;
}
export interface WorkflowGraphWireChildRun { status: WorkflowGraphWireRunStatus; }
export interface WorkflowGraphWireGraph {
  runStatus: WorkflowGraphWireRunStatus;
  nodes: WorkflowGraphWireNode[];
  edges: WorkflowGraphWireEdge[];
  gates: WorkflowGraphWireGate[];
  activeGate?: WorkflowGraphWireGate;
  progress: WorkflowGraphWireProgress;
  feedbackRounds: WorkflowGraphWireFeedbackRound[];
  childRuns: WorkflowGraphWireChildRun[];
  reuse: { nodeCount: number; edgeCount: number };
  diagnostics: { code: WorkflowGraphDiagnosticCode }[];
}

export interface RequestWorkflowGraph { type: 'requestWorkflowGraph'; requestId: string; taskId: string; }
export type WorkflowGraphResult =
  | { type: 'workflowGraphResult'; requestId: string; taskId: string; ok: true; graph: WorkflowGraphWireGraph }
  | { type: 'workflowGraphResult'; requestId: string; taskId: string; ok: false; code: WorkflowGraphErrorCode };

/** Route-facing classification preserves safe correlation for a bounded error reply. */
export type ParsedRequestWorkflowGraph =
  | { ok: true; requestId: string; taskId: string }
  | { ok: false; silent: true }
  | { ok: false; silent: false; requestId: string; taskId: string; code: 'invalidRequest' };

const ERROR_CODES = new Set<string>(WORKFLOW_GRAPH_ERROR_CODES);
const DIAGNOSTIC_CODES = new Set<string>(WORKFLOW_GRAPH_DIAGNOSTIC_CODES);
const INPUT_STATES = new Set<string>(['supplied_live', 'supplied_reused', 'pending', 'blocking']);
const RUN_STATUSES = new Set<string>(['running', 'succeeded', 'failed', 'cancelled']);
const NODE_STATUSES = new Set<string>([
  'pending', 'active', 'reused', 'succeeded', 'failed', 'cancelled', 'skipped',
]);
const GATE_STATUSES = new Set<string>(['open', 'satisfied', 'consumed', 'failed', 'cancelled']);
const FEEDBACK_ROUND_STATUSES = new Set<string>(['open', 'satisfied']);
const FEEDBACK_JOIN_MODES = new Set<string>(['all']);
const EXECUTION_ACTIVITIES = new Set<string>([
  'none', 'queued', 'executing', 'waiting_feedback', 'completed', 'failed', 'cancelled', 'skipped',
]);
const DISPLAY_STATES = new Set<string>([
  'queued', 'executing', 'waiting', 'completed', 'reused',
  'blocked', 'not_started', 'failed', 'cancelled', 'skipped',
]);
const PROGRESS_BUCKETS = new Set<string>([
  'queued', 'executing', 'waiting', 'completed',
  'blocked', 'not_started', 'failed', 'cancelled', 'skipped',
]);
const NODE_REASONS = new Set<string>([
  'waiting_for_inputs', 'run_closed_before_activation', 'awaiting_workflow_route',
]);
const DECISION_GATES = new Set<string>(['optional', 'required']);
const DECISION_STATUSES = new Set<string>(['waiting', 'correcting', 'decided', 'exhausted']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && Object.keys(record).every((key) => keys.includes(key));
}
function isBoundedString(value: unknown, max = WORKFLOW_GRAPH_ID_MAX): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseList<T>(
  value: unknown,
  maximum: number,
  parse: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const result: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed) return null;
    result.push(parsed);
  }
  return result;
}

/**
 * Exact webview request parser. Unsafe/missing correlation is silent; an exact
 * type with safe correlation but malformed keys receives invalidRequest.
 */
export function parseRequestWorkflowGraphMessage(raw: unknown): ParsedRequestWorkflowGraph {
  if (!isRecord(raw) || raw.type !== 'requestWorkflowGraph') return { ok: false, silent: true };
  const { requestId, taskId } = raw;
  if (!isBoundedString(requestId, WORKFLOW_GRAPH_REQUEST_ID_MAX) || !isBoundedString(taskId, WORKFLOW_GRAPH_TASK_ID_MAX)) {
    return { ok: false, silent: true };
  }
  if (!hasExactKeys(raw, ['type', 'requestId', 'taskId'])) {
    return { ok: false, silent: false, requestId, taskId, code: 'invalidRequest' };
  }
  return { ok: true, requestId, taskId };
}

/** Convenience parser for callers that only accept an exact valid request. */
export function parseRequestWorkflowGraph(raw: unknown): Omit<RequestWorkflowGraph, 'type'> | null {
  const parsed = parseRequestWorkflowGraphMessage(raw);
  return parsed.ok ? { requestId: parsed.requestId, taskId: parsed.taskId } : null;
}

function parseDecision(raw: unknown): WorkflowGraphWireDecision | null {
  if (
    !isRecord(raw)
    || !hasExactKeys(raw, ['status', 'attempt', 'maxAttempts'])
    || typeof raw.status !== 'string'
    || !DECISION_STATUSES.has(raw.status)
    || typeof raw.attempt !== 'number'
    || !Number.isSafeInteger(raw.attempt)
    || (raw.attempt !== 1 && raw.attempt !== 2 && raw.attempt !== 3)
    || raw.maxAttempts !== 3
  ) return null;
  return {
    status: raw.status as WorkflowGraphWireDecision['status'],
    attempt: raw.attempt,
    maxAttempts: 3,
  };
}

function parseNode(raw: unknown): WorkflowGraphWireNode | null {
  if (!isRecord(raw)) return null;
  const baseKeys = [
    'nodeId', 'workflowNodeStatus', 'executionActivity', 'displayState', 'progressBucket', 'reused',
  ];
  const exactKeys = [
    ...baseKeys,
    ...('title' in raw ? ['title'] : []),
    ...('reason' in raw ? ['reason'] : []),
    ...('decisionGate' in raw ? ['decisionGate'] : []),
    ...('decision' in raw ? ['decision'] : []),
  ];
  const decision = 'decision' in raw ? parseDecision(raw.decision) : undefined;
  if (!hasExactKeys(raw, exactKeys)
    || !isBoundedString(raw.nodeId) || typeof raw.workflowNodeStatus !== 'string'
    || !NODE_STATUSES.has(raw.workflowNodeStatus)
    || typeof raw.executionActivity !== 'string' || !EXECUTION_ACTIVITIES.has(raw.executionActivity)
    || typeof raw.displayState !== 'string' || !DISPLAY_STATES.has(raw.displayState)
    || typeof raw.progressBucket !== 'string' || !PROGRESS_BUCKETS.has(raw.progressBucket)
    || typeof raw.reused !== 'boolean'
    || ('title' in raw && !isBoundedString(raw.title, WORKFLOW_GRAPH_TITLE_MAX))
    || ('reason' in raw && (typeof raw.reason !== 'string' || !NODE_REASONS.has(raw.reason)))
    || ('decisionGate' in raw && (typeof raw.decisionGate !== 'string' || !DECISION_GATES.has(raw.decisionGate)))
    || ('decision' in raw && !decision)) return null;
  const node: WorkflowGraphWireNode = {
    nodeId: raw.nodeId,
    ...('title' in raw ? { title: raw.title as string } : {}),
    workflowNodeStatus: raw.workflowNodeStatus as WorkflowGraphWireNodeStatus,
    executionActivity: raw.executionActivity as WorkflowGraphWireExecutionActivity,
    displayState: raw.displayState as WorkflowGraphWireDisplayState,
    progressBucket: raw.progressBucket as WorkflowGraphWireProgressBucket,
    ...('reason' in raw ? { reason: raw.reason as WorkflowGraphWireNode['reason'] } : {}),
    ...('decisionGate' in raw
      ? { decisionGate: raw.decisionGate as WorkflowGraphWireDecisionGate }
      : {}),
    ...(decision ? { decision } : {}),
    reused: raw.reused,
  };
  return node;
}
function validNodeTuple(node: WorkflowGraphWireNode, runStatus: WorkflowGraphWireRunStatus): boolean {
  const expectedBucket = node.displayState === 'reused' ? 'completed' : node.displayState;
  if (node.progressBucket !== expectedBucket) return false;
  if (node.decision && !node.decisionGate) return false;
  if (node.decision?.status === 'waiting') {
    if (
      node.decisionGate !== 'required'
      || node.decision.attempt !== 1
      || runStatus !== 'running'
      || node.workflowNodeStatus !== 'active'
    ) return false;
  }
  if (node.decision?.status === 'correcting') {
    if (runStatus !== 'running' || node.workflowNodeStatus !== 'active') return false;
  }
  if (node.decision?.status === 'exhausted') {
    if (
      node.decision.attempt !== 3
      || runStatus !== 'failed'
      || node.workflowNodeStatus !== 'failed'
      || node.displayState !== 'failed'
    ) return false;
  }
  if (node.workflowNodeStatus === 'reused') {
    return node.executionActivity === 'none' && node.displayState === 'reused'
      && node.reason === undefined;
  }
  if (node.executionActivity === 'queued') {
    return node.displayState === 'queued' && node.reason === undefined;
  }
  if (node.executionActivity === 'executing') {
    return node.displayState === 'executing' && node.reason === undefined;
  }
  if (node.executionActivity === 'waiting_feedback') {
    return node.displayState === 'waiting' && node.reason === undefined;
  }
  if (node.workflowNodeStatus === 'succeeded') {
    return node.displayState === 'completed' && node.reason === undefined;
  }
  if (
    (node.workflowNodeStatus === 'pending' || node.workflowNodeStatus === 'active')
    && node.executionActivity === 'none'
    && node.reason === 'run_closed_before_activation'
  ) {
    return runStatus !== 'running' && node.displayState === 'not_started';
  }
  if (node.workflowNodeStatus === 'failed') {
    return node.displayState === 'failed' && node.reason === undefined;
  }
  if (node.workflowNodeStatus === 'cancelled') {
    return node.displayState === 'cancelled' && node.reason === undefined;
  }
  if (node.workflowNodeStatus === 'skipped') {
    return node.displayState === 'skipped' && node.reason === undefined;
  }
  if (node.executionActivity === 'failed') {
    return node.displayState === 'failed' && node.reason === undefined;
  }
  if (node.executionActivity === 'cancelled') {
    return node.displayState === 'cancelled' && node.reason === undefined;
  }
  if (node.executionActivity === 'skipped') {
    return node.displayState === 'skipped' && node.reason === undefined;
  }
  if (node.executionActivity === 'completed') {
    if (runStatus === 'failed') {
      return node.displayState === 'failed' && node.reason === undefined;
    }
    if (runStatus === 'cancelled') {
      return node.displayState === 'cancelled' && node.reason === undefined;
    }
    if (runStatus === 'succeeded') {
      return node.displayState === 'completed' && node.reason === undefined;
    }
    return node.displayState === 'waiting' && node.reason === 'awaiting_workflow_route';
  }
  if (node.reason === 'waiting_for_inputs') {
    return runStatus === 'running' && node.displayState === 'blocked';
  }
  return node.executionActivity === 'none'
    && runStatus === 'running'
    && node.displayState === 'not_started'
    && node.reason === undefined;
}
function parseEdge(raw: unknown): WorkflowGraphWireEdge | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['fromNodeId', 'toNodeId', 'inputRef', 'contributionState', 'reused']) || !isBoundedString(raw.fromNodeId) || !isBoundedString(raw.toNodeId) || !isBoundedString(raw.inputRef) || typeof raw.contributionState !== 'string' || !INPUT_STATES.has(raw.contributionState) || typeof raw.reused !== 'boolean') return null;
  return { fromNodeId: raw.fromNodeId, toNodeId: raw.toNodeId, inputRef: raw.inputRef, contributionState: raw.contributionState as WorkflowGraphWireInputState, reused: raw.reused };
}
function parseGateInput(raw: unknown): WorkflowGraphWireGateInput | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['inputRef', 'producerNodeId', 'state']) || !isBoundedString(raw.inputRef) || !isBoundedString(raw.producerNodeId) || typeof raw.state !== 'string' || !INPUT_STATES.has(raw.state)) return null;
  return { inputRef: raw.inputRef, producerNodeId: raw.producerNodeId, state: raw.state as WorkflowGraphWireInputState };
}
function parseGate(raw: unknown): WorkflowGraphWireGate | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['consumerNodeId', 'status', 'satisfied', 'required', 'inputs']) || !isBoundedString(raw.consumerNodeId) || typeof raw.status !== 'string' || !GATE_STATUSES.has(raw.status) || !isCount(raw.satisfied) || !isCount(raw.required) || raw.satisfied > raw.required) return null;
  const inputs = parseList(raw.inputs, WORKFLOW_GRAPH_GATE_INPUTS_MAX, parseGateInput);
  const inputRefs = inputs ? new Set(inputs.map((input) => input.inputRef)) : undefined;
  if (!inputs || inputRefs?.size !== inputs.length || inputs.length !== raw.required || inputs.filter((input) => input.state === 'supplied_live' || input.state === 'supplied_reused').length !== raw.satisfied) return null;
  if ((raw.status === 'satisfied' || raw.status === 'consumed') && raw.satisfied !== raw.required) return null;
  if (raw.status === 'open' && raw.satisfied >= raw.required) return null;
  return { consumerNodeId: raw.consumerNodeId, status: raw.status as WorkflowGraphWireGateStatus, satisfied: raw.satisfied, required: raw.required, inputs };
}
function parseProgress(raw: unknown, nodeCount: number): WorkflowGraphWireProgress | null {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    'total', 'completed', 'queued', 'executing', 'waiting', 'blocked', 'notStarted',
    'failed', 'cancelled', 'skipped', 'frontierNodeIds', 'activeNodeIds',
  ])) return null;
  const countKeys = ['total', 'completed', 'queued', 'executing', 'waiting', 'blocked', 'notStarted', 'failed', 'cancelled', 'skipped'] as const;
  if (countKeys.some((key) => !isCount(raw[key]))) return null;
  const frontierNodeIds = parseList(raw.frontierNodeIds, WORKFLOW_GRAPH_NODES_MAX, (value) => isBoundedString(value) ? value : null);
  const activeNodeIds = parseList(raw.activeNodeIds, WORKFLOW_GRAPH_NODES_MAX, (value) => isBoundedString(value) ? value : null);
  if (!frontierNodeIds || !activeNodeIds || raw.total !== nodeCount) return null;
  const sum = countKeys.slice(1).reduce((total, key) => total + (raw[key] as number), 0);
  if (sum !== raw.total) return null;
  return {
    total: raw.total as number,
    completed: raw.completed as number,
    queued: raw.queued as number,
    executing: raw.executing as number,
    waiting: raw.waiting as number,
    blocked: raw.blocked as number,
    notStarted: raw.notStarted as number,
    failed: raw.failed as number,
    cancelled: raw.cancelled as number,
    skipped: raw.skipped as number,
    frontierNodeIds,
    activeNodeIds,
  };
}
function parseFeedbackRound(raw: unknown): WorkflowGraphWireFeedbackRound | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['requesterNodeId', 'status', 'joinMode', 'required', 'responded']) || !isBoundedString(raw.requesterNodeId) || typeof raw.status !== 'string' || !FEEDBACK_ROUND_STATUSES.has(raw.status) || typeof raw.joinMode !== 'string' || !FEEDBACK_JOIN_MODES.has(raw.joinMode) || !isCount(raw.required) || raw.required > WORKFLOW_GRAPH_NODES_MAX || !isCount(raw.responded) || raw.responded > raw.required) return null;
  if (raw.status === 'satisfied' && raw.responded !== raw.required) return null;
  if (raw.status === 'open' && raw.responded >= raw.required) return null;
  return { requesterNodeId: raw.requesterNodeId, status: raw.status as WorkflowGraphWireFeedbackRound['status'], joinMode: raw.joinMode as WorkflowGraphWireFeedbackRound['joinMode'], required: raw.required, responded: raw.responded };
}
function parseChildRun(raw: unknown): WorkflowGraphWireChildRun | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['status']) || typeof raw.status !== 'string' || !RUN_STATUSES.has(raw.status)) return null;
  return { status: raw.status as WorkflowGraphWireRunStatus };
}
function parseDiagnostic(raw: unknown): { code: WorkflowGraphDiagnosticCode } | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['code']) || typeof raw.code !== 'string' || !DIAGNOSTIC_CODES.has(raw.code)) return null;
  return { code: raw.code as WorkflowGraphDiagnosticCode };
}
function parseGraph(raw: unknown): WorkflowGraphWireGraph | null {
  if (!isRecord(raw)) return null;
  const baseKeys = ['runStatus', 'nodes', 'edges', 'gates', 'progress', 'feedbackRounds', 'childRuns', 'reuse', 'diagnostics'];
  if (!hasExactKeys(raw, 'activeGate' in raw ? [...baseKeys, 'activeGate'] : baseKeys) || typeof raw.runStatus !== 'string' || !RUN_STATUSES.has(raw.runStatus)) return null;
  const nodes = parseList(raw.nodes, WORKFLOW_GRAPH_NODES_MAX, parseNode);
  const edges = parseList(raw.edges, WORKFLOW_GRAPH_EDGES_MAX, parseEdge);
  const gates = parseList(raw.gates, WORKFLOW_GRAPH_GATES_MAX, parseGate);
  const feedbackRounds = parseList(raw.feedbackRounds, WORKFLOW_GRAPH_FEEDBACK_ROUNDS_MAX, parseFeedbackRound);
  const childRuns = parseList(raw.childRuns, WORKFLOW_GRAPH_CHILD_RUNS_MAX, parseChildRun);
  const diagnostics = parseList(raw.diagnostics, WORKFLOW_GRAPH_DIAGNOSTICS_MAX, parseDiagnostic);
  if (!nodes || !edges || !gates || !feedbackRounds || !childRuns || !diagnostics || !isRecord(raw.reuse) || !hasExactKeys(raw.reuse, ['nodeCount', 'edgeCount']) || !isCount(raw.reuse.nodeCount) || !isCount(raw.reuse.edgeCount)) return null;
  const progress = parseProgress(raw.progress, nodes.length);
  if (!progress) return null;
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const gateConsumers = new Set(gates.map((gate) => gate.consumerNodeId));
  const edgeKeys = new Set(edges.map((edge) => `${edge.toNodeId}\0${edge.inputRef}`));
  if (
    nodeIds.size !== nodes.length
    || gateConsumers.size !== gates.length
    || edgeKeys.size !== edges.length
    || nodes.some((node) => !validNodeTuple(node, raw.runStatus as WorkflowGraphWireRunStatus))
    || gates.some((gate) => !nodeIds.has(gate.consumerNodeId))
    || edges.some((edge) => !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))
    || feedbackRounds.some((round) => !nodeIds.has(round.requesterNodeId))
  ) return null;
  const bucketCounts = new Map<WorkflowGraphWireProgressBucket, number>();
  for (const node of nodes) {
    bucketCounts.set(node.progressBucket, (bucketCounts.get(node.progressBucket) ?? 0) + 1);
  }
  if (
    progress.completed !== (bucketCounts.get('completed') ?? 0)
    || progress.queued !== (bucketCounts.get('queued') ?? 0)
    || progress.executing !== (bucketCounts.get('executing') ?? 0)
    || progress.waiting !== (bucketCounts.get('waiting') ?? 0)
    || progress.blocked !== (bucketCounts.get('blocked') ?? 0)
    || progress.notStarted !== (bucketCounts.get('not_started') ?? 0)
    || progress.failed !== (bucketCounts.get('failed') ?? 0)
    || progress.cancelled !== (bucketCounts.get('cancelled') ?? 0)
    || progress.skipped !== (bucketCounts.get('skipped') ?? 0)
  ) return null;
  const expectedFrontier = nodes
    .filter((node) => ['queued', 'executing', 'waiting', 'blocked'].includes(node.progressBucket))
    .map((node) => node.nodeId);
  const expectedActive = nodes
    .filter((node) => node.progressBucket === 'executing')
    .map((node) => node.nodeId);
  if (
    JSON.stringify(progress.frontierNodeIds) !== JSON.stringify(expectedFrontier)
    || JSON.stringify(progress.activeNodeIds) !== JSON.stringify(expectedActive)
  ) return null;
  const edgeByInput = new Map(edges.map((edge) => [`${edge.toNodeId}\0${edge.inputRef}`, edge] as const));
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node] as const));
  const gateByConsumer = new Map(gates.map((gate) => [gate.consumerNodeId, gate] as const));
  for (const node of nodes) {
    const gate = gateByConsumer.get(node.nodeId);
    const hasIncompleteGate = gate !== undefined && gate.satisfied < gate.required;
    const mustBeBlocked = raw.runStatus === 'running'
      && (node.workflowNodeStatus === 'pending' || node.workflowNodeStatus === 'active')
      && node.executionActivity === 'none'
      && hasIncompleteGate;
    if ((node.displayState === 'blocked') !== mustBeBlocked) return null;
  }
  for (const gate of gates) {
    for (const input of gate.inputs) {
      const edge = edgeByInput.get(`${gate.consumerNodeId}\0${input.inputRef}`);
      if (input.producerNodeId === 'engine_start' && !edge) {
        if (input.state === 'supplied_reused') return null;
        continue;
      }
      const producer = nodeById.get(input.producerNodeId);
      if (
        !producer
        || !edge
        || edge.fromNodeId !== input.producerNodeId
        || edge.contributionState !== input.state
        || (input.state === 'supplied_reused') !== producer.reused
      ) {
        return null;
      }
    }
  }
  for (const edge of edges) {
    const gate = gateByConsumer.get(edge.toNodeId);
    const input = gate?.inputs.find((candidate) => candidate.inputRef === edge.inputRef);
    if (!input || input.producerNodeId !== edge.fromNodeId || input.state !== edge.contributionState) {
      return null;
    }
  }
  const activeGate = raw.activeGate === undefined ? undefined : parseGate(raw.activeGate);
  if ('activeGate' in raw && !activeGate) return null;
  if (activeGate) {
    const matchingGate = gates.find((gate) => gate.consumerNodeId === activeGate.consumerNodeId);
    if (!matchingGate || JSON.stringify(matchingGate) !== JSON.stringify(activeGate)) return null;
  }
  if (nodes.some((node) => node.reused !== (node.workflowNodeStatus === 'reused'))) return null;
  const reusedNodeIds = new Set(nodes.filter((node) => node.reused).map((node) => node.nodeId));
  if (
    raw.reuse.nodeCount !== reusedNodeIds.size
    || raw.reuse.edgeCount !== edges.filter((edge) => edge.reused).length
    || edges.some((edge) => edge.reused !== reusedNodeIds.has(edge.fromNodeId))
  ) return null;
  return { runStatus: raw.runStatus as WorkflowGraphWireRunStatus, nodes, edges, gates, ...(activeGate ? { activeGate } : {}), progress, feedbackRounds, childRuns, reuse: { nodeCount: raw.reuse.nodeCount, edgeCount: raw.reuse.edgeCount }, diagnostics };
}

/** Fail-closed host→webview parser: any malformed or extra field rejects the whole result. */
export function parseWorkflowGraphResult(raw: unknown): WorkflowGraphResult | null {
  if (!isRecord(raw) || raw.type !== 'workflowGraphResult' || !isBoundedString(raw.requestId, WORKFLOW_GRAPH_REQUEST_ID_MAX) || !isBoundedString(raw.taskId, WORKFLOW_GRAPH_TASK_ID_MAX) || typeof raw.ok !== 'boolean') return null;
  if (raw.ok) {
    if (!hasExactKeys(raw, ['type', 'requestId', 'taskId', 'ok', 'graph'])) return null;
    const graph = parseGraph(raw.graph);
    return graph ? { type: 'workflowGraphResult', requestId: raw.requestId, taskId: raw.taskId, ok: true, graph } : null;
  }
  if (!hasExactKeys(raw, ['type', 'requestId', 'taskId', 'ok', 'code']) || typeof raw.code !== 'string' || !ERROR_CODES.has(raw.code)) return null;
  return { type: 'workflowGraphResult', requestId: raw.requestId, taskId: raw.taskId, ok: false, code: raw.code as WorkflowGraphErrorCode };
}
