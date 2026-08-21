<script lang="ts">
  import type { WorkflowGraphWireGraph } from '../../../src/shared/workflow-graph-wire';
  import { buildWorkflowGraphPanelView } from '../lib/workflow-graph-view';

  interface Props {
    graph: WorkflowGraphWireGraph;
  }

  let { graph }: Props = $props();
  const view = $derived(buildWorkflowGraphPanelView(graph));

  function nodeTone(status: string): string {
    if (status === 'succeeded' || status === 'reused') return 'task-status--success';
    if (status === 'active' || status === 'running') return 'task-status--attention';
    if (status === 'failed') return 'task-status--danger';
    if (status === 'cancelled' || status === 'skipped') return 'task-status--muted';
    if (status === 'pending' || status === 'queued' || status === 'blocked') return 'task-status--info';
    return 'task-status--neutral';
  }

  function nodeIcon(status: string, active: boolean): string {
    if (active) return 'codicon-loading';
    if (status === 'succeeded' || status === 'reused') return 'codicon-pass-filled';
    if (status === 'failed') return 'codicon-error';
    if (status === 'cancelled') return 'codicon-circle-slash';
    if (status === 'skipped') return 'codicon-debug-step-over';
    if (status === 'pending' || status === 'queued') return 'codicon-clock';
    if (status === 'blocked') return 'codicon-warning';
    if (status === 'active' || status === 'running') return 'codicon-loading';
    return 'codicon-circle-large-outline';
  }
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
    <div class="workflow-graph-panel__section-title">Nodes — {view.nodes.length} · {view.reuseSummary.label}</div>
    <ol class="workflow-graph-panel__nodes">
      {#each view.nodes as node (node.id)}
        {@const tone = nodeTone(node.status)}
        <li
          class:workflow-graph-panel__node--active={node.active}
          class="workflow-graph-panel__node {tone}"
          data-node-id={node.id}
          data-node-status={node.status}
        >
          <div class="workflow-graph-panel__node-topline">
            <div class="workflow-graph-panel__node-identity">
              <span class="codicon {nodeIcon(node.status, node.active)} workflow-graph-panel__node-icon" aria-hidden="true"></span>
              <span class="workflow-graph-panel__node-id">{node.id}</span>
            </div>
            <span class="workflow-graph-panel__status-badge {tone}">{node.statusLabel}</span>
          </div>
          {#if node.active}
            <div class="workflow-graph-panel__active">● Active node — currently executing</div>
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
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    background: var(--vscode-editor-background, #1e1e1e);
    font-size: 12px;
    color: var(--vscode-foreground, #cccccc);
    border-radius: 6px;
    overflow: hidden;
  }

  /* Inside overlay we want flush, no outer margin/border duplication */
  :global(.task-status-overlay) .workflow-graph-panel {
    margin: 0;
    border: none;
    border-radius: 0;
    background: transparent;
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

  .workflow-graph-panel__header {
    padding: 0.6rem 0.75rem;
    background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 96%, var(--vscode-foreground) 4%);
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
  }

  .workflow-graph-panel__section,
  .workflow-graph-panel__degraded {
    padding: 0.55rem 0.75rem;
  }

  .workflow-graph-panel__section,
  .workflow-graph-panel__degraded {
    border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
  }
  .workflow-graph-panel__section:first-of-type {
    border-top: none;
  }

  .workflow-graph-panel__eyebrow,
  .workflow-graph-panel__section-title {
    color: var(--vscode-descriptionForeground, #9ca3af);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .workflow-graph-panel__run-id {
    margin-top: 2px;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground, #cccccc);
    overflow-wrap: anywhere;
  }

  .workflow-graph-panel__reuse {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #9ca3af);
    background: color-mix(in srgb, var(--vscode-badge-background, #616061) 28%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
    padding: 2px 6px;
    border-radius: 999px;
    white-space: nowrap;
  }

  .workflow-graph-panel__node-id {
    overflow-wrap: anywhere;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground, #cccccc);
  }

  .workflow-graph-panel__status-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
    background: color-mix(in srgb, currentColor 12%, transparent);
    white-space: nowrap;
  }

  .workflow-graph-panel__nodes,
  .workflow-graph-panel__plain-list,
  .workflow-graph-panel__degraded ul {
    margin: 0.45rem 0 0;
    padding: 0;
    list-style: none;
  }

  .workflow-graph-panel__node {
    padding: 0.55rem 0.6rem;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border, #3c3c3c) 80%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 96%, var(--vscode-foreground) 4%);
    margin-top: 6px;
  }
  .workflow-graph-panel__node:first-child {
    margin-top: 0.45rem;
  }

  .workflow-graph-panel__node--active {
    border-color: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 55%, var(--vscode-panel-border));
    background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 10%, var(--vscode-editor-background));
    border-left: 3px solid var(--vscode-focusBorder, #3794ff);
    padding-left: 0.55rem;
  }

  .workflow-graph-panel__node-identity {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .workflow-graph-panel__node-icon {
    font-size: 14px;
    flex-shrink: 0;
    opacity: 0.9;
  }
  .workflow-graph-panel__node.task-status--success .workflow-graph-panel__node-icon {
    color: var(--vscode-testing-iconPassed, #73c991);
  }
  .workflow-graph-panel__node.task-status--danger .workflow-graph-panel__node-icon {
    color: var(--vscode-errorForeground, #f14c4c);
  }
  .workflow-graph-panel__node.task-status--attention .workflow-graph-panel__node-icon {
    color: var(--vscode-charts-yellow, #cca700);
  }
  .workflow-graph-panel__node.task-status--info .workflow-graph-panel__node-icon {
    color: var(--vscode-charts-blue, #3794ff);
  }

  .workflow-graph-panel__plain-list li {
    padding: 0.4rem 0.5rem;
    border: 1px solid transparent;
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
    margin-top: 4px;
  }
  .workflow-graph-panel__plain-list li:first-child {
    margin-top: 0.45rem;
  }

  .workflow-graph-panel__active {
    color: var(--vscode-focusBorder, #3794ff);
    font-weight: 700;
    font-size: 11px;
    margin-top: 0.3rem;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .workflow-graph-panel__provenance {
    color: var(--vscode-descriptionForeground, #9ca3af);
    font-size: 11px;
    margin-top: 0.25rem;
    font-style: italic;
  }

  .workflow-graph-panel__degraded {
    color: var(--vscode-editorWarning-foreground, #cca700);
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent);
    font-size: 11px;
    line-height: 1.4;
  }
  .workflow-graph-panel__degraded strong {
    color: inherit;
  }

  .workflow-graph-panel__degraded ul {
    list-style: disc;
    padding-left: 1.2rem;
    color: var(--vscode-foreground, #cccccc);
  }

  .workflow-graph-panel__status {
    color: var(--vscode-descriptionForeground, #9ca3af);
    white-space: nowrap;
    font-size: 11px;
  }
</style>
