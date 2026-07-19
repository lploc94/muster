// Multi-session ACP fake with per-session sticky MCP failure (M017 S01 T02).
//
// This is NOT a test file — excluded from tsc + vitest include via *.testkit.ts.
// Dependency-light (no vitest import), matching acp-test-harness.testkit.ts.
//
// Models a live shared ACP process where one session's MCP registry failed
// (tool catalog missing complete_task/fail_task) while sibling sessions on the
// same process remain healthy and stream normally. Does not modify runAcpTurn
// or any adapter — characterization only.
//
// Prefer makeFakeAcpClient from acp-test-harness.testkit.ts for single-session
// adapter characterization; use this harness when tests need multi-session
// isolation or sticky MCP failure (S01 T04, S02, S06).

import {
  DEFAULT_MUSTER_TOOLS,
  defaultMusterToolCatalog,
  type FakeMcpTool,
} from '../bridge/mcp-fault-fixture.testkit';

/** Disposition tools that a failed MCP registry is missing. */
export const MUSTER_DISPOSITION_TOOLS = ['complete_task', 'fail_task'] as const;

export type MusterDispositionTool = (typeof MUSTER_DISPOSITION_TOOLS)[number];

export interface SessionMcpState {
  sessionId: string;
  /** True when this session's MCP registry failed and tools were never registered. */
  mcpFailed: boolean;
  /** Inverse of mcpFailed for readiness-gate assertions (invariant #1). */
  mcpReady: boolean;
  /** Sticky failure reason when mcpFailed. */
  reason?: string;
  /** Tool catalog currently advertised for this session. */
  tools: FakeMcpTool[];
  created: boolean;
}

export interface FakeAcpFaultHarness {
  /** Shared fake client returned from a mocked getSharedAcpClient(). */
  client: Record<string, unknown>;
  /** Recorded arguments for each client method. */
  calls: {
    ensureConnected: unknown[][];
    newSession: unknown[][];
    loadSession: unknown[][];
    setConfigOption: unknown[][];
    setSessionModel: unknown[][];
    prompt: unknown[][];
    cancel: unknown[][];
    closeSession: unknown[][];
    registerConnectionSink: unknown[][];
    registerSessionSink: unknown[][];
  };
  /** Method names in call order. */
  callOrder: string[];
  /**
   * Sticky mark: sessionId's MCP registry failed. Catalog drops disposition
   * tools. Process stays alive. May be called before or after session create.
   */
  markSessionMcpFailed(sessionId: string, reason?: string): void;
  isSessionMcpFailed(sessionId: string): boolean;
  isSessionMcpReady(sessionId: string): boolean;
  mcpFailureReason(sessionId: string): string | undefined;
  /** Copy of the tool catalog for sessionId (empty array if unknown). */
  toolCatalogFor(sessionId: string): FakeMcpTool[];
  /** Snapshot of all known session MCP states. */
  sessionStates(): SessionMcpState[];
  /** Session ids returned from newSession/loadSession so far. */
  sessions(): string[];
  /** Shared process liveness — MCP failure of one session never kills it. */
  isProcessAlive(): boolean;
  /** Explicit kill for tests that model process death (not used by sticky MCP fail). */
  killProcess(): void;
  /** Push a session/update to a specific session's sink. */
  push(sessionId: string, update: unknown): void;
  /** Push a connection line (shared across sessions). */
  conn(line: string, source?: 'stderr' | 'non-json'): void;
  /** Resolve the pending prompt for a session. */
  resolve(sessionId: string, result: unknown): void;
  /** Reject the pending prompt for a session. */
  reject(sessionId: string, err: unknown): void;
  /** Resolves when registerSessionSink is first called for sessionId. */
  waitForSessionSink(sessionId: string): Promise<void>;
  /** Resolves when prompt is first called for sessionId. */
  waitForPrompt(sessionId: string): Promise<void>;
}

