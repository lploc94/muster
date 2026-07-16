import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedPromptCancel,
  deriveLiveInputSupport,
  encodeElicitationContent,
  encodeGrokAnswers,
  killProcessTree,
  LIVE_INPUT_METHOD,
  normalizeAgentQuestions,
  parseElicitationCreate,
  setPermissionController,
  terminateProcessTree,
  type KillableProcess,
  type PermissionController,
  type PromptResult,
} from './acp-client';
import type { PermissionMode } from './permission-policy';

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

    await expect(wrapped).resolves.toEqual({
      stopReason: 'cancelled',
      cancelConfidence: 'forced',
    });
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

    // Cooperative settle has no cancelConfidence: 'forced' (confirmed path).
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
  it('policy B: attempts wire send even when capability evidence is absent', async () => {
    const { AcpClient } = await import('./acp-client');
    const client = new AcpClient({
      key: 'live-input-test-always-try',
      label: 'TestAgent',
      command: 'false',
      args: [],
    });
    // Simulate a connected client that never advertised live input.
    (client as unknown as { liveInputSupported: boolean }).liveInputSupported = false;
    (client as unknown as { ensureConnected: () => Promise<void> }).ensureConnected = async () => {};
    const sendRequest = vi.fn(() => ({
      id: 1,
      promise: Promise.resolve({}),
    }));
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;
    (client as unknown as { hasActivePrompt: (s: string) => boolean }).hasActivePrompt = () => true;

    const result = await client.sendLiveInput({
      sessionId: 'sess-1',
      instruction: 'steer left',
    });

    expect(result).toEqual({ code: 'delivered', sessionId: 'sess-1' });
    expect(sendRequest).toHaveBeenCalledTimes(1);
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

describe('normalizeAgentQuestions', () => {
  it('maps Grok question/options{label} into prompt/options strings', () => {
    expect(
      normalizeAgentQuestions([
        {
          question: 'Pick one?',
          options: [{ label: 'A', description: 'alpha' }, { label: 'B' }],
          multiSelect: false,
        },
      ]),
    ).toEqual([
      {
        prompt: 'Pick one?',
        options: ['A', 'B'],
        allowFreeText: false,
        multiSelect: false,
      },
    ]);
  });

  it('accepts prompt + string options (muster_bridge shape)', () => {
    expect(
      normalizeAgentQuestions([{ prompt: 'Freeform?', options: ['yes', 'no'], multiSelect: true }]),
    ).toEqual([
      {
        prompt: 'Freeform?',
        options: ['yes', 'no'],
        allowFreeText: false,
        multiSelect: true,
      },
    ]);
  });

  it('drops empty / non-object entries', () => {
    expect(normalizeAgentQuestions([null, {}, { question: '' }, 'x'])).toEqual([]);
  });
});

describe('RFD elicitation parse (via acp-client re-export)', () => {
  it('parses form create params', () => {
    const parsed = parseElicitationCreate({
      sessionId: 'sess-1',
      mode: 'form',
      message: 'Pick approach',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: {
            type: 'string',
            description: 'How to proceed?',
            oneOf: [{ const: 'A' }, { const: 'B' }],
          },
        },
        required: ['question_0'],
      },
    });
    expect(parsed.kind).toBe('form');
  });

  it('encodes Grok answers keyed by question text', () => {
    expect(
      encodeGrokAnswers(
        [{ prompt: 'Pick one?', options: ['A', 'B'] }],
        { '0': { selected: ['A'], freeText: null } },
      ),
    ).toEqual({ 'Pick one?': 'A' });
  });
});

