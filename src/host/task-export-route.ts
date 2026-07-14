import type { TaskStoreFile } from '../task/types';
import {
  MAX_TASK_MARKDOWN_EXPORT_ID_CHARS,
  renderTaskMarkdownExport,
  type TaskMarkdownExportErrorCode,
} from './task-markdown-export';

/** Cap for sanitized refusal text posted to the webview (no raw stack dumps). */
export const MAX_TASK_EXPORT_ERROR_CHARS = 400;

/** Stable reason codes for task export host failures. */
export type TaskExportErrorCode =
  | TaskMarkdownExportErrorCode
  | 'write_failed'
  | 'dialog_failed';

/**
 * Generic user-facing messages mapped from stable reason codes.
 * Never include absolute paths, raw provider details, or stack frames.
 */
export const TASK_EXPORT_ERROR_MESSAGES: Record<TaskExportErrorCode, string> = {
  invalid_request: 'Export request is invalid.',
  task_not_found: 'Task not found for export.',
  render_bound: 'Task export is too large to render.',
  write_failed: 'Unable to write the exported Markdown file.',
  dialog_failed: 'Unable to open the save dialog.',
};

export type ParsedExportTask =
  | { ok: true; taskId: string }
  | { ok: false; code: 'invalid_request'; message: string; taskId?: string };

/** Minimal URI surface for injected VS Code Save As / write seams. */
export interface TaskExportUri {
  /** Absolute filesystem path when available (never returned to the webview). */
  fsPath?: string;
  /** URI path segment; used as basename fallback when fsPath is absent. */
  path?: string;
}

export interface TaskExportSaveDialogOptions {
  /** Suggested `.md` basename only — never a directory path. */
  defaultFileName: string;
}

export interface TaskExportRouteDeps {
  /** Read-only snapshot accessor. Must not mutate the returned file. */
  getStoreFile: () => TaskStoreFile;
  /**
   * Injected native Save As seam. Return `undefined` when the user cancels.
   * Tests inject a mock; production wires `vscode.window.showSaveDialog`.
   */
  showSaveDialog: (
    options: TaskExportSaveDialogOptions,
  ) => Promise<TaskExportUri | undefined> | Thenable<TaskExportUri | undefined>;
  /**
   * Injected UTF-8 write seam. Tests inject a mock; production wires
   * `vscode.workspace.fs.writeFile`.
   */
  writeFile: (uri: TaskExportUri, content: Uint8Array) => Promise<void> | Thenable<void>;
  /**
   * Deterministic export timestamp (ISO-8601). Required so the route never
   * reads the system clock in tests; production may pass `new Date().toISOString()`.
   */
  exportedAt: string;
  /** Optional render budget forwarded to the pure projector. */
  maxChars?: number;
}

export type TaskExportHostMessage =
  | {
      type: 'exportResult';
      taskId: string;
      /** Basename only — never an absolute path. */
      fileName: string;
      sourceRevision: number;
      exportedAt: string;
    }
  | { type: 'commandError'; taskId?: string; message: string };

export type TaskExportHostOutcome =
  | { kind: 'messages'; messages: TaskExportHostMessage[] }
  | { kind: 'cancel' };

/**
 * Strip control characters, stack-frame fragments, and absolute-path-like
 * segments so refusal text is safe to surface in the webview without leaking
 * host internals.
 */