export interface FakeAcpFaultClientOptions {
  /** IDs returned by successive newSession calls (FIFO). Extra calls auto-generate. */
  sessionIdQueue?: string[];
  loadSessionSupported?: boolean;
  modelConfig?: {
    id: string;
    applyVia?: 'config_option' | 'session_set_model';
    currentValue?: string;
    options: { value: string; name: string }[];
  };
  /** Healthy-session catalog (defaults to full Muster catalog). */
  healthyTools?: FakeMcpTool[];
  /**
   * Catalog returned for MCP-failed sessions. Defaults to healthy catalog with
   * complete_task / fail_task stripped.
   */
  failedTools?: FakeMcpTool[];
}

interface PendingPrompt {
  promise: Promise<unknown>;
  resolve: (r: unknown) => void;
  reject: (e: unknown) => void;
  opened: boolean;
}

interface SessionRuntime {
  state: SessionMcpState;
  sinks: Set<(u: unknown) => void>;
  prompt?: PendingPrompt;
  sinkReady?: { promise: Promise<void>; resolve: () => void };
  promptReady?: { promise: Promise<void>; resolve: () => void };
}

function catalogWithoutDisposition(tools: FakeMcpTool[]): FakeMcpTool[] {
  const ban = new Set<string>(MUSTER_DISPOSITION_TOOLS);
  return tools.filter((t) => !ban.has(t.name)).map((t) => ({ ...t }));
}

function copyTools(tools: FakeMcpTool[]): FakeMcpTool[] {
  return tools.map((t) => ({ ...t }));
}

/**
 * Create a multi-session fake ACP client with per-session sticky MCP failure.
 *
 * @example
 * ```ts
 * const h = makeFakeAcpFaultClient({ sessionIdQueue: ['sess-A', 'sess-B'] });
 * h.markSessionMcpFailed('sess-A');
 * const a = await h.client.newSession(cwd, mcpServers);
 * const b = await h.client.newSession(cwd, mcpServers);
 * // A lacks complete_task/fail_task; B has full catalog; process stays alive
 * ```
 */
