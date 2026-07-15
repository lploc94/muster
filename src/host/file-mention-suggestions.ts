/**
 * Host-owned file mention suggestions (M011 S01–S02).
 *
 * The webview never supplies a cwd or absolute path. The host derives the
 * authoritative working directory from task/draft context, ascends at most two
 * parent levels, optionally refines into a relative directory under that scope,
 * lists one directory non-recursively, and returns only relative suggestion
 * items. Failures use bounded error codes — never raw filesystem messages or
 * absolute paths.
 */

import * as path from 'path';

export const FILE_MENTION_SUGGESTION_MAX_ITEMS = 50;
export const FILE_MENTION_SUGGESTION_MAX_QUERY_CHARS = 256;
export const FILE_MENTION_SUGGESTION_MAX_REQUEST_ID_CHARS = 128;
export const FILE_MENTION_SUGGESTION_MAX_TASK_ID_CHARS = 128;
export const FILE_MENTION_SUGGESTION_MAX_NAME_CHARS = 255;

/** Hidden / build / dependency directories never suggested (case-sensitive names). */
const BLOCKED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.turbo',
  '.next',
  '.nuxt',
  '.output',
  '.vercel',
  '.yarn',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'tmp',
  'temp',
  '__pycache__',
  'vendor',
]);

export type FileMentionSuggestionKind = 'file' | 'directory';
export type FileMentionParentDepth = 0 | 1 | 2;

export interface FileMentionSuggestionItem {
  /** Stable identity for list rendering (kind + relative insertion path). */
  id: string;
  kind: FileMentionSuggestionKind;
  /** User-visible label (basename / entry name). */
  label: string;
  /** Relative path inserted into the composer mention (never absolute). */
  insertionPath: string;
}

export interface FileMentionSuggestionsRequest {
  requestId: string;
  /** When set, host resolves cwd from that task; when absent, draft/workspace cwd. */
  taskId?: string;
  /** Bounded ascent from authoritative cwd: 0 current, 1 parent, 2 grandparent. */
  parentDepth: FileMentionParentDepth | number;
  /** Relative path query after parent prefix (no leading '@'). */
  relativeQuery: string;
}

export type FileMentionSuggestionsErrorCode =
  | 'invalidRequest'
  | 'unavailable'
  | 'listingFailed';

export type FileMentionSuggestionsResult =
  | {
      ok: true;
      requestId: string;
      parentDepth: FileMentionParentDepth;
      relativeQuery: string;
      items: FileMentionSuggestionItem[];
    }
  | {
      ok: false;
      requestId: string;
      code: FileMentionSuggestionsErrorCode;
    };

export interface FileMentionDirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileMentionSuggestionServices {
  /**
   * Resolve the authoritative cwd for the optional task id.
   * Must never trust a webview-supplied path.
   */
  resolveCwd(scope: { taskId?: string }): string | undefined;
  /** List one directory non-recursively. */
  readDirectory(dirPath: string): Promise<readonly FileMentionDirEntry[]>;
  /**
   * Optional: detect directory symlinks when refining into nested paths so the
   * host never follows a symlink that escapes the selected scope. Defaults to
   * false when omitted (unit tests without symlink awareness).
   */
  isDirectorySymlink?(dirPath: string): Promise<boolean>;
}

function fail(
  requestId: string,
  code: FileMentionSuggestionsErrorCode,
): FileMentionSuggestionsResult {
  return { ok: false, requestId, code };
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isParentDepth(value: unknown): value is FileMentionParentDepth {
  return value === 0 || value === 1 || value === 2;
}

/**
 * Safe relative refinement under a parentDepth scope.
 * Mirrors the webview parser remainder: no absolute/drive/UNC, no `.`/`..`
 * segments, no control characters, length-capped.
 */
export function isSafeScopedRelativeQuery(query: string): boolean {
  if (typeof query !== 'string') return false;
  if (query.length > FILE_MENTION_SUGGESTION_MAX_QUERY_CHARS) return false;
  if (hasControlChars(query)) return false;
  if (query.length === 0) return true;

  if (query.startsWith('/') || query.startsWith('\\')) return false;
  if (query.startsWith('//') || query.startsWith('\\\\')) return false;
  if (/^[A-Za-z]:/.test(query)) return false;

  // Trailing slash is valid directory refinement (`src/`); strip before segment checks.
  const normalized = query.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.length === 0) return false;
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
  }
  return true;
}

/** @deprecated Prefer isSafeScopedRelativeQuery — kept for S01 call-site compatibility. */
export function isSafeCurrentDirectoryRelativeQuery(query: string): boolean {
  return isSafeScopedRelativeQuery(query);
}

function isSafeEntryName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.length > FILE_MENTION_SUGGESTION_MAX_NAME_CHARS) return false;
  if (name === '.' || name === '..') return false;
  if (hasControlChars(name)) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return true;
}

function isBlockedDirectoryName(name: string): boolean {
  if (name.startsWith('.')) return true;
  return BLOCKED_DIRECTORY_NAMES.has(name);
}

function isBlockedFileName(name: string): boolean {
  return name.startsWith('.');
}

function normalizeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > FILE_MENTION_SUGGESTION_MAX_REQUEST_ID_CHARS) return undefined;
  if (hasControlChars(trimmed)) return undefined;
  return trimmed;
}

function normalizeTaskId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > FILE_MENTION_SUGGESTION_MAX_TASK_ID_CHARS) return undefined;
  if (hasControlChars(trimmed)) return undefined;
  return trimmed;
}

function parentPrefix(depth: FileMentionParentDepth): string {
  if (depth === 0) return '';
  if (depth === 1) return '../';
  return '../../';
}

/**
 * Split a scoped relative query into the directory to list and the basename
 * prefix filter. Trailing slash means list that directory with empty filter.
 */
function splitDirectoryAndFilter(relativeQuery: string): {
  directorySegments: string[];
  filterPrefix: string;
} {
  const normalized = relativeQuery.replace(/\\/g, '/');
  if (normalized.length === 0) {
    return { directorySegments: [], filterPrefix: '' };
  }

  const endsWithSlash = normalized.endsWith('/');
  const parts = normalized.split('/').filter((segment) => segment.length > 0);
  if (parts.length === 0) {
    return { directorySegments: [], filterPrefix: '' };
  }

  if (endsWithSlash) {
    return { directorySegments: parts, filterPrefix: '' };
  }
  if (parts.length === 1) {
    return { directorySegments: [], filterPrefix: parts[0]!.toLowerCase() };
  }
  return {
    directorySegments: parts.slice(0, -1),
    filterPrefix: parts[parts.length - 1]!.toLowerCase(),
  };
}

function joinRelative(prefix: string, segments: string[], name: string): string {
  const body = [...segments, name].join('/');
  if (!prefix) return body;
  return `${prefix}${body}`;
}

/**
 * List bounded suggestions for an active @ query at parentDepth 0–2.
 * Never returns absolute paths, raw filesystem errors, or cwd.
 */
export async function listFileMentionSuggestions(
  rawRequest: FileMentionSuggestionsRequest,
  services: FileMentionSuggestionServices,
): Promise<FileMentionSuggestionsResult> {
  const requestId = normalizeRequestId(rawRequest?.requestId) ?? '';
  if (!requestId) {
    return fail('', 'invalidRequest');
  }

  if (!isParentDepth(rawRequest.parentDepth)) {
    return fail(requestId, 'invalidRequest');
  }
  const parentDepth = rawRequest.parentDepth;

  const relativeQuery =
    typeof rawRequest.relativeQuery === 'string' ? rawRequest.relativeQuery : '';
  if (!isSafeScopedRelativeQuery(relativeQuery)) {
    return fail(requestId, 'invalidRequest');
  }

  const taskId = normalizeTaskId(rawRequest.taskId);
  if (rawRequest.taskId !== undefined && taskId === undefined) {
    return fail(requestId, 'invalidRequest');
  }

  let cwd: string | undefined;
  try {
    cwd = services.resolveCwd(taskId !== undefined ? { taskId } : {});
  } catch {
    return fail(requestId, 'unavailable');
  }

  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    return fail(requestId, 'unavailable');
  }

  // Normalize the authoritative cwd and ascend parentDepth levels.
  // Prefer path.normalize/join over path.resolve so Windows tests that supply
  // root-relative fixtures are not rewritten with a drive letter.
  let scopeRoot = path.normalize(cwd);
  for (let i = 0; i < parentDepth; i += 1) {
    scopeRoot = path.normalize(path.join(scopeRoot, '..'));
  }

  const { directorySegments, filterPrefix } = splitDirectoryAndFilter(relativeQuery);

  // Walk directory segments under scopeRoot without following directory symlinks.
  let listDir = scopeRoot;
  for (const segment of directorySegments) {
    listDir = path.join(listDir, segment);
    if (typeof services.isDirectorySymlink === 'function') {
      try {
        if (await services.isDirectorySymlink(listDir)) {
          return fail(requestId, 'listingFailed');
        }
      } catch {
        return fail(requestId, 'listingFailed');
      }
    }
  }

  let entries: readonly FileMentionDirEntry[];
  try {
    entries = await services.readDirectory(listDir);
  } catch {
    return fail(requestId, 'listingFailed');
  }

  const prefix = parentPrefix(parentDepth);
  const directories: FileMentionSuggestionItem[] = [];
  const files: FileMentionSuggestionItem[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue;
    if (!isSafeEntryName(entry.name)) continue;

    const isDir = typeof entry.isDirectory === 'function' && entry.isDirectory();
    const isFile = typeof entry.isFile === 'function' && entry.isFile();
    if (isDir === isFile) continue;

    if (isDir) {
      if (isBlockedDirectoryName(entry.name)) continue;
    } else if (isBlockedFileName(entry.name)) {
      continue;
    }

    const label = entry.name;
    if (filterPrefix.length > 0 && !label.toLowerCase().startsWith(filterPrefix)) {
      continue;
    }

    const kind: FileMentionSuggestionKind = isDir ? 'directory' : 'file';
    const insertionPath = joinRelative(prefix, directorySegments, label);
    const item: FileMentionSuggestionItem = {
      id: `${kind === 'directory' ? 'dir' : 'file'}:${insertionPath}`,
      kind,
      label,
      insertionPath,
    };
    if (kind === 'directory') directories.push(item);
    else files.push(item);
  }

  const byLabel = (a: FileMentionSuggestionItem, b: FileMentionSuggestionItem) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  directories.sort(byLabel);
  files.sort(byLabel);

  const items = [...directories, ...files].slice(0, FILE_MENTION_SUGGESTION_MAX_ITEMS);

  return {
    ok: true,
    requestId,
    parentDepth,
    relativeQuery,
    items,
  };
}
