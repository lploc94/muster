import { evaluateDependency } from './deps';
import { isActiveHandoffPhase } from './engine-handoff';
import type { ResourceLimits } from './limits';
import { evaluateTaskReadiness, readinessToPromoteReason } from './readiness';
import { hasResourceConflict } from './resources';
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
    const producer = file.tasks[dep.taskId];
    const outcome = evaluateDependency(
      dep,
      producer?.lifecycle,
      producer?.taskResult?.verdict?.status,
    );
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
    const producer = file.tasks[dep.taskId];
    const outcome = evaluateDependency(
      dep,
      producer?.lifecycle,
      producer?.taskResult?.verdict?.status,
    );
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

  // FIFO: only the earliest still-queued, promotable turn for this task may run.
  // Held follow-ups (holdAutoPromote) do not block a later safe auto-retry.
  const earlierQueued = turnsForTask(file, turn.taskId).find(
    (t) =>
      t.id !== turnId &&
      t.status === 'queued' &&
      t.holdAutoPromote !== true &&
      (t.sequence < turn.sequence ||
        (t.sequence === turn.sequence &&
          (t.createdAt < turn.createdAt ||
            (t.createdAt === turn.createdAt && t.id < turn.id)))),
  );
  if (earlierQueued) {
    return { ok: false, reason: 'earlier queued turn must run first' };
  }

  // Parent-question / attention wakes may run while the parent is waiting on children.
  const isOrchestrationWake =
    turn.trigger === 'engine' &&
    (turn.id.includes('parent-q-') || turn.id.endsWith('-attention'));

  // W5: same readiness evaluator as get_task_status / UI (draft, deps, inputs, wait, handoff, holds).
  const readiness = evaluateTaskReadiness(file, turn.taskId);
  if (!readiness.schedulable) {
    const onlyWaitingChildren =
      readiness.reasons.some((r) => r.code === 'waiting_children') &&
      readiness.reasons.every(
        (r) =>
          r.code === 'waiting_children' ||
          r.code === 'queued' ||
          r.code === 'ready' ||
          r.code === 'needs_attention',
      );
    if (!(isOrchestrationWake && onlyWaitingChildren)) {
      const reason = readinessToPromoteReason(readiness);
      if (reason) return { ok: false, reason };
    }
  }
  // Turn-specific holds still apply when readiness is otherwise clear.
  if (turn.holdAutoPromote) {
    return { ok: false, reason: 'held after previous turn failure' };
  }
  // Keep handoff/deps double-check for defense in depth if readiness drifts.
  if (dependenciesBlockTask(file, turn.taskId)) {
    return { ok: false, reason: 'dependencies not satisfied' };
  }
  if (task.wait?.kind === 'children' && !isOrchestrationWake) {
    return { ok: false, reason: 'waiting on child tasks' };
  }
  if (task.wait?.kind === 'external') {
    return { ok: false, reason: 'waiting on external blocker' };
  }
  if (task.handoff && isActiveHandoffPhase(task.handoff.phase)) {
    return { ok: false, reason: 'runtime handoff in progress' };
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

  // W7: shared-cwd path/git serialization (same commit gate as promote).
  const resource = hasResourceConflict(file, turn.taskId);
  if (resource.conflict) {
    return { ok: false, reason: resource.reason };
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