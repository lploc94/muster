<script lang="ts">
  import type { ToolItem } from '../lib/turn-state.svelte';
  import {
    buildToolDiffView,
    describeDiffFileForScreenReader,
    type ToolDiffView,
  } from '../lib/tool-diff-view';

  interface Props {
    tool: ToolItem;
  }
  let { tool }: Props = $props();

  /**
   * User toggle for params/result. null = default:
   * mixed diff + payload tools start expanded; payload-only tools start collapsed.
   */
  let expandedOverride = $state<boolean | null>(null);

  /**
   * Per-file body open overrides, keyed by bodyId from buildToolDiffView.
   * Only consulted when the view is size-gated collapsed-by-default; small
   * diffs always render bodies open so S01/S02 fixtures stay interaction-free.
   */
  let fileBodyExpanded = $state<Record<string, boolean>>({});

  function toolIcon(name: string, kind?: string): string {
    const n = (name || '').toLowerCase();
    if (n.includes('read') || n.includes('file') || n.includes('cat')) return 'codicon-file';
    if (n.includes('write') || n.includes('edit') || n.includes('patch')) return 'codicon-edit';
    if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'codicon-search';
    if (n.includes('bash') || n.includes('exec') || n.includes('run') || n.includes('shell'))
      return 'codicon-terminal';
    if (kind === 'mcp') return 'codicon-plug';
    return 'codicon-tools';
  }

  const componentId = $props.id();
  const headerId = `${componentId}-tool-header`;
  const detailsId = `${componentId}-tool-details`;

  const icon = $derived(toolIcon(tool.name, tool.toolKind));
  const resultPayload = $derived(
    tool.status === 'error' && tool.error ? tool.error : tool.output,
  );
  const fileChanges = $derived(
    tool.fileChanges && tool.fileChanges.length > 0 ? tool.fileChanges : undefined,
  );
  /** Present only when the engine hit the file-count bound (never 0 / never empty chrome). */
  const fileChangesOmitted = $derived(
    typeof tool.fileChangesOmitted === 'number' && tool.fileChangesOmitted > 0
      ? tool.fileChangesOmitted
      : undefined,
  );

  /**
   * Pure presentation model (M020 S03). tool.id is encoded into stable,
   * collision-free body/toggle ids; agent paths never participate.
   */
  const diffView: ToolDiffView | undefined = $derived(
    fileChanges || fileChangesOmitted !== undefined
      ? buildToolDiffView({
          toolCallId: tool.id,
          fileChanges: fileChanges ?? [],
          ...(fileChangesOmitted !== undefined ? { fileChangesOmitted } : {}),
        })
      : undefined,
  );

  /** The header discloses only the params/result region; file diffs have per-file controls. */
  const hasDetails = $derived(
    tool.input !== undefined || tool.output !== undefined || !!tool.error,
  );
  /** Mixed evidence tools keep the existing default of showing their params/result. */
  const expanded = $derived(
    expandedOverride !== null ? expandedOverride : fileChanges !== undefined && hasDetails,
  );

  function toggleExpanded() {
    if (!hasDetails) return;
    expandedOverride = !expanded;
  }

  function isFileBodyExpanded(view: ToolDiffView, bodyId: string): boolean {
    // Small diffs: always open — size-gated collapse only, never unconditional.
    if (!view.collapsedByDefault) return true;
    if (Object.prototype.hasOwnProperty.call(fileBodyExpanded, bodyId)) {
      return fileBodyExpanded[bodyId] === true;
    }
    return false;
  }

  function toggleFileBody(view: ToolDiffView, bodyId: string) {
    if (!view.collapsedByDefault) return;
    const next = !isFileBodyExpanded(view, bodyId);
    fileBodyExpanded = { ...fileBodyExpanded, [bodyId]: next };
  }
</script>

<div class="tool-card rounded px-2 py-1 text-xs border" style="border-color: var(--vscode-panel-border);">
  <button
    id={headerId}
    type="button"
    class="flex items-center gap-2 w-full text-left"
    class:cursor-pointer={hasDetails}
    disabled={!hasDetails}
    aria-expanded={hasDetails ? expanded : undefined}
    aria-controls={hasDetails ? detailsId : undefined}
    onclick={toggleExpanded}
  >
    <span class="codicon {icon}"></span>
    {#if tool.toolKind === 'mcp'}<vscode-badge>MCP</vscode-badge>{/if}
    <span class="font-mono break-all flex-1">{tool.name}</span>
    <span style="color: var(--vscode-descriptionForeground); font-size: 10px;">
      {tool.status === 'running' ? 'running…' : tool.status}
    </span>
    {#if hasDetails}
      <span class="codicon {expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}" style="font-size: 12px;"></span>
    {/if}
  </button>

  {#if diffView}
    <div class="tool-card__diff mt-1.5" role="group" aria-label="File changes">
      {#each diffView.files as file (file.bodyId)}
        {@const bodyOpen = isFileBodyExpanded(diffView, file.bodyId)}
        {@const srSummary = describeDiffFileForScreenReader(file)}
        <div class="tool-card__diff-file">
          <div class="tool-card__diff-summary">
            {#if diffView.collapsedByDefault}
              <button
                id={file.toggleId}
                type="button"
                class="tool-card__diff-toggle"
                aria-expanded={bodyOpen}
                aria-controls={file.bodyId}
                aria-label={srSummary}
                onclick={() => toggleFileBody(diffView, file.bodyId)}
              >
                <span
                  class="codicon {bodyOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'} tool-card__diff-chevron"
                  aria-hidden="true"
                ></span>
                <span class="tool-card__diff-path font-mono break-all">{file.path}</span>
                <span class="tool-card__diff-counts" aria-hidden="true">{file.countsLabel}</span>
              </button>
            {:else}
              <div class="tool-card__diff-summary-static" aria-label={srSummary}>
                <span class="tool-card__diff-path font-mono break-all">{file.path}</span>
                <span class="tool-card__diff-counts" aria-hidden="true">{file.countsLabel}</span>
              </div>
            {/if}
          </div>

          <div
            id={file.bodyId}
            class="tool-card__diff-body-panel"
            role={diffView.collapsedByDefault ? 'region' : undefined}
            aria-labelledby={diffView.collapsedByDefault ? file.toggleId : undefined}
            data-collapsed={bodyOpen ? 'false' : 'true'}
            aria-hidden={bodyOpen ? undefined : 'true'}
          >
            <div class="tool-card__diff-body-inner">
              {#if bodyOpen}
                {#if file.comparisonUnavailable}
                  <div class="tool-card__diff-unavailable" role="status">
                    Comparison unavailable — this diff is too complex to compare safely
                  </div>
                {:else}
                  <pre class="tool-card__diff-body text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded max-h-48">
{#each file.lines as line}<span class="tool-card__diff-line tool-card__diff-line--{line.kind}">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}{line.text}
</span>{/each}</pre>
                {/if}
                {#if file.truncated}
                  <div
                    class="tool-card__diff-truncated"
                    role="status"
                    aria-label="Diff truncated"
                  >
                    Diff truncated — full text exceeded the per-side bound
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        </div>
      {/each}
      {#if diffView.fileChangesOmitted !== undefined}
        <div
          class="tool-card__diff-omitted"
          role="status"
          aria-label="File changes omitted"
        >
          {diffView.fileChangesOmitted} additional file{diffView.fileChangesOmitted === 1
            ? ''
            : 's'} omitted
        </div>
      {/if}
    </div>
  {/if}

  {#if hasDetails}
    <div
      id={detailsId}
      class="tool-card__details-region"
      role="region"
      aria-labelledby={headerId}
      aria-hidden={expanded ? undefined : 'true'}
    >
      {#if expanded}
        {#if tool.input !== undefined}
          <div class="tool-card__details mt-1.5">
            <div class="text-[10px] opacity-70 mb-0.5">params:</div>
            <pre class="tool-card__payload text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded max-h-40 whitespace-pre">{typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)}</pre>
          </div>
        {/if}

        {#if resultPayload !== undefined}
          <div class="tool-card__details mt-1.5">
            <div class="text-[10px] opacity-70 mb-0.5">result:</div>
            <pre
              class="tool-card__payload text-[10px] bg-[var(--vscode-textCodeBlock-background)] p-1 rounded max-h-40 whitespace-pre"
              style:color={tool.status === 'error' ? 'var(--vscode-errorForeground)' : undefined}
            >{typeof resultPayload === 'string' ? resultPayload : JSON.stringify(resultPayload, null, 2)}</pre>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-card,
  .tool-card__details,
  .tool-card__diff {
    min-width: 0;
    max-width: 100%;
  }

  .tool-card {
    overflow: hidden;
  }

  .tool-card__payload,
  .tool-card__diff-body {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    margin: 0;
    overflow: auto;
    white-space: pre;
  }

  .tool-card__diff-summary {
    margin-bottom: 0.25rem;
  }

  .tool-card__diff-toggle,
  .tool-card__diff-summary-static {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    width: 100%;
    min-width: 0;
    text-align: left;
  }

  .tool-card__diff-toggle {
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .tool-card__diff-toggle:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
  }

  .tool-card__diff-chevron {
    flex: 0 0 auto;
    font-size: 12px;
    line-height: 1;
    position: relative;
    top: 1px;
  }

  .tool-card__diff-path {
    color: var(--vscode-descriptionForeground);
    flex: 1 1 auto;
    min-width: 0;
  }

  .tool-card__diff-counts {
    flex: 0 0 auto;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }

  /*
   * Size-gated disclosure panel: animate row height under no-preference,
   * force 0s under prefers-reduced-motion so expansion is instant.
   */
  .tool-card__diff-body-panel {
    display: grid;
    grid-template-rows: 1fr;
    transition: grid-template-rows 0.2s ease;
  }

  .tool-card__diff-body-panel[data-collapsed='true'] {
    grid-template-rows: 0fr;
  }

  .tool-card__diff-body-inner {
    min-height: 0;
    overflow: hidden;
  }

  .tool-card__diff-body-panel[data-collapsed='false'] .tool-card__diff-body-inner {
    overflow: visible;
  }

  @media (prefers-reduced-motion: reduce) {
    .tool-card__diff-body-panel {
      transition-duration: 0s;
    }
  }

  .tool-card__diff-line {
    display: block;
  }

  .tool-card__diff-line--removed {
    color: var(--vscode-errorForeground);
    background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
  }

  .tool-card__diff-line--added {
    color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #89d185));
    background: color-mix(
      in srgb,
      var(--vscode-testing-iconPassed, var(--vscode-charts-green, #89d185)) 12%,
      transparent
    );
  }

  /* Honest bound markers (M020 S02) — description tone, not error chrome. */
  .tool-card__diff-truncated,
  .tool-card__diff-omitted {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    margin-top: 0.25rem;
  }

  .tool-card__diff-omitted {
    margin-top: 0.5rem;
  }
</style>
