import type {
  QueuedTurnProjection,
  SnapshotMessage,
  TaskSummary,
  TranscriptItem,
  WorkspacePatch,
  WorkspacePatchBatchMessage,
} from './protocol';
import type { ThreadItem } from './turn-state.svelte';

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
    default:
      return null;
  }
}

/** Pure workspace revision + focused transcript view for protocol v9 patches. */
export interface WorkspacePatchViewState {
  revision: number;
  needsRecovery: boolean;
  tasks: Map<string, TaskSummary>;
  subtree: TaskSummary[];
  focusedTaskId: string | null;
  queuedTurns: QueuedTurnProjection[];
  transcriptItems: ThreadItem[];
  reasoningByTurn: Record<string, string>;
  /** Stable reasoning entity id -> rendered turn ownership. */
  reasoningTurnByItemId: Record<string, string>;
  loadedTranscriptIds: ReadonlySet<string>;
  /** IDs removed by the most recently applied batch (for live-stream teardown). */
  removedTranscriptIds: ReadonlySet<string>;
  transcriptWorkspaceRevision?: number;
  /** Observed gap revision that triggered recovery (if any). */
  observedRevision?: number;
}

export type ApplyWorkspacePatchBatchResult = {
  state: WorkspacePatchViewState;
  applied: boolean;
  kind: 'applied' | 'stale' | 'duplicate' | 'gap' | 'invariant' | 'recovering' | 'noop';
  /** True when this call newly entered needsRecovery (caller should fire recovery once). */
  enteredRecovery: boolean;
};

function cloneTasks(tasks: Map<string, TaskSummary>): Map<string, TaskSummary> {
  return new Map(tasks);
}

function cloneIds(ids: ReadonlySet<string>): Set<string> {
  return new Set(ids);
}

export function emptyWorkspacePatchViewState(): WorkspacePatchViewState {
  return {
    revision: 0,
    needsRecovery: false,
    tasks: new Map(),
    subtree: [],
    focusedTaskId: null,
    queuedTurns: [],
    transcriptItems: [],
    reasoningByTurn: {},
    reasoningTurnByItemId: {},
    loadedTranscriptIds: new Set(),
    removedTranscriptIds: new Set(),
  };
}

/**
 * Snapshot hydrate is authoritative: set revision, clear recovery, replace
 * task maps/subtree/queue and focused transcript ownership window.
 */
export function applySnapshotToPatchView(
  state: WorkspacePatchViewState,
  snapshot: SnapshotMessage,
): WorkspacePatchViewState {
  // A snapshot is authoritative only at or ahead of the revision already
  // applied. A slower focus/recovery read must never roll the reducer back and
  // make a later duplicate batch mask state that the stale snapshot omitted.
  if (snapshot.storeRevision < state.revision) return state;

  const tasks = new Map<string, TaskSummary>();
  for (const task of snapshot.rootTasks) tasks.set(task.id, task);
  if (snapshot.subtree) {
    for (const task of snapshot.subtree) tasks.set(task.id, task);
  }

  const transcriptItems: ThreadItem[] = [];
  const reasoningByTurn: Record<string, string> = {};
  const reasoningTurnByItemId: Record<string, string> = {};
  const loaded = new Set<string>();
  if (snapshot.transcript) {
    for (const item of snapshot.transcript) {
      loaded.add(item.id);
      if (item.kind === 'reasoning') {
        if (item.turnId) {
          reasoningByTurn[item.turnId] = asText(item.content);
          reasoningTurnByItemId[item.id] = item.turnId;
        }
        continue;
      }
      const mapped = transcriptToThreadItem(item);
      if (mapped) transcriptItems.push(mapped);
    }
  }

  return {
    revision: snapshot.storeRevision,
    needsRecovery: false,
    tasks,
    subtree: snapshot.subtree ? [...snapshot.subtree] : [],
    focusedTaskId: snapshot.focusedTaskId ?? null,
    queuedTurns: snapshot.focusedTaskId ? [...(snapshot.queuedTurns ?? [])] : [],
    transcriptItems,
    reasoningByTurn,
    reasoningTurnByItemId,
    loadedTranscriptIds: loaded,
    removedTranscriptIds: new Set(),
    transcriptWorkspaceRevision: snapshot.transcriptPage?.workspaceRevision,
    observedRevision: undefined,
  };
}

function upsertTaskInSubtree(
  subtree: TaskSummary[],
  task: TaskSummary,
  focusedTaskId: string | null,
): TaskSummary[] {
  const idx = subtree.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    const next = subtree.slice();
    next[idx] = task;
    return next;
  }
  // Only the focused root, or a task linked to an existing subtree member, may join.
  if (task.parentId === null) {
    if (focusedTaskId === task.id) return [...subtree, task];
    return subtree;
  }
  if (subtree.some((t) => t.id === task.parentId || t.parentId === task.id)) {
    return [...subtree, task];
  }
  return subtree;
}

