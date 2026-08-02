/**
 * Shared workflow graph host↔webview contract (M024/S05).
 * Pure data validation only: no VS Code, repository, filesystem, or MCP imports.
 */

export const WORKFLOW_GRAPH_REQUEST_ID_MAX = 128;
export const WORKFLOW_GRAPH_TASK_ID_MAX = 512;
export const WORKFLOW_GRAPH_ID_MAX = 512;
export const WORKFLOW_GRAPH_COLLECTION_MAX = 128;

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
  'workflow_graph_child_runs_truncated',
] as const;
export type WorkflowGraphDiagnosticCode = (typeof WORKFLOW_GRAPH_DIAGNOSTIC_CODES)[number];

export interface WorkflowGraphWireNode { nodeId: string; status: string; reused: boolean; }
export interface WorkflowGraphWireEdge { fromNodeId: string; toNodeId: string; inputRef: string; reused: boolean; }
export interface WorkflowGraphWireGate { gateId: string; status: string; satisfied: number; required: number; }
export interface WorkflowGraphWireFeedbackRound {
  roundId: string;
  requesterNodeId: string;
  status: string;
  joinMode: string;
  required: number;
  responded: number;
}
export interface WorkflowGraphWireChildRun { runId: string; status: string; }
export interface WorkflowGraphWireGraph {
  runId: string;
  nodes: WorkflowGraphWireNode[];
  edges: WorkflowGraphWireEdge[];
  activeGate?: WorkflowGraphWireGate;
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
function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > WORKFLOW_GRAPH_COLLECTION_MAX) return null;
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

function parseNode(raw: unknown): WorkflowGraphWireNode | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['nodeId', 'status', 'reused']) || !isBoundedString(raw.nodeId) || !isBoundedString(raw.status) || typeof raw.reused !== 'boolean') return null;
  return { nodeId: raw.nodeId, status: raw.status, reused: raw.reused };
}
function parseEdge(raw: unknown): WorkflowGraphWireEdge | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['fromNodeId', 'toNodeId', 'inputRef', 'reused']) || !isBoundedString(raw.fromNodeId) || !isBoundedString(raw.toNodeId) || !isBoundedString(raw.inputRef) || typeof raw.reused !== 'boolean') return null;
  return { fromNodeId: raw.fromNodeId, toNodeId: raw.toNodeId, inputRef: raw.inputRef, reused: raw.reused };
}
function parseGate(raw: unknown): WorkflowGraphWireGate | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['gateId', 'status', 'satisfied', 'required']) || !isBoundedString(raw.gateId) || !isBoundedString(raw.status) || !isCount(raw.satisfied) || !isCount(raw.required) || raw.satisfied > raw.required) return null;
  return { gateId: raw.gateId, status: raw.status, satisfied: raw.satisfied, required: raw.required };
}
function parseFeedbackRound(raw: unknown): WorkflowGraphWireFeedbackRound | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['roundId', 'requesterNodeId', 'status', 'joinMode', 'required', 'responded']) || !isBoundedString(raw.roundId) || !isBoundedString(raw.requesterNodeId) || !isBoundedString(raw.status) || !isBoundedString(raw.joinMode) || !isCount(raw.required) || !isCount(raw.responded) || raw.responded > raw.required) return null;
  return { roundId: raw.roundId, requesterNodeId: raw.requesterNodeId, status: raw.status, joinMode: raw.joinMode, required: raw.required, responded: raw.responded };
}
function parseChildRun(raw: unknown): WorkflowGraphWireChildRun | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['runId', 'status']) || !isBoundedString(raw.runId) || !isBoundedString(raw.status)) return null;
  return { runId: raw.runId, status: raw.status };
}
function parseDiagnostic(raw: unknown): { code: WorkflowGraphDiagnosticCode } | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['code']) || typeof raw.code !== 'string' || !DIAGNOSTIC_CODES.has(raw.code)) return null;
  return { code: raw.code as WorkflowGraphDiagnosticCode };
}
function parseGraph(raw: unknown): WorkflowGraphWireGraph | null {
  if (!isRecord(raw)) return null;
  const baseKeys = ['runId', 'nodes', 'edges', 'feedbackRounds', 'childRuns', 'reuse', 'diagnostics'];
  if (!hasExactKeys(raw, 'activeGate' in raw ? [...baseKeys, 'activeGate'] : baseKeys) || !isBoundedString(raw.runId)) return null;
  const nodes = parseList(raw.nodes, parseNode);
  const edges = parseList(raw.edges, parseEdge);
  const feedbackRounds = parseList(raw.feedbackRounds, parseFeedbackRound);
  const childRuns = parseList(raw.childRuns, parseChildRun);
  const diagnostics = parseList(raw.diagnostics, parseDiagnostic);
  if (!nodes || !edges || !feedbackRounds || !childRuns || !diagnostics || !isRecord(raw.reuse) || !hasExactKeys(raw.reuse, ['nodeCount', 'edgeCount']) || !isCount(raw.reuse.nodeCount) || !isCount(raw.reuse.edgeCount)) return null;
  const activeGate = raw.activeGate === undefined ? undefined : parseGate(raw.activeGate);
  if ('activeGate' in raw && !activeGate) return null;
  return { runId: raw.runId, nodes, edges, ...(activeGate ? { activeGate } : {}), feedbackRounds, childRuns, reuse: { nodeCount: raw.reuse.nodeCount, edgeCount: raw.reuse.edgeCount }, diagnostics };
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
