// Characterization tests for the Kiro ACP adapter (`KiroBackend`).
//
// Kiro is a near-clone of the canonical Claude adapter with a handful of
// documented drifts (empty chunks emit raw, no `usage_update` case, post-turn
// usage read from `result._meta` via a picked-key helper, MCP classification via
// an `isMcpTool` helper, a never-throwing `resolveAuth`, and an extra
// prompt-rejection passthrough branch). These tests lock in the CURRENT
// observable behavior of `run()` — the emitted `NormalizedEvent` stream — so the
// planned dedup refactor into a shared `runAcpTurn` can be proven
// behavior-preserving. They are intentionally black-box: the private mapping
// helpers are exercised only through `run()`, the seam the refactor must keep
// stable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, RunOptions } from '../types';
import { makeFakeAcpClient, runTurn, type FakeAcpHarness } from './acp-test-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { KiroBackend, KIRO_AGENT_CONFIG } from './kiro';

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

describe('KiroBackend — identity', () => {
  it('exposes the kiro name and full capability set', () => {
    const b = new KiroBackend();
    expect(b.name).toBe('kiro');
    expect(b.capabilities).toEqual({
      supportsReasoning: true,
      supportsDetailedToolEvents: true,
      supportsMCP: true,
    });
  });
});

describe('KiroBackend.run — session + streaming', () => {
  it('emits sessionStarted, streams assistant deltas with a stable messageId, then turnCompleted', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
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
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }],
    });
    expect(contents(events, 'reasoningDelta')).toEqual(['thinking']);
  });

  it('connects (with extraEnv) before opening a session, then passes cwd/prompt through', async () => {
    const extraEnv = { FOO: 'bar' };
    await runTurn(new KiroBackend(), options({ prompt: 'do it', cwd: '/work', extraEnv }), fake, {});
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
    const events = await runTurn(new KiroBackend(), options({ resumeId: 'sess-r' }), fake, {});
    expect(fake.calls.ensureConnected).toHaveLength(1);
    expect(fake.callOrder.indexOf('ensureConnected')).toBeLessThan(fake.callOrder.indexOf('loadSession'));
    expect(fake.calls.loadSession[0][0]).toBe('sess-r');
    expect(fake.calls.newSession).toHaveLength(0);
    expect(events[0]).toEqual({ type: 'sessionStarted', sessionId: 'sess-1' });
  });
});

describe('KiroBackend.run — tool events', () => {
  it('maps tool_call to toolStarted with the kiro: id prefix, name, input, meta and mcp kind from _meta', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'abc',
          title: 'Read',
          rawInput: { path: '/x' },
          _meta: { 'kiro.dev/tool': { kind: 'mcp' } },
        },
      ],
    });
    const started = events.find((e) => e.type === 'toolStarted');
    // drift #5(a): kind is classified by isMcpTool via _meta['kiro.dev/tool'].kind,
    // NOT by the update's own `kind` field. Full _meta is forwarded verbatim.
    expect(started).toEqual({
      type: 'toolStarted',
      toolCallId: 'kiro:abc',
      name: 'Read',
      kind: 'mcp',
      input: { path: '/x' },
      meta: { 'kiro.dev/tool': { kind: 'mcp' } },
    });
  });

  it("classifies a tool as mcp when the toolName field contains the '___' substring", async () => {
    // drift #5(b): the '___' check reads `update.toolName` (not `title`/`name`).
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [
        { sessionUpdate: 'tool_call', toolCallId: 'abc', title: 'Read', toolName: 'srv___tool' },
      ],
    });
    const started = events.find((e) => e.type === 'toolStarted') as { kind: string };
    expect(started.kind).toBe('mcp');
  });

  it("does NOT classify as mcp when '___' is only in the title (not toolName)", async () => {
    // Guards the exact field: a title with '___' but no toolName stays builtin.
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 'abc', title: 'srv___tool' }],
    });
    const started = events.find((e) => e.type === 'toolStarted') as { kind: string; name: string };
    expect(started.kind).toBe('builtin');
    expect(started.name).toBe('srv___tool');
  });

  it('classifies a plain tool_call as builtin and defaults a missing title to "tool"', async () => {
    // drift #5(c): neither mcp _meta nor a '___' toolName -> builtin.
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 'abc', rawInput: {} }],
    });
    const started = events.find((e) => e.type === 'toolStarted') as {
      kind: string;
      name: string;
      meta: unknown;
    };
    expect(started.kind).toBe('builtin');
    expect(started.name).toBe('tool');
    expect(started.meta).toBeUndefined();
  });

  it('emits raw for a tool_call missing a toolCallId', async () => {
    const update = { sessionUpdate: 'tool_call', title: 'Read' };
    const events = await runTurn(new KiroBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });

  it('maps a completed tool_call_update to toolCompleted success with extracted text output', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
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
      toolCallId: 'kiro:abc',
      outcome: 'success',
      output: 'done',
      meta: undefined,
    });
  });

  it('maps a failed tool_call_update to toolCompleted error, defaulting the message when no text', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'tool_call_update', toolCallId: 'abc', status: 'failed' }],
    });
    const done = events.find((e) => e.type === 'toolCompleted') as { outcome: string; error: string };
    expect(done.outcome).toBe('error');
    expect(done.error).toBe('Tool failed');
  });

  it('reads a status from _meta.updateParams when the top-level status is absent', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
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
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [
        { sessionUpdate: 'tool_call_update', toolCallId: 'abc', status: 'in_progress', rawInput: { n: 1 } },
      ],
    });
    expect(events).toContainEqual({
      type: 'toolUpdated',
      toolCallId: 'kiro:abc',
      input: { n: 1 },
      meta: undefined,
    });
  });

  it('emits raw for a tool_call_update missing a toolCallId', async () => {
    const update = { sessionUpdate: 'tool_call_update', status: 'completed' };
    const events = await runTurn(new KiroBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });
});

