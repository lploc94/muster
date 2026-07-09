import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedPromptCancel,
  killProcessTree,
  terminateProcessTree,
  type KillableProcess,
  type PromptResult,
} from './acp-client';

/**
 * Lightweight fake ChildProcess: an EventEmitter carrying the pid/exitCode/kill
 * surface the kill helpers rely on. Avoids spawning real processes (let alone
 * real grandchildren) in unit tests.
 */
class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
  constructor(public pid: number | undefined = 4242) {
    super();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('boundedPromptCancel', () => {
  it('returns the pending promise unchanged when no signal is provided', () => {
    const pending = Promise.resolve<PromptResult>({ stopReason: 'end_turn' });
    const wrapped = boundedPromptCancel(pending, undefined, {
      onCancel: vi.fn(),
      onForceSettle: vi.fn(),
    });
    expect(wrapped).toBe(pending);
  });

  it('resolves with the real result and never force-cancels on normal completion', async () => {
    const onCancel = vi.fn();
    const onForceSettle = vi.fn();
    const controller = new AbortController();
    const pending = Promise.resolve<PromptResult>({ stopReason: 'end_turn' });

    const wrapped = boundedPromptCancel(pending, controller.signal, { onCancel, onForceSettle }, 100);

    await expect(wrapped).resolves.toEqual({ stopReason: 'end_turn' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onForceSettle).not.toHaveBeenCalled();
  });

  it('force-settles with a cancelled result after the grace when the agent ignores cancel', async () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    const onForceSettle = vi.fn();
    const controller = new AbortController();
    // Never-settling pending promise models a hung agent that ignores cancel.
    const pending = new Promise<PromptResult>(() => {});

    const wrapped = boundedPromptCancel(pending, controller.signal, { onCancel, onForceSettle }, 100);

    controller.abort();
    // Cooperative cancel fires immediately; force-settle only after the grace.
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onForceSettle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    await expect(wrapped).resolves.toEqual({ stopReason: 'cancelled' });
    expect(onForceSettle).toHaveBeenCalledTimes(1);
  });

  it('clears the grace timer when the agent honors cancel within the grace', async () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    const onForceSettle = vi.fn();
    const controller = new AbortController();
    let resolvePending!: (value: PromptResult) => void;
    const pending = new Promise<PromptResult>((resolve) => {
      resolvePending = resolve;
    });

    const wrapped = boundedPromptCancel(pending, controller.signal, { onCancel, onForceSettle }, 100);

    controller.abort();
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Agent settles the prompt before the grace elapses.
    resolvePending({ stopReason: 'cancelled' });
    await Promise.resolve(); // let pending.then run and clear the grace timer
    await vi.advanceTimersByTimeAsync(500); // well past the grace

    await expect(wrapped).resolves.toEqual({ stopReason: 'cancelled' });
    expect(onForceSettle).not.toHaveBeenCalled();
  });

  it('propagates a real rejection from the pending prompt', async () => {
    const onCancel = vi.fn();
    const onForceSettle = vi.fn();
    const controller = new AbortController();
    const pending = Promise.reject<PromptResult>(new Error('Claude agent exited (code 1)'));

    const wrapped = boundedPromptCancel(pending, controller.signal, { onCancel, onForceSettle }, 100);

    await expect(wrapped).rejects.toThrow('Claude agent exited');
    expect(onCancel).not.toHaveBeenCalled();
    expect(onForceSettle).not.toHaveBeenCalled();
  });
});

describe('killProcessTree', () => {
  it('signals the negative pid (whole group) with the given signal on POSIX', () => {
    const proc = new FakeProc(4242);
    const processKill = vi.fn();

    killProcessTree(proc, 'SIGTERM', 'linux', processKill);

    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('falls back to proc.kill(signal) on Windows (no process groups)', () => {
    const proc = new FakeProc(4242);
    const processKill = vi.fn();

    killProcessTree(proc, 'SIGTERM', 'win32', processKill);

    expect(processKill).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('falls back to proc.kill when the group signal throws (EPERM/ESRCH)', () => {
    const proc = new FakeProc(4242);
    const processKill = vi.fn(() => {
      throw new Error('EPERM');
    });

    killProcessTree(proc, 'SIGKILL', 'linux', processKill);

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does nothing when pid is missing or the process already exited', () => {
    const processKill = vi.fn();

    const noPid = new FakeProc();
    noPid.pid = undefined; // an unstarted process has no pid
    killProcessTree(noPid, 'SIGTERM', 'linux', processKill);
    expect(processKill).not.toHaveBeenCalled();
    expect(noPid.kill).not.toHaveBeenCalled();

    const exited = new FakeProc(4242);
    exited.exitCode = 0;
    killProcessTree(exited, 'SIGTERM', 'linux', processKill);
    expect(processKill).not.toHaveBeenCalled();
    expect(exited.kill).not.toHaveBeenCalled();
  });
});

describe('terminateProcessTree', () => {
  it('sends SIGTERM immediately then escalates to SIGKILL if still alive', () => {
    vi.useFakeTimers();
    const proc = new FakeProc(4242);
    const kill = vi.fn((_p: KillableProcess, _signal: NodeJS.Signals) => {});

    terminateProcessTree(proc, 50, kill);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(proc, 'SIGTERM');

    vi.advanceTimersByTime(50);

    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenLastCalledWith(proc, 'SIGKILL');
  });

  it('does not escalate to SIGKILL when the process exits within the grace', () => {
    vi.useFakeTimers();
    const proc = new FakeProc(4242);
    const kill = vi.fn((_p: KillableProcess, _signal: NodeJS.Signals) => {});

    terminateProcessTree(proc, 50, kill);
    expect(kill).toHaveBeenCalledWith(proc, 'SIGTERM');

    // Process exits cleanly before the escalation grace elapses.
    proc.exitCode = 0;
    proc.emit('exit');
    vi.advanceTimersByTime(100);

    expect(kill).toHaveBeenCalledTimes(1); // only SIGTERM, escalation cleared on exit
  });

  it('does nothing for an already-exited process', () => {
    const proc = new FakeProc(4242);
    proc.exitCode = 0;
    const kill = vi.fn((_p: KillableProcess, _signal: NodeJS.Signals) => {});

    terminateProcessTree(proc, 50, kill);

    expect(kill).not.toHaveBeenCalled();
  });
});
