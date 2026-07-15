/**
 * Pure active skill-trigger query parser for composer autocomplete.
 *
 * Mirrors `parseActiveFileMentionQuery` but for a per-backend skill prefix
 * (`/` for Claude/most backends, `$` for Codex). Detects an in-progress
 * `<prefix><name>` token at the caret. Independent of Svelte and the host.
 *
 * The trigger only fires when the prefix is at input start or immediately
 * after whitespace, so `/` inside a path or `$` inside a mid-word token
 * (e.g. `foo$bar`) does NOT open the picker.
 */

/** Characters allowed inside a skill name after the trigger prefix. */
const NAME_CHAR = /[A-Za-z0-9._-]/;

export interface ActiveSkillQuery {
  /** Inclusive index of the trigger prefix character. */
  start: number;
  /** Exclusive end of the replacement range (the caret). */
  end: number;
  /** Skill name typed so far (no leading prefix). */
  query: string;
}

/**
 * Detect an active skill trigger at the caret. `prefix` is the backend char
 * (`'/'` or `'$'`). Returns null when there is no valid in-progress query.
 */
export function parseActiveSkillQuery(
  text: string,
  caret: number,
  prefix: string,
): ActiveSkillQuery | null {
  if (typeof text !== 'string') return null;
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  // A single-character trigger is required (map values are always one char).
  if (typeof prefix !== 'string' || prefix.length !== 1) return null;

  // Walk left over the query-name characters to find the trigger prefix.
  let i = caret;
  while (i > 0 && NAME_CHAR.test(text[i - 1]!)) i -= 1;

  const p = i - 1;
  // The character before the name must be the prefix.
  if (p < 0 || text[p] !== prefix) return null;
  // The prefix must be at input start or preceded by whitespace.
  if (p > 0 && !/\s/.test(text[p - 1]!)) return null;

  // Extend the range past the caret over the trailing name characters so the
  // replacement covers the WHOLE contiguous token — a caret mid-token then
  // strips the entire skill name (no garbage suffix left behind).
  let end = caret;
  while (end < text.length && NAME_CHAR.test(text[end]!)) end += 1;

  const query = text.slice(p + 1, end);
  // Reject control characters (defensive; mirrors file-mention parser).
  for (let c = 0; c < query.length; c += 1) {
    const code = query.charCodeAt(c);
    if (code < 0x20 || code === 0x7f) return null;
  }

  return { start: p, end, query };
}

/**
 * Remove the active `prefix + query` slice from the text (used when a
 * suggestion is chosen and the skill becomes a structured chip instead).
 */
export function stripActiveSkillQuery(
  text: string,
  range: { start: number; end: number },
): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const joined = before + after;
  return { text: joined, caret: before.length };
}
