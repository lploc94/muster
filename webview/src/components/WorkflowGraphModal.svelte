<script lang="ts">
  import { onMount } from 'svelte';
  import type { WorkflowGraphWireGraph } from '../../../src/shared/workflow-graph-wire';
  import WorkflowGraphCanvas from './WorkflowGraphCanvas.svelte';
  import { buildWorkflowGraphPanelView } from '../lib/workflow-graph-view';
  import type { WorkflowGraphRequest } from '../lib/workflow-graph-store.svelte';
  interface Props { graph: WorkflowGraphWireGraph | null; request?: WorkflowGraphRequest | null; error?: string | null; onClose: () => void; onRetry?: () => void; }
  let { graph, request = null, error = null, onClose, onRetry }: Props = $props();
  const view = $derived(graph ? buildWorkflowGraphPanelView(graph) : null);
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let isPanning = $state(false);
  let panStart = $state({ x: 0, y: 0 });
  let panOrigin = $state({ x: 0, y: 0 });
  let canvasContainer: HTMLDivElement | undefined = $state();
  function zoomIn() { scale = Math.min(2.5, +(scale + 0.15).toFixed(2)); }
  function zoomOut() { scale = Math.max(0.4, +(scale - 0.15).toFixed(2)); }
  function resetView() { scale = 1; tx = 0; ty = 0; }
  function fitView() { scale = 1; tx = 0; ty = 0; }
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea, [role="button"]')) return;
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    panOrigin = { x: tx, y: ty };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) { if (!isPanning) return; tx = panOrigin.x + (e.clientX - panStart.x); ty = panOrigin.y + (e.clientY - panStart.y); }
  function onPointerUp(e: PointerEvent) { isPanning = false; try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {} }
  function onWheel(e: WheelEvent) { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const delta = e.deltaY > 0 ? -0.08 : 0.08; scale = Math.min(2.5, Math.max(0.4, +(scale + delta).toFixed(2))); }
  let modalEl: HTMLDivElement | undefined = $state();
  let prevActiveEl: HTMLElement | null = null;
  onMount(() => {
    prevActiveEl = document.activeElement as HTMLElement | null;
    modalEl?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
      if (e.key === '-') { e.preventDefault(); zoomOut(); }
      if (e.key === '0') { e.preventDefault(); resetView(); }
    }
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prevActiveEl?.focus();
    };
  });
</script>

<div class="workflow-modal-backdrop" data-testid="workflow-graph-modal-backdrop" onclick={onClose} aria-hidden="true"></div>
<div
  bind:this={modalEl}
  class="workflow-modal"
  role="dialog"
  aria-modal="true"
  aria-label={graph ? `Workflow graph for run ${graph.runId}` : 'Workflow graph'}
  data-testid="workflow-graph-modal"
  tabindex="-1"
