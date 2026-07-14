/**
 * Task brief + first-turn prompt compiler (orchestration W2).
 * Pure helpers — no engine/store I/O.
 */

import { formatPinnedInputsForPrompt } from './dataflow';
import type { ResolvedInputPin, TaskBriefKind, TaskBriefV1 } from './types';

/** Max chars for a single compiled prompt section. */
export const BRIEF_SECTION_MAX = 8_192;
/** Max chars for the entire compiled first prompt. */
export const COMPILED_PROMPT_MAX = 48_000;

const KIND_PREAMBLES: Readonly<Record<TaskBriefKind, string>> = {
  coordinate:
    'You are coordinating a multi-task workflow. Create a clear plan graph, wait for children, and seal only via host policy.',
  plan: 'You are a planning agent. Produce a concrete, actionable plan summary suitable for implementers.',
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

export interface CompileTaskPromptMeta {
  taskId?: string;
  goal?: string;
}

/**
 * Compile first-turn prompt from brief + durable resolved input pins.
 * Pins are framed as untrusted data (not instructions).
 */
export function compileTaskPrompt(
  brief: TaskBriefV1,
  resolvedInputs: readonly ResolvedInputPin[] = [],
  meta: CompileTaskPromptMeta = {},
): string {
  const parts: string[] = [];
  const preamble = KIND_PREAMBLES[brief.kind] ?? KIND_PREAMBLES.generic;
  parts.push(`# Role\n${preamble}`);

  parts.push(`# Objective\n${clampSection(brief.objective || meta.goal || brief.title)}`);

  if (brief.context) {
    parts.push(`# Context\n${clampSection(brief.context)}`);
  }
  if (brief.nonGoals && brief.nonGoals.length > 0) {
    parts.push(`# Non-goals\n${brief.nonGoals.map((g) => `- ${clampSection(g, 500)}`).join('\n')}`);
  }
  if (brief.constraints && brief.constraints.length > 0) {
    parts.push(
      `# Constraints\n${brief.constraints.map((c) => `- ${clampSection(c, 500)}`).join('\n')}`,
    );
  }
  if (brief.acceptanceCriteria.length > 0) {
    parts.push(
      `# Acceptance criteria\n${brief.acceptanceCriteria.map((c) => `- ${clampSection(c, 500)}`).join('\n')}`,
    );
  }
  if (brief.definitionOfDone && brief.definitionOfDone.length > 0) {
    parts.push(
      `# Definition of done\n${brief.definitionOfDone.map((d) => `- ${clampSection(d, 500)}`).join('\n')}`,
    );
  }
  if (brief.readPaths && brief.readPaths.length > 0) {
    parts.push(`# Read paths\n${brief.readPaths.map((p) => `- ${p}`).join('\n')}`);
  }
  if (brief.writePaths && brief.writePaths.length > 0) {
    parts.push(`# Write paths\n${brief.writePaths.map((p) => `- ${p}`).join('\n')}`);
  }
  if (brief.verification?.commands?.length || brief.verification?.manualChecks?.length) {
    const lines: string[] = [];
    for (const cmd of brief.verification.commands ?? []) {
      lines.push(`- command: ${clampSection(cmd, 500)}`);
    }
    for (const check of brief.verification.manualChecks ?? []) {
      lines.push(`- check: ${clampSection(check, 500)}`);
    }
    parts.push(`# Verification\n${lines.join('\n')}`);
  }

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
