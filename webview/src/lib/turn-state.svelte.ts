import type { NormalizedEvent } from './types';

// Settled, rendered transcript items (the in-memory twin of the host-owned
// TranscriptItem model, docs/WEBVIEW.md §8). Keyed by a unique, monotonic id.
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
  id: string; // toolCallId
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

let counter = 0;
function uid(): string {
  return `i${++counter}`;
}

/**
 * Reactive chat state (Svelte 5 runes). A single mutable streaming buffer holds
 * the in-flight assistant message and is kept separate from `items` so that
 * settled history never re-renders while streaming (docs/WEBVIEW.md §7.3).
 */
class ThreadState {
  items = $state<ThreadItem[]>([]);
  streaming = $state<{ messageId: string; text: string } | null>(null);
  running = $state(false);
  runId = $state<string | null>(null);
  sessionId = $state<string | undefined>(undefined);
  backend = $state('claude');

  reset(): void {
    this.items = [];
    this.streaming = null;
    this.running = false;
    this.runId = null;
    this.sessionId = undefined;
  }

  startTurn(runId: string, prompt: string): void {
    this.running = true;
    this.runId = runId;
    this.items.push({ kind: 'user', id: uid(), text: prompt });
  }

  endTurn(): void {
    this.commitStreaming();
    this.running = false;
    this.runId = null;
  }

  pushError(message: string, isCancellation = false): void {
    this.commitStreaming();
    this.items.push({ kind: 'error', id: uid(), message, isCancellation });
  }

  private commitStreaming(): void {
    if (this.streaming && this.streaming.text.length > 0) {
      this.items.push({ kind: 'assistant', id: uid(), text: this.streaming.text });
    }
    this.streaming = null;
  }

  private findTool(id: string): ToolItem | undefined {
    for (const it of this.items) {
      if (it.kind === 'tool' && it.id === id) return it;
    }
    return undefined;
  }

  /** Reduce one NormalizedEvent into the thread (docs/WEBVIEW.md §5). */
  applyEvent(ev: NormalizedEvent): void {
    switch (ev.type) {
      case 'sessionStarted':
        if (ev.sessionId) this.sessionId = ev.sessionId;
        break;

      case 'assistantDelta':
        if (!this.streaming || this.streaming.messageId !== ev.messageId) {
          this.commitStreaming();
          this.streaming = { messageId: ev.messageId, text: '' };
        }
        this.streaming.text += ev.content;
        break;

      case 'toolStarted':
        this.commitStreaming();
        this.items.push({
          kind: 'tool',
          id: ev.toolCallId,
          name: ev.name,
          toolKind: ev.kind,
          status: 'running',
        });
        break;

      case 'toolCompleted': {
        const tool = this.findTool(ev.toolCallId);
        if (tool) {
          tool.status = ev.outcome;
          if (ev.outcome === 'error') tool.error = ev.error;
        }
        break;
      }

      case 'error':
        this.pushError(ev.message, ev.isCancellation ?? false);
        break;

      case 'turnCompleted':
        this.commitStreaming();
        break;

      // reasoningDelta (Phase 2), toolUpdated (Phase 2), usage (Phase 2),
      // raw (never rendered — ADAPTER-SPEC) are intentionally ignored.
      case 'reasoningDelta':
      case 'toolUpdated':
      case 'usage':
      case 'raw':
        break;
    }
  }
}

export const thread = new ThreadState();
