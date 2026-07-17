import type { NormalizedEvent } from './types';
import type {
  TaskRuntimeActivity,
  TaskViewStatus,
  TranscriptItem,
  TranscriptPageErrorCode,
  TranscriptPageResultMessage,
  TranscriptPageState,
} from './protocol';
import type { ThreadItem } from './turn-state.svelte';
import {
  applyTranscriptPageResult,
  beginLoadOlder,
  ownershipFromTranscript,
  type TranscriptPageWindowState,
} from './transcript-page-reducer';

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  return (content as { text?: string })?.text ?? '';
}

function transcriptToThreadItem(item: TranscriptItem): ThreadItem | null {
  switch (item.kind) {
    case 'user':
      return {
        kind: 'user',
        id: item.id,
        text: asText(item.content),
        turnId: item.turnId,
        order: item.order,
      };
    case 'assistant':
      return {
        kind: 'assistant',
        id: item.id,
        text: asText(item.content),
        turnId: item.turnId,
        order: item.order,
      };
    case 'error': {
      const content = item.content as { message?: string; isCancellation?: boolean } | string;
      const message = typeof content === 'string' ? content : (content?.message ?? 'Error');
      const isCancellation = typeof content === 'object' ? content?.isCancellation : false;
      return { kind: 'error', id: item.id, message, isCancellation };
    }
    case 'tool': {
      const t = item.content as {
        toolCallId?: string;
        name?: string;
        toolKind?: 'mcp' | 'builtin' | 'other';
        status?: 'running' | 'success' | 'error';
        input?: unknown;
        output?: unknown;
        error?: string;
      };
      return {
        kind: 'tool',
        id: item.id,
        name: t?.name ?? 'tool',
        toolKind: t?.toolKind,
        status: t?.status ?? 'success',
        input: t?.input,
        output: t?.output,
        error: t?.error,
        turnId: item.turnId,
        order: item.order,
      };
    }
    // reasoning items are collected separately (turn-scoped header), not as list items
    default:
      return null;
  }
}

/** Per-task streaming thread (docs/WEBVIEW-IMPROVEMENT-PLAN §5.2 / §5.4). */
export class TaskThread {
  items = $state<ThreadItem[]>([]);
  streaming = $state<{ messageId: string; text: string } | null>(null);
  /** Reasoning is turn-scoped: turnId -> accumulated reasoning text (rendered in header). */
  reasoningByTurn = $state<Record<string, string>>({});
  running = $state(false);
  activeTurnId = $state<string | null>(null);
  readOnly = $state(false);
  /** True after any turn process was started for this task (CLI was created at least once). */
  hadProcess = $state(false);
  /**
   * Monotonic activity counter bumped on every applied event. Lets the view track
   * in-place content growth (reasoning appends, tool status/input/output changes)
   * that does not alter `items.length` or `streaming.text` — used for autoscroll.
   */
  revision = $state(0);
  /**
   * W4/W5 transcript page metadata for the focused thread. The transcript is a
   * bounded latest-N page plus optional older pages prepended via
   * loadTranscriptPage. Hydrate/focus replaces the window; reset clears it.
   */
  beforeCursor = $state<string | undefined>(undefined);
  hasMoreBefore = $state(false);
  transcriptWorkspaceRevision = $state<number | undefined>(undefined);
  /** Ownership of transcript entity IDs (list + reasoning) for idempotent prepend. */
  private loadedTranscriptIds = new Set<string>();
  olderPageLoading = $state(false);
  pendingRequestId = $state<string | undefined>(undefined);
  pendingTaskId = $state<string | undefined>(undefined);
  pendingCursor = $state<string | undefined>(undefined);
  olderPageError = $state<TranscriptPageErrorCode | undefined>(undefined);
  lastAppliedRequestId = $state<string | undefined>(undefined);

