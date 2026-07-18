/**
 * Fresh-session recovery prompt (M017-S06 / Design §9.3).
 *
 * Sticky ACP session/load that retains a broken MCP registry cannot be fixed by
 * reloading the same session id. Attempt 2 must session/new with a durable
 * recovery prompt that preserves goal/brief/prior outcomes without inventing a
 * user request, under the same budget/sanitizer family as first-turn/handoff.
 *
 * Pure helper — no engine/store I/O. TaskEngine wires this into
 * RunOptions.mcpSetup.buildFreshSessionPrompt in T03.
 */

import { BRIEF_SECTION_MAX, COMPILED_PROMPT_MAX, clampSection } from './brief';
import type { TaskBriefV1 } from './types';

/** Max prior-outcome lines retained in a recovery prompt. */
export const RECOVERY_PRIOR_OUTCOME_MAX = 16;
/** Max chars per prior-outcome line (before prompt-level packing). */
export const RECOVERY_PRIOR_OUTCOME_LINE_MAX = 1_000;

export interface FreshSessionRecoveryPromptInput {
  /** Task goal — protected core material. */
  goal: string;
  /** Optional structured brief (objective/context preferred when present). */
  brief?: TaskBriefV1;
  /**
   * Compact prior turn outcomes/summaries already durable on the store.
   * Treated as prior work, not as a new user request.
   */
  priorOutcomes?: readonly string[];
  /**
   * Original compiled prompt for this turn (restate when budget allows).
   * Never invented — only restated.
   */
  originalPrompt?: string;
  /** Optional readiness/setup reason (e.g. session_registry_sticky). */
  recoveryReason?: string;
  /** Budget; defaults to COMPILED_PROMPT_MAX (first-turn family). */
  maxChars?: number;
}

export type FreshSessionRecoveryPromptResult =
  | { ok: true; prompt: string }
  | {
      ok: false;
      code: 'prompt_budget_exceeded' | 'empty_recovery_prompt';
      message: string;
    };

/**
 * Scrub recovery prompt / diagnostic text without the handoff 240-char cap.
 * Matches the same secret family as store handoff sanitizer + explicit
 * MUSTER_BRIDGE_TOKEN / Authorization header redaction required by S06.
 */