/**
 * Sync older-page ownership already present in the thread store into the pure
 * patch view so the next live workspacePatchBatch does not wipe W5 pages.
 */
export function syncTranscriptPageIntoPatchView(
  state: WorkspacePatchViewState,
  input: {
    focusedTaskId: string | null;
    transcriptItems: readonly ThreadItem[];
    reasoningByTurn: Readonly<Record<string, string>>;
    reasoningTurnByItemId: Readonly<Record<string, string>>;
    loadedTranscriptIds: ReadonlySet<string>;
    transcriptWorkspaceRevision?: number;
  },
): WorkspacePatchViewState {
  if (!input.focusedTaskId || state.focusedTaskId !== input.focusedTaskId) {
    return state;
  }
  const revision =
    input.transcriptWorkspaceRevision === undefined
      ? state.transcriptWorkspaceRevision
      : state.transcriptWorkspaceRevision === undefined
        ? input.transcriptWorkspaceRevision
        : Math.max(state.transcriptWorkspaceRevision, input.transcriptWorkspaceRevision);
  return {
    ...state,
    transcriptItems: input.transcriptItems.slice(),
    reasoningByTurn: { ...input.reasoningByTurn },
    reasoningTurnByItemId: { ...input.reasoningTurnByItemId },
    loadedTranscriptIds: new Set(input.loadedTranscriptIds),
    transcriptWorkspaceRevision: revision,
  };
}

function removeTaskFromView(
  draft: {
    tasks: Map<string, TaskSummary>;
    subtree: TaskSummary[];
    focusedTaskId: string | null;
    queuedTurns: QueuedTurnProjection[];
    transcriptItems: ThreadItem[];
    reasoningByTurn: Record<string, string>;
    reasoningTurnByItemId: Record<string, string>;
    loadedTranscriptIds: Set<string>;
  },
  taskId: string,
): void {
  draft.tasks.delete(taskId);
  draft.subtree = draft.subtree.filter((t) => t.id !== taskId);
  if (draft.focusedTaskId === taskId) {
    draft.focusedTaskId = null;
    draft.queuedTurns = [];
    draft.transcriptItems = [];
    draft.reasoningByTurn = {};
    draft.reasoningTurnByItemId = {};
    draft.loadedTranscriptIds = new Set();
  }
}

function appendTranscriptItems(
  draft: {
    focusedTaskId: string | null;
    transcriptItems: ThreadItem[];
    reasoningByTurn: Record<string, string>;
    reasoningTurnByItemId: Record<string, string>;
    loadedTranscriptIds: Set<string>;
  },
  taskId: string,
  items: readonly TranscriptItem[],
): 'ok' | 'invariant' {
  if (draft.focusedTaskId !== taskId) {
    // Non-focused transcript patches are accepted at the revision layer but do
    // not mutate the focused window (host should only publish focused scope).
    return 'ok';
  }
  for (const item of items) {
    if (draft.loadedTranscriptIds.has(item.id)) {
      // A repeated envelope revision was handled before this point. Seeing an
      // existing entity in a new revision means the host mislabeled an update
      // as append; silently ignoring it could lose newer content.
      return 'invariant';
    }
    draft.loadedTranscriptIds.add(item.id);
    if (item.kind === 'reasoning') {
      if (item.turnId) {
        draft.reasoningByTurn[item.turnId] = asText(item.content);
        draft.reasoningTurnByItemId[item.id] = item.turnId;
      }
      continue;
    }
    const mapped = transcriptToThreadItem(item);
    if (mapped) draft.transcriptItems.push(mapped);
  }
  return 'ok';
}

function patchTranscriptItem(
  draft: {
    focusedTaskId: string | null;
    transcriptItems: ThreadItem[];
    reasoningByTurn: Record<string, string>;
    reasoningTurnByItemId: Record<string, string>;
    loadedTranscriptIds: Set<string>;
  },
  taskId: string,
  item: TranscriptItem,
): 'ok' | 'invariant' {
  if (draft.focusedTaskId !== taskId) return 'ok';

  if (item.kind === 'reasoning') {
    if (!item.turnId) return 'invariant';
    if (!draft.loadedTranscriptIds.has(item.id)) return 'invariant';
    // Reasoning owns the stable entity id (= turnId typically).
    draft.reasoningByTurn[item.turnId] = asText(item.content);
    draft.reasoningTurnByItemId[item.id] = item.turnId;
    return 'ok';
  }

  if (!draft.loadedTranscriptIds.has(item.id)) {
    // Unknown item patch must not invent ordering — force recovery.
    return 'invariant';
  }

  const mapped = transcriptToThreadItem(item);
  if (!mapped) return 'invariant';

  const idx = draft.transcriptItems.findIndex((existing) => existing.id === item.id);
  if (idx < 0) {
    // Ownership without a materialized row is inconsistent. Appending at the
    // end would invent canonical ordering, so recover from a bounded snapshot.
    return 'invariant';
  }
  draft.transcriptItems[idx] = mapped;
  return 'ok';
}

