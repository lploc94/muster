// Characterization tests for the Claude ACP adapter (`ClaudeBackend`).
//
// Claude is the canonical adapter; grok/kiro/codex/opencode are near-clones with
// a handful of documented drifts. These tests lock in the CURRENT observable
// behavior of `run()` — the emitted `NormalizedEvent` stream — so the planned
// dedup refactor into a shared `runAcpTurn` can be proven behavior-preserving.
// They are intentionally black-box: the private mapping helpers are exercised
// only through `run()`, which is the seam the refactor must keep stable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, RunOptions } from '../types';
import { makeFakeAcpClient, runTurn, type FakeAcpHarness } from './acp-test-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { ClaudeBackend, claudeAgentConfig } from './claude';

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

describe('ClaudeBackend — identity', () => {
  it('exposes the claude name and full capability set', () => {
    const b = new ClaudeBackend();
    expect(b.name).toBe('claude');
    expect(b.capabilities).toEqual({
      supportsReasoning: true,
      supportsDetailedToolEvents: true,
      supportsMCP: true,
      supportsLiveInput: true,
    });
  });
});

describe('ClaudeBackend.run — model selection', () => {
  it('sets the model config option after the session and before the prompt', async () => {
    await runTurn(new ClaudeBackend(), options({ model: 'opus[1m]' }), fake, {});
    expect(fake.calls.setConfigOption).toHaveLength(1);
    expect(fake.calls.setConfigOption[0]).toEqual(['sess-1', 'model', 'opus[1m]']);
    const ns = fake.callOrder.indexOf('newSession');
    const sc = fake.callOrder.indexOf('setConfigOption');
    const pr = fake.callOrder.indexOf('prompt');
    expect(ns).toBeGreaterThanOrEqual(0);
    expect(sc).toBeGreaterThan(ns);
    expect(pr).toBeGreaterThan(sc);
  });

  it('uses the model config option id advertised by the session when present', async () => {
    fake = makeFakeAcpClient({
      modelConfig: { id: 'model', currentValue: 'default', options: [{ value: 'sonnet', name: 'Sonnet' }] },
    });
    H.current = fake;
    await runTurn(new ClaudeBackend(), options({ model: 'sonnet' }), fake, {});
    expect(fake.calls.setConfigOption[0]).toEqual(['sess-1', 'model', 'sonnet']);
  });

  it('does not set a model config option when no model is selected', async () => {
    await runTurn(new ClaudeBackend(), options(), fake, {});
    expect(fake.calls.setConfigOption).toHaveLength(0);
    expect(fake.callOrder).not.toContain('setConfigOption');
  });

  it('uses session/set_model when the agent advertises session.models shape', async () => {
    fake = makeFakeAcpClient({
      modelConfig: {
        id: 'model',
        applyVia: 'session_set_model',
        currentValue: 'grok-4.5',
        options: [{ value: 'grok-4.5', name: 'Grok 4.5' }],
      },
    });
    H.current = fake;
    await runTurn(new ClaudeBackend(), options({ model: 'grok-4.5' }), fake, {});
    expect(fake.calls.setConfigOption).toHaveLength(0);
    expect(fake.calls.setSessionModel).toEqual([['sess-1', 'grok-4.5']]);
    const ns = fake.callOrder.indexOf('newSession');
    const sm = fake.callOrder.indexOf('setSessionModel');
    const pr = fake.callOrder.indexOf('prompt');
    expect(sm).toBeGreaterThan(ns);
    expect(pr).toBeGreaterThan(sm);
  });
});

