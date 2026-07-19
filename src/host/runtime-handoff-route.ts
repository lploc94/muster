import { MAX_TASK_MARKDOWN_EXPORT_ID_CHARS } from './task-markdown-export';
import { sanitizeHandoffFailureMessage } from '../task/sanitization';

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
  boundBackend: string;
  boundModel?: string;
  switchedAt: string;
}

export interface RuntimeHandoffRouteDeps {
  /** Read-only task binding lookup. Must not mutate store state. */
  getTask: (taskId: string) => RuntimeHandoffTaskBinding | undefined;
  requestRuntimeHandoff: (params: {
    taskId: string;
    targetBackend: string;
    targetModel?: string;
  }) => Promise<RuntimeHandoffEngineResult<RuntimeHandoffRequestValue>>;
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

/** Non-empty string, length cap, no null/control bytes. Catalog ids may include `/`. */
function isNonEmptyLabel(value: string, max: number): boolean {
  if (!value || value.length > max) return false;
  if (value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) return false;
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
    /[\u0000-\u001f\u007f]/.test(taskId)
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'requestRuntimeHandoff taskId is invalid',
      taskId: taskId.slice(0, MAX_TASK_MARKDOWN_EXPORT_ID_CHARS),
    };
  }

  // Labels only — reject unknown keys so session ids / paths cannot ride along.
  const allowedKeys = new Set(['type', 'taskId', 'targetBackend', 'targetModel']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'requestRuntimeHandoff contains unsupported fields',
        taskId,
      };
    }
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
  // Backend is a webview picker id (claude/grok/…); engine makeBackend is the real gate.
  if (!isNonEmptyLabel(targetBackend, MAX_RUNTIME_HANDOFF_LABEL_CHARS)) {
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
    // Model ids come from the CLI catalog (may include provider/ prefixes).
    // Only reject empty, oversized, or control-byte garbage — no inventing charset rules.
    if (trimmedModel.length === 0) {
      targetModel = undefined;
    } else if (!isNonEmptyLabel(trimmedModel, MAX_RUNTIME_HANDOFF_LABEL_CHARS)) {
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

  return {
    ok: true,
    taskId,
    targetBackend,
    ...(targetModel !== undefined ? { targetModel } : {}),
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
 * 3. requestRuntimeHandoff atomically commits the new local binding + context cutoff.
 * 4. Surface sanitized commandError on refusal; never return session ids.
 */
export async function routeRuntimeHandoff(
  data: unknown,
  deps: RuntimeHandoffRouteDeps,
): Promise<RuntimeHandoffHostOutcome> {
  const parsed = parseRequestRuntimeHandoffMessage(data);
  if (!parsed.ok) {
    console.info('[muster][handoff-route] parse failed', parsed);
    return refused(
      parsed.message || 'Runtime handoff request is invalid.',
      parsed.taskId,
    );
  }
  console.info('[muster][handoff-route] parsed', parsed);

  if (
    !deps ||
    typeof deps !== 'object' ||
    typeof deps.getTask !== 'function' ||
    typeof deps.requestRuntimeHandoff !== 'function'
  ) {
    console.info('[muster][handoff-route] deps unavailable');
    return refused('Runtime handoff is unavailable.', parsed.taskId);
  }

  let current: RuntimeHandoffTaskBinding | undefined;
  try {
    current = deps.getTask(parsed.taskId);
  } catch {
    console.info('[muster][handoff-route] getTask threw');
    return refused('Unable to read task for runtime handoff.', parsed.taskId);
  }

  if (!current) {
    console.info('[muster][handoff-route] task not found', parsed.taskId);
    return refused('Task not found for runtime handoff.', parsed.taskId);
  }

  if (sameBinding(current, parsed.targetBackend, parsed.targetModel)) {
    console.info('[muster][handoff-route] same binding refused', {
      current,
      targetBackend: parsed.targetBackend,
      targetModel: parsed.targetModel,
    });
    return refused(
      'Target backend/model is already bound; switch is unchanged.',
      parsed.taskId,
    );
  }
  console.info('[muster][handoff-route] will request', {
    current,
    targetBackend: parsed.targetBackend,
    targetModel: parsed.targetModel,
  });

  let requested: RuntimeHandoffEngineResult<RuntimeHandoffRequestValue>;
  try {
    requested = await deps.requestRuntimeHandoff({
      taskId: parsed.taskId,
      targetBackend: parsed.targetBackend,
      ...(parsed.targetModel !== undefined
        ? { targetModel: parsed.targetModel }
        : {}),
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

  // Success is the atomic request commit; target session creation is deferred to
  // the next real user/queued turn and uses the ordinary MCP-enabled run path.
  return {
    kind: 'completed',
    taskId: parsed.taskId,
    operationId: requested.value.operationId,
    boundBackend: requested.value.boundBackend,
    refreshSnapshot: true,
    messages: [],
  };
}
