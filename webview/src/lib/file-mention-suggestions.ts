/**
 * Client-side request-scope correlation for file-mention suggestion responses.
 *
 * Accepts a host `fileMentionSuggestions` payload only when it matches the
 * latest request id, active query (parentDepth + relativeQuery), and the
 * currently focused task/draft scope. Never stores absolute paths.
 */

import type {
  FileMentionParentDepth,
  FileMentionSuggestionItem,
  FileMentionSuggestionsMessage,
} from './protocol';

export type { FileMentionParentDepth };

export interface FileMentionSuggestionAcceptScope {
  requestId: string;
  parentDepth: FileMentionParentDepth;
  relativeQuery: string;
  /** Task id at request time; undefined means draft/workspace scope. */
  taskId?: string;
}

export interface FileMentionSuggestionFocus {
  /** Currently focused task id (undefined = draft). */
  focusedTaskId?: string;
}

export type AcceptFileMentionSuggestionResult =
  | { ok: true; items: FileMentionSuggestionItem[] }
  | { ok: false; items: [] };

function sameTaskScope(
  scopeTaskId: string | undefined,
  focusedTaskId: string | undefined,
): boolean {
  const a = scopeTaskId ?? undefined;
  const b = focusedTaskId ?? undefined;
  return a === b;
}

/**
 * Accept a host suggestion response only when requestId, query fields, and
 * focused task/draft scope still match. Returns null for stale/mismatched
 * responses. Failures close without free-form text.
 */
export function acceptFileMentionSuggestionResponse(
  scope: FileMentionSuggestionAcceptScope | null,
  message: FileMentionSuggestionsMessage,
  focus?: FileMentionSuggestionFocus,
): AcceptFileMentionSuggestionResult | null {
  if (!scope || message.requestId !== scope.requestId) {
    return null;
  }

  if (focus !== undefined) {
    if (!sameTaskScope(scope.taskId, focus.focusedTaskId)) {
      return null;
    }
  }

  if (message.ok === false) {
    return { ok: false, items: [] };
  }

  // Success envelope: require matching parentDepth + relativeQuery so a late
  // response from an earlier keystroke cannot paint over a newer active query
  // that happens to reuse a recycled id (requestId is still primary).
  if (message.parentDepth !== scope.parentDepth) {
    return null;
  }
  if (message.relativeQuery !== scope.relativeQuery) {
    return null;
  }

  return { ok: true, items: message.items };
}
