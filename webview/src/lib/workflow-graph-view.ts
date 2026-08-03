/**
 * Pure workflow graph presentation reducer (M024/S05).
 *
 * Converts the bounded, already-validated host graph into stable operator copy.
 * This module performs no I/O and has no framework or DOM dependency.
 */
import type {
  WorkflowGraphDiagnosticCode,
  WorkflowGraphWireGraph,
} from "../../../src/shared/workflow-graph-wire";

export interface WorkflowGraphNodeView {
  id: string;
  status: string;
  statusLabel: string;
  reused: boolean;
  active: boolean;
  provenanceLabel: string;
}

export interface WorkflowGraphGateView {
  id: string;
  status: string;
  statusLabel: string;
  satisfied: number;
  required: number;
  progressLabel: string;
}

export interface WorkflowGraphFeedbackRoundView {
  id: string;
  requesterNodeId: string;
  status: string;
  statusLabel: string;
  joinMode: string;
  responded: number;
  required: number;
  progressLabel: string;
}

export interface WorkflowGraphChildRunView {
  id: string;
  status: string;
  statusLabel: string;
}

export interface WorkflowGraphReuseSummary {
  nodeCount: number;
  edgeCount: number;
  label: string;
}

export interface WorkflowGraphDegradedReadView {
  visible: boolean;
  label: string;
  diagnostics: string[];
}

export interface WorkflowGraphPanelView {
  runId: string;
  nodes: WorkflowGraphNodeView[];
  activeNodeId: string | null;
  activeGate: WorkflowGraphGateView | null;
  feedbackRounds: WorkflowGraphFeedbackRoundView[];
  childRuns: WorkflowGraphChildRunView[];
  reuseSummary: WorkflowGraphReuseSummary;
  degradedRead: WorkflowGraphDegradedReadView;
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "Waiting for inputs",
  satisfied: "Satisfied",
  queued: "Queued",
  running: "Running",
  reused: "Reused",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
  open: "Open",
  closed: "Closed",
};

const DIAGNOSTIC_LABELS: Readonly<Record<WorkflowGraphDiagnosticCode, string>> =
  {
    workflow_graph_topology_undecodable:
      "Workflow topology could not be decoded",
    workflow_graph_nodes_truncated: "Workflow nodes were truncated",
    workflow_graph_edges_truncated: "Workflow edges were truncated",
    workflow_graph_child_runs_truncated: "Child workflow runs were truncated",
  };

export function workflowGraphStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "Unknown status";
}

export function workflowGraphDiagnosticLabel(
  code: WorkflowGraphDiagnosticCode,
): string {
  return DIAGNOSTIC_LABELS[code];
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function reuseLabel(nodeCount: number, edgeCount: number): string {
  if (nodeCount === 0 && edgeCount === 0) return "No reused nodes or edges";
  return `${plural(nodeCount, "reused node")} · ${plural(edgeCount, "reused edge")}`;
}

function reduceDegradedRead(
  diagnostics: WorkflowGraphWireGraph["diagnostics"],
): WorkflowGraphDegradedReadView {
  if (diagnostics.length === 0)
    return { visible: false, label: "", diagnostics: [] };
  return {
    visible: true,
    label: "Workflow graph may be incomplete",
    diagnostics: diagnostics.map((diagnostic) =>
      workflowGraphDiagnosticLabel(diagnostic.code),
    ),
  };
}

/** Reduces a validated wire graph without sorting, filtering, or fabricating topology. */
export function buildWorkflowGraphPanelView(
  graph: WorkflowGraphWireGraph,
): WorkflowGraphPanelView {
  const activeNodeId =
    graph.nodes.find((node) => node.status === "running")?.nodeId ?? null;

  return {
    runId: graph.runId,
    nodes: graph.nodes.map((node) => ({
      id: node.nodeId,
      status: node.status,
      statusLabel: workflowGraphStatusLabel(node.status),
      reused: node.reused,
      active: node.nodeId === activeNodeId,
      provenanceLabel: node.reused ? "Supplied from a prior result" : "",
    })),
    activeNodeId,
    activeGate: graph.activeGate
      ? {
          id: graph.activeGate.gateId,
          status: graph.activeGate.status,
          statusLabel: workflowGraphStatusLabel(graph.activeGate.status),
          satisfied: graph.activeGate.satisfied,
          required: graph.activeGate.required,
          progressLabel: `${graph.activeGate.satisfied} of ${graph.activeGate.required} required inputs supplied`,
        }
      : null,
    feedbackRounds: graph.feedbackRounds.map((round) => ({
      id: round.roundId,
      requesterNodeId: round.requesterNodeId,
      status: round.status,
      statusLabel: workflowGraphStatusLabel(round.status),
      joinMode: round.joinMode,
      responded: round.responded,
      required: round.required,
      progressLabel: `${round.responded} of ${round.required} responses received`,
    })),
    childRuns: graph.childRuns.map((childRun) => ({
      id: childRun.runId,
      status: childRun.status,
      statusLabel: workflowGraphStatusLabel(childRun.status),
    })),
    reuseSummary: {
      nodeCount: graph.reuse.nodeCount,
      edgeCount: graph.reuse.edgeCount,
      label: reuseLabel(graph.reuse.nodeCount, graph.reuse.edgeCount),
    },
    degradedRead: reduceDegradedRead(graph.diagnostics),
  };
}
