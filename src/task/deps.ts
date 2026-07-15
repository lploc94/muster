import type { TaskBriefKind, TaskDependency, TaskLifecycleState, VerdictStatus } from './types';

const TERMINAL_LIFECYCLES: ReadonlySet<TaskLifecycleState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

function isTerminalLifecycle(state: TaskLifecycleState | undefined): boolean {
  return state !== undefined && TERMINAL_LIFECYCLES.has(state);
}

export function isDependencySatisfied(
  dep: TaskDependency,
  depLifecycle: TaskLifecycleState | undefined,
  depVerdict?: VerdictStatus,
): boolean {
  if (!isTerminalLifecycle(depLifecycle)) {
    return false;
  }
  const outcomeSatisfied =
    dep.requiredOutcome === 'settled' ? true : depLifecycle === 'succeeded';
  if (!outcomeSatisfied) {
    return false;
  }
  // Opt-in verify gate (Phase A): only a passing producer verdict satisfies.
  // Absent `requiredVerdict` → today's behavior (verdict ignored).
  if (dep.requiredVerdict === 'pass') {
    return depVerdict === 'pass';
  }
  return true;
}

export function evaluateDependency(
  dep: TaskDependency,
  depLifecycle: TaskLifecycleState | undefined,
  depVerdict?: VerdictStatus,
): 'satisfied' | 'pending' | 'block' | 'fail' | 'skip' {
  if (isDependencySatisfied(dep, depLifecycle, depVerdict)) {
    return 'satisfied';
  }
  if (!isTerminalLifecycle(depLifecycle)) {
    return 'pending';
  }
  return dep.onUnsatisfied;
}

export interface DepGraph {
  rootOf(taskId: string): string | undefined;
  dependsOn(taskId: string): readonly string[];
  /**
   * Brief kind of an existing task, backed by the SAME task map `rootOf`/`dependsOn`
   * read (an O(1) lookup, not a second scan). Enables the verify-gate auto-default in
   * createTask. Optional so legacy graph mocks (which never target a verify producer)
   * stay valid; real engine graphs always provide it.
   */
  briefKindOf?(taskId: string): TaskBriefKind | undefined;
}

function hasCycle(
  candidateTaskId: string,
  newDeps: readonly TaskDependency[],
  graph: DepGraph,
): boolean {
  for (const dep of newDeps) {
    if (dep.taskId === candidateTaskId) {
      return true;
    }
    const visited = new Set<string>();
    const stack = [dep.taskId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === candidateTaskId) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const next of graph.dependsOn(current)) {
        stack.push(next);
      }
    }
  }
  return false;
}

function depsEqual(
  left: readonly TaskDependency[],
  right: readonly TaskDependency[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every(
    (dep, index) =>
      dep.taskId === right[index].taskId &&
      dep.requiredOutcome === right[index].requiredOutcome &&
      dep.onUnsatisfied === right[index].onUnsatisfied,
  );
}

export function validateDependencies(
  candidate: { taskId: string; rootId: string },
  deps: readonly TaskDependency[],
  graph: DepGraph,
  firstTurnQueued: boolean,
  existingDeps?: readonly TaskDependency[],
): { ok: true } | { ok: false; reason: string } {
  if (firstTurnQueued) {
    if (existingDeps === undefined || !depsEqual(deps, existingDeps)) {
      return { ok: false, reason: 'dependencies are immutable after the first turn is queued' };
    }
    return { ok: true };
  }

  for (const dep of deps) {
    const depRoot = graph.rootOf(dep.taskId);
    if (depRoot === undefined) {
      return { ok: false, reason: `dependency task ${dep.taskId} does not exist` };
    }
    if (depRoot !== candidate.rootId) {
      return { ok: false, reason: `dependency ${dep.taskId} is not in the same root graph` };
    }
  }

  if (hasCycle(candidate.taskId, deps, graph)) {
    return { ok: false, reason: 'dependency cycle detected' };
  }

  return { ok: true };
}