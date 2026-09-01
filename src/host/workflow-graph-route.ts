import {
  parseRequestWorkflowGraphMessage,
  WORKFLOW_GRAPH_DIAGNOSTIC_CODES,
  type WorkflowGraphDiagnosticCode,
  type WorkflowGraphErrorCode,
  type WorkflowGraphResult,
  type WorkflowGraphWireGraph,
} from '../shared/workflow-graph-wire';
import type { WorkflowGraphView } from './workflow-graph';

export interface WorkflowGraphFocusState {
  taskId: string | undefined;
  generation: number;
}

export interface WorkflowGraphRouteDeps {
  getFocused: () => WorkflowGraphFocusState;
  buildWorkflowGraph: (taskId: string) => Promise<WorkflowGraphView | undefined>;
}

export type WorkflowGraphHostOutcome =
  | { kind: 'silent' }
  | { kind: 'message'; message: WorkflowGraphResult };

function failure(
  requestId: string,
  taskId: string,
  code: WorkflowGraphErrorCode,
): WorkflowGraphHostOutcome {
  return {
    kind: 'message',
    message: { type: 'workflowGraphResult', requestId, taskId, ok: false, code },
  };
}

/**
 * Copies the host presentation projection into the exact, shared webview wire
 * shape. This keeps the route as the only host-to-webview topology adapter.
 */
const WIRE_DIAGNOSTIC_CODES = new Set<string>(WORKFLOW_GRAPH_DIAGNOSTIC_CODES);

function isWireDiagnosticCode(code: string): code is WorkflowGraphDiagnosticCode {
  return WIRE_DIAGNOSTIC_CODES.has(code);
}

function toWireGraph(graph: WorkflowGraphView): WorkflowGraphWireGraph {
  const diagnostics: { code: WorkflowGraphDiagnosticCode }[] = [];
  for (const diagnostic of graph.diagnostics) {
    if (isWireDiagnosticCode(diagnostic.code)) {
      diagnostics.push({ code: diagnostic.code });
    }
  }

  return {
    runStatus: graph.runStatus,
    nodes: graph.nodes.map((node) => ({
      nodeId: node.nodeId,
      ...(node.title ? { title: node.title } : {}),
      workflowNodeStatus: node.workflowNodeStatus,
      executionActivity: node.executionActivity,
      displayState: node.displayState,
      progressBucket: node.progressBucket,
      ...(node.reason ? { reason: node.reason } : {}),
      ...(node.decisionGate ? { decisionGate: node.decisionGate } : {}),
      ...(node.decision ? { decision: { ...node.decision } } : {}),
      reused: node.reused,
    })),
    edges: graph.edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      inputRef: edge.inputRef,
      contributionState: edge.contributionState,
      reused: edge.reused,
    })),
    gates: graph.gates.map((gate) => ({
      consumerNodeId: gate.consumerNodeId,
      status: gate.status,
      satisfied: gate.satisfied,
      required: gate.required,
      inputs: gate.inputs.map((input) => ({ ...input })),
    })),
    ...(graph.activeGate
      ? {
          activeGate: {
            consumerNodeId: graph.activeGate.consumerNodeId,
            status: graph.activeGate.status,
            satisfied: graph.activeGate.satisfied,
            required: graph.activeGate.required,
            inputs: graph.activeGate.inputs.map((input) => ({ ...input })),
          },
        }
      : {}),
    progress: {
      ...graph.progress,
      frontierNodeIds: [...graph.progress.frontierNodeIds],
      activeNodeIds: [...graph.progress.activeNodeIds],
    },
    feedbackRounds: graph.feedbackRounds.map((round) => ({
      requesterNodeId: round.requesterNodeId,
      status: round.status,
      joinMode: round.joinMode,
      required: round.required,
      responded: round.responded,
    })),
    childRuns: graph.childRuns.map((run) => ({ status: run.status })),
    reuse: { nodeCount: graph.reuse.nodeCount, edgeCount: graph.reuse.edgeCount },
    diagnostics,
  };
}

/**
 * Pull-based graph request route. It validates before any graph read, rejects
 * non-focused tasks, and re-checks focus generation after the asynchronous read.
 */
export async function routeRequestWorkflowGraph(
  data: unknown,
  deps: WorkflowGraphRouteDeps,
): Promise<WorkflowGraphHostOutcome> {
  const parsed = parseRequestWorkflowGraphMessage(data);
  if (!parsed.ok) {
    return parsed.silent
      ? { kind: 'silent' }
      : failure(parsed.requestId, parsed.taskId, parsed.code);
  }

  const { requestId, taskId } = parsed;
  const focusAtStart = deps.getFocused();
  if (focusAtStart.taskId !== taskId) return failure(requestId, taskId, 'invalidRequest');

  let graph: WorkflowGraphView | undefined;
  try {
    graph = await deps.buildWorkflowGraph(taskId);
  } catch {
    return failure(requestId, taskId, 'unavailable');
  }

  const focusAfter = deps.getFocused();
  if (
    focusAfter.taskId !== taskId ||
    focusAfter.generation !== focusAtStart.generation
  ) {
    return failure(requestId, taskId, 'invalidRequest');
  }
  if (!graph) return failure(requestId, taskId, 'notInWorkflow');

  return {
    kind: 'message',
    message: {
      type: 'workflowGraphResult',
      requestId,
      taskId,
      ok: true,
      graph: toWireGraph(graph),
    },
  };
}
