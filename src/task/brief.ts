/**
 * Task brief + first-turn prompt compiler (orchestration W2 / host-context W0).
 * Pure helpers — no engine/store I/O.
 */

import { formatPinnedInputsForPrompt } from './dataflow';
import {
  buildHostContext,
  formatHostContextMarkdown,
  type BuildHostContextInput,
  type HostContextV1,
  type HostEnvironmentSnapshot,
} from './host-context';
import type { ResolvedInputPin, TaskBriefKind, TaskBriefV1 } from './types';

/** Max chars for a single compiled prompt section. */
export const BRIEF_SECTION_MAX = 8_192;
/** Max chars for the entire compiled first prompt. */
export const COMPILED_PROMPT_MAX = 48_000;
/** Max items in a brief list section. */
export const BRIEF_LIST_MAX_ITEMS = 32;

const KIND_PREAMBLES: Readonly<Record<TaskBriefKind, string>> = {
  coordinate:
    'You are coordinating a multi-task workflow. Create a clear plan graph, wait for children, and seal only via host policy. When a step must be verified, delegate a verify task that depends on the work and have downstream tasks depend on that verify task; a non-pass verdict then blocks downstream and auto-remediation attempts a bounded fix.',
  plan: 'You are a planning agent. Produce a concrete, actionable plan summary suitable for implementers.',
  breakdown:
    'You are a work-breakdown agent. Decompose the plan into an ordered checklist of small, independent implementation tasks. For each item give: a one-line goal, its taskType, which earlier items it depends on, which earlier outputs it consumes, and acceptance criteria. Prefer parallelizable, minimal items. Emit the checklist in a strict, compact, machine-readable form. For any item that must be verified, emit a verify step depending on that work and mark its dependents as depending on the verify step so a failing verdict blocks them.',
  implement: 'You are an implementation agent. Apply the plan carefully; prefer minimal correct changes.',
  test: 'You are a testing agent. Verify behavior with the given checks; report failures clearly.',
  verify: 'You are a verification agent. Confirm acceptance criteria and definition of done.',
  research: 'You are a research agent. Gather facts; do not modify the workspace unless required.',
  generic: 'You are a task agent. Complete the objective; respect constraints and acceptance criteria.',
};

export function clampSection(text: string, max = BRIEF_SECTION_MAX): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/**
 * Default brief when only goal/description exist (create + migrate).
 */
export function synthesizeBriefFromGoal(
  goal: string,
  description?: string,
  kind: TaskBriefKind = 'generic',
): TaskBriefV1 {
  const title = clampSection(goal.trim() || 'Untitled task', 200);
  return {
    version: 1,
    kind,
    title,
    objective: clampSection(goal),
    ...(description !== undefined && description.length > 0
      ? { context: clampSection(description) }
      : {}),
    acceptanceCriteria: [],
    expectedOutputs: ['summary'],
  };
}

export const TASK_BRIEF_KINDS: readonly TaskBriefKind[] = [
  'coordinate',
  'plan',
  'breakdown',
  'implement',
  'test',
  'verify',
  'research',
  'generic',
];

export function isTaskBriefKind(value: string): value is TaskBriefKind {
  return (TASK_BRIEF_KINDS as readonly string[]).includes(value);
}

/** MCP/create partial brief overlay (no version). */
export type TaskBriefOverlay = {
  kind?: TaskBriefKind;
  title?: string;
  objective?: string;
  context?: string;
  nonGoals?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  definitionOfDone?: string[];
  readPaths?: string[];
  writePaths?: string[];
  verification?: {
    commands?: string[];
    manualChecks?: string[];
    hostRun?: boolean;
    emitVerdict?: boolean;
  };
  skills?: string[];
};

/**
 * Structured-verdict instruction. Appended to EVERY verify-kind brief by default
 * (emitting a verdict is a verify task's job), and to a non-verify brief only when it
 * opts in via `verification.hostRun` or `verification.emitVerdict`.
 */
const VERDICT_INSTRUCTION_SECTION =
  "# Verdict\nWhen you finish, call complete_task with a structured verdict {status:'pass'|'fail'|'inconclusive', rationale, criteria[]}. Missing checks or missing evidence => 'inconclusive', never a default 'pass'.";

function clampStringList(items: readonly string[] | undefined, itemMax = 500): string[] | undefined {
  if (!items) return undefined;
  return items
    .slice(0, BRIEF_LIST_MAX_ITEMS)
    .map((s) => clampSection(s, itemMax))
    .filter((s) => s.length > 0);
}

/**
 * Valid bare skill/command name. Rejects spaces, newlines, slashes, and control
 * chars so a declared skill can never smuggle extra prompt lines (injection).
 */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Maximum number of skills a single brief may declare. */
export const MAX_BRIEF_SKILLS = 8;

