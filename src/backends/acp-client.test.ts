import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

import {
  AcpClient,
  MAX_ACP_FRAME_BYTES,
  boundedPromptCancel,
  disposeSharedAcpClient,
  encodeElicitationContent,
  encodeGrokAnswers,
  extractCommandNames,
  feedBoundedNdjson,
  getSharedAcpClient,
  killProcessTree,
  normalizeAgentQuestions,
  parseElicitationCreate,
  peekSharedAcpClient,
  setPermissionController,
  terminateProcessTree,
  type AcpAgentConfig,
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

describe('feedBoundedNdjson', () => {
  it('reassembles split UTF-8 frames and emits only complete lines', () => {
    const payload = Buffer.from('{"text":"🙂"}\n{"ok":true}\n', 'utf8');
    const split = payload.indexOf(Buffer.from('🙂')) + 2;
    const first = feedBoundedNdjson(Buffer.alloc(0), payload.subarray(0, split));
    expect(first.lines).toEqual([]);
    expect(first.exceeded).toBe(false);

    const second = feedBoundedNdjson(first.remainder, payload.subarray(split));
    expect(second.lines).toEqual(['{"text":"🙂"}', '{"ok":true}']);
    expect(second.remainder).toHaveLength(0);
  });

  it('rejects an unterminated frame as soon as its byte cap is exceeded', () => {
    const first = feedBoundedNdjson(Buffer.alloc(0), Buffer.alloc(8, 97), 10);
    expect(first.exceeded).toBe(false);
    const second = feedBoundedNdjson(first.remainder, Buffer.alloc(3, 98), 10);
    expect(second.exceeded).toBe(true);
    expect(second.remainder).toHaveLength(0);
    expect(second.observedBytes).toBe(11);
  });

  it('keeps the production cap bounded at two MiB', () => {
    expect(MAX_ACP_FRAME_BYTES).toBe(2 * 1024 * 1024);
  });
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

describe('AcpClient advertised commands (tri-state)', () => {
  const config: AcpAgentConfig = {
    key: 'fake-backend',
    label: 'Fake',
    command: 'noop',
    args: [],
  };

  it('is undefined before any advertisement (UNKNOWN)', () => {
    const client = new AcpClient(config);
    expect(client.getAdvertisedCommands()).toBeUndefined();
  });

  it('records the advertised set and reflects it (KNOWN)', () => {
    const client = new AcpClient(config);
    client.recordAdvertisedCommands(['plan', 'review']);
    const set = client.getAdvertisedCommands();
    expect(set).toBeInstanceOf(Set);
    expect(set?.has('plan')).toBe(true);
    expect(set?.has('review')).toBe(true);
    expect(set?.has('nope')).toBe(false);
  });

  it('records an empty list as a KNOWN-but-empty set (fail-closed), not undefined', () => {
    const client = new AcpClient(config);
    client.recordAdvertisedCommands([]);
    const set = client.getAdvertisedCommands();
    expect(set).toBeInstanceOf(Set);
    expect(set?.size).toBe(0);
  });

  it('replaces the set on re-advertisement (agent re-sends the full list)', () => {
    const client = new AcpClient(config);
    client.recordAdvertisedCommands(['a', 'b']);
    client.recordAdvertisedCommands(['c']);
    const set = client.getAdvertisedCommands();
    expect([...(set ?? [])]).toEqual(['c']);
  });
});

describe('peekSharedAcpClient', () => {
  afterEach(() => {
    disposeSharedAcpClient();
  });

  it('returns undefined for a key that was never created (never spawns)', () => {
    expect(peekSharedAcpClient('never-made')).toBeUndefined();
  });

  it('returns the shared client keyed by config.key after it exists', () => {
    const config: AcpAgentConfig = {
      key: 'peek-backend',
      label: 'Peek',
      command: 'noop',
      args: [],
    };
    const created = getSharedAcpClient(config);
    expect(peekSharedAcpClient('peek-backend')).toBe(created);
  });
});

describe('extractCommandNames', () => {
  it('extracts names from an array of { name } objects (ACP spec shape)', () => {
    expect(
      extractCommandNames({
        sessionUpdate: 'available_commands_update',
        commands: [{ name: 'plan', description: 'x' }, { name: 'review' }],
      }),
    ).toEqual(['plan', 'review']);
  });

  it('extracts names from an array of bare strings', () => {
    expect(extractCommandNames({ commands: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('returns [] for an empty array (KNOWN-but-empty advertisement)', () => {
    expect(extractCommandNames({ commands: [] })).toEqual([]);
  });

  it('returns [] when the commands field is missing', () => {
    expect(extractCommandNames({ sessionUpdate: 'available_commands_update' })).toEqual([]);
  });

  it('returns [] when commands is not an array', () => {
    expect(extractCommandNames({ commands: 'nope' })).toEqual([]);
    expect(extractCommandNames({ commands: { name: 'x' } })).toEqual([]);
  });

  it('returns [] for non-object input without throwing (null / undefined / primitive)', () => {
    expect(extractCommandNames(null)).toEqual([]);
    expect(extractCommandNames(undefined)).toEqual([]);
    expect(extractCommandNames('nope')).toEqual([]);
    expect(extractCommandNames(42)).toEqual([]);
  });

  it('skips items with no usable name (null / non-string name / number)', () => {
    expect(
      extractCommandNames({
        commands: [{ name: 'ok' }, null, { name: 42 }, {}, 7, { description: 'no name' }],
      }),
    ).toEqual(['ok']);
  });
});

describe('AcpClient.onLine advertised-commands capture', () => {
  const config: AcpAgentConfig = {
    key: 'online-backend',
    label: 'OnLine',
    command: 'noop',
    args: [],
  };
  const feed = (client: AcpClient, line: string): void => {
    (client as unknown as { onLine(l: string): void }).onLine(line);
  };

  it('records available_commands_update even with NO session sink registered', () => {
    // Reproduces the timing gap: the notification can arrive right after
    // session/new, before runAcpTurn registers the session sink.
    const client = new AcpClient(config);
    expect(client.getAdvertisedCommands()).toBeUndefined();
    feed(
      client,
      JSON.stringify({
        method: 'session/update',
        params: {
          sessionId: 's-unregistered',
          update: {
            sessionUpdate: 'available_commands_update',
            commands: [{ name: 'plan' }, { name: 'review' }],
          },
        },
      }),
    );
    const set = client.getAdvertisedCommands();
    expect(set).toBeInstanceOf(Set);
    expect([...(set ?? [])].sort()).toEqual(['plan', 'review']);
  });

  it('records an empty advertisement as KNOWN-but-empty (not undefined)', () => {
    const client = new AcpClient(config);
    feed(
      client,
      JSON.stringify({
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'available_commands_update', commands: [] } },
      }),
    );
    expect(client.getAdvertisedCommands()?.size).toBe(0);
  });

  it('leaves the cache untouched for unrelated session updates', () => {
    const client = new AcpClient(config);
    feed(
      client,
      JSON.stringify({
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: {} } },
      }),
    );
    expect(client.getAdvertisedCommands()).toBeUndefined();
  });
});

describe('AcpClient advertised-commands lifecycle', () => {
  const config: AcpAgentConfig = {
    key: 'lifecycle-backend',
    label: 'Lifecycle',
    command: 'noop',
    args: [],
  };

  it('drops the cache on process teardown (reconnect must re-advertise)', () => {
    const client = new AcpClient(config);
    client.recordAdvertisedCommands(['plan']);
    expect(client.getAdvertisedCommands()?.has('plan')).toBe(true);
    // teardownProcess is safe to call with no live process (rl/proc undefined).
    (client as unknown as { teardownProcess(): void }).teardownProcess();
    expect(client.getAdvertisedCommands()).toBeUndefined();
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

/**
 * Controllable ACP child process for reconnect/fencing regressions.
 * Auto-answers initialize/authenticate so ensureConnected can complete,
 * while leaving later requests pending for the test to settle.
 */
class FakeStdioChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: EventEmitter & {
    writable: boolean;
    write: (data: string) => boolean;
  };

  constructor(public pid: number) {
    super();
    this.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (data: string): boolean => {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          let msg: { id?: number; method?: string };
          try {
            msg = JSON.parse(line) as { id?: number; method?: string };
          } catch {
            continue;
          }
          if (msg.id == null) continue;
          if (msg.method === 'initialize') {
            queueMicrotask(() => {
              this.stdout.emit(
                'data',
                Buffer.from(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: { protocolVersion: 1, agentCapabilities: {} },
                  }) + '\n',
                ),
              );
            });
          } else if (msg.method === 'authenticate') {
            queueMicrotask(() => {
              this.stdout.emit(
                'data',
                Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n'),
              );
            });
          }
        }
        return true;
      },
    });
  }

  kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    return true;
  });
}

