<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import {
    tasks,
    registerBackendSelect,
    type WebviewBackendId,
  } from '../lib/tasks.svelte';
  import { parseBackendId, parseModelFromSelectValue } from '../lib/backend-resolve';
  import { post } from '../lib/protocol';
  import { ADD_CONTEXT_ACTIONS, getAddContextActionHostMessage } from '../lib/context-actions';
  import {
    getTaskPresentation,
    getTaskStatusPresentation,
    isHardTerminal,
    runtimeBlocksComposer,
  } from '../lib/task-status';
  import {
    getTurnActivityPresentation,
    turnActivityFromTask,
    type TurnActivityState,
  } from '../lib/turn-activity';
  import type { AddContextAction } from '../lib/context-actions';
  import type { PendingAsk, TaskSummary, TaskViewStatus } from '../lib/protocol';
  import { effectiveRuntimeActivity } from '../lib/protocol';
  import { BACKENDS, backendShortLabel, backendModelLabel } from '../lib/backends';
  import { tip } from '../lib/tooltip';
  import {
    extractFileDropCandidatesFromDataTransfer,
    isOsFileManagerDrag,
    isVsCodeExplorerDrag,
  } from '../lib/file-drop';
  import { renderUserTextWithMentions } from '../lib/file-mention-render';
  import {
    allocateDisplayToken,
    expandMentionsForLlm,
    type MentionBindingMap,
  } from '../lib/file-mention-bindings';
  import {
    buildTaskComposerMessage,
    resolveComposerKeyIntent,
    shouldPreventDefaultForComposerKey,
    type ComposerSubmitIntent,
  } from '../lib/composer-submit';
  import { outboxAdd } from '../lib/send-outbox';
  import { vscode } from '../lib/vscode';

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
  }

  let {
    mode,
    taskId,
    turnId = null,
    readOnly = false,
    pendingAsk = null,
    task = null,
    taskStatus = 'idle',
  }: Props = $props();

  const thread = $derived(threadStore.current);
  const presentation = $derived(task ? getTaskPresentation(task) : getTaskStatusPresentation(taskStatus));
  const runtime = $derived(task ? effectiveRuntimeActivity(task) : null);
  const lifecycle = $derived(task?.lifecycle ?? (taskStatus as string));
  const turnActivity = $derived.by((): TurnActivityState => {
    if (task) {
      return turnActivityFromTask(task, {
        threadRunning: thread.running && !pendingAsk,
        askPending: !!pendingAsk,
      });
    }
    if (pendingAsk || taskStatus === 'waiting_user') return 'waiting_you';
    if (thread.running || taskStatus === 'running') return 'executing';
    if (taskStatus === 'queued') return 'queued';
    if (taskStatus === 'needs_recovery') return 'failed_turn';
    return 'null';
  });
  const turnPresentation = $derived(
    getTurnActivityPresentation(turnActivity, {
      hostActivity: task?.currentTurnActivity,
      waitReason:
        task?.currentTurnActivity && task.currentTurnActivity.state === 'queued'
          ? task.currentTurnActivity.waitReason
          : undefined,
    }),
  );

  let textareaEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let highlightEl = $state<HTMLDivElement | undefined>(undefined);
  let draftText = $state('');
  /** Display token (@name) → resolve path for LLM expand-on-send. */
  let mentionBindings: MentionBindingMap = new Map();
  let backendSelect = $state<(HTMLElement & { value: string }) | undefined>(undefined);
  let addContextMenuRegion = $state<HTMLElement | undefined>(undefined);
  let isDraggingFile = $state(false);
  let isExplorerDrag = $state(false);
  let dropFeedback = $state<string | null>(null);
  let isAddContextMenuOpen = $state(false);
  let lastPrefillNonce = $state<number | null>(null);

  /** Highlight layer mirrors draft; trailing newline needs an extra break for height parity. */
  const draftHighlightHtml = $derived.by(() => {
    const base = renderUserTextWithMentions(draftText);
    if (!base) return '';
    return draftText.endsWith('\n') ? `${base}<br>` : base;
  });

  // Terminal lifecycles stay writable: host send reopens the same task to open.
  // Live/queued stay writable so Enter queues FIFO follow-ups and Ctrl+Enter can inject.
  // Phase B: only structured waiting_you / pendingAsk blocks free-form by default.
  const statusBlocksSend = $derived(
    task
      ? runtimeBlocksComposer(runtime) || turnActivity === 'waiting_you'
      : taskStatus === 'waiting_user',
  );
  const blocked = $derived(mode === 'task' && (!!pendingAsk || readOnly || statusBlocksSend));
  // Draft still waits for the first turn to settle. Task mode stays open while
  // a live/queued turn is active so Enter queues and Ctrl+Enter can inject.
  const canSend = $derived(mode === 'draft' ? !thread.running : !blocked);

  // Queue panel Edit / sendRejected restore → load text into the message box.
  // Never overwrite a newer non-empty draft the user already typed.
  // On refuse (non-empty draft): leave prefill uncleared so App does not drop outbox.
  $effect(() => {
    const prefill = tasks.composerPrefill;
    if (!prefill || prefill.nonce === lastPrefillNonce) return;
    if (!canSend) return;
    if (draftText.trim().length > 0) {
      // Refuse: keep prefill for a later empty-composer attempt; mark nonce seen
      // so we don't spin, but restore only when draft becomes empty.
      return;
    }
    lastPrefillNonce = prefill.nonce;
    draftText = prefill.text;
    mentionBindings = new Map();
    dropFeedback = null;
    const appliedId = prefill.clientRequestId;
    tasks.clearComposerPrefill();
    if (appliedId) {
      // Signal successful apply for outbox cleanup.
      window.dispatchEvent(
        new CustomEvent('muster:prefill-applied', { detail: { clientRequestId: appliedId } }),
      );
    }
    queueMicrotask(() => {
      textareaEl?.focus();
      const len = draftText.length;
      textareaEl?.setSelectionRange(len, len);
      syncHighlightScroll();
    });
  });
  // Stop this turn while a live turn is executing or waiting for the user.
  const canCancel = $derived(
    mode === 'task' &&
      (turnActivity === 'executing' ||
        turnActivity === 'waiting_you' ||
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
      dropFeedback = null;
      const displayName =
        typeof msg.displayName === 'string' && msg.displayName.trim()
          ? msg.displayName.trim()
          : undefined;
      insertFileMention(msg.path, displayName);
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

  function submitComposer(intent: Exclude<ComposerSubmitIntent, { kind: 'none' }>) {
    if (!canSend) return;
    const displayText = draftText.trim();
    if (!displayText) return;

    // UI keeps short @names; host stores display `text` and agent-facing `llmText`.
    const llmText = expandMentionsForLlm(displayText, mentionBindings);

    if (mode === 'draft') {
      // Draft has no live-inject path — treat any submit as create-task send.
      // Read the LIVE select element first (what the user sees). Do not trust
      // preferredBackend alone — onchange can lag or be missed by the WC.
      const raw = backendSelect?.value ?? '';
      const fromDom = parseBackendId(raw);
      const backend: WebviewBackendId = fromDom ?? tasks.preferredBackend;
      const model =
        parseModelFromSelectValue(raw) ??
        (backend === tasks.preferredBackend ? tasks.preferredModel : null);
      if (model) {
        tasks.setModelSelection(backend, model);
      } else {
        tasks.setBackend(backend);
      }
      const clientRequestId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const payload: {
        type: 'send';
        text: string;
        llmText?: string;
        backend: string;
        model?: string;
        continuationOf?: string;
        clientRequestId: string;
      } = { type: 'send', text: displayText, backend, clientRequestId };
      if (llmText !== displayText) payload.llmText = llmText;
      if (model) payload.model = model;
      if (tasks.continuationOf) payload.continuationOf = tasks.continuationOf;
      outboxAdd(vscode, {
        clientRequestId,
        text: displayText,
        llmText: llmText !== displayText ? llmText : undefined,
        backend,
        model: model ?? undefined,
        continuationOf: tasks.continuationOf ?? undefined,
        createdAt: Date.now(),
        status: 'pending',
      });
      // DEBUG: temporary — remove after diagnosing grok→claude draft send.
      console.info('[muster][draft-send]', {
        selectValue: raw,
        fromDom,
        preferredBackend: tasks.preferredBackend,
        preferredModel: tasks.preferredModel,
        payloadBackend: payload.backend,
        payloadModel: payload.model ?? null,
      });
      threadStore.current.appendTranscript({
        id: `local-${Date.now()}`,
        kind: 'user',
        content: displayText,
      });
      post(payload);
      // Keep draft until sendAccepted; clear only on success (App restores on reject).
      draftText = '';
      mentionBindings = new Map();
      return;
    }

    if (intent.kind === 'sendLiveInput') {
      // Interrupt & send: host reserves follow-up then interrupts live turn.
      const message = buildTaskComposerMessage(intent, {
        taskId,
        text: displayText,
        llmText,
      });
      if (!message) return;
      post(message);
      draftText = '';
      mentionBindings = new Map();
      return;
    }

    if (!taskId) return;
    const payload = buildTaskComposerMessage(intent, {
      taskId,
      text: displayText,
      llmText,
    });
    if (!payload || payload.type !== 'send') return;
    if (payload.clientRequestId) {
      outboxAdd(vscode, {
        clientRequestId: payload.clientRequestId,
        taskId,
        text: displayText,
        llmText: llmText !== displayText ? llmText : undefined,
        createdAt: Date.now(),
        status: 'pending',
      });
    }
    post(payload);
    // Optimistic clear; sendRejected restores from outbox text.
    draftText = '';
    mentionBindings = new Map();
  }

  function send() {
    submitComposer({ kind: 'send' });
  }

  function sendLiveInput() {
    submitComposer({ kind: 'sendLiveInput' });
  }

  function cancel() {
    if (!canCancel || !taskId || !turnId) return;
    post({ type: 'cancelTurn', taskId, turnId });
  }

  function insertFileMention(resolvePath: string, displayName?: string) {
    if (!canSend) return;
    const { token } = allocateDisplayToken(mentionBindings, resolvePath, displayName);
    if (!token) return;

    const current = draftText;
    const start = textareaEl?.selectionStart ?? current.length;
    const end = textareaEl?.selectionEnd ?? start;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const leading = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const trailing = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
    const insertion = `${leading}${token}${trailing}`;
    draftText = `${before}${insertion}${after}`;
    const caret = start + insertion.length;
    queueMicrotask(() => {
      textareaEl?.focus();
      textareaEl?.setSelectionRange(caret, caret);
      syncHighlightScroll();
    });
  }

  function syncHighlightScroll() {
    if (!textareaEl || !highlightEl) return;
    highlightEl.scrollTop = textareaEl.scrollTop;
    highlightEl.scrollLeft = textareaEl.scrollLeft;
  }

  function onDraftInput(e: Event) {
    const el = e.currentTarget as HTMLTextAreaElement;
    draftText = el.value;
    syncHighlightScroll();
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

  function onDragOver(e: DragEvent) {
    if (!canSend) return;
    // Must preventDefault so VS Code / Chromium allow the drop into the webview.
    e.preventDefault();
    isDraggingFile = true;
    const types = e.dataTransfer?.types;
    isExplorerDrag =
      !!types && (isVsCodeExplorerDrag(types) || isOsFileManagerDrag(types));
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropFeedback = null;
  }

  function onDragLeave(e: DragEvent) {
    if (!e.currentTarget || !e.relatedTarget) {
      isDraggingFile = false;
      isExplorerDrag = false;
      return;
    }
    const current = e.currentTarget as Node;
    const related = e.relatedTarget as Node;
    if (!current.contains(related)) {
      isDraggingFile = false;
      isExplorerDrag = false;
    }
  }

  function isBareFileName(candidate: string): boolean {
    const c = candidate.trim();
    if (!c) return false;
    if (c.includes('/') || c.includes('\\')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(c)) return false;
    return true;
  }

  async function onDrop(e: DragEvent) {
    isDraggingFile = false;
    isExplorerDrag = false;
    if (!canSend || !e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();

    const dt = e.dataTransfer;
    const files = Array.from(dt.files ?? []);

    // Sync + async path extraction (Explorer URIs / Electron File.path).
    const extraction = await extractFileDropCandidatesFromDataTransfer(dt, canSend);

    // Finder often only gives File.name (no absolute path). Import bytes on the
    // host so the mention is a real absolute path the LLM can open.
    const onlyBareNames =
      extraction.ok &&
      extraction.candidates.length > 0 &&
      extraction.candidates.every(isBareFileName);
    if (files.length === 1 && (onlyBareNames || !extraction.ok)) {
      try {
        const file = files[0];
        const buffer = await file.arrayBuffer();
        dropFeedback = null;
        post({ type: 'importDroppedFile', name: file.name, data: buffer });
        return;
      } catch {
        dropFeedback = 'Unable to read the dropped file.';
        return;
      }
    }

    if (extraction.ok) {
      dropFeedback = null;
      post({ type: 'resolveFileDrop', candidates: extraction.candidates });
      return;
    }
    if (extraction.code !== 'disabled') {
      dropFeedback = extraction.message;
    }
  }

  /** Interrupt & send only while a turn is executing — waiting_you Ctrl+Enter uses ordinary send. */
  const liveInjectEligible = $derived(
    mode === 'task' &&
      (runtime === 'running' || taskStatus === 'running' || turnActivity === 'executing'),
  );

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isAddContextMenuOpen) {
      e.preventDefault();
      closeAddContextMenu();
      return;
    }

    const policyInput = {
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: e.isComposing,
      keyCode: e.keyCode,
    };
    const keyOpts = { mode, liveInjectEligible };
    const intent = resolveComposerKeyIntent(policyInput, keyOpts);
    if (intent.kind === 'none') return;
    if (shouldPreventDefaultForComposerKey(policyInput, keyOpts)) {
      e.preventDefault();
    }
    submitComposer(intent);
  }

  /** True when lifecycle is sealed; composer stays enabled and send reopens. */
  const isTerminalReopenable = $derived(
    task
      ? isHardTerminal(lifecycle) || lifecycle === 'failed'
      : isHardTerminal(taskStatus) || taskStatus === 'failed',
  );

  /** Blocks send (busy/gated). Terminal reopenable is NOT a block. Live/queued are not blocks. */
  const blockReason = $derived.by(() => {
    if (mode === 'draft') return '';
    if (pendingAsk || turnActivity === 'waiting_you') {
      return 'Answer above to continue.';
    }
    if (task) {
      if (runtimeBlocksComposer(runtime)) return presentation.composerGuidance;
      if (readOnly) return 'This task is read-only right now.';
      return '';
    }
    if (taskStatus === 'waiting_user') return 'Answer above to continue.';
    if (readOnly) return 'This task is read-only right now.';
    return '';
  });

  /** Non-blocking affordance copy while live/queued (composer remains editable). */
  const liveComposerGuidance = $derived.by(() => {
    if (mode !== 'task' || blockReason) return '';
    if (task) {
      if (runtime === 'running' || runtime === 'queued') return presentation.composerGuidance;
      return '';
    }
    if (taskStatus === 'running' || taskStatus === 'queued') return presentation.composerGuidance;
    return '';
  });

  /**
   * Composer note for blocked/busy states and live queue affordance.
   * Terminal reopen warning lives once in TaskWorkspace (panel + Reopen button).
   */
  const composerNote = $derived.by(() => {
    if (mode === 'draft') return '';
    if (blockReason) return blockReason;
    if (liveComposerGuidance) return liveComposerGuidance;
    if (taskStatus === 'awaiting_outcome' && !isTerminalReopenable) {
      return presentation.composerGuidance;
    }
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

  /** Prefer the user's restored choice over the availability display fallback. */
  const draftBackend = $derived(
    mode === 'draft' ? tasks.preferredBackend : currentBackend,
  );
  const draftModel = $derived(
    mode === 'draft'
      ? (tasks.preferredModel ?? tasks.selectedModel)
      : tasks.selectedModel,
  );

  const pickerOptions = $derived.by(() => {
    const models = tasks.modelsByBackend;
    const opts: { value: string; label: string }[] = [];
    if (models && Object.keys(models).length > 0) {
      for (const be of pickerBackends) {
        const m = models[be.id];
        if (m && m.options.length > 0) {
          for (const o of m.options) {
            opts.push({
              value: `${be.id}::${o.value}`,
              label: `[${backendShortLabel(be.id)}] ${o.name}`,
            });
          }
        } else {
          // Backend installed but no model list yet (still enumerating) or none advertised.
          // Keep restored preference visible as backend::model when we have one.
          if (be.id === draftBackend && draftModel) {
            opts.push({
              value: `${be.id}::${draftModel}`,
              label: `[${backendShortLabel(be.id)}] ${draftModel}`,
            });
          } else {
            opts.push({
              value: be.id,
              label: modelsLoading ? `${be.label} (loading models…)` : be.label,
            });
          }
        }
      }
    } else {
      for (const be of pickerBackends) {
        if (be.id === draftBackend && draftModel) {
          opts.push({
            value: `${be.id}::${draftModel}`,
            label: `[${backendShortLabel(be.id)}] ${draftModel}`,
          });
        } else {
          opts.push({
            value: be.id,
            label: modelsLoading ? `${be.label} (loading models…)` : be.label,
          });
        }
      }
    }
    // Ensure the active selection always exists as an option (web component needs it).
    const active = encodePickerValue(draftBackend, draftModel, models);
    if (active.includes('::') && !opts.some((o) => o.value === active)) {
      const [be, ...rest] = active.split('::');
      const model = rest.join('::');
      opts.unshift({
        value: active,
        label: `[${backendShortLabel(be)}] ${model}`,
      });
    }
    return opts;
  });

  function modelInCatalog(backend: string, model: string): boolean {
    return !!tasks.modelsByBackend?.[backend]?.options.some((o) => o.value === model);
  }

  function encodePickerValue(
    backend: string,
    model: string | null,
    models: typeof tasks.modelsByBackend,
  ): string {
    const m = models?.[backend];
    if (m && m.options.length > 0) {
      const chosen =
        (model && m.options.some((o) => o.value === model) ? model : null) ??
        m.current ??
        m.options[0].value;
      return `${backend}::${chosen}`;
    }
    if (model) return `${backend}::${model}`;
    return backend;
  }

  // Always prefer backend::model when a model is known (restored or catalog default).
  const currentPickerValue = $derived(
    encodePickerValue(draftBackend, draftModel, tasks.modelsByBackend),
  );

  // Remount only on catalog phase transitions (empty → has models). vscode-elements
  // does not fire change when setting .value / defaulting option[0] on remount —
  // only real user click/Enter dispatches change (via new Event, isTrusted=false).
  let catalogGeneration = $state(0);
  let lastModelsLoaded: boolean | undefined;
  $effect(() => {
    const loaded = modelsLoaded;
    // Only bump on an actual empty↔loaded transition. Incrementing on every
    // `!loaded` effect pass reads/writes catalogGeneration forever and can halt
    // all subsequent webview reactivity with effect_update_depth_exceeded.
    if (loaded === lastModelsLoaded) return;
    lastModelsLoaded = loaded;
    catalogGeneration += 1;
  });
  const pickerRemountKey = $derived(
    modelsLoaded ? `models:${catalogGeneration}` : `loading:${catalogGeneration}`,
  );

  // Only force preferred encoding after remount — never continuously overwrite
  // the live select (that fights the user's pick and can clobber Grok → Claude).
  let lastForcedRemountKey = '';
  $effect(() => {
    const el = backendSelect;
    const key = pickerRemountKey;
    const next = currentPickerValue;
    if (!el || mode !== 'draft') return;
    if (key === lastForcedRemountKey && el.value) return;
    lastForcedRemountKey = key;
    try {
      el.value = next;
    } catch {
      // best-effort
    }
  });

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
      ? `Start a new coordinator task with ${draftBackend}…`
      : isTerminalReopenable
        ? 'Send a message to reopen this task…'
        : blockReason
          ? blockReason
          : liveComposerGuidance
            ? 'Enter queues a follow-up · Ctrl+Enter interrupts and sends…'
            : 'Message this task…',
  );

  const BACKEND_IDS = ['claude', 'grok', 'kiro', 'codex', 'opencode'];

  function onBackendChange(e: Event) {
    // vscode-single-select dispatches `new Event('change')` so isTrusted is always
    // false even for real user clicks — never filter on isTrusted.
    const el = (e.currentTarget ?? backendSelect) as (HTMLElement & { value: string }) | undefined;
    const raw = el?.value ?? '';
    const sep = raw.indexOf('::');
    if (sep >= 0) {
      const backend = raw.slice(0, sep);
      const model = raw.slice(sep + 2);
      if (BACKEND_IDS.includes(backend)) {
        console.info('[muster][picker-change]', { raw, backend, model, isTrusted: e.isTrusted });
        tasks.setModelSelection(backend as WebviewBackendId, model);
      }
    } else if (BACKEND_IDS.includes(raw)) {
      console.info('[muster][picker-change]', { raw, backend: raw, model: null, isTrusted: e.isTrusted });
      tasks.setBackend(raw as WebviewBackendId);
    } else {
      console.warn('[muster][picker-change] unparsed', { raw, isTrusted: e.isTrusted });
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
  {#if mode === 'task' && turnPresentation.showStrip}
    <div
      class={`turn-activity-bar turn-activity-bar--${turnPresentation.tone}`}
      data-turn-activity={turnActivity}
      role="status"
      aria-live="polite"
      use:tip={turnPresentation.detail}
    >
      <span
        class="codicon codicon-{turnPresentation.icon}"
        class:codicon-modifier-spin={turnActivity === 'executing'}
        aria-hidden="true"
      ></span>
      <span class="turn-activity-bar__label">{turnPresentation.label}</span>
      <span class="turn-activity-bar__sep" aria-hidden="true">·</span>
      <span class="turn-activity-bar__hint">{turnPresentation.hint}</span>
    </div>
  {/if}

  {#if isDraggingFile}
    <div class="composer-drop-status" role="status" aria-live="polite">
      {isExplorerDrag
        ? 'Hold Shift and drop to mention the file (Explorer / Finder)'
        : 'Drop file to mention it'}
    </div>
  {/if}

  {#if dropFeedback}
    <div class="composer-guidance composer-guidance--error" role="alert">{dropFeedback}</div>
  {/if}

  {#if composerNote}
    <div
      class="composer-guidance"
      role="note"
      data-composer-guidance={blockReason ? 'blocked' : liveComposerGuidance ? 'live' : 'info'}
    >
      {composerNote}
    </div>
  {/if}

  <!-- Layered input: highlight backdrop + transparent textarea (Cursor-style live chips). -->
  <div class="composer-input" class:composer-input--disabled={!canSend}>
    <div
      bind:this={highlightEl}
      class="composer-input__highlight"
      aria-hidden="true"
    >{@html draftHighlightHtml}</div>
    <textarea
      bind:this={textareaEl}
      class="composer-input__textarea"
      rows={3}
      placeholder={placeholder}
      disabled={!canSend}
      value={draftText}
      oninput={onDraftInput}
      onscroll={syncHighlightScroll}
      onkeydown={onKeydown}
      spellcheck="true"
    ></textarea>
  </div>

  <div class="flex items-center justify-between gap-2 pt-1" onkeydown={onKeydown}>
    <div class="flex items-center gap-1.5 min-w-0">
      {#if mode === 'draft'}
        {#key pickerRemountKey}
          <vscode-single-select
            bind:this={backendSelect}
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
              <vscode-option value={opt.value} selected={opt.value === currentPickerValue}
                >{opt.label}</vscode-option
              >
            {/each}
          </vscode-single-select>
        {/key}
      {:else}
        <div
          class="px-2 py-0.5 text-xs rounded border truncate"
          style="border-color: var(--vscode-panel-border); opacity: 0.85;"
          use:tip={'Backend + model for this task'}
        >
          {backendModelLabel(currentBackend, tasks.focusedTask?.model)}
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
          aria-label="Stop this turn"
          use:tip={'Stop this turn'}
        >
          <span class="codicon codicon-debug-stop"></span>
        </button>
      {/if}
      {#if canSend}
        {#if !canCancel}
          <button
            type="button"
            class="icon-btn"
            style="width: 28px; height: 28px;"
            onclick={send}
            aria-label="Send"
            use:tip={
              mode === 'task' && (runtime === 'running' || taskStatus === 'running')
                ? 'Enter queues a follow-up; Ctrl+Enter interrupts and sends'
                : isTerminalReopenable
                  ? 'Send a message to reopen this task'
                  : 'Send'
            }
          >
            <span class="codicon codicon-send"></span>
          </button>
        {/if}
        {#if mode === 'task' && (runtime === 'running' || taskStatus === 'running')}
          <button
            type="button"
            class="icon-btn"
            style="width: 28px; height: 28px;"
            onclick={sendLiveInput}
            aria-label="Interrupt and send"
            use:tip={'Ctrl+Enter: interrupt & send (cut & continue)'}
            data-testid="composer-live-inject"
          >
            <span class="codicon codicon-debug-line-by-line"></span>
          </button>
        {/if}
      {:else if (runtime === 'needs_recovery' || taskStatus === 'needs_recovery') && !turnId}
        <span class="task-muted text-xs">Recovery actions need a retryable turn.</span>
      {:else if mode === 'draft' && thread.running}
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
