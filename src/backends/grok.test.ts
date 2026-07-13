// Characterization tests for the Grok ACP adapter (`GrokBackend`).
//
// Grok is a near-clone of the canonical Claude adapter with a handful of
// documented drifts (see the per-test notes). These tests lock in the CURRENT
// observable behavior of `run()` — the emitted `NormalizedEvent` stream — so the
// planned dedup refactor into a shared `runAcpTurn` can be proven
// behavior-preserving. They are intentionally black-box: the private mapping
// helpers are exercised only through `run()`, which is the seam the refactor
// must keep stable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, RunOptions } from '../types';
import { makeFakeAcpClient, runTurn, type FakeAcpHarness } from './acp-test-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { GrokBackend, GROK_AGENT_CONFIG } from './grok';

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

describe('GrokBackend — identity', () => {
  it('exposes the grok name and full capability set', () => {
    const b = new GrokBackend();
    expect(b.name).toBe('grok');
    expect(b.capabilities).toEqual({
      supportsReasoning: true,
      supportsDetailedToolEvents: true,
      supportsMCP: true,
      supportsLiveInput: true,
    });
  });
});

describe('GrokBackend.run — session + streaming', () => {
  it('emits sessionStarted, streams assistant deltas with a stable messageId, then turnCompleted', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
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
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }],
    });
    expect(contents(events, 'reasoningDelta')).toEqual(['thinking']);
  });

  it('connects (with extraEnv) before opening a session, then passes cwd/prompt through', async () => {
    const extraEnv = { FOO: 'bar' };
    await runTurn(new GrokBackend(), options({ prompt: 'do it', cwd: '/work', extraEnv }), fake, {});
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
    const events = await runTurn(new GrokBackend(), options({ resumeId: 'sess-r' }), fake, {});
    expect(fake.calls.ensureConnected).toHaveLength(1);
    expect(fake.callOrder.indexOf('ensureConnected')).toBeLessThan(fake.callOrder.indexOf('loadSession'));
    expect(fake.calls.loadSession[0][0]).toBe('sess-r');
    expect(fake.calls.newSession).toHaveLength(0);
    expect(events[0]).toEqual({ type: 'sessionStarted', sessionId: 'sess-1' });
  });
});

describe('GrokBackend.run — tool events', () => {
  it('maps tool_call to toolStarted with the grok: id prefix, name, input and meta', async () => {
    // Drift: kind is classified from _meta['x.ai/tool'].kind, not update.kind.
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'abc',
          title: 'Read',
          rawInput: { path: '/x' },
          _meta: { 'x.ai/tool': { kind: 'mcp' } },
        },
      ],
    });
    const started = events.find((e) => e.type === 'toolStarted');
    expect(started).toEqual({
      type: 'toolStarted',
      toolCallId: 'grok:abc',
      name: 'Read',
      kind: 'mcp',
      input: { path: '/x' },
      meta: { 'x.ai/tool': { kind: 'mcp' } },
    });
  });

  it('classifies a tool_call as builtin when x.ai/tool _meta is absent, even with top-level kind:mcp (drift)', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [
        { sessionUpdate: 'tool_call', toolCallId: 'abc', title: 'Read', kind: 'mcp', rawInput: { path: '/x' } },
      ],
    });
    const started = events.find((e) => e.type === 'toolStarted');
    expect(started).toEqual({
      type: 'toolStarted',
      toolCallId: 'grok:abc',
      name: 'Read',
      kind: 'builtin',
      input: { path: '/x' },
      meta: undefined,
    });
  });

  it('defaults a missing title to "tool"', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 'abc', rawInput: {} }],
    });
    const started = events.find((e) => e.type === 'toolStarted') as { name: string; kind: string };
    expect(started.name).toBe('tool');
    expect(started.kind).toBe('builtin');
  });

  it('emits raw for a tool_call missing a toolCallId', async () => {
    const update = { sessionUpdate: 'tool_call', title: 'Read' };
    const events = await runTurn(new GrokBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });

  it('maps a completed tool_call_update to toolCompleted success with extracted text output', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
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
      toolCallId: 'grok:abc',
      outcome: 'success',
      output: 'done',
      meta: undefined,
    });
  });

  it('maps a failed tool_call_update to toolCompleted error, defaulting the message when no text', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'tool_call_update', toolCallId: 'abc', status: 'failed' }],
    });
    const done = events.find((e) => e.type === 'toolCompleted') as { outcome: string; error: string };
    expect(done.outcome).toBe('error');
    expect(done.error).toBe('Tool failed');
  });

  it('reads a status from _meta.updateParams when the top-level status is absent', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
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
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [
        { sessionUpdate: 'tool_call_update', toolCallId: 'abc', status: 'in_progress', rawInput: { n: 1 } },
      ],
    });
    expect(events).toContainEqual({
      type: 'toolUpdated',
      toolCallId: 'grok:abc',
      input: { n: 1 },
      meta: undefined,
    });
  });
});

