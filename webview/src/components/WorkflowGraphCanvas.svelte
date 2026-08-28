<script lang="ts">
  import type { WorkflowGraphWireGraph } from '../../../src/shared/workflow-graph-wire';
  import { buildWorkflowGraphPanelView, workflowGraphNodeTone } from '../lib/workflow-graph-view';
  import { computeWorkflowGraphLayout, LAYOUT_NODE_H, LAYOUT_NODE_W } from '../lib/workflow-graph-layout';

  interface Props {
    graph: WorkflowGraphWireGraph;
    scale?: number;
    translate?: { x: number; y: number };
  }

  let { graph, scale = 1, translate = { x: 0, y: 0 } }: Props = $props();

  const view = $derived(buildWorkflowGraphPanelView(graph));
  const layout = $derived(computeWorkflowGraphLayout(graph));
  const nodeById = $derived(new Map(view.nodes.map((n) => [n.id, n] as const)));

  function nodeIcon(status: string, active: boolean): string {
    if (active) return 'codicon-loading';
    if (status === 'completed' || status === 'reused') return 'codicon-pass-filled';
    if (status === 'failed') return 'codicon-error';
    if (status === 'cancelled') return 'codicon-circle-slash';
    if (status === 'skipped') return 'codicon-debug-step-over';
    if (status === 'queued' || status === 'waiting') return 'codicon-clock';
    if (status === 'blocked') return 'codicon-warning';
    if (status === 'executing') return 'codicon-loading';
    return 'codicon-circle-large-outline';
  }

  function edgeStroke(state: WorkflowGraphWireGraph['edges'][number]['contributionState']): string {
    if (state === 'supplied_reused') return 'var(--vscode-charts-blue, #3794ff)';
    if (state === 'supplied_live') return 'var(--vscode-testing-iconPassed, #73c991)';
    if (state === 'blocking') return 'var(--vscode-editorWarning-foreground, #cca700)';
    return 'var(--vscode-descriptionForeground, #8a8a8a)';
  }
</script>

<div class="workflow-graph-canvas" data-testid="workflow-graph-canvas">
  <svg
    width={layout.width}
    height={layout.height}
    viewBox={`0 0 ${layout.width} ${layout.height}`}
    role="img"
    aria-label="Workflow graph with {view.nodes.length} nodes and {layout.edges.length} edges"
    style={`transform: translate(${translate.x}px, ${translate.y}px) scale(${scale}); transform-origin: 0 0;`}
  >
    <defs>
      <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" opacity="0.7"></path>
      </marker>
      <marker id="wf-arrow-reused" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" opacity="0.85"></path>
      </marker>
    </defs>

    <!-- Edges -->
    {#each layout.edges as edge (edge.from + '->' + edge.to + ':' + edge.inputRef)}
      <path
        d={edge.path}
        fill="none"
        stroke={edgeStroke(edge.contributionState)}
        stroke-width={edge.contributionState === 'blocking' || edge.reused ? 2 : 1.5}
        stroke-dasharray={edge.contributionState === 'pending' || edge.reused ? '6 4' : 'none'}
        opacity={edge.contributionState === 'pending' ? 0.65 : 0.9}
        marker-end={edge.reused ? 'url(#wf-arrow-reused)' : 'url(#wf-arrow)'}
        data-edge-from={edge.from}
        data-edge-to={edge.to}
        data-input-ref={edge.inputRef}
        data-input-state={edge.contributionState}
      />
      <title>{edge.inputRef} — {edge.contributionState.replace('_', ' ')}</title>
    {/each}

    <!-- Nodes -->
    {#each layout.nodes as pos (pos.id)}
      {@const n = nodeById.get(pos.id)}
      {#if n}
        {@const tone = `task-status--${workflowGraphNodeTone(n.status)}`}
        <g
          transform={`translate(${pos.x}, ${pos.y})`}
          data-node-id={n.id}
          data-node-status={n.status}
          class="workflow-graph-canvas__node {tone}"
          aria-label={`${n.id} ${n.statusLabel}${n.active ? ' active' : ''}${n.reused ? ' reused' : ''}`}
        >
          <rect
            x="0"
            y="0"
            width={LAYOUT_NODE_W}
            height={LAYOUT_NODE_H}
            rx="6"
            ry="6"
            class="workflow-graph-canvas__node-rect {tone}"
            fill={n.active ? 'color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 14%, var(--vscode-editor-background, #1e1e1e))' : 'var(--vscode-editor-background, #252526)'}
            stroke={n.active ? 'var(--vscode-focusBorder, #3794ff)' : 'var(--vscode-panel-border, #3c3c3c)'}
            stroke-width={n.active ? 2 : 1}
          />
          {#if n.active}
            <rect x="0" y="0" width="3" height={LAYOUT_NODE_H} rx="1.5" fill="var(--vscode-focusBorder, #3794ff)" />
          {/if}
          <!-- Icon -->
          <text x="10" y="20" font-size="14" class="workflow-graph-canvas__node-icon" aria-hidden="true">{n.active ? '⟳' : n.status === 'completed' || n.status === 'reused' ? '✓' : n.status === 'failed' ? '✕' : n.status === 'cancelled' ? '⊘' : '○'}</text>
          <text x="28" y="18" font-size="11" font-weight="700" fill="var(--vscode-foreground, #cccccc)" class="workflow-graph-canvas__node-id">{n.id.length > 14 ? n.id.slice(0, 12) + '…' : n.id}</text>
          <text x="28" y="32" font-size="10" fill="var(--vscode-descriptionForeground, #9ca3af)">{n.statusLabel}</text>
          {#if n.reused}
            <text x="28" y="40" font-size="8" font-style="italic" fill="var(--vscode-charts-blue, #3794ff)">reused</text>
          {/if}
          {#if n.active}
            <text x={LAYOUT_NODE_W - 34} y="16" font-size="8" font-weight="700" fill="var(--vscode-focusBorder, #3794ff)">ACTIVE</text>
          {/if}
          <!-- Use foreignObject for codicon if needed, but text fallback keeps it simple for test -->
          <title>{n.id} — {n.statusLabel}{n.reasonLabel ? ` · ${n.reasonLabel}` : ''}{n.reused ? ' · Supplied from a prior result' : ''}{n.active ? ' · Active node' : ''}</title>
        </g>
      {/if}
    {/each}
  </svg>
</div>

<style>
  .workflow-graph-canvas {
    display: inline-block;
    background: var(--vscode-editor-background, #1e1e1e);
    border-radius: 6px;
  }
  .workflow-graph-canvas__node {
    cursor: default;
  }
  .workflow-graph-canvas__node-rect.task-status--success {
    stroke: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 45%, var(--vscode-panel-border));
  }
  .workflow-graph-canvas__node-rect.task-status--danger {
    stroke: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 45%, var(--vscode-panel-border));
  }
  .workflow-graph-canvas__node-rect.task-status--attention {
    stroke: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 45%, var(--vscode-panel-border));
  }
  .workflow-graph-canvas__node-rect.task-status--warning {
    stroke: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 60%, var(--vscode-panel-border));
  }
  .workflow-graph-canvas__node-rect.task-status--info {
    stroke: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 45%, var(--vscode-panel-border));
  }
</style>
