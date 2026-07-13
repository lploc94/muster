import type { BackendModels, QueuedTurnProjection, SnapshotMessage, TaskSummary } from './protocol';
import { isHardTerminalLifecycle } from './protocol';
import { sortQueuedTurns } from './queued-turns';
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

  selectedBackend = $state<WebviewBackendId>('claude');

  /** Selected model value for the current backend; null = the backend default. */
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

  constructor() {
    // Restore the last-used backend/model from webview state (persists across reloads).
    try {
      const saved = vscode.getState() as { selectedBackend?: unknown; selectedModel?: unknown } | undefined;
      const be = saved?.selectedBackend;
      if (be === 'claude' || be === 'grok' || be === 'kiro' || be === 'codex' || be === 'opencode') {
        this.selectedBackend = be;
      }
      if (typeof saved?.selectedModel === 'string') this.selectedModel = saved.selectedModel;
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
    if (next !== this.selectedBackend) this.selectedModel = null;
    this.selectedBackend = next;
    this.persistSelection();
  }

  /** Select a specific (backend, model) pair from the grouped model picker. */
  setModelSelection(backend: WebviewBackendId, model: string): void {
    this.selectedBackend = backend;
    this.selectedModel = model;
    this.persistSelection();
  }

  setAvailableBackends(ids: string[]): void {
    this.availableBackends = ids;
    // If the currently selected backend isn't installed, fall back to the first
    // available one so the picker never shows a dead default.
    if (ids.length > 0 && !ids.includes(this.selectedBackend)) {
      this.selectedBackend = ids[0] as WebviewBackendId;
      this.selectedModel = null;
      this.persistSelection();
    }
  }

  setAvailableModels(models: Record<string, BackendModels>): void {
    this.modelsByBackend = models;
    // Drop a persisted/selected model the current backend no longer advertises.
    if (this.selectedModel) {
      const opts = models[this.selectedBackend]?.options;
      if (!opts || !opts.some((o) => o.value === this.selectedModel)) {
        this.selectedModel = null;
        this.persistSelection();
      }
    }
  }

  private persistSelection(): void {
    try {
      const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
      vscode.setState({ ...prev, selectedBackend: this.selectedBackend, selectedModel: this.selectedModel });
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

/** Read the dropdown at send time so the chosen backend drives new-task creation. */
export function resolveBackendForSend(): WebviewBackendId {
  const fromSelect = backendSelectEl?.value;
  if (
    fromSelect === 'claude' ||
    fromSelect === 'grok' ||
    fromSelect === 'kiro' ||
    fromSelect === 'codex' ||
    fromSelect === 'opencode'
  ) {
    return fromSelect;
  }
  return tasks.selectedBackend;
}