describe('GrokBackend.run — usage', () => {
  it('maps usage_update to a usage event (used/size) before the terminal', async () => {
    // Normalized (4b): Grok previously had no usage_update case (fell through to
    // raw); it now maps usage_update like the reference adapter.
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'usage_update', used: 10, size: 100 }],
    });
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const termIdx = events.findIndex((e) => e.type === 'turnCompleted');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(events[usageIdx]).toEqual({ type: 'usage', usage: { used: 10, size: 100 } });
    expect(usageIdx).toBeLessThan(termIdx);
  });

  it('emits a usage event from result._meta, dropping thoughtTokens, before the terminal (drift)', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      result: { stopReason: 'end_turn', _meta: { totalTokens: 5, thoughtTokens: 9, modelId: 'grok-x' } },
    });
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const termIdx = events.findIndex((e) => e.type === 'turnCompleted');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(termIdx);
    expect(events[usageIdx]).toEqual({
      type: 'usage',
      usage: { totalTokens: 5, modelId: 'grok-x' },
      meta: { totalTokens: 5, thoughtTokens: 9, modelId: 'grok-x' },
    });
  });

  it('emits no usage event when the result carries usage but no _meta (drift: usage read from _meta)', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      result: { stopReason: 'end_turn', usage: { totalTokens: 5 } },
    });
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('emits no usage event when result._meta has none of the picked usage keys', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      result: { stopReason: 'end_turn', _meta: { trace: 1 } },
    });
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });
});

describe('GrokBackend.run — terminal classification', () => {
  it('end_turn -> turnCompleted with meta.stopReason', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, { result: { stopReason: 'end_turn' } });
    expect(events.at(-1)).toEqual({ type: 'turnCompleted', meta: { stopReason: 'end_turn' } });
  });

  it('stopReason "cancelled" -> cancellation error', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, { result: { stopReason: 'cancelled' } });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Turn cancelled', isCancellation: true });
  });

  it('missing stopReason -> "prompt ended without a stopReason" error', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, { result: {} });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Grok prompt ended without a stopReason' });
  });

  it('a failure stopReason (max_tokens) -> "stopped" error WITHOUT meta', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, { result: { stopReason: 'max_tokens' } });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Grok stopped: max_tokens' });
  });

  it('treats max_turn_requests as a failure stopReason -> "stopped" error WITHOUT meta', async () => {
    // Normalized (4b): max_turn_requests is now in Grok's FAILURE set (as in the
    // other adapters), so it hits the failure branch (no meta) instead of the
    // generic non-end_turn branch (which carried meta.stopReason).
    const events = await runTurn(new GrokBackend(), options(), fake, {
      result: { stopReason: 'max_turn_requests' },
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Grok stopped: max_turn_requests' });
  });

  it('a non-failure non-end_turn stopReason -> "stopped" error WITH meta', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, { result: { stopReason: 'surprise' } });
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Grok stopped: surprise',
      meta: { stopReason: 'surprise' },
    });
  });
});

describe('GrokBackend.run — empty/unknown chunk handling', () => {
  it('drops an empty-string assistant chunk (no assistantDelta, no raw)', async () => {
    // Normalized (4b): Grok previously surfaced empty chunks as raw noise; it now
    // drops them like the reference adapter.
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }],
    });
    expect(events.some((e) => e.type === 'assistantDelta')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('drops an empty-string thought chunk', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } }],
    });
    expect(events.some((e) => e.type === 'reasoningDelta')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('emits raw for a recognized chunk with a non-string text shape', async () => {
    const update = { sessionUpdate: 'agent_message_chunk', content: {} };
    const events = await runTurn(new GrokBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });

  it('drops user_message_chunk and available_commands_update noise', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
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
    const events = await runTurn(new GrokBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });
});

describe('GrokBackend.run — connection lines', () => {
  it('prefixes stderr and non-json connection lines as raw', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      conn: [
        ['boom', 'stderr'],
        ['{partial', 'non-json'],
      ],
    });
    expect(events).toContainEqual({ type: 'raw', line: '[stderr] boom' });
    expect(events).toContainEqual({ type: 'raw', line: '[acp] {partial' });
  });
});

