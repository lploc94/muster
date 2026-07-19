// M017-S06 T01/T02: RunOptions.mcpSetup controller + bounded pre-dispatch setup
// loop + sticky fresh-session recovery prompt wiring.
//
// Proves runAcpTurn awaits readiness before onBeforePrompt, recovers once via
// session close + fresh session, dispatches prompt at most once, and settles
// exhausted setup without prompt_outstanding side effects or process teardown.
// T02 adds durable recovery-prompt helper integration on sticky load failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFreshSessionRecoveryPromptOrThrow } from '../task/fresh-session-recovery-prompt';
import type { McpSetupController, McpSetupReadyResult, NormalizedEvent, RunOptions } from '../types';
import {
  makeFakeAcpFaultClient,
  type FakeAcpFaultHarness,
} from './acp-fault-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpFaultHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { ClaudeBackend } from './claude';

function options(over: Partial<RunOptions> = {}): RunOptions {
  return { prompt: 'hello', ...over };
}

async function collectRun(
  backend: { run(o: RunOptions): AsyncIterable<NormalizedEvent> },
  opts: RunOptions,
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const ev of backend.run(opts)) events.push(ev);
  return events;
}

function makeController(
  over: Partial<McpSetupController> & {
    readyByAttempt?: Record<number, McpSetupReadyResult>;
  } = {},
): McpSetupController & {
  calls: {
    prepareAttempt: unknown[];
    awaitReady: unknown[];
    disposeAttempt: unknown[];
    buildFreshSessionPrompt: unknown[];
  };
} {
  const calls = {
    prepareAttempt: [] as unknown[],
    awaitReady: [] as unknown[],
    disposeAttempt: [] as unknown[],
    buildFreshSessionPrompt: [] as unknown[],
  };
  const readyByAttempt = over.readyByAttempt ?? {
    1: { ok: true },
  };
  return {
    maxAttempts: over.maxAttempts,
    calls,
    async prepareAttempt(ctx) {
      calls.prepareAttempt.push(ctx);
      return over.prepareAttempt ? over.prepareAttempt(ctx) : undefined;
    },
    async awaitReady(ctx) {
      calls.awaitReady.push(ctx);
      if (over.awaitReady) return over.awaitReady(ctx);
      return readyByAttempt[ctx.attempt] ?? { ok: false, code: 'missing_evidence', message: 'no script' };
    },
    async disposeAttempt(ctx) {
      calls.disposeAttempt.push(ctx);
      if (over.disposeAttempt) await over.disposeAttempt(ctx);
    },
    async buildFreshSessionPrompt(ctx) {
      calls.buildFreshSessionPrompt.push(ctx);
      if (over.buildFreshSessionPrompt) return over.buildFreshSessionPrompt(ctx);
      return 'fresh recovery prompt';
    },
  };
}

