import { evaluateDependency } from './deps';
import type {
  MusterTask,
  TaskLifecycleState,
  TaskRuntimeActivity,
  TaskTurn,
  TaskViewStatus,
} from './types';

const TERMINAL_LIFECYCLES: ReadonlySet<TaskLifecycleState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

const HARD_TERMINAL_LIFECYCLES: ReadonlySet<TaskLifecycleState> = new Set([
  'succeeded',
  'cancelled',
  'skipped',
]);

export function isTerminalLifecycle(state: TaskLifecycleState): boolean {
  return TERMINAL_LIFECYCLES.has(state);
}

/** Hard terminal: read-only; follow-up is a new/continuation task. */
export function isHardTerminalLifecycle(state: TaskLifecycleState): boolean {
  return HARD_TERMINAL_LIFECYCLES.has(state);
}

/** Soft terminal: user may reopen with a new message on the same task. */
export function isSoftTerminalLifecycle(state: TaskLifecycleState): boolean {
  return state === 'failed';
}

function isLiveTurnStatus(status: TaskTurn['status']): boolean {
  return status === 'running' || status === 'waiting_user';
}

function hasUnsatisfiedDependency(
  task: MusterTask,
  depLifecycles: ReadonlyMap<string, TaskLifecycleState>,
): boolean {
  return task.dependencies.some((dep) => {
    const outcome = evaluateDependency(dep, depLifecycles.get(dep.taskId));
    return outcome !== 'satisfied';
  });
}

function findLiveTurn(turns: readonly TaskTurn[]): TaskTurn | undefined {
  return turns.find((turn) => isLiveTurnStatus(turn.status));
}

function hasQueuedTurn(turns: readonly TaskTurn[]): boolean {
  return turns.some((turn) => turn.status === 'queued');
}

function latestTurn(turns: readonly TaskTurn[]): TaskTurn | undefined {
  if (turns.length === 0) {
    return undefined;
  }
  return turns.reduce((latest, turn) => (turn.sequence > latest.sequence ? turn : latest));
}

function needsRecovery(turns: readonly TaskTurn[]): boolean {
  const latest = latestTurn(turns);
  if (!latest) {
    return false;
  }
  if (latest.status !== 'failed' && latest.status !== 'interrupted') {
    return false;
  }
  return !turns.some((turn) => turn.status === 'queued' || isLiveTurnStatus(turn.status));
}

function hasOutcomeProposal(task: MusterTask): boolean {
  return task.outcomeProposal != null;
}

/**
 * Runtime activity for an **open** task (CLI/deps/waits). Returns `null` when
 * lifecycle is not open — UI should show lifecycle alone for terminal outcomes.
 */
export function deriveRuntimeActivity(
  task: MusterTask,
  turns: readonly TaskTurn[],
  depLifecycles: ReadonlyMap<string, TaskLifecycleState>,
): TaskRuntimeActivity | null {
  if (task.lifecycle !== 'open') {
    return null;
  }

  // 1. Outcome proposal awaiting authorized sealer
  if (hasOutcomeProposal(task)) {
    return 'awaiting_outcome';
  }

  // 2. Live turn
  const liveTurn = findLiveTurn(turns);
  if (liveTurn) {
    return liveTurn.status === 'waiting_user' ? 'waiting_user' : 'running';
  }

  // 3. Unsatisfied dependencies
  if (hasUnsatisfiedDependency(task, depLifecycles)) {
    return 'waiting_dependencies';
  }

  // 4. Schedulable queued turn
  if (hasQueuedTurn(turns)) {
    return 'queued';
  }

  // 5. Children wait
  if (task.wait?.kind === 'children') {
    return 'waiting_children';
  }

  // 6. External wait
  if (task.wait?.kind === 'external') {
    return 'blocked';
  }

  // 7. Needs recovery
  if (needsRecovery(turns)) {
    return 'needs_recovery';
  }

  // 8. Idle
  return 'idle';
}

/**
 * Compact single-axis status (backward compatible).
 * Prefer `task.lifecycle` + `deriveRuntimeActivity` for UI.
 */
export function deriveViewStatus(
  task: MusterTask,
  turns: readonly TaskTurn[],
  depLifecycles: ReadonlyMap<string, TaskLifecycleState>,
): TaskViewStatus {
  if (isTerminalLifecycle(task.lifecycle)) {
    return task.lifecycle;
  }
  return deriveRuntimeActivity(task, turns, depLifecycles) ?? 'idle';
}
