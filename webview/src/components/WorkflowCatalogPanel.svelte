<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    WorkflowCatalogWire,
    WorkflowCatalogWirePackageKind,
  } from '../../../src/shared/workflow-catalog-wire';

  interface Props {
    catalog: WorkflowCatalogWire | null;
    loading: boolean;
    error: string | null;
    onClose: () => void;
    onReload: () => void;
    onRetry: () => void;
  }

  type CatalogViewState = 'loading' | 'populated' | 'empty' | 'diagnostics-only' | 'error';

  let { catalog, loading, error, onClose, onReload, onRetry }: Props = $props();

  // The host already orders entries by name bytes, scope, then entry file.
  // Filtering only partitions that stable order into the two visible scope groups.
  const workspaceEntries = $derived(
    catalog?.workflows.filter((workflow) => workflow.scope === 'workspace') ?? [],
  );
  const globalEntries = $derived(
    catalog?.workflows.filter((workflow) => workflow.scope === 'global') ?? [],
  );
  const diagnostics = $derived(catalog?.diagnostics ?? []);
  const showGuidance = $derived(catalog !== null && catalog.workflows.length === 0);
  const viewState: CatalogViewState = $derived.by(() => {
    if (error !== null) return 'error';
    if (catalog === null) return 'loading';
    if (catalog.workflows.length > 0) return 'populated';
    if (catalog.diagnostics.length > 0) return 'diagnostics-only';
    return 'empty';
  });

  function packageKindIcon(packageKind: WorkflowCatalogWirePackageKind): string {
    return packageKind === 'bundle' ? 'codicon-folder' : 'codicon-file-text';
  }

  /** '(scope)' and '(catalog)' are reserved host labels, not file basenames. */
  function isScopeNotice(file: string): boolean {
    return file === '(scope)' || file === '(catalog)';
  }

  function scopeNoticeLabel(file: string): string {
    return file === '(catalog)' ? 'Catalog notice' : 'Scope notice';
  }

  let panelEl: HTMLElement | undefined = $state();
  let previousActiveElement: HTMLElement | null = null;

  onMount(() => {
    previousActiveElement = document.activeElement as HTMLElement | null;
    panelEl?.focus();

    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previousActiveElement?.focus();
    };
  });
</script>

{#snippet catalogSnapshot()}
  {#if loading && error === null}
    <div
      class="workflow-catalog__status"
      data-testid="workflow-catalog-refreshing"
      role="status"
    >
      <span class="codicon codicon-loading workflow-catalog__spinner" aria-hidden="true"></span>
      <span>Refreshing workflows…</span>
    </div>
  {/if}

  {#if workspaceEntries.length > 0}
    <section
      class="workflow-catalog__group-section"
      data-testid="workflow-catalog-group-workspace"
      aria-labelledby="workflow-catalog-workspace-heading"
    >
      <h3 id="workflow-catalog-workspace-heading" class="workflow-catalog__group-heading">
        <span>Workspace</span>
        <span class="workflow-catalog__count" aria-hidden="true">{workspaceEntries.length}</span>
      </h3>
      <ul
        class="workflow-catalog__list"
        aria-labelledby="workflow-catalog-workspace-heading"
      >
        {#each workspaceEntries as entry (entry.workflowRef)}
          <li class="workflow-catalog__row" data-testid="workflow-catalog-row">
            <div class="workflow-catalog__row-primary">
              <span class="workflow-catalog__name">{entry.name}</span>
              <span class="workflow-catalog__kind" data-testid="workflow-catalog-kind">
                <span class="codicon {packageKindIcon(entry.packageKind)}" aria-hidden="true"></span>
                {entry.packageKind}
              </span>
            </div>
            {#if entry.description}
              <p class="workflow-catalog__description">{entry.description}</p>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if globalEntries.length > 0}
    <section
      class="workflow-catalog__group-section"
      data-testid="workflow-catalog-group-global"
      aria-labelledby="workflow-catalog-global-heading"
    >
      <h3 id="workflow-catalog-global-heading" class="workflow-catalog__group-heading">
        <span>User</span>
        <span class="workflow-catalog__count" aria-hidden="true">{globalEntries.length}</span>
      </h3>
      <ul
        class="workflow-catalog__list"
        aria-labelledby="workflow-catalog-global-heading"
      >
        {#each globalEntries as entry (entry.workflowRef)}
          <li class="workflow-catalog__row" data-testid="workflow-catalog-row">
            <div class="workflow-catalog__row-primary">
              <span class="workflow-catalog__name">{entry.name}</span>
              <span class="workflow-catalog__kind" data-testid="workflow-catalog-kind">
                <span class="codicon {packageKindIcon(entry.packageKind)}" aria-hidden="true"></span>
                {entry.packageKind}
              </span>
            </div>
            {#if entry.description}
              <p class="workflow-catalog__description">{entry.description}</p>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if showGuidance}
    <div class="workflow-catalog__empty" data-testid="workflow-catalog-empty">
      <span class="codicon codicon-library workflow-catalog__empty-icon" aria-hidden="true"></span>
      <div>
        <p class="workflow-catalog__empty-title">No workflows found</p>
        <p class="workflow-catalog__empty-detail">
          Add a Markdown file or a package directory under
          <code>.muster/workflows/</code> in this workspace, or in your home directory for all
          workspaces.
        </p>
      </div>
    </div>
  {/if}

  {#if diagnostics.length > 0}
    <section
      class="workflow-catalog__diagnostics"
      data-testid="workflow-catalog-diagnostics"
      role="status"
      aria-labelledby="workflow-catalog-diagnostics-heading"
    >
      <h3 id="workflow-catalog-diagnostics-heading" class="workflow-catalog__group-heading">
        <span>Diagnostics</span>
        <span class="workflow-catalog__count" aria-hidden="true">{diagnostics.length}</span>
      </h3>
      <ul
        class="workflow-catalog__list workflow-catalog__diagnostic-list"
        aria-labelledby="workflow-catalog-diagnostics-heading"
      >
        {#each diagnostics as diagnostic, index (`${diagnostic.file}:${diagnostic.code}:${index}`)}
          {@const scopeNotice = isScopeNotice(diagnostic.file)}
          <li
            class="workflow-catalog__diagnostic"
            class:workflow-catalog__diagnostic--scope={scopeNotice}
            data-testid="workflow-catalog-diagnostic"
          >
            <div class="workflow-catalog__diagnostic-primary">
              <span
                class="codicon {scopeNotice ? 'codicon-info' : 'codicon-warning'} workflow-catalog__diagnostic-icon"
                aria-hidden="true"
              ></span>
              {#if scopeNotice}
                <span class="sr-only">{scopeNoticeLabel(diagnostic.file)}: </span>
              {/if}
              <span class="workflow-catalog__diagnostic-file">{diagnostic.file}</span>
              <code class="workflow-catalog__code">{diagnostic.code}</code>
            </div>
            {#if diagnostic.message}
              <p class="workflow-catalog__diagnostic-message">{diagnostic.message}</p>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

<section
  class="workflow-catalog"
  data-testid="workflow-catalog-panel"
  data-state={viewState}
  bind:this={panelEl}
  tabindex="-1"
  aria-label="Workflows"
  aria-busy={loading}
>
  <header class="workflow-catalog__header">
    <h2 class="workflow-catalog__title">Workflows</h2>
    <div class="workflow-catalog__actions">
      <button
        type="button"
        class="icon-btn"
        data-testid="workflow-catalog-reload"
        onclick={onReload}
        disabled={loading}
        aria-label="Reload workflows"
        title="Reload workflows"
      >
        <span class="codicon codicon-refresh" aria-hidden="true"></span>
      </button>
      <button
        type="button"
        class="icon-btn"
        data-testid="workflow-catalog-close"
        onclick={onClose}
        aria-label="Close workflows"
        title="Close workflows (Esc)"
      >
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </div>
  </header>

  {#if viewState === 'loading'}
    <div class="workflow-catalog__status" data-testid="workflow-catalog-loading" role="status">
      <span class="codicon codicon-loading workflow-catalog__spinner" aria-hidden="true"></span>
      <span>{loading ? 'Reading workflow catalog…' : 'Waiting for workflow catalog…'}</span>
    </div>
  {:else if viewState === 'error'}
    <div class="workflow-catalog__error" data-testid="workflow-catalog-error" role="alert">
      <span class="codicon codicon-error workflow-catalog__error-icon" aria-hidden="true"></span>
      <div class="workflow-catalog__error-copy">
        <p class="workflow-catalog__error-title">Could not read the workflow catalog</p>
        <p class="workflow-catalog__error-detail">
          {catalog === null
            ? 'Try the request again.'
            : 'The last loaded catalog remains visible below.'}
        </p>
      </div>
      <button
        type="button"
        class="workflow-catalog__retry"
        data-testid="workflow-catalog-retry"
        onclick={onRetry}
        disabled={loading}
      >
        Retry
      </button>
    </div>
    {#if catalog !== null}
      {@render catalogSnapshot()}
    {/if}
  {:else if viewState === 'populated'}
    {@render catalogSnapshot()}
  {:else if viewState === 'diagnostics-only'}
    {@render catalogSnapshot()}
  {:else}
    {@render catalogSnapshot()}
  {/if}
</section>

<style>
  .workflow-catalog {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 12px;
    overflow: auto;
    padding: 8px 12px 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }

  .workflow-catalog:focus {
    outline: none;
  }

  .workflow-catalog__header,
  .workflow-catalog__actions,
  .workflow-catalog__row-primary,
  .workflow-catalog__kind,
  .workflow-catalog__status,
  .workflow-catalog__diagnostic-primary {
    display: flex;
    align-items: center;
  }

  .workflow-catalog__header {
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .workflow-catalog__title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    line-height: 20px;
  }

  .workflow-catalog__actions {
    flex: none;
    gap: 4px;
  }

  .workflow-catalog__status {
    gap: 8px;
    min-height: 28px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .workflow-catalog__spinner {
    animation: workflow-catalog-spin 800ms linear infinite;
  }

  .workflow-catalog__group-section,
  .workflow-catalog__diagnostics {
    min-width: 0;
  }

  .workflow-catalog__group-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    line-height: 16px;
    text-transform: uppercase;
  }

  .workflow-catalog__count {
    display: inline-flex;
    min-width: 16px;
    min-height: 16px;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: 0 4px;
    border-radius: 8px;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    font-size: 10px;
    letter-spacing: normal;
    line-height: 16px;
  }

  .workflow-catalog__list {
    margin: 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--vscode-panel-border);
  }

  .workflow-catalog__row,
  .workflow-catalog__diagnostic {
    min-width: 0;
    padding: 8px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .workflow-catalog__row-primary,
  .workflow-catalog__diagnostic-primary {
    min-width: 0;
    flex-wrap: wrap;
    gap: 4px 8px;
  }

  .workflow-catalog__name,
  .workflow-catalog__diagnostic-file {
    min-width: 0;
    overflow-wrap: anywhere;
    font-weight: 600;
  }

  .workflow-catalog__kind {
    flex: none;
    gap: 4px;
    padding: 0 4px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    font-size: 10px;
    line-height: 16px;
  }

  .workflow-catalog__kind .codicon {
    font-size: 12px;
  }

  .workflow-catalog__description,
  .workflow-catalog__diagnostic-message {
    margin: 4px 0 0;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    line-height: 16px;
    overflow-wrap: anywhere;
  }

  .workflow-catalog__empty {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 12px;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-background);
  }

  .workflow-catalog__empty-icon {
    flex: none;
    color: var(--vscode-foreground);
  }

  .workflow-catalog__empty-title,
  .workflow-catalog__empty-detail,
  .workflow-catalog__error-title,
  .workflow-catalog__error-detail {
    margin: 0;
  }

  .workflow-catalog__empty-title,
  .workflow-catalog__error-title {
    color: var(--vscode-foreground);
    font-weight: 600;
  }

  .workflow-catalog__empty-detail,
  .workflow-catalog__error-detail {
    margin-top: 4px;
    font-size: 12px;
    line-height: 16px;
  }

  .workflow-catalog__empty code,
  .workflow-catalog__code {
    font-family: var(--vscode-editor-font-family);
  }

  .workflow-catalog__empty code {
    padding: 0 4px;
    color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
  }

  .workflow-catalog__diagnostics {
    padding-top: 4px;
  }

  .workflow-catalog__diagnostic {
    padding-left: 8px;
    border-left: 2px solid var(--vscode-editorWarning-foreground);
  }

  .workflow-catalog__diagnostic--scope {
    border-left-color: var(--vscode-notificationsInfoIcon-foreground);
  }

  .workflow-catalog__diagnostic-icon {
    flex: none;
    color: var(--vscode-editorWarning-foreground);
  }

  .workflow-catalog__diagnostic--scope .workflow-catalog__diagnostic-icon {
    color: var(--vscode-notificationsInfoIcon-foreground);
  }

  .workflow-catalog__code {
    min-width: 0;
    overflow-wrap: anywhere;
    padding: 0 4px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    font-size: 10px;
    line-height: 16px;
  }

  .workflow-catalog__error {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 8px;
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    border-radius: 4px;
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground);
  }

  .workflow-catalog__error-icon {
    color: var(--vscode-errorForeground);
  }

  .workflow-catalog__error-copy {
    min-width: 0;
  }

  .workflow-catalog__retry {
    min-height: 28px;
    box-sizing: border-box;
    padding: 4px 12px;
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder));
    border-radius: 2px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    font: inherit;
    cursor: pointer;
  }

  .workflow-catalog__retry:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  .workflow-catalog__retry:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .workflow-catalog__retry:disabled {
    cursor: default;
    opacity: 0.5;
  }

  @keyframes workflow-catalog-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .workflow-catalog__spinner {
      animation: none;
    }
  }
</style>
