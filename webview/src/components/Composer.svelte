<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import { tasks, resolveBackendForSend, registerBackendSelect } from '../lib/tasks.svelte';
  import { post } from '../lib/protocol';
  import { ADD_CONTEXT_ACTIONS, getAddContextActionHostMessage } from '../lib/context-actions';
  import {
    getTaskPresentation,
    getTaskStatusPresentation,
    isHardTerminal,
    runtimeBlocksComposer,
  } from '../lib/task-status';
  import {
    CLI_LAST_EXIT_LABELS,
    cliStatusFromTask,
    getCliStatusPresentation,
    type CliLastExit,
  } from '../lib/cli-status';
  import type { AddContextAction } from '../lib/context-actions';
  import type { PendingAsk, TaskSummary, TaskViewStatus } from '../lib/protocol';
  import { effectiveRuntimeActivity } from '../lib/protocol';
  import type { WebviewBackendId } from '../lib/tasks.svelte';
  import { BACKENDS, backendShortLabel } from '../lib/backends';
  import { tip } from '../lib/tooltip';

  interface Props {
    mode: 'draft' | 'task';
    taskId?: string;
    turnId?: string | null;
    readOnly?: boolean;
    pendingAsk?: PendingAsk | null;
    /** Preferred: full task summary for dual-axis status. */
    task?: TaskSummary | null;
    /** @deprecated Prefer `task`. Kept for callers that only have viewStatus. */
    taskStatus?: TaskViewStatus;
    /** Optional last process exit (host may project later). */
    cliLastExit?: CliLastExit | null;
  }

  let {
    mode,
    taskId,
    turnId = null,
    readOnly = false,
    pendingAsk = null,
    task = null,
    taskStatus = 'idle',
    cliLastExit = null,
  }: Props = $props();

  const thread = $derived(threadStore.current);
  const presentation = $derived(task ? getTaskPresentation(task) : getTaskStatusPresentation(taskStatus));
  const runtime = $derived(task ? effectiveRuntimeActivity(task) : null);
  const lifecycle = $derived(task?.lifecycle ?? (taskStatus as string));
  const cliStatus = $derived(
    task
      ? cliStatusFromTask(task, {
          // Generating only when streaming without a pending ask.
          threadRunning: thread.running && !pendingAsk,
          askPending: !!pendingAsk,
          // Persist across reload: a committed session implies a prior process.
          hadProcess: thread.hadProcess || !!task.committedSessionId,
        })
      : thread.running && !pendingAsk
        ? ('running' as const)
        : pendingAsk
          ? ('idle' as const)
          : ('not_started' as const),
  );
  const cliPresentation = $derived(getCliStatusPresentation(cliStatus));
  const cliExitHint = $derived(
    cliStatus === 'stopped' && cliLastExit ? CLI_LAST_EXIT_LABELS[cliLastExit] : null,
  );

  let textareaEl = $state<(HTMLElement & { value: string }) | undefined>(undefined);
  let backendSelect = $state<(HTMLElement & { value: string }) | undefined>(undefined);
  let addContextMenuRegion = $state<HTMLElement | undefined>(undefined);
  let isDraggingFile = $state(false);
  let isAddContextMenuOpen = $state(false);

  const statusBlocksSend = $derived(
    task
      ? isHardTerminal(lifecycle) || runtimeBlocksComposer(runtime)
      : taskStatus === 'running' ||
          taskStatus === 'queued' ||
          taskStatus === 'waiting_dependencies' ||
          taskStatus === 'waiting_children' ||
          taskStatus === 'waiting_user' ||
          taskStatus === 'needs_recovery' ||
          isHardTerminal(taskStatus),
  );
  const blocked = $derived(mode === 'task' && (!!pendingAsk || readOnly || statusBlocksSend));
  const canSend = $derived(mode === 'draft' ? !thread.running : !thread.running && !blocked);
  // Stop applies while a process is up (generating or idle/waiting_user).
  const canCancel = $derived(
    mode === 'task' &&
      (cliStatus === 'running' ||
        cliStatus === 'idle' ||
        runtime === 'running' ||
        runtime === 'waiting_user' ||
        taskStatus === 'running' ||
        taskStatus === 'waiting_user') &&
      !!taskId &&
      !!turnId,
  );

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

  $effect(() => {
    if (!canSend && isAddContextMenuOpen) {
      closeAddContextMenu();
    }
  });

  $effect(() => {
    if (!isAddContextMenuOpen) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Node && addContextMenuRegion?.contains(target)) return;
      closeAddContextMenu();
    }

    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
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
        model?: string;
        continuationOf?: string;
      } = { type: 'send', text: value, backend };
      // Only deliver a model that belongs to the chosen backend's catalog. Before
      // enumeration finishes (catalog null) trust the persisted selection.
      const model = tasks.selectedModel;
      if (model && (!tasks.modelsByBackend || modelInCatalog(backend, model))) {
        payload.model = model;
      }
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

  function closeAddContextMenu() {
    isAddContextMenuOpen = false;
  }

  function toggleAddContextMenu() {
    if (!canSend) return;
    isAddContextMenuOpen = !isAddContextMenuOpen;
  }

  function activateAddContextAction(action: AddContextAction) {
    if (!canSend) return;
    const hostMessage = getAddContextActionHostMessage(action.id);
    if (!hostMessage) return;
    closeAddContextMenu();
    post(hostMessage);
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
    if (e.key === 'Escape' && isAddContextMenuOpen) {
      e.preventDefault();
      closeAddContextMenu();
      return;
    }

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
    if (task) {
      if (isHardTerminal(lifecycle)) return presentation.composerGuidance;
      if (runtimeBlocksComposer(runtime)) return presentation.composerGuidance;
      if (lifecycle === 'failed') return presentation.composerGuidance;
      if (readOnly) return 'This task is read-only right now.';
      return '';
    }
    if (taskStatus === 'running') return presentation.composerGuidance;
    if (taskStatus === 'queued') return presentation.composerGuidance;
    if (taskStatus === 'waiting_dependencies') return presentation.composerGuidance;
    if (taskStatus === 'waiting_children') return presentation.composerGuidance;
    if (taskStatus === 'waiting_user') return presentation.composerGuidance;
    if (taskStatus === 'needs_recovery') return presentation.composerGuidance;
    if (taskStatus === 'awaiting_outcome') return presentation.composerGuidance;
    if (isHardTerminal(taskStatus)) return presentation.composerGuidance;
    if (taskStatus === 'failed') return presentation.composerGuidance;
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

  // Grouped model picker: one `[Backend] Model` option per enumerated model.
  // Until the host reports models, fall back to plain per-backend options.
  const modelsLoaded = $derived(!!tasks.modelsByBackend && Object.keys(tasks.modelsByBackend).length > 0);
  const modelsLoading = $derived(mode === 'draft' && !modelsLoaded);

  const pickerOptions = $derived.by(() => {
    const models = tasks.modelsByBackend;
    if (models && Object.keys(models).length > 0) {
      const opts: { value: string; label: string }[] = [];
      for (const be of pickerBackends) {
        const m = models[be.id];
        if (m && m.options.length > 0) {
          for (const o of m.options) {
            opts.push({ value: `${be.id}::${o.value}`, label: `[${backendShortLabel(be.id)}] ${o.name}` });
          }
        } else {
          // Backend installed but no model list yet (still enumerating) or none advertised.
          opts.push({
            value: be.id,
            label: modelsLoading ? `${be.label} (loading models…)` : be.label,
          });
        }
      }
      if (opts.length > 0) return opts;
    }
    return pickerBackends.map((b) => ({
      value: b.id,
      label: modelsLoading ? `${b.label} (loading models…)` : b.label,
    }));
  });

  function modelInCatalog(backend: string, model: string): boolean {
    return !!tasks.modelsByBackend?.[backend]?.options.some((o) => o.value === model);
  }

  // Encoded value the select should show — always an option that exists in
  // `pickerOptions`. Until models load (or for a backend with none) that is the
  // plain backend id; otherwise the chosen model, else the backend's default.
  const currentPickerValue = $derived.by(() => {
    if (!modelsLoaded) return currentBackend;
    const m = tasks.modelsByBackend?.[currentBackend];
    if (m && m.options.length > 0) {
      const chosen =
        tasks.selectedModel && modelInCatalog(currentBackend, tasks.selectedModel)
          ? tasks.selectedModel
          : (m.current ?? m.options[0].value);
      return `${currentBackend}::${chosen}`;
    }
    return currentBackend;
  });

  // Remount key so vscode-single-select rebuilds options when the catalog arrives
  // (web components often ignore Svelte re-rendering child <vscode-option>s).
  // Only remount when the option *set* changes — not when the selected value changes.
  const pickerRemountKey = $derived(
    modelsLoaded
      ? `models:${pickerOptions.map((o) => o.value).join('|')}`
      : `backends:${pickerBackends.map((b) => b.id).join(',')}:loading`,
  );

  // Ensure host starts enumeration when the draft composer is shown (also
  // prefetched on App mount / panel resolve).
  let draftModelsRequested = false;
  $effect(() => {
    if (mode === 'draft' && !draftModelsRequested) {
      draftModelsRequested = true;
      post({ type: 'listModels' });
    }
    if (mode !== 'draft') {
      draftModelsRequested = false;
    }
  });

  const placeholder = $derived(
    mode === 'draft'
      ? `Start a new coordinator task with ${currentBackend}…`
      : disabledReason
        ? disabledReason
        : `Message this task…`,
  );

  const BACKEND_IDS = ['claude', 'grok', 'kiro', 'codex', 'opencode'];

  function onBackendChange(e: Event) {
    const el = (e.currentTarget ?? backendSelect) as (HTMLElement & { value: string }) | undefined;
    const raw = el?.value ?? '';
    const sep = raw.indexOf('::');
    if (sep >= 0) {
      const backend = raw.slice(0, sep);
      const model = raw.slice(sep + 2);
      if (BACKEND_IDS.includes(backend)) {
        tasks.setModelSelection(backend as WebviewBackendId, model);
      }
    } else if (BACKEND_IDS.includes(raw)) {
      tasks.setBackend(raw as WebviewBackendId);
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
  {#if mode === 'task'}
    <div
      class={`cli-status-bar cli-status-bar--${cliPresentation.tone}`}
      data-cli-status={cliStatus}
      role="status"
      aria-live="polite"
      use:tip={cliPresentation.detail}
    >
      <span
        class="codicon codicon-{cliPresentation.icon}"
        class:codicon-modifier-spin={cliStatus === 'running'}
        aria-hidden="true"
      ></span>
      <span class="cli-status-bar__label">{cliPresentation.label}</span>
      <span class="cli-status-bar__sep" aria-hidden="true">·</span>
      <span class="cli-status-bar__hint">
        {cliExitHint ?? cliPresentation.hint}
      </span>
    </div>
  {/if}

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

  <div class="flex items-center justify-between gap-2 pt-1" onkeydown={onKeydown}>
    <div class="flex items-center gap-1.5 min-w-0">
      {#if mode === 'draft'}
        {#key pickerRemountKey}
          <vscode-single-select
            bind:this={backendSelect}
            value={currentPickerValue}
            use:tip={modelsLoaded
              ? 'Select backend + model for the new task'
              : 'Loading models from installed CLIs… (shows backends first)'}
            disabled={thread.running}
            position="above"
            onchange={onBackendChange}
            oninput={onBackendChange}
            style="width: fit-content; min-width: fit-content; max-width: 100%;"
          >
            {#each pickerOptions as opt (opt.value)}
              <vscode-option value={opt.value}>{opt.label}</vscode-option>
            {/each}
          </vscode-single-select>
        {/key}
      {:else}
        <div
          class="px-2 py-0.5 text-xs rounded border truncate"
          style="border-color: var(--vscode-panel-border); opacity: 0.85;"
          use:tip={'Backend for this task'}
        >
          {backendShortLabel(currentBackend)}
        </div>
      {/if}

      <div bind:this={addContextMenuRegion} class="add-context">
        <button
          type="button"
          class="icon-btn add-context__button"
          aria-label="Add Context"
          aria-haspopup="menu"
          aria-expanded={isAddContextMenuOpen ? 'true' : 'false'}
          use:tip={'Add Context'}
          onclick={toggleAddContextMenu}
          disabled={!canSend}
        >
          <span class="codicon codicon-add"></span>
        </button>

        {#if isAddContextMenuOpen}
          <div class="add-context__menu" role="menu" aria-label="Add Context">
            {#each ADD_CONTEXT_ACTIONS as action (action.id)}
              <button
                type="button"
                class="add-context__menu-item"
                class:add-context__menu-item--disabled={action.state !== 'enabled'}
                role="menuitem"
                aria-label={action.label}
                aria-disabled={action.state !== 'enabled' ? 'true' : 'false'}
                title={action.state === 'enabled' ? action.description : action.disabledReason}
                disabled={action.state !== 'enabled'}
                onclick={() => activateAddContextAction(action)}
              >
                <span class="add-context__menu-item-label">{action.label}</span>
                {#if action.state === 'comingSoon'}
                  <span class="add-context__menu-item-badge">Coming soon</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

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
      {:else if (runtime === 'queued' || taskStatus === 'queued') && turnId}
        <span class="task-muted text-xs">Queued turn is waiting to resume.</span>
      {:else if (runtime === 'needs_recovery' || taskStatus === 'needs_recovery') && !turnId}
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
