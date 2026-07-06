// Shared settled transcript item types (docs/WEBVIEW.md §7.3 / §8).
// Per-task thread state lives in thread.svelte.ts.

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
}
export interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
}
export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  toolKind?: 'mcp' | 'builtin' | 'other';
  status: 'running' | 'success' | 'error';
  error?: string;
}
export interface ErrorItem {
  kind: 'error';
  id: string;
  message: string;
  isCancellation?: boolean;
}
export type ThreadItem = UserItem | AssistantItem | ToolItem | ErrorItem;