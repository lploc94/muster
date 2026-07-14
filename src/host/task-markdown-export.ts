import type { MusterTask, TaskStoreFile } from '../task/types';
import { buildTranscript } from './snapshot';

/** Version marker embedded at the top of every exported document. */
export const TASK_MARKDOWN_EXPORT_FORMAT = 'muster-task-export/v1';

/**
 * Default atomic render bound for export Markdown. Exceeding the bound returns
 * `render_bound` with no partial document (fail-closed).
 */
export const DEFAULT_TASK_MARKDOWN_EXPORT_MAX_CHARS = 1_000_000;

/** Reject oversized inbound task identifiers (defense-in-depth at host boundary). */
export const MAX_TASK_MARKDOWN_EXPORT_ID_CHARS = 256;

/** Platform-safe basename length budget, excluding the `.md` suffix. */
const MAX_FILENAME_STEM_CHARS = 80;

const FALLBACK_FILENAME = 'task-export.md';

export type TaskMarkdownExportErrorCode =
  | 'invalid_request'
  | 'task_not_found'
  | 'render_bound';

export interface TaskMarkdownExportOptions {
  /**
   * Deterministic export timestamp (ISO-8601). Required so the pure projector
   * never reads the system clock.
   */
  exportedAt: string;
  /**
   * Optional max Markdown character budget. When exceeded, the projector returns
   * `render_bound` without a partial document.
   */
  maxChars?: number;
}

export type TaskMarkdownExportResult =
  | {
      ok: true;
      markdown: string;
      suggestedFilename: string;
      sourceRevision: number;
      exportedAt: string;
      taskId: string;
    }
  | {
      ok: false;
      code: TaskMarkdownExportErrorCode;
    };

function isIsoTimestamp(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return false;
  }
  // Prefer exact round-trip of the provided string when possible (Z timestamps).
  try {
    return new Date(ms).toISOString() === value || !Number.isNaN(Date.parse(value));
  } catch {
    return false;
  }
}

function isValidTaskId(taskId: unknown): taskId is string {
  if (typeof taskId !== 'string') {
    return false;
  }
  const trimmed = taskId.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > MAX_TASK_MARKDOWN_EXPORT_ID_CHARS) {
    return false;
  }
  if (trimmed.includes('\0')) {
    return false;
  }
  // Reject whitespace-only after trim already handled; keep original id identity
  // but refuse ids that only differ by surrounding whitespace from empty.
  return taskId === trimmed;
}

/**
 * Build a platform-safe `.md` suggested filename from a task goal.
 * ASCII slug only; falls back to a deterministic default when nothing safe remains.
 */
export function suggestTaskMarkdownFilename(goal: string): string {
  const raw = typeof goal === 'string' ? goal : '';
  // Normalize separators and strip control / reserved path characters.
  const normalized = raw
    .replace(/\\/g, '/')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, ' ')
    .trim()
    .toLowerCase();

  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FILENAME_STEM_CHARS)
    .replace(/-+$/g, '');

  if (!slug) {
    return FALLBACK_FILENAME;
  }
  return `${slug}.md`;
}

function formatMetadataLine(label: string, value: string): string {
  return `- **${label}:** ${value}`;
}

function renderTaskMetadata(task: MusterTask, sourceRevision: number, exportedAt: string): string {
  const lines: string[] = [
    formatMetadataLine('Task ID', task.id),
    formatMetadataLine('Goal', task.goal),
    formatMetadataLine('Status', task.lifecycle),
    formatMetadataLine('Backend', task.backend),
  ];
  if (typeof task.model === 'string' && task.model.trim()) {
    lines.push(formatMetadataLine('Model', task.model));
  }
  lines.push(formatMetadataLine('Source revision', String(sourceRevision)));
  lines.push(formatMetadataLine('Exported at', exportedAt));
  return lines.join('\n');
}

function renderConversation(file: TaskStoreFile, taskId: string): string {
  const items = buildTranscript(file, taskId);
  const blocks: string[] = [];

  for (const item of items) {
    // Allowlist: only committed-visible user/assistant display content.
    // Intentionally omit tool and reasoning even though buildTranscript includes them.
    if (item.kind !== 'user' && item.kind !== 'assistant') {
      continue;
    }
    const heading = item.kind === 'user' ? '### User' : '### Assistant';
    // Preserve content verbatim (including retention markers). Do not interpret Markdown.
    blocks.push(`${heading}\n\n${item.content}`);
  }

  if (blocks.length === 0) {
    return '';
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Pure, side-effect-free projector: one TaskStoreFile snapshot + task id →
 * bounded Markdown document metadata, or a stable typed error code.
 *
 * Does not mutate `file`, open dialogs, write files, or read the system clock.
 */
export function renderTaskMarkdownExport(
  file: TaskStoreFile,
  taskId: string,
  options: TaskMarkdownExportOptions,
): TaskMarkdownExportResult {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false, code: 'invalid_request' };
  }
  if (typeof options.exportedAt !== 'string' || !isIsoTimestamp(options.exportedAt)) {
    return { ok: false, code: 'invalid_request' };
  }
  if (!isValidTaskId(taskId)) {
    return { ok: false, code: 'invalid_request' };
  }

  const task = file?.tasks?.[taskId];
  if (!task) {
    return { ok: false, code: 'task_not_found' };
  }

  const maxChars =
    typeof options.maxChars === 'number' && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : DEFAULT_TASK_MARKDOWN_EXPORT_MAX_CHARS;

  const conversation = renderConversation(file, taskId);
  const metadata = renderTaskMetadata(task, file.revision, options.exportedAt);
  const suggestedFilename = suggestTaskMarkdownFilename(task.goal);

  const parts = [
    `<!-- ${TASK_MARKDOWN_EXPORT_FORMAT} -->`,
    '',
    '# Muster task export',
    '',
    'This is a point-in-time export of one Muster task\'s committed visible conversation. It is not a backup or restore format.',
    '',
    '## Task',
    '',
    metadata,
    '',
    '## Conversation',
    '',
  ];

  if (conversation) {
    parts.push(conversation.trimEnd(), '');
  }

  const markdown = parts.join('\n');

  if (markdown.length > maxChars) {
    // Atomic fail-closed bound — never return a partial document.
    return { ok: false, code: 'render_bound' };
  }

  return {
    ok: true,
    markdown,
    suggestedFilename,
    sourceRevision: file.revision,
    exportedAt: options.exportedAt,
    taskId,
  };
}
