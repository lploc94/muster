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
  title?: string;
  status: WorkflowGraphWireGraph["nodes"][number]["displayState"];
  statusLabel: string;
  reused: boolean;
  active: boolean;
  provenanceLabel: string;
  reasonLabel?: string;
  decisionGateLabel?: string;
  decisionLabel?: string;
}

export interface WorkflowGraphEdgeView {
  fromNodeId: string;
  toNodeId: string;
  inputRef: string;
  state: WorkflowGraphWireGraph["edges"][number]["contributionState"];
  stateLabel: string;
  reused: boolean;
}

export interface WorkflowGraphGateInputView {
  inputRef: string;
  producerNodeId: string;
  state: WorkflowGraphWireGraph["gates"][number]["inputs"][number]["state"];
  stateLabel: string;
  missing: boolean;
}

export interface WorkflowGraphGateView {
  id: string;
  consumerNodeId: string;
  status: string;
  statusLabel: string;
  satisfied: number;
  required: number;
  progressLabel: string;
  blockingLabel: string;
  inputs: WorkflowGraphGateInputView[];
}

export interface WorkflowGraphProgressView extends Omit<WorkflowGraphWireGraph["progress"], "frontierNodeIds" | "activeNodeIds"> {
  frontierNodeIds: string[];
  activeNodeIds: string[];
  summaryLabel: string;
  frontierLabel: string;
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

export type WorkflowGraphNodeTone =
  | "success" | "attention" | "info" | "warning" | "danger" | "muted" | "neutral";

export interface WorkflowGraphPanelView {
  runId: string;
  nodes: WorkflowGraphNodeView[];
  edges: WorkflowGraphEdgeView[];
  gates: WorkflowGraphGateView[];
  progress: WorkflowGraphProgressView;
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
  executing: "Executing",
  waiting: "Waiting",
  completed: "Completed",
  not_started: "Not started",
  active: "Running",
  running: "Running",
  reused: "Reused",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
  skipped: "Skipped",
  open: "Open",
  closed: "Closed",
  consumed: "Consumed",
};

const DIAGNOSTIC_LABELS: Readonly<Record<WorkflowGraphDiagnosticCode, string>> =
  {
    workflow_graph_topology_undecodable:
      "Workflow topology could not be decoded",
    workflow_graph_nodes_truncated: "Workflow nodes were truncated",
    workflow_graph_edges_truncated: "Workflow edges were truncated",
    workflow_graph_gates_truncated: "Workflow gates were truncated",
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

export function workflowGraphNodeTone(status: WorkflowGraphWireGraph["nodes"][number]["displayState"]): WorkflowGraphNodeTone {
  if (status === "completed" || status === "reused") return "success";
  if (status === "executing") return "attention";
  if (status === "queued" || status === "waiting") return "info";
  if (status === "blocked") return "warning";
  if (status === "failed") return "danger";
  if (status === "cancelled" || status === "skipped") return "muted";
  return "neutral";
}

export function workflowGraphDecisionLabel(
  decision: NonNullable<WorkflowGraphWireGraph["nodes"][number]["decision"]>,
): string {
  const attempt = `attempt ${decision.attempt} of ${decision.maxAttempts}`;
  if (decision.status === "waiting") return `Waiting for workflow decision · ${attempt}`;
  if (decision.status === "correcting") return `Correcting workflow route · ${attempt}`;
  if (decision.status === "decided") return `Workflow route decided · ${attempt}`;
  return `Workflow decision failed · ${attempt}`;
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

const INPUT_STATE_LABELS: Readonly<Record<WorkflowGraphWireGraph["gates"][number]["inputs"][number]["state"], string>> = {
  supplied_live: "Supplied live",
  supplied_reused: "Supplied reused",
  pending: "Pending",
  blocking: "Blocking",
};

const NODE_REASON_LABELS: Readonly<Record<NonNullable<WorkflowGraphWireGraph["nodes"][number]["reason"]>, string>> = {
  waiting_for_inputs: "Waiting for workflow inputs",
  run_closed_before_activation: "Run closed before activation",
  awaiting_workflow_route: "Waiting for workflow routing",
};

function reduceGate(gate: WorkflowGraphWireGraph["gates"][number]): WorkflowGraphGateView {
  const inputs = gate.inputs.map((input) => ({
    inputRef: input.inputRef,
    producerNodeId: input.producerNodeId,
    state: input.state,
    stateLabel: INPUT_STATE_LABELS[input.state],
    missing: input.state === "pending" || input.state === "blocking",
  }));
  const pendingRefs = inputs.filter((input) => input.state === "pending").map((input) => input.inputRef);
  const blockingRefs = inputs.filter((input) => input.state === "blocking").map((input) => input.inputRef);
  const blockingParts: string[] = [];
  if (pendingRefs.length > 0) blockingParts.push(`Waiting on ${pendingRefs.join(", ")}`);
  if (blockingRefs.length > 0) blockingParts.push(`Blocked by ${blockingRefs.join(", ")}`);
  return {
    id: gate.gateId,
    consumerNodeId: gate.consumerNodeId,
    status: gate.status,
    statusLabel: workflowGraphStatusLabel(gate.status),
    satisfied: gate.satisfied,
    required: gate.required,
    progressLabel: `${gate.satisfied} of ${gate.required} required inputs supplied`,
    blockingLabel: blockingParts.length > 0 ? blockingParts.join(" · ") : "All inputs supplied",
    inputs,
  };
}

function reduceProgress(progress: WorkflowGraphWireGraph["progress"]): WorkflowGraphProgressView {
  const parts = [`${progress.completed} of ${progress.total} completed`];
  const counts: Array<[number, string]> = [
    [progress.queued, "queued"],
    [progress.executing, "executing"],
    [progress.waiting, "waiting"],
    [progress.blocked, "blocked"],
    [progress.notStarted, "not started"],
    [progress.failed, "failed"],
    [progress.cancelled, "cancelled"],
    [progress.skipped, "skipped"],
  ];
  for (const [count, label] of counts) if (count > 0) parts.push(`${count} ${label}`);
  return {
    ...progress,
    frontierNodeIds: [...progress.frontierNodeIds],
    activeNodeIds: [...progress.activeNodeIds],
    summaryLabel: parts.join(" · "),
    frontierLabel: progress.frontierNodeIds.length > 0
      ? `Frontier: ${progress.frontierNodeIds.join(", ")}`
      : "Frontier clear",
  };
}

/** Reduces a validated wire graph without sorting, filtering, or fabricating topology. */
export function buildWorkflowGraphPanelView(
  graph: WorkflowGraphWireGraph,
): WorkflowGraphPanelView {
  const activeNodeIds = new Set(graph.progress.activeNodeIds);
  const activeNodeId = graph.progress.activeNodeIds[0] ?? null;
  const gates = graph.gates.map(reduceGate);

  return {
    runId: graph.runId,
    nodes: graph.nodes.map((node) => ({
      id: node.nodeId,
      ...(node.title ? { title: node.title } : {}),
      status: node.displayState,
      statusLabel: workflowGraphStatusLabel(node.displayState),
      reused: node.reused,
      active: activeNodeIds.has(node.nodeId),
      provenanceLabel: node.reused ? "Supplied from a prior result" : "",
      ...(node.reason ? { reasonLabel: NODE_REASON_LABELS[node.reason] } : {}),
      ...(node.decisionGate
        ? { decisionGateLabel: node.decisionGate === "required" ? "Decision required" : "Decision optional" }
        : {}),
      ...(node.decision ? { decisionLabel: workflowGraphDecisionLabel(node.decision) } : {}),
    })),
    edges: graph.edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      inputRef: edge.inputRef,
      state: edge.contributionState,
      stateLabel: INPUT_STATE_LABELS[edge.contributionState],
      reused: edge.reused,
    })),
    gates,
    progress: reduceProgress(graph.progress),
    activeNodeId,
    activeGate: graph.activeGate ? reduceGate(graph.activeGate) : null,
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