  private pageWindowState(): TranscriptPageWindowState {
    return {
      items: this.items,
      reasoningByTurn: this.reasoningByTurn,
      loadedTranscriptIds: this.loadedTranscriptIds,
      beforeCursor: this.beforeCursor,
      hasMoreBefore: this.hasMoreBefore,
      transcriptWorkspaceRevision: this.transcriptWorkspaceRevision,
      olderPageLoading: this.olderPageLoading,
      pendingRequestId: this.pendingRequestId,
      pendingTaskId: this.pendingTaskId,
      pendingCursor: this.pendingCursor,
      olderPageError: this.olderPageError,
      lastAppliedRequestId: this.lastAppliedRequestId,
    };
  }

  private applyPageWindowState(state: TranscriptPageWindowState): void {
    this.items = state.items;
    this.reasoningByTurn = state.reasoningByTurn;
    this.loadedTranscriptIds = new Set(state.loadedTranscriptIds);
    this.beforeCursor = state.beforeCursor;
    this.hasMoreBefore = state.hasMoreBefore;
    this.transcriptWorkspaceRevision = state.transcriptWorkspaceRevision;
    this.olderPageLoading = state.olderPageLoading;
    this.pendingRequestId = state.pendingRequestId;
    this.pendingTaskId = state.pendingTaskId;
    this.pendingCursor = state.pendingCursor;
    this.olderPageError = state.olderPageError;
    this.lastAppliedRequestId = state.lastAppliedRequestId;
  }

  hydrate(
    transcript: TranscriptItem[],
    activeTurnId?: string,
    viewStatus?: TaskViewStatus,
    opts?: {
      lifecycle?: string;
      runtimeActivity?: TaskRuntimeActivity | null;
      transcriptPage?: TranscriptPageState;
    },
  ): void {
    // Keep the live streaming buffer only if it belongs to the still-active turn and
    // corresponds to a persisted `partial` assistant segment of the same id — the
    // buffer supersedes that transcript item (avoids a double bubble).
    const keepStreaming =
      !!this.streaming &&
      !!activeTurnId &&
      this.activeTurnId === activeTurnId &&
      transcript.some(
        (t) => t.kind === 'assistant' && t.state === 'partial' && t.id === this.streaming!.messageId,
      );

    const next: ThreadItem[] = [];
    const reasoning: Record<string, string> = {};
    for (const item of transcript) {
      if (item.kind === 'reasoning') {
        if (item.turnId) reasoning[item.turnId] = asText(item.content);
        continue;
      }
      if (keepStreaming && item.kind === 'assistant' && item.id === this.streaming!.messageId) {
        continue; // superseded by the live streaming buffer
      }
      const mapped = transcriptToThreadItem(item);
      if (mapped) next.push(mapped);
    }

    this.items = next;
    this.reasoningByTurn = reasoning;
    this.loadedTranscriptIds = ownershipFromTranscript(transcript);
    if (!keepStreaming) this.streaming = null;
    this.activeTurnId = activeTurnId ?? null;
    // Replace transcript-page metadata on every hydrate/focus (protocol v6+).
    this.beforeCursor = opts?.transcriptPage?.beforeCursor;
    this.hasMoreBefore = opts?.transcriptPage?.hasMoreBefore ?? false;
    this.transcriptWorkspaceRevision = opts?.transcriptPage?.workspaceRevision;
    // Focus/hydrate invalidates any in-flight older-page request for this window.
    this.olderPageLoading = false;
    this.pendingRequestId = undefined;
    this.pendingTaskId = undefined;
    this.pendingCursor = undefined;
    this.olderPageError = undefined;
    this.lastAppliedRequestId = undefined;
    const runtime = opts?.runtimeActivity ?? (viewStatus === 'running' || viewStatus === 'waiting_user' ? viewStatus : null);
    this.running = runtime === 'running' || runtime === 'waiting_user';
    // Restore "had a process" after reload: live/recovery runtime, or any transcript
    // (implies a prior turn). Composer also treats committedSessionId as hadProcess.
    if (this.running || runtime === 'needs_recovery' || next.length > 0) {
      this.hadProcess = true;
    }
    // Terminal tasks stay writable: send reopens the same task to open.
    this.readOnly = false;
  }

