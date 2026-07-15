/**
 * Pure file-mention autocomplete session for Composer.
 * Debounces request posts, correlates responses by request scope
 * (requestId + parentDepth + relativeQuery + taskId), and never stores
 * absolute paths. Independent of Svelte DOM code.
 */

import { parseActiveFileMentionQuery, type ActiveFileMentionQuery } from './file-mention-query';
import {
  acceptFileMentionSuggestionResponse,
  type FileMentionSuggestionAcceptScope,
} from './file-mention-suggestions';
import type {
  FileMentionParentDepth,
  FileMentionSuggestionItem,
  FileMentionSuggestionsMessage,
  OutMessage,
} from './protocol';

/** Debounce window for host suggestion requests (keystroke coalescing). */
export const FILE_MENTION_SUGGESTION_DEBOUNCE_MS = 120;

export interface FileMentionAutocompleteState {
  open: boolean;
  items: FileMentionSuggestionItem[];
  activeQuery: ActiveFileMentionQuery | null;
  pendingRequestId: string | null;
}

export interface FileMentionAutocompleteCaretInput {
  text: string;
  caret: number;
  canSend: boolean;
  taskId?: string;
}

export interface FileMentionAutocompleteSessionOptions {
  post: (message: OutMessage) => void;
  createRequestId?: () => string;
  debounceMs?: number;
  /** Optional clock hooks for tests (defaults to window timers). */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface FileMentionAutocompleteSession {
  onCaretChange(input: FileMentionAutocompleteCaretInput): void;
  onResponse(message: FileMentionSuggestionsMessage): void;
  getState(): FileMentionAutocompleteState;
  reset(): void;
  dispose(): void;
}

/**
 * Accept a host suggestion response only when requestId matches the active scope.
 * Returns null for stale/mismatched responses. Failures close without free-form text.
 *
 * @deprecated Prefer acceptFileMentionSuggestionResponse for parentDepth/query/task scope.
 * Kept for unit tests that exercise the legacy requestId-only shape.
 */
export interface AcceptFileMentionScope {
  requestId: string;
  relativeQuery: string;
  parentDepth: FileMentionParentDepth;
}

/**
 * Accept a host suggestion response only when requestId matches the active scope.
 * Returns null for stale/mismatched responses. Failures close without free-form text.
 */
export function acceptFileMentionSuggestions(
  scope: AcceptFileMentionScope | null,
  message: FileMentionSuggestionsMessage,
): { ok: true; items: FileMentionSuggestionItem[] } | { ok: false; items: [] } | null {
  if (!scope || message.requestId !== scope.requestId) {
    return null;
  }
  if (message.ok === false) {
    return { ok: false, items: [] };
  }
  return { ok: true, items: message.items };
}

/**
 * Replace exactly the active @query range with a mention token.
 * Adds a single trailing space when the suffix does not already start with whitespace.
 */
export function replaceActiveFileMentionQuery(
  text: string,
  range: { start: number; end: number },
  token: string,
): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const trailing = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
  const insertion = `${token}${trailing}`;
  return {
    text: `${before}${insertion}${after}`,
    caret: before.length + insertion.length,
  };
}

/**
 * Refine the active @query into a directory scope for drill-down navigation.
 * Replaces the active range with `@insertionPath/` (no trailing space) so the
 * caret stays inside a valid autocomplete token and children are requested next.
 */
export function refineActiveFileMentionDirectory(
  text: string,
  range: { start: number; end: number },
  insertionPath: string,
): { text: string; caret: number } {
  const normalized = insertionPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const token = `@${normalized}/`;
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  return {
    text: `${before}${token}${after}`,
    caret: before.length + token.length,
  };
}

function defaultRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `fm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyState(): FileMentionAutocompleteState {
  return {
    open: false,
    items: [],
    activeQuery: null,
    pendingRequestId: null,
  };
}

/**
 * Create a debounced autocomplete session.
 * Stores only the current request scope; stale responses are ignored.
 */
export function createFileMentionAutocompleteSession(
  options: FileMentionAutocompleteSessionOptions,
): FileMentionAutocompleteSession {
  const debounceMs = options.debounceMs ?? FILE_MENTION_SUGGESTION_DEBOUNCE_MS;
  const createRequestId = options.createRequestId ?? defaultRequestId;
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));

  let state = emptyState();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Scope of the in-flight / last posted request (for response correlation). */
  let pendingScope: FileMentionSuggestionAcceptScope | null = null;
  /** Latest caret input while a debounce is pending. */
  let latestInput: FileMentionAutocompleteCaretInput | null = null;

  function clearTimer(): void {
    if (timer != null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function setState(next: FileMentionAutocompleteState): void {
    state = next;
  }

  function closeAndClearPending(): void {
    clearTimer();
    pendingScope = null;
    latestInput = null;
    setState(emptyState());
  }

  function fireRequest(input: FileMentionAutocompleteCaretInput, query: ActiveFileMentionQuery): void {
    const requestId = createRequestId();
    const scope: FileMentionSuggestionAcceptScope = {
      requestId,
      relativeQuery: query.relativeQuery,
      parentDepth: query.parentDepth,
      taskId: input.taskId,
    };
    pendingScope = scope;
    setState({
      open: false,
      items: [],
      activeQuery: query,
      pendingRequestId: requestId,
    });

    const message: OutMessage = {
      type: 'requestFileMentionSuggestions',
      requestId,
      parentDepth: query.parentDepth,
      relativeQuery: query.relativeQuery,
    };
    if (input.taskId) {
      (message as { taskId?: string }).taskId = input.taskId;
    }
    options.post(message);
  }

  return {
    onCaretChange(input: FileMentionAutocompleteCaretInput): void {
      if (disposed) return;
      latestInput = input;

      if (!input.canSend) {
        closeAndClearPending();
        return;
      }

      const query = parseActiveFileMentionQuery(input.text, input.caret);
      if (!query) {
        closeAndClearPending();
        return;
      }

      // Keep active query fresh even while debouncing so selection range is current.
      setState({
        open: false,
        items: [],
        activeQuery: query,
        pendingRequestId: state.pendingRequestId,
      });

      clearTimer();
      timer = setTimeoutFn(() => {
        timer = null;
        if (disposed) return;
        const current = latestInput;
        if (!current || !current.canSend) {
          closeAndClearPending();
          return;
        }
        const nextQuery = parseActiveFileMentionQuery(current.text, current.caret);
        if (!nextQuery) {
          closeAndClearPending();
          return;
        }
        fireRequest(current, nextQuery);
      }, debounceMs);
    },

    onResponse(message: FileMentionSuggestionsMessage): void {
      if (disposed) return;
      // Compare request-time taskId against the latest focused task/draft so a
      // late response cannot paint after the composer scope has moved.
      const accepted = acceptFileMentionSuggestionResponse(pendingScope, message, {
        focusedTaskId: latestInput?.taskId,
      });
      if (!accepted) {
        // Stale response — ignore without closing a newer pending request.
        return;
      }
      if (!accepted.ok) {
        setState({
          open: false,
          items: [],
          activeQuery: state.activeQuery,
          pendingRequestId: null,
        });
        pendingScope = null;
        return;
      }
      // S02: show files and directories so mouse navigation can drill down.
      setState({
        open: accepted.items.length > 0,
        items: accepted.items,
        activeQuery: state.activeQuery,
        pendingRequestId: null,
      });
      pendingScope = null;
    },

    getState(): FileMentionAutocompleteState {
      return state;
    },

    reset(): void {
      closeAndClearPending();
    },

    dispose(): void {
      disposed = true;
      closeAndClearPending();
    },
  };
}
