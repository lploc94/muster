import { describe, expect, it } from "vitest";
import type { WorkflowGraphWireGraph } from "../../../src/shared/workflow-graph-wire";
import {
  buildWorkflowGraphPanelView,
  workflowGraphDiagnosticLabel,
  workflowGraphStatusLabel,
} from "./workflow-graph-view";

function graph(
  overrides: Partial<WorkflowGraphWireGraph> = {},
): WorkflowGraphWireGraph {
  return {
    runId: "run-parent",
    runStatus: "running",
    nodes: [
      { nodeId: "one", workflowNodeStatus: "reused", executionActivity: "none", displayState: "reused", progressBucket: "completed", reused: true },
      { nodeId: "two", workflowNodeStatus: "reused", executionActivity: "none", displayState: "reused", progressBucket: "completed", reused: true },
      { nodeId: "three", workflowNodeStatus: "reused", executionActivity: "none", displayState: "reused", progressBucket: "completed", reused: true },
      { nodeId: "four", workflowNodeStatus: "reused", executionActivity: "none", displayState: "reused", progressBucket: "completed", reused: true },
      { nodeId: "five", workflowNodeStatus: "active", executionActivity: "executing", displayState: "executing", progressBucket: "executing", reused: false },
    ],
    edges: [
      { fromNodeId: "one", toNodeId: "two", inputRef: "source", contributionState: "supplied_reused", reused: true },
      {
        fromNodeId: "two",
        toNodeId: "three",
        inputRef: "source",
        contributionState: "supplied_reused",
        reused: true,
      },
      {
        fromNodeId: "three",
        toNodeId: "four",
        inputRef: "source",
        contributionState: "supplied_reused",
        reused: true,
      },
      {
        fromNodeId: "four",
        toNodeId: "five",
        inputRef: "source",
        contributionState: "supplied_reused",
        reused: true,
      },
    ],
    gates: [{
      gateId: "gate-five", consumerNodeId: "five", status: "open",
      satisfied: 3, required: 4,
      inputs: [
        { inputRef: "one", producerNodeId: "one", state: "supplied_reused" },
        { inputRef: "two", producerNodeId: "two", state: "supplied_reused" },
        { inputRef: "three", producerNodeId: "three", state: "supplied_reused" },
        { inputRef: "four", producerNodeId: "four", state: "pending" },
      ],
    }],
    activeGate: {
      gateId: "gate-five",
      consumerNodeId: "five",
      status: "open",
      satisfied: 3,
      required: 4,
      inputs: [
        { inputRef: "one", producerNodeId: "one", state: "supplied_reused" },
        { inputRef: "two", producerNodeId: "two", state: "supplied_reused" },
        { inputRef: "three", producerNodeId: "three", state: "supplied_reused" },
        { inputRef: "four", producerNodeId: "four", state: "pending" },
      ],
    },
    progress: {
      total: 5, completed: 4, queued: 0, executing: 1, waiting: 0,
      blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
      frontierNodeIds: ["five"], activeNodeIds: ["five"],
    },
    feedbackRounds: [
      {
        roundId: "feedback-1",
        requesterNodeId: "five",
        status: "open",
        joinMode: "all",
        responded: 1,
        required: 2,
      },
    ],
    childRuns: [{ runId: "run-child", status: "running" }],
    reuse: { nodeCount: 4, edgeCount: 4 },
    diagnostics: [
      { code: "workflow_graph_topology_undecodable" },
      { code: "workflow_graph_nodes_truncated" },
      { code: "workflow_graph_edges_truncated" },
      { code: "workflow_graph_child_runs_truncated" },
    ],
    ...overrides,
  };
}

