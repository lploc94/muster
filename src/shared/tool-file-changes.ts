/**
 * Shared producer-side canonicalization and bounding for untrusted ACP
 * file-change evidence. Every sink (SQLite, host projection, live webview event)
 * receives only the representation returned here.
 */

import path from 'node:path';
import {
  TOOL_FILE_CHANGE_PATH_MAX_BYTES,
  TOOL_FILE_CHANGE_SIDE_MAX_BYTES,
  TOOL_FILE_CHANGE_SIDE_MAX_LINES,
  TOOL_FILE_CHANGES_MAX_FILES,
  TOOL_FILE_CHANGES_TOTAL_MAX_BYTES,
  isSafeRelativeToolPath,
  logicalLineCount,
  toolFileChangeRetainedBytes,
  utf8ByteLength,
} from './tool-file-change-contract';

export { TOOL_FILE_CHANGES_MAX_FILES } from './tool-file-change-contract';

/** Backward-compatible name used by existing tests/docs; the bound is now UTF-8 bytes. */
export const TOOL_FILE_CHANGE_TEXT_MAX = TOOL_FILE_CHANGE_SIDE_MAX_BYTES;
/** Deprecated: truncation is metadata-only and never injected into file text. */
export const TOOL_FILE_CHANGE_TRUNCATION_SUFFIX = '';

export interface BoundedToolFileChange {
  path: string;
  oldText: string | null;
  newText: string;
  /** Present only when either side was clipped by a byte or line bound. */
  truncated?: boolean;
  /**
   * Present only when the original agent path resolved outside the trusted
   * workspace. Always `true` when set — never `false`.
   */
  outsideWorkspace?: true;
}

/** Path classification after sanitization; empty path means rejected. */
export interface ClassifiedToolFileChangePath {
  path: string;
  outsideWorkspace?: true;
}

export interface BoundToolFileChangesResult {
  fileChanges?: BoundedToolFileChange[];
  /** All entries omitted by unsafe path, file-count, or aggregate-byte bounds. */
  fileChangesOmitted?: number;
}

export interface BoundToolFileChangesOptions {
  /** Trusted task/workspace cwd used only to relativize contained absolute paths. */
  cwd?: string;
}

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/|\\\\[?.]\\)/u;