function removeTranscriptItems(
  draft: {
    focusedTaskId: string | null;
    transcriptItems: ThreadItem[];
    reasoningByTurn: Record<string, string>;
    reasoningTurnByItemId: Record<string, string>;
    loadedTranscriptIds: Set<string>;
  },
  taskId: string,
  itemIds: readonly string[],
): 'ok' {
  if (draft.focusedTaskId !== taskId) return 'ok';
  const removed = new Set(itemIds);
  draft.transcriptItems = draft.transcriptItems.filter((item) => !removed.has(item.id));
  for (const itemId of itemIds) {
    draft.loadedTranscriptIds.delete(itemId);
    const turnId = draft.reasoningTurnByItemId[itemId];
    if (turnId) {
      delete draft.reasoningTurnByItemId[itemId];
      // One canonical reasoning row is rendered per turn. Only clear the turn
      // when the removed stable entity still owns it.
      if (!Object.values(draft.reasoningTurnByItemId).includes(turnId)) {
        delete draft.reasoningByTurn[turnId];
      }
    }
  }
  return 'ok';
}

function hasBatchIdentityInvariant(batch: WorkspacePatchBatchMessage): boolean {
  const taskMutations = new Set<string>();
  const removedTasks = new Set<string>();
  const queueTasks = new Set<string>();
  const transcriptEntities = new Set<string>();

  for (const patch of batch.patches) {
    switch (patch.type) {
      case 'taskUpserted':
      case 'turnActivityChanged': {
        if (taskMutations.has(patch.task.id)) return true;
        taskMutations.add(patch.task.id);
        break;
      }
      case 'taskRemoved': {
        if (taskMutations.has(patch.taskId)) return true;
        taskMutations.add(patch.taskId);
        removedTasks.add(patch.taskId);
        break;
      }
      case 'queuedTurnsChanged': {
        if (queueTasks.has(patch.taskId) || removedTasks.has(patch.taskId)) return true;
        queueTasks.add(patch.taskId);
        break;
      }
      case 'transcriptItemsAppended': {
        if (removedTasks.has(patch.taskId)) return true;
        for (const item of patch.items) {
          const key = `${patch.taskId}\0${item.id}`;
          if (transcriptEntities.has(key)) return true;
          transcriptEntities.add(key);
        }
        break;
      }
      case 'transcriptItemPatched': {
        if (removedTasks.has(patch.taskId)) return true;
        const key = `${patch.taskId}\0${patch.item.id}`;
        if (transcriptEntities.has(key)) return true;
        transcriptEntities.add(key);
        break;
      }
      case 'transcriptItemsRemoved': {
        if (removedTasks.has(patch.taskId)) return true;
        for (const itemId of patch.itemIds) {
          const key = `${patch.taskId}\0${itemId}`;
          if (transcriptEntities.has(key)) return true;
          transcriptEntities.add(key);
        }
        break;
      }
    }
  }

  // A removal may appear after another task-scoped patch in the same envelope.
  for (const taskId of removedTasks) {
    if (queueTasks.has(taskId)) return true;
    for (const key of transcriptEntities) {
      if (key.startsWith(`${taskId}\0`)) return true;
    }
  }
  return false;
}

/** Enter bounded recovery for a malformed/invariant patch envelope. */
export function enterWorkspacePatchRecovery(
  state: WorkspacePatchViewState,
  observedRevision: number,
): ApplyWorkspacePatchBatchResult {
  if (state.needsRecovery) {
    return { state, applied: false, kind: 'recovering', enteredRecovery: false };
  }
  return {
    state: {
      ...state,
      needsRecovery: true,
      observedRevision: Math.max(state.revision + 1, observedRevision),
    },
    applied: false,
    kind: 'invariant',
    enteredRecovery: true,
  };
}

