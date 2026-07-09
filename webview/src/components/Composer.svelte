<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import { tasks, resolveBackendForSend, registerBackendSelect } from '../lib/tasks.svelte';
  import { post } from '../lib/protocol';
  import { getTaskStatusPresentation, isTaskStatusTerminal } from '../lib/task-status';
  import type { PendingAsk, TaskViewStatus } from '../lib/protocol';
  import type { WebviewBackendId } from '../lib/tasks.svelte';
  import { BACKENDS, backendShortLabel } from '../lib/backends';
  import { tip } from '../lib/tooltip';

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
  let isDraggingFile = $state(false);

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

  $effect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data;
      if (msg?.type !== 'filePicked' || typeof msg.path !== 'string') return;
      insertFileMention(msg.path);
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
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

  function mentionForPath(path: string): string {
    const normalized = path.trim().replace(/\\/g, '/');
    if (!normalized) return '';
    return /\s/.test(normalized) ? `@"${normalized}"` : `@${normalized}`;
  }

  function insertFileMention(path: string) {
    if (!textareaEl || !canSend) return;
    const mention = mentionForPath(path);
    if (!mention) return;

    const current = textareaEl.value ?? '';
    const needsLeadingSpace = current.length > 0 && !/\s$/.test(current);
    const next = `${current}${needsLeadingSpace ? ' ' : ''}${mention} `;
    textareaEl.value = next;
    textareaEl.focus?.();
  }

  function pickFile() {
    if (!canSend) return;
    post({ type: 'pickFile' });
  }

  function dragCandidates(dataTransfer: DataTransfer): string[] {
    const candidates: string[] = [];
    for (const file of Array.from(dataTransfer.files ?? [])) {
      const path = (file as File & { path?: string }).path;
      if (typeof path === 'string' && path) candidates.push(path);
      if (file.name) candidates.push(file.name);
    }
    for (const type of dataTransfer.types ?? []) {
      const value = dataTransfer.getData(type);
      if (value) candidates.push(value);
    }
    return candidates;
  }

  function onDragOver(e: DragEvent) {
    if (!canSend) return;
    e.preventDefault();
    isDraggingFile = true;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(e: DragEvent) {
    if (!e.currentTarget || !e.relatedTarget) {
      isDraggingFile = false;
      return;
    }
    const current = e.currentTarget as Node;
    const related = e.relatedTarget as Node;
    if (!current.contains(related)) isDraggingFile = false;
  }

  function onDrop(e: DragEvent) {
    if (!canSend || !e.dataTransfer) return;
    e.preventDefault();
    isDraggingFile = false;
    const candidates = dragCandidates(e.dataTransfer);
    if (candidates.length > 0) {
      post({ type: 'resolveFileDrop', candidates });
    }
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

  // Only offer backends whose CLI the host reports as installed. Until that is
  // known (null) — or if nothing was detected — fail open and show all.
  const pickerBackends = $derived.by(() => {
    const avail = tasks.availableBackends;
    if (!avail || avail.length === 0) return BACKENDS;
    const filtered = BACKENDS.filter((b) => avail.includes(b.id));
    return filtered.length > 0 ? filtered : BACKENDS;
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

<div
  class="composer-shell border-t p-2 flex flex-col gap-2"
  class:composer-shell--dragging={isDraggingFile}
  style="border-color: var(--vscode-panel-border);"
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
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
          use:tip={'Select CLI / model for new task'}
          disabled={thread.running}
          position="above"
          onchange={onBackendChange}
          oninput={onBackendChange}
          style="width: fit-content; min-width: fit-content;"
        >
          {#each pickerBackends as be (be.id)}
            <vscode-option value={be.id}>{be.label}</vscode-option>
          {/each}
        </vscode-single-select>
      {:else}
        <div
          class="px-2 py-0.5 text-xs rounded border truncate"
          style="border-color: var(--vscode-panel-border); opacity: 0.85;"
          use:tip={'Backend for this task'}
        >
          {backendShortLabel(currentBackend)}
        </div>
      {/if}

      <button
        type="button"
        class="icon-btn"
        style="width: 20px; height: 20px;"
        aria-label="Add file"
        use:tip={'Add file'}
        onclick={pickFile}
        disabled={!canSend}
      >
        <span class="codicon codicon-add"></span>
      </button>

      <!-- Config button (placeholder) -->
      <button
        type="button"
        class="icon-btn opacity-60"
        style="width: 20px; height: 20px;"
        aria-label="Config"
        use:tip={'Config'}
        disabled
      >
        <span class="codicon codicon-gear"></span>
      </button>
    </div>

    <div class="flex items-center gap-2">
      {#if canCancel}
        <button
          type="button"
          class="icon-btn"
          style="width: 28px; height: 28px;"
          onclick={cancel}
          aria-label="Stop"
          use:tip={'Stop'}
        >
          <span class="codicon codicon-debug-stop"></span>
        </button>
      {:else if canSend}
        <button
          type="button"
          class="icon-btn"
          style="width: 28px; height: 28px;"
          onclick={send}
          aria-label="Send"
          use:tip={'Send'}
        >
          <span class="codicon codicon-send"></span>
        </button>
      {:else if taskStatus === 'queued' && turnId}
        <span class="task-muted text-xs">Queued turn is waiting to resume.</span>
      {:else if taskStatus === 'needs_recovery' && !turnId}
        <span class="task-muted text-xs">Recovery actions need a retryable turn.</span>
      {:else if thread.running}
        <button
          type="button"
          class="icon-btn"
          style="width: 28px; height: 28px;"
          disabled
          aria-label="Running…"
          use:tip={'Running…'}
        >
          <span class="codicon codicon-loading"></span>
        </button>
      {/if}
    </div>
  </div>
</div>
