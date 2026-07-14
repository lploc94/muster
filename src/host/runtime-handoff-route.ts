import { MAX_TASK_MARKDOWN_EXPORT_ID_CHARS } from './task-markdown-export';
import { sanitizeHandoffFailureMessage } from '../task/store';

/** Cap for sanitized refusal text posted to the webview (no raw stack dumps). */
export const MAX_RUNTIME_HANDOFF_ERROR_CHARS = 400;

/** Max length for backend/model labels on inbound switch requests. */
export const MAX_RUNTIME_HANDOFF_LABEL_CHARS = 128;

export type RuntimeHandoffParseErrorCode = 'invalid_request';

export type ParsedRequestRuntimeHandoff =
  | {
      ok: true;
      taskId: string;
      targetBackend: string;
      targetModel?: string;
      skipSummary: boolean;
    }
  | {
      ok: false;
      code: RuntimeHandoffParseErrorCode;
      message: string;
      taskId?: string;
    };

/** Minimal task binding used for same-binding refusal (no session ids). */
export interface RuntimeHandoffTaskBinding {
  backend: string;
  model?: string;
}

export type RuntimeHandoffEngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface RuntimeHandoffRequestValue {
  operationId: string;
  phase: string;
}

export interface RuntimeHandoffCompleteValue {
  operationId: string;
  phase: string;
  boundBackend: string;
  /** Engine may return this; the route never forwards it to the webview. */
  boundSessionId?: string;
}

export interface RuntimeHandoffRouteDeps {
  /** Read-only task binding lookup. Must not mutate store state. */
  getTask: (taskId: string) => RuntimeHandoffTaskBinding | undefined;
  requestRuntimeHandoff: (params: {
    taskId: string;
    targetBackend: string;
    targetModel?: string;
    skipSummary?: boolean;
  }) => Promise<RuntimeHandoffEngineResult<RuntimeHandoffRequestValue>>;
  completeRuntimeHandoff: (params: {
    taskId: string;
    operationId?: string;
  }) => Promise<RuntimeHandoffEngineResult<RuntimeHandoffCompleteValue>>;
  /**
   * Optional hook after requestRuntimeHandoff commits preparing_receiver so the
   * host can project intermediate handoffProgress before receiver transfer.
   */
  afterRequestCommitted?: (taskId: string) => void | Promise<void>;
}

export type RuntimeHandoffHostMessage = {
  type: 'commandError';
  taskId?: string;
  message: string;
};

export type RuntimeHandoffHostOutcome =
  | {
      kind: 'completed';
      taskId: string;
      operationId: string;
      boundBackend: string;
      refreshSnapshot: true;
      messages: RuntimeHandoffHostMessage[];
    }
  | {
      kind: 'failed';
      taskId: string;
      operationId?: string;
      refreshSnapshot: true;
      messages: RuntimeHandoffHostMessage[];
    }
  | {
      kind: 'refused';
      taskId?: string;
      refreshSnapshot: false;
      messages: RuntimeHandoffHostMessage[];
    };

/**
 * Sanitize engine/host refusal text for commandError. Strips stack frames,
 * absolute paths, and token-like secrets so refusals never leak host internals.
 * Also re-runs sanitizeHandoffFailureMessage for shared handoff redaction rules.
 */
