<script lang="ts">
  import { tasks, registerBackendSelect } from '../lib/tasks.svelte';
  import { threadStore } from '../lib/thread.svelte';
  import { post } from '../lib/protocol';

  const thread = $derived(threadStore.current);

  let backendSelect: (HTMLElement & { value: string }) | undefined;

  function syncBackendFromSelect(e: Event) {
    const el = (e.currentTarget ?? backendSelect) as (HTMLElement & { value: string }) | undefined;
    const next = el?.value;
    if (next === 'claude' || next === 'grok' || next === 'kiro' || next === 'codex') {
      tasks.setBackend(next);
    }
  }

  function newTask() {
    tasks.openNewTaskDraft();
    post({ type: 'newTask' });
  }

  $effect(() => {
    registerBackendSelect(backendSelect);
  });
</script>

<div
  class="flex items-center gap-2 px-2 py-1 border-b"
  style="border-color: var(--vscode-panel-border);"
>
  <span class="font-semibold">Muster</span>

  <vscode-single-select
    bind:this={backendSelect}
    value={tasks.selectedBackend}
    title="Backend (new tasks)"
    disabled={thread.running}
    onchange={syncBackendFromSelect}
    oninput={syncBackendFromSelect}
  >
    <vscode-option value="claude">Claude</vscode-option>
    <vscode-option value="grok">Grok</vscode-option>
    <vscode-option value="kiro">Kiro</vscode-option>
    <vscode-option value="codex">Codex</vscode-option>
  </vscode-single-select>

  <span class="flex-1"></span>

  {#if thread.running}
    <vscode-badge>running…</vscode-badge>
  {/if}

  <vscode-button secondary onclick={newTask}>New task</vscode-button>
</div>