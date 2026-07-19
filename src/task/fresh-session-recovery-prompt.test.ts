// M017-S06 T02: durable fresh-session recovery prompt helper.
//
// Sticky session/load that retains a broken MCP registry must fall back to
// session/new with a budgeted recovery prompt that preserves goal/brief/prior
// outcomes without inventing a user request, under the same budget/sanitizer
// family as first-turn/handoff assembly.

import { describe, expect, it } from 'vitest';
import { COMPILED_PROMPT_MAX } from './brief';
import {
  buildFreshSessionRecoveryPrompt,
  buildFreshSessionRecoveryPromptOrThrow,
  sanitizeRecoveryPromptText,
} from './fresh-session-recovery-prompt';
import type { TaskBriefV1 } from './types';

function sampleBrief(over: Partial<TaskBriefV1> = {}): TaskBriefV1 {
  return {
    version: 1,
    kind: 'implement',
    title: 'Ship recovery',
    objective: 'Recover MCP readiness without losing task context',
    acceptanceCriteria: ['prompt preserves goal'],
    expectedOutputs: ['summary'],
    ...over,
  };
}

describe('buildFreshSessionRecoveryPrompt (M017-S06 / T02)', () => {
  it('preserves goal, brief objective, and prior outcomes without inventing a user request', () => {
    const result = buildFreshSessionRecoveryPrompt({
      goal: 'Fix sticky MCP registry',
      brief: sampleBrief({
        context: 'Agent was mid-implementation on the readiness gate.',
      }),
      priorOutcomes: ['turn 1: tools/list missing evidence', 'turn 2: sticky load failed'],
      originalPrompt: 'Original first-turn work for the readiness gate.',
      recoveryReason: 'session_registry_sticky',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toMatch(/Session recovery/i);
    expect(result.prompt).toMatch(/Do not invent a new user request/i);
    expect(result.prompt).toContain('Fix sticky MCP registry');
    expect(result.prompt).toContain('Recover MCP readiness without losing task context');
    expect(result.prompt).toContain('mid-implementation on the readiness gate');
    expect(result.prompt).toContain('turn 1: tools/list missing evidence');
    expect(result.prompt).toContain('Original first-turn work for the readiness gate.');
    expect(result.prompt).toMatch(/session_registry_sticky/);
    // Must not invent a fresh user ask that replaces the original goal.
    expect(result.prompt).not.toMatch(/Please help me with something new/i);
  });

  it('sanitizes bearer tokens, Authorization headers, and MUSTER_BRIDGE_TOKEN from all sections', () => {
    const result = buildFreshSessionRecoveryPrompt({
      goal: 'token=MUSTER_BRIDGE_TOKEN_SECRET continue work',
      brief: sampleBrief({
        objective: 'Authorization: Bearer sk-secret-value keep going',
        context: 'MUSTER_BRIDGE_TOKEN=abc123 and Authorization: Bearer sk-leaked',
      }),
      priorOutcomes: ['Authorization: Bearer sk-prior-secret', 'token=MUSTER_BRIDGE_TOKEN_LEAK'],
      originalPrompt: 'Bearer sk-original MUSTER_BRIDGE_TOKEN=xyz',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const blob = result.prompt;
    expect(blob).not.toMatch(/Bearer sk-secret-value/i);
    expect(blob).not.toMatch(/Bearer sk-leaked/i);
    expect(blob).not.toMatch(/Bearer sk-prior-secret/i);
    expect(blob).not.toMatch(/Bearer sk-original/i);
    expect(blob).not.toMatch(/MUSTER_BRIDGE_TOKEN_SECRET/);
    expect(blob).not.toMatch(/MUSTER_BRIDGE_TOKEN_LEAK/);
    expect(blob).not.toMatch(/MUSTER_BRIDGE_TOKEN=abc123/);
    expect(blob).not.toMatch(/MUSTER_BRIDGE_TOKEN=xyz/);
    expect(blob).toMatch(/\[redacted\]/i);
  });

  it('fails closed when core content exceeds budget (no context-less prompt)', () => {
    // Varied content so the run-collapse sanitizer does not shrink the payload.
    const hugeGoal = Array.from({ length: COMPILED_PROMPT_MAX }, (_, i) =>
      String.fromCharCode(65 + (i % 26)),
    ).join('');
    const result = buildFreshSessionRecoveryPrompt({
      goal: hugeGoal,
      brief: sampleBrief({
        objective: Array.from({ length: 1000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''),
      }),
      maxChars: 500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('prompt_budget_exceeded');
    expect(result.message).toMatch(/budget/i);
  });

  it('drops optional sections under budget before failing the protected core', () => {
    const result = buildFreshSessionRecoveryPrompt({
      goal: 'Keep the goal',
      brief: sampleBrief({
        objective: 'Keep objective',
        context: 'C'.repeat(2000),
      }),
      priorOutcomes: ['P'.repeat(2000)],
      originalPrompt: 'O'.repeat(2000),
      maxChars: 900,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.length).toBeLessThanOrEqual(900);
    expect(result.prompt).toContain('Keep the goal');
    expect(result.prompt).toContain('Keep objective');
    // Optional bulk should be reduced/omitted rather than truncating the core mid-header.
    expect(result.prompt).toMatch(/## Session recovery/);
  });

  it('fails empty goal with empty_recovery_prompt rather than inventing content', () => {
    const result = buildFreshSessionRecoveryPrompt({
      goal: '   ',
      originalPrompt: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('empty_recovery_prompt');
  });

  it('OrThrow adapter throws budget-shaped errors for runAcpTurn sticky hook', () => {
    expect(() =>
      buildFreshSessionRecoveryPromptOrThrow({
        goal: 'x'.repeat(10_000),
        maxChars: 50,
      }),
    ).toThrow(/budget|recovery prompt/i);

    const prompt = buildFreshSessionRecoveryPromptOrThrow({
      goal: 'Continue implementing readiness recovery',
      brief: sampleBrief(),
    });
    expect(prompt).toContain('Continue implementing readiness recovery');
  });
});

describe('sanitizeRecoveryPromptText', () => {
  it('redacts secrets without the handoff 240-char diagnostic cap', () => {
    // Authorization redaction is line-scoped (through EOL), so put bulk body
    // on separate lines — mirrors real multi-line prompt dumps.
    const long = [
      'prefix',
      'Authorization: Bearer sk-long-secret',
      'safe '.repeat(80).trimEnd(),
      'MUSTER_BRIDGE_TOKEN=value',
    ].join('\n');
    const cleaned = sanitizeRecoveryPromptText(long);
    expect(cleaned.length).toBeGreaterThan(240);
    expect(cleaned).not.toMatch(/Bearer sk-long-secret/i);
    expect(cleaned).not.toMatch(/MUSTER_BRIDGE_TOKEN=value/);
    expect(cleaned).toContain('safe');
  });
});