  reset(): void {
    this.items = [];
    this.streaming = null;
    this.reasoningByTurn = {};
    this.running = false;
    this.activeTurnId = null;
    this.readOnly = false;
    this.hadProcess = false;
    this.beforeCursor = undefined;
    this.hasMoreBefore = false;
    this.transcriptWorkspaceRevision = undefined;
    this.loadedTranscriptIds = new Set();
    this.olderPageLoading = false;
    this.pendingRequestId = undefined;
    this.pendingTaskId = undefined;
    this.pendingCursor = undefined;
    this.olderPageError = undefined;
    this.lastAppliedRequestId = undefined;
  }

  /**
   * Begin a single in-flight older-page request when cursor/hasMore allow it.
   * Returns the outbound payload fields, or null when the request is refused.
   */
  beginLoadOlder(taskId: string, requestId: string): {
    requestId: string;
    taskId: string;
    beforeCursor: string;
  } | null {
    const result = beginLoadOlder(this.pageWindowState(), { taskId, requestId });
    this.applyPageWindowState(result.state);
    if (!result.ok) return null;
    return {
      requestId: result.requestId,
      taskId: result.taskId,
      beforeCursor: result.beforeCursor,
    };
  }

  /** Apply a host transcriptPageResult with focus + request correlation. */
  applyTranscriptPageResult(
    message: TranscriptPageResultMessage,
    focusedTaskId: string | null,
  ): boolean {
    const result = applyTranscriptPageResult(this.pageWindowState(), message, focusedTaskId);
    if (result.applied) {
      this.applyPageWindowState(result.state);
      if (result.kind === 'success') this.revision++;
    }
    return result.applied;
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  appendTranscript(item: TranscriptItem): void {
    this.loadedTranscriptIds.add(item.id);
    if (item.kind === 'reasoning') {
      if (item.turnId) this.reasoningByTurn[item.turnId] = asText(item.content);
      return;
    }
    // Idempotent: turnStart + snapshot hydrate may both project the same user message.
    if (this.items.some((existing) => existing.id === item.id)) {
      return;
    }
    const mapped = transcriptToThreadItem(item);
    if (mapped) this.items.push(mapped);
  }

  startTurn(turnId: string): void {
    this.running = true;
    this.activeTurnId = turnId;
    this.hadProcess = true;
  }

  endTurn(): void {
    this.commitStreaming();
    this.running = false;
    this.activeTurnId = null;
    this.hadProcess = true;
  }

  pushError(message: string, isCancellation = false): void {
    this.commitStreaming();
    const id = `err-${Date.now()}`;
    this.loadedTranscriptIds.add(id);
    this.items.push({ kind: 'error', id, message, isCancellation });
  }

  private commitStreaming(): void {
    if (this.streaming && this.streaming.text.length > 0) {
      const id = this.streaming.messageId;
      // The segment id is the deterministic `${turnId}:${order}`. Recover turnId/order so
      // a committed *live* bubble carries the same turn linkage as a *restored* transcript
      // item — the per-turn reasoning header requires `turnId`, and without it live vs.
      // restored rendering would diverge.
      let turnId = this.activeTurnId ?? undefined;
      let order: number | undefined;
      if (turnId && id.startsWith(`${turnId}:`)) {
        const n = Number(id.slice(turnId.length + 1));
        if (Number.isFinite(n)) order = n;
      } else {
        // Fallback: split at the last colon (turnId may itself contain colons).
        const lastColon = id.lastIndexOf(':');
        if (lastColon > 0) {
          const n = Number(id.slice(lastColon + 1));
          if (Number.isFinite(n)) {
            turnId = id.slice(0, lastColon);
            order = n;
          }
        }
      }
      // messageId is the deterministic segment id; dedupe by id.
      this.loadedTranscriptIds.add(id);
      const existing = this.items.find((it) => it.id === id);
      if (existing && existing.kind === 'assistant') {
        existing.text = this.streaming.text;
        existing.turnId ??= turnId;
        existing.order ??= order;
      } else {
        this.items.push({ kind: 'assistant', id, text: this.streaming.text, turnId, order });
      }
    }
    this.streaming = null;
  }

  private findTool(id: string): Extract<ThreadItem, { kind: 'tool' }> | undefined {
    for (const it of this.items) {
      if (it.kind === 'tool' && it.id === id) return it;
    }
    return undefined;
  }

  /** Reduce one NormalizedEvent into the thread. */
  applyEvent(ev: NormalizedEvent): void {
    switch (ev.type) {
      case 'assistantDelta':
        if (!this.streaming || this.streaming.messageId !== ev.messageId) {
          this.commitStreaming();
          // If a persisted partial segment with this id is already an item (e.g. after
          // a hide/show re-hydrate mid-stream), absorb it into the buffer to avoid a
          // duplicate bubble; the buffer then continues appending live deltas.
          const idx = this.items.findIndex((it) => it.kind === 'assistant' && it.id === ev.messageId);
          let seed = '';
          if (idx >= 0) {
            const it = this.items[idx];
            if (it.kind === 'assistant') seed = it.text;
            this.items.splice(idx, 1);
          }
          // Own the live segment id so older pages cannot prepend a stale duplicate.
          this.loadedTranscriptIds.add(ev.messageId);
          this.streaming = { messageId: ev.messageId, text: seed };
        }
        this.streaming.text += ev.content;
        break;

      case 'raw': {
        // Historical/unknown raw lines are ignored (no concurrent inject path).
        break;
      }

      case 'reasoningDelta':
        if (this.activeTurnId) {
          // SQLite reasoning entity id is the turn id (activeTurnId), not the
          // backend messageId. Own it so older pages cannot overwrite live text.
          this.loadedTranscriptIds.add(this.activeTurnId);
          this.reasoningByTurn[this.activeTurnId] =
            (this.reasoningByTurn[this.activeTurnId] ?? '') + ev.content;
        }
        break;

      case 'toolStarted': {
        // A tool closes the current assistant segment (matches the engine).
        this.commitStreaming();
        if (!this.activeTurnId) break;
        const id = `${this.activeTurnId}:${ev.toolCallId}`;
        this.loadedTranscriptIds.add(id);
        const existing = this.findTool(id);
        if (existing) {
          existing.name = ev.name;
          existing.toolKind = ev.kind;
          existing.status = 'running';
          if (ev.input !== undefined) existing.input = ev.input;
        } else {
          this.items.push({
            kind: 'tool',
            id,
            turnId: this.activeTurnId,
            name: ev.name,
            toolKind: ev.kind,
            status: 'running',
            input: ev.input,
          });
        }
        break;
      }

      case 'toolUpdated': {
        if (!this.activeTurnId) break;
        const id = `${this.activeTurnId}:${ev.toolCallId}`;
        this.loadedTranscriptIds.add(id);
        const tool = this.findTool(id);
        if (tool) {
          if (ev.input !== undefined) tool.input = ev.input;
        } else {
          this.items.push({
            kind: 'tool',
            id,
            turnId: this.activeTurnId,
            name: 'tool',
            status: 'running',
            input: ev.input,
          });
        }
        break;
      }

      case 'toolCompleted': {
        if (!this.activeTurnId) break;
        const id = `${this.activeTurnId}:${ev.toolCallId}`;
        this.loadedTranscriptIds.add(id);
        const tool = this.findTool(id);
        const status = ev.outcome === 'error' ? 'error' : 'success';
        if (tool) {
          tool.status = status;
          if (ev.outcome === 'error') tool.error = ev.error;
          else tool.output = ev.output;
        } else {
          this.items.push({
            kind: 'tool',
            id,
            turnId: this.activeTurnId,
            name: 'tool',
            status,
            output: ev.outcome === 'error' ? undefined : ev.output,
            error: ev.outcome === 'error' ? ev.error : undefined,
          });
        }
        break;
      }

      case 'error':
        this.pushError(ev.message, ev.isCancellation ?? false);
        break;

      case 'turnCompleted':
        this.commitStreaming();
        break;

      case 'sessionStarted':
      case 'usage':
      case 'raw':
        break;
    }
    // Track in-place mutations (reasoning/tool) that don't change items/streaming length.
    this.revision++;
  }
}

/** Cap on retained inactive threads (P2-5). */
const MAX_CACHED_THREADS = 30;

class ThreadStore {
  private byTask = new Map<string, TaskThread>();
  current = $state<TaskThread>(new TaskThread());
  currentTaskId = $state<string | null>(null);

