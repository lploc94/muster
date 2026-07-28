// Shared settled transcript item types (docs/WEBVIEW.md §7.3 / §8).
// Per-task thread state lives in thread.svelte.ts.

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  turnId?: string;
  /** Optional mid-turn order (interleaved with assistant/tool segments). */
  order?: number;
}
export interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
  turnId?: string;
  order?: number;
}
/** Optional ACP diff-block evidence projected across the host/webview boundary (M020). */
export interface ToolFileChange {
  path: string;
  oldText: string | null;
  newText: string;
  /** Present only when a side was clipped by the engine bound; never `false`. */
  truncated?: boolean;
  /** Present only when path resolved outside trusted workspace; never `false`. */
  outsideWorkspace?: true;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  toolKind?: 'mcp' | 'builtin' | 'other';
  status: 'running' | 'success' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
  /** Optional ACP diff evidence. Omitted when absent (never empty array). */
  fileChanges?: ToolFileChange[];
  /**
   * Count of valid fileChanges dropped by the file-count bound (M020 S02).
   * Omitted when zero / absent so content-only tools stay free of empty evidence.
   */
  fileChangesOmitted?: number;
  turnId?: string;
  order?: number;
}
export interface ReasoningItem {
  kind: 'reasoning';
  id: string;
  text: string;
  turnId: string;
  order: number;
}
export interface ErrorItem {
  kind: 'error';
  id: string;
  message: string;
  isCancellation?: boolean;
}
export type ThreadItem = UserItem | AssistantItem | ToolItem | ReasoningItem | ErrorItem;
