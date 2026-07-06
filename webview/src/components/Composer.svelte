<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import { tasks, resolveBackendForSend } from '../lib/tasks.svelte';
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

  let textareaEl: (HTMLElement & { value: string }) | undefined;

  const blocked = $derived(!!pendingAsk || readOnly);
  const canSend = $derived(!thread.running && !blocked);
  const canCancel = $derived(thread.running && !!taskId && !!turnId);

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

  const placeholder = $derived(
    mode === 'draft'
      ? `New task message (${tasks.selectedBackend})…`
      : readOnly
        ? 'Thread is read-only.'
        : pendingAsk
          ? 'Answer the pending question above…'
          : `Message…`,
  );
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

  <div class="flex gap-2 justify-end">
    {#if canCancel}
      <vscode-button secondary onclick={cancel}>Cancel</vscode-button>
    {:else if canSend}
      <vscode-button onclick={send}>Send</vscode-button>
    {/if}
  </div>
</div>