describe('ClaudeBackend.run — session + streaming', () => {
  it('emits sessionStarted, streams assistant deltas with a stable messageId, then turnCompleted', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
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
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }],
    });
    expect(contents(events, 'reasoningDelta')).toEqual(['thinking']);
  });

  it('connects (with extraEnv) before opening a session, then passes cwd/prompt through', async () => {
    const extraEnv = { FOO: 'bar' };
    await runTurn(new ClaudeBackend(), options({ prompt: 'do it', cwd: '/work', extraEnv }), fake, {});
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
    const events = await runTurn(new ClaudeBackend(), options({ resumeId: 'sess-r' }), fake, {});
    expect(fake.calls.ensureConnected).toHaveLength(1);
    expect(fake.callOrder.indexOf('ensureConnected')).toBeLessThan(fake.callOrder.indexOf('loadSession'));
    expect(fake.calls.loadSession[0][0]).toBe('sess-r');
    expect(fake.calls.newSession).toHaveLength(0);
    expect(events[0]).toEqual({ type: 'sessionStarted', sessionId: 'sess-1' });
  });
});

describe('ClaudeBackend.run — tool events', () => {
  it('maps tool_call to toolStarted with the claude: id prefix, name, kind and input', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
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
      toolCallId: 'claude:abc',
      name: 'Read',
      kind: 'mcp',
      input: { path: '/x' },
      meta: { origin: 'test' },
    });
  });

  it('classifies a non-mcp tool_call kind as builtin and defaults a missing title to "tool"', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
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
    const events = await runTurn(new ClaudeBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });

  it('maps a completed tool_call_update to toolCompleted success with extracted text output', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
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
      toolCallId: 'claude:abc',
      outcome: 'success',
      output: 'done',
      meta: undefined,
    });
  });

  it('maps a failed tool_call_update to toolCompleted error, defaulting the message when no text', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'tool_call_update', toolCallId: 'abc', status: 'failed' }],
    });
    const done = events.find((e) => e.type === 'toolCompleted') as { outcome: string; error: string };
    expect(done.outcome).toBe('error');
    expect(done.error).toBe('Tool failed');
  });

  it('reads a status from _meta.updateParams when the top-level status is absent', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
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
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        { sessionUpdate: 'tool_call_update', toolCallId: 'abc', status: 'in_progress', rawInput: { n: 1 } },
      ],
    });
    expect(events).toContainEqual({
      type: 'toolUpdated',
      toolCallId: 'claude:abc',
      input: { n: 1 },
      meta: undefined,
    });
  });
});

describe('ClaudeBackend.run — usage', () => {
  it('emits a usage event from usage_update (used/size) before the terminal', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'usage_update', used: 10, size: 100 }],
    });
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const termIdx = events.findIndex((e) => e.type === 'turnCompleted');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(events[usageIdx]).toEqual({ type: 'usage', usage: { used: 10, size: 100 } });
    expect(usageIdx).toBeLessThan(termIdx);
  });

  it('emits a usage event from the prompt result (including thoughtTokens) before the terminal', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      result: {
        stopReason: 'end_turn',
        usage: { totalTokens: 5, thoughtTokens: 2, modelId: 'claude-x' },
        _meta: { trace: 1 },
      },
    });
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const termIdx = events.findIndex((e) => e.type === 'turnCompleted');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(termIdx);
    expect(events[usageIdx]).toEqual({
      type: 'usage',
      usage: { totalTokens: 5, thoughtTokens: 2, modelId: 'claude-x' },
      meta: { trace: 1 },
    });
  });

  it('emits no result usage event when the result carries no usage', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      result: { stopReason: 'end_turn' },
    });
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });
});