export function sanitizeRuntimeHandoffErrorText(
  text: string,
  max = MAX_RUNTIME_HANDOFF_ERROR_CHARS,
): string {
  // Layer 1: shared handoff failure redaction (tokens, long dumps, known shapes).
  const layered = sanitizeHandoffFailureMessage(
    typeof text === 'string' ? text : String(text ?? ''),
  );
  // Layer 2: export-route-style path/stack scrubbing for raw engine reasons.
  const cleaned = layered
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+at\s+[\w.$<>]+\s*\([^)]*\)/g, '')
    .replace(/\s+at\s+[\w.$<>]+/g, '')
    // Windows absolute paths and POSIX absolute fragments.
    .replace(/\b[A-Za-z]:\\[^\s'"]+/g, '[path]')
    .replace(/\/(?:Users|home|var|tmp|etc|abs|private|opt)[^\s'"]*/gi, '[path]')
    .replace(/\/[^\s'"]+\.(?:ts|js|mjs|cjs|tsx|jsx)\b[^\s'"]*/gi, '[path]')
    .replace(
      /\b(?:sk|pk|api[_-]?key|token|secret|key)[-_][A-Za-z0-9][-_A-Za-z0-9]{4,}\b/gi,
      '[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) {
    return 'Runtime handoff failed.';
  }
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

function commandErrorMessage(
  taskId: string | undefined,
  message: string,
): RuntimeHandoffHostMessage {
  const sanitized = sanitizeRuntimeHandoffErrorText(message);
  return taskId
    ? { type: 'commandError', taskId, message: sanitized }
    : { type: 'commandError', message: sanitized };
}

function refused(
  message: string,
  taskId?: string,
): RuntimeHandoffHostOutcome {
  return {
    kind: 'refused',
    ...(taskId ? { taskId } : {}),
    refreshSnapshot: false,
    messages: [commandErrorMessage(taskId, message)],
  };
}

function isSafeLabel(value: string, max: number): boolean {
  if (!value || value.length > max) return false;
  if (value.includes('\0')) return false;
  // Reject control characters and path-like fragments.
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) return false;
  return true;
}

/**
 * Validate a webview `requestRuntimeHandoff` payload. Never mutates store state.
 */
export function parseRequestRuntimeHandoffMessage(
  data: unknown,
): ParsedRequestRuntimeHandoff {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'requestRuntimeHandoff requires an object payload',
    };
  }
  const record = data as Record<string, unknown>;
  if (record.type !== undefined && record.type !== 'requestRuntimeHandoff') {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'requestRuntimeHandoff type mismatch',
    };
  }
  if (typeof record.taskId !== 'string') {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'requestRuntimeHandoff requires taskId',
    };
  }
  const taskId = record.taskId.trim();
  if (!taskId) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'requestRuntimeHandoff requires taskId',
    };
  }
  if (
    taskId.length > MAX_TASK_MARKDOWN_EXPORT_ID_CHARS ||
    taskId.includes('\0')
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'requestRuntimeHandoff taskId is invalid',
      taskId: taskId.slice(0, MAX_TASK_MARKDOWN_EXPORT_ID_CHARS),
    };
  }

  if (typeof record.targetBackend !== 'string') {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'requestRuntimeHandoff requires targetBackend',
      taskId,
    };
  }
  const targetBackend = record.targetBackend.trim();
  if (!isSafeLabel(targetBackend, MAX_RUNTIME_HANDOFF_LABEL_CHARS)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'requestRuntimeHandoff targetBackend is invalid',
      taskId,
    };
  }

  let targetModel: string | undefined;
  if (record.targetModel !== undefined && record.targetModel !== null) {
    if (typeof record.targetModel !== 'string') {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'requestRuntimeHandoff targetModel is invalid',
        taskId,
      };
    }
    const trimmedModel = record.targetModel.trim();
    if (trimmedModel.length === 0) {
      targetModel = undefined;
    } else if (!isSafeLabel(trimmedModel, MAX_RUNTIME_HANDOFF_LABEL_CHARS)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'requestRuntimeHandoff targetModel is invalid',
        taskId,
      };
    } else {
      targetModel = trimmedModel;
    }
  }

  // Default skipSummary true so the host does not force a hidden summary turn
  // unless the webview explicitly requests one.
  let skipSummary = true;
  if (record.skipSummary !== undefined) {
    if (typeof record.skipSummary !== 'boolean') {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'requestRuntimeHandoff skipSummary is invalid',
        taskId,
      };
    }
    skipSummary = record.skipSummary;
  }

  return {
    ok: true,
    taskId,
    targetBackend,
    ...(targetModel !== undefined ? { targetModel } : {}),
    skipSummary,
  };
}

