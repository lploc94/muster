/**
 * Correlates one real webview-initiated `requestWorkflowGraph` with the host's
 * `workflowGraphResult` reply so a native Extension Development Host can prove
 * the focus/transport seam end to end.
 *
 * Direction matters: unlike the render probe (host asks, webview answers), the
 * graph route is webview-initiated. This module therefore never *sends*
 * anything. It arms an expectation, observes the genuine inbound request and
 * the genuine outbound reply, and settles only when both correlate. That keeps
 * the production path unmodified — no synthesized request can satisfy it.
 *
 * The observation is deliberately bounded: counts, statuses, and diagnostic
 * codes only. No node ids, input refs, run ids, prompts, artifact bodies, or
 * paths ever leave this module.
 */
import {
  parseWorkflowGraphResult,
  type WorkflowGraphDiagnosticCode,
  type WorkflowGraphErrorCode,
  type WorkflowGraphWireGraph,
} from '../shared/workflow-graph-wire';

/** Bounded projection of a rendered graph — aggregate shape, never identifiers. */
export type WorkflowGraphProbeGraphObservation = {
  runStatus: string;
  nodeCount: number;
  edgeCount: number;
  /** Nodes/edges individually flagged reused on the wire. */
  reusedNodeCount: number;
  reusedEdgeCount: number;
  /** The host's own reuse counters, kept separate so drift is detectable. */
  reuseNodeCount: number;
  reuseEdgeCount: number;
  /** Sorted unique node statuses; proves `reused` survives to the wire. */
  nodeStatuses: string[];
  feedbackRoundCount: number;
  activeGate?: { status: string; satisfied: number; required: number };
  diagnostics: WorkflowGraphDiagnosticCode[];
};

export type WorkflowGraphProbeObservation = {
  /** Echoed so the caller can assert correlation rather than trusting us. */
  requestId: string;
  taskId: string;
  ok: boolean;
  code?: WorkflowGraphErrorCode;
  graph?: WorkflowGraphProbeGraphObservation;
};

export type WorkflowGraphProbeCoordinator = {
  /** Arms a single-flight expectation. Call before triggering the focus change. */
  expect(taskId: string): Promise<WorkflowGraphProbeObservation>;
  /** Taps the real inbound webview message; captures the correlation id. */
  noteRequest(message: unknown): void;
  /** Taps the real outbound host reply; settles on correlation. */
  noteResult(message: unknown): boolean;
  dispose(): void;
};

export type WorkflowGraphProbeDeps = {
  timeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timeout: ReturnType<typeof setTimeout>) => void;
};

const DEFAULT_TIMEOUT_MS = 20_000;

type Pending = {
  taskId: string;
  /** Set once the webview's own request is observed. Until then nothing can settle. */
  requestId: string | undefined;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (observation: WorkflowGraphProbeObservation) => void;
  reject: (error: Error) => void;
};

function summarizeGraph(graph: WorkflowGraphWireGraph): WorkflowGraphProbeGraphObservation {
  const statuses = [...new Set(graph.nodes.map((node) => node.workflowNodeStatus))].sort();
  return {
    runStatus: graph.runStatus,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    reusedNodeCount: graph.nodes.filter((node) => node.reused).length,
    reusedEdgeCount: graph.edges.filter((edge) => edge.reused).length,
    reuseNodeCount: graph.reuse.nodeCount,
    reuseEdgeCount: graph.reuse.edgeCount,
    nodeStatuses: statuses,
    feedbackRoundCount: graph.feedbackRounds.length,
    ...(graph.activeGate
      ? {
          activeGate: {
            status: graph.activeGate.status,
            satisfied: graph.activeGate.satisfied,
            required: graph.activeGate.required,
          },
        }
      : {}),
    diagnostics: graph.diagnostics.map((diagnostic) => diagnostic.code),
  };
}

/** True when `message` is a webview graph request for `taskId`. */
function readRequestId(message: unknown, taskId: string): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const candidate = message as { type?: unknown; requestId?: unknown; taskId?: unknown };
  if (candidate.type !== 'requestWorkflowGraph') return undefined;
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0) return undefined;
  if (candidate.taskId !== taskId) return undefined;
  return candidate.requestId;
}

/**
 * Creates a single-flight observer so a stale, forged, or uncorrelated reply
 * cannot satisfy a live native-host observation.
 */
export function createWorkflowGraphProbeCoordinator(
  deps: WorkflowGraphProbeDeps = {},
): WorkflowGraphProbeCoordinator {
  const setTimer = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((timeout) => clearTimeout(timeout));
  let pending: Pending | undefined;
  let disposed = false;

  function settle(error?: Error, observation?: WorkflowGraphProbeObservation): void {
    const current = pending;
    if (!current) return;
    pending = undefined;
    clearTimer(current.timeout);
    if (error) current.reject(error);
    else current.resolve(observation!);
  }

  return {
    expect(taskId: string): Promise<WorkflowGraphProbeObservation> {
      if (disposed) {
        return Promise.reject(new Error('Workflow graph probe coordinator is disposed'));
      }
      if (pending) {
        return Promise.reject(new Error('Workflow graph probe observation is already pending'));
      }
      if (!taskId) return Promise.reject(new Error('Workflow graph probe taskId is required'));

      return new Promise<WorkflowGraphProbeObservation>((resolve, reject) => {
        const timeout = setTimer(() => {
          const sawRequest = Boolean(pending?.requestId);
          settle(
            new Error(
              sawRequest
                ? 'Workflow graph probe observed the webview request but no correlated result'
                : 'Workflow graph probe timed out before the webview requested a graph',
            ),
          );
        }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        pending = { taskId, requestId: undefined, timeout, resolve, reject };
      });
    },

    noteRequest(message: unknown): void {
      if (!pending || pending.requestId) return;
      const requestId = readRequestId(message, pending.taskId);
      if (requestId) pending.requestId = requestId;
    },

    noteResult(message: unknown): boolean {
      const current = pending;
      if (!current?.requestId) return false;
      const result = parseWorkflowGraphResult(message);
      if (!result) return false;
      if (result.requestId !== current.requestId || result.taskId !== current.taskId) return false;

      settle(undefined, {
        requestId: result.requestId,
        taskId: result.taskId,
        ok: result.ok,
        ...(result.ok ? { graph: summarizeGraph(result.graph) } : { code: result.code }),
      });
      return true;
    },

    dispose(): void {
      disposed = true;
      settle(new Error('Workflow graph probe coordinator is disposed'));
    },
  };
}
