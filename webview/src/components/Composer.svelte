<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import { tasks, resolveBackendForSend, registerBackendSelect } from '../lib/tasks.svelte';
  import { post } from '../lib/protocol';
  import { getTaskStatusPresentation, isTaskStatusTerminal } from '../lib/task-status';
  import type { PendingAsk, TaskViewStatus } from '../lib/protocol';
  import type { WebviewBackendId } from '../lib/tasks.svelte';

  interface Props {
    mode: 'draft' | 'task';
    taskId?: string;
    turnId?: string | null;
    readOnly?: boolean;
    pendingAsk?: PendingAsk | null;
    taskStatus?: TaskViewStatus;
  }

  let {
    mode,
    taskId,
    turnId = null,
    readOnly = false,
    pendingAsk = null,
    taskStatus = 'idle',
  }: Props = $props();

  const thread = $derived(threadStore.current);
  const presentation = $derived(getTaskStatusPresentation(taskStatus));

  let textareaEl = $state<(HTMLElement & { value: string }) | undefined>(undefined);
  let backendSelect = $state<(HTMLElement & { value: string }) | undefined>(undefined);

  const statusBlocksSend = $derived(
    taskStatus === 'running' ||
      taskStatus === 'queued' ||
      taskStatus === 'waiting_dependencies' ||
      taskStatus === 'waiting_children' ||
      taskStatus === 'waiting_user' ||
      taskStatus === 'needs_recovery' ||
      isTaskStatusTerminal(taskStatus),
  );
  const blocked = $derived(mode === 'task' && (!!pendingAsk || readOnly || statusBlocksSend));
  const canSend = $derived(mode === 'draft' ? !thread.running : !thread.running && !blocked);
  const canCancel = $derived(mode === 'task' && taskStatus === 'running' && !!taskId && !!turnId);

  const currentBackend = $derived(
    mode === 'draft' ? tasks.selectedBackend : (tasks.focusedTask?.backend ?? tasks.selectedBackend),
  );

  // Register select so resolveBackendForSend can read it for draft sends.
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
    // Ignore Enter while an IME composition is active (CJK/Vietnamese input);
    // keyCode 229 is the legacy signal for the same.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const disabledReason = $derived.by(() => {
    if (mode === 'draft') return '';
    if (pendingAsk) return 'Answer the pending task question above to continue.';
    if (taskStatus === 'running') return presentation.composerGuidance;
    if (taskStatus === 'queued') return presentation.composerGuidance;
    if (taskStatus === 'waiting_dependencies') return presentation.composerGuidance;
    if (taskStatus === 'waiting_children') return presentation.composerGuidance;
    if (taskStatus === 'waiting_user') return presentation.composerGuidance;
    if (taskStatus === 'needs_recovery') return presentation.composerGuidance;
    if (isTaskStatusTerminal(taskStatus)) return presentation.composerGuidance;
    if (readOnly) return 'This task is read-only right now.';
    return '';
  });

  const placeholder = $derived(
    mode === 'draft'
      ? `Start a new coordinator task with ${currentBackend}…`
      : disabledReason
        ? disabledReason
        : `Message this task…`,
  );

  function onBackendChange(e: Event) {
    const el = (e.currentTarget ?? backendSelect) as (HTMLElement & { value: string }) | undefined;
    const next = el?.value;
    if (next === 'claude' || next === 'grok' || next === 'kiro' || next === 'codex' || next === 'opencode') {
      tasks.setBackend(next as WebviewBackendId);
    }
  }
</script>

<div class="composer-shell border-t p-2 flex flex-col gap-2" style="border-color: var(--vscode-panel-border);">
  {#if disabledReason}
    <div class="composer-guidance" role="note">{disabledReason}</div>
  {/if}

  <vscode-textarea
    bind:this={textareaEl}
    rows={3}
    placeholder={placeholder}
    disabled={!canSend}
    onkeydown={onKeydown}
    style="width: 100%;"
  ></vscode-textarea>

  <div class="flex items-center justify-between gap-2 pt-1">
    <div class="flex items-center gap-1.5 min-w-0">
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
        <div
          class="px-2 py-0.5 text-xs rounded border truncate"
          style="border-color: var(--vscode-panel-border); opacity: 0.85;"
          title="Backend for this task"
        >
          {currentBackend}
        </div>
      {/if}

      <button type="button" class="icon-btn opacity-60" style="width: 20px; height: 20px;" title="Add context (coming soon)" disabled>
        <span class="codicon codicon-add"></span>
      </button>

      <button type="button" class="icon-btn opacity-60" style="width: 20px; height: 20px;" title="Config" disabled>
        <span class="codicon codicon-gear"></span>
      </button>
    </div>

    <div class="flex items-center gap-2">
      {#if canCancel}
        <button type="button" class="icon-btn" style="width: 28px; height: 28px;" onclick={cancel} title="Stop">
          <span class="codicon codicon-debug-stop"></span>
        </button>
      {:else if canSend}
        <button type="button" class="icon-btn" style="width: 28px; height: 28px;" onclick={send} title="Send">
          <span class="codicon codicon-send"></span>
        </button>
      {:else if taskStatus === 'queued' && turnId}
        <span class="task-muted text-xs">Queued turn is waiting to resume.</span>
      {:else if taskStatus === 'needs_recovery' && !turnId}
        <span class="task-muted text-xs">Recovery actions need a retryable turn.</span>
      {:else if thread.running}
        <button type="button" class="icon-btn" style="width: 28px; height: 28px;" disabled title="Running…">
          <span class="codicon codicon-loading"></span>
        </button>
      {/if}
    </div>
  </div>
</div>
