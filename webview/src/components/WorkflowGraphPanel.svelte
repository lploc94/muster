<script lang="ts">
  import type { WorkflowGraphWireGraph } from '../../../src/shared/workflow-graph-wire';
  import { buildWorkflowGraphPanelView } from '../lib/workflow-graph-view';

  interface Props {
    graph: WorkflowGraphWireGraph;
  }

  let { graph }: Props = $props();
  const view = $derived(buildWorkflowGraphPanelView(graph));
</script>

<section
  class="workflow-graph-panel"
  data-testid="workflow-graph-panel"
  aria-label="Workflow graph for run {view.runId}"
>
  <header class="workflow-graph-panel__header">
    <div>
      <div class="workflow-graph-panel__eyebrow">Workflow run</div>
      <div class="workflow-graph-panel__run-id">{view.runId}</div>
    </div>
    <div class="workflow-graph-panel__reuse" aria-label="Reuse density">
      {view.reuseSummary.label}
    </div>
  </header>

  {#if view.degradedRead.visible}
    <div class="workflow-graph-panel__degraded" role="status">
      <strong>{view.degradedRead.label}</strong>
      <ul>
        {#each view.degradedRead.diagnostics as diagnostic (diagnostic)}
          <li>{diagnostic}</li>
        {/each}
      </ul>
    </div>
  {/if}

  <div class="workflow-graph-panel__section">
    <div class="workflow-graph-panel__section-title">Nodes</div>
    <ol class="workflow-graph-panel__nodes">
      {#each view.nodes as node (node.id)}
        <li
          class:workflow-graph-panel__node--active={node.active}
          class="workflow-graph-panel__node"
          data-node-id={node.id}
          data-node-status={node.status}
        >
          <div class="workflow-graph-panel__node-topline">
            <span class="workflow-graph-panel__node-id">{node.id}</span>
            <span class="workflow-graph-panel__status">{node.statusLabel}</span>
          </div>
          {#if node.active}
            <div class="workflow-graph-panel__active">Active node</div>
          {/if}
          {#if node.reused}
            <div class="workflow-graph-panel__provenance">{node.provenanceLabel}</div>
          {/if}
        </li>
      {/each}
    </ol>
  </div>

  {#if view.activeGate}
    <div class="workflow-graph-panel__section" data-gate-id={view.activeGate.id}>
      <div class="workflow-graph-panel__section-title">Active gate</div>
      <div class="workflow-graph-panel__summary-line">
        <span>{view.activeGate.statusLabel}</span>
        <span>{view.activeGate.progressLabel}</span>
      </div>
    </div>
  {/if}

  {#if view.feedbackRounds.length > 0}
    <div class="workflow-graph-panel__section">
      <div class="workflow-graph-panel__section-title">Feedback rounds</div>
      <ul class="workflow-graph-panel__plain-list">
        {#each view.feedbackRounds as round (round.id)}
          <li>
            <span>{round.statusLabel} from {round.requesterNodeId}</span>
            <span>{round.progressLabel}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if view.childRuns.length > 0}
    <div class="workflow-graph-panel__section">
      <div class="workflow-graph-panel__section-title">Child runs</div>
      <ul class="workflow-graph-panel__plain-list">
        {#each view.childRuns as childRun (childRun.id)}
          <li data-child-run-id={childRun.id}>
            <span>{childRun.id}</span>
            <span class="workflow-graph-panel__status">{childRun.statusLabel}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .workflow-graph-panel {
    margin: 0.5rem 0.75rem;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
    font-size: 12px;
  }

  .workflow-graph-panel__header,
  .workflow-graph-panel__node-topline,
  .workflow-graph-panel__summary-line,
  .workflow-graph-panel__plain-list li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .workflow-graph-panel__header,
  .workflow-graph-panel__section,
  .workflow-graph-panel__degraded {
    padding: 0.55rem 0.65rem;
  }

  .workflow-graph-panel__section,
  .workflow-graph-panel__degraded {
    border-top: 1px solid var(--vscode-panel-border);
  }

  .workflow-graph-panel__eyebrow,
  .workflow-graph-panel__section-title {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .workflow-graph-panel__run-id,
  .workflow-graph-panel__node-id {
    overflow-wrap: anywhere;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
  }

  .workflow-graph-panel__reuse,
  .workflow-graph-panel__status {
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }

  .workflow-graph-panel__nodes,
  .workflow-graph-panel__plain-list,
  .workflow-graph-panel__degraded ul {
    margin: 0.4rem 0 0;
    padding: 0;
    list-style: none;
  }

  .workflow-graph-panel__node,
  .workflow-graph-panel__plain-list li {
    padding: 0.35rem 0;
  }

  .workflow-graph-panel__node + .workflow-graph-panel__node,
  .workflow-graph-panel__plain-list li + li {
    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
  }

  .workflow-graph-panel__node--active {
    padding-left: 0.45rem;
    border-left: 2px solid var(--vscode-focusBorder);
  }

  .workflow-graph-panel__active {
    color: var(--vscode-testing-iconPassed, var(--vscode-focusBorder));
    font-weight: 600;
    margin-top: 0.15rem;
  }

  .workflow-graph-panel__provenance,
  .workflow-graph-panel__degraded {
    color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
  }

  .workflow-graph-panel__provenance {
    margin-top: 0.15rem;
  }

  .workflow-graph-panel__degraded ul {
    list-style: disc;
    padding-left: 1.2rem;
  }
</style>
