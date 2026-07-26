/**
 * Shared bounding + path sanitization for ACP tool-call fileChanges evidence (M020).
 *
 * Pure Node-safe module: host engine and webview protocol both import the same
 * bounds so the producer and the fail-closed guard stay aligned. Does not import
 * from `src/types.ts` so the webview can consume it without pulling host types.
 *
 * Bounding signals are in-data (not logs):
 * - `truncated: true` on an entry means a per-side text bound was hit
 * - `fileChangesOmitted > 0` on the result means the file-count bound was hit
 */

import path from 'node:path';

/** Max ACP fileChanges entries retained per tool call (mirrors webview protocol). */
export const TOOL_FILE_CHANGES_MAX_FILES = 32;

/** Max path / text length for a single side of a fileChange entry (mirrors webview protocol). */
export const TOOL_FILE_CHANGE_TEXT_MAX = 262_144;

/** Honest suffix appended when a side is clipped. Length must fit inside the text max. */
export const TOOL_FILE_CHANGE_TRUNCATION_SUFFIX = '\n… truncated';

/**
 * Structural shape of a bounded file-change entry.
 * Compatible with `ToolFileChange` in `src/types.ts` once that type gains
 * optional `truncated`; kept local so this module stays dependency-free.
 */
export interface BoundedToolFileChange {
  path: string;
  oldText: string | null;
  newText: string;
  /** Present only when a side was clipped; never emitted as `false`. */
  truncated?: boolean;
}

export interface BoundToolFileChangesResult {
  fileChanges?: BoundedToolFileChange[];
  /** Count of valid entries dropped by the file-count bound; omitted when zero. */
  fileChangesOmitted?: number;
}

export interface BoundToolFileChangesOptions {
  /** Task/workspace cwd used to relativize absolute in-workspace paths. */
  cwd?: string;
}

/**
 * Relativize or degrade a model-supplied path so no absolute host path
 * (drive prefix, home directory layout) crosses the host/webview boundary.
 *
 * Semantics match `workspaceRelativePath` in `src/task/engine-handoff.ts`
 * (reimplemented here rather than imported so shared stays free of task code).
 */
export function sanitizeToolFileChangePath(raw: string, cwd?: string): string {
  // Strip NULs first so they cannot hide path separators or drive prefixes.
  const cleaned = raw.replace(/\0/g, '').trim();
  if (!cleaned) return cleaned;

  if (cwd) {
    const absCwd = path.resolve(cwd);
    const absPath = path.isAbsolute(cleaned)
      ? path.resolve(cleaned)
      : path.resolve(absCwd, cleaned);
    if (absPath === absCwd) return '.';
    if (absPath.startsWith(`${absCwd}${path.sep}`)) {
      return path.relative(absCwd, absPath).split(path.sep).join('/');
    }
  }

  // Absolute outside cwd (or absolute with no cwd): degrade to basename so
  // host home directories / drive prefixes never leak.
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned)) {
    return path.basename(cleaned);
  }

  return cleaned.replace(/\\/g, '/');
}

function clipSide(text: string): { text: string; truncated: boolean } {
  if (text.length <= TOOL_FILE_CHANGE_TEXT_MAX) {
    return { text, truncated: false };
  }
  const suffix = TOOL_FILE_CHANGE_TRUNCATION_SUFFIX;
  // Ensure the clipped result (content + suffix) stays within the bound.
  const usable = Math.max(0, TOOL_FILE_CHANGE_TEXT_MAX - suffix.length);
  return { text: text.slice(0, usable) + suffix, truncated: true };
}

/**
 * Bound and sanitize a list of tool file changes before persistence / projection.
 *
 * - `undefined` / `[]` → `{}` (absence stays byte-identical; never emits empty array)
 * - paths are sanitized; empty sanitized paths are dropped
 * - at most `TOOL_FILE_CHANGES_MAX_FILES` entries kept; remainder → `fileChangesOmitted`
 * - each `oldText`/`newText` side clipped independently; clipped entry gets `truncated: true`
 * - never mutates the input array or its entries
 */
export function boundToolFileChanges(
  changes: readonly BoundedToolFileChange[] | undefined,
  options?: BoundToolFileChangesOptions,
): BoundToolFileChangesResult {
  if (changes === undefined || changes.length === 0) {
    return {};
  }

  const cwd = options?.cwd;
  const kept: BoundedToolFileChange[] = [];
  let omitted = 0;

  for (const entry of changes) {
    const sanitizedPath = sanitizeToolFileChangePath(entry.path, cwd);
    if (!sanitizedPath) {
      // Empty after sanitize: drop without counting toward omitted.
      continue;
    }

    if (kept.length >= TOOL_FILE_CHANGES_MAX_FILES) {
      omitted += 1;
      continue;
    }

    let truncated = false;
    let oldText: string | null = entry.oldText;
    if (oldText !== null) {
      const clipped = clipSide(oldText);
      oldText = clipped.text;
      truncated = truncated || clipped.truncated;
    }
    const newClipped = clipSide(entry.newText);
    const newText = newClipped.text;
    truncated = truncated || newClipped.truncated;

    const next: BoundedToolFileChange = {
      path: sanitizedPath,
      oldText,
      newText,
    };
    if (truncated) {
      next.truncated = true;
    }
    kept.push(next);
  }

  if (kept.length === 0) {
    return {};
  }

  return {
    fileChanges: kept,
    ...(omitted > 0 ? { fileChangesOmitted: omitted } : {}),
  };
}
