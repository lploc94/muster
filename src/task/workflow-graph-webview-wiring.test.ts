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

describe("workflow graph webview wiring", () => {
  it("renders the shared bounded presentation view through a dedicated panel", () => {
    expect(panelSource).toContain("buildWorkflowGraphPanelView");
    expect(panelSource).toContain('data-testid="workflow-graph-panel"');
    expect(panelSource).toContain("node.provenanceLabel");
    expect(panelSource).toContain("Active node");
    expect(panelSource).toContain("Active gate");
    expect(panelSource).toContain("Child runs");
    expect(panelSource).toContain("view.degradedRead.label");
  });

  it("requests one focused graph and rejects stale task or request correlations", () => {
    expect(appSource).toContain("requestWorkflowGraph");
    expect(appSource).toContain("workflowGraphResult");
    expect(appSource).toContain(
      "msg.requestId !== workflowGraphRequest?.requestId",
    );
    expect(appSource).toContain("msg.taskId !== tasks.focusedTaskId");
    expect(workspaceSource).toContain("WorkflowGraphPanel");
    expect(workspaceSource).toContain("graph={workflowGraph}");
  });
});
