// Slim copy of the shared contract from src/types.ts — see docs/WEBVIEW.md §10.
// Do NOT import src/types.ts directly (different build graph). Keep in sync
// with docs/ADAPTER-SPEC.md.

export type NormalizedEvent =
  | { type: 'sessionStarted'; sessionId?: string; meta?: Record<string, unknown> }
  | { type: 'assistantDelta'; content: string; messageId: string; meta?: Record<string, unknown> }
  | { type: 'reasoningDelta'; content: string; messageId: string; meta?: Record<string, unknown> }
  | {
      type: 'toolStarted';
      toolCallId: string;
      name: string;
      kind?: 'mcp' | 'builtin' | 'other';
      input?: unknown;
      meta?: Record<string, unknown>;
    }
  | { type: 'toolUpdated'; toolCallId: string; input?: unknown; meta?: Record<string, unknown> }
  | {
      type: 'toolCompleted';
      toolCallId: string;
      outcome: 'success' | 'error';
      output?: unknown;
      error?: string;
      meta?: Record<string, unknown>;
    }
  | { type: 'usage'; usage: Record<string, unknown>; meta?: Record<string, unknown> }
  | { type: 'turnCompleted'; meta?: Record<string, unknown> }
  | { type: 'error'; message: string; isCancellation?: boolean; raw?: unknown; meta?: Record<string, unknown> }
  | { type: 'raw'; line: string };

// muster_bridge ask_user question shape (Phase 3).
export interface Question {
  prompt: string;
  options?: string[];
  allowFreeText?: boolean;
  multiSelect?: boolean;
}