/**
 * Dedupe (case-sensitive) + preserve first-seen order + cap at MAX_BRIEF_SKILLS;
 * drop non-strings and blanks. The NAME regex is NOT applied here — validation is
 * deferred to injection time so we can distinguish invalid vs unavailable names
 * for attention reporting. Returns undefined for a non-array or empty result.
 */
export function normalizeSkillNames(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of input) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_BRIEF_SKILLS) break;
  }
  return out.length ? out : undefined;
}

export interface SkillResolution {
  commandLines: string[];
  unavailable: string[];
}

/**
 * Resolve declared skills against a backend's advertised command set.
 * - advertised === undefined → UNKNOWN backend → inject optimistically (valid names only).
 * - advertised is a Set → KNOWN → strict: only inject names present in the set.
 * A name failing SKILL_NAME_RE is never injected and is reported as unavailable.
 */
export function resolveSkillInvocation(
  skills: readonly string[] | undefined,
  advertised: ReadonlySet<string> | undefined,
): SkillResolution {
  const commandLines: string[] = [];
  const unavailable: string[] = [];
  for (const name of skills ?? []) {
    if (!SKILL_NAME_RE.test(name)) {
      unavailable.push(name);
      continue;
    }
    const ok = advertised === undefined ? true : advertised.has(name);
    if (ok) commandLines.push(`/${name}`);
    else unavailable.push(name);
  }
  return { commandLines, unavailable };
}

/**
 * Merge synthesize-from-goal with optional MCP brief overlay + path convenience fields.
 * Pure; clamps oversize. Prefer brief.* paths over top-level convenience when both set.
 */
export function mergeBriefFromCreate(args: {
  goal: string;
  description?: string;
  brief?: TaskBriefOverlay;
  writePaths?: string[];
  readPaths?: string[];
  /** Preset briefKind when overlay omits kind (task-types resolve). */
  defaultKind?: TaskBriefKind;
}): TaskBriefV1 {
  const kind = args.brief?.kind ?? args.defaultKind ?? 'generic';
  const base = synthesizeBriefFromGoal(args.goal, args.description, kind);
  const o = args.brief;

  const readPaths =
    clampStringList(o?.readPaths, 1000) ??
    clampStringList(args.readPaths, 1000) ??
    base.readPaths;
  const writePaths =
    clampStringList(o?.writePaths, 1000) ??
    clampStringList(args.writePaths, 1000) ??
    base.writePaths;

  const verification =
    o?.verification !== undefined
      ? {
          ...(clampStringList(o.verification.commands)
            ? { commands: clampStringList(o.verification.commands) }
            : {}),
          ...(clampStringList(o.verification.manualChecks)
            ? { manualChecks: clampStringList(o.verification.manualChecks) }
            : {}),
          ...(o.verification.hostRun === true ? { hostRun: true } : {}),
          ...(o.verification.emitVerdict === true ? { emitVerdict: true } : {}),
        }
      : base.verification;

  const merged: TaskBriefV1 = {
    version: 1,
    kind: o?.kind ?? base.kind,
    title: o?.title !== undefined ? clampSection(o.title, 200) : base.title,
    objective:
      o?.objective !== undefined ? clampSection(o.objective) : base.objective,
    acceptanceCriteria:
      clampStringList(o?.acceptanceCriteria) ?? base.acceptanceCriteria,
    expectedOutputs: base.expectedOutputs ?? ['summary'],
  };

  const context =
    o?.context !== undefined
      ? o.context.length > 0
        ? clampSection(o.context)
        : undefined
      : base.context;
  if (context) merged.context = context;

  const nonGoals = clampStringList(o?.nonGoals);
  if (nonGoals) merged.nonGoals = nonGoals;
  else if (base.nonGoals) merged.nonGoals = base.nonGoals;

  const constraints = clampStringList(o?.constraints);
  if (constraints) merged.constraints = constraints;
  else if (base.constraints) merged.constraints = base.constraints;

  const definitionOfDone = clampStringList(o?.definitionOfDone);
  if (definitionOfDone) merged.definitionOfDone = definitionOfDone;
  else if (base.definitionOfDone) merged.definitionOfDone = base.definitionOfDone;

  if (readPaths && readPaths.length > 0) merged.readPaths = readPaths;
  if (writePaths && writePaths.length > 0) merged.writePaths = writePaths;
  if (
    verification &&
    (verification.commands?.length ||
      verification.manualChecks?.length ||
      ('hostRun' in verification && verification.hostRun) ||
      ('emitVerdict' in verification && verification.emitVerdict))
  ) {
    merged.verification = verification;
  }

  const skills = normalizeSkillNames(o?.skills);
  if (skills) merged.skills = skills;

  return merged;
}

export interface CompileTaskPromptMeta {
  taskId?: string;
  goal?: string;
}

