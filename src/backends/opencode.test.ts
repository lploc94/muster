// Characterization tests for the OpenCode ACP adapter (`OpenCodeBackend`).
//
// OpenCode is a near-clone of the canonical Claude adapter. These tests lock in
// the CURRENT observable behavior of `run()` — the emitted `NormalizedEvent`
// stream — so the planned dedup refactor into a shared `runAcpTurn` can be
// proven behavior-preserving. They are intentionally black-box: the private
// mapping helpers are exercised only through `run()`, which is the seam the
// refactor must keep stable.
//
// OpenCode matches Claude on ALL mapping behavior (empty chunks dropped,
// full FAILURE_STOP_REASONS incl. max_turn_requests, a usage_update case,
// post-turn usage from result.usage incl. thoughtTokens, mcp/builtin kind).
// The documented drift is `OPENCODE_AGENT_CONFIG.resolveAuth`, which is a CONST
// config whose resolveAuth ALWAYS returns null and never throws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, RunOptions } from '../types';
import { makeFakeAcpClient, runTurn, type FakeAcpHarness } from './acp-test-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { OpenCodeBackend, OPENCODE_AGENT_CONFIG } from './opencode';

function options(over: Partial<RunOptions> = {}): RunOptions {
  return { prompt: 'hello', ...over };
}

/** Narrow helper: assistant/reasoning delta contents in order. */
function contents(events: NormalizedEvent[], type: 'assistantDelta' | 'reasoningDelta'): string[] {
  return events.filter((e) => e.type === type).map((e) => (e as { content: string }).content);
}

let fake: FakeAcpHarness;

beforeEach(() => {
  fake = makeFakeAcpClient();
  H.current = fake;
});

afterEach(() => {
  H.current = null;
});

describe('OpenCodeBackend — identity', () => {
  it('exposes the opencode name and full capability set', () => {
    const b = new OpenCodeBackend();
    expect(b.name).toBe('opencode');
    expect(b.capabilities).toEqual({
      supportsReasoning: true,
      supportsDetailedToolEvents: true,
      supportsMCP: true,
      supportsLiveInput: true,
    });
  });
});

describe('OpenCodeBackend.run — session + streaming', () => {
  it('emits sessionStarted, streams assistant deltas with a stable messageId, then turnCompleted', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
      ],
      result: { stopReason: 'end_turn' },
    });

    expect(events[0]).toEqual({ type: 'sessionStarted', sessionId: 'sess-1' });
    expect(contents(events, 'assistantDelta')).toEqual(['Hel', 'lo']);

    const ids = new Set(
      events.filter((e) => e.type === 'assistantDelta').map((e) => (e as { messageId: string }).messageId),
    );
    expect(ids.size).toBe(1);

    expect(events.at(-1)).toEqual({ type: 'turnCompleted', meta: { stopReason: 'end_turn' } });
  });

  it('maps agent_thought_chunk to reasoningDelta', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }],
    });
    expect(contents(events, 'reasoningDelta')).toEqual(['thinking']);
  });

  it('connects (with extraEnv) before opening a session, then passes cwd/prompt through', async () => {
    const extraEnv = { FOO: 'bar' };
    await runTurn(new OpenCodeBackend(), options({ prompt: 'do it', cwd: '/work', extraEnv }), fake, {});
    // The ACP connection must be established (with the run's extraEnv) before a session is opened.
    expect(fake.calls.ensureConnected).toEqual([[extraEnv]]);
    expect(fake.callOrder.indexOf('ensureConnected')).toBeLessThan(fake.callOrder.indexOf('newSession'));
    expect(fake.calls.newSession[0][0]).toBe('/work');
    expect(fake.calls.loadSession).toHaveLength(0);
    // prompt(sessionId, promptText, signal)
    expect(fake.calls.prompt[0][0]).toBe('sess-1');
    expect(fake.calls.prompt[0][1]).toBe('do it');
  });

  it('resumes an existing session via loadSession when resumeId is set', async () => {
    const events = await runTurn(new OpenCodeBackend(), options({ resumeId: 'sess-r' }), fake, {});
    expect(fake.calls.ensureConnected).toHaveLength(1);
    expect(fake.callOrder.indexOf('ensureConnected')).toBeLessThan(fake.callOrder.indexOf('loadSession'));
    expect(fake.calls.loadSession[0][0]).toBe('sess-r');
    expect(fake.calls.newSession).toHaveLength(0);
    expect(events[0]).toEqual({ type: 'sessionStarted', sessionId: 'sess-1' });
  });
});

