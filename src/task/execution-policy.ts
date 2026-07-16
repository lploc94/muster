import type { TaskExecutionPolicy } from './types';

export type RunLimitSetting = '15m' | '30m' | '1h' | '2h' | '4h' | '8h';

export const RUN_LIMIT_MS: Readonly<Record<RunLimitSetting, number>> = {
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
};

export const DEFAULT_RUN_LIMIT: RunLimitSetting = '2h';
export const DEFAULT_RUN_LIMIT_MS = RUN_LIMIT_MS[DEFAULT_RUN_LIMIT];

export const DEFAULT_TASK_EXECUTION_POLICY: Readonly<TaskExecutionPolicy> = {
  maxTurns: 50,
  maxAutomaticRetries: 2,
};

export interface TaskExecutionHardBounds {
  maxTurns: number;
  maxAutomaticRetries: number;
  minRunLimitMs: number;
  maxRunLimitMs: number;
}

export const TASK_EXECUTION_HARD_BOUNDS: Readonly<TaskExecutionHardBounds> = {
  maxTurns: 500,
  maxAutomaticRetries: 20,
  minRunLimitMs: 1_000,
  maxRunLimitMs: RUN_LIMIT_MS['8h'],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function parseRunLimit(value: unknown): RunLimitSetting {
  return typeof value === 'string' && Object.hasOwn(RUN_LIMIT_MS, value)
    ? value as RunLimitSetting
    : DEFAULT_RUN_LIMIT;
}

export function runLimitMs(value: unknown): number {
  return RUN_LIMIT_MS[parseRunLimit(value)];
}

/** Resolve both root and child policy through one trusted path. */
export function resolveTaskExecutionPolicy(
  requested?: Partial<TaskExecutionPolicy>,
  options?: {
    userRunLimitMs?: number;
    bounds?: TaskExecutionHardBounds;
  },
): TaskExecutionPolicy {
  const bounds = options?.bounds ?? TASK_EXECUTION_HARD_BOUNDS;
  // Store overrides clamped only to hard bounds. Live user ceiling (`userRunLimitMs`)
  // is applied at promotion via resolveTurnRunDeadline so unpromoted tasks can adopt
  // a raised setting without permanently shrinking the stored override.
  const legacyTurnTimeout = requested?.turnTimeoutMs;
  const requestedOverride = requested?.runTimeoutOverrideMs ?? legacyTurnTimeout;
  const runTimeoutOverrideMs = requestedOverride === undefined
    ? undefined
    : clamp(requestedOverride, bounds.minRunLimitMs, bounds.maxRunLimitMs);
  return {
    maxTurns: clamp(
      requested?.maxTurns ?? DEFAULT_TASK_EXECUTION_POLICY.maxTurns,
      1,
      bounds.maxTurns,
    ),
    maxAutomaticRetries: clamp(
      requested?.maxAutomaticRetries ?? DEFAULT_TASK_EXECUTION_POLICY.maxAutomaticRetries,
      0,
      bounds.maxAutomaticRetries,
    ),
    ...(runTimeoutOverrideMs !== undefined ? { runTimeoutOverrideMs } : {}),
  };
}

export interface ResolvedTurnRunDeadline {
  effectiveRunLimitMs: number;
  runDeadlineAt: string;
}

export function resolveTurnRunDeadline(
  policy: TaskExecutionPolicy,
  userRunLimitMs: number,
  startedAt: string,
): ResolvedTurnRunDeadline {
  const ceiling = clamp(
    userRunLimitMs,
    TASK_EXECUTION_HARD_BOUNDS.minRunLimitMs,
    TASK_EXECUTION_HARD_BOUNDS.maxRunLimitMs,
  );
  const override = policy.runTimeoutOverrideMs ?? policy.turnTimeoutMs;
  const effectiveRunLimitMs = override === undefined
    ? ceiling
    : clamp(override, TASK_EXECUTION_HARD_BOUNDS.minRunLimitMs, ceiling);
  const startMs = Date.parse(startedAt);
  const runDeadlineAt = new Date(
    (Number.isFinite(startMs) ? startMs : Date.now()) + effectiveRunLimitMs,
  ).toISOString();
  return { effectiveRunLimitMs, runDeadlineAt };
}

export function remainingRunTimeMs(
  turn: { runDeadlineAt?: string; effectiveRunLimitMs?: number },
  nowMs = Date.now(),
): number | undefined {
  if (!turn.runDeadlineAt) return turn.effectiveRunLimitMs;
  const deadline = Date.parse(turn.runDeadlineAt);
  return Number.isFinite(deadline) ? Math.max(0, deadline - nowMs) : turn.effectiveRunLimitMs;
}
