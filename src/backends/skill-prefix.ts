/**
 * Skill/slash-command prefixes. There are TWO distinct roles — do not conflate:
 *
 * 1. INJECTION prefix (`skillPrefixForBackend`) — the character the HOST writes
 *    at the top of the first-turn prompt so the backend actually expands the
 *    skill. This is PER-BACKEND and cannot be normalized: Claude, Grok, Kiro and
 *    OpenCode expand `/name`, but OpenAI Codex only expands `$name` — `/name`
 *    there returns "Unrecognized command" (openai/codex#11817, closed as not
 *    planned; `/` is reserved for Codex's built-in commands). So Codex needs `$`.
 *
 * 2. TRIGGER prefix (`SKILL_TRIGGER_PREFIX`) — the single character the user
 *    types in the composer to open the skill picker, and the prefix rendered on
 *    skill chips. This is UNIFORM `/` across every backend: the composer never
 *    talks to a backend directly, so the picker UX is normalized to `/` and the
 *    host translates to the correct injection prefix per backend on send.
 *
 * The engine reads the injection prefix via DI (getSkillPrefix injected in
 * extension.ts) so `task/` never imports `backends/`; the webview reads the
 * trigger prefix off the `skillsAvailable` message.
 */
export const SKILL_INVOCATION_PREFIX: Readonly<Record<string, string>> = { codex: '$' };
export const DEFAULT_SKILL_PREFIX = '/';

/**
 * Host-side INJECTION prefix for `backendId`: what gets written into the prompt
 * so the backend expands the skill. Per-backend (`$` for Codex, `/` otherwise).
 */
export function skillPrefixForBackend(backendId: string): string {
  return SKILL_INVOCATION_PREFIX[backendId] ?? DEFAULT_SKILL_PREFIX;
}

/**
 * Uniform composer TRIGGER/display prefix, identical for every backend: the user
 * always types `/` to open the picker and chips always render `/name`, no matter
 * what the backend's wire injection prefix is. Decoupled from
 * `skillPrefixForBackend` on purpose — normalizing the UX must never change the
 * per-backend wire text (Codex still receives `$name`).
 */
export const SKILL_TRIGGER_PREFIX = '/';
