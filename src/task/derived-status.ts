import { evaluateDependency } from './deps';
import type { MusterTask, TaskLifecycleState, TaskTurn, TaskViewStatus } from './types';

const TERMINAL_LIFECYCLES: ReadonlySet<TaskLifecycleState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

function isTerminalLifecycle(state: TaskLifecycleState): boolean {
  return TERMINAL_LIFECYCLES.has(state);
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

export function deriveViewStatus(
  task: MusterTask,
  turns: readonly TaskTurn[],
  depLifecycles: ReadonlyMap<string, TaskLifecycleState>,
): TaskViewStatus {
  // 1. Terminal lifecycle
  if (isTerminalLifecycle(task.lifecycle)) {
    return task.lifecycle as Extract<
      TaskViewStatus,
      'succeeded' | 'failed' | 'cancelled' | 'skipped'
    >;
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