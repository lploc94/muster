import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_POLL_ACTIVE_MS,
  WORKSPACE_POLL_MAX_MS,
  WorkspaceRevisionPoller,
} from './workspace-revision-poller';

function createFakeTimers() {
  const timers: Array<{ id: number; fn: () => void; ms: number; due: number }> = [];
  let nextId = 1;
  let now = 0;
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fn, ms, due: now + ms });
      return id;
    },
    clearSchedule: (handle: unknown) => {
      const idx = timers.findIndex((t) => t.id === handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
    async advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.due <= now).sort((a, b) => a.due - b.due);
      for (const timer of due) {
        const idx = timers.indexOf(timer);
        if (idx >= 0) timers.splice(idx, 1);
        timer.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    pending: () => timers.length,
  };
}

describe('WorkspaceRevisionPoller', () => {
  it('polls immediately on start and stops the timer when inactive', async () => {
    const clock = createFakeTimers();
    let active = true;
    let applied = 0;
    const getDataVersion = vi.fn(async () => 1);
    const getRevision = vi.fn(async () => applied);
    const onExternal = vi.fn(async () => undefined);
    const onRecovery = vi.fn(async () => undefined);

    const poller = new WorkspaceRevisionPoller({
      getStorageDataVersion: getDataVersion,
      getWorkspaceRevision: getRevision,
      getAppliedRevision: () => applied,
      isActive: () => active,
      onExternalRevisions: onExternal,
      onRecovery,
      schedule: clock.schedule,
      clearSchedule: clock.clearSchedule,
    });

    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(getDataVersion).toHaveBeenCalledTimes(1);
    expect(onExternal).not.toHaveBeenCalled();

    active = false;
    poller.stop();
    expect(clock.pending()).toBe(0);

    const calls = getDataVersion.mock.calls.length;
    await clock.advance(WORKSPACE_POLL_ACTIVE_MS * 4);
    expect(getDataVersion.mock.calls.length).toBe(calls);
    poller.dispose();
  });

  it('invokes external reconcile when revision advances and resets backoff', async () => {
    const clock = createFakeTimers();
    let applied = 0;
    let dataVersion = 1;
    let revision = 0;
    const onExternal = vi.fn(async ({ afterRevision, currentRevision }) => {
      expect(afterRevision).toBe(applied);
      applied = currentRevision;
    });

    const poller = new WorkspaceRevisionPoller({
      getStorageDataVersion: async () => dataVersion,
      getWorkspaceRevision: async () => revision,
      getAppliedRevision: () => applied,
      isActive: () => true,
      onExternalRevisions: onExternal,
      onRecovery: async () => undefined,
      schedule: clock.schedule,
      clearSchedule: clock.clearSchedule,
    });

    poller.start();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(poller.getPollCount()).toBe(1);

    dataVersion = 2;
    revision = 3;
    // Immediate tick avoids depending on the idle timer after first poll.
    poller.tickNow();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(onExternal).toHaveBeenCalledTimes(1);
    expect(poller.getIntervalMs()).toBe(WORKSPACE_POLL_ACTIVE_MS);
    poller.dispose();
  });

  it('increases idle backoff up to max and coalesces overlapping triggers', async () => {
    const clock = createFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dataVersion = 1;
    const getDataVersion = vi.fn(async () => {
      await gate;
      return dataVersion;
    });

    const poller = new WorkspaceRevisionPoller({
      getStorageDataVersion: getDataVersion,
      getWorkspaceRevision: async () => 0,
      getAppliedRevision: () => 0,
      isActive: () => true,
      onExternalRevisions: async () => undefined,
      onRecovery: async () => undefined,
      schedule: clock.schedule,
      clearSchedule: clock.clearSchedule,
      activeIntervalMs: 100,
      maxIntervalMs: 400,
      idleFactor: 2,
    });

    poller.start();
    // Coalesce while in-flight.
    poller.tickNow();
    poller.tickNow();
    expect(getDataVersion).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Pending immediate runs once more.
    expect(getDataVersion.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Idle path grows interval.
    dataVersion = 1;
    await clock.advance(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(poller.getIntervalMs()).toBeGreaterThanOrEqual(100);
    await clock.advance(poller.getIntervalMs());
    await Promise.resolve();
    await Promise.resolve();
    expect(poller.getIntervalMs()).toBeLessThanOrEqual(400);
    expect(poller.getIntervalMs()).toBeLessThanOrEqual(WORKSPACE_POLL_MAX_MS);
    poller.dispose();
  });

  it('backs off on error without advancing applied revision', async () => {
    const clock = createFakeTimers();
    let applied = 2;
    const onRecovery = vi.fn(async () => undefined);
    const poller = new WorkspaceRevisionPoller({
      getStorageDataVersion: async () => {
        throw new Error('disk full');
      },
      getWorkspaceRevision: async () => 5,
      getAppliedRevision: () => applied,
      isActive: () => true,
      onExternalRevisions: async () => {
        applied = 5;
      },
      onRecovery,
      schedule: clock.schedule,
      clearSchedule: clock.clearSchedule,
    });
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onRecovery).toHaveBeenCalled();
    expect(applied).toBe(2);
    expect(poller.getIntervalMs()).toBeGreaterThan(WORKSPACE_POLL_ACTIVE_MS);
    poller.dispose();
  });
});
