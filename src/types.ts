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
