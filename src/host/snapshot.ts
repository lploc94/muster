import type { Question } from '../bridge/ask-bridge';
import { deriveRuntimeActivity, deriveViewStatus } from '../task/derived-status';
import type { TaskStore } from '../task/store';
import type {
  MusterTask,
  TaskLifecycleState,
  TaskMessageState,
  TaskRole,
  TaskRuntimeActivity,
  TaskStoreFile,
  TaskTurn,
  TaskViewStatus,
} from '../task/types';

export interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: TaskRole;
  /** User-facing work outcome (open / succeeded / failed / cancelled / skipped). */
  lifecycle: TaskLifecycleState;
  /**
   * CLI/deps/wait activity while lifecycle is open; null when terminal.
   * Primary UI: lifecycle badge; secondary: this field.
   */
  runtimeActivity: TaskRuntimeActivity | null;
  /**
   * Compact single-axis status for older consumers: terminal lifecycle or
   * runtime activity. Prefer lifecycle + runtimeActivity.
   */
  viewStatus: TaskViewStatus;
  /** Backend session id for resume (same task, next turn). */
  committedSessionId?: string;
  /** Agent proposed complete/fail; root stays open until user continues or accepts. */
  hasOutcomeProposal?: boolean;
  updatedAt: string;
  backend: string;
  continuationOf?: string;
}

export interface ToolTranscriptContent {
  toolCallId: string;
  name: string;
  toolKind?: 'mcp' | 'builtin' | 'other';
  status: 'running' | 'success' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
}

export type TranscriptItem =
  | {
      id: string;
      kind: 'user' | 'assistant';
      content: string;
      turnId?: string;
      order?: number;
      state?: TaskMessageState;
    }
  | { id: string; kind: 'tool'; turnId: string; order: number; content: ToolTranscriptContent }
  | { id: string; kind: 'reasoning'; turnId: string; content: string };

/**
 * Authoritative queued follow-up turn projection for S03 edit/delete and S04
 * composer feedback. Ordered by FIFO sequence (then createdAt, then id).
 * Each entry binds a distinct turn identity to its message inputs.
 */
export interface QueuedTurnProjection {
  turnId: string;
  sequence: number;
  status: 'queued';
  messageIds: string[];
  createdAt: string;
}

export interface TaskSnapshot {
  rootTasks: TaskSummary[];
  focusedTaskId?: string;
  subtree?: TaskSummary[];
  transcript?: TranscriptItem[];
  /**
   * Currently live (running/waiting_user) turn, or the sole queued turn when
   * nothing is live, or the latest retryable turn under needs_recovery.
   * Never prefers a later queued follow-up over a live turn (R012 multi-queue).
   */
  activeTurnId?: string;
  /** FIFO queued follow-ups for the focused task (excludes the live turn). */
  queuedTurns?: QueuedTurnProjection[];
  storeRevision: number;
  pendingAsk?: { turnId: string; askId: string; questions: Question[] };
}

export interface PendingAskOverlay {
  taskId: string;
  turnId: string;
  askId: string;
  questions: Question[];
}

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((turn) => turn.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
}

function depLifecyclesForTask(file: TaskStoreFile, task: MusterTask): Map<string, TaskLifecycleState> {
  const map = new Map<string, TaskLifecycleState>();
  for (const dep of task.dependencies) {
    const depTask = file.tasks[dep.taskId];
    if (depTask) {
      map.set(dep.taskId, depTask.lifecycle);
    }
  }
  return map;
}

function maxIso(...values: (string | undefined)[]): string {
  const present = values.filter((value): value is string => typeof value === 'string');
  if (present.length === 0) {
    return '';
  }
  return present.reduce((latest, value) => (value.localeCompare(latest) > 0 ? value : latest));
}

