/**
 * Per-backend skill/slash-command invocation prefix. Claude and most backends
 * invoke a skill as `/name`; OpenAI Codex invokes skills as `$name` (e.g.
 * `$brainstorming`) — `/name` is NOT recognized for custom skills there.
 *
 * This is the single source of truth for the prefix. The engine reads it via DI
 * (getSkillPrefix injected in extension.ts) so `task/` never imports `backends/`;
 * the webview reads it via the `skillsAvailable` message. Both ultimately resolve
 * through this map.
 */
export const SKILL_INVOCATION_PREFIX: Readonly<Record<string, string>> = { codex: '$' };
export const DEFAULT_SKILL_PREFIX = '/';
export function skillPrefixForBackend(backendId: string): string {
  return SKILL_INVOCATION_PREFIX[backendId] ?? DEFAULT_SKILL_PREFIX;
}