describe('KiroBackend.run — usage (post-turn usage from _meta)', () => {
  it('maps usage_update to a usage event (used/size) before the terminal', async () => {
    // Normalized (4b): Kiro previously had no usage_update case (fell through to
    // raw); it now maps usage_update like the reference adapter.
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'usage_update', used: 10, size: 100 }],
    });
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const termIdx = events.findIndex((e) => e.type === 'turnCompleted');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(events[usageIdx]).toEqual({ type: 'usage', usage: { used: 10, size: 100 } });
    expect(usageIdx).toBeLessThan(termIdx);
  });

  it('drift #4: emits a usage event from result._meta, picking only the whitelisted keys (thoughtTokens dropped)', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      result: {
        stopReason: 'end_turn',
        _meta: { totalTokens: 5, thoughtTokens: 9, modelId: 'kiro-x' },
      },
    });
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const termIdx = events.findIndex((e) => e.type === 'turnCompleted');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(termIdx);
    // `usage` is the picked subset (thoughtTokens is NOT in the whitelist, so
    // it is dropped); `meta` is the full, unfiltered _meta.
    expect(events[usageIdx]).toEqual({
      type: 'usage',
      usage: { totalTokens: 5, modelId: 'kiro-x' },
      meta: { totalTokens: 5, thoughtTokens: 9, modelId: 'kiro-x' },
    });
  });

  it('picks the full whitelist when present in result._meta', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      result: {
        stopReason: 'end_turn',
        _meta: {
          totalTokens: 1,
          inputTokens: 2,
          outputTokens: 3,
          cachedReadTokens: 4,
          reasoningTokens: 5,
          modelId: 'm',
          extra: 'ignored',
        },
      },
    });
    const usage = events.find((e) => e.type === 'usage') as { usage: Record<string, unknown> };
    expect(usage.usage).toEqual({
      totalTokens: 1,
      inputTokens: 2,
      outputTokens: 3,
      cachedReadTokens: 4,
      reasoningTokens: 5,
      modelId: 'm',
    });
  });

  it('drift #4: emits NO usage event when the result carries usage but no _meta', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      result: { stopReason: 'end_turn', usage: { totalTokens: 5, modelId: 'kiro-x' } },
    });
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('emits no usage event when result._meta has none of the whitelisted keys', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      result: { stopReason: 'end_turn', _meta: { trace: 1 } },
    });
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });
});

describe('KiroBackend.run — terminal classification', () => {
  it('end_turn -> turnCompleted with meta.stopReason', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, { result: { stopReason: 'end_turn' } });
    expect(events.at(-1)).toEqual({ type: 'turnCompleted', meta: { stopReason: 'end_turn' } });
  });

  it('stopReason "cancelled" -> cancellation error', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, { result: { stopReason: 'cancelled' } });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Turn cancelled', isCancellation: true });
  });

  it('missing stopReason -> "prompt ended without a stopReason" error', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, { result: {} });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Kiro prompt ended without a stopReason' });
  });

  it('a failure stopReason -> "stopped" error WITHOUT meta', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, { result: { stopReason: 'max_tokens' } });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Kiro stopped: max_tokens' });
  });

  it('drift #1: max_turn_requests is a failure stopReason for Kiro -> error WITHOUT meta', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      result: { stopReason: 'max_turn_requests' },
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Kiro stopped: max_turn_requests' });
  });

  it('a non-failure non-end_turn stopReason -> "stopped" error WITH meta', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, { result: { stopReason: 'surprise' } });
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Kiro stopped: surprise',
      meta: { stopReason: 'surprise' },
    });
  });
});

