import type { TaskExecutionPolicy, TaskStoreFile } from './types';

export interface ResourceLimits {
  maxDepth: number;
  maxChildrenPerTask: number;
  maxChildrenPerRoot: number;
  maxTurnsPerTask: number;
  maxConcurrentTurns: number;
  maxConcurrentPerRoot: number;
  maxConcurrentPerBackend: number;
  maxResultBytes: number;
  maxErrorBytes: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxDepth: 8,
  maxChildrenPerTask: 32,
  maxChildrenPerRoot: 64,
  maxTurnsPerTask: 50,
  maxConcurrentTurns: 4,
  maxConcurrentPerRoot: 4,
  maxConcurrentPerBackend: 2,
  maxResultBytes: 16_384,
  maxErrorBytes: 4_096,
};

/**
 * Hard bounds applied to agent-supplied {@link TaskExecutionPolicy} values before
 * they are persisted. An AI coordinator can request an arbitrary execution policy
 * via the MCP bridge; without clamping it could set a multi-day turn/task timeout
 * or an enormous turn budget (resource-exhaustion / DoS). Every field is clamped
 * to `[min, max]` so the raw agent value is never trusted.
 */
export interface ExecutionPolicyBounds {
  minTurnTimeoutMs: number;
  maxTurnTimeoutMs: number;
  minTaskTimeoutMs: number;
  maxTaskTimeoutMs: number;
  maxTurns: number;
  maxAutomaticRetries: number;
}

export const DEFAULT_EXECUTION_POLICY_BOUNDS: ExecutionPolicyBounds = {
  minTurnTimeoutMs: 1_000, // 1 second
  maxTurnTimeoutMs: 1_800_000, // 30 minutes
  minTaskTimeoutMs: 1_000, // 1 second
  maxTaskTimeoutMs: 14_400_000, // 4 hours
  maxTurns: 500,
  maxAutomaticRetries: 20,
};

/**
 * Independent hard cap on a bridge bearer token's lifetime. This is deliberately
 * decoupled from {@link ExecutionPolicyBounds.maxTurnTimeoutMs}: even a large (but
 * clamped) turn timeout must never mint a local credential that outlives this
 * bound. See {@link bridgeTokenTtlMs}.
 */
export const MAX_BRIDGE_TOKEN_TTL_MS = 900_000; // 15 minutes

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Merge an agent-supplied (already type-validated) partial execution policy onto a
 * trusted base and clamp every field to {@link ExecutionPolicyBounds}. The result
 * is safe to persist: over-limit timeouts / turn budgets are reduced to the
 * configured maxima and below-minimum timeouts are raised to the minima.
 */
export function clampExecutionPolicy(
  base: TaskExecutionPolicy,
  requested: Partial<TaskExecutionPolicy> | undefined,
  bounds: ExecutionPolicyBounds = DEFAULT_EXECUTION_POLICY_BOUNDS,
): TaskExecutionPolicy {
  const merged = { ...base, ...requested };
  return {
    maxTurns: clamp(merged.maxTurns, 1, bounds.maxTurns),
    maxAutomaticRetries: clamp(merged.maxAutomaticRetries, 0, bounds.maxAutomaticRetries),
    turnTimeoutMs: clamp(merged.turnTimeoutMs, bounds.minTurnTimeoutMs, bounds.maxTurnTimeoutMs),
    taskTimeoutMs: clamp(merged.taskTimeoutMs, bounds.minTaskTimeoutMs, bounds.maxTaskTimeoutMs),
  };
}

/**
 * TTL for a bridge bearer token, capped by an independent hard bound. Even a large
 * (already clamped) turn timeout must never produce a token that lives longer than
 * `maxTtlMs`, keeping local credentials short-lived. Negative/NaN inputs collapse
 * to 0 (an immediately-expired token) rather than a long-lived one.
 */
export function bridgeTokenTtlMs(
  turnTimeoutMs: number,
  maxTtlMs: number = MAX_BRIDGE_TOKEN_TTL_MS,
): number {
  const requested = Number.isFinite(turnTimeoutMs) ? Math.max(0, turnTimeoutMs) : 0;
  return Math.min(requested, maxTtlMs);
}

