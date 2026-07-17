import type { RepositoryTranscriptItem, TaskRepository, TranscriptPage } from '../task/repository';
import { InvalidTranscriptCursorError } from '../task/transcript-cursor';
import type { MusterTask } from '../task/types';
import { BOOTSTRAP_TRANSCRIPT_LIMIT, toHostTranscriptItem } from './repository-snapshot';
import type { TranscriptItem, TranscriptPageState } from './snapshot';

/** Bounds for loadTranscriptPage correlation/payload fields (protocol v7). */
export const TRANSCRIPT_PAGE_REQUEST_ID_MAX = 128;
export const TRANSCRIPT_PAGE_TASK_ID_MAX = 512;
export const TRANSCRIPT_PAGE_CURSOR_MAX = 4096;
export const TRANSCRIPT_PAGE_LIMIT = BOOTSTRAP_TRANSCRIPT_LIMIT;

export type TranscriptPageErrorCode =
  | 'invalidRequest'
  | 'staleFocus'
  | 'taskNotFound'
  | 'invalidCursor'
  | 'unavailable';

export type TranscriptPageResultMessage =
  | {
      type: 'transcriptPageResult';
      requestId: string;
      taskId: string;
      ok: true;
      items: TranscriptItem[];
      transcriptPage: TranscriptPageState;
    }
  | {
      type: 'transcriptPageResult';
      requestId: string;
      taskId: string;
      ok: false;
      code: TranscriptPageErrorCode;
    };

export type ParsedLoadTranscriptPage =
  | {
      ok: true;
      requestId: string;
      taskId: string;
      beforeCursor: string;
    }
  | {
      ok: false;
      /** When correlation fields are unsafe, the host must not post a typed result. */
      silent: true;
    }
  | {
      ok: false;
      silent: false;
      requestId: string;
      taskId: string;
      code: 'invalidRequest';
    };

export interface TranscriptPageFocusState {
  taskId: string | undefined;
  generation: number;
}

export interface TranscriptPageRouteDeps {
  getFocused: () => TranscriptPageFocusState;
  getTask: (taskId: string) => Promise<MusterTask | undefined> | MusterTask | undefined;
  getTranscriptPage: (
    taskId: string,
    beforeCursor: string,
    limit: number,
  ) => Promise<TranscriptPage>;
}

export type TranscriptPageHostOutcome =
  | { kind: 'silent' }
  | { kind: 'message'; message: TranscriptPageResultMessage };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
}

const LOAD_TRANSCRIPT_PAGE_KEYS = ['type', 'requestId', 'taskId', 'beforeCursor'] as const;

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

/**
 * Validate a webview `loadTranscriptPage` payload before any repository call.
 * Exact shape only: type/requestId/taskId/beforeCursor. Correlation-unsafe or
 * missing/wrong type → silent; safe correlation with bad cursor/shape → typed
 * invalidRequest (zero repository calls either way).
 */
export function parseLoadTranscriptPageMessage(data: unknown): ParsedLoadTranscriptPage {
  if (!isRecord(data)) {
    return { ok: false, silent: true };
  }
  // type is required and must be exact; missing/wrong type is silent (no correlation post).
  if (data.type !== 'loadTranscriptPage') {
    return { ok: false, silent: true };
  }

  const requestId = data.requestId;
  const taskId = data.taskId;
  const correlationSafe =
    isBoundedString(requestId, TRANSCRIPT_PAGE_REQUEST_ID_MAX) &&
    isBoundedString(taskId, TRANSCRIPT_PAGE_TASK_ID_MAX);
  if (!correlationSafe) {
    return { ok: false, silent: true };
  }

  // Extra keys or invalid cursor with safe correlation → typed invalidRequest.
  if (!hasOnlyKeys(data, LOAD_TRANSCRIPT_PAGE_KEYS)) {
    return { ok: false, silent: false, requestId, taskId, code: 'invalidRequest' };
  }

  const beforeCursor = data.beforeCursor;
  if (!isBoundedString(beforeCursor, TRANSCRIPT_PAGE_CURSOR_MAX)) {
    return { ok: false, silent: false, requestId, taskId, code: 'invalidRequest' };
  }

  return {
    ok: true,
    requestId,
    taskId,
    beforeCursor,
  };
}

function failure(
  requestId: string,
  taskId: string,
  code: TranscriptPageErrorCode,
): TranscriptPageHostOutcome {
  return {
    kind: 'message',
    message: {
      type: 'transcriptPageResult',
      requestId,
      taskId,
      ok: false,
      code,
    },
  };
}

function pageStateFromResult(page: TranscriptPage): TranscriptPageState {
  return {
    hasMoreBefore: page.hasMoreBefore,
    workspaceRevision: page.workspaceRevision,
    ...(page.hasMoreBefore && page.beforeCursor !== undefined
      ? { beforeCursor: page.beforeCursor }
      : {}),
  };
}

/**
 * Pure host route for protocol-v7 loadTranscriptPage:
 * 1. Validate correlation + payload.
 * 2. Capture focus/generation; refuse non-focused task with zero page queries.
 * 3. Verify task existence, then query exactly one bounded keyset page.
 * 4. Re-check focus/generation after await; stale race → staleFocus, no success.
 * Never leaks SQL, stack, raw cursor, or free-form error text.
 */
export async function routeLoadTranscriptPage(
  data: unknown,
  deps: TranscriptPageRouteDeps,
): Promise<TranscriptPageHostOutcome> {
  const parsed = parseLoadTranscriptPageMessage(data);
  if (!parsed.ok) {
    if (parsed.silent) return { kind: 'silent' };
    return failure(parsed.requestId, parsed.taskId, parsed.code);
  }

  const { requestId, taskId, beforeCursor } = parsed;
  const focusAtStart = deps.getFocused();
  if (focusAtStart.taskId !== taskId) {
    return failure(requestId, taskId, 'staleFocus');
  }
  const generationAtStart = focusAtStart.generation;

  let task: MusterTask | undefined;
  try {
    task = await deps.getTask(taskId);
  } catch {
    return failure(requestId, taskId, 'unavailable');
  }
  if (!task) {
    return failure(requestId, taskId, 'taskNotFound');
  }

  let page: TranscriptPage;
  try {
    page = await deps.getTranscriptPage(taskId, beforeCursor, TRANSCRIPT_PAGE_LIMIT);
  } catch (error) {
    if (error instanceof InvalidTranscriptCursorError) {
      return failure(requestId, taskId, 'invalidCursor');
    }
    return failure(requestId, taskId, 'unavailable');
  }

  const focusAfter = deps.getFocused();
  if (focusAfter.taskId !== taskId || focusAfter.generation !== generationAtStart) {
    return failure(requestId, taskId, 'staleFocus');
  }

  const items = page.items.map((item: RepositoryTranscriptItem) => toHostTranscriptItem(item));
  return {
    kind: 'message',
    message: {
      type: 'transcriptPageResult',
      requestId,
      taskId,
      ok: true,
      items,
      transcriptPage: pageStateFromResult(page),
    },
  };
}

/** Type-only re-export so tests can name repository deps without importing host protocol. */
export type { TaskRepository };