describe('runAcpTurn mcpSetup controller (M017-S06 / T01)', () => {
  let fake: FakeAcpFaultHarness;

  beforeEach(() => {
    fake = makeFakeAcpFaultClient({ sessionIdQueue: ['sess-1', 'sess-2', 'sess-3'] });
    H.current = fake;
  });

  afterEach(() => {
    H.current = null;
  });

  it('without mcpSetup keeps legacy path (no awaitReady, prompt still fires)', async () => {
    const backend = new ClaudeBackend();
    const pump = collectRun(backend, options({ prompt: 'legacy' }));
    await fake.waitForPrompt('sess-1');
    expect(fake.calls.prompt.length).toBe(1);
    fake.resolve('sess-1', { stopReason: 'end_turn' });
    const events = await pump;
    expect(events.some((e) => e.type === 'turnCompleted')).toBe(true);
  });

  it('ready first attempt: prepare → session → awaitReady → onBeforePrompt → prompt once', async () => {
    const ctrl = makeController({ readyByAttempt: { 1: { ok: true } } });
    const beforePrompt = vi.fn(async () => {});
    const backend = new ClaudeBackend();
    const pump = collectRun(
      backend,
      options({
        prompt: 'work',
        mcpSetup: ctrl,
        onBeforePrompt: beforePrompt,
      }),
    );

    await fake.waitForPrompt('sess-1');
    expect(ctrl.calls.prepareAttempt).toHaveLength(1);
    expect(ctrl.calls.awaitReady).toHaveLength(1);
    expect((ctrl.calls.awaitReady[0] as { sessionId: string }).sessionId).toBe('sess-1');
    expect(beforePrompt).toHaveBeenCalledTimes(1);
    // Order: prepareAttempt before newSession; awaitReady before onBeforePrompt before prompt
    const prepIdx = fake.callOrder.indexOf('newSession');
    const promptIdx = fake.callOrder.indexOf('prompt');
    expect(prepIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThan(prepIdx);
    expect(fake.calls.prompt).toHaveLength(1);
    expect(fake.calls.prompt[0]?.[0]).toBe('sess-1');
    expect(fake.calls.prompt[0]?.[1]).toBe('work');

    fake.resolve('sess-1', { stopReason: 'end_turn' });
    const events = await pump;
    expect(events.some((e) => e.type === 'sessionStarted' && e.sessionId === 'sess-1')).toBe(true);
    expect(events.some((e) => e.type === 'turnCompleted')).toBe(true);
    expect(fake.isProcessAlive()).toBe(true);
  });

  it('does not call onBeforePrompt or prompt when awaitReady fails and attempts exhaust', async () => {
    const ctrl = makeController({
      maxAttempts: 2,
      readyByAttempt: {
        1: { ok: false, code: 'missing_evidence', message: 'no tools/list yet' },
        2: { ok: false, code: 'missing_evidence', message: 'still missing' },
      },
    });
    const beforePrompt = vi.fn(async () => {});
    const backend = new ClaudeBackend();
    const events = await collectRun(
      backend,
      options({
        prompt: 'never dispatch',
        mcpSetup: ctrl,
        onBeforePrompt: beforePrompt,
      }),
    );

    expect(beforePrompt).not.toHaveBeenCalled();
    expect(fake.calls.prompt).toHaveLength(0);
    expect(ctrl.calls.prepareAttempt).toHaveLength(2);
    expect(ctrl.calls.awaitReady).toHaveLength(2);
    expect(ctrl.calls.disposeAttempt.length).toBeGreaterThanOrEqual(2);
    expect(fake.calls.closeSession.length).toBeGreaterThanOrEqual(2);
    expect(fake.calls.newSession.length).toBe(2);

    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err && err.type === 'error' && err.message).toMatch(/mcp setup exhausted/i);
    expect(err && err.type === 'error' && err.message).toMatch(/missing_evidence/);
    expect(err && err.type === 'error' && err.message).toMatch(/2/);
    expect(err && err.type === 'error' && err.meta).toMatchObject({
      mcpSetupCode: 'attempts_exhausted',
      readinessCode: 'missing_evidence',
      attemptCount: 2,
    });
    // Never terminal_received — pre-dispatch only.
    expect(err && err.type === 'error' && err.meta?.failureClass).not.toBe('terminal_received');
    expect(fake.isProcessAlive()).toBe(true);
  });

  it('first-attempt readiness failure recovers on attempt 2 and prompts exactly once', async () => {
    const ctrl = makeController({
      maxAttempts: 2,
      readyByAttempt: {
        1: { ok: false, code: 'generation_mismatch', message: 'stale generation' },
        2: { ok: true },
      },
    });
    const beforePrompt = vi.fn(async () => {});
    const backend = new ClaudeBackend();
    const pump = collectRun(
      backend,
      options({
        prompt: 'recover me',
        mcpSetup: ctrl,
        onBeforePrompt: beforePrompt,
      }),
    );

    await fake.waitForPrompt('sess-2');
    expect(fake.calls.prompt).toHaveLength(1);
    expect(fake.calls.prompt[0]?.[0]).toBe('sess-2');
    expect(fake.calls.closeSession.some((args) => args[0] === 'sess-1')).toBe(true);
    expect(ctrl.calls.prepareAttempt).toHaveLength(2);
    expect(ctrl.calls.disposeAttempt.length).toBeGreaterThanOrEqual(1);
    expect(beforePrompt).toHaveBeenCalledTimes(1);

    fake.resolve('sess-2', { stopReason: 'end_turn' });
    const events = await pump;
    expect(events.some((e) => e.type === 'sessionStarted' && e.sessionId === 'sess-2')).toBe(true);
    expect(events.some((e) => e.type === 'turnCompleted')).toBe(true);
    expect(fake.calls.prompt).toHaveLength(1);
    expect(fake.isProcessAlive()).toBe(true);
  });

  it('hard-caps maxAttempts at 2 even if controller requests more', async () => {
    const ctrl = makeController({
      maxAttempts: 9,
      readyByAttempt: {
        1: { ok: false, code: 'wrong_catalog', message: 'bad' },
        2: { ok: false, code: 'wrong_catalog', message: 'still bad' },
        3: { ok: true },
      },
    });
    const events = await collectRun(new ClaudeBackend(), options({ mcpSetup: ctrl }));
    expect(ctrl.calls.prepareAttempt).toHaveLength(2);
    expect(fake.calls.prompt).toHaveLength(0);
    expect(events.some((e) => e.type === 'error' && /attempts_exhausted|mcp setup exhausted/i.test(e.message))).toBe(
      true,
    );
  });

  it('ensureConnected runs once across recovery attempts', async () => {
    const ctrl = makeController({
      readyByAttempt: {
        1: { ok: false, code: 'missing_evidence', message: 'nope' },
        2: { ok: true },
      },
    });
    const pump = collectRun(new ClaudeBackend(), options({ mcpSetup: ctrl }));
    await fake.waitForPrompt('sess-2');
    expect(fake.calls.ensureConnected).toHaveLength(1);
    fake.resolve('sess-2', { stopReason: 'end_turn' });
    await pump;
  });

  it('sticky readiness failure forces fresh session recovery mode on attempt 2', async () => {
    // loadSession uses the requested id and does not consume sessionIdQueue;
    // only the fresh session/new needs a queued id.
    fake = makeFakeAcpFaultClient({
      sessionIdQueue: ['sess-fresh'],
      loadSessionSupported: true,
    });
    H.current = fake;

    const ctrl = makeController({
      readyByAttempt: {
        1: {
          ok: false,
          code: 'session_registry_sticky',
          message: 'load retained broken MCP registry',
          sticky: true,
        },
        2: { ok: true },
      },
      async prepareAttempt(ctx) {
        // First attempt loads the sticky session; second is forced fresh.
        if (ctx.attempt === 1) return { resumeId: 'sess-load' };
        return { resumeId: null, prompt: undefined };
      },
      async buildFreshSessionPrompt() {
        // Wire the real T02 helper (TaskEngine will do this in T03).
        return buildFreshSessionRecoveryPromptOrThrow({
          goal: 'Fix sticky MCP registry',
          originalPrompt: 'original first-turn prompt',
          priorOutcomes: ['turn 1: sticky load failed'],
          recoveryReason: 'session_registry_sticky',
        });
      },
    });

    const pump = collectRun(
      new ClaudeBackend(),
      options({
        prompt: 'original',
        resumeId: 'sess-load',
        mcpSetup: ctrl,
      }),
    );

    await fake.waitForPrompt('sess-fresh');
    expect(fake.calls.loadSession.length).toBeGreaterThanOrEqual(1);
    expect(fake.calls.loadSession[0]?.[0]).toBe('sess-load');
    expect(fake.calls.newSession.length).toBe(1);
    expect(fake.calls.newSession[0]).toBeDefined();
    // Attempt 2 context should be fresh_after_sticky
    const attempt2 = ctrl.calls.prepareAttempt[1] as { recoveryMode: string; forceFreshSession: boolean };
    expect(attempt2.recoveryMode).toBe('fresh_after_sticky');
    expect(attempt2.forceFreshSession).toBe(true);
    expect(ctrl.calls.buildFreshSessionPrompt.length).toBeGreaterThanOrEqual(1);
    // Prompt text should come from the durable recovery helper when sticky recovery runs
    expect(fake.calls.prompt[0]?.[0]).toBe('sess-fresh');
    const recoveredPrompt = fake.calls.prompt[0]?.[1] ?? '';
    expect(recoveredPrompt).toMatch(/Session recovery/i);
    expect(recoveredPrompt).toContain('Fix sticky MCP registry');
    expect(recoveredPrompt).toContain('original first-turn prompt');
    expect(recoveredPrompt).toMatch(/Do not invent a new user request/i);

    fake.resolve('sess-fresh', { stopReason: 'end_turn' });
    await pump;
  });

  it('buildFreshSessionPrompt budget failure fails pre_dispatch without prompt', async () => {
    const ctrl = makeController({
      readyByAttempt: {
        1: {
          ok: false,
          code: 'session_registry_sticky',
          message: 'sticky',
          sticky: true,
        },
      },
      async buildFreshSessionPrompt() {
        return buildFreshSessionRecoveryPromptOrThrow({
          goal: 'x'.repeat(10_000),
          maxChars: 50,
        });
      },
    });
    // Only one attempt will fail sticky then budget fails before attempt 2 session.
    // With maxAttempts 2, sticky path tries to build prompt before attempt 2.
    const events = await collectRun(new ClaudeBackend(), options({ mcpSetup: ctrl, resumeId: 'x' }));
    expect(fake.calls.prompt).toHaveLength(0);
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.message).toMatch(/budget|recovery prompt/i);
  });

  it('empty recovery prompt after sticky fails pre_dispatch without prompt', async () => {
    const ctrl = makeController({
      readyByAttempt: {
        1: {
          ok: false,
          code: 'session_registry_sticky',
          message: 'sticky',
          sticky: true,
        },
      },
      async buildFreshSessionPrompt() {
        return '   ';
      },
    });
    const events = await collectRun(new ClaudeBackend(), options({ mcpSetup: ctrl, resumeId: 'sticky-id' }));
    expect(fake.calls.prompt).toHaveLength(0);
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.message).toMatch(/recovery prompt empty/i);
    expect(err && err.type === 'error' && err.meta).toMatchObject({
      mcpSetupCode: 'session_registry_sticky',
    });
  });

  it('session isolation: concurrent session B keeps streaming while A recovers', async () => {
    fake = makeFakeAcpFaultClient({ sessionIdQueue: ['sess-A1', 'sess-A2', 'sess-B'] });
    H.current = fake;

    const ctrlA = makeController({
      readyByAttempt: {
        1: { ok: false, code: 'missing_evidence', message: 'A fail' },
        2: { ok: true },
      },
    });

    const backendA = new ClaudeBackend();
    const backendB = new ClaudeBackend();

    // Start A recovery path (will create sess-A1 fail, then sess-A2).
    const pumpA = collectRun(backendA, options({ prompt: 'A', mcpSetup: ctrlA }));

    // Wait until A has closed first session and is setting up second — or until A prompts.
    await fake.waitForPrompt('sess-A2');

    // Concurrent B on same process without mcpSetup (or with ready controller).
    const pumpB = collectRun(backendB, options({ prompt: 'B' }));
    await fake.waitForPrompt('sess-B');

    // B streams while A is mid-flight
    fake.push('sess-B', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'B-streaming' },
    });
    fake.resolve('sess-B', { stopReason: 'end_turn' });
    const eventsB = await pumpB;
    expect(eventsB.some((e) => e.type === 'assistantDelta' && e.content === 'B-streaming')).toBe(true);
    expect(fake.isProcessAlive()).toBe(true);

    fake.resolve('sess-A2', { stopReason: 'end_turn' });
    const eventsA = await pumpA;
    expect(eventsA.some((e) => e.type === 'turnCompleted')).toBe(true);
    expect(fake.calls.prompt.filter((p) => p[0] === 'sess-A2')).toHaveLength(1);
    expect(fake.calls.prompt.filter((p) => p[0] === 'sess-B')).toHaveLength(1);
  });

  it('does not include bearer tokens in exhausted setup errors', async () => {
    const ctrl = makeController({
      readyByAttempt: {
        1: {
          ok: false,
          code: 'missing_evidence',
          message: 'token=MUSTER_BRIDGE_TOKEN_SECRET Authorization: Bearer sk-secret',
        },
        2: {
          ok: false,
          code: 'missing_evidence',
          message: 'Authorization: Bearer sk-secret',
        },
      },
    });
    const events = await collectRun(new ClaudeBackend(), options({ mcpSetup: ctrl }));
    const err = events.find((e) => e.type === 'error');
    const blob = JSON.stringify(err);
    expect(blob).not.toMatch(/Bearer sk-secret/);
    expect(blob).not.toMatch(/MUSTER_BRIDGE_TOKEN_SECRET/);
  });
});
