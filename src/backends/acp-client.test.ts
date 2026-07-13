import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedPromptCancel,
  deriveLiveInputSupport,
  killProcessTree,
  LIVE_INPUT_METHOD,
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

describe('deriveLiveInputSupport', () => {
  it('is false when agent capabilities are missing or empty', () => {
    expect(deriveLiveInputSupport(undefined)).toBe(false);
    expect(deriveLiveInputSupport({})).toBe(false);
    expect(deriveLiveInputSupport({ agentCapabilities: {} })).toBe(false);
  });

  it('is true only when initialize advertises liveInput evidence', () => {
    expect(
      deriveLiveInputSupport({
        agentCapabilities: { promptCapabilities: { liveInput: true } },
      }),
    ).toBe(true);
    expect(
      deriveLiveInputSupport({
        agentCapabilities: { sessionCapabilities: { liveInput: true } },
      }),
    ).toBe(true);
    expect(
      deriveLiveInputSupport({
        agentCapabilities: { _meta: { liveInput: true } },
      }),
    ).toBe(true);
    expect(
      deriveLiveInputSupport({
        agentCapabilities: { promptCapabilities: { image: true } },
      }),
    ).toBe(false);
  });
});

describe('LIVE_INPUT_METHOD', () => {
  it('uses concurrent session/prompt as the in-flight wire method', () => {
    expect(LIVE_INPUT_METHOD).toBe('session/prompt');
  });
});

describe('AcpClient.sendLiveInput contract', () => {
  it('refuses with unsupported when capability evidence is absent (no wire send)', async () => {
    const { AcpClient } = await import('./acp-client');
    const client = new AcpClient({
      key: 'live-input-test-unsupported',
      label: 'TestAgent',
      command: 'false',
      args: [],
    });
    // Simulate a connected client that never advertised live input.
    (client as unknown as { liveInputSupported: boolean }).liveInputSupported = false;
    (client as unknown as { ensureConnected: () => Promise<void> }).ensureConnected = async () => {};
    const sendRequest = vi.fn();
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;
    (client as unknown as { hasActivePrompt: (s: string) => boolean }).hasActivePrompt = () => true;

    const result = await client.sendLiveInput({
      sessionId: 'sess-1',
      instruction: 'steer left',
    });

    expect(result).toEqual({
      code: 'unsupported',
      reason: 'TestAgent agent does not advertise live-input capability',
    });
    expect(sendRequest).not.toHaveBeenCalled();
    client.dispose();
  });

  it('refuses with no-active-turn when no prompt is pending', async () => {
    const { AcpClient } = await import('./acp-client');
    const client = new AcpClient({
      key: 'live-input-test-no-turn',
      label: 'TestAgent',
      command: 'false',
      args: [],
    });
    (client as unknown as { liveInputSupported: boolean }).liveInputSupported = true;
    (client as unknown as { ensureConnected: () => Promise<void> }).ensureConnected = async () => {};
    const sendRequest = vi.fn();
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    const result = await client.sendLiveInput({
      sessionId: 'sess-1',
      instruction: 'steer left',
    });

    expect(result).toMatchObject({ code: 'no-active-turn' });
    expect(sendRequest).not.toHaveBeenCalled();
    client.dispose();
  });

  it('sends session/prompt with sessionId + text prompt while a turn is active', async () => {
    const { AcpClient } = await import('./acp-client');
    const client = new AcpClient({
      key: 'live-input-test-deliver',
      label: 'TestAgent',
      command: 'false',
      args: [],
    });
    (client as unknown as { liveInputSupported: boolean }).liveInputSupported = true;
    (client as unknown as { ensureConnected: () => Promise<void> }).ensureConnected = async () => {};
    (client as unknown as { hasActivePrompt: (s: string) => boolean }).hasActivePrompt = () => true;
    const sendRequest = vi.fn().mockReturnValue({
      id: 99,
      promise: Promise.resolve({ stopReason: 'end_turn' }),
    });
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    const result = await client.sendLiveInput({
      sessionId: 'sess-live',
      instruction: 'prefer the smaller fix',
    });

    expect(result).toEqual({ code: 'delivered', sessionId: 'sess-live' });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith(LIVE_INPUT_METHOD, {
      sessionId: 'sess-live',
      prompt: [{ type: 'text', text: 'prefer the smaller fix' }],
    });
    client.dispose();
  });

  it('returns rejected on agent error responses without inventing queue state', async () => {
    const { AcpClient } = await import('./acp-client');
    const client = new AcpClient({
      key: 'live-input-test-reject',
      label: 'TestAgent',
      command: 'false',
      args: [],
    });
    (client as unknown as { liveInputSupported: boolean }).liveInputSupported = true;
    (client as unknown as { ensureConnected: () => Promise<void> }).ensureConnected = async () => {};
    (client as unknown as { hasActivePrompt: (s: string) => boolean }).hasActivePrompt = () => true;
    const sendRequest = vi.fn().mockReturnValue({
      id: 100,
      promise: Promise.reject(new Error('Method not found')),
    });
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    const result = await client.sendLiveInput({
      sessionId: 'sess-live',
      instruction: 'steer',
    });

    expect(result).toEqual({ code: 'rejected', reason: 'Method not found' });
    client.dispose();
  });

  it('returns cancelled when the signal aborts before or during dispatch', async () => {
    const { AcpClient } = await import('./acp-client');
    const client = new AcpClient({
      key: 'live-input-test-cancel',
      label: 'TestAgent',
      command: 'false',
      args: [],
    });
    (client as unknown as { liveInputSupported: boolean }).liveInputSupported = true;
    (client as unknown as { ensureConnected: () => Promise<void> }).ensureConnected = async () => {};
    (client as unknown as { hasActivePrompt: (s: string) => boolean }).hasActivePrompt = () => true;

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      client.sendLiveInput({
        sessionId: 'sess-live',
        instruction: 'steer',
        signal: preAborted.signal,
      }),
    ).resolves.toMatchObject({ code: 'cancelled' });

    let resolveReq!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveReq = resolve;
    });
    const sendRequest = vi.fn().mockReturnValue({ id: 101, promise: pending });
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    const mid = new AbortController();
    const liveP = client.sendLiveInput({
      sessionId: 'sess-live',
      instruction: 'steer mid',
      signal: mid.signal,
    });
    mid.abort();
    await expect(liveP).resolves.toMatchObject({ code: 'cancelled' });
    resolveReq({ stopReason: 'end_turn' });
    client.dispose();
  });

  it('returns rejected for empty sessionId/instruction without sending', async () => {
    const { AcpClient } = await import('./acp-client');
    const client = new AcpClient({
      key: 'live-input-test-malformed',
      label: 'TestAgent',
      command: 'false',
      args: [],
    });
    const sendRequest = vi.fn();
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    await expect(client.sendLiveInput({ sessionId: '', instruction: 'x' })).resolves.toMatchObject({
      code: 'rejected',
    });
    await expect(client.sendLiveInput({ sessionId: 's', instruction: '  ' })).resolves.toMatchObject({
      code: 'rejected',
    });
    expect(sendRequest).not.toHaveBeenCalled();
    client.dispose();
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
