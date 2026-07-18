import type { TaskExecutionPolicy, TaskStoreFile } from './types';
import { TASK_ERROR_MAX_BYTES, TASK_RESULT_MAX_BYTES } from './content-limits';
import { TASK_EXECUTION_HARD_BOUNDS } from './execution-policy';

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
  // Hard allocation safety bound. The per-task policy supplies the normal 50-turn
  // budget; keeping this at 50 made the advertised policy max of 500 unreachable.
  maxTurnsPerTask: TASK_EXECUTION_HARD_BOUNDS.maxTurns,
  // M016: raised from 4/4/2 so multi-worker backends can saturate usefully
  // under default config; operators can still lower via config.
  maxConcurrentTurns: 30,
  maxConcurrentPerRoot: 20,
  maxConcurrentPerBackend: 15,
  maxResultBytes: TASK_RESULT_MAX_BYTES,
  maxErrorBytes: TASK_ERROR_MAX_BYTES,
};

/**
 * package.json contributes.configuration bounds for the three live
 * muster.execution concurrency settings. Keep in lockstep with package.json
 * minimum/maximum so host clamping matches the Settings UI.
 */
export const RESOURCE_CONCURRENCY_BOUNDS = {
  maxConcurrentPerBackend: { min: 1, max: 32 },
  maxConcurrentTurns: { min: 1, max: 64 },
  maxConcurrentPerRoot: { min: 1, max: 64 },
} as const;

export interface ResourceConcurrencySettingsInput {
  maxConcurrentPerBackend?: unknown;
  maxConcurrentTurns?: unknown;
  maxConcurrentPerRoot?: unknown;
}

function clampConcurrencySetting(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(Math.floor(value), min, max);
}

/**
 * Build a full {@link ResourceLimits} snapshot from live VS Code setting values.
 * Concurrency caps clamp to package.json min/max (or fall back to
 * {@link DEFAULT_RESOURCE_LIMITS}); structural caps always come from defaults.
 * Pure — host reads settings and calls this on every scheduling pass (no cache).
 */
export function resourceLimitsFromSettings(
  raw: ResourceConcurrencySettingsInput,
): ResourceLimits {
  return {
    ...DEFAULT_RESOURCE_LIMITS,
    maxConcurrentPerBackend: clampConcurrencySetting(
      raw.maxConcurrentPerBackend,
      RESOURCE_CONCURRENCY_BOUNDS.maxConcurrentPerBackend.min,
      RESOURCE_CONCURRENCY_BOUNDS.maxConcurrentPerBackend.max,
      DEFAULT_RESOURCE_LIMITS.maxConcurrentPerBackend,
    ),
    maxConcurrentTurns: clampConcurrencySetting(
      raw.maxConcurrentTurns,
      RESOURCE_CONCURRENCY_BOUNDS.maxConcurrentTurns.min,
      RESOURCE_CONCURRENCY_BOUNDS.maxConcurrentTurns.max,
      DEFAULT_RESOURCE_LIMITS.maxConcurrentTurns,
    ),
    maxConcurrentPerRoot: clampConcurrencySetting(
      raw.maxConcurrentPerRoot,
      RESOURCE_CONCURRENCY_BOUNDS.maxConcurrentPerRoot.min,
      RESOURCE_CONCURRENCY_BOUNDS.maxConcurrentPerRoot.max,
      DEFAULT_RESOURCE_LIMITS.maxConcurrentPerRoot,
    ),
  };
}

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

/**
 * Schema-v5 compatibility adapter. Values derive from the canonical V2 hard
 * bounds; production task creation resolves through execution-policy.ts.
 */
export const DEFAULT_EXECUTION_POLICY_BOUNDS: ExecutionPolicyBounds = {
  minTurnTimeoutMs: TASK_EXECUTION_HARD_BOUNDS.minRunLimitMs,
  maxTurnTimeoutMs: TASK_EXECUTION_HARD_BOUNDS.maxRunLimitMs,
  minTaskTimeoutMs: TASK_EXECUTION_HARD_BOUNDS.minRunLimitMs,
  maxTaskTimeoutMs: TASK_EXECUTION_HARD_BOUNDS.maxRunLimitMs,
  maxTurns: TASK_EXECUTION_HARD_BOUNDS.maxTurns,
  maxAutomaticRetries: TASK_EXECUTION_HARD_BOUNDS.maxAutomaticRetries,
};

/**
 * Soft default ceiling for bridge bearer tokens when turnTimeout is small.
 * W8: token lifetime must cover the turn budget — bridgeTokenTtlMs uses
 * max(turnTimeoutMs, this floor) then applies a hard safety cap.
 */
export const MAX_BRIDGE_TOKEN_TTL_MS = 900_000; // 15 minutes
/** Covers the longest supported 8h run plus cleanup without permitting multi-day tokens. */
export const HARD_BRIDGE_TOKEN_TTL_MS = 8 * 60 * 60_000 + 5 * 60_000;

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
  const result: TaskExecutionPolicy = {
    maxTurns: clamp(merged.maxTurns, 1, bounds.maxTurns),
    maxAutomaticRetries: clamp(merged.maxAutomaticRetries, 0, bounds.maxAutomaticRetries),
  };
  const override = merged.runTimeoutOverrideMs;
  if (override !== undefined) {
    result.runTimeoutOverrideMs = clamp(override, bounds.minTurnTimeoutMs, bounds.maxTurnTimeoutMs);
  }
  // Preserve schema-v5 values only for compatibility callers. New engine creation
  // goes through resolveTaskExecutionPolicy and never emits these fields.
  if (merged.turnTimeoutMs !== undefined) {
    result.turnTimeoutMs = clamp(merged.turnTimeoutMs, bounds.minTurnTimeoutMs, bounds.maxTurnTimeoutMs);
  }
  if (merged.taskTimeoutMs !== undefined) {
    result.taskTimeoutMs = clamp(merged.taskTimeoutMs, bounds.minTaskTimeoutMs, bounds.maxTaskTimeoutMs);
  }
  return result;
}

/**
 * TTL for a bridge bearer token (W8): must cover turnTimeoutMs so complete_task
 * remains authorized for the full turn. Soft default MAX_BRIDGE_TOKEN_TTL_MS when
 * turnTimeout is smaller; hard cap HARD_BRIDGE_TOKEN_TTL_MS (or maxTtlMs override).
 * Negative/NaN inputs collapse to 0.
 */
export function bridgeTokenTtlMs(
  turnTimeoutMs: number,
  maxTtlMs: number = HARD_BRIDGE_TOKEN_TTL_MS,
): number {
  if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) {
    return 0;
  }
  const requested = turnTimeoutMs;
  // Cover at least the turn budget; soft floor for short turns (W8).
  const softFloor = Math.min(MAX_BRIDGE_TOKEN_TTL_MS, maxTtlMs);
  return Math.min(Math.max(requested, softFloor), maxTtlMs);
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
  // Count every turn row for the task, including still-queued reservations, so
  // operators cannot oversubscribe the effective cap with FIFO follow-ups that
  // can never all execute.
  const epoch = task.executionEpoch ?? 1;
  const slotsUsed = Object.values(file.turns).filter(
    (turn) => turn.taskId === taskId && (turn.executionEpoch ?? 1) === epoch,
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
