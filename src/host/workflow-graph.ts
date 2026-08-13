import type { TaskRepository } from '../task/repository';
import type {
  WorkflowGraphChildRunProjection,
  WorkflowGraphEdgeProjection,
  WorkflowGraphNodeProjection,
  WorkflowGraphProjection,
  WorkflowGraphReuseProjection,
  WorkflowGateStatusProjection,
  WorkflowIntegrityDiagnosticProjection,
  WorkflowRunFeedbackRoundInspectionProjection,
} from '../task/workflow-types';

/** A graph node enriched for host rendering without exposing durable task ids. */
export interface WorkflowGraphViewNode extends WorkflowGraphNodeProjection {
  reused: boolean;
}

/** A graph edge enriched from its producer node's durable lifecycle state. */
export interface WorkflowGraphViewEdge extends WorkflowGraphEdgeProjection {
  reused: boolean;
}

/**
 * Host-only graph view ready for a future webview protocol adapter.
 *
 * This deliberately keeps the repository's bounded read and its diagnostics
 * intact, while deriving display-friendly reuse state from durable node status.
 * It must not be used by agent-facing tool or bridge projections.
 */
export interface WorkflowGraphView {
  runId: string;
  nodes: readonly WorkflowGraphViewNode[];
  edges: readonly WorkflowGraphViewEdge[];
  activeGate?: WorkflowGateStatusProjection;
  feedbackRounds: readonly WorkflowRunFeedbackRoundInspectionProjection[];
  childRuns: readonly WorkflowGraphChildRunProjection[];
  reuse: WorkflowGraphReuseProjection;
  diagnostics: readonly WorkflowIntegrityDiagnosticProjection[];
}

/**
 * Reads and adapts the bounded graph containing taskId for host presentation.
 * Missing workflow membership remains undefined; repository failures propagate.
 */
export async function buildWorkflowGraphView(
  repository: Pick<TaskRepository, 'getWorkflowGraphForTask'>,
  taskId: string,
): Promise<WorkflowGraphView | undefined> {
  const graph = await repository.getWorkflowGraphForTask(taskId);
  if (!graph) return undefined;

  return projectWorkflowGraphView(graph);
}

/** Converts the durable graph projection to its renderer-oriented host shape. */
export function projectWorkflowGraphView(graph: WorkflowGraphProjection): WorkflowGraphView {
  const reusedNodeIds = new Set(
    graph.nodes.filter((node) => node.status === 'reused').map((node) => node.nodeId),
  );

  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      reused: reusedNodeIds.has(node.nodeId),
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      reused: reusedNodeIds.has(edge.fromNodeId),
    })),
  };
}