describe('KiroBackend.run — empty/unknown chunk handling', () => {
  it('drops an empty-string assistant chunk (no assistantDelta, no raw)', async () => {
    // Normalized (4b): Kiro previously surfaced empty chunks as raw noise; it now
    // drops them like the reference adapter.
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }],
    });
    expect(events.some((e) => e.type === 'assistantDelta')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('drops an empty-string thought chunk', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } }],
    });
    expect(events.some((e) => e.type === 'reasoningDelta')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('emits raw for a recognized chunk with a non-string text shape', async () => {
    const update = { sessionUpdate: 'agent_message_chunk', content: {} };
    const events = await runTurn(new KiroBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });

  it('drops user_message_chunk and available_commands_update noise', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
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
    const events = await runTurn(new KiroBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });
});

describe('KiroBackend.run — connection lines', () => {
  it('prefixes stderr and non-json connection lines as raw', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      conn: [
        ['boom', 'stderr'],
        ['{partial', 'non-json'],
      ],
    });
    expect(events).toContainEqual({ type: 'raw', line: '[stderr] boom' });
    expect(events).toContainEqual({ type: 'raw', line: '[acp] {partial' });
  });
});

describe('KiroBackend.run — cancellation & errors', () => {
  it('yields only a cancellation terminal when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await runTurn(new KiroBackend(), options({ signal: controller.signal }), fake);
    expect(events).toEqual([{ type: 'error', message: 'Turn cancelled', isCancellation: true }]);
    expect(fake.calls.newSession).toHaveLength(0);
  });

  it('cancels the active session and yields a cancellation terminal when aborted mid-turn', async () => {
    const controller = new AbortController();
    const backend = new KiroBackend();
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
    const events = await runTurn(new KiroBackend(), options({ resumeId: 'sess-r' }), fake);
    expect(events).toContainEqual({ type: 'error', message: 'Kiro agent does not support session resume' });
    expect(fake.calls.loadSession).toHaveLength(0);
  });

  it('drift #7: wraps a generic prompt rejection with the "Kiro ACP error" prefix', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, { reject: new Error('boom') });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Kiro ACP error: boom' });
  });

  it('drift #7: passes through a "Kiro agent exited" rejection message unwrapped', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      reject: new Error('Kiro agent exited (code 1)'),
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Kiro agent exited (code 1)' });
  });

  it('drift #7: passes through a "not running" rejection message unwrapped', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      reject: new Error('agent not running'),
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'agent not running' });
  });

  it('drift #7: passes through a "Run `kiro-cli login`" rejection message unwrapped', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      reject: new Error('Please Run `kiro-cli login` first'),
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Please Run `kiro-cli login` first' });
  });

  it('drift #7: passes through a "Failed to start" rejection message unwrapped', async () => {
    const events = await runTurn(new KiroBackend(), options(), fake, {
      reject: new Error('Failed to start kiro-cli'),
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Failed to start kiro-cli' });
  });
});

describe('KIRO_AGENT_CONFIG.resolveAuth (drift #6: never throws, const config)', () => {
  it('returns null when no authMethods are advertised (uses cached creds / KIRO_API_KEY transparently)', () => {
    expect(KIRO_AGENT_CONFIG.resolveAuth!({} as never, {} as never)).toBeNull();
  });

  it('returns null when authMethods is an empty array', () => {
    expect(KIRO_AGENT_CONFIG.resolveAuth!({ authMethods: [] } as never, {} as never)).toBeNull();
  });

  it('selects the api-key method when KIRO_API_KEY and a matching method id are present', () => {
    const result = KIRO_AGENT_CONFIG.resolveAuth!(
      { authMethods: [{ id: 'other' }, { id: 'api-key' }] } as never,
      { KIRO_API_KEY: 'k' } as never,
    );
    expect(result).toEqual({ methodId: 'api-key', meta: { headless: true } });
  });

  it('falls back to the cached/token/login/sso/builder method when no KIRO_API_KEY is set', () => {
    const result = KIRO_AGENT_CONFIG.resolveAuth!(
      { authMethods: [{ id: 'weird' }, { id: 'token-auth' }] } as never,
      {} as never,
    );
    expect(result).toEqual({ methodId: 'token-auth', meta: { headless: true } });
  });

  it('picks the cached-style method even when KIRO_API_KEY is set but no api-key method exists', () => {
    const result = KIRO_AGENT_CONFIG.resolveAuth!(
      { authMethods: [{ id: 'login' }] } as never,
      { KIRO_API_KEY: 'k' } as never,
    );
    expect(result).toEqual({ methodId: 'login', meta: { headless: true } });
  });

  it('falls back to the first method id when none match the cached-style pattern', () => {
    const result = KIRO_AGENT_CONFIG.resolveAuth!(
      { authMethods: [{ id: 'first' }, { id: 'second' }] } as never,
      {} as never,
    );
    expect(result).toEqual({ methodId: 'first', meta: { headless: true } });
  });
});