function formatListSection(title: string, items: readonly string[], itemMax = 500): string {
  const capped = items.slice(0, BRIEF_LIST_MAX_ITEMS);
  let body = capped.map((g) => `- ${clampSection(g, itemMax)}`).join('\n');
  if (body.length > BRIEF_SECTION_MAX) {
    body = body.slice(0, BRIEF_SECTION_MAX);
  }
  return `# ${title}\n${body}`;
}

/**
 * Compile role + brief body sections (no host, no pins).
 * Used by assembleFirstTurnPrompt and legacy compileTaskPrompt.
 */
export function compileBriefBody(
  brief: TaskBriefV1,
  meta: CompileTaskPromptMeta = {},
): { role: string; objective: string; optional: string[] } {
  const preamble = KIND_PREAMBLES[brief.kind] ?? KIND_PREAMBLES.generic;
  const role = `# Role\n${preamble}`;
  const objective = `# Objective\n${clampSection(brief.objective || meta.goal || brief.title)}`;
  const optional: string[] = [];

  if (brief.context) {
    optional.push(`# Context\n${clampSection(brief.context)}`);
  }
  if (brief.nonGoals && brief.nonGoals.length > 0) {
    optional.push(formatListSection('Non-goals', brief.nonGoals));
  }
  if (brief.constraints && brief.constraints.length > 0) {
    optional.push(formatListSection('Constraints', brief.constraints));
  }
  if (brief.acceptanceCriteria.length > 0) {
    optional.push(formatListSection('Acceptance criteria', brief.acceptanceCriteria));
  }
  if (brief.definitionOfDone && brief.definitionOfDone.length > 0) {
    optional.push(formatListSection('Definition of done', brief.definitionOfDone));
  }
  if (brief.readPaths && brief.readPaths.length > 0) {
    optional.push(formatListSection('Read paths', brief.readPaths, 1000));
  }
  if (brief.writePaths && brief.writePaths.length > 0) {
    optional.push(formatListSection('Write paths', brief.writePaths, 1000));
  }
  if (brief.verification?.commands?.length || brief.verification?.manualChecks?.length) {
    const lines: string[] = [];
    for (const cmd of brief.verification.commands ?? []) {
      lines.push(`- command: ${clampSection(cmd, 500)}`);
    }
    for (const check of brief.verification.manualChecks ?? []) {
      lines.push(`- check: ${clampSection(check, 500)}`);
    }
    let body = lines.join('\n');
    if (body.length > BRIEF_SECTION_MAX) body = body.slice(0, BRIEF_SECTION_MAX);
    optional.push(`# Verification\n${body}`);
  }
  // Verdict-by-default (verify-gate-loop A): producing a pass/fail verdict IS the job of
  // a verify task, so every verify-kind brief gets the `# Verdict` instruction. The
  // `hostRun`/`emitVerdict` flags remain the opt-in for NON-verify kinds that also want
  // to self-report a structured verdict.
  if (
    brief.kind === 'verify' ||
    brief.verification?.hostRun === true ||
    brief.verification?.emitVerdict === true
  ) {
    optional.push(VERDICT_INSTRUCTION_SECTION);
  }

  return { role, objective, optional };
}

/**
 * Compile first-turn prompt from brief + durable resolved input pins.
 * Pins are framed as untrusted data (not instructions).
 * Legacy API: still end-slices if over max (prefer assembleFirstTurnPrompt for budgeted assembly).
 */
export function compileTaskPrompt(
  brief: TaskBriefV1,
  resolvedInputs: readonly ResolvedInputPin[] = [],
  meta: CompileTaskPromptMeta = {},
): string {
  const { role, objective, optional } = compileBriefBody(brief, meta);
  const parts: string[] = [role, objective, ...optional];

  const pinned = formatPinnedInputsForPrompt(resolvedInputs);
  if (pinned) {
    parts.push(pinned);
  }

  let compiled = parts.join('\n\n');
  if (compiled.length > COMPILED_PROMPT_MAX) {
    compiled = compiled.slice(0, COMPILED_PROMPT_MAX);
  }
  return compiled;
}

// ---------------------------------------------------------------------------
// Budgeted first-turn assembly (W0)
// ---------------------------------------------------------------------------

export type AssembleFirstTurnResult =
  | { ok: true; prompt: string; hostContext: HostContextV1; unavailableSkills: string[] }
  | { ok: false; code: 'prompt_budget_exceeded'; message: string };

export interface AssembleFirstTurnInput {
  snapshot: HostEnvironmentSnapshot;
  self: BuildHostContextInput['self'];
  tools?: string[];
  taskCwd?: string;
  brief: TaskBriefV1;
  resolvedInputs?: readonly ResolvedInputPin[];
  meta?: CompileTaskPromptMeta;
  /** Coordinator task-type summaries for first-turn host inject. */
  taskTypes?: BuildHostContextInput['taskTypes'];
  /**
   * Backend-advertised command/skill names for fail-closed skill injection.
   * undefined → UNKNOWN backend → inject declared skills optimistically.
   */
  advertisedCommands?: ReadonlySet<string>;
}

