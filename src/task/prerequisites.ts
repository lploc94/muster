import type { TaskBriefKind, TaskLifecycleState, TaskPrerequisite, VerdictStatus } from './types';

const TERMINAL_LIFECYCLES: ReadonlySet<TaskLifecycleState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

function isTerminalLifecycle(state: TaskLifecycleState | undefined): boolean {
  return state !== undefined && TERMINAL_LIFECYCLES.has(state);
}

export function isPrerequisiteMet(
  prerequisite: TaskPrerequisite,
  producerLifecycle: TaskLifecycleState | undefined,
  producerVerdict?: VerdictStatus,
): boolean {
  if (!isTerminalLifecycle(producerLifecycle)) {
    return false;
  }
  const lifecycleMet =
    prerequisite.requiredLifecycle === 'terminal' || producerLifecycle === 'succeeded';
  if (!lifecycleMet) {
    return false;
  }
  // Opt-in verify gate (Phase A): only a passing producer verdict satisfies.
  // Absent `requiredVerdict` → today's behavior (verdict ignored).
  if (prerequisite.requiredVerdict === 'pass') {
    return producerVerdict === 'pass';
  }
  return true;
}

export function evaluatePrerequisite(
  prerequisite: TaskPrerequisite,
  producerLifecycle: TaskLifecycleState | undefined,
  producerVerdict?: VerdictStatus,
): 'met' | 'pending' | 'block' | 'fail' | 'skip' {
  if (isPrerequisiteMet(prerequisite, producerLifecycle, producerVerdict)) {
    return 'met';
  }
  if (!isTerminalLifecycle(producerLifecycle)) {
    return 'pending';
  }
  return prerequisite.onUnmet;
}

export interface PrerequisiteGraph {
  rootOf(taskId: string): string | undefined;
  prerequisitesOf(taskId: string): readonly string[];
  /**
   * Brief kind of an existing task, backed by the same task map as the graph lookups.
   * read (an O(1) lookup, not a second scan). Enables the verify-gate auto-default in
   * createTask. Optional so legacy graph mocks (which never target a verify producer)
   * stay valid; real engine graphs always provide it.
   */
  briefKindOf?(taskId: string): TaskBriefKind | undefined;
}

function hasCycle(
  candidateTaskId: string,
  prerequisites: readonly TaskPrerequisite[],
  graph: PrerequisiteGraph,
): boolean {
  for (const prerequisite of prerequisites) {
    if (prerequisite.producerTaskId === candidateTaskId) {
      return true;
    }
    const visited = new Set<string>();
    const stack = [prerequisite.producerTaskId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === candidateTaskId) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const next of graph.prerequisitesOf(current)) {
        stack.push(next);
      }
    }
  }
  return false;
}

function prerequisitesEqual(
  left: readonly TaskPrerequisite[],
  right: readonly TaskPrerequisite[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every(
    (prerequisite, index) =>
      prerequisite.producerTaskId === right[index].producerTaskId &&
      prerequisite.requiredLifecycle === right[index].requiredLifecycle &&
      prerequisite.onUnmet === right[index].onUnmet &&
      prerequisite.requiredVerdict === right[index].requiredVerdict,
  );
}

export function validatePrerequisites(
  candidate: { taskId: string; rootId: string },
  prerequisites: readonly TaskPrerequisite[],
  graph: PrerequisiteGraph,
  firstTurnQueued: boolean,
  existingPrerequisites?: readonly TaskPrerequisite[],
): { ok: true } | { ok: false; reason: string } {
  if (firstTurnQueued) {
    if (
      existingPrerequisites === undefined ||
      !prerequisitesEqual(prerequisites, existingPrerequisites)
    ) {
      return { ok: false, reason: 'prerequisites are immutable after the first turn is queued' };
    }
    return { ok: true };
  }

  for (const prerequisite of prerequisites) {
    const producerRoot = graph.rootOf(prerequisite.producerTaskId);
    if (producerRoot === undefined) {
      return { ok: false, reason: `prerequisite task ${prerequisite.producerTaskId} does not exist` };
    }
    if (producerRoot !== candidate.rootId) {
      return {
        ok: false,
        reason: `prerequisite ${prerequisite.producerTaskId} is not in the same root graph`,
      };
    }
  }

  if (hasCycle(candidate.taskId, prerequisites, graph)) {
    return { ok: false, reason: 'prerequisite cycle detected' };
  }

  return { ok: true };
}
