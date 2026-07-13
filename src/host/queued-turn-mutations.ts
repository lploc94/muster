import type { EngineResult } from '../task/engine';

/** Reject oversized inbound task/turn identifiers (defense-in-depth at host boundary). */
export const MAX_QUEUED_MUTATION_ID_CHARS = 256;

/**
 * Host-side content bound for editQueuedTurn. Matches TaskEngine.MAX_QUEUED_MESSAGE_CHARS
 * so oversized payloads are refused before they reach the engine store.
 */
export const MAX_QUEUED_MUTATION_CONTENT_CHARS = 100_000;

/** Cap for sanitized refusal text posted to the webview (no raw stack dumps). */
export const MAX_QUEUED_MUTATION_ERROR_CHARS = 400;

export type ParsedEditQueuedTurn =
  | { ok: true; taskId: string; turnId: string; content: string }
  | { ok: false; message: string; taskId?: string };

export type ParsedDeleteQueuedTurn =
  | { ok: true; taskId: string; turnId: string }
  | { ok: false; message: string; taskId?: string };

export type QueuedMutationHostOutcome =
  | { kind: 'ack'; taskId: string; turnId: string; messageId: string }
  | { kind: 'ack'; taskId: string; turnId: string; deletedMessageIds: string[] }
  | { kind: 'error'; taskId?: string; message: string };

/**
 * Strip control characters and bound length so refusal text is safe to surface
 * in the webview command-error chrome without leaking raw internals.
 */
export function sanitizeQueuedMutationText(
  text: string,
  max = MAX_QUEUED_MUTATION_ERROR_CHARS,
): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Drop stack-frame fragments that may appear if a raw Error leaked into reason.
  const withoutFrames = cleaned
    .replace(/\s+at\s+[\w.$<>]+\s*\([^)]*\)/g, '')
    .replace(/\s+at\s+[\w.$<>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutFrames.length <= max) return withoutFrames;
  return `${withoutFrames.slice(0, Math.max(0, max - 1))}…`;
}

function parseIds(
  record: Record<string, unknown>,
  label: 'editQueuedTurn' | 'deleteQueuedTurn',
): { ok: true; taskId: string; turnId: string } | { ok: false; message: string; taskId?: string } {
  if (typeof record.taskId !== 'string') {
    return { ok: false, message: `${label} requires taskId` };
  }
  const taskId = record.taskId.trim();
  if (!taskId) {
    return { ok: false, message: `${label} requires taskId` };
  }
  if (taskId.length > MAX_QUEUED_MUTATION_ID_CHARS || taskId.includes('\0')) {
    return {
      ok: false,
      message: `${label} taskId is invalid`,
      taskId: taskId.slice(0, MAX_QUEUED_MUTATION_ID_CHARS),
    };
  }
  if (typeof record.turnId !== 'string') {
    return { ok: false, message: `${label} requires turnId`, taskId };
  }
  const turnId = record.turnId.trim();
  if (!turnId) {
    return { ok: false, message: `${label} requires turnId`, taskId };
  }
  if (turnId.length > MAX_QUEUED_MUTATION_ID_CHARS || turnId.includes('\0')) {
    return { ok: false, message: `${label} turnId is invalid`, taskId };
  }
  return { ok: true, taskId, turnId };
}

/**
 * Validate a webview `editQueuedTurn` payload. Never mutates store state —
 * callers only receive a parse result or a typed engine outcome.
 */
export function parseEditQueuedTurnMessage(data: unknown): ParsedEditQueuedTurn {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, message: 'editQueuedTurn requires an object payload' };
  }
  const record = data as Record<string, unknown>;
  if (record.type !== undefined && record.type !== 'editQueuedTurn') {
    return { ok: false, message: 'editQueuedTurn type mismatch' };
  }
  const ids = parseIds(record, 'editQueuedTurn');
  if (!ids.ok) {
    return ids;
  }
  if (typeof record.content !== 'string') {
    return { ok: false, message: 'editQueuedTurn requires a non-empty content', taskId: ids.taskId };
  }
  // Preserve intentional leading/trailing spaces for delivery — empty after trim is invalid.
  if (!record.content.trim()) {
    return { ok: false, message: 'editQueuedTurn requires a non-empty content', taskId: ids.taskId };
  }
  if (record.content.length > MAX_QUEUED_MUTATION_CONTENT_CHARS) {
    return {
      ok: false,
      message: `editQueuedTurn content exceeds ${MAX_QUEUED_MUTATION_CONTENT_CHARS} characters`,
      taskId: ids.taskId,
    };
  }
  if (record.content.includes('\0')) {
    return { ok: false, message: 'editQueuedTurn content is invalid', taskId: ids.taskId };
  }
  return { ok: true, taskId: ids.taskId, turnId: ids.turnId, content: record.content };
}