function applyOnePatch(
  draft: {
    tasks: Map<string, TaskSummary>;
    subtree: TaskSummary[];
    focusedTaskId: string | null;
    queuedTurns: QueuedTurnProjection[];
    transcriptItems: ThreadItem[];
    reasoningByTurn: Record<string, string>;
    reasoningTurnByItemId: Record<string, string>;
    loadedTranscriptIds: Set<string>;
  },
  patch: WorkspacePatch,
): 'ok' | 'invariant' {
  switch (patch.type) {
    case 'taskUpserted': {
      draft.tasks.set(patch.task.id, patch.task);
      draft.subtree = upsertTaskInSubtree(draft.subtree, patch.task, draft.focusedTaskId);
      return 'ok';
    }
    case 'turnActivityChanged': {
      const existing = draft.tasks.get(patch.task.id);
      if (!existing) {
        // Authoritative full TaskSummary still upserts when missing.
        draft.tasks.set(patch.task.id, patch.task);
        draft.subtree = upsertTaskInSubtree(draft.subtree, patch.task, draft.focusedTaskId);
        return 'ok';
      }
      draft.tasks.set(patch.task.id, patch.task);
      draft.subtree = upsertTaskInSubtree(draft.subtree, patch.task, draft.focusedTaskId);
      return 'ok';
    }
    case 'taskRemoved': {
      removeTaskFromView(draft, patch.taskId);
      return 'ok';
    }
    case 'queuedTurnsChanged': {
      if (draft.focusedTaskId === patch.taskId) {
        draft.queuedTurns = [...patch.queuedTurns];
      }
      return 'ok';
    }
    case 'transcriptItemsAppended':
      return appendTranscriptItems(draft, patch.taskId, patch.items);
    case 'transcriptItemPatched':
      return patchTranscriptItem(draft, patch.taskId, patch.item);
    case 'transcriptItemsRemoved':
      return removeTranscriptItems(draft, patch.taskId, patch.itemIds);
    default:
      return 'invariant';
  }
}

/**
 * Apply an atomic workspacePatchBatch.
 *
 * Rules:
 * - revision < current → stale no-op
 * - revision === current → duplicate no-op
 * - revision === current + 1 → apply all patches atomically
 * - revision > current + 1 → gap: set needsRecovery, no partial mutation
 * - while needsRecovery → ignore further patches until snapshot hydrate
 * - empty patches still advance revision
 * - duplicate identity / invariant failure → no partial apply; needsRecovery
 * - revision never regresses
 */
export function applyWorkspacePatchBatch(
  state: WorkspacePatchViewState,
  batch: WorkspacePatchBatchMessage,
): ApplyWorkspacePatchBatchResult {
  if (state.needsRecovery) {
    return { state, applied: false, kind: 'recovering', enteredRecovery: false };
  }

  if (batch.revision < state.revision) {
    return { state, applied: false, kind: 'stale', enteredRecovery: false };
  }
  if (batch.revision === state.revision) {
    return { state, applied: false, kind: 'duplicate', enteredRecovery: false };
  }
  if (batch.revision > state.revision + 1) {
    return {
      state: {
        ...state,
        needsRecovery: true,
        observedRevision: batch.revision,
      },
      applied: false,
      kind: 'gap',
      enteredRecovery: true,
    };
  }

  if (hasBatchIdentityInvariant(batch)) {
    return enterWorkspacePatchRecovery(state, batch.revision);
  }

  // Contiguous: batch.revision === state.revision + 1
  const draft = {
    tasks: cloneTasks(state.tasks),
    subtree: [...state.subtree],
    focusedTaskId: state.focusedTaskId,
    queuedTurns: [...state.queuedTurns],
    transcriptItems: state.transcriptItems.slice(),
    reasoningByTurn: { ...state.reasoningByTurn },
    reasoningTurnByItemId: { ...state.reasoningTurnByItemId },
    loadedTranscriptIds: cloneIds(state.loadedTranscriptIds),
  };

  for (const patch of batch.patches) {
    const result = applyOnePatch(draft, patch);
    if (result === 'invariant') {
      return {
        state: {
          ...state,
          needsRecovery: true,
          observedRevision: batch.revision,
        },
        applied: false,
        kind: 'invariant',
        enteredRecovery: true,
      };
    }
  }

  const nextRevision = batch.revision;
  const removedTranscriptIds = new Set<string>();
  for (const patch of batch.patches) {
    if (patch.type === 'transcriptItemsRemoved' && patch.taskId === draft.focusedTaskId) {
      for (const itemId of patch.itemIds) removedTranscriptIds.add(itemId);
    }
  }
  const transcriptWorkspaceRevision =
    state.transcriptWorkspaceRevision === undefined
      ? nextRevision
      : Math.max(state.transcriptWorkspaceRevision, nextRevision);

  return {
    applied: true,
    kind: 'applied',
    enteredRecovery: false,
    state: {
      revision: nextRevision,
      needsRecovery: false,
      tasks: draft.tasks,
      subtree: draft.subtree,
      focusedTaskId: draft.focusedTaskId,
      queuedTurns: draft.queuedTurns,
      transcriptItems: draft.transcriptItems,
      reasoningByTurn: draft.reasoningByTurn,
      reasoningTurnByItemId: draft.reasoningTurnByItemId,
      loadedTranscriptIds: draft.loadedTranscriptIds,
      removedTranscriptIds,
      transcriptWorkspaceRevision,
      observedRevision: undefined,
    },
  };
}