>
  <header class="workflow-modal__header">
    <div class="workflow-modal__head">
      <div class="workflow-modal__eyebrow">Workflow</div>
      <div class="workflow-modal__title" title={graph?.runId ?? 'Loading…'}>
        {#if graph}
          Run {view?.runId}
        {:else if request}
          Loading workflow…
        {:else}
          Workflow graph
        {/if}
      </div>
      {#if view}
        <div class="workflow-modal__reuse">{view.reuseSummary.label}</div>
      {/if}
    </div>
    <div class="workflow-modal__actions">
      <div class="workflow-modal__zoom" role="group" aria-label="Zoom controls">
        <button type="button" class="icon-btn" aria-label="Zoom out" onclick={zoomOut} title="Zoom out (-)"> <span class="codicon codicon-zoom-out"></span> </button>
        <span class="workflow-modal__scale" aria-live="polite">{Math.round(scale*100)}%</span>
        <button type="button" class="icon-btn" aria-label="Zoom in" onclick={zoomIn} title="Zoom in (+)"> <span class="codicon codicon-zoom-in"></span> </button>
        <button type="button" class="icon-btn" aria-label="Reset view" onclick={resetView} title="Reset (0)"> <span class="codicon codicon-discard"></span> </button>
        <button type="button" class="icon-btn" aria-label="Fit view" onclick={fitView} title="Fit"> <span class="codicon codicon-screen-full"></span> </button>
      </div>
      <button type="button" class="icon-btn" aria-label="Close workflow graph" onclick={onClose} title="Close (Esc)">
        <span class="codicon codicon-close"></span>
      </button>
    </div>
  </header>

  {#if view?.degradedRead.visible}
    <div class="workflow-modal__degraded" role="status">
      <strong>{view.degradedRead.label}</strong>
      <ul>
        {#each view.degradedRead.diagnostics as d (d)}<li>{d}</li>{/each}
      </ul>
    </div>
  {/if}

  <div
    class="workflow-modal__canvas-wrap"
    bind:this={canvasContainer}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onwheel={onWheel}
    data-testid="workflow-graph-canvas-wrap"
    style:cursor={isPanning ? 'grabbing' : 'grab'}
  >
    {#if graph}
      <WorkflowGraphCanvas {graph} {scale} translate={{ x: tx, y: ty }} />
    {:else if request}
      <div class="workflow-modal__loading">
        <span class="codicon codicon-loading workflow-modal__spin" aria-hidden="true"></span>
        <span>Loading workflow graph…</span>
      </div>
    {:else if error}
      <div class="workflow-modal__empty" data-testid="workflow-graph-error">
        <span class="codicon codicon-warning" aria-hidden="true"></span>
        <span>
          {#if error === 'notInWorkflow'}
            This task is not part of a workflow run.
          {:else if error === 'invalidRequest'}
            Workflow request was stale — please retry.
          {:else}
            Workflow graph unavailable. Please retry.
          {/if}
        </span>
        {#if onRetry}
          <button type="button" class="workflow-modal__retry" onclick={onRetry} data-testid="workflow-graph-retry">Retry</button>
        {/if}
      </div>
    {:else}
      <div class="workflow-modal__empty">
        <span class="codicon codicon-info" aria-hidden="true"></span>
        <span>No workflow graph available for this task. It may not be part of a workflow.</span>
      </div>
    {/if}
  </div>

  {#if view}
    <div class="workflow-modal__details">
      <div class="workflow-modal__section">
        <div class="workflow-modal__section-title">Nodes — {view.nodes.length}</div>
        <div class="workflow-modal__node-legend">
          {#each view.nodes as n (n.id)}
            <span class="workflow-modal__legend-item {n.active ? 'is-active' : ''}" data-node-id={n.id} title={`${n.id} — ${n.statusLabel}${n.reused ? ' · reused' : ''}`}>
              <span class="codicon {n.active ? 'codicon-loading' : n.status === 'succeeded' || n.status==='reused' ? 'codicon-pass-filled' : n.status==='failed' ? 'codicon-error' : 'codicon-circle-large-outline'}" aria-hidden="true"></span>
              {n.id}
              <span class="workflow-modal__badge">{n.statusLabel}</span>
              {#if n.reused}<span class="workflow-modal__reused">reused</span>{/if}
              {#if n.active}<span class="workflow-modal__active">active</span>{/if}
            </span>
          {/each}
        </div>
      </div>

      {#if view.activeGate}
        <div class="workflow-modal__section" data-gate-id={view.activeGate.id}>
          <div class="workflow-modal__section-title">Active gate — {view.activeGate.id}</div>
          <div class="workflow-modal__summary-line">
            <span>{view.activeGate.statusLabel}</span>
            <span>{view.activeGate.progressLabel}</span>
          </div>
        </div>
      {/if}

      {#if view.feedbackRounds.length > 0}
        <div class="workflow-modal__section">
          <div class="workflow-modal__section-title">Feedback rounds</div>
          <ul class="workflow-modal__plain-list">
            {#each view.feedbackRounds as r (r.id)}
              <li><span>{r.statusLabel} from {r.requesterNodeId}</span> <span>{r.progressLabel}</span></li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if view.childRuns.length > 0}
        <div class="workflow-modal__section">
          <div class="workflow-modal__section-title">Child runs</div>
          <ul class="workflow-modal__plain-list">
            {#each view.childRuns as c (c.id)}
              <li data-child-run-id={c.id}><span>{c.id}</span> <span>{c.statusLabel}</span></li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/if}

  <footer class="workflow-modal__footer">
    <span>Drag to pan · Ctrl/⌘+wheel to zoom · +/− to zoom · 0 to reset · Esc to close</span>
  </footer>
</div>

<style>
  .workflow-modal-backdrop {
    position: fixed; inset: 0;
    background: color-mix(in srgb, #000 46%, transparent);
    z-index: 60;
  }
  .workflow-modal {
    position: fixed;
    inset: 4% 4% 6% 4%;
    z-index: 61;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 8px;
    box-shadow: 0 16px 40px color-mix(in srgb, #000 38%, transparent);
    overflow: hidden;
    min-height: 320px;
    outline: none;
  }
  @media (max-width: 720px) {
    .workflow-modal { inset: 2% 2% 2% 2%; }
  }
  .workflow-modal__header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 96%, var(--vscode-foreground) 4%);
  }
  .workflow-modal__head { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .workflow-modal__eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #9ca3af); }
  .workflow-modal__title { font-size: 13px; font-weight: 700; color: var(--vscode-foreground, #cccccc); overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, ui-monospace, monospace); }
  .workflow-modal__reuse { font-size: 11px; color: var(--vscode-descriptionForeground, #9ca3af); background: color-mix(in srgb, var(--vscode-badge-background, #616061) 28%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent); padding: 1px 6px; border-radius: 999px; display: inline-block; width: fit-content; margin-top: 2px; }
  .workflow-modal__actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .workflow-modal__zoom { display: flex; align-items: center; gap: 4px; padding: 2px 6px; border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 6px; background: var(--vscode-editor-background, #1e1e1e); }
  .workflow-modal__scale { font-size: 11px; min-width: 36px; text-align: center; color: var(--vscode-descriptionForeground, #9ca3af); }
  .workflow-modal__degraded { padding: 8px 12px; background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent); color: var(--vscode-editorWarning-foreground, #cca700); font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
  .workflow-modal__degraded ul { margin: 6px 0 0 1.2rem; color: var(--vscode-foreground, #cccccc); }
  .workflow-modal__canvas-wrap {
    flex: 1 1 auto;
    overflow: auto;
    background: var(--vscode-editor-background, #1e1e1e);
    position: relative;
    min-height: 240px;
    overscroll-behavior: contain;
  }
  .workflow-modal__loading, .workflow-modal__empty {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    height: 200px; color: var(--vscode-descriptionForeground, #9ca3af); font-size: 12px; padding: 20px; text-align: center;
  }
  .workflow-modal__spin { animation: task-tree-spin 0.8s linear infinite; }
  @media (prefers-reduced-motion: reduce) { .workflow-modal__spin { animation: none; } }
  .workflow-modal__details {
    border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
    max-height: 30%;
    overflow: auto;
    padding: 8px 12px;
    display: flex; flex-direction: column; gap: 10px;
    background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 96%, var(--vscode-foreground) 4%);
  }
  .workflow-modal__section-title { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #9ca3af); }
  .workflow-modal__node-legend { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .workflow-modal__legend-item { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 999px; font-size: 11px; background: var(--vscode-editor-background, #252526); }
  .workflow-modal__legend-item.is-active { border-color: var(--vscode-focusBorder, #3794ff); background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 10%, var(--vscode-editor-background)); }
  .workflow-modal__badge { padding: 1px 6px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 28%, transparent); background: color-mix(in srgb, currentColor 12%, transparent); font-size: 10px; }
  .workflow-modal__reused { font-size: 10px; font-style: italic; color: var(--vscode-charts-blue, #3794ff); }
  .workflow-modal__active { font-size: 10px; font-weight: 700; color: var(--vscode-focusBorder, #3794ff); }
  .workflow-modal__summary-line, .workflow-modal__plain-list li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 11px; }
  .workflow-modal__plain-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .workflow-modal__plain-list li { padding: 4px 6px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); }
  .workflow-modal__retry { margin-left: 8px; padding: 2px 10px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer; }
  .workflow-modal__retry:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .workflow-modal__footer { padding: 6px 12px; border-top: 1px solid var(--vscode-panel-border, #3c3c3c); font-size: 10px; color: var(--vscode-descriptionForeground, #9ca3af); text-align: center; }
</style>