function sameBinding(
  current: RuntimeHandoffTaskBinding,
  targetBackend: string,
  targetModel: string | undefined,
): boolean {
  if (current.backend !== targetBackend) {
    return false;
  }
  const currentModel = current.model ?? undefined;
  const nextModel = targetModel ?? undefined;
  return currentModel === nextModel;
}

/**
 * Host routing for requestRuntimeHandoff:
 * 1. Validate the inbound switch request.
 * 2. Refuse missing task / same binding without calling engine APIs.
 * 3. requestRuntimeHandoff → preparing_receiver (binding hold).
 * 4. Optionally project intermediate handoffProgress via afterRequestCommitted.
 * 5. completeRuntimeHandoff → atomic rebind (or failed handoff with source hold).
 * 6. Surface sanitized commandError on refusal/failure; never return session ids.
 */
export async function routeRuntimeHandoff(
  data: unknown,
  deps: RuntimeHandoffRouteDeps,
): Promise<RuntimeHandoffHostOutcome> {
  const parsed = parseRequestRuntimeHandoffMessage(data);
  if (!parsed.ok) {
    return refused(
      parsed.message || 'Runtime handoff request is invalid.',
      parsed.taskId,
    );
  }

  if (
    !deps ||
    typeof deps !== 'object' ||
    typeof deps.getTask !== 'function' ||
    typeof deps.requestRuntimeHandoff !== 'function' ||
    typeof deps.completeRuntimeHandoff !== 'function'
  ) {
    return refused('Runtime handoff is unavailable.', parsed.taskId);
  }

  let current: RuntimeHandoffTaskBinding | undefined;
  try {
    current = deps.getTask(parsed.taskId);
  } catch {
    return refused('Unable to read task for runtime handoff.', parsed.taskId);
  }

  if (!current) {
    return refused('Task not found for runtime handoff.', parsed.taskId);
  }

  if (sameBinding(current, parsed.targetBackend, parsed.targetModel)) {
    return refused(
      'Target backend/model is already bound; switch is unchanged.',
      parsed.taskId,
    );
  }

  let requested: RuntimeHandoffEngineResult<RuntimeHandoffRequestValue>;
  try {
    requested = await deps.requestRuntimeHandoff({
      taskId: parsed.taskId,
      targetBackend: parsed.targetBackend,
      ...(parsed.targetModel !== undefined
        ? { targetModel: parsed.targetModel }
        : {}),
      skipSummary: parsed.skipSummary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused(
      `Runtime handoff request failed: ${message}`,
      parsed.taskId,
    );
  }

  if (!requested.ok) {
    // Request refusal leaves source binding untouched and never calls complete.
    return refused(requested.reason, parsed.taskId);
  }

  // Intermediate projection: preparing_receiver is now durable on the task.
  if (typeof deps.afterRequestCommitted === 'function') {
    try {
      await deps.afterRequestCommitted(parsed.taskId);
    } catch {
      // Projection refresh is best-effort; transfer still proceeds.
    }
  }

  let completed: RuntimeHandoffEngineResult<RuntimeHandoffCompleteValue>;
  try {
    completed = await deps.completeRuntimeHandoff({
      taskId: parsed.taskId,
      operationId: requested.value.operationId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'failed',
      taskId: parsed.taskId,
      operationId: requested.value.operationId,
      refreshSnapshot: true,
      messages: [
        commandErrorMessage(
          parsed.taskId,
          `Runtime handoff transfer failed: ${message}`,
        ),
      ],
    };
  }

  if (!completed.ok) {
    // completeRuntimeHandoff records handoff.fail without rebinding source.
    // Refresh so webview can show failed handoffProgress + prior binding.
    return {
      kind: 'failed',
      taskId: parsed.taskId,
      operationId: requested.value.operationId,
      refreshSnapshot: true,
      messages: [commandErrorMessage(parsed.taskId, completed.reason)],
    };
  }

  // Success — never include boundSessionId or diagnostics bodies.
  return {
    kind: 'completed',
    taskId: parsed.taskId,
    operationId: completed.value.operationId,
    boundBackend: completed.value.boundBackend,
    refreshSnapshot: true,
    messages: [],
  };
}