describe('AcpClient retired stdout fencing (R038 / M021-S02)', () => {
  const config: AcpAgentConfig = {
    key: 'stdout-fence-backend',
    label: 'Fence',
    command: 'fake-acp',
    args: ['stdio'],
  };

  afterEach(() => {
    mockSpawn.mockReset();
  });

  it('detaches retired stdout and keeps late bytes out of the fresh connection', async () => {
    const child1 = new FakeStdioChild(1001);
    const child2 = new FakeStdioChild(1002);
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const client = new AcpClient(config);
    await client.ensureConnected();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const sessionUpdates: SessionUpdateLike[] = [];
    const connectionLines: Array<{ line: string; source: string }> = [];
    client.registerSessionSink('sess-live', (update) => {
      sessionUpdates.push(update as SessionUpdateLike);
    });
    client.registerConnectionSink((line, source) => {
      connectionLines.push({ line, source });
    });

    // Capture the retired listener before teardown so we can also exercise the
    // ownership guard for an already-queued callback after replacement.
    const retiredStdoutListeners = [
      ...child1.stdout.listeners('data'),
    ] as Array<(chunk: Buffer) => void>;
    expect(retiredStdoutListeners.length).toBeGreaterThan(0);

    // Reconnect without dispose() so session/connection sinks stay registered.
    (client as unknown as { teardownProcess(): void }).teardownProcess();
    (client as unknown as { connectPromise?: Promise<void> }).connectPromise = undefined;

    // Teardown must detach the exact retired stdout data listener.
    expect(child1.stdout.listenerCount('data')).toBe(0);

    await client.ensureConnected();
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // Track request ids written to the fresh child so we can attempt a stale settle.
    let lastFreshRequestId: number | undefined;
    const originalWrite = child2.stdin.write.bind(child2.stdin);
    child2.stdin.write = (data: string): boolean => {
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === 'number') lastFreshRequestId = msg.id;
        } catch {
          // ignore non-json writes
        }
      }
      return originalWrite(data);
    };

    const pending = (
      client as unknown as {
        request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
      }
    ).request(
      'session/prompt',
      { sessionId: 'sess-live', prompt: [{ type: 'text', text: 'hi' }] },
      2_000,
    );
    expect(lastFreshRequestId).toBeTypeOf('number');

    // Late complete JSON session update from the retired child.
    const staleSessionFrame =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-live',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'STALE' },
          },
        },
      }) + '\n';
    child1.stdout.emit('data', Buffer.from(staleSessionFrame));

    // Late non-JSON complete line from the retired child.
    child1.stdout.emit('data', Buffer.from('NOT-JSON-FROM-RETIRED\n'));

    // Late partial NDJSON fragment that would poison the shared remainder.
    child1.stdout.emit('data', Buffer.from('{"stale":'));

    // Late response that would settle the fresh connection's pending request.
    child1.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: lastFreshRequestId,
          result: { stopReason: 'STALE' },
        }) + '\n',
      ),
    );

    // Already-queued ownership path: invoke the captured retired callback directly.
    for (const listener of retiredStdoutListeners) {
      listener(Buffer.from(staleSessionFrame));
      listener(Buffer.from('QUEUED-NON-JSON\n'));
      listener(Buffer.from('{"partial'));
      listener(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: lastFreshRequestId,
            result: { stopReason: 'STALE_QUEUED' },
          }) + '\n',
        ),
      );
    }

    // Fresh child delivers a clean valid frame — must not be prefixed by retired partials.
    child2.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-live',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'FRESH' },
            },
          },
        }) + '\n',
      ),
    );

    expect(sessionUpdates).toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'FRESH' },
      },
    ]);
    expect(connectionLines).toEqual([]);

    const pendingMap = (
      client as unknown as { pending: Map<number, unknown> }
    ).pending;
    expect(pendingMap.has(lastFreshRequestId!)).toBe(true);

    child2.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: lastFreshRequestId,
          result: { stopReason: 'end_turn' },
        }) + '\n',
      ),
    );
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });

    client.dispose();
  });
});

type SessionUpdateLike = {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
};