export type LimitKind =
  | 'depth'
  | 'children_per_task'
  | 'children_per_root'
  | 'turns_per_task'
  | 'result_size'
  | 'error_size';

export interface LimitContext {
  file: TaskStoreFile;
  parentId: string | null;
  rootId: string;
  taskId?: string;
  childCountForParent?: number;
  childCountForRoot?: number;
  turnCount?: number;
  resultBytes?: number;
  errorBytes?: number;
}

export function effectiveTurnCap(
  task: { executionPolicy: { maxTurns: number } },
  limits: ResourceLimits,
): number {
  return Math.min(limits.maxTurnsPerTask, task.executionPolicy.maxTurns);
}

export function canCreateTurn(
  file: TaskStoreFile,
  taskId: string,
  limits: ResourceLimits,
): { ok: true } | { ok: false; reason: string } {
  const task = file.tasks[taskId];
  if (!task) {
    return { ok: false, reason: 'task not found' };
  }
  const cap = effectiveTurnCap(task, limits);
  const slotsUsed = Object.values(file.turns).filter(
    (turn) => turn.taskId === taskId && turn.status !== 'queued',
  ).length;
  if (slotsUsed >= cap) {
    return { ok: false, reason: 'max turns per task exceeded' };
  }
  return { ok: true };
}

export function taskDepth(file: TaskStoreFile, taskId: string): number {
  let depth = 0;
  let current = file.tasks[taskId];
  while (current?.parentId) {
    depth += 1;
    current = file.tasks[current.parentId];
    if (!current) {
      break;
    }
  }
  return depth;
}

export function countChildren(file: TaskStoreFile, parentId: string): number {
  return Object.values(file.tasks).filter((t) => t.parentId === parentId).length;
}

export function countRootChildren(file: TaskStoreFile, rootId: string): number {
  return Object.values(file.tasks).filter((t) => {
    let current = t;
    while (current.parentId) {
      const parent = file.tasks[current.parentId];
      if (!parent) {
        return current.id === rootId || false;
      }
      current = parent;
    }
    return current.id === rootId && t.id !== rootId;
  }).length;
}

export function checkLimit(
  kind: LimitKind,
  limits: ResourceLimits,
  ctx: LimitContext,
): { ok: true } | { ok: false; reason: string } {
  switch (kind) {
    case 'depth': {
      if (!ctx.taskId) {
        return { ok: false, reason: 'task id required for depth check' };
      }
      const depth = taskDepth(ctx.file, ctx.taskId);
      if (depth >= limits.maxDepth) {
        return { ok: false, reason: 'max depth exceeded' };
      }
      return { ok: true };
    }
    case 'children_per_task': {
      const count = ctx.childCountForParent ?? (ctx.parentId ? countChildren(ctx.file, ctx.parentId) : 0);
      if (count >= limits.maxChildrenPerTask) {
        return { ok: false, reason: 'max children per task exceeded' };
      }
      return { ok: true };
    }
    case 'children_per_root': {
      const count = ctx.childCountForRoot ?? countRootChildren(ctx.file, ctx.rootId);
      if (count >= limits.maxChildrenPerRoot) {
        return { ok: false, reason: 'max children per root exceeded' };
      }
      return { ok: true };
    }
    case 'turns_per_task': {
      const count = ctx.turnCount ?? 0;
      if (count >= limits.maxTurnsPerTask) {
        return { ok: false, reason: 'max turns per task exceeded' };
      }
      return { ok: true };
    }
    case 'result_size': {
      if ((ctx.resultBytes ?? 0) > limits.maxResultBytes) {
        return { ok: false, reason: 'result too large' };
      }
      return { ok: true };
    }
    case 'error_size': {
      if ((ctx.errorBytes ?? 0) > limits.maxErrorBytes) {
        return { ok: false, reason: 'error too large' };
      }
      return { ok: true };
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}