// Shared test harness for the ACP backend adapter characterization tests.
//
// This is NOT a test file — it is excluded from `tsc` (via the `**/*.testkit.ts`
// pattern in tsconfig) and from vitest's `*.test.ts` include glob, so it is only
// ever pulled in by the per-adapter `*.test.ts` files. It is deliberately free
// of any `vitest` import so it stays a plain, dependency-light module.
//
// The adapters have no dependency-injection seam: `run()` calls
// `getSharedAcpClient()` directly. Characterization tests therefore `vi.mock`
// `./acp-client` and hand this fake client back. The fake captures the session
// and connection sinks the adapter registers, exposes a controllable
// `session/prompt` promise, and records calls (and their order) for assertions —
// enough to drive the real `run()` loop and observe every `NormalizedEvent` it
// emits.

import type { NormalizedEvent, RunOptions } from '../types';

/** A fake ACP client plus a control surface for driving an adapter's run() loop. */
export interface FakeAcpHarness {
  /** The object the mocked `getSharedAcpClient()` should return to the adapter. */
  client: Record<string, unknown>;
  /** Resolves once the adapter registers its session sink (i.e. it reached the prompt loop). */
  readyP: Promise<void>;
  /** Recorded arguments for each client method, for call-site assertions. */
  calls: {
    ensureConnected: unknown[][];
    newSession: unknown[][];
    loadSession: unknown[][];
    setConfigOption: unknown[][];
    setSessionModel: unknown[][];
    prompt: unknown[][];
    cancel: unknown[][];
    registerConnectionSink: unknown[][];
    registerSessionSink: unknown[][];
  };
  /** Method names in the exact order the adapter invoked them, for sequencing assertions. */
  callOrder: string[];
  /** Push a raw ACP `session/update` into the adapter's session sink. */
  push(update: unknown): void;
  /** Push a connection line (stderr / non-json) into the adapter's connection sink. */
  conn(line: string, source?: 'stderr' | 'non-json'): void;
  /** Settle the pending `session/prompt` with a result. */
  resolve(result: unknown): void;
  /** Reject the pending `session/prompt` (models an agent/transport error). */
  reject(err: unknown): void;
}

export function makeFakeAcpClient(
  opts: {
    sessionId?: string;
    loadSessionSupported?: boolean;
    /** Model config returned from `newSession` (as an ACP agent would advertise). */
    modelConfig?: {
      id: string;
      applyVia?: 'config_option' | 'session_set_model';
      currentValue?: string;
      options: { value: string; name: string }[];
    };
  } = {},
): FakeAcpHarness {
  const sessionId = opts.sessionId ?? 'sess-1';
  let sessionSink: ((u: unknown) => void) | undefined;
  let connectionSink: ((line: string, source: 'stderr' | 'non-json') => void) | undefined;
  let resolveP!: (r: unknown) => void;
  let rejectP!: (e: unknown) => void;
  let markReady!: () => void;
  const readyP = new Promise<void>((r) => (markReady = r));
  const promptP = new Promise<unknown>((res, rej) => {
    resolveP = res;
    rejectP = rej;
  });

  const calls: FakeAcpHarness['calls'] = {
    ensureConnected: [],
    newSession: [],
    loadSession: [],
    setConfigOption: [],
    setSessionModel: [],
    prompt: [],
    cancel: [],
    registerConnectionSink: [],
    registerSessionSink: [],
  };
  const callOrder: string[] = [];

  const client = {
    loadSessionSupported: opts.loadSessionSupported ?? true,
    registerConnectionSink: (fn: (line: string, source: 'stderr' | 'non-json') => void) => {
      callOrder.push('registerConnectionSink');
      calls.registerConnectionSink.push([]);
      connectionSink = fn;
      return () => {};
    },
    ensureConnected: async (...args: unknown[]) => {
      callOrder.push('ensureConnected');
      calls.ensureConnected.push(args);
    },
    newSession: async (...args: unknown[]) => {
      callOrder.push('newSession');
      calls.newSession.push(args);
      return { sessionId, modelConfig: opts.modelConfig };
    },
    loadSession: async (...args: unknown[]) => {
      callOrder.push('loadSession');
      calls.loadSession.push(args);
      return { sessionId };
    },
    setConfigOption: async (...args: unknown[]) => {
      callOrder.push('setConfigOption');
      calls.setConfigOption.push(args);
    },
    setSessionModel: async (...args: unknown[]) => {
      callOrder.push('setSessionModel');
      calls.setSessionModel.push(args);
    },
    registerSessionSink: (sid: string, fn: (u: unknown) => void) => {
      callOrder.push('registerSessionSink');
      calls.registerSessionSink.push([sid]);
      sessionSink = fn;
      markReady();
      return () => {};
    },
    prompt: (...args: unknown[]) => {
      callOrder.push('prompt');
      calls.prompt.push(args);
      return promptP;
    },
    cancel: (...args: unknown[]) => {
      callOrder.push('cancel');
      calls.cancel.push(args);
    },
  };

  return {
    client,
    readyP,
    calls,
    callOrder,
    push: (u) => {
      if (!sessionSink) throw new Error('session sink not registered yet');
      sessionSink(u);
    },
    conn: (line, source = 'stderr') => {
      if (!connectionSink) throw new Error('connection sink not registered yet');
      connectionSink(line, source);
    },
    resolve: (r) => resolveP(r),
    reject: (e) => rejectP(e),
  };
}

/**
 * Drive an adapter's `run()` to completion and return every emitted event.
 *
 * The adapter's poll loop races the pending prompt against a 50 ms timer. We
 * settle the prompt on a microtask, which always wins that race, so no real or
 * fake timers are needed. When the adapter returns early (abort before start,
 * unsupported resume) it never registers a session sink; that path is detected
 * by racing `readyP` against the pump completing.
 */
export async function runTurn(
  backend: { run(o: RunOptions): AsyncIterable<NormalizedEvent> },
  options: RunOptions,
  fake: FakeAcpHarness,
  script: {
    updates?: unknown[];
    conn?: Array<[string, 'stderr' | 'non-json']>;
    result?: unknown;
    reject?: unknown;
  } = {},
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  const pump = (async () => {
    for await (const ev of backend.run(options)) events.push(ev);
  })();

  const reachedLoop = await Promise.race([
    fake.readyP.then(() => true),
    pump.then(() => false),
  ]);

  if (reachedLoop) {
    for (const [line, source] of script.conn ?? []) fake.conn(line, source);
    for (const u of script.updates ?? []) fake.push(u);
    if ('reject' in script) fake.reject(script.reject);
    else fake.resolve(script.result ?? { stopReason: 'end_turn' });
  }

  await pump;
  return events;
}