describe("buildWorkflowGraphPanelView", () => {
  it("reduces a five-node reuse closure into stable operator-facing panel data", () => {
    const view = buildWorkflowGraphPanelView(graph());

    expect(view.runId).toBe("run-parent");
    expect(view.nodes).toEqual([
      {
        id: "one",
        status: "reused",
        statusLabel: "Reused",
        reused: true,
        active: false,
        provenanceLabel: "Supplied from a prior result",
      },
      {
        id: "two",
        status: "reused",
        statusLabel: "Reused",
        reused: true,
        active: false,
        provenanceLabel: "Supplied from a prior result",
      },
      {
        id: "three",
        status: "reused",
        statusLabel: "Reused",
        reused: true,
        active: false,
        provenanceLabel: "Supplied from a prior result",
      },
      {
        id: "four",
        status: "reused",
        statusLabel: "Reused",
        reused: true,
        active: false,
        provenanceLabel: "Supplied from a prior result",
      },
      {
        id: "five",
        status: "executing",
        statusLabel: "Executing",
        reused: false,
        active: true,
        provenanceLabel: "",
      },
    ]);
    expect(view.activeNodeId).toBe("five");
    expect(view.activeGate).toEqual({
      id: "gate-five",
      status: "open",
      statusLabel: "Open",
      satisfied: 3,
      required: 4,
      progressLabel: "3 of 4 required inputs supplied",
    });
    expect(view.feedbackRounds).toEqual([
      {
        id: "feedback-1",
        requesterNodeId: "five",
        status: "open",
        statusLabel: "Open",
        joinMode: "all",
        responded: 1,
        required: 2,
        progressLabel: "1 of 2 responses received",
      },
    ]);
    expect(view.childRuns).toEqual([
      { id: "run-child", status: "running", statusLabel: "Running" },
    ]);
    expect(view.reuseSummary).toEqual({
      nodeCount: 4,
      edgeCount: 4,
      label: "4 reused nodes · 4 reused edges",
    });
    expect(view.degradedRead).toEqual({
      visible: true,
      label: "Workflow graph may be incomplete",
      diagnostics: [
        "Workflow topology could not be decoded",
        "Workflow nodes were truncated",
        "Workflow edges were truncated",
        "Child workflow runs were truncated",
      ],
    });
  });

  it("preserves bounded input order, does not invent an active node, and handles absent optional data", () => {
    const view = buildWorkflowGraphPanelView(
      graph({
        nodes: [
          { nodeId: "later", workflowNodeStatus: "active", executionActivity: "queued", displayState: "queued", progressBucket: "queued", reused: false },
          { nodeId: "earlier", workflowNodeStatus: "succeeded", executionActivity: "completed", displayState: "completed", progressBucket: "completed", reused: false },
        ],
        progress: {
          total: 2, completed: 1, queued: 1, executing: 0, waiting: 0,
          blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
          frontierNodeIds: ["later"], activeNodeIds: [],
        },
        activeGate: undefined,
        feedbackRounds: [],
        childRuns: [],
        reuse: { nodeCount: 0, edgeCount: 0 },
        diagnostics: [],
      }),
    );

    expect(view.nodes.map((node) => node.id)).toEqual(["later", "earlier"]);
    expect(view.nodes.every((node) => !node.active)).toBe(true);
    expect(view.activeNodeId).toBeNull();
    expect(view.activeGate).toBeNull();
    expect(view.feedbackRounds).toEqual([]);
    expect(view.childRuns).toEqual([]);
    expect(view.reuseSummary.label).toBe("No reused nodes or edges");
    expect(view.degradedRead).toEqual({
      visible: false,
      label: "",
      diagnostics: [],
    });
  });

  it("covers durable node and gate statuses while retaining a safe fallback for future values", () => {
    for (const status of ["pending", "active", "reused", "succeeded", "consumed"]) {
      expect(workflowGraphStatusLabel(status)).not.toBe("Unknown status");
    }
    expect(workflowGraphStatusLabel("blocked")).toBe("Blocked");
    expect(workflowGraphStatusLabel("satisfied")).toBe("Satisfied");
    expect(workflowGraphStatusLabel("future_state")).toBe("Unknown status");
    expect(workflowGraphDiagnosticLabel("workflow_graph_edges_truncated")).toBe(
      "Workflow edges were truncated",
    );
  });
});
