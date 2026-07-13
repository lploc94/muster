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

/** ACP `session/new` / `session/load` MCP entry (http/sse only over ACP). */
export type McpServerConfig =
  | { type: 'http'; name: string; url: string; headers?: { name: string; value: string }[] }
  | { type: 'sse'; name: string; url: string; headers?: { name: string; value: string }[] };

export interface RunOptions {
  prompt: string;
  resumeId?: string;
  mcpConfigPath?: string;
  /** Per-session MCP injection for ACP backends (empty by default). */
  mcpServers?: McpServerConfig[];
  cwd?: string;
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;
  /** Model to select for this turn's session (ACP `session/set_config_option`). */
  model?: string;
}

export interface BackendCapabilities {
  supportsReasoning: boolean;
  supportsDetailedToolEvents: boolean;
  supportsMCP: boolean;
  /**
   * True when this backend may deliver in-flight input to a live turn
   * (subject to runtime agent capability evidence). False means the backend
   * has no live-input path and callers must refuse without queue mutation.
   */
  supportsLiveInput: boolean;
}

/** Request to inject an instruction into a backend's currently-active turn. */
export interface LiveInputRequest {
  sessionId: string;
  instruction: string;
  signal?: AbortSignal;
}

/**
 * Stable live-input outcomes. Backend/engine/host layers share these codes so
 * refusals stay capability- and ownership-specific (never silent queueing).
 */
export type LiveInputResult =
  | { code: 'delivered'; sessionId: string }
  | { code: 'unsupported'; reason: string }
  | { code: 'no-active-turn'; reason: string }
  | { code: 'not-local-owner'; reason: string }
  | { code: 'rejected'; reason: string }
  | { code: 'cancelled'; reason: string };

export interface Backend {
  readonly name: string;
  readonly capabilities?: BackendCapabilities;
  run(options: RunOptions): AsyncIterable<NormalizedEvent>;
  extractSessionId?(rawOutput: string, lastUsedId?: string): string | undefined;
  /**
   * Optional in-flight input path. When absent or when capability evidence is
   * missing, callers treat live input as unsupported.
   */
  sendLiveInput?(request: LiveInputRequest): Promise<LiveInputResult>;
}