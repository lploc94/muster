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
    'You are coordinating a multi-task workflow. Create a clear plan graph, wait for children, and seal only via host policy.',
  plan: 'You are a planning agent. Produce a concrete, actionable plan summary suitable for implementers.',
  breakdown:
    'You are a work-breakdown agent. Decompose the plan into an ordered checklist of small, independent implementation tasks. For each item give: a one-line goal, its taskType, which earlier items it depends on, which earlier outputs it consumes, and acceptance criteria. Prefer parallelizable, minimal items. Emit the checklist in a strict, compact, machine-readable form.',
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
  verification?: { commands?: string[]; manualChecks?: string[] };
};

function clampStringList(items: readonly string[] | undefined, itemMax = 500): string[] | undefined {
  if (!items) return undefined;
  return items
    .slice(0, BRIEF_LIST_MAX_ITEMS)
    .map((s) => clampSection(s, itemMax))
    .filter((s) => s.length > 0);
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
  if (verification && (verification.commands?.length || verification.manualChecks?.length)) {
    merged.verification = verification;
  }

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
  | { ok: true; prompt: string; hostContext: HostContextV1 }
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

  // Protected minimum: host + role + objective (+ complete pins last if any)
  const minParts = [hostMd, role, objective];
  if (pinSection) minParts.push(pinSection);
  let minPrompt = minParts.join('\n\n');

  if (minPrompt.length > COMPILED_PROMPT_MAX) {
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
    if (minPrompt.length > COMPILED_PROMPT_MAX) {
      return {
        ok: false,
        code: 'prompt_budget_exceeded',
        message: `First-turn prompt core (host+role+objective+pins) exceeds ${COMPILED_PROMPT_MAX} chars (${minPrompt.length})`,
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
    if (candidate.length > COMPILED_PROMPT_MAX) break;
    briefBody = next;
  }

  const assembled = pinSection
    ? `${hostMd}\n\n${briefBody}\n\n${pinSection}`
    : `${hostMd}\n\n${briefBody}`;

  if (assembled.length > COMPILED_PROMPT_MAX) {
    return {
      ok: false,
      code: 'prompt_budget_exceeded',
      message: `First-turn prompt exceeds ${COMPILED_PROMPT_MAX} chars after assembly (${assembled.length})`,
    };
  }

  // Verify pin tags intact when pins present
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

  return { ok: true, prompt: assembled, hostContext: hostCtx };
}