export function makeFakeAcpFaultClient(
  opts: FakeAcpFaultClientOptions = {},
): FakeAcpFaultHarness {
  const healthyTools = copyTools(opts.healthyTools ?? defaultMusterToolCatalog());
  const failedTools = copyTools(
    opts.failedTools ?? catalogWithoutDisposition(healthyTools),
  );
  const sessionIdQueue = [...(opts.sessionIdQueue ?? [])];
  let autoSessionSeq = 0;
  let processAlive = true;

  const sessions = new Map<string, SessionRuntime>();
  /** Pre-marks applied before session create. */
  const stickyFailures = new Map<string, string | undefined>();
  let connectionSink: ((line: string, source: 'stderr' | 'non-json') => void) | undefined;

  const calls: FakeAcpFaultHarness['calls'] = {
    ensureConnected: [],
    newSession: [],
    loadSession: [],
    setConfigOption: [],
    setSessionModel: [],
    prompt: [],
    cancel: [],
    closeSession: [],
    registerConnectionSink: [],
    registerSessionSink: [],
  };
  const callOrder: string[] = [];

  function nextSessionId(): string {
    if (sessionIdQueue.length > 0) return sessionIdQueue.shift() as string;
    autoSessionSeq += 1;
    return `sess-auto-${autoSessionSeq}`;
  }

  function ensureRuntime(sessionId: string, created: boolean): SessionRuntime {
    let runtime = sessions.get(sessionId);
    if (!runtime) {
      const failed = stickyFailures.has(sessionId);
      const reason = stickyFailures.get(sessionId);
      runtime = {
        state: {
          sessionId,
          mcpFailed: failed,
          mcpReady: !failed,
          reason: failed ? reason ?? 'mcp registry failed' : undefined,
          tools: copyTools(failed ? failedTools : healthyTools),
          created,
        },
        sinks: new Set(),
      };
      sessions.set(sessionId, runtime);
    } else if (created) {
      runtime.state.created = true;
    }
    return runtime;
  }

  function applyMcpFailed(runtime: SessionRuntime, reason?: string): void {
    runtime.state.mcpFailed = true;
    runtime.state.mcpReady = false;
    runtime.state.reason = reason ?? runtime.state.reason ?? 'mcp registry failed';
    runtime.state.tools = copyTools(failedTools);
  }

  function ensurePrompt(runtime: SessionRuntime): PendingPrompt {
    if (!runtime.prompt) {
      let resolve!: (r: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      runtime.prompt = { promise, resolve, reject, opened: false };
    }
    return runtime.prompt;
  }

  function ensureSinkReady(runtime: SessionRuntime): Promise<void> {
    if (!runtime.sinkReady) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      runtime.sinkReady = { promise, resolve };
    }
    return runtime.sinkReady.promise;
  }

  function ensurePromptReady(runtime: SessionRuntime): Promise<void> {
    if (!runtime.promptReady) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      runtime.promptReady = { promise, resolve };
    }
    return runtime.promptReady.promise;
  }

  function assertAlive(method: string): void {
    if (!processAlive) {
      throw new Error(`ACP process is not alive; cannot ${method}`);
    }
  }

  const client = {
    loadSessionSupported: opts.loadSessionSupported ?? true,
    registerConnectionSink: (fn: (line: string, source: 'stderr' | 'non-json') => void) => {
      callOrder.push('registerConnectionSink');
      calls.registerConnectionSink.push([]);
      connectionSink = fn;
      return () => {
        if (connectionSink === fn) connectionSink = undefined;
      };
    },
    ensureConnected: async (...args: unknown[]) => {
      callOrder.push('ensureConnected');
      calls.ensureConnected.push(args);
      assertAlive('ensureConnected');
    },
    newSession: async (...args: unknown[]) => {
      callOrder.push('newSession');
      calls.newSession.push(args);
      assertAlive('newSession');
      const sessionId = nextSessionId();
      ensureRuntime(sessionId, true);
      return { sessionId, modelConfig: opts.modelConfig };
    },
    loadSession: async (...args: unknown[]) => {
      callOrder.push('loadSession');
      calls.loadSession.push(args);
      assertAlive('loadSession');
      // loadSession(sessionId, cwd, mcpServers, timeoutMs?) — prefer first string arg.
      const requested =
        typeof args[0] === 'string' && args[0].length > 0 ? (args[0] as string) : nextSessionId();
      ensureRuntime(requested, true);
      return { sessionId: requested };
    },
    setConfigOption: async (...args: unknown[]) => {
      callOrder.push('setConfigOption');
      calls.setConfigOption.push(args);
      assertAlive('setConfigOption');
    },
    setSessionModel: async (...args: unknown[]) => {
      callOrder.push('setSessionModel');
      calls.setSessionModel.push(args);
      assertAlive('setSessionModel');
    },
    registerSessionSink: (sid: string, fn: (u: unknown) => void) => {
      callOrder.push('registerSessionSink');
      calls.registerSessionSink.push([sid]);
      const runtime = ensureRuntime(sid, false);
      runtime.sinks.add(fn);
      void ensureSinkReady(runtime);
      runtime.sinkReady?.resolve();
      return () => {
        runtime.sinks.delete(fn);
      };
    },
    prompt: (...args: unknown[]) => {
      callOrder.push('prompt');
      calls.prompt.push(args);
      assertAlive('prompt');
      const sid =
        typeof args[0] === 'string' ? (args[0] as string) : ensureRuntime('unknown', false).state.sessionId;
      const runtime = ensureRuntime(sid, false);
      const pending = ensurePrompt(runtime);
      pending.opened = true;
      void ensurePromptReady(runtime);
      runtime.promptReady?.resolve();
      // Legacy path (no mcpSetup) still allows prompt on a failed MCP registry.
      // S06 recovery path blocks prompt via awaitReady before this is reached.
      return pending.promise;
    },
    cancel: (...args: unknown[]) => {
      callOrder.push('cancel');
      calls.cancel.push(args);
    },
    closeSession: async (...args: unknown[]) => {
      callOrder.push('closeSession');
      calls.closeSession.push(args);
      // Best-effort; process stays alive.
    },
  };

  const harness: FakeAcpFaultHarness = {
    client,
    calls,
    callOrder,

    markSessionMcpFailed(sessionId, reason) {
      stickyFailures.set(sessionId, reason);
      const runtime = sessions.get(sessionId);
      if (runtime) applyMcpFailed(runtime, reason);
      else {
        // Pre-create state so toolCatalogFor / isSessionMcpFailed work immediately.
        ensureRuntime(sessionId, false);
        const r = sessions.get(sessionId)!;
        applyMcpFailed(r, reason);
      }
    },

    isSessionMcpFailed(sessionId) {
      return sessions.get(sessionId)?.state.mcpFailed ?? stickyFailures.has(sessionId);
    },

    isSessionMcpReady(sessionId) {
      const runtime = sessions.get(sessionId);
      if (runtime) return runtime.state.mcpReady;
      if (stickyFailures.has(sessionId)) return false;
      return false; // unknown session is not ready
    },

    mcpFailureReason(sessionId) {
      return sessions.get(sessionId)?.state.reason ?? stickyFailures.get(sessionId);
    },

    toolCatalogFor(sessionId) {
      const runtime = sessions.get(sessionId);
      if (runtime) return copyTools(runtime.state.tools);
      if (stickyFailures.has(sessionId)) return copyTools(failedTools);
      return [];
    },

    sessionStates() {
      return [...sessions.values()].map((r) => ({
        ...r.state,
        tools: copyTools(r.state.tools),
      }));
    },

    sessions() {
      return [...sessions.values()]
        .filter((r) => r.state.created)
        .map((r) => r.state.sessionId);
    },

    isProcessAlive() {
      return processAlive;
    },

    killProcess() {
      processAlive = false;
    },

    push(sessionId, update) {
      const runtime = sessions.get(sessionId);
      if (!runtime || runtime.sinks.size === 0) {
        throw new Error(`session sink not registered yet for ${sessionId}`);
      }
      for (const sink of runtime.sinks) sink(update);
    },

    conn(line, source = 'stderr') {
      if (!connectionSink) throw new Error('connection sink not registered yet');
      connectionSink(line, source);
    },

    resolve(sessionId, result) {
      const runtime = sessions.get(sessionId);
      if (!runtime?.prompt) {
        throw new Error(`no pending prompt for ${sessionId}`);
      }
      runtime.prompt.resolve(result);
    },

    reject(sessionId, err) {
      const runtime = sessions.get(sessionId);
      if (!runtime?.prompt) {
        throw new Error(`no pending prompt for ${sessionId}`);
      }
      runtime.prompt.reject(err);
    },

    waitForSessionSink(sessionId) {
      const runtime = ensureRuntime(sessionId, false);
      return ensureSinkReady(runtime);
    },

    waitForPrompt(sessionId) {
      const runtime = ensureRuntime(sessionId, false);
      return ensurePromptReady(runtime);
    },
  };

  return harness;
}

/** True when catalog lacks every Muster disposition tool. */
export function catalogMissingDispositionTools(tools: readonly FakeMcpTool[]): boolean {
  const names = new Set(tools.map((t) => t.name));
  return MUSTER_DISPOSITION_TOOLS.every((n) => !names.has(n));
}

/** True when catalog includes every Muster disposition tool. */
export function catalogHasDispositionTools(tools: readonly FakeMcpTool[]): boolean {
  const names = new Set(tools.map((t) => t.name));
  return MUSTER_DISPOSITION_TOOLS.every((n) => names.has(n));
}

export { DEFAULT_MUSTER_TOOLS, defaultMusterToolCatalog };
export type { FakeMcpTool };
