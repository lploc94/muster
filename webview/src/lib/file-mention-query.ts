/**
 * Pure active file-mention query parser for composer autocomplete.
 * Detects an in-progress @query at the caret. Independent of Svelte and filesystem.
 *
 * Supports parentDepth 0–2 via leading `../` prefixes. Embedded or deeper
 * traversal, absolute roots, drive/UNC prefixes, and control characters fail closed.
 */

/** Matches unquoted mention body characters (same set as file-mention-bindings / render). */
const QUERY_CHAR = /[A-Za-z0-9_./\\-]/;

/** Word char that, if immediately before @, makes it an email-like token. */
const EMAIL_PREFIX = /[A-Za-z0-9_]/;

export type FileMentionParentDepth = 0 | 1 | 2;

export interface ActiveFileMentionQuery {
  /** Inclusive start index of the active token (points at '@'). */
  start: number;
  /** Exclusive end index of the replacement range (the caret). */
  end: number;
  /** Directory ascent count relative to task/draft cwd. Bounded to 0–2. */
  parentDepth: FileMentionParentDepth;
  /**
   * Relative path query after the leading parent-prefix (no leading '@').
   * Empty when the caret is still inside the parent prefix (e.g. `@../`).
   */
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

  // Quoted mentions (completed or incomplete) are not autocomplete queries.
  if (text[atIndex + 1] === '"') {
    return null;
  }

  const rawQuery = text.slice(atIndex + 1, caret);

  // Reject control characters (including tab/newline) anywhere in the query span.
  for (let c = 0; c < rawQuery.length; c += 1) {
    const code = rawQuery.charCodeAt(c);
    if (code < 0x20 || code === 0x7f) {
      return null;
    }
  }

  const scoped = parseBoundedParentScopedQuery(rawQuery);
  if (!scoped) return null;

  return {
    start: atIndex,
    end: caret,
    parentDepth: scoped.parentDepth,
    relativeQuery: scoped.relativeQuery,
  };
}

interface ScopedQuery {
  parentDepth: FileMentionParentDepth;
  relativeQuery: string;
}

/**
 * Parse leading parent-ascent prefixes (`../` up to depth 2) and the remaining
 * relative directory/basename query. Rejects absolute roots, drive/UNC prefixes,
 * embedded `..` / `.` segments, empty segments, and depth > 2.
 */
function parseBoundedParentScopedQuery(query: string): ScopedQuery | null {
  // Absolute / root / UNC-style
  if (query.startsWith('/') || query.startsWith('\\')) return null;
  if (query.startsWith('//') || query.startsWith('\\\\')) return null;

  // Windows drive prefix: C: or c:\
  if (/^[A-Za-z]:/.test(query)) return null;

  // Normalize separators for segment checks
  const normalized = query.replace(/\\/g, '/');

  let parentDepth = 0;
  let rest = normalized;

  // Consume leading `../` segments (complete), then optional incomplete trailing `..`.
  while (parentDepth < 3) {
    if (rest.startsWith('../')) {
      parentDepth += 1;
      rest = rest.slice(3);
      continue;
    }
    if (rest === '..') {
      parentDepth += 1;
      rest = '';
      break;
    }
    break;
  }

  if (parentDepth > 2) return null;

  // Remaining path must not start with `.` or `..` segments (e.g. `./x`, `../` after limit).
  // Also reject any further parent-ascent that wasn't consumed above.
  if (rest === '.' || rest === '..' || rest.startsWith('./') || rest.startsWith('../')) {
    return null;
  }

  // Empty relative query is valid (bare `@`, `@../`, `@../../`).
  if (rest.length === 0) {
    return { parentDepth: parentDepth as FileMentionParentDepth, relativeQuery: '' };
  }

  // Trailing slash is valid directory refinement (`src/`, `../packages/`).
  // Preserve it in relativeQuery so the host lists that directory; reject bare `/`
  // and consecutive internal empty segments (`a//b`).
  const endsWithSlash = rest.endsWith('/');
  const withoutTrailing = rest.replace(/\/+$/, '');
  if (withoutTrailing.length === 0) {
    // Only slashes after the parent prefix (e.g. `@../` is already empty rest).
    return null;
  }
  if (rest.includes('//')) {
    return null;
  }

  const segments = withoutTrailing.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return null;
    }
  }

  return {
    parentDepth: parentDepth as FileMentionParentDepth,
    // Keep a single trailing slash when present for directory drill-down.
    relativeQuery: endsWithSlash ? `${withoutTrailing}/` : withoutTrailing,
  };
}
