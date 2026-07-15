import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AcpClient,
  boundedPromptCancel,
  disposeSharedAcpClient,
  encodeElicitationContent,
  encodeGrokAnswers,
  extractCommandNames,
  getSharedAcpClient,
  killProcessTree,
  normalizeAgentQuestions,
  parseElicitationCreate,
  peekSharedAcpClient,
  terminateProcessTree,
  type AcpAgentConfig,
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
