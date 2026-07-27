/**
 * Browser-safe contract for bounded ACP file-change evidence.
 * Keep this module free of Node-only imports so both the extension host and
 * webview protocol guard can enforce the same limits.
 */

export const TOOL_FILE_CHANGES_MAX_FILES = 32;
export const TOOL_FILE_CHANGE_PATH_MAX_BYTES = 1_024;
export const TOOL_FILE_CHANGE_SIDE_MAX_BYTES = 131_072;
export const TOOL_FILE_CHANGE_SIDE_MAX_LINES = 2_000;
export const TOOL_FILE_CHANGES_TOTAL_MAX_BYTES = 524_288;

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const WINDOWS_ABSOLUTE_OR_DRIVE = /^(?:[A-Za-z]:|\\\\|\/\/|\\\\[?.]\\)/u;

/** UTF-8 byte length without Buffer so the same code runs in the webview. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Logical display lines; a final newline does not invent an extra empty line. */
export function logicalLineCount(value: string): number {
  if (value === '') return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  if (value.charCodeAt(value.length - 1) === 10) lines -= 1;
  return lines;
}

/** Strict post-canonicalization path contract for data crossing into the webview. */
export function isSafeRelativeToolPath(value: string): boolean {
  if (value.length === 0 || CONTROL_OR_BIDI.test(value)) return false;
  if (value.startsWith('/') || WINDOWS_ABSOLUTE_OR_DRIVE.test(value) || value.includes('\\')) {
    return false;
  }
  if (utf8ByteLength(value) > TOOL_FILE_CHANGE_PATH_MAX_BYTES) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export interface ToolFileChangeEvidenceShape {
  path: string;
  oldText: string | null;
  newText: string;
  truncated?: boolean;
}

export function toolFileChangeRetainedBytes(change: ToolFileChangeEvidenceShape): number {
  return (
    utf8ByteLength(change.path) +
    (change.oldText === null ? 0 : utf8ByteLength(change.oldText)) +
    utf8ByteLength(change.newText)
  );
}

export function isBoundedToolFileChange(change: unknown): change is ToolFileChangeEvidenceShape {
  if (typeof change !== 'object' || change === null || Array.isArray(change)) return false;
  const value = change as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => !['path', 'oldText', 'newText', 'truncated'].includes(key))) return false;
  if (typeof value.path !== 'string' || !isSafeRelativeToolPath(value.path)) return false;
  if (!(value.oldText === null || typeof value.oldText === 'string')) return false;
  if (typeof value.newText !== 'string') return false;
  if (value.truncated !== undefined && value.truncated !== true) return false;
  for (const side of [value.oldText, value.newText]) {
    if (typeof side !== 'string') continue;
    if (utf8ByteLength(side) > TOOL_FILE_CHANGE_SIDE_MAX_BYTES) return false;
    if (logicalLineCount(side) > TOOL_FILE_CHANGE_SIDE_MAX_LINES) return false;
  }
  return true;
}

export function isBoundedToolFileChanges(value: unknown): value is ToolFileChangeEvidenceShape[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TOOL_FILE_CHANGES_MAX_FILES) {
    return false;
  }
  let totalBytes = 0;
  for (const change of value) {
    if (!isBoundedToolFileChange(change)) return false;
    totalBytes += toolFileChangeRetainedBytes(change);
    if (totalBytes > TOOL_FILE_CHANGES_TOTAL_MAX_BYTES) return false;
  }
  return true;
}
