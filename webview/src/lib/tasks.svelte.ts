import type { SnapshotMessage, TaskSummary } from './protocol';
import { isTerminalStatus } from './protocol';

export interface CommandErrorState {
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

  /** Set when opening "Continue as new task" from a terminal thread. */
  continuationOf = $state<string | null>(null);

  selectedBackend = $state<WebviewBackendId>('claude');

  /** Backend ids the host reports as installed/callable; null = not yet known. */
  availableBackends = $state<string[] | null>(null);

  commandError = $state<CommandErrorState | null>(null);

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

  get focusedIsTerminal(): boolean {
    const task = this.focusedTask;
    return task ? isTerminalStatus(task.viewStatus) : false;
  }

  setBackend(next: WebviewBackendId): void {
    this.selectedBackend = next;
  }

  setAvailableBackends(ids: string[]): void {
    this.availableBackends = ids;
    // If the currently selected backend isn't installed, fall back to the first
    // available one so the picker never shows a dead default.
    if (ids.length > 0 && !ids.includes(this.selectedBackend)) {
      this.selectedBackend = ids[0] as WebviewBackendId;
    }
  }

  openNewTaskDraft(): void {
    this.draftMode = true;
    this.continuationOf = null;
    this.focusedTaskId = null;
    this.subtree = [];
  }

  openContinuationDraft(terminalTaskId: string): void {
    this.draftMode = true;
    this.continuationOf = terminalTaskId;
    this.focusedTaskId = null;
    this.subtree = [];
  }

  clearDraft(): void {
    this.draftMode = false;
    this.continuationOf = null;
  }

  focusTask(taskId: string): void {
    this.draftMode = false;
    this.continuationOf = null;
    this.focusedTaskId = taskId;
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