import type { BackendModels, QueuedTurnProjection, SnapshotMessage, TaskSummary } from './protocol';
import { isHardTerminalLifecycle, post } from './protocol';
import { sortQueuedTurns } from './queued-turns';
import { parseBackendId, parseModelFromSelectValue } from './backend-resolve';
import { vscode } from './vscode';

export interface CommandErrorState {
  taskId: string | null;
  message: string;
}

/** Non-error status notice (e.g. live-input delivered acknowledgement). */
export interface CommandNoticeState {
  taskId: string | null;
  message: string;
}

/** Backends selectable from the webview toolbar. */
export type WebviewBackendId = 'claude' | 'grok' | 'kiro' | 'codex' | 'opencode';

class TasksState {
  /** All known tasks keyed by id (roots + subtree entries from snapshots/patches). */
  tasks = $state<Map<string, TaskSummary>>(new Map());
  focusedTaskId = $state<string | null>(null);
  subtree = $state<TaskSummary[]>([]);
  storeRevision = $state(0);

  /** Per-task watermark for stale taskUpdated guard (ISSUE-13). */
  private revisionWatermarks = $state<Map<string, number>>(new Map());

  /** Unpersisted composer — first send has no taskId. */
  draftMode = $state(false);

  /** Optional link when creating a draft after another task (legacy protocol field). */
  continuationOf = $state<string | null>(null);

  /**
   * User's preferred backend for new tasks (what we persist). May temporarily
   * differ from the picker display when that CLI is not currently detected.
   */
  preferredBackend = $state<WebviewBackendId>('claude');

  /** Preferred model for preferredBackend; null = backend default. */
  preferredModel = $state<string | null>(null);

  /**
   * Backend shown in the picker. Falls back to the first available CLI when
   * preferredBackend is missing from detection — without overwriting preference.
   */
  selectedBackend = $state<WebviewBackendId>('claude');

  /** Model shown for selectedBackend; null = backend default. */
  selectedModel = $state<string | null>(null);

  /** Backend ids the host reports as installed/callable; null = not yet known. */
  availableBackends = $state<string[] | null>(null);

  /** Per-backend model lists reported by the host; null = not yet enumerated. */
  modelsByBackend = $state<Record<string, BackendModels> | null>(null);

  commandError = $state<CommandErrorState | null>(null);

  /** Transient success/status notice (live-input delivered, etc.). */
  commandNotice = $state<CommandNoticeState | null>(null);

  /**
   * FIFO queued follow-ups for the focused task (host snapshot.queuedTurns).
   * Cleared on draft/blur; replaced on every focused snapshot so dispatch
   * removing an entry immediately drops edit/delete controls.
   */
  queuedTurns = $state<QueuedTurnProjection[]>([]);

  /**
   * One-shot prefill for the composer (queue Edit → message box).
   * Composer consumes and clears when `nonce` changes.
   * Optional clientRequestId: only clear matching rejected outbox on successful apply.
   */
  composerPrefill = $state<{ text: string; nonce: number; clientRequestId?: string } | null>(null);
  private prefillNonceSeq = 0;

  constructor() {
    // Restore the last-used backend/model from webview state (persists across reloads).
    // Host globalState may overwrite this shortly via applyHostComposerSelection.
    try {
      const saved = vscode.getState() as { selectedBackend?: unknown; selectedModel?: unknown } | undefined;
      const be = saved?.selectedBackend;
      if (be === 'claude' || be === 'grok' || be === 'kiro' || be === 'codex' || be === 'opencode') {
        this.preferredBackend = be;
        this.selectedBackend = be;
      }
      if (typeof saved?.selectedModel === 'string') {
        this.preferredModel = saved.selectedModel;
        this.selectedModel = saved.selectedModel;
      }
    } catch {
      // best-effort — fall back to defaults
    }
  }

  get rootTasks(): TaskSummary[] {
    const roots: TaskSummary[] = [];
    for (const task of this.tasks.values()) {
      if (task.parentId === null) roots.push(task);
    }
    roots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return roots;
  }

  get focusedTask(): TaskSummary | undefined {
    if (!this.focusedTaskId) return undefined;
    return this.tasks.get(this.focusedTaskId);
  }

  /** Hard terminal (succeeded/cancelled/skipped). Soft failed is separate. */
  get focusedIsTerminal(): boolean {
    const task = this.focusedTask;
    return task ? isHardTerminalLifecycle(task.lifecycle) : false;
  }

  get focusedIsSoftFailed(): boolean {
    return this.focusedTask?.lifecycle === 'failed';
  }