export function projectActivityTime(file: TaskStoreFile, taskId: string): string {
  const task = file.tasks[taskId];
  if (!task) {
    return '';
  }
  let latest = task.updatedAt;
  for (const turn of turnsForTask(file, taskId)) {
    latest = maxIso(latest, turn.createdAt, turn.startedAt, turn.finishedAt);
  }
  for (const message of Object.values(file.messages)) {
    if (message.taskId === taskId) {
      latest = maxIso(latest, message.createdAt);
    }
  }
  for (const tc of Object.values(file.toolCalls ?? {})) {
    if (tc.taskId === taskId) {
      latest = maxIso(latest, tc.createdAt, tc.updatedAt);
    }
  }
  for (const r of Object.values(file.reasoning ?? {})) {
    if (r.taskId === taskId) {
      latest = maxIso(latest, r.createdAt, r.updatedAt);
    }
  }
  return latest;
}

export function projectTaskSummary(file: TaskStoreFile, taskId: string): TaskSummary | undefined {
  const task = file.tasks[taskId];
  if (!task) {
    return undefined;
  }
  const turns = turnsForTask(file, taskId);
  const deps = depLifecyclesForTask(file, task);
  return {
    id: task.id,
    parentId: task.parentId,
    goal: task.goal,
    role: task.role,
    lifecycle: task.lifecycle,
    runtimeActivity: deriveRuntimeActivity(task, turns, deps),
    viewStatus: deriveViewStatus(task, turns, deps),
    committedSessionId: task.committedSessionId,
    hasOutcomeProposal: task.outcomeProposal != null,
    updatedAt: projectActivityTime(file, taskId),
    backend: task.backend,
    continuationOf: task.continuationOf,
  };
}