describe('ClaudeBackend.run — terminal classification', () => {
  it('end_turn -> turnCompleted with meta.stopReason', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, { result: { stopReason: 'end_turn' } });
    expect(events.at(-1)).toEqual({ type: 'turnCompleted', meta: { stopReason: 'end_turn' } });
  });

  it('stopReason "cancelled" -> cancellation error', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, { result: { stopReason: 'cancelled' } });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Turn cancelled', isCancellation: true, meta: { interruptConfidence: 'confirmed' } });
  });

  it('missing stopReason -> "prompt ended without a stopReason" error', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, { result: {} });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Claude prompt ended without a stopReason', meta: { failureClass: 'terminal_received' } });
  });

  it('a failure stopReason -> "stopped" error WITHOUT meta', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, { result: { stopReason: 'max_tokens' } });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Claude stopped: max_tokens', meta: { failureClass: 'terminal_received' } });
  });

  it('max_turn_requests is a failure stopReason for Claude -> error WITHOUT meta', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      result: { stopReason: 'max_turn_requests' },
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Claude stopped: max_turn_requests', meta: { failureClass: 'terminal_received' } });
  });

  it('a non-failure non-end_turn stopReason -> "stopped" error WITH meta', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, { result: { stopReason: 'surprise' } });
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Claude stopped: surprise',
      meta: { failureClass: 'terminal_received', stopReason: 'surprise' },
    });
  });
});

describe('ClaudeBackend.run — empty/unknown chunk handling (drift: claude drops empties)', () => {
  it('drops an empty-string assistant chunk (no assistantDelta, no raw)', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }],
    });
    expect(events.some((e) => e.type === 'assistantDelta')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('drops an empty-string thought chunk', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } }],
    });
    expect(events.some((e) => e.type === 'reasoningDelta')).toBe(false);
    expect(events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('emits raw for a recognized chunk with a non-string text shape', async () => {
    const update = { sessionUpdate: 'agent_message_chunk', content: {} };
    const events = await runTurn(new ClaudeBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });

  it('drops user_message_chunk and available_commands_update noise', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
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
    const events = await runTurn(new ClaudeBackend(), options(), fake, { updates: [update] });
    expect(events).toContainEqual({ type: 'raw', line: JSON.stringify(update) });
  });
});

describe('ClaudeBackend.run — connection lines', () => {
  it('prefixes stderr and non-json connection lines as raw', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      conn: [
        ['boom', 'stderr'],
        ['{partial', 'non-json'],
      ],
    });
    expect(events).toContainEqual({ type: 'raw', line: '[stderr] boom' });
    expect(events).toContainEqual({ type: 'raw', line: '[acp] {partial' });
  });
});

describe('ClaudeBackend.run — cancellation & errors', () => {
  it('yields only a cancellation terminal when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await runTurn(new ClaudeBackend(), options({ signal: controller.signal }), fake);
    expect(events).toEqual([{ type: 'error', message: 'Turn cancelled', isCancellation: true }]);
    expect(fake.calls.newSession).toHaveLength(0);
  });

  it('cancels the active session and yields a cancellation terminal when aborted mid-turn', async () => {
    const controller = new AbortController();
    const backend = new ClaudeBackend();
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
    const events = await runTurn(new ClaudeBackend(), options({ resumeId: 'sess-r' }), fake);
    expect(events).toContainEqual({ type: 'error', message: 'Claude agent does not support session resume' });
    expect(fake.calls.loadSession).toHaveLength(0);
  });

  it('wraps a generic prompt rejection with the "Claude ACP error" prefix', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, { reject: new Error('boom') });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Claude ACP error: boom' });
  });

  it('passes through an "agent exited" rejection message unwrapped', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      reject: new Error('Claude agent exited (code 1)'),
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Claude agent exited (code 1)' });
  });
});

describe('claudeAgentConfig.resolveAuth (drift: never throws)', () => {
  it('selects the api-key method when an API key and matching method are present', () => {
    const cfg = claudeAgentConfig();
    const result = cfg.resolveAuth!(
      { authMethods: [{ id: 'api-key' }] } as never,
      { ANTHROPIC_API_KEY: 'sk-test' } as never,
    );
    expect(result).toEqual({ methodId: 'api-key', meta: { headless: true } });
  });

  it('returns null (delegates to the CLI/SDK) when no API key is configured', () => {
    const cfg = claudeAgentConfig();
    const result = cfg.resolveAuth!({ authMethods: [{ id: 'api-key' }] } as never, {} as never);
    expect(result).toBeNull();
  });
});