function isContained(
  relative: string,
  flavor: typeof path.posix | typeof path.win32,
): boolean {
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${flavor.sep}`) &&
      !flavor.isAbsolute(relative))
  );
}

function basenameForAnyFlavor(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return path.posix.basename(normalized);
}

function relativeWithinTrustedCwd(raw: string, cwd: string): string | undefined {
  const rawLooksWindows = WINDOWS_DRIVE.test(raw) || raw.startsWith('\\\\');
  const cwdLooksWindows = WINDOWS_DRIVE.test(cwd) || cwd.startsWith('\\\\');

  if (rawLooksWindows || cwdLooksWindows) {
    if (!(rawLooksWindows && cwdLooksWindows)) return undefined;
    const relative = path.win32.relative(path.win32.resolve(cwd), path.win32.resolve(raw));
    return isContained(relative, path.win32) ? relative.replace(/\\/g, '/') || '.' : undefined;
  }

  const relative = path.posix.relative(path.posix.resolve(cwd), path.posix.resolve(raw));
  return isContained(relative, path.posix) ? relative || '.' : undefined;
}

/**
 * Canonicalize and classify an agent path without leaking host layout.
 *
 * - absolute paths are relativized only when proven inside the trusted cwd;
 *   otherwise they degrade to basename and set outsideWorkspace: true;
 * - relative traversal that resolves outside cwd also degrades to basename
 *   and sets outsideWorkspace: true;
 * - Windows and POSIX flavors are handled independently of the host OS;
 * - controls, bidi overrides/isolates, blank values, and oversized paths reject
 *   with an empty path (no marker).
 */
export function classifyToolFileChangePath(
  raw: string,
  cwd?: string,
): ClassifiedToolFileChangePath {
  if (raw.length === 0 || CONTROL_OR_BIDI.test(raw)) return { path: '' };
  const cleaned = raw.trim();
  if (!cleaned) return { path: '' };

  const absolute = path.posix.isAbsolute(cleaned) || WINDOWS_ABSOLUTE.test(cleaned);
  let candidate: string;
  let outsideWorkspace = false;

  if (absolute) {
    const contained = cwd ? relativeWithinTrustedCwd(cleaned, cwd) : undefined;
    if (contained !== undefined) {
      candidate = contained;
    } else {
      candidate = basenameForAnyFlavor(cleaned);
      outsideWorkspace = true;
    }
  } else {
    const normalized = cleaned.replace(/\\/g, '/');
    if (cwd && normalized.split('/').includes('..')) {
      const resolved = path.posix.resolve(cwd.replace(/\\/g, '/'), normalized);
      const relative = path.posix.relative(cwd.replace(/\\/g, '/'), resolved);
      if (isContained(relative, path.posix)) {
        candidate = relative || '.';
      } else {
        candidate = path.posix.basename(resolved);
        outsideWorkspace = true;
      }
    } else {
      candidate = path.posix.normalize(normalized);
    }
  }

  // A file-change path equal to the workspace root is not a file identity.
  if (candidate === '.') return { path: '' };
  if (!isSafeRelativeToolPath(candidate)) return { path: '' };
  if (utf8ByteLength(candidate) > TOOL_FILE_CHANGE_PATH_MAX_BYTES) return { path: '' };
  return outsideWorkspace
    ? { path: candidate, outsideWorkspace: true }
    : { path: candidate };
}

/** Canonicalize-only wrapper; use classifyToolFileChangePath when the marker is needed. */
export function sanitizeToolFileChangePath(raw: string, cwd?: string): string {
  return classifyToolFileChangePath(raw, cwd).path;
}

function clipToLogicalLines(value: string): { text: string; truncated: boolean } {
  if (logicalLineCount(value) <= TOOL_FILE_CHANGE_SIDE_MAX_LINES) {
    return { text: value, truncated: false };
  }
  let newlineCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) continue;
    newlineCount += 1;
    if (newlineCount === TOOL_FILE_CHANGE_SIDE_MAX_LINES) {
      return { text: value.slice(0, index + 1), truncated: true };
    }
  }
  return { text: value, truncated: false };
}

function clipToUtf8Bytes(value: string): { text: string; truncated: boolean } {
  if (utf8ByteLength(value) <= TOOL_FILE_CHANGE_SIDE_MAX_BYTES) {
    return { text: value, truncated: false };
  }
  let bytes = 0;
  let text = '';
  for (const character of value) {
    const charBytes = utf8ByteLength(character);
    if (bytes + charBytes > TOOL_FILE_CHANGE_SIDE_MAX_BYTES) break;
    text += character;
    bytes += charBytes;
  }
  return { text, truncated: true };
}

function clipSide(value: string): { text: string; truncated: boolean } {
  const byLines = clipToLogicalLines(value);
  const byBytes = clipToUtf8Bytes(byLines.text);
  return { text: byBytes.text, truncated: byLines.truncated || byBytes.truncated };
}

export function boundToolFileChanges(
  changes: readonly BoundedToolFileChange[] | undefined,
  options?: BoundToolFileChangesOptions,
): BoundToolFileChangesResult {
  if (changes === undefined || changes.length === 0) return {};

  const kept: BoundedToolFileChange[] = [];
  let omitted = 0;
  let retainedBytes = 0;

  for (const entry of changes) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      !(entry.oldText === null || typeof entry.oldText === 'string') ||
      typeof entry.newText !== 'string'
    ) {
      omitted += 1;
      continue;
    }
    const classified = classifyToolFileChangePath(entry.path, options?.cwd);
    if (!classified.path) {
      omitted += 1;
      continue;
    }
    if (kept.length >= TOOL_FILE_CHANGES_MAX_FILES) {
      omitted += 1;
      continue;
    }

    let truncated = entry.truncated === true;
    let oldText: string | null = entry.oldText;
    if (oldText !== null) {
      const clipped = clipSide(oldText);
      oldText = clipped.text;
      truncated ||= clipped.truncated;
    }
    const clippedNew = clipSide(entry.newText);
    truncated ||= clippedNew.truncated;

    // Present-only marker: set by classification or preserved from prior rebound.
    const outsideWorkspace =
      classified.outsideWorkspace === true || entry.outsideWorkspace === true;

    const candidate: BoundedToolFileChange = {
      path: classified.path,
      oldText,
      newText: clippedNew.text,
      ...(truncated ? { truncated: true } : {}),
      ...(outsideWorkspace ? { outsideWorkspace: true } : {}),
    };
    const candidateBytes = toolFileChangeRetainedBytes(candidate);
    if (retainedBytes + candidateBytes > TOOL_FILE_CHANGES_TOTAL_MAX_BYTES) {
      omitted += 1;
      continue;
    }

    retainedBytes += candidateBytes;
    kept.push(candidate);
  }

  return {
    ...(kept.length > 0 ? { fileChanges: kept } : {}),
    ...(omitted > 0 ? { fileChangesOmitted: omitted } : {}),
  };
}
