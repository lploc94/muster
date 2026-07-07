import type { Question } from '../bridge/ask-bridge';
import { deriveViewStatus } from '../task/derived-status';
import type { TaskStore } from '../task/store';
import type {
  MusterTask,
  TaskLifecycleState,
  TaskRole,
  TaskStoreFile,
  TaskTurn,
  TaskViewStatus,
} from '../task/types';

export interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: TaskRole;
  lifecycle: TaskLifecycleState;
  viewStatus: TaskViewStatus;
  updatedAt: string;
  backend: string;
  continuationOf?: string;
}

export interface TranscriptItem {
  id: string;
  kind: 'user' | 'assistant';
  content: string;
}

export interface TaskSnapshot {
  rootTasks: TaskSummary[];
  focusedTaskId?: string;
  subtree?: TaskSummary[];
  transcript?: TranscriptItem[];
  activeTurnId?: string;
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
  return latest;
}

export function projectTaskSummary(file: TaskStoreFile, taskId: string): TaskSummary | undefined {
  const task = file.tasks[taskId];
  if (!task) {
    return undefined;
  }
  return {
    id: task.id,
    parentId: task.parentId,
    goal: task.goal,
    role: task.role,
    lifecycle: task.lifecycle,
    viewStatus: deriveViewStatus(task, turnsForTask(file, taskId), depLifecyclesForTask(file, task)),
    updatedAt: projectActivityTime(file, taskId),
    backend: task.backend,
    continuationOf: task.continuationOf,
  };
}

export function buildTranscript(file: TaskStoreFile, taskId: string): TranscriptItem[] {
  return Object.values(file.messages)
    .filter((message) => message.taskId === taskId && (message.role === 'user' || message.role === 'assistant'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((message) => ({
      id: message.id,
      kind: message.role as 'user' | 'assistant',
      content: message.content,
    }));
}

export function activeTurnIdForTask(file: TaskStoreFile, taskId: string): string | undefined {
  const turns = turnsForTask(file, taskId);
  const live = turns.filter(
    (turn) => turn.status === 'running' || turn.status === 'waiting_user' || turn.status === 'queued',
  );
  if (live.length > 0) {
    return live.reduce((latest, turn) => (turn.sequence > latest.sequence ? turn : latest)).id;
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