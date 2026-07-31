import { describe, expect, it, vi } from 'vitest';
import {
  RETENTION_SCHEDULE_INTERVAL_MS,
  resolveRetentionScheduleIntervalMs,
  RetentionScheduler,
} from './retention-scheduler';

function createFakeInterval() {
  let callback: (() => void) | undefined;
  let nextHandle = 1;
  const cleared: unknown[] = [];
  return {
    schedule: vi.fn((fn: () => void, _ms: number) => {
      callback = fn;
      return nextHandle++;
    }),
    clear: vi.fn((handle: unknown) => {
      cleared.push(handle);
    }),
    async fire(): Promise<void> {
      callback?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    cleared,
  };
}

describe('RetentionScheduler', () => {
  it('uses the UAT retention interval override when UAT mode is enabled', () => {
    expect(
      resolveRetentionScheduleIntervalMs(true, { MUSTER_RETENTION_INTERVAL_MS: '60000' }),
    ).toBe(60_000);
  });

  it('preserves production cadence and rejects malformed UAT interval overrides', () => {
    expect(
      resolveRetentionScheduleIntervalMs(false, { MUSTER_RETENTION_INTERVAL_MS: '60000' }),
    ).toBe(RETENTION_SCHEDULE_INTERVAL_MS);

    for (const value of [undefined, '0', '-1', '1.5', 'not-a-number']) {
      expect(resolveRetentionScheduleIntervalMs(true, { MUSTER_RETENTION_INTERVAL_MS: value }))
        .toBe(RETENTION_SCHEDULE_INTERVAL_MS);
    }
  });

  it('runs an initial pass and a second injected interval pass without restart', async () => {
    const timer = createFakeInterval();
    const runPass = vi.fn(async () => undefined);
    const scheduler = new RetentionScheduler({
      runPass,
      intervalMs: 60_000,
      schedule: timer.schedule,
      clearSchedule: timer.clear,
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(timer.schedule).toHaveBeenCalledWith(expect.any(Function), 60_000);

    await timer.fire();
    expect(runPass).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    expect(timer.clear).toHaveBeenCalledTimes(1);
  });

  it('skips overlapping ticks but runs another pass after the active pass settles', async () => {
    const timer = createFakeInterval();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runPass = vi.fn(async () => gate);
    const scheduler = new RetentionScheduler({
      runPass,
      schedule: timer.schedule,
      clearSchedule: timer.clear,
    });

    scheduler.start();
    await timer.fire();
    await timer.fire();
    expect(runPass).toHaveBeenCalledTimes(1);

    release();
    // runPass awaits its gate and the scheduler clears single-flight in finally.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await timer.fire();
    expect(runPass).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
});
