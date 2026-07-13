import type { LiveInputResult } from '../types';

/** Reject oversized inbound task identifiers (defense-in-depth at host boundary). */
export const MAX_LIVE_INPUT_ID_CHARS = 256;

/**
 * Host-side instruction bound for live input. Matches TaskEngine.MAX_LIVE_INPUT_CHARS
 * so oversized payloads are refused before they reach the engine/backend path.
 */
export const MAX_LIVE_INPUT_INSTRUCTION_CHARS = 8_192;

/** Cap for sanitized refusal text posted to the webview (no raw stack dumps). */
export const MAX_LIVE_INPUT_ERROR_CHARS = 400;

export type ParsedLiveInput =
  | { ok: true; taskId: string; instruction: string }
  | { ok: false; message: string; taskId?: string };

export type LiveInputHostOutcome =
  | { kind: 'ack'; taskId: string; sessionId: string }
  | { kind: 'error'; taskId?: string; message: string };

/**
 * Strip control characters and bound length so refusal text is safe to surface
 * in the webview command-error chrome without leaking raw internals.
 */
export function sanitizeLiveInputText(text: string, max = MAX_LIVE_INPUT_ERROR_CHARS): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Validate a webview `sendLiveInput` payload. Never queues or mutates store state —
 * callers only receive a parse result or a typed engine outcome.
 */
export function parseSendLiveInputMessage(data: unknown): ParsedLiveInput {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, message: 'sendLiveInput requires an object payload' };
  }
  const record = data as Record<string, unknown>;
  if (record.type !== undefined && record.type !== 'sendLiveInput') {
    return { ok: false, message: 'sendLiveInput type mismatch' };
  }
  if (typeof record.taskId !== 'string') {
    return { ok: false, message: 'sendLiveInput requires taskId' };
  }
  const taskId = record.taskId.trim();
  if (!taskId) {
    return { ok: false, message: 'sendLiveInput requires taskId' };
  }
  if (taskId.length > MAX_LIVE_INPUT_ID_CHARS || taskId.includes('\0')) {
    return { ok: false, message: 'sendLiveInput taskId is invalid', taskId: taskId.slice(0, MAX_LIVE_INPUT_ID_CHARS) };
  }
  if (typeof record.instruction !== 'string') {
    return { ok: false, message: 'sendLiveInput requires a non-empty instruction', taskId };
  }
  // Do not trim away intentional leading/trailing spaces for delivery — but empty after trim is invalid.
  if (!record.instruction.trim()) {
    return { ok: false, message: 'sendLiveInput requires a non-empty instruction', taskId };
  }
  if (record.instruction.length > MAX_LIVE_INPUT_INSTRUCTION_CHARS) {
    return {
      ok: false,
      message: `sendLiveInput instruction exceeds ${MAX_LIVE_INPUT_INSTRUCTION_CHARS} characters`,
      taskId,
    };
  }
  if (record.instruction.includes('\0')) {
    return { ok: false, message: 'sendLiveInput instruction is invalid', taskId };
  }
  return { ok: true, taskId, instruction: record.instruction };
}

/**
 * Map a typed engine/backend LiveInputResult to a capability- or ownership-specific
 * refusal string. Delivered outcomes are not refusals.
 */
export function liveInputRefusalMessage(result: LiveInputResult): string {
  switch (result.code) {
    case 'delivered':
      return '';
    case 'unsupported':
      return sanitizeLiveInputText(`Live input unsupported: ${result.reason}`);
    case 'no-active-turn':
      return sanitizeLiveInputText(`No active turn for live input: ${result.reason}`);
    case 'not-local-owner':
      return sanitizeLiveInputText(`Live input refused: not the local owner (${result.reason})`);
    case 'cancelled':
      return sanitizeLiveInputText(`Live input cancelled: ${result.reason}`);
    case 'rejected':
      return sanitizeLiveInputText(`Live input rejected: ${result.reason}`);
    default: {
      const _exhaustive: never = result;
      return sanitizeLiveInputText(`Live input failed: ${String(_exhaustive)}`);
    }
  }
}

export interface LiveInputRouteDeps {
  engineReady: boolean;
  /**
   * Engine entrypoint. Tests assert this is called at most once and only after
   * payload validation succeeds — never continueTask / queue creation.
   */
  sendLiveInput: (taskId: string, instruction: string) => Promise<LiveInputResult>;
}

/**
 * Host routing for live-input: validate, delegate once to the engine, and return
 * either a success ack or a sanitized command-error payload. Never falls through
 * to continueTask or any queue mutation path.
 */
export async function routeSendLiveInput(
  data: unknown,
  deps: LiveInputRouteDeps,
): Promise<LiveInputHostOutcome> {
  if (!deps.engineReady) {
    return { kind: 'error', message: 'task engine not ready' };
  }
  const parsed = parseSendLiveInputMessage(data);
  if (!parsed.ok) {
    return { kind: 'error', taskId: parsed.taskId, message: parsed.message };
  }
  const result = await deps.sendLiveInput(parsed.taskId, parsed.instruction);
  if (result.code === 'delivered') {
    return { kind: 'ack', taskId: parsed.taskId, sessionId: result.sessionId };
  }
  return {
    kind: 'error',
    taskId: parsed.taskId,
    message: liveInputRefusalMessage(result),
  };
}