  private getOrCreate(taskId: string): TaskThread {
    let thread = this.byTask.get(taskId);
    if (!thread) {
      thread = new TaskThread();
      this.byTask.set(taskId, thread);
      this.evictIfNeeded();
    }
    return thread;
  }

  /** Evict inactive terminal/non-focused threads; never evict running/waiting. */
  private evictIfNeeded(): void {
    if (this.byTask.size <= MAX_CACHED_THREADS) return;
    for (const [taskId, thread] of this.byTask) {
      if (this.byTask.size <= MAX_CACHED_THREADS) break;
      if (taskId === this.currentTaskId) continue;
      if (thread.running || thread.activeTurnId) continue;
      this.byTask.delete(taskId);
    }
  }

  focusTask(
    taskId: string,
    transcript?: TranscriptItem[],
    activeTurnId?: string,
    viewStatus?: TaskViewStatus,
    opts?: {
      lifecycle?: string;
      runtimeActivity?: TaskRuntimeActivity | null;
      transcriptPage?: TranscriptPageState;
    },
  ): void {
    const thread = this.getOrCreate(taskId);
    this.current = thread;
    this.currentTaskId = taskId;
    if (transcript) {
      thread.hydrate(transcript, activeTurnId, viewStatus, opts);
    } else if (opts?.lifecycle || viewStatus) {
      // Terminal tasks stay writable (send reopens); never lock the composer here.
      thread.setReadOnly(false);
      const runtime = opts?.runtimeActivity;
      thread.running = runtime === 'running' || runtime === 'waiting_user';
    }
  }