export function buildTranscript(file: TaskStoreFile, taskId: string): TranscriptItem[] {
  const turns = turnsForTask(file, taskId);
  const seqOf = new Map<string, number>();
  for (const turn of turns) {
    seqOf.set(turn.id, turn.sequence);
  }
  // User messages link to a turn via turn.inputs (they carry no turnId themselves).
  const msgTurn = new Map<string, string>();
  for (const turn of turns) {
    for (const input of turn.inputs) {
      if (input.kind === 'message') {
        msgTurn.set(input.messageId, turn.id);
      }
    }
  }

  interface Entry {
    item: TranscriptItem;
    seq: number;
    order: number;
    createdAt: string;
    id: string;
  }
  const entries: Entry[] = [];

  for (const message of Object.values(file.messages)) {
    if (message.taskId !== taskId) {
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }
    const turnId = message.role === 'assistant' ? message.turnId : (message.turnId ?? msgTurn.get(message.id));
    const seq = turnId !== undefined && seqOf.has(turnId) ? seqOf.get(turnId)! : -1;
    // user prompt (-2) sorts before reasoning (-1) and assistant/tool segments (>=0).
    const order = message.role === 'assistant' ? (message.order ?? 0) : -2;
    entries.push({
      item: {
        id: message.id,
        kind: message.role,
        content: message.content,
        turnId,
        order: message.order,
        state: message.state,
      },
      seq,
      order,
      createdAt: message.createdAt,
      id: message.id,
    });
  }

  for (const tc of Object.values(file.toolCalls ?? {})) {
    if (tc.taskId !== taskId) {
      continue;
    }
    const seq = seqOf.has(tc.turnId) ? seqOf.get(tc.turnId)! : -1;
    entries.push({
      item: {
        id: tc.id,
        kind: 'tool',
        turnId: tc.turnId,
        order: tc.order,
        content: {
          toolCallId: tc.toolCallId,
          name: tc.name,
          toolKind: tc.kind,
          status: tc.status,
          input: tc.input,
          output: tc.output,
          error: tc.error,
        },
      },
      seq,
      order: tc.order,
      createdAt: tc.createdAt,
      id: tc.id,
    });
  }

  for (const r of Object.values(file.reasoning ?? {})) {
    if (r.taskId !== taskId) {
      continue;
    }
    const seq = seqOf.has(r.turnId) ? seqOf.get(r.turnId)! : -1;
    entries.push({
      item: { id: r.id, kind: 'reasoning', turnId: r.turnId, content: r.content },
      seq,
      order: -1,
      createdAt: r.createdAt,
      id: r.id,
    });
  }

  entries.sort(
    (a, b) =>
      a.seq - b.seq ||
      a.order - b.order ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  return entries.map((entry) => entry.item);
}

function messageIdsForTurn(turn: TaskTurn): string[] {
  return turn.inputs
    .filter((input): input is { kind: 'message'; messageId: string } => input.kind === 'message')
    .map((input) => input.messageId);
}

/**
 * FIFO queued follow-up turns for a task. Excludes live/settled turns so S03/S04
 * can key edit/delete and composer feedback off dedicated turn identity.
 */
export function projectQueuedTurns(file: TaskStoreFile, taskId: string): QueuedTurnProjection[] {
  return turnsForTask(file, taskId)
    .filter((turn) => turn.status === 'queued')
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .map((turn) => ({
      turnId: turn.id,
      sequence: turn.sequence,
      status: 'queued' as const,
      messageIds: messageIdsForTurn(turn),
      createdAt: turn.createdAt,
    }));
}

/**
 * Active turn for host/webview controls:
 * 1. Live running/waiting_user turn (never a later queued follow-up)
 * 2. Else earliest queued turn by sequence (resume target when nothing is live)
 * 3. Else latest failed/interrupted under needs_recovery
 */
export function activeTurnIdForTask(file: TaskStoreFile, taskId: string): string | undefined {
  const turns = turnsForTask(file, taskId);
  const live = turns.filter((turn) => turn.status === 'running' || turn.status === 'waiting_user');
  if (live.length > 0) {
    // Prefer highest sequence if multiple live (should be rare; scheduler enforces one).
    return live.reduce((latest, turn) => (turn.sequence > latest.sequence ? turn : latest)).id;
  }
  const queued = turns
    .filter((turn) => turn.status === 'queued')
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  if (queued.length > 0) {
    return queued[0]!.id;
  }
  const task = file.tasks[taskId];
  if (!task) {
    return undefined;
  }
  const viewStatus = deriveViewStatus(task, turns, depLifecyclesForTask(file, task));
  if (viewStatus !== 'needs_recovery') {
    return undefined;
  }
  const retryable = turns.filter((turn) => turn.status === 'failed' || turn.status === 'interrupted');
  if (retryable.length === 0) {
    return undefined;
  }
  return retryable.reduce((latest, turn) => (turn.sequence > latest.sequence ? turn : latest)).id;
}

export function buildSnapshot(
  store: TaskStore,
  focusedTaskId?: string,
  activePendingAsks?: ReadonlyMap<string, PendingAskOverlay>,
): TaskSnapshot {
  const file = store.getFile();
  const rootTasks = Object.values(file.tasks)
    .filter((task) => task.parentId === null)
    .map((task) => projectTaskSummary(file, task.id))
    .filter((summary): summary is TaskSummary => summary !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));

  const snapshot: TaskSnapshot = {
    rootTasks,
    focusedTaskId,
    storeRevision: file.revision,
  };

  if (!focusedTaskId) {
    return snapshot;
  }

  const subtreeIds = collectSubtreeIds(file, focusedTaskId);
  snapshot.subtree = subtreeIds
    .map((taskId) => projectTaskSummary(file, taskId))
    .filter((summary): summary is TaskSummary => summary !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  snapshot.transcript = buildTranscript(file, focusedTaskId);
  snapshot.activeTurnId = activeTurnIdForTask(file, focusedTaskId);
  snapshot.queuedTurns = projectQueuedTurns(file, focusedTaskId);

  const pending = activePendingAsks?.get(focusedTaskId);
  if (pending) {
    snapshot.pendingAsk = {
      turnId: pending.turnId,
      askId: pending.askId,
      questions: pending.questions,
    };
  }

  return snapshot;
}

function collectSubtreeIds(file: TaskStoreFile, rootTaskId: string): string[] {
  const ids = [rootTaskId];
  const queue = [rootTaskId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const children = Object.values(file.tasks)
      .filter((task) => task.parentId === current)
      .map((task) => task.id)
      .sort();
    for (const childId of children) {
      ids.push(childId);
      queue.push(childId);
    }
  }
  return ids;
}