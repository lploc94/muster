import { evaluateDependency } from './deps';
import type { ResourceLimits } from './limits';
import type { TaskStoreFile, TaskTurn } from './types';

const LIVE_STATUSES: ReadonlySet<TaskTurn['status']> = new Set(['running', 'waiting_user']);

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns).filter((t) => t.taskId === taskId);
}

function activeTurnForTask(file: TaskStoreFile, taskId: string): TaskTurn | undefined {
  return turnsForTask(file, taskId).find(
    (t) => t.status === 'queued' || LIVE_STATUSES.has(t.status),
  );
}

function runningTurns(file: TaskStoreFile): TaskTurn[] {
  return Object.values(file.turns).filter((t) => LIVE_STATUSES.has(t.status));
}

function sessionIdForTurn(file: TaskStoreFile, turn: TaskTurn): string | undefined {
  const task = file.tasks[turn.taskId];
  return turn.observedSessionId ?? turn.candidateSessionId ?? task?.committedSessionId;
}

export function countRunningTurns(file: TaskStoreFile): number {
  return runningTurns(file).length;
}

export function countRunningForRoot(file: TaskStoreFile, rootId: string): number {
  return runningTurns(file).filter((turn) => {
    const task = file.tasks[turn.taskId];
    if (!task) {
      return false;
    }
    let current = task;
    while (current.parentId) {
      const parent = file.tasks[current.parentId];
      if (!parent) {
        break;
      }
      current = parent;
    }
    return current.id === rootId;
  }).length;
}

export function countRunningForBackend(file: TaskStoreFile, backend: string): number {
  return runningTurns(file).filter((turn) => file.tasks[turn.taskId]?.backend === backend).length;
}

export function isSessionBusy(file: TaskStoreFile, sessionId: string | undefined): boolean {
  if (!sessionId) {
    return false;
  }
  return runningTurns(file).some((turn) => sessionIdForTurn(file, turn) === sessionId);
}

export function dependenciesBlockTask(file: TaskStoreFile, taskId: string): boolean {
  const task = file.tasks[taskId];
  if (!task) {
    return true;
  }
  for (const dep of task.dependencies) {
    const lifecycle = file.tasks[dep.taskId]?.lifecycle;
    const outcome = evaluateDependency(dep, lifecycle);
    // Only 'satisfied' allows promotion. pending/block wait; fail/skip are sealed by
    // host applyDependencyTerminals — still block until sealed/settled.
    if (outcome !== 'satisfied') {
      return true;
    }
  }
  return false;
}

export function dependencyTerminalOutcome(
  file: TaskStoreFile,
  taskId: string,
): 'failed' | 'skipped' | undefined {
  const task = file.tasks[taskId];
  if (!task) return undefined;
  let failed = false;
  let skipped = false;
  for (const dep of task.dependencies) {
    const lifecycle = file.tasks[dep.taskId]?.lifecycle;
    const outcome = evaluateDependency(dep, lifecycle);
    if (outcome === 'fail') failed = true;
    if (outcome === 'skip') skipped = true;
  }
  if (failed) return 'failed';
  if (skipped) return 'skipped';
  return undefined;
}

export function canPromoteTurn(
  file: TaskStoreFile,
  turnId: string,
  limits: ResourceLimits,
): { ok: true } | { ok: false; reason: string } {
  const turn = file.turns[turnId];
  if (!turn || turn.status !== 'queued') {
    return { ok: false, reason: 'turn is not queued' };
  }

  const task = file.tasks[turn.taskId];
  if (!task) {
    return { ok: false, reason: 'task not found' };
  }

  const otherLive = turnsForTask(file, turn.taskId).find(
    (t) => t.id !== turnId && LIVE_STATUSES.has(t.status),
  );
  if (otherLive) {
    return { ok: false, reason: 'task already has an active turn' };
  }

  // FIFO: only the earliest still-queued turn for this task may promote.
  // Blocks resumeQueuedTurn / cross-process schedule of a later sequence first.
  const earlierQueued = turnsForTask(file, turn.taskId).find(
    (t) =>
      t.id !== turnId &&
      t.status === 'queued' &&
      (t.sequence < turn.sequence ||
        (t.sequence === turn.sequence &&
          (t.createdAt < turn.createdAt ||
            (t.createdAt === turn.createdAt && t.id < turn.id)))),
  );
  if (earlierQueued) {
    return { ok: false, reason: 'earlier queued turn must run first' };
  }

  if (dependenciesBlockTask(file, turn.taskId)) {
    return { ok: false, reason: 'dependencies not satisfied' };
  }

  if (countRunningTurns(file) >= limits.maxConcurrentTurns) {
    return { ok: false, reason: 'global concurrency limit' };
  }

  let root = task;
  while (root.parentId) {
    const parent = file.tasks[root.parentId];
    if (!parent) {
      break;
    }
    root = parent;
  }
  if (countRunningForRoot(file, root.id) >= limits.maxConcurrentPerRoot) {
    return { ok: false, reason: 'root concurrency limit' };
  }

  if (countRunningForBackend(file, task.backend) >= limits.maxConcurrentPerBackend) {
    return { ok: false, reason: 'backend concurrency limit' };
  }

  const sessionId = task.committedSessionId;
  if (sessionId && isSessionBusy(file, sessionId)) {
    return { ok: false, reason: 'session already has a running turn' };
  }

  return { ok: true };
}

export function pickRunnableTurns(file: TaskStoreFile, limits: ResourceLimits): string[] {
  const queued = Object.values(file.turns)
    .filter((t) => t.status === 'queued')
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

  const promoted: string[] = [];
  let draft = file;

  for (const turn of queued) {
    const check = canPromoteTurn(draft, turn.id, limits);
    if (!check.ok) {
      continue;
    }
    promoted.push(turn.id);
    draft = {
      ...draft,
      turns: {
        ...draft.turns,
        [turn.id]: { ...turn, status: 'running', startedAt: turn.startedAt ?? new Date().toISOString() },
      },
    };
  }

  return promoted;
}