export function sanitizeTaskExportErrorText(
  text: string,
  max = MAX_TASK_EXPORT_ERROR_CHARS,
): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const withoutFrames = cleaned
    .replace(/\s+at\s+[\w.$<>]+\s*\([^)]*\)/g, '')
    .replace(/\s+at\s+[\w.$<>]+/g, '')
    // Drop drive-letter and POSIX absolute path fragments that may appear in
    // raw Error messages (never surface absolute destinations to the webview).
    .replace(/\b[A-Za-z]:\\[^\s'"]+/g, '')
    .replace(/\/(?:Users|home|var|tmp|etc|abs)\/[^\s'"]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutFrames.length <= max) return withoutFrames;
  return `${withoutFrames.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Extract a webview-safe basename from a destination path or URI path.
 * Never returns directory segments or absolute path prefixes.
 */
export function exportFileNameBasename(pathOrName: string): string {
  const raw = typeof pathOrName === 'string' ? pathOrName : '';
  const normalized = raw.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((part) => part.length > 0);
  const base = segments.length > 0 ? segments[segments.length - 1]! : '';
  // Strip residual path separators and control characters as defense-in-depth.
  const safe = base.replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '').trim();
  return safe || 'task-export.md';
}

function basenameFromUri(uri: TaskExportUri): string {
  if (typeof uri.fsPath === 'string' && uri.fsPath.trim()) {
    return exportFileNameBasename(uri.fsPath);
  }
  if (typeof uri.path === 'string' && uri.path.trim()) {
    return exportFileNameBasename(uri.path);
  }
  return 'task-export.md';
}

function commandError(
  code: TaskExportErrorCode,
  taskId?: string,
): TaskExportHostOutcome {
  const message = TASK_EXPORT_ERROR_MESSAGES[code];
  return {
    kind: 'messages',
    messages: [
      taskId
        ? { type: 'commandError', taskId, message }
        : { type: 'commandError', message },
    ],
  };
}

/**
 * Validate a webview `exportTask` payload. Never mutates store state —
 * callers only receive a parse result.
 */
export function parseExportTaskMessage(data: unknown): ParsedExportTask {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'exportTask requires an object payload',
    };
  }
  const record = data as Record<string, unknown>;
  if (record.type !== undefined && record.type !== 'exportTask') {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'exportTask type mismatch',
    };
  }
  if (typeof record.taskId !== 'string') {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'exportTask requires taskId',
    };
  }
  const taskId = record.taskId.trim();
  if (!taskId) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'exportTask requires taskId',
    };
  }
  if (taskId.length > MAX_TASK_MARKDOWN_EXPORT_ID_CHARS || taskId.includes('\0')) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'exportTask taskId is invalid',
      taskId: taskId.slice(0, MAX_TASK_MARKDOWN_EXPORT_ID_CHARS),
    };
  }
  // Reject ids that only differed by surrounding whitespace from empty already
  // handled; keep original identity only when trim did not change content...
  // Actually we accept the trimmed id (consistent with other host routes).
  return { ok: true, taskId };
}

/**
 * Host routing for exportTask:
 * 1. Validate the inbound request.
 * 2. Project Markdown via the pure S01 projector (read-only store snapshot).
 * 3. Open native Save As through the injected dialog seam.
 * 4. Write UTF-8 bytes through the injected filesystem seam on approval.
 * 5. Return typed exportResult (basename only) or sanitized commandError.
 *
 * Cancel is intentionally silent. The store snapshot is never mutated.
 */
export async function routeExportTask(
  data: unknown,
  deps: TaskExportRouteDeps,
): Promise<TaskExportHostOutcome> {
  const parsed = parseExportTaskMessage(data);
  if (!parsed.ok) {
    // Prefer the stable generic mapping for user-visible chrome; parse detail
    // stays internal (tests assert the stable TASK_EXPORT_ERROR_MESSAGES text).
    return commandError('invalid_request', parsed.taskId);
  }

  if (
    !deps ||
    typeof deps !== 'object' ||
    typeof deps.getStoreFile !== 'function' ||
    typeof deps.showSaveDialog !== 'function' ||
    typeof deps.writeFile !== 'function' ||
    typeof deps.exportedAt !== 'string'
  ) {
    return commandError('invalid_request', parsed.taskId);
  }

  let file: TaskStoreFile;
  try {
    file = deps.getStoreFile();
  } catch {
    return commandError('invalid_request', parsed.taskId);
  }

  const rendered = renderTaskMarkdownExport(file, parsed.taskId, {
    exportedAt: deps.exportedAt,
    maxChars: deps.maxChars,
  });

  if (!rendered.ok) {
    return commandError(rendered.code, parsed.taskId);
  }

  let destination: TaskExportUri | undefined;
  try {
    destination = await deps.showSaveDialog({
      defaultFileName: rendered.suggestedFilename,
    });
  } catch {
    // Dialog seam threw — surface a generic dialog failure without raw details.
    return commandError('dialog_failed', parsed.taskId);
  }

  if (destination === undefined || destination === null) {
    // User cancelled Save As — intentional silent no-op.
    return { kind: 'cancel' };
  }

  const bytes = new TextEncoder().encode(rendered.markdown);

  try {
    await deps.writeFile(destination, bytes);
  } catch {
    // Never echo absolute paths, errno strings, or raw Error stacks.
    return commandError('write_failed', parsed.taskId);
  }

  const fileName = basenameFromUri(destination);

  return {
    kind: 'messages',
    messages: [
      {
        type: 'exportResult',
        taskId: rendered.taskId,
        fileName,
        sourceRevision: rendered.sourceRevision,
        exportedAt: rendered.exportedAt,
      },
    ],
  };
}