/**
 * Budgeted first-turn compile: host → role → brief (objective + optional) → pins.
 * Protects host base/self/rules, role+objective, and complete pin tags.
 * Never mid-tag slices pin framing.
 */
export function assembleFirstTurnPrompt(input: AssembleFirstTurnInput): AssembleFirstTurnResult {
  const hostCtx = buildHostContext({
    snapshot: input.snapshot,
    self: input.self,
    tools: input.tools,
    taskCwd: input.taskCwd,
    taskTypes: input.taskTypes,
    // First-turn: demote raw catalogs when types present (get_host_context keeps them).
    suppressBackendCatalog: true,
  });
  let hostMd = formatHostContextMarkdown(hostCtx);

  const { role, objective, optional } = compileBriefBody(input.brief, input.meta ?? {});
  const pins = input.resolvedInputs ?? [];
  const pinSection = formatPinnedInputsForPrompt(pins);

  // Fail-closed skill injection resolved UP FRONT so the leading `/name` prefix is
  // reserved in EVERY budget decision below — protected minimum, slim-host, AND
  // optional-section packing — not just a final check. Otherwise optional sections
  // could be kept that leave no room for the prefix, failing a prompt that would
  // have fit by dropping an optional section. Known-absent / invalid names are not
  // injected and are surfaced for engine attention. First turn only. `budget` is
  // the space left for everything except the prefix.
  const { commandLines, unavailable } = resolveSkillInvocation(
    input.brief.skills,
    input.advertisedCommands,
  );
  const skillPrefix = commandLines.length ? `${commandLines.join('\n')}\n\n` : '';
  const budget = COMPILED_PROMPT_MAX - skillPrefix.length;

  // Protected minimum: host + role + objective (+ complete pins last if any)
  const minParts = [hostMd, role, objective];
  if (pinSection) minParts.push(pinSection);
  let minPrompt = minParts.join('\n\n');

  if (minPrompt.length > budget) {
    // Drop coordinator catalog (backends/models) from host if present
    if (hostCtx.availableBackends !== undefined || hostCtx.models !== undefined) {
      const slim: HostContextV1 = {
        ...hostCtx,
        availableBackends: undefined,
        models: undefined,
      };
      hostMd = formatHostContextMarkdown(slim);
      const slimParts = [hostMd, role, objective, ...(pinSection ? [pinSection] : [])];
      minPrompt = slimParts.join('\n\n');
    }
    if (minPrompt.length > budget) {
      return {
        ok: false,
        code: 'prompt_budget_exceeded',
        message: `First-turn prompt core (host+role+objective+pins${skillPrefix ? '+skills' : ''}) exceeds ${COMPILED_PROMPT_MAX} chars (${minPrompt.length + skillPrefix.length})`,
      };
    }
  }

  // Budget optional brief sections between objective and pins (order: host→role→brief→pins)
  let briefBody = `${role}\n\n${objective}`;
  for (const section of optional) {
    const next = `${briefBody}\n\n${section}`;
    const candidate = pinSection
      ? `${hostMd}\n\n${next}\n\n${pinSection}`
      : `${hostMd}\n\n${next}`;
    if (candidate.length > budget) break;
    briefBody = next;
  }

  const assembled = pinSection
    ? `${hostMd}\n\n${briefBody}\n\n${pinSection}`
    : `${hostMd}\n\n${briefBody}`;

  const prompt = skillPrefix ? `${skillPrefix}${assembled}` : assembled;

  // Safety net: `assembled` is packed within `budget` = MAX - prefix, so the full
  // prompt should already fit; this guards only against accounting drift.
  if (prompt.length > COMPILED_PROMPT_MAX) {
    return {
      ok: false,
      code: 'prompt_budget_exceeded',
      message: `First-turn prompt exceeds ${COMPILED_PROMPT_MAX} chars after assembly (${prompt.length})`,
    };
  }

  // Verify pin tags intact when pins present (pins live in `assembled`; the skill
  // prefix does not affect pin framing).
  if (pinSection) {
    for (const pin of pins) {
      const open = `<untrusted-input name="${pin.as}"`;
      const close = `</untrusted-input>`;
      if (!assembled.includes(open) || !assembled.includes(close)) {
        return {
          ok: false,
          code: 'prompt_budget_exceeded',
          message: `Pin framing for "${pin.as}" would be incomplete under budget`,
        };
      }
    }
  }

  return { ok: true, prompt, hostContext: hostCtx, unavailableSkills: unavailable };
}