  clearFocus(): void {
    this.current = new TaskThread();
    this.currentTaskId = null;
  }

  onTurnStart(taskId: string, turnId: string): void {
    this.getOrCreate(taskId).startTurn(turnId);
  }

  onEvent(taskId: string, turnId: string, event: NormalizedEvent): void {
    const thread = this.getOrCreate(taskId);
    if (turnId !== thread.activeTurnId) return;
    thread.applyEvent(event);
  }

  onTurnDone(taskId: string, turnId: string): void {
    const thread = this.getOrCreate(taskId);
    if (turnId !== thread.activeTurnId) return;
    thread.endTurn();
  }

  onTurnError(taskId: string, turnId: string, message: string): void {
    const thread = this.getOrCreate(taskId);
    if (turnId !== thread.activeTurnId) return;
    thread.pushError(message);
    thread.endTurn();
  }

  onTranscriptAppend(taskId: string, item: TranscriptItem): void {
    this.getOrCreate(taskId).appendTranscript(item);
  }

  /**
   * Start one older-page request for the focused thread. Enforces single
   * in-flight request + hasMore/cursor gates. Returns outbound fields or null.
   */
  beginLoadOlder(requestId: string): {
    requestId: string;
    taskId: string;
    beforeCursor: string;
  } | null {
    if (!this.currentTaskId) return null;
    return this.current.beginLoadOlder(this.currentTaskId, requestId);
  }

  /**
   * Apply transcriptPageResult only when task is focused and request correlates.
   * Stale/mismatched responses are no-ops.
   */
  onTranscriptPageResult(message: TranscriptPageResultMessage): boolean {
    if (!this.currentTaskId || message.taskId !== this.currentTaskId) {
      return false;
    }
    return this.current.applyTranscriptPageResult(message, this.currentTaskId);
  }

  updateReadOnly(_lifecycleOrViewStatus: string): void {
    // Terminal tasks stay writable; send reopens the same task to open.
    this.current.setReadOnly(false);
  }

  updateRuntimeFlags(runtimeActivity: TaskRuntimeActivity | null | undefined): void {
    this.current.running =
      runtimeActivity === 'running' || runtimeActivity === 'waiting_user';
  }
}

export const threadStore = new ThreadStore();