describe('GrokBackend.run — cancellation & errors', () => {
  it('yields only a cancellation terminal when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await runTurn(new GrokBackend(), options({ signal: controller.signal }), fake);
    expect(events).toEqual([{ type: 'error', message: 'Turn cancelled', isCancellation: true }]);
    expect(fake.calls.newSession).toHaveLength(0);
  });

  it('cancels the active session and yields a cancellation terminal when aborted mid-turn', async () => {
    const controller = new AbortController();
    const backend = new GrokBackend();
    const events: NormalizedEvent[] = [];
    const pump = (async () => {
      for await (const ev of backend.run(options({ signal: controller.signal }))) events.push(ev);
    })();
    await fake.readyP;
    controller.abort();
    fake.resolve({ stopReason: 'end_turn' });
    await pump;
    expect(fake.calls.cancel[0][0]).toBe('sess-1');
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Turn cancelled', isCancellation: true });
  });

  it('reports an unsupported resume when the client cannot load sessions', async () => {
    fake = makeFakeAcpClient({ loadSessionSupported: false });
    H.current = fake;
    const events = await runTurn(new GrokBackend(), options({ resumeId: 'sess-r' }), fake);
    expect(events).toContainEqual({ type: 'error', message: 'Grok agent does not support session resume' });
    expect(fake.calls.loadSession).toHaveLength(0);
  });

  it('wraps a generic prompt rejection with the "Grok ACP error" prefix', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, { reject: new Error('boom') });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Grok ACP error: boom' });
  });

  it('passes through an "agent exited" rejection message unwrapped', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      reject: new Error('Grok agent exited (code 1)'),
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Grok agent exited (code 1)' });
  });

  it('passes through a "Run `grok login`" rejection message unwrapped (drift: extra passthrough branch)', async () => {
    const events = await runTurn(new GrokBackend(), options(), fake, {
      reject: new Error('Run `grok login` first, or set XAI_API_KEY.'),
    });
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Run `grok login` first, or set XAI_API_KEY.',
    });
  });
});

describe('GROK_AGENT_CONFIG.resolveAuth (drift: throws when unresolved)', () => {
  it('selects xai.api_key when XAI_API_KEY and the matching method are present', () => {
    const result = GROK_AGENT_CONFIG.resolveAuth!(
      { authMethods: [{ id: 'xai.api_key' }] } as never,
      { XAI_API_KEY: 'k' } as never,
    );
    expect(result).toEqual({ methodId: 'xai.api_key', meta: { headless: true } });
  });

  it('falls back to cached_token when no API key is set but cached_token is offered', () => {
    const result = GROK_AGENT_CONFIG.resolveAuth!(
      { authMethods: [{ id: 'cached_token' }] } as never,
      {} as never,
    );
    expect(result).toEqual({ methodId: 'cached_token', meta: { headless: true } });
  });

  it('throws when neither an API key nor a cached token is available', () => {
    expect(() => GROK_AGENT_CONFIG.resolveAuth!({ authMethods: [] } as never, {} as never)).toThrow(
      'Run `grok login` first, or set XAI_API_KEY.',
    );
  });
});

describe('GROK_AGENT_CONFIG.extensionRequestHandler (grok-only)', () => {
  it('cancels ask_user_question for both namespaced forms', () => {
    expect(GROK_AGENT_CONFIG.extensionRequestHandler!('x.ai/ask_user_question', {} as never)).toEqual({
      result: { outcome: 'cancelled' },
    });
    expect(GROK_AGENT_CONFIG.extensionRequestHandler!('_x.ai/ask_user_question', {} as never)).toEqual({
      result: { outcome: 'cancelled' },
    });
  });

  it('approves exit_plan_mode for both namespaced forms', () => {
    expect(GROK_AGENT_CONFIG.extensionRequestHandler!('x.ai/exit_plan_mode', {} as never)).toEqual({
      result: { outcome: 'approved' },
    });
    expect(GROK_AGENT_CONFIG.extensionRequestHandler!('_x.ai/exit_plan_mode', {} as never)).toEqual({
      result: { outcome: 'approved' },
    });
  });

  it('returns undefined for an unknown method', () => {
    expect(GROK_AGENT_CONFIG.extensionRequestHandler!('something/else', {} as never)).toBeUndefined();
  });
});
