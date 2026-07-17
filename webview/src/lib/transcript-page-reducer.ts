import type {
  TranscriptItem,
  TranscriptPageErrorCode,
  TranscriptPageResultMessage,
  TranscriptPageState,
} from './protocol';
import type { ThreadItem } from './turn-state.svelte';

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  return (content as { text?: string })?.text ?? '';
}

function transcriptToThreadItem(item: TranscriptItem): ThreadItem | null {
  switch (item.kind) {
    case 'user':
      return {
        kind: 'user',
        id: item.id,
        text: asText(item.content),
        turnId: item.turnId,
        order: item.order,
      };
    case 'assistant':
      return {
        kind: 'assistant',
        id: item.id,
        text: asText(item.content),
        turnId: item.turnId,
        order: item.order,
      };
    case 'error': {
      const content = item.content as { message?: string; isCancellation?: boolean } | string;
      const message = typeof content === 'string' ? content : (content?.message ?? 'Error');
      const isCancellation = typeof content === 'object' ? content?.isCancellation : false;
      return { kind: 'error', id: item.id, message, isCancellation };
    }
    case 'tool': {
      const t = item.content as {
        toolCallId?: string;
        name?: string;
        toolKind?: 'mcp' | 'builtin' | 'other';
        status?: 'running' | 'success' | 'error';
        input?: unknown;
        output?: unknown;
        error?: string;
      };
      return {
        kind: 'tool',
        id: item.id,
        name: t?.name ?? 'tool',
        toolKind: t?.toolKind,
        status: t?.status ?? 'success',
        input: t?.input,
        output: t?.output,
        error: t?.error,
        turnId: item.turnId,
        order: item.order,
      };
    }
    default:
      return null;
  }
}

/** Pure older-page request/merge state (protocol v7). */
export interface TranscriptPageWindowState {
  items: ThreadItem[];
  reasoningByTurn: Record<string, string>;
  /** All transcript entity IDs already owned (list items + reasoning). */
  loadedTranscriptIds: ReadonlySet<string>;
  beforeCursor?: string;
  hasMoreBefore: boolean;
  transcriptWorkspaceRevision?: number;
  olderPageLoading: boolean;
  pendingRequestId?: string;
  pendingTaskId?: string;
  pendingCursor?: string;
  olderPageError?: TranscriptPageErrorCode;
  lastAppliedRequestId?: string;
}

export type BeginLoadOlderResult =
  | { ok: true; requestId: string; taskId: string; beforeCursor: string; state: TranscriptPageWindowState }
  | { ok: false; reason: 'no_task' | 'no_cursor' | 'no_more' | 'in_flight'; state: TranscriptPageWindowState };

export type ApplyTranscriptPageResult = {
  state: TranscriptPageWindowState;
  applied: boolean;
  kind: 'success' | 'error' | 'noop';
};

function cloneIds(ids: ReadonlySet<string>): Set<string> {
  return new Set(ids);
}

export function emptyTranscriptPageWindowState(): TranscriptPageWindowState {
  return {
    items: [],
    reasoningByTurn: {},
    loadedTranscriptIds: new Set(),
    hasMoreBefore: false,
    olderPageLoading: false,
  };
}

/** Clear pending older-page request/error (focus/hydrate/reset). */
export function clearOlderPagePending(state: TranscriptPageWindowState): TranscriptPageWindowState {
  return {
    ...state,
    olderPageLoading: false,
    pendingRequestId: undefined,
    pendingTaskId: undefined,
    pendingCursor: undefined,
    olderPageError: undefined,
  };
}

/**
 * Build ownership set from a hydrate transcript window. Reasoning IDs are
 * tracked even though they are not rendered as list items.
 */
export function ownershipFromTranscript(items: readonly TranscriptItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    ids.add(item.id);
  }
  return ids;
}

