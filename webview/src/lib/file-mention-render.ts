/**
 * Render user message text with file-mention chips.
 * Matches the composer insert format: @path or @"path with spaces".
 * Output is HTML-safe (escaped text + fixed markup).
 */

/** Quoted: @"docs/my file.md"  Unquoted: @src/extension.ts */
export const FILE_MENTION_PATTERN =
  /@"((?:[^"\\]|\\.)*)"|@([A-Za-z0-9_./\\-][A-Za-z0-9_./\\-]*)/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface FileMentionMatch {
  raw: string;
  path: string;
  index: number;
  length: number;
}

/** Extract mentions in source order (for tests / future structured send). */
export function findFileMentions(text: string): FileMentionMatch[] {
  const out: FileMentionMatch[] = [];
  const re = new RegExp(FILE_MENTION_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const path = (m[1] !== undefined ? m[1] : m[2] ?? '').replace(/\\"/g, '"');
    if (!path) continue;
    out.push({ raw, path, index: m.index, length: raw.length });
  }
  return out;
}

/**
 * Escape plain text and wrap file mentions in a chip span.
 * Does not parse markdown — user bubbles stay plain with mention highlights.
 */
export function renderUserTextWithMentions(text: string): string {
  if (!text) return '';
  const re = new RegExp(FILE_MENTION_PATTERN.source, 'g');
  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    result += escapeHtml(text.slice(last, m.index));
    const raw = m[0];
    const path = (m[1] !== undefined ? m[1] : m[2] ?? '').replace(/\\"/g, '"');
    if (!path) {
      result += escapeHtml(raw);
    } else {
      const title = escapeHtml(path);
      const label = escapeHtml(raw);
      result += `<span class="file-mention" title="${title}">${label}</span>`;
    }
    last = m.index + raw.length;
  }
  result += escapeHtml(text.slice(last));
  // Newlines/spaces preserved by `.user-message-bubble { white-space: pre-wrap }`.
  return result;
}
