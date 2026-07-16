import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_LIMIT_MS,
  DEFAULT_TASK_EXECUTION_POLICY,
  RUN_LIMIT_MS,
  remainingRunTimeMs,
  resolveTaskExecutionPolicy,
  resolveTurnRunDeadline,
  runLimitMs,
} from './execution-policy';

describe('canonical task execution policy', () => {
  it('uses one 50-turn default and the 2h host run ceiling', () => {
    expect(resolveTaskExecutionPolicy()).toEqual(DEFAULT_TASK_EXECUTION_POLICY);
    expect(DEFAULT_RUN_LIMIT_MS).toBe(RUN_LIMIT_MS['2h']);
    expect(runLimitMs('8h')).toBe(RUN_LIMIT_MS['8h']);
    expect(runLimitMs('none')).toBe(DEFAULT_RUN_LIMIT_MS);
  });

  it('stores overrides within hard bounds; clamps to user ceiling only at promotion', () => {
    expect(resolveTaskExecutionPolicy(
      { runTimeoutOverrideMs: RUN_LIMIT_MS['30m'] },
      { userRunLimitMs: RUN_LIMIT_MS['2h'] },
    ).runTimeoutOverrideMs).toBe(RUN_LIMIT_MS['30m']);
    // Creation keeps a long override so a later raised setting can still apply.
    expect(resolveTaskExecutionPolicy(
      { maxTurns: 9999, runTimeoutOverrideMs: RUN_LIMIT_MS['8h'] },
      { userRunLimitMs: RUN_LIMIT_MS['1h'] },
    )).toMatchObject({ maxTurns: 500, runTimeoutOverrideMs: RUN_LIMIT_MS['8h'] });
    // Promotion freezes the live ceiling against the stored override.
    expect(resolveTurnRunDeadline(
      resolveTaskExecutionPolicy(
        { runTimeoutOverrideMs: RUN_LIMIT_MS['8h'] },
        { userRunLimitMs: RUN_LIMIT_MS['1h'] },
      ),
      RUN_LIMIT_MS['1h'],
      '2026-07-16T00:00:00.000Z',
    ).effectiveRunLimitMs).toBe(RUN_LIMIT_MS['1h']);
  });

  it('freezes a deadline and computes remaining time without extending it', () => {
    const startedAt = '2026-07-16T00:00:00.000Z';
    const resolved = resolveTurnRunDeadline(
      resolveTaskExecutionPolicy(),
      RUN_LIMIT_MS['2h'],
      startedAt,
    );
    expect(resolved).toEqual({
      effectiveRunLimitMs: RUN_LIMIT_MS['2h'],
      runDeadlineAt: '2026-07-16T02:00:00.000Z',
    });
    expect(remainingRunTimeMs(resolved, Date.parse('2026-07-16T01:30:00.000Z'))).toBe(
      RUN_LIMIT_MS['30m'],
    );
  });
});
