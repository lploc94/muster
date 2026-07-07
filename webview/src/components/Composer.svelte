<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import { tasks, resolveBackendForSend, registerBackendSelect } from '../lib/tasks.svelte';
  import { post } from '../lib/protocol';
  import type { PendingAsk } from '../lib/protocol';

  interface Props {
    mode: 'draft' | 'task';
    taskId?: string;
    turnId?: string | null;
    readOnly?: boolean;
    pendingAsk?: PendingAsk | null;
  }

  let {
    mode,
    taskId,
    turnId = null,
    readOnly = false,
    pendingAsk = null,
  }: Props = $props();

  const thread = $derived(threadStore.current);

  let textareaEl = $state<(HTMLElement & { value: string }) | undefined>(undefined);
  let backendSelect = $state<(HTMLElement & { value: string }) | undefined>(undefined);

  const blocked = $derived(!!pendingAsk || readOnly);
  const canSend = $derived(!thread.running && !blocked);
  const canCancel = $derived(thread.running && !!taskId && !!turnId);

  // Register select so resolveBackendForSend can read it for draft sends
  $effect(() => {
    registerBackendSelect(backendSelect);
  });

  function send() {
    if (!canSend || !textareaEl) return;
    const value = (textareaEl.value ?? '').trim();
    if (!value) return;

    if (mode === 'draft') {
      const backend = resolveBackendForSend();
      tasks.setBackend(backend);
      const payload: {
        type: 'send';
        text: string;
        backend: string;
        continuationOf?: string;
      } = { type: 'send', text: value, backend };
      if (tasks.continuationOf) payload.continuationOf = tasks.continuationOf;
      threadStore.current.appendTranscript({
        id: `local-${Date.now()}`,
        kind: 'user',
        content: value,
      });
      post(payload);
    } else if (taskId) {
      post({ type: 'send', taskId, text: value });
    }

    textareaEl.value = '';
  }

  function cancel() {
    if (!canCancel || !taskId || !turnId) return;
    post({ type: 'cancelTurn', taskId, turnId });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Current backend to display / select
  const currentBackend = $derived(
    mode === 'draft' ? tasks.selectedBackend : (tasks.focusedTask?.backend ?? tasks.selectedBackend)
  );

  const placeholder = $derived(
    mode === 'draft'
      ? `Start a new coordinator task…`
      : readOnly
        ? 'Thread is read-only.'
        : pendingAsk
          ? 'Answer the pending question above…'
          : `Message this task…`,
  );

  function onBackendChange(e: Event) {
    const el = (e.currentTarget ?? backendSelect) as (HTMLElement & { value: string }) | undefined;
    const next = el?.value as any;
    if (next === 'claude' || next === 'grok' || next === 'kiro' || next === 'codex' || next === 'opencode') {
      tasks.setBackend(next);
    }
  }
</script>

<div class="border-t p-2 flex flex-col gap-2" style="border-color: var(--vscode-panel-border);">
  <vscode-textarea
    bind:this={textareaEl}
    rows={3}
    placeholder={placeholder}
    disabled={!canSend}
    onkeydown={onKeydown}
    style="width: 100%;"
  ></vscode-textarea>

  <!-- Footer bar: left = model + add + config ; right = send/stop -->
  <div class="flex items-center justify-between gap-2 pt-1">
    <div class="flex items-center gap-1.5">
      {#if mode === 'draft'}
        <vscode-single-select
          bind:this={backendSelect}
          value={currentBackend}
          title="Select CLI / model for new task"
          disabled={thread.running}
          position="above"
          onchange={onBackendChange}
          oninput={onBackendChange}
          style="width: fit-content; min-width: fit-content;"
        >
          <vscode-option value="claude">Claude</vscode-option>
          <vscode-option value="grok">Grok</vscode-option>
          <vscode-option value="kiro">Kiro</vscode-option>
          <vscode-option value="codex">Codex</vscode-option>
          <vscode-option value="opencode">OpenCode</vscode-option>
        </vscode-single-select>
      {:else}
        <!-- For existing task, show the backend used (read-only style) -->
        <div
          class="px-2 py-0.5 text-xs rounded border"
          style="border-color: var(--vscode-panel-border); opacity: 0.85;"
          title="Backend for this task"
        >
          {currentBackend}
        </div>
      {/if}

      <!-- Add / context button (placeholder per requirements) -->
      <button
        type="button"
        class="icon-btn opacity-60"
        style="width: 20px; height: 20px;"
        title="Add context (coming soon)"
        disabled
      >
        <span class="codicon codicon-add"></span>
      </button>

      <!-- Config button (placeholder) -->
      <button
        type="button"
        class="icon-btn opacity-60"
        style="width: 20px; height: 20px;"
        title="Config"
        disabled
      >
        <span class="codicon codicon-gear"></span>
      </button>
    </div>

    <div>
      {#if canCancel}
        <button
          type="button"
          class="icon-btn"
          style="width: 28px; height: 28px;"
          onclick={cancel}
          title="Stop"
        >
          <span class="codicon codicon-debug-stop"></span>
        </button>
      {:else if canSend}
        <button
          type="button"
          class="icon-btn"
          style="width: 28px; height: 28px;"
          onclick={send}
          title="Send"
        >
          <span class="codicon codicon-send"></span>
        </button>
      {:else if thread.running}
        <button
          type="button"
          class="icon-btn"
          style="width: 28px; height: 28px;"
          disabled
          title="Running…"
        >
          <span class="codicon codicon-loading"></span>
        </button>
      {/if}
    </div>
  </div>
</div>