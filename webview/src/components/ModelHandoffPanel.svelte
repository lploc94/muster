<script lang="ts">
  /**
   * Explicit model/backend switch for an existing task.
   *
   * Changing the model on a live task is always a runtime handoff, never a plain
   * chat turn. The old inline dropdown committed that on a single stray scroll;
   * this panel makes the user pick, read the consequence, then confirm.
   */
  import { onMount, untrack } from 'svelte';

  interface Props {
    options: { value: string; label: string }[];
    /** Committed (or pending) binding, as `backend::model`. */
    currentValue: string;
    /** Empty while the host is still enumerating installed CLIs. */
    loading?: boolean;
    onClose: () => void;
    onCommit: (value: string) => void;
  }

  let { options, currentValue, loading = false, onClose, onCommit }: Props = $props();

  // Baseline is frozen at open. `currentValue` is reactive: if a host snapshot
  // rebinds the task while the panel is up, comparing against the live prop
  // either disarms an armed commit under the cursor, or arms it with `selected`
  // still holding the old binding — committing a handoff the user never picked.
  const baseline = untrack(() => currentValue);
  let selected = $state(baseline);
  const changed = $derived(selected !== baseline);
  const currentLabel = $derived(options.find((o) => o.value === baseline)?.label ?? baseline);

  let panelEl: HTMLDivElement | undefined = $state();
  let prevActiveEl: HTMLElement | null = null;

  onMount(() => {
    prevActiveEl = document.activeElement as HTMLElement | null;
    panelEl?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prevActiveEl?.focus();
    };
  });

  function commit() {
    if (!changed) return;
    onCommit(selected);
  }
</script>

<div
  class="model-panel-backdrop"
  data-testid="model-handoff-backdrop"
  onclick={onClose}
  aria-hidden="true"
></div>
<div
  bind:this={panelEl}
  class="model-panel"
  role="dialog"
  aria-modal="true"
  aria-label="Change model for this task"
  data-testid="model-handoff-panel"
  data-current={currentValue}
  data-selected={selected}
  tabindex="-1"
>
  <header class="model-panel__header">
    <div class="model-panel__head">
      <div class="model-panel__eyebrow">Conversation</div>
      <div class="model-panel__title">Change model</div>
    </div>
    <button type="button" class="icon-btn" aria-label="Close change model" onclick={onClose}>
      <span class="codicon codicon-close"></span>
    </button>
  </header>

  <div class="model-panel__body">
    <p class="model-panel__note" data-testid="model-handoff-note">
      Switching hands this task off to another runtime. The transcript stays; the agent restarts on
      the new model.
    </p>
    <p class="model-panel__current">
      Currently on <strong data-testid="model-handoff-current">{currentLabel}</strong>
    </p>

    {#if loading && options.length === 0}
      <div class="model-panel__empty" role="status" data-testid="model-handoff-loading">
        Loading models from installed CLIs…
      </div>
    {:else if options.length === 0}
      <div class="model-panel__empty" role="status" data-testid="model-handoff-empty">
        No selectable models yet. Install or configure an agent CLI first.
      </div>
    {:else}
      <ul class="model-panel__list" role="radiogroup" aria-label="Available models">
        {#each options as option (option.value)}
          <li>
            <button
              type="button"
              class="model-panel__option"
              class:model-panel__option--selected={option.value === selected}
              role="radio"
              aria-checked={option.value === selected ? 'true' : 'false'}
              data-testid="model-handoff-option"
              data-value={option.value}
              onclick={() => (selected = option.value)}
            >
              <span class="model-panel__option-label">{option.label}</span>
              {#if option.value === currentValue}
                <span class="model-panel__badge">Current</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <footer class="model-panel__footer">
    <button type="button" class="model-panel__secondary" onclick={onClose}>Cancel</button>
    <button
      type="button"
      class="model-panel__primary"
      data-testid="model-handoff-commit"
      disabled={!changed}
      onclick={commit}
    >
      Switch model
    </button>
  </footer>
</div>

<style>
  .model-panel-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #000 46%, transparent);
    z-index: 60;
  }
  .model-panel {
    position: fixed;
    inset: 8% 6% auto 6%;
    max-height: 84%;
    z-index: 61;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 8px;
    box-shadow: 0 16px 40px color-mix(in srgb, #000 38%, transparent);
    overflow: hidden;
    outline: none;
  }
  .model-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    background: color-mix(
      in srgb,
      var(--vscode-sideBar-background, var(--vscode-editor-background)) 96%,
      var(--vscode-foreground) 4%
    );
  }
  .model-panel__head {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .model-panel__eyebrow {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground, #9ca3af);
  }
  .model-panel__title {
    font-size: 13px;
    font-weight: 700;
    color: var(--vscode-foreground, #cccccc);
  }
  .model-panel__body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 10px 12px;
  }
  .model-panel__note {
    margin: 0 0 6px;
    font-size: 11px;
    color: var(--vscode-editorWarning-foreground, #cca700);
  }
  .model-panel__current {
    margin: 0 0 10px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #9ca3af);
  }
  .model-panel__empty {
    padding: 16px 8px;
    text-align: center;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #9ca3af);
  }
  .model-panel__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .model-panel__option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    color: inherit;
    background: transparent;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .model-panel__option:hover,
  .model-panel__option:focus-visible {
    background: var(--vscode-list-hoverBackground);
    outline: none;
  }
  .model-panel__option--selected {
    border-color: var(--vscode-focusBorder, #3794ff);
    background: color-mix(
      in srgb,
      var(--vscode-focusBorder, #3794ff) 12%,
      var(--vscode-editor-background)
    );
  }
  .model-panel__option-label {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
  }
  .model-panel__badge {
    flex: none;
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 999px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
  }
  .model-panel__footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
  }
  .model-panel__primary,
  .model-panel__secondary {
    padding: 3px 12px;
    border-radius: 4px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .model-panel__primary {
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .model-panel__primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  .model-panel__primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .model-panel__secondary {
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .model-panel__secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
</style>
