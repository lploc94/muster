export type NormalizedEvent =
  | { type: 'sessionStarted'; sessionId?: string; meta?: Record<string, unknown> }
  | { type: 'assistantDelta'; content: string; messageId: string; meta?: Record<string, unknown> }
  | { type: 'reasoningDelta'; content: string; messageId: string; meta?: Record<string, unknown> }
  | { type: 'toolStarted'; toolCallId: string; name: string; kind?: 'mcp' | 'builtin' | 'other'; input?: unknown; meta?: Record<string, unknown> }
  | { type: 'toolUpdated'; toolCallId: string; input?: unknown; meta?: Record<string, unknown> }
  | { type: 'toolCompleted'; toolCallId: string; outcome: 'success' | 'error'; output?: unknown; error?: string; meta?: Record<string, unknown> }
  | { type: 'usage'; usage: Record<string, unknown>; meta?: Record<string, unknown> }
  | { type: 'turnCompleted'; meta?: Record<string, unknown> }
  | { type: 'error'; message: string; isCancellation?: boolean; raw?: unknown; meta?: Record<string, unknown> }
  | { type: 'raw'; line: string };

/**
 * ACP `session/new` / `session/load` MCP entry.
 * - `http` / `sse`: remote transports (not used for Muster ACP muster_bridge injection;
 *   headless non-ACP backends still write an HTTP muster_bridge via `--mcp-config`).
 * - `stdio`: local process transport — sole ACP muster_bridge path via Muster-owned proxy
 *   (M017-S07). Env is an ACP env-variable array (`{ name, value }[]`); secrets must never
 *   appear in args.
 */
export type McpServerConfig =
  | { type: 'http'; name: string; url: string; headers?: { name: string; value: string }[] }
  | { type: 'sse'; name: string; url: string; headers?: { name: string; value: string }[] }
  | {
      type: 'stdio';
      name: string;
      command: string;
      args: string[];
      env?: { name: string; value: string }[];
    };

/**
 * Failure taxonomy for the pre-dispatch MCP setup loop (M017-S06).
 * Includes readiness codes plus setup-loop-only codes (sticky registry,
 * timeout, attempts exhausted).
 */
export type McpSetupFailureCode =
  | 'wrong_catalog'
  | 'missing_evidence'
  | 'generation_mismatch'
  | 'session_registry_sticky'
  | 'setup_timeout'
  | 'attempts_exhausted'
  | 'stale_attempt'
  | 'setup_in_progress'
  | 'not_initialized';

/** How the current setup attempt obtains an ACP session. */
export type McpSetupRecoveryMode = 'load' | 'new' | 'fresh_after_sticky';

/** Per-attempt context passed to mcpSetup controller hooks. */
export interface McpSetupAttemptContext {
  /** 1-based attempt index. */
  attempt: number;
  /** Bounded max attempts for this turn (hard-capped at 2). */
  maxAttempts: number;
  recoveryMode: McpSetupRecoveryMode;
  /** True when a prior sticky load failure forced session/new. */
  forceFreshSession: boolean;
  previousFailure?: {
    code: string;
    message: string;
  };
}

/** Optional overrides returned from prepareAttempt. */
export interface McpSetupPrepareResult {
  /**
   * Session resume target for this attempt.
   * - string: session/load that id
   * - null: force session/new
   * - omit: inherit RunOptions.resumeId unless forceFreshSession
   */
  resumeId?: string | null;
  /** Optional prompt override (e.g. fresh-session recovery prompt). */
  prompt?: string;
}

export type McpSetupReadyResult =
  | { ok: true }
  | {
      ok: false;
      code: McpSetupFailureCode | string;
      message: string;
      /** Sticky session registry — next attempt must session/new. */
      sticky?: boolean;
      /** Defaults true while attempts remain. */
      retriable?: boolean;
    };

/**
 * Optional pre-dispatch MCP setup controller (ACP backends only).
 * When present, runAcpTurn runs a bounded setup loop:
 * prepareAttempt → session/load|new → awaitReady → onBeforePrompt → prompt once.
 * Omitted by non-ACP backends and by callers that do not need readiness recovery.
 */
export interface McpSetupController {
  /** Default 2; hard-capped at 2. */
  maxAttempts?: number;
  prepareAttempt: (
    ctx: McpSetupAttemptContext,
  ) => void | McpSetupPrepareResult | Promise<void | McpSetupPrepareResult>;
  awaitReady: (
    ctx: McpSetupAttemptContext & { sessionId: string },
  ) => Promise<McpSetupReadyResult>;
  disposeAttempt?: (
    ctx: McpSetupAttemptContext & {
      sessionId?: string;
      failure?: { code: string; message: string };
    },
  ) => void | Promise<void>;
  /**
   * Optional durable recovery prompt after sticky session/load failure.
   * Budget failure must throw — runAcpTurn fails pre_dispatch without a
   * context-less prompt.
   */
  buildFreshSessionPrompt?: (
    ctx: McpSetupAttemptContext & { sessionId?: string },
  ) => string | Promise<string>;
}

export interface RunOptions {
  prompt: string;
  resumeId?: string;
  mcpConfigPath?: string;
  /** Per-session MCP injection for ACP backends (empty by default). */
  mcpServers?: McpServerConfig[];
  cwd?: string;
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;
  /** Host-derived ACP request budget; always extends beyond the engine run deadline. */
  promptTimeoutMs?: number;
  /**
   * Remaining wall-clock budget for ACP setup (connect/session/model) so backend
   * init is included in the frozen run deadline. Absent when no deadline is frozen.
   */
  setupTimeoutMs?: number;
  /** Model to select for this turn's session (ACP `session/set_config_option`). */
  model?: string;
  /**
   * Phase C: durable dispatch boundary. Invoked immediately before the
   * side-effecting `session/prompt` (or equivalent). Host must persist
   * `prompt_outstanding` here so pre-dispatch failures remain safe_to_retry.
   */
  onBeforePrompt?: () => void | Promise<void>;
  /**
   * M017-S06: optional bounded pre-dispatch MCP setup/recovery controller.
   * When set, session/prompt runs only after awaitReady succeeds for the live
   * attempt. Non-ACP backends omit this.
   */
  mcpSetup?: McpSetupController;
}

export interface BackendCapabilities {
  supportsReasoning: boolean;
  supportsDetailedToolEvents: boolean;
  supportsMCP: boolean;
}

export interface Backend {
  readonly name: string;
  readonly capabilities?: BackendCapabilities;
  run(options: RunOptions): AsyncIterable<NormalizedEvent>;
  extractSessionId?(rawOutput: string, lastUsedId?: string): string | undefined;
}
