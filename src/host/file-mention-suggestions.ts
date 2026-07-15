/**
 * Host-owned current-directory file mention suggestions (M011 S01).
 *
 * The webview never supplies a cwd or absolute path. The host derives the
 * authoritative working directory from task/draft context, lists one directory
 * non-recursively, and returns only relative suggestion items. Failures use
 * bounded error codes — never raw filesystem messages or absolute paths.
 */

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

export interface FileMentionSuggestionItem {
  /** Stable identity for list rendering (kind + relative name). */
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
  /** S01 always 0; host rejects other values. */
  parentDepth: 0 | 1 | 2 | number;
  /** Relative path query after '@' (no leading '@'). */
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
      parentDepth: 0;
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

/**
 * S01 safety: only plain relative path prefixes under the current directory.
 * Mirrors the webview parser so host and client reject the same shapes.
 */
export function isSafeCurrentDirectoryRelativeQuery(query: string): boolean {
  if (typeof query !== 'string') return false;
  if (query.length > FILE_MENTION_SUGGESTION_MAX_QUERY_CHARS) return false;
  if (hasControlChars(query)) return false;
  if (query.length === 0) return true;

  if (query.startsWith('/') || query.startsWith('\\')) return false;
  if (query.startsWith('//') || query.startsWith('\\\\')) return false;
  if (/^[A-Za-z]:/.test(query)) return false;

  const normalized = query.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
  }
  return true;
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
  // Hidden files (dotfiles) are out of autocomplete scope for S01.
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

/**
 * List bounded current-directory suggestions for an active @ query.
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

  if (rawRequest.parentDepth !== 0) {
    return fail(requestId, 'invalidRequest');
  }

  const relativeQuery =
    typeof rawRequest.relativeQuery === 'string' ? rawRequest.relativeQuery : '';
  if (!isSafeCurrentDirectoryRelativeQuery(relativeQuery)) {
    return fail(requestId, 'invalidRequest');
  }

  const taskId = normalizeTaskId(rawRequest.taskId);
  // Invalid non-empty taskId shape (e.g. control chars) is a request error.
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

  // S01 lists only the authoritative current directory (non-recursive).
  // relativeQuery is a basename/prefix filter, not a nested path walk.
  const queryNormalized = relativeQuery.replace(/\\/g, '/');
  // If the query contains a slash, treat the final segment as the prefix filter
  // for names in the current directory only — do not descend into subdirs.
  // Nested directory drill-down is S02. For S01, multi-segment queries still
  // filter entry names by the full relative string prefix so "src/u" matches
  // nothing until the user selects `src` in a later slice.
  const filterPrefix = queryNormalized.toLowerCase();

  let entries: readonly FileMentionDirEntry[];
  try {
    entries = await services.readDirectory(cwd);
  } catch {
    return fail(requestId, 'listingFailed');
  }

  const directories: FileMentionSuggestionItem[] = [];
  const files: FileMentionSuggestionItem[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue;
    if (!isSafeEntryName(entry.name)) continue;

    const isDir = typeof entry.isDirectory === 'function' && entry.isDirectory();
    const isFile = typeof entry.isFile === 'function' && entry.isFile();
    if (isDir === isFile) continue; // neither or both — skip

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
    const item: FileMentionSuggestionItem = {
      id: `${kind === 'directory' ? 'dir' : 'file'}:${label}`,
      kind,
      label,
      insertionPath: label,
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
    parentDepth: 0,
    relativeQuery,
    items,
  };
}