  setBackend(next: WebviewBackendId): void {
    // Switching backend drops the model selection (models are backend-specific).
    if (next !== this.preferredBackend) this.preferredModel = null;
    this.preferredBackend = next;
    this.syncDisplaySelection();
    this.persistSelection();
  }

  /** Select a specific (backend, model) pair from the grouped model picker. */
  setModelSelection(backend: WebviewBackendId, model: string): void {
    this.preferredBackend = backend;
    this.preferredModel = model;
    this.syncDisplaySelection();
    this.persistSelection();
  }

  setAvailableBackends(ids: string[]): void {
    this.availableBackends = ids;
    // Recompute display only — never overwrite preferredBackend/model.
    this.syncDisplaySelection();
  }

  setAvailableModels(models: Record<string, BackendModels>): void {
    this.modelsByBackend = models;
    this.syncDisplaySelection();
  }

  /**
   * Apply host-persisted last-used backend/model (survives restarts).
   * Host preference wins over ephemeral webview state.
   */
  applyHostComposerSelection(backend: string, model: string | null): void {
    if (
      backend !== 'claude' &&
      backend !== 'grok' &&
      backend !== 'kiro' &&
      backend !== 'codex' &&
      backend !== 'opencode'
    ) {
      return;
    }
    this.preferredBackend = backend;
    this.preferredModel = typeof model === 'string' && model.length > 0 ? model : null;
    this.syncDisplaySelection();
    this.persistLocalSelection();
  }

  /**
   * Map preferredBackend/model onto selectedBackend/model for the picker.
   * Falls back to the first detected backend when preferred is unavailable,
   * without mutating or persisting the preference.
   */
  private syncDisplaySelection(): void {
    const ids = this.availableBackends;
    if (ids && ids.length > 0 && !ids.includes(this.preferredBackend)) {
      this.selectedBackend = ids[0] as WebviewBackendId;
      this.selectedModel = null;
      return;
    }
    this.selectedBackend = this.preferredBackend;
    let model = this.preferredModel;
    if (model && this.modelsByBackend) {
      const opts = this.modelsByBackend[this.preferredBackend]?.options;
      if (!opts || !opts.some((o) => o.value === model)) {
        model = null;
      }
    }
    this.selectedModel = model;
  }

  private persistSelection(): void {
    this.persistLocalSelection();
    // Durable copy on the host — webview setState alone is lost on full restart.
    try {
      vscode.postMessage({
        type: 'setComposerSelection',
        backend: this.preferredBackend,
        model: this.preferredModel,
      });
    } catch {
      // best-effort
    }
  }

  private persistLocalSelection(): void {
    try {
      const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
      vscode.setState({
        ...prev,
        selectedBackend: this.preferredBackend,
        selectedModel: this.preferredModel,
      });
    } catch {
      // best-effort
    }
  }

  openNewTaskDraft(): void {
    this.draftMode = true;
    this.continuationOf = null;
    this.focusedTaskId = null;
    this.subtree = [];
    this.queuedTurns = [];
    // Keep last-used preferredBackend/model; only refresh display mapping.
    this.syncDisplaySelection();
  }

  openContinuationDraft(terminalTaskId: string): void {
    this.draftMode = true;
    this.continuationOf = terminalTaskId;
    this.focusedTaskId = null;
    this.subtree = [];
    this.queuedTurns = [];
  }

  clearDraft(): void {
    this.draftMode = false;
    this.continuationOf = null;
  }

  focusTask(taskId: string): void {
    this.draftMode = false;
    this.continuationOf = null;
    this.focusedTaskId = taskId;
    // Drop prior focus queue until the host snapshot for this task arrives.
    this.queuedTurns = [];
  }

  applySnapshot(snapshot: SnapshotMessage): void {
    this.storeRevision = snapshot.storeRevision;

    const next = new Map<string, TaskSummary>();
    for (const task of snapshot.rootTasks) {
      next.set(task.id, task);
      this.seedWatermark(task.id, snapshot.storeRevision);
    }
    if (snapshot.subtree) {
      for (const task of snapshot.subtree) {
        next.set(task.id, task);
        this.seedWatermark(task.id, snapshot.storeRevision);
      }
    }
    this.tasks = next;
    this.subtree = snapshot.subtree ?? [];

    if (snapshot.focusedTaskId) {
      this.focusedTaskId = snapshot.focusedTaskId;
      this.draftMode = false;
      this.continuationOf = null;
      this.queuedTurns = sortQueuedTurns(snapshot.queuedTurns ?? []);
    } else if (!this.draftMode) {
      this.queuedTurns = [];
    }
  }

