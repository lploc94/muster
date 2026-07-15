/**
 * Pure active file-mention query parser for composer autocomplete.
 * Detects an in-progress @query at the caret. Independent of Svelte and filesystem.
 *
 * S01 scope: parentDepth is always 0. Traversal (@../, @./, embedded ..) is rejected
 * here so S02 can extend the same contract without rewriting callers.
 */

/** Matches unquoted mention body characters (same set as file-mention-bindings / render). */
const QUERY_CHAR = /[A-Za-z0-9_./\\-]/;

/** Word char that, if immediately before @, makes it an email-like token. */
const EMAIL_PREFIX = /[A-Za-z0-9_]/;

export interface ActiveFileMentionQuery {
  /** Inclusive start index of the active token (points at '@'). */
  start: number;
  /** Exclusive end index of the replacement range (the caret). */
  end: number;
  /** Directory ascent count relative to task/draft cwd. S01 always 0. */
  parentDepth: 0;
  /** Relative path query after '@' up to the caret (no leading '@'). */
  relativeQuery: string;
}

/**
 * Parse the active file-mention query at `caret` in `text`.
 * Returns null when there is no valid in-progress unquoted @query for autocomplete.
 */
export function parseActiveFileMentionQuery(
  text: string,
  caret: number,
): ActiveFileMentionQuery | null {
  if (typeof text !== 'string') return null;
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;

  // Caret must be past the '@' trigger (index of '@' is start; caret > start).
  if (caret === 0) return null;

  // Walk left from caret over query characters to find the '@'.
  let i = caret - 1;
  while (i >= 0 && QUERY_CHAR.test(text[i]!)) {
    i -= 1;
  }

  if (i < 0 || text[i] !== '@') return null;

  const atIndex = i;
  // Caret must be strictly after '@' — sitting on '@' is not an active query yet.
  if (caret <= atIndex) return null;

  // Email-like: word character immediately before '@'.
  if (atIndex > 0 && EMAIL_PREFIX.test(text[atIndex - 1]!)) {
    return null;
  }

  // Quoted mentions (completed or incomplete) are not S01 autocomplete queries.
  if (text[atIndex + 1] === '"') {
    return null;
  }

  const relativeQuery = text.slice(atIndex + 1, caret);

  // Reject control characters (including tab/newline) anywhere in the query span.
  for (let c = 0; c < relativeQuery.length; c += 1) {
    const code = relativeQuery.charCodeAt(c);
    if (code < 0x20 || code === 0x7f) {
      return null;
    }
  }

  // Every character between '@' and caret must already be a QUERY_CHAR
  // (ensured by the left walk). Empty query after '@' is valid.

  if (!isSafeCurrentDirectoryQuery(relativeQuery)) {
    return null;
  }

  return {
    start: atIndex,
    end: caret,
    parentDepth: 0,
    relativeQuery,
  };
}

/**
 * S01 safety: only plain relative path prefixes under the current directory.
 * Rejects traversal, absolute roots, drive letters, and UNC-style prefixes.
 */
function isSafeCurrentDirectoryQuery(query: string): boolean {
  if (query.length === 0) return true;

  // Absolute / root / UNC-style
  if (query.startsWith('/') || query.startsWith('\\')) return false;
  if (query.startsWith('//') || query.startsWith('\\\\')) return false;

  // Windows drive prefix: C: or c:\
  if (/^[A-Za-z]:/.test(query)) return false;

  // Normalize separators for segment checks
  const normalized = query.replace(/\\/g, '/');

  // Reject "." or ".." path segments (leading, trailing, or embedded).
  // Also reject empty segments from consecutive slashes (e.g. "a//b").
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
  }

  return true;
}