describe('OpenCodeBackend.run — tool events', () => {
  it('maps tool_call to toolStarted with the opencode: id prefix, name, kind and input', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'abc',
          title: 'Read',
          kind: 'mcp',
          rawInput: { path: '/x' },
          _meta: { origin: 'test' },
        },
      ],
    });
    const started = events.find((e) => e.type === 'toolStarted');
    expect(started).toEqual({
      type: 'toolStarted',
      toolCallId: 'opencode:abc',
      name: 'Read',
      kind: 'mcp',
      input: { path: '/x' },
      meta: { origin: 'test' },
    });
  });

  it('classifies a non-mcp tool_call kind as builtin and defaults a missing title to "tool"', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 'abc', rawInput: {} }],
    });
    const started = events.find((e) => e.type === 'toolStarted') as {
      kind: string;
      name: string;
    };
    expect(started.kind).toBe('builtin');
    expect(started.name).toBe('tool');
  });

  it('emits raw for a tool_call missing a toolCallId', async () => {
    const update = { sessionUpdate: 'tool_call', title: 'Read' };
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });

  it('maps a completed tool_call_update to toolCompleted success with extracted text output', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'abc',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        },
      ],
    });
    expect(events).toContainEqual({
      type: 'toolCompleted',
      toolCallId: 'opencode:abc',
      outcome: 'success',
      output: 'done',
      meta: undefined,
    });
  });

  it('maps a failed tool_call_update to toolCompleted error, defaulting the message when no text', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'tool_call_update', toolCallId: 'abc', status: 'failed' }],
    });
    const done = events.find((e) => e.type === 'toolCompleted') as { outcome: string; error: string };
    expect(done.outcome).toBe('error');
    expect(done.error).toBe('Tool failed');
  });

  it('reads a status from _meta.updateParams when the top-level status is absent', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'abc',
          _meta: { updateParams: { status: 'COMPLETED' } },
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
        },
      ],
    });
    const done = events.find((e) => e.type === 'toolCompleted') as { outcome: string; output: string };
    expect(done.outcome).toBe('success');
    expect(done.output).toBe('ok');
  });

  it('maps an in-progress tool_call_update to toolUpdated', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [
        { sessionUpdate: 'tool_call_update', toolCallId: 'abc', status: 'in_progress', rawInput: { n: 1 } },
      ],
    });
    expect(events).toContainEqual({
      type: 'toolUpdated',
      toolCallId: 'opencode:abc',
      input: { n: 1 },
      meta: undefined,
    });
  });
});

describe('OpenCodeBackend.run — usage', () => {
  it('emits a usage event from usage_update (used/size) before the terminal', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'usage_update', used: 10, size: 100 }],
    });
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const termIdx = events.findIndex((e) => e.type === 'turnCompleted');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(events[usageIdx]).toEqual({ type: 'usage', usage: { used: 10, size: 100 } });
    expect(usageIdx).toBeLessThan(termIdx);
  });

  it('emits a usage event from the prompt result (including thoughtTokens) before the terminal', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      result: {
        stopReason: 'end_turn',
        usage: { totalTokens: 5, thoughtTokens: 2, modelId: 'opencode-x' },
        _meta: { trace: 1 },
      },
    });
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const termIdx = events.findIndex((e) => e.type === 'turnCompleted');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(termIdx);
    expect(events[usageIdx]).toEqual({
      type: 'usage',
      usage: { totalTokens: 5, thoughtTokens: 2, modelId: 'opencode-x' },
      meta: { trace: 1 },
    });
  });

  it('emits no result usage event when the result carries no usage', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      result: { stopReason: 'end_turn' },
    });
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });
});

describe('OpenCodeBackend.run — terminal classification', () => {
  it('end_turn -> turnCompleted with meta.stopReason', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { result: { stopReason: 'end_turn' } });
    expect(events.at(-1)).toEqual({ type: 'turnCompleted', meta: { stopReason: 'end_turn' } });
  });

  it('stopReason "cancelled" -> cancellation error', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { result: { stopReason: 'cancelled' } });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Turn cancelled', isCancellation: true, meta: { interruptConfidence: 'confirmed' } });
  });

  it('missing stopReason -> "prompt ended without a stopReason" error', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { result: {} });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'OpenCode prompt ended without a stopReason', meta: { failureClass: 'terminal_received' } });
  });

  it('a failure stopReason -> "stopped" error WITHOUT meta', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { result: { stopReason: 'max_tokens' } });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'OpenCode stopped: max_tokens', meta: { failureClass: 'terminal_received' } });
  });

  it('max_turn_requests is a failure stopReason for OpenCode -> error WITHOUT meta', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      result: { stopReason: 'max_turn_requests' },
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'OpenCode stopped: max_turn_requests', meta: { failureClass: 'terminal_received' } });
  });

  it('a non-failure non-end_turn stopReason -> "stopped" error WITH meta', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { result: { stopReason: 'surprise' } });
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'OpenCode stopped: surprise',
      meta: { failureClass: 'terminal_received', stopReason: 'surprise' },
    });
  });
});