describe('M012 S03 flow: permission mode is sampled per request from mutable config', () => {
  afterEach(() => {
    setPermissionController(null);
  });

  type HandlePermission = (
    id: number | string,
    params: Record<string, unknown>,
  ) => Promise<void>;

  type ClientWithGate = {
    handlePermissionRequest: HandlePermission;
    respondOk: (id: number | string, result?: unknown) => void;
    dispose: () => void;
  };

  const permissionOptions = [
    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
  ];

  function makeMutableModeReader(initial: PermissionMode) {
    let mode: PermissionMode = initial;
    return {
      get: () => mode,
      set: (next: PermissionMode) => {
        mode = next;
      },
    };
  }

  function makeController(
    modeReader: { get: () => PermissionMode },
    hooks: {
      prompt?: PermissionController['prompt'];
      audit?: PermissionController['audit'];
    } = {},
  ): PermissionController {
    return {
      mode: () => modeReader.get(),
      isAllowlisted: () => false,
      remember: vi.fn(),
      audit: hooks.audit ?? vi.fn(),
      prompt: hooks.prompt ?? (async () => ({ allow: false, remember: false })),
    };
  }

  async function installClient(controller: PermissionController): Promise<{
    client: ClientWithGate;
    responses: Array<{ id: number | string; result: unknown }>;
  }> {
    const { AcpClient } = await import('./acp-client');
    const client = new AcpClient({
      key: 'permission-flow-test',
      label: 'TestAgent',
      command: 'false',
      args: [],
    }) as unknown as ClientWithGate;
    const responses: Array<{ id: number | string; result: unknown }> = [];
    client.respondOk = (id, result = {}) => {
      responses.push({ id, result });
    };
    setPermissionController(controller);
    return { client, responses };
  }

  async function requestPermission(
    client: ClientWithGate,
    id: number,
    kind: string,
    title: string,
  ): Promise<void> {
    await client.handlePermissionRequest(id, {
      sessionId: 'sess-flow',
      toolCall: { kind, title },
      options: permissionOptions,
    });
  }

  it('ask auto-allows reads without prompting', async () => {
    const mode = makeMutableModeReader('ask');
    const prompt = vi.fn(async () => ({ allow: false, remember: false }));
    const audit = vi.fn();
    const { client, responses } = await installClient(makeController(mode, { prompt, audit }));

    await requestPermission(client, 1, 'read', 'Read package.json');

    expect(prompt).not.toHaveBeenCalled();
    expect(responses).toEqual([
      { id: 1, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', source: 'read', classification: 'read' }),
    );
    client.dispose();
  });

  it('readonly denies new writes without prompting', async () => {
    const mode = makeMutableModeReader('readonly');
    const prompt = vi.fn(async () => ({ allow: true, remember: false }));
    const audit = vi.fn();
    const { client, responses } = await installClient(makeController(mode, { prompt, audit }));

    await requestPermission(client, 2, 'edit', 'Write src/host/permission-settings.ts');

    expect(prompt).not.toHaveBeenCalled();
    expect(responses).toEqual([
      { id: 2, result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        source: 'mode-readonly',
        classification: 'write',
      }),
    );
    client.dispose();
  });

  it('allow permits new writes without prompting', async () => {
    const mode = makeMutableModeReader('allow');
    const prompt = vi.fn(async () => ({ allow: false, remember: false }));
    const audit = vi.fn();
    const { client, responses } = await installClient(makeController(mode, { prompt, audit }));

    await requestPermission(client, 3, 'execute', 'Run tests');

    expect(prompt).not.toHaveBeenCalled();
    expect(responses).toEqual([
      { id: 3, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'allow',
        source: 'mode-allow',
        classification: 'write',
      }),
    );
    client.dispose();
  });

  it('samples mode once per request and re-reads for the next request after config change', async () => {
    let resolvePrompt!: (value: { allow: boolean; remember: boolean }) => void;
    const pendingPrompt = new Promise<{ allow: boolean; remember: boolean }>((resolve) => {
      resolvePrompt = resolve;
    });
    const mode = makeMutableModeReader('ask');
    const prompt = vi.fn(async () => pendingPrompt);
    const audit = vi.fn();
    const { client, responses } = await installClient(makeController(mode, { prompt, audit }));

    // Ask-mode write samples mode once and stays pending until the user resolves it.
    const pendingWrite = client.handlePermissionRequest(20, {
      sessionId: 'sess-flow',
      toolCall: { kind: 'edit', title: 'Write pending' },
      options: permissionOptions,
    });
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(responses).toHaveLength(0);

    // Config flips to allow while the first request is still pending — must stay pending.
    mode.set('allow');
    expect(responses).toHaveLength(0);

    // A concurrent new write under allow auto-allows without waiting on the pending ask.
    await client.handlePermissionRequest(21, {
      sessionId: 'sess-flow',
      toolCall: { kind: 'edit', title: 'Write after allow' },
      options: permissionOptions,
    });
    expect(responses).toEqual([
      { id: 21, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } },
    ]);
    expect(prompt).toHaveBeenCalledTimes(1);

    // User resolves the original ask-mode request (deny).
    resolvePrompt({ allow: false, remember: false });
    await pendingWrite;
    expect(responses).toEqual([
      { id: 21, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } },
      { id: 20, result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', source: 'user' }),
    );

    // Next request re-reads the mutated allow mode.
    await client.handlePermissionRequest(22, {
      sessionId: 'sess-flow',
      toolCall: { kind: 'execute', title: 'Run after allow' },
      options: permissionOptions,
    });
    expect(responses.at(-1)).toEqual({
      id: 22,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    });
    expect(prompt).toHaveBeenCalledTimes(1);

    // Flip to readonly — next write is denied without prompting.
    mode.set('readonly');
    await client.handlePermissionRequest(23, {
      sessionId: 'sess-flow',
      toolCall: { kind: 'edit', title: 'Write after readonly' },
      options: permissionOptions,
    });
    expect(responses.at(-1)).toEqual({
      id: 23,
      result: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
    });
    expect(prompt).toHaveBeenCalledTimes(1);

    client.dispose();
  });
});
