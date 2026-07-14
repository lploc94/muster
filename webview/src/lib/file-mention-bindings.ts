/**
 * Display-name mentions in the composer, expanded to real paths on send.
 * UI shows @name; LLM receives @path (absolute or workspace-relative).
 */

/**
 * Unquoted chip grammar must match `FILE_MENTION_PATTERN` in file-mention-render.ts:
 * ASCII letters, digits, `_ . / \ -` only. Everything else (Unicode, spaces, punctuation)
 * uses the quoted form so chips still highlight.
 */
const UNQUOTED_MENTION = /^[A-Za-z0-9_./\\-]+$/;

/** Build a composer mention token: @path or @"path with spaces/quotes/unicode". */
export function mentionTokenFor(pathOrName: string): string {
  const normalized = pathOrName.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (UNQUOTED_MENTION.test(normalized)) {
    return `@${normalized}`;
  }
  // Escape \ and " so the quoted form round-trips through the mention parser.
  const escaped = normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `@"${escaped}"`;
}

/** Basename for display chips (last path segment). */
export function displayNameForPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : normalized;
}

/**
 * Map display mention token → resolve path for the LLM.
 * Keys are exact tokens as inserted (e.g. `@logo.png`, `@"my file.md"`).
 */
export type MentionBindingMap = Map<string, string>;

/**
 * Insert a unique display token for `resolvePath`. If `@name` is already bound
 * to a different path, use `name (2)`, `name (3)`, …
 */
export function allocateDisplayToken(
  bindings: MentionBindingMap,
  resolvePath: string,
  preferredDisplayName?: string,
): { token: string; displayName: string } {
  const baseName = (preferredDisplayName?.trim() || displayNameForPath(resolvePath) || 'file').replace(
    /\\/g,
    '/',
  );
  // Strip existing @ wrapper if host sent a token by mistake
  const bare = baseName.replace(/^@"?/, '').replace(/"$/, '');

  let displayName = bare;
  let n = 1;
  while (true) {
    const token = mentionTokenFor(displayName);
    const existing = bindings.get(token);
    if (!existing || existing === resolvePath) {
      bindings.set(token, resolvePath.replace(/\\/g, '/'));
      return { token, displayName };
    }
    n += 1;
    const dot = bare.lastIndexOf('.');
    if (dot > 0) {
      displayName = `${bare.slice(0, dot)} (${n})${bare.slice(dot)}`;
    } else {
      displayName = `${bare} (${n})`;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace bound display tokens with path tokens for the LLM payload.
 * Only complete tokens are replaced (not prefixes of longer @mentions).
 * Unbound @mentions (typed by hand) are left unchanged.
 */
export function expandMentionsForLlm(text: string, bindings: MentionBindingMap): string {
  if (!text || bindings.size === 0) return text;
  const entries = [...bindings.entries()].sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [token, resolvePath] of entries) {
    if (!out.includes(token)) continue;
    const replacement = mentionTokenFor(resolvePath);
    // Require that the match is not a strict prefix of a longer @-token.
    // After the token we allow end-of-string, whitespace, or common punctuation —
    // not another path character that would mean the user typed a longer mention.
    const pattern = new RegExp(`${escapeRegExp(token)}(?![A-Za-z0-9_./\\\\-])`, 'g');
    out = out.replace(pattern, replacement);
  }
  return out;
}