export function sanitizeRecoveryPromptText(text: string): string {
  return text
    // Windows absolute paths
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[path]')
    // POSIX absolute paths
    .replace(/(?:^|[\s"'`(=])(\/(?:[^\s"'`)]+\/)+[^\s"'`)]+)/g, (match, pathPart: string) =>
      match.replace(pathPart, '[path]'),
    )
    // Authorization / cookie headers — full value through EOL
    .replace(
      /\b((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi,
      '$1[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]')
    // Explicit muster bridge token forms (assignment and bare suffix values)
    .replace(/\bMUSTER_BRIDGE_TOKEN\s*[=:]\s*\S+/gi, 'MUSTER_BRIDGE_TOKEN=[redacted]')
    .replace(/\bMUSTER_BRIDGE_TOKEN[_-][A-Za-z0-9._~+/-]+/gi, 'MUSTER_BRIDGE_TOKEN_[redacted]')
    // password/token/secret/key assignment forms
    .replace(
      /\b((?:password|passwd|pwd|passphrase|api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret|token|auth[_-]?token|private[_-]?key|aws_secret_access_key|aws_access_key_id)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    // Common secret / token shapes (sk-…, api_key-…, etc.)
    .replace(
      /\b(?:sk|pk|api[_-]?key|token|secret|key)[-_][A-Za-z0-9][-_A-Za-z0-9]{4,}\b/gi,
      '[redacted]',
    )
    // Collapse long runs (conversation dumps / raw CLI)
    .replace(/([A-Za-z0-9])\1{20,}/g, '$1$1$1…');
}

function scrubSection(text: string, max = BRIEF_SECTION_MAX): string {
  return clampSection(sanitizeRecoveryPromptText(text.replace(/\r\n/g, '\n').trim()), max);
}

function buildHeader(reason?: string): string {
  const reasonLine =
    reason && reason.trim().length > 0
      ? `\nRecovery reason: ${scrubSection(reason, 200)}`
      : '';
  return [
    '## Session recovery',
    '',
    'The previous ACP session retained a broken MCP tool registry and was closed.',
    'Continue the same task in this fresh session. Do not invent a new user request.',
    'Treat the material below as durable task context from before the recovery.',
    reasonLine,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function buildPriorOutcomesBlock(priorOutcomes: readonly string[] | undefined): string | undefined {
  if (!priorOutcomes || priorOutcomes.length === 0) return undefined;
  const lines: string[] = [];
  for (const raw of priorOutcomes.slice(0, RECOVERY_PRIOR_OUTCOME_MAX)) {
    if (typeof raw !== 'string') continue;
    const line = scrubSection(raw, RECOVERY_PRIOR_OUTCOME_LINE_MAX);
    if (!line) continue;
    lines.push(`- ${line}`);
  }
  if (lines.length === 0) return undefined;
  return `# Prior outcomes\n${lines.join('\n')}`;
}

/**
 * Build a durable fresh-session recovery prompt.
 *
 * Protected core (must fit budget or fail closed): recovery header + goal +
 * brief objective when present. Optional sections (context, prior outcomes,
 * original prompt) are packed greedily and dropped under budget — never emit a
 * context-less prompt when the core itself cannot fit.
 */
export function buildFreshSessionRecoveryPrompt(
  input: FreshSessionRecoveryPromptInput,
): FreshSessionRecoveryPromptResult {
  const maxChars = Math.max(1, Math.floor(input.maxChars ?? COMPILED_PROMPT_MAX));
  const goal = scrubSection(input.goal ?? '', BRIEF_SECTION_MAX);
  const objective = scrubSection(
    input.brief?.objective || input.goal || input.brief?.title || '',
    BRIEF_SECTION_MAX,
  );
  const title = input.brief?.title ? scrubSection(input.brief.title, 200) : undefined;
  const context = input.brief?.context
    ? scrubSection(input.brief.context, BRIEF_SECTION_MAX)
    : undefined;
  const originalPrompt =
    typeof input.originalPrompt === 'string' && input.originalPrompt.trim().length > 0
      ? scrubSection(input.originalPrompt, COMPILED_PROMPT_MAX)
      : undefined;

  if (!goal && !objective && !originalPrompt) {
    return {
      ok: false,
      code: 'empty_recovery_prompt',
      message: 'recovery prompt empty: no goal, objective, or original prompt to restate',
    };
  }

  const header = buildHeader(input.recoveryReason);
  const goalSection = goal ? `# Goal\n${goal}` : undefined;
  const titleSection = title && title !== goal ? `# Title\n${title}` : undefined;
  const objectiveSection =
    objective && objective !== goal ? `# Objective\n${objective}` : undefined;
  const contextSection = context ? `# Context\n${context}` : undefined;
  const priorSection = buildPriorOutcomesBlock(input.priorOutcomes);
  const originalSection = originalPrompt
    ? `# Original prompt\n${originalPrompt}`
    : undefined;

  // Protected core: header + goal (or objective as fallback) must fit.
  const coreParts = [header];
  if (goalSection) coreParts.push(goalSection);
  else if (objectiveSection) coreParts.push(objectiveSection);
  else if (originalSection) {
    // Only original remains — still durable restatement, not invention.
    coreParts.push(originalSection);
  }
  const core = coreParts.join('\n\n');
  if (core.length > maxChars) {
    return {
      ok: false,
      code: 'prompt_budget_exceeded',
      message: `recovery prompt core exceeds budget (${core.length} > ${maxChars})`,
    };
  }

  // Optional packing order: title → objective (if not already core) → context →
  // prior outcomes → original prompt. Drop when over budget.
  const optional: string[] = [];
  if (titleSection) optional.push(titleSection);
  if (objectiveSection && goalSection) optional.push(objectiveSection);
  if (contextSection) optional.push(contextSection);
  if (priorSection) optional.push(priorSection);
  if (originalSection && !(coreParts.includes(originalSection))) {
    optional.push(originalSection);
  }

  let assembled = core;
  for (const section of optional) {
    const next = `${assembled}\n\n${section}`;
    if (next.length > maxChars) break;
    assembled = next;
  }

  if (!assembled.trim()) {
    return {
      ok: false,
      code: 'empty_recovery_prompt',
      message: 'recovery prompt empty after assembly',
    };
  }

  if (assembled.length > maxChars) {
    return {
      ok: false,
      code: 'prompt_budget_exceeded',
      message: `recovery prompt exceeds budget after assembly (${assembled.length} > ${maxChars})`,
    };
  }

  return { ok: true, prompt: assembled };
}

/**
 * Adapter for RunOptions.mcpSetup.buildFreshSessionPrompt — throws on budget /
 * empty so runAcpTurn fails pre_dispatch without dispatching a context-less prompt.
 */
export function buildFreshSessionRecoveryPromptOrThrow(
  input: FreshSessionRecoveryPromptInput,
): string {
  const result = buildFreshSessionRecoveryPrompt(input);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.prompt;
}