  applyTaskUpdated(taskId: string, storeRevision: number, patch: Partial<TaskSummary>): void {
    const watermark = this.revisionWatermarks.get(taskId) ?? 0;
    if (storeRevision <= watermark) return;

    const existing = this.tasks.get(taskId);
    const merged: TaskSummary = {
      ...(existing ?? {
        id: taskId,
        parentId: null,
        goal: '',
        role: 'coordinator',
        lifecycle: 'open',
        runtimeActivity: 'idle',
        viewStatus: 'idle',
        currentTurnActivity: null,
        updatedAt: new Date(0).toISOString(),
        backend: '',
      }),
      ...patch,
      id: taskId,
    };
    this.tasks.set(taskId, merged);
    this.revisionWatermarks.set(taskId, storeRevision);
    this.storeRevision = Math.max(this.storeRevision, storeRevision);

    if (merged.parentId === null) {
      // root list is derived from tasks map
    } else if (this.focusedTaskId && this.subtree.some((t) => t.id === taskId)) {
      this.subtree = this.subtree.map((t) => (t.id === taskId ? merged : t));
    }
  }

  setCommandError(message: string | null, taskId: string | null = null): void {
    this.commandError = message ? { taskId, message } : null;
    // A refusal/error supersedes any prior success notice for the same chrome.
    if (message) this.commandNotice = null;
  }

  setCommandNotice(message: string | null, taskId: string | null = null): void {
    this.commandNotice = message ? { taskId, message } : null;
    // A delivered acknowledgement clears a prior refusal so success is visible.
    if (message) this.commandError = null;
  }

  /** Put text into the task/draft composer (used by queue Edit / rejected send restore). */
  prefillComposer(text: string, clientRequestId?: string): void {
    this.prefillNonceSeq += 1;
    this.composerPrefill = {
      text,
      nonce: this.prefillNonceSeq,
      ...(clientRequestId ? { clientRequestId } : {}),
    };
  }

  clearComposerPrefill(): void {
    this.composerPrefill = null;
  }

  /** Optimistic remove so Delete/Edit feedback is immediate before host snapshot. */
  removeQueuedTurnLocally(turnId: string): void {
    this.queuedTurns = this.queuedTurns.filter((turn) => turn.turnId !== turnId);
  }

  /**
   * Request a host-orchestrated runtime handoff (model/backend switch) on an
   * existing task. Progress arrives via TaskSummary.handoffProgress on
   * snapshot/taskUpdated — never as chat. Refusals use setCommandError via
   * commandError inbound messages.
   */
  requestRuntimeHandoff(
    taskId: string,
    targetBackend: string,
    targetModel?: string | null,
  ): void {
    this.setCommandError(null);
    const message: {
      type: 'requestRuntimeHandoff';
      taskId: string;
      targetBackend: string;
      targetModel?: string;
      skipSummary?: boolean;
    } = {
      type: 'requestRuntimeHandoff',
      taskId,
      targetBackend,
      skipSummary: true,
    };
    if (typeof targetModel === 'string' && targetModel.trim()) {
      message.targetModel = targetModel.trim();
    }
    post(message);
  }

  private seedWatermark(taskId: string, revision: number): void {
    const prev = this.revisionWatermarks.get(taskId) ?? 0;
    if (revision > prev) this.revisionWatermarks.set(taskId, revision);
  }
}

export const tasks = new TasksState();

let backendSelectEl: (HTMLElement & { value: string }) | undefined;

export function registerBackendSelect(el: (HTMLElement & { value: string }) | undefined): void {
  backendSelectEl = el;
}

/**
 * Backend for a draft send. The live select is authoritative when it has a
 * parseable value (`backend` or `backend::model`) — that is what the user sees.
 * preferredBackend is only a fallback when the select is missing/unmounted.
 */
export function resolveBackendForSend(): WebviewBackendId {
  return parseBackendId(backendSelectEl?.value) ?? tasks.preferredBackend;
}

/**
 * Model for a draft send. Prefer the encoded select value, then preferredModel
 * when it belongs to the resolved backend.
 */
export function resolveModelForSend(): string | null {
  const raw = backendSelectEl?.value;
  const fromDom = parseModelFromSelectValue(raw);
  if (fromDom) return fromDom;
  const backend = resolveBackendForSend();
  if (backend === tasks.preferredBackend) return tasks.preferredModel;
  return null;
}

/**
 * Sync preferred* from the live select (or current preferred) so persistence
 * and subsequent drafts match what was just sent.
 */
export function syncPreferenceFromSend(): { backend: WebviewBackendId; model: string | null } {
  const backend = resolveBackendForSend();
  const model = resolveModelForSend();
  if (model) {
    tasks.setModelSelection(backend, model);
  } else {
    tasks.setBackend(backend);
  }
  return { backend, model };
}