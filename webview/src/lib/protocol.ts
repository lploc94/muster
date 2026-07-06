import { vscode } from './vscode';
import type { NormalizedEvent, Question } from './types';

// Extension host -> webview (docs/WEBVIEW.md §4.1). Phase 1 handles all but
// askPending / historyChunk (later phases).
export type ExtMessage =
  | { type: 'turnStart'; runId: string; prompt: string; backend: string; resume: boolean }
  | { type: 'event'; runId: string; event: NormalizedEvent }
  | { type: 'turnDone'; runId: string }
  | { type: 'turnError'; runId: string; message: string }
  | { type: 'askPending'; id: string; questions: Question[] }
  | { type: 'sessionReset' };

// Webview -> extension host (docs/WEBVIEW.md §4.2). Phase 1 subset.
export type OutMessage =
  | { type: 'send'; text: string; backend?: string; continueLast?: boolean }
  | { type: 'newSession'; backend?: string }
  | { type: 'cancelTurn' };

/** Post a typed message to the extension host. */
export function post(message: OutMessage): void {
  vscode.postMessage(message);
}

/** Minimal runtime guard for messages arriving from the extension host. */
export function isExtMessage(data: unknown): data is ExtMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}
