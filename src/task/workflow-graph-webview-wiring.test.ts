import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const panelSource = readFileSync(
  resolve(root, "webview/src/components/WorkflowGraphPanel.svelte"),
  "utf8",
);
const appSource = readFileSync(resolve(root, "webview/src/App.svelte"), "utf8");
const workspaceSource = readFileSync(
  resolve(root, "webview/src/components/TaskWorkspace.svelte"),
  "utf8",
);
const composerSource = readFileSync(
  resolve(root, "webview/src/components/Composer.svelte"),
  "utf8",
);
const storeSource = readFileSync(
  resolve(root, "webview/src/lib/workflow-graph-store.svelte.ts"),
  "utf8",
);
const refreshPolicySource = readFileSync(
  resolve(root, "webview/src/lib/workflow-graph-refresh-policy.ts"),
  "utf8",
);

describe("workflow graph webview wiring", () => {
  it("renders the shared bounded presentation view through a dedicated panel", () => {
    expect(panelSource).toContain("buildWorkflowGraphPanelView");
    expect(panelSource).toContain('data-testid="workflow-graph-panel"');
    expect(panelSource).toContain("node.provenanceLabel");
    expect(panelSource).toContain("Active node");
    expect(panelSource).toContain("Active gate");
    expect(panelSource).not.toContain("Child runs");
    expect(panelSource).toContain("view.degradedRead.label");
  });

  it("requests one focused graph and rejects stale task or request correlations", () => {
    expect(appSource).toContain("requestWorkflowGraph");
    expect(appSource).toContain("workflowGraphResult");
    expect(appSource).toContain(
      "msg.requestId !== workflowGraphRequest?.requestId",
    );
    expect(appSource).toContain("msg.taskId !== tasks.focusedTaskId");
    // On-demand modal next to History: no auto-fetch on focus, only when View Workflow is opened
    expect(appSource).toContain("WorkflowGraphModal");
    expect(appSource).toContain('data-testid="view-workflow-graph"');
    expect(appSource).toContain("workflowGraphOpen");
    expect(appSource).toContain("setOpen");
    expect(appSource).toContain("untrack(() => workflowGraphStore.setOpen");
    // TaskWorkspace no longer auto-renders the panel (modal is App-owned, saves vertical space)
    expect(workspaceSource).not.toContain("WorkflowGraphPanel");
    expect(workspaceSource).not.toContain("graph={workflowGraph}");
    // Status overlay still shows per-node detail for the clicked node
    expect(workspaceSource).toContain("task-status-overlay");
    expect(workspaceSource).toContain('data-testid="node-status-detail"');
    expect(workspaceSource).toContain('data-testid="node-status-badge"');
    expect(workspaceSource).toContain("workflowGraphStatusLabel");
    expect(workspaceSource).toContain("formatUpdatedAt");
  });

  it("renders workflow as a DAG canvas with modal pan/zoom (not a plain list)", () => {
    const modalSource = readFileSync(
      resolve(root, "webview/src/components/WorkflowGraphModal.svelte"),
      "utf8",
    );
    const canvasSource = readFileSync(
      resolve(root, "webview/src/components/WorkflowGraphCanvas.svelte"),
      "utf8",
    );
    const layoutSource = readFileSync(
      resolve(root, "webview/src/lib/workflow-graph-layout.ts"),
      "utf8",
    );
    expect(modalSource).toContain('data-testid="workflow-graph-modal"');
    expect(modalSource).toContain("WorkflowGraphCanvas");
    expect(modalSource).toContain('role="dialog"');
    expect(canvasSource).toContain("computeWorkflowGraphLayout");
    expect(canvasSource).toContain('data-testid="workflow-graph-canvas"');
    expect(canvasSource).toContain("data-node-id");
    expect(canvasSource).toContain("data-edge-from");
    expect(canvasSource).toContain("data-input-state");
    expect(canvasSource).toContain("n.title");
    expect(canvasSource).toContain("n.decisionLabel");
    expect(canvasSource).not.toContain('role="button"');
    expect(canvasSource).not.toContain("onNodeClick");
    expect(layoutSource).toContain("computeWorkflowGraphLayout");
    expect(layoutSource).toContain("computeWorkflowGraphFit");
    expect(layoutSource).toContain("NODE_W");
    expect(modalSource).toContain("ResizeObserver");
    expect(modalSource).toContain("view.progress.summaryLabel");
    expect(modalSource).toContain("view.gates");
    expect(modalSource).toContain("n.decisionGateLabel");
    expect(modalSource).toContain("n.decisionLabel");
    expect(modalSource).toContain("workflowGraphTopologyKey");
    expect(modalSource).toContain("untrack");
  });

  it("keeps pending shells inspect-only and graph refreshes ordered", () => {
    expect(workspaceSource).toContain("task.workflowNodeStatus === 'pending'");
    expect(composerSource).toContain("task.workflowNodeStatus === 'pending'");
    expect(storeSource).toContain("WorkflowGraphRefreshPolicy");
    expect(storeSource).toContain("this.error !== null");
    expect(refreshPolicySource).toContain("dirtyWhileRequest");
  });
});