export function beginLoadOlder(
  state: TranscriptPageWindowState,
  opts: { taskId: string | null | undefined; requestId: string },
): BeginLoadOlderResult {
  if (!opts.taskId) {
    return { ok: false, reason: 'no_task', state };
  }
  if (!state.hasMoreBefore) {
    return { ok: false, reason: 'no_more', state };
  }
  if (!state.beforeCursor) {
    return { ok: false, reason: 'no_cursor', state };
  }
  if (state.olderPageLoading || state.pendingRequestId) {
    return { ok: false, reason: 'in_flight', state };
  }
  const requestId = opts.requestId;
  if (!requestId || requestId.length > 128) {
    return { ok: false, reason: 'no_task', state };
  }
  return {
    ok: true,
    requestId,
    taskId: opts.taskId,
    beforeCursor: state.beforeCursor,
    state: {
      ...state,
      olderPageLoading: true,
      pendingRequestId: requestId,
      pendingTaskId: opts.taskId,
      pendingCursor: state.beforeCursor,
      olderPageError: undefined,
    },
  };
}

/**
 * Apply a host transcriptPageResult. Only matching focused task + pending
 * requestId may mutate state. Existing item/reasoning ownership always wins.
 */
export function applyTranscriptPageResult(
  state: TranscriptPageWindowState,
  message: TranscriptPageResultMessage,
  focusedTaskId: string | null | undefined,
): ApplyTranscriptPageResult {
  if (!focusedTaskId || message.taskId !== focusedTaskId) {
    return { state, applied: false, kind: 'noop' };
  }
  if (
    !state.pendingRequestId ||
    !state.pendingTaskId ||
    message.requestId !== state.pendingRequestId ||
    message.taskId !== state.pendingTaskId
  ) {
    return { state, applied: false, kind: 'noop' };
  }

  if (!message.ok) {
    return {
      applied: true,
      kind: 'error',
      state: {
        ...state,
        olderPageLoading: false,
        pendingRequestId: undefined,
        pendingTaskId: undefined,
        pendingCursor: undefined,
        olderPageError: message.code,
      },
    };
  }

  // Defensive: every currently rendered item ID is owned even if a live path
  // forgot to seed loadedTranscriptIds (existing/live always wins).
  const owned = cloneIds(state.loadedTranscriptIds);
  for (const item of state.items) owned.add(item.id);
  const prepended: ThreadItem[] = [];
  const reasoning = { ...state.reasoningByTurn };
  // Turns that already had reasoning before this page keep live/newer text.
  // Within the older page, multiple rows for a new turn use hydrate's last-wins.
  const preexistingReasoningTurns = new Set(Object.keys(state.reasoningByTurn));

  for (const item of message.items) {
    if (owned.has(item.id)) {
      // Existing ownership wins — never overwrite newer/live content.
      continue;
    }
    owned.add(item.id);
    if (item.kind === 'reasoning') {
      if (item.turnId && !preexistingReasoningTurns.has(item.turnId)) {
        reasoning[item.turnId] = asText(item.content);
      }
      continue;
    }
    const mapped = transcriptToThreadItem(item);
    if (mapped) prepended.push(mapped);
  }

  const page: TranscriptPageState = message.transcriptPage;
  const nextRevision =
    state.transcriptWorkspaceRevision === undefined
      ? page.workspaceRevision
      : Math.max(state.transcriptWorkspaceRevision, page.workspaceRevision);

  return {
    applied: true,
    kind: 'success',
    state: {
      items: [...prepended, ...state.items],
      reasoningByTurn: reasoning,
      loadedTranscriptIds: owned,
      beforeCursor: page.beforeCursor,
      hasMoreBefore: page.hasMoreBefore,
      transcriptWorkspaceRevision: nextRevision,
      olderPageLoading: false,
      pendingRequestId: undefined,
      pendingTaskId: undefined,
      pendingCursor: undefined,
      olderPageError: undefined,
      lastAppliedRequestId: message.requestId,
    },
  };
}