/**
 * Validate a webview `deleteQueuedTurn` payload. Never mutates store state.
 */
export function parseDeleteQueuedTurnMessage(data: unknown): ParsedDeleteQueuedTurn {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, message: 'deleteQueuedTurn requires an object payload' };
  }
  const record = data as Record<string, unknown>;
  if (record.type !== undefined && record.type !== 'deleteQueuedTurn') {
    return { ok: false, message: 'deleteQueuedTurn type mismatch' };
  }
  return parseIds(record, 'deleteQueuedTurn');
}

/**
 * Map a typed engine refusal reason to a sanitized, user-visible commandError string.
 * Does not invent stack traces; strips control chars and frame-like fragments.
 */
export function queuedMutationRefusalMessage(reason: string): string {
  const sanitized = sanitizeQueuedMutationText(reason);
  if (!sanitized) {
    return 'Queued turn mutation refused';
  }
  // Already a short stable reason from the engine — prefix for channel consistency.
  if (/^queued turn mutation refused/i.test(sanitized)) {
    return sanitized;
  }
  return sanitizeQueuedMutationText(`Queued turn mutation refused: ${sanitized}`);
}

export interface EditQueuedTurnRouteDeps {
  engineReady: boolean;
  /**
   * Engine entrypoint. Tests assert this is called at most once and only after
   * payload validation succeeds — never continueTask / queue creation.
   */
  editQueuedTurn: (
    taskId: string,
    turnId: string,
    content: string,
  ) => EngineResult<{ turnId: string; messageId: string }>;
}

export interface DeleteQueuedTurnRouteDeps {
  engineReady: boolean;
  deleteQueuedTurn: (
    taskId: string,
    turnId: string,
  ) => EngineResult<{ turnId: string; deletedMessageIds: string[] }>;
}

/**
 * Host routing for editQueuedTurn: validate, delegate once to the engine, and
 * return either a success ack or a sanitized command-error payload. Never falls
 * through to continueTask or any other queue creation path.
 */
export function routeEditQueuedTurn(
  data: unknown,
  deps: EditQueuedTurnRouteDeps,
): QueuedMutationHostOutcome {
  if (!deps.engineReady) {
    return { kind: 'error', message: 'task engine not ready' };
  }
  const parsed = parseEditQueuedTurnMessage(data);
  if (!parsed.ok) {
    return { kind: 'error', taskId: parsed.taskId, message: parsed.message };
  }
  const result = deps.editQueuedTurn(parsed.taskId, parsed.turnId, parsed.content);
  if (result.ok) {
    return {
      kind: 'ack',
      taskId: parsed.taskId,
      turnId: result.value.turnId,
      messageId: result.value.messageId,
    };
  }
  return {
    kind: 'error',
    taskId: parsed.taskId,
    message: queuedMutationRefusalMessage(result.reason),
  };
}

/**
 * Host routing for deleteQueuedTurn: validate, delegate once to the engine, and
 * return either a success ack or a sanitized command-error payload.
 */
export function routeDeleteQueuedTurn(
  data: unknown,
  deps: DeleteQueuedTurnRouteDeps,
): QueuedMutationHostOutcome {
  if (!deps.engineReady) {
    return { kind: 'error', message: 'task engine not ready' };
  }
  const parsed = parseDeleteQueuedTurnMessage(data);
  if (!parsed.ok) {
    return { kind: 'error', taskId: parsed.taskId, message: parsed.message };
  }
  const result = deps.deleteQueuedTurn(parsed.taskId, parsed.turnId);
  if (result.ok) {
    return {
      kind: 'ack',
      taskId: parsed.taskId,
      turnId: result.value.turnId,
      deletedMessageIds: result.value.deletedMessageIds,
    };
  }
  return {
    kind: 'error',
    taskId: parsed.taskId,
    message: queuedMutationRefusalMessage(result.reason),
  };
}