describe('OpenCodeBackend.run — empty/unknown chunk handling (drops empties like claude)', () => {
  it('drops an empty-string assistant chunk (no assistantDelta, no raw)', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }],
    });
    expect(events.some((e) => e.type === 'assistantDelta')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('drops an empty-string thought chunk', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } }],
    });
    expect(events.some((e) => e.type === 'reasoningDelta')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('emits raw for a recognized chunk with a non-string text shape', async () => {
    const update = { sessionUpdate: 'agent_message_chunk', content: {} };
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });

  it('drops user_message_chunk and available_commands_update noise', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      updates: [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } },
        { sessionUpdate: 'available_commands_update', commands: [] },
      ],
    });
    expect(events.filter((e) => e.type === 'raw')).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(['sessionStarted', 'turnCompleted']);
  });

  it('emits raw for an unknown session update kind', async () => {
    const update = { sessionUpdate: 'mystery_kind', foo: 1 };
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });
});

describe('OpenCodeBackend.run — connection lines', () => {
  it('prefixes stderr and non-json connection lines as raw', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      conn: [
        ['boom', 'stderr'],
        ['{partial', 'non-json'],
      ],
    });
    expect(events).toContainEqual({ type: 'raw', line: '[stderr] boom' });
    expect(events).toContainEqual({ type: 'raw', line: '[acp] {partial' });
  });
});

describe('OpenCodeBackend.run — cancellation & errors', () => {
  it('yields only a cancellation terminal when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await runTurn(new OpenCodeBackend(), options({ signal: controller.signal }), fake);
    expect(events).toEqual([{ type: 'error', message: 'Turn cancelled', isCancellation: true }]);
    expect(fake.calls.newSession).toHaveLength(0);
  });

  it('cancels the active session and yields a cancellation terminal when aborted mid-turn', async () => {
    const controller = new AbortController();
    const backend = new OpenCodeBackend();
    const events: NormalizedEvent[] = [];
    const pump = (async () => {
      for await (const ev of backend.run(options({ signal: controller.signal }))) events.push(ev);
    })();
    await fake.readyP;
    controller.abort();
    fake.resolve({ stopReason: 'end_turn' });
    await pump;
    expect(fake.calls.cancel[0][0]).toBe('sess-1');
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Turn cancelled', isCancellation: true, meta: { interruptConfidence: 'confirmed' } });
  });

  it('reports an unsupported resume when the client cannot load sessions', async () => {
    fake = makeFakeAcpClient({ loadSessionSupported: false });
    H.current = fake;
    const events = await runTurn(new OpenCodeBackend(), options({ resumeId: 'sess-r' }), fake);
    expect(events).toContainEqual({ type: 'error', message: 'OpenCode agent does not support session resume' });
    expect(fake.calls.loadSession).toHaveLength(0);
  });

  it('wraps a generic prompt rejection with the "OpenCode ACP error" prefix', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, { reject: new Error('boom') });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'OpenCode ACP error: boom' });
  });

  it('passes through an "agent exited" rejection message unwrapped', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      reject: new Error('OpenCode agent exited (code 1)'),
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'OpenCode agent exited (code 1)' });
  });

  it('passes through a "not running" rejection message unwrapped', async () => {
    const events = await runTurn(new OpenCodeBackend(), options(), fake, {
      reject: new Error('agent process not running'),
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'agent process not running' });
  });
});

describe('OPENCODE_AGENT_CONFIG.resolveAuth (drift: always returns null, never throws)', () => {
  it('is a const config object (not a factory function)', () => {
    expect(typeof OPENCODE_AGENT_CONFIG).toBe('object');
    expect(OPENCODE_AGENT_CONFIG.key).toBe('opencode');
    expect(OPENCODE_AGENT_CONFIG.label).toBe('OpenCode');
    expect(typeof OPENCODE_AGENT_CONFIG.resolveAuth).toBe('function');
  });

  it('returns null even when an api-key method id and an API key in env are present', () => {
    const result = OPENCODE_AGENT_CONFIG.resolveAuth!(
      { authMethods: [{ id: 'api-key' }] } as never,
      { OPENCODE_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-other' } as never,
    );
    expect(result).toBeNull();
  });

  it('returns null for the advertised interactive opencode-login method', () => {
    const result = OPENCODE_AGENT_CONFIG.resolveAuth!(
      { authMethods: [{ id: 'opencode-login' }] } as never,
      {} as never,
    );
    expect(result).toBeNull();
  });

  it('returns null for empty init and empty env', () => {
    const result = OPENCODE_AGENT_CONFIG.resolveAuth!({} as never, {} as never);
    expect(result).toBeNull();
  });

  it('returns null with no arguments at all (never throws)', () => {
    expect(() => OPENCODE_AGENT_CONFIG.resolveAuth!(undefined as never, undefined as never)).not.toThrow();
    expect(OPENCODE_AGENT_CONFIG.resolveAuth!(undefined as never, undefined as never)).toBeNull();
  });
});
