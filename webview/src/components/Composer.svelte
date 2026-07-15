<script lang="ts">
  import { threadStore } from '../lib/thread.svelte';
  import {
    tasks,
    registerBackendSelect,
    type WebviewBackendId,
  } from '../lib/tasks.svelte';
  import { parseBackendId, parseModelFromSelectValue } from '../lib/backend-resolve';
  import { post, postDebug } from '../lib/protocol';
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
  import { isHandoffProgressInFlight } from '../lib/handoff-progress';
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
    createFileMentionAutocompleteSession,
    refineActiveFileMentionDirectory,
    replaceActiveFileMentionQuery,
    type FileMentionAutocompleteState,
  } from '../lib/file-mention-autocomplete';
  import {
    resolveFileMentionKeyIntent,
    shouldPreventDefaultForFileMentionKey,
  } from '../lib/file-mention-keyboard';
  import {
    FILE_MENTION_LISTBOX_ID,
    FILE_MENTION_LISTBOX_LABEL,
    clampFileMentionActiveIndex,
    fileMentionOptionId,
    fileMentionStatusText,
    resolveFileMentionActiveDescendant,
  } from '../lib/file-mention-listbox';
  import type { FileMentionSuggestionItem, FileMentionSuggestionsMessage } from '../lib/protocol';
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
  /** Reactive mirror of the pure autocomplete session (request scope + listbox). */
  let mentionAutocomplete = $state<FileMentionAutocompleteState>({
    open: false,
    items: [],
    activeQuery: null,
    pendingRequestId: null,
    outcome: 'closed',
  });
  let mentionListboxRegion = $state<HTMLElement | undefined>(undefined);
  /** Keyboard/mouse highlighted option; -1 means none until first Arrow or paint seed. */
  let mentionActiveIndex = $state(-1);
  let lastMentionItemsSignature = '';
  /** Suppress autocomplete open/request while IME composition is in progress. */
  let mentionImeComposing = $state(false);

  function syncMentionAutocompleteFromSession() {
    const next = mentionAutocompleteSession.getState();
    const signature = `${next.outcome}:${next.pendingRequestId ?? ''}:${next.items.map((i) => i.id).join('|')}`;
    // Seed/clamp active option when the item set or outcome changes; keep user
    // highlight stable across identical paints.
    if (signature !== lastMentionItemsSignature) {
      lastMentionItemsSignature = signature;
      if (next.outcome === 'ready' && next.items.length > 0) {
        mentionActiveIndex = clampFileMentionActiveIndex(0, next.items.length);
      } else {
        mentionActiveIndex = -1;
      }
    } else if (next.items.length > 0) {
      mentionActiveIndex = clampFileMentionActiveIndex(mentionActiveIndex, next.items.length);
    } else {
      mentionActiveIndex = -1;
    }
    mentionAutocomplete = next;
  }

  function closeFileMentionPopup() {
    mentionAutocompleteSession.reset();
    lastMentionItemsSignature = '';
    mentionActiveIndex = -1;
    syncMentionAutocompleteFromSession();
  }

  function scrollActiveMentionOptionIntoView(index: number) {
    if (!mentionListboxRegion || index < 0) return;
    const option = mentionListboxRegion.querySelector(`#${fileMentionOptionId(index)}`);
    if (option instanceof HTMLElement) {
      option.scrollIntoView({ block: 'nearest' });
    }
  }

  function acceptFileMentionAtIndex(index: number) {
    const item = mentionAutocomplete.items[index];
    if (!item) return;
    selectFileMentionSuggestion(item);
  }

  /** Keep textarea focus when clicking an option (mousedown before blur). */
  function onMentionOptionMouseDown(e: MouseEvent) {
    e.preventDefault();
  }

  function onMentionOptionMouseEnter(index: number) {
    mentionActiveIndex = index;
  }

  function onComposerTextareaBlur(e: FocusEvent) {
    // Close when focus leaves the composer input, but not when moving into the
    // listbox region (mousedown already preserves focus; pointerdown outside closes).
    const related = e.relatedTarget;
    if (related instanceof Node && mentionListboxRegion?.contains(related)) return;
    if (mentionAutocomplete.open) {
      closeFileMentionPopup();
    }
  }

  function notifyMentionAutocompleteCaret() {
    // IME composition must not open the popup or post host requests mid-composition.
    if (mentionImeComposing) {
      if (mentionAutocomplete.open || mentionAutocomplete.pendingRequestId) {
        closeFileMentionPopup();
      }
      return;
    }
    const caret = textareaEl?.selectionStart ?? draftText.length;
    mentionAutocompleteSession.onCaretChange({
      text: draftText,
      caret,
      canSend,
      taskId: mode === 'task' ? taskId : undefined,
    });
    syncMentionAutocompleteFromSession();
  }

  function onMentionCompositionStart() {
    mentionImeComposing = true;
    if (mentionAutocomplete.open || mentionAutocomplete.pendingRequestId) {
      closeFileMentionPopup();
    }
  }

  function onMentionCompositionEnd() {
    mentionImeComposing = false;
    // Re-evaluate caret after composition commits (email-like / @query may now be valid).
    notifyMentionAutocompleteCaret();
  }

  const mentionAutocompleteSession = createFileMentionAutocompleteSession({
    post,
  });

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
    mentionBindings = new Map(prefill.mentionBindings ?? []);
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

  /** Task-mode picker is always interactive; chrome only reflects in-flight handoff. */
  const handoffInFlight = $derived(
    mode === 'task' && isHandoffProgressInFlight(tasks.focusedTask?.handoffProgress),
  );

  // Register select so resolveBackendForSend can read it for draft sends.
  $effect(() => {
    registerBackendSelect(backendSelect);
  });

  // Native listeners (capture) — vscode-elements change can miss Svelte onchange.
  $effect(() => {
    const el = backendSelect as (HTMLElement & { value: string }) | undefined;
    if (!el) return;
    postDebug('picker.mounted', {
      mode,
      testId: el.getAttribute('data-testid'),
      value: el.value,
      disabled: el.hasAttribute('disabled'),
      focusedTaskId: tasks.focusedTask?.id ?? null,
      focusedBackend: tasks.focusedTask?.backend ?? null,
      focusedModel: tasks.focusedTask?.model ?? null,
    });
    const onAny = (e: Event) => {
      postDebug(`picker.dom_${e.type}`, {
        mode,
        value: (e.currentTarget as HTMLElement & { value?: string })?.value ?? el.value,
        isTrusted: e.isTrusted,
        focusedTaskId: tasks.focusedTask?.id ?? null,
        focusedBackend: tasks.focusedTask?.backend ?? null,
        focusedModel: tasks.focusedTask?.model ?? null,
      });
      // Only handle change here (input is noisy/duplicate). Svelte onchange also
      // fires; dedupe in onBackendChange.
      if (e.type === 'change') {
        onBackendChange(e);
      }
    };
    el.addEventListener('change', onAny, true);
    el.addEventListener('click', onAny, true);
    return () => {
      el.removeEventListener('change', onAny, true);
      el.removeEventListener('click', onAny, true);
    };
  });

  $effect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data;
      if (msg?.type === 'fileMentionSuggestions') {
        mentionAutocompleteSession.onResponse(msg as FileMentionSuggestionsMessage);
        syncMentionAutocompleteFromSession();
        return;
      }
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
    if (!canSend) {
      closeFileMentionPopup();
    }
  });

  // Close autocomplete when focus target / draft-vs-task mode changes.
  $effect(() => {
    void mode;
    void taskId;
    closeFileMentionPopup();
  });

  // Scroll the active option into view when keyboard highlight moves.
  $effect(() => {
    if (!mentionAutocomplete.open || mentionActiveIndex < 0) return;
    queueMicrotask(() => scrollActiveMentionOptionIntoView(mentionActiveIndex));
  });

  $effect(() => {
    if (!isAddContextMenuOpen && !mentionAutocomplete.open) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Node && addContextMenuRegion?.contains(target)) return;
      if (target instanceof Node && mentionListboxRegion?.contains(target)) return;
      closeAddContextMenu();
      if (mentionAutocomplete.open) {
        closeFileMentionPopup();
      }
    }

    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  const mentionStatus = $derived(fileMentionStatusText(mentionAutocomplete.outcome));
  const mentionActiveDescendant = $derived(
    resolveFileMentionActiveDescendant(mentionActiveIndex, mentionAutocomplete.items.length),
  );
  const mentionPopupVisible = $derived(
    mentionAutocomplete.open &&
      (mentionAutocomplete.items.length > 0 ||
        mentionAutocomplete.outcome === 'empty' ||
        mentionAutocomplete.outcome === 'error'),
  );

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
        mentionBindings:
          mentionBindings.size > 0 ? Array.from(mentionBindings.entries()) : undefined,
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

    // Prefer live picker selection so a model switch that didn't fire handoff
    // still reaches the host (send path will hand off when binding differs).
    const rawPicker = backendSelect?.value ?? '';
    const pickerBackend = parseBackendId(rawPicker);
    const pickerModel = parseModelFromSelectValue(rawPicker);

    if (intent.kind === 'sendLiveInput') {
      // Interrupt & send: host reserves follow-up then interrupts live turn.
      const message = buildTaskComposerMessage(intent, {
        taskId,
        text: displayText,
        llmText,
        ...(pickerBackend ? { backend: pickerBackend } : {}),
        ...(pickerModel ? { model: pickerModel } : {}),
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
      ...(pickerBackend ? { backend: pickerBackend } : {}),
      ...(pickerModel ? { model: pickerModel } : {}),
    });
    if (!payload || payload.type !== 'send') return;
    if (payload.clientRequestId) {
      outboxAdd(vscode, {
        clientRequestId: payload.clientRequestId,
        taskId,
        text: displayText,
        llmText: llmText !== displayText ? llmText : undefined,
        mentionBindings:
          mentionBindings.size > 0 ? Array.from(mentionBindings.entries()) : undefined,
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
    closeFileMentionPopup();
    queueMicrotask(() => {
      textareaEl?.focus();
      textareaEl?.setSelectionRange(caret, caret);
      syncHighlightScroll();
    });
  }

  /** Mouse selection of a host suggestion: files insert; directories refine and re-query. */
  function selectFileMentionSuggestion(item: FileMentionSuggestionItem) {
    if (!canSend) return;
    const active = mentionAutocompleteSession.getState().activeQuery;
    if (!active) return;

    if (item.kind === 'directory') {
      const refined = refineActiveFileMentionDirectory(
        draftText,
        { start: active.start, end: active.end },
        item.insertionPath,
      );
      draftText = refined.text;
      // Clear prior list while the refined directory query is requested.
      closeFileMentionPopup();
      queueMicrotask(() => {
        textareaEl?.focus();
        textareaEl?.setSelectionRange(refined.caret, refined.caret);
        syncHighlightScroll();
        // Re-parse @insertionPath/ and request children under that directory.
        notifyMentionAutocompleteCaret();
      });
      return;
    }

    if (item.kind !== 'file') return;
    const { token } = allocateDisplayToken(mentionBindings, item.insertionPath, item.label);
    if (!token) return;
    const replaced = replaceActiveFileMentionQuery(draftText, { start: active.start, end: active.end }, token);
    draftText = replaced.text;
    closeFileMentionPopup();
    queueMicrotask(() => {
      textareaEl?.focus();
      textareaEl?.setSelectionRange(replaced.caret, replaced.caret);
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
    notifyMentionAutocompleteCaret();
  }

  function onDraftSelectOrKeyup(e?: Event) {
    // Arrow/Enter/Tab/Escape keyups must not re-run caret sync while the popup
    // is open — that would re-enter the autocomplete session and can reset the
    // keyboard highlight (activeIndex) or briefly clear items.
    if (
      mentionAutocomplete.open &&
      e instanceof KeyboardEvent &&
      (e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'Enter' ||
        e.key === 'Tab' ||
        e.key === 'Escape')
    ) {
      return;
    }
    notifyMentionAutocompleteCaret();
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

    // File-mention popup policy composes ahead of composer submit (T01/T02).
    const mentionKeyOpts = {
      popupOpen: mentionAutocomplete.open,
      itemCount: mentionAutocomplete.items.length,
      activeIndex: mentionActiveIndex,
      activeSelectable:
        mentionActiveIndex >= 0 &&
        mentionActiveIndex < mentionAutocomplete.items.length,
    };
    const mentionIntent = resolveFileMentionKeyIntent(policyInput, mentionKeyOpts);
    if (mentionIntent.kind !== 'none') {
      if (shouldPreventDefaultForFileMentionKey(policyInput, mentionKeyOpts)) {
        e.preventDefault();
      }
      if (mentionIntent.kind === 'dismiss') {
        closeFileMentionPopup();
        return;
      }
      if (mentionIntent.kind === 'move') {
        mentionActiveIndex = mentionIntent.activeIndex;
        queueMicrotask(() => scrollActiveMentionOptionIntoView(mentionIntent.activeIndex));
        return;
      }
      if (mentionIntent.kind === 'accept') {
        acceptFileMentionAtIndex(mentionIntent.activeIndex);
        return;
      }
    }
    // Open empty/error popup: pure policy returns none (no option to accept),
    // but Enter/Tab must not fall through to send until the popup is dismissed.
    if (
      mentionAutocomplete.open &&
      (e.key === 'Enter' || e.key === 'Tab') &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      return;
    }

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
      : (tasks.focusedTask?.model ?? tasks.selectedModel),
  );

  /**
   * Task-mode picker value: optimistic pending handoff target when set for this
   * task, else the host-bound task backend/model.
   */
  const taskPickerValue = $derived.by(() => {
    const focused = tasks.focusedTask;
    const pending =
      focused &&
      tasks.pendingHandoffTarget &&
      tasks.pendingHandoffTarget.taskId === focused.id
        ? tasks.pendingHandoffTarget
        : null;
    return encodePickerValue(
      pending?.backend ?? focused?.backend ?? currentBackend,
      pending?.model ?? focused?.model ?? null,
      tasks.modelsByBackend,
    );
  });

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

  /** Width from longest option label so long opencode model ids are not clipped. */
  const pickerWidthStyle = $derived.by(() => {
    let maxChars = 12;
    for (const opt of pickerOptions) {
      if (opt.label.length > maxChars) maxChars = opt.label.length;
    }
    // ~7.2px per char + chevron/padding as the preferred width. min-width:0 lets
    // the control shrink in narrow webviews so it never pushes the send button
    // off-screen; the open dropdown popup still shows the full labels.
    const px = Math.min(Math.max(Math.ceil(maxChars * 7.2 + 36), 140), 420);
    return `width: ${px}px; min-width: 0; max-width: min(100%, 420px);`;
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

  // Sync select value only when remount key or bound task binding changes.
  // Never continuously overwrite on every effect tick — that fights the open
  // dropdown / user pick and makes the task picker feel unclickable.
  let lastForcedRemountKey = '';
  let lastTaskBindingKey = '';
  $effect(() => {
    const el = backendSelect as
      | (HTMLElement & { value: string; open?: boolean })
      | undefined;
    const key = pickerRemountKey;
    if (!el) return;
    // Never force value while the dropdown is open (closes/fights the click).
    if (el.open === true || el.getAttribute('aria-expanded') === 'true') {
      return;
    }
    if (mode === 'task') {
      const bindingKey = `${tasks.focusedTask?.id ?? ''}:${taskPickerValue}`;
      // Remount or host-confirmed binding change only (not optimistic user pick).
      if (key === lastForcedRemountKey && bindingKey === lastTaskBindingKey && el.value) {
        return;
      }
      lastForcedRemountKey = key;
      lastTaskBindingKey = bindingKey;
      try {
        el.value = taskPickerValue;
      } catch {
        // best-effort
      }
      return;
    }
    const next = currentPickerValue;
    if (key === lastForcedRemountKey && el.value) return;
    lastForcedRemountKey = key;
    try {
      el.value = next;
    } catch {
      // best-effort
    }
  });

  // Ensure host starts enumeration whenever draft or task composer is shown.
  let modelsRequested = false;
  $effect(() => {
    const needModels = mode === 'draft' || mode === 'task';
    if (needModels && !modelsRequested) {
      modelsRequested = true;
      post({ type: 'listModels' });
    }
    if (!needModels) {
      modelsRequested = false;
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

  function sameBinding(
    backend: string,
    model: string | null | undefined,
    task: TaskSummary | undefined,
  ): boolean {
    if (!task) return false;
    const taskModel = typeof task.model === 'string' && task.model.trim() ? task.model.trim() : '';
    const nextModel = typeof model === 'string' && model.trim() ? model.trim() : '';
    return task.backend === backend && taskModel === nextModel;
  }

  function revertTaskPicker(el: (HTMLElement & { value: string }) | undefined): void {
    try {
      if (el) el.value = taskPickerValue;
    } catch {
      // best-effort
    }
  }

  /** Deduplicate change+input double-fire from vscode-single-select. */
  let lastHandoffRequestKey = '';
  let lastHandoffRequestAt = 0;

  function onBackendChange(e: Event) {
    // vscode-single-select dispatches `new Event('change')` so isTrusted is always
    // false even for real user clicks — never filter on isTrusted.
    // Prefer change over input to avoid double handoff (input often follows change).
    if (e.type === 'input') {
      return;
    }
    const el = (e.currentTarget ?? backendSelect) as (HTMLElement & { value: string }) | undefined;
    const raw = el?.value ?? '';
    postDebug('picker.change_handler', {
      type: e.type,
      raw,
      isTrusted: e.isTrusted,
      mode,
      focusedTaskId: tasks.focusedTask?.id ?? null,
      focusedBackend: tasks.focusedTask?.backend ?? null,
      focusedModel: tasks.focusedTask?.model ?? null,
      pendingHandoff: tasks.pendingHandoffTarget,
    });
    const sep = raw.indexOf('::');
    if (sep >= 0) {
      const backend = raw.slice(0, sep);
      const model = raw.slice(sep + 2);
      if (BACKEND_IDS.includes(backend)) {
        if (mode === 'draft') {
          postDebug('picker.draft_setModelSelection', { backend, model });
          tasks.setModelSelection(backend as WebviewBackendId, model);
          return;
        }
        // Existing task: changing model always requests handoff (never chat).
        const focused = tasks.focusedTask;
        if (!focused) {
          postDebug('picker.no_focused_task', { raw });
          revertTaskPicker(el);
          return;
        }
        if (sameBinding(backend, model, focused)) {
          postDebug('picker.same_binding', {
            backend,
            model,
            taskBackend: focused.backend,
            taskModel: focused.model ?? null,
          });
          revertTaskPicker(el);
          return;
        }
        const key = `${focused.id}|${backend}|${model}`;
        const now = Date.now();
        if (key === lastHandoffRequestKey && now - lastHandoffRequestAt < 1500) {
          postDebug('picker.handoff_deduped', { key });
          return;
        }
        lastHandoffRequestKey = key;
        lastHandoffRequestAt = now;
        postDebug('picker.request_handoff', {
          taskId: focused.id,
          from: { backend: focused.backend, model: focused.model ?? null },
          to: { backend, model },
        });
        tasks.requestRuntimeHandoff(focused.id, backend, model);
      } else {
        postDebug('picker.backend_not_in_ids', { backend, raw });
      }
    } else if (BACKEND_IDS.includes(raw)) {
      if (mode === 'draft') {
        postDebug('picker.draft_setBackend', { backend: raw });
        tasks.setBackend(raw as WebviewBackendId);
        return;
      }
      const focused = tasks.focusedTask;
      if (!focused) {
        postDebug('picker.no_focused_task', { raw });
        revertTaskPicker(el);
        return;
      }
      if (sameBinding(raw, null, focused)) {
        postDebug('picker.same_binding_backend_only', {
          backend: raw,
          taskBackend: focused.backend,
          taskModel: focused.model ?? null,
        });
        revertTaskPicker(el);
        return;
      }
      const key = `${focused.id}|${raw}|`;
      const now = Date.now();
      if (key === lastHandoffRequestKey && now - lastHandoffRequestAt < 1500) {
        postDebug('picker.handoff_deduped', { key });
        return;
      }
      lastHandoffRequestKey = key;
      lastHandoffRequestAt = now;
      postDebug('picker.request_handoff_backend_only', {
        taskId: focused.id,
        from: { backend: focused.backend, model: focused.model ?? null },
        to: { backend: raw, model: null },
      });
      tasks.requestRuntimeHandoff(focused.id, raw, null);
    } else {
      postDebug('picker.unparsed', { raw, isTrusted: e.isTrusted });
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
      onkeyup={onDraftSelectOrKeyup}
      onselect={onDraftSelectOrKeyup}
      onclick={onDraftSelectOrKeyup}
      onblur={onComposerTextareaBlur}
      oncompositionstart={onMentionCompositionStart}
      oncompositionend={onMentionCompositionEnd}
      spellcheck="true"
      aria-autocomplete="list"
      aria-controls={mentionPopupVisible ? FILE_MENTION_LISTBOX_ID : undefined}
      aria-expanded={mentionPopupVisible ? 'true' : 'false'}
      aria-haspopup="listbox"
      aria-activedescendant={mentionPopupVisible ? mentionActiveDescendant : undefined}
    ></textarea>

    {#if mentionPopupVisible}
      <div
        bind:this={mentionListboxRegion}
        id={FILE_MENTION_LISTBOX_ID}
        class="file-mention-listbox"
        role="listbox"
        aria-label={FILE_MENTION_LISTBOX_LABEL}
        data-testid="file-mention-listbox"
        data-outcome={mentionAutocomplete.outcome}
      >
        {#if mentionStatus}
          <div
            class="file-mention-listbox__status"
            role="status"
            aria-live="polite"
            data-testid="file-mention-status"
          >
            {mentionStatus}
          </div>
        {/if}
        {#each mentionAutocomplete.items as item, index (item.id)}
          <button
            type="button"
            id={fileMentionOptionId(index)}
            class="file-mention-listbox__item"
            class:file-mention-listbox__item--directory={item.kind === 'directory'}
            class:file-mention-listbox__item--active={index === mentionActiveIndex}
            role="option"
            aria-selected={index === mentionActiveIndex ? 'true' : 'false'}
            aria-label={item.kind === 'directory' ? `${item.label}/` : item.label}
            tabindex="-1"
            data-testid="file-mention-option"
            data-kind={item.kind}
            data-insertion-path={item.insertionPath}
            onmousedown={onMentionOptionMouseDown}
            onmouseenter={() => onMentionOptionMouseEnter(index)}
            onclick={() => selectFileMentionSuggestion(item)}
          >
            <span class="file-mention-listbox__item-label">
              {item.kind === 'directory' ? `${item.label}/` : item.label}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="flex items-center justify-between gap-2 pt-1" onkeydown={onKeydown}>
    <div class="flex items-center gap-1.5 min-w-0">
      {#if mode === 'draft' || mode === 'task'}
        {#key `${mode}:${pickerRemountKey}`}
          <vscode-single-select
            bind:this={backendSelect}
            data-testid={mode === 'task' ? 'task-model-switch' : 'draft-model-picker'}
            use:tip={
              mode === 'draft'
                ? modelsLoaded
                  ? 'Select backend + model for the new task'
                  : 'Loading models from installed CLIs… (shows backends first)'
                : handoffInFlight
                  ? 'Model switch in progress… (picker stays available)'
                  : modelsLoaded
                    ? 'Switch backend + model for this task (handoff)'
                    : 'Loading models from installed CLIs…'
            }
            disabled={mode === 'draft' ? thread.running : false}
            position="above"
            onchange={onBackendChange}
            style={pickerWidthStyle}
          >
            {#each pickerOptions as opt (opt.value)}
              <vscode-option
                value={opt.value}
                selected={opt.value === (mode === 'draft' ? currentPickerValue : taskPickerValue)}
                >{opt.label}</vscode-option
              >
            {/each}
          </vscode-single-select>
        {/key}
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
    </div>

    <div class="flex items-center gap-2 shrink-0">
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
