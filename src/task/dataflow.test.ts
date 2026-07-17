import { describe, expect, it } from 'vitest';
import {
  buildTaskResultFromSummary,
  clampSummary,
  effectiveTaskResult,
  formatPinnedInputsForPrompt,
  pinResolvedInputs,
  resolveInputBindings,
  TASK_RESULT_SUMMARY_MAX,
  validateBindingsForRelease,
} from './dataflow';
import type { MusterTask, TaskTurn } from './types';

function task(partial: Partial<MusterTask> & { id: string }): MusterTask {
  return {
    role: 'worker',
    lifecycle: 'open',
    goal: 'g',
    parentId: null,
    dependencies: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: {
      maxTurns: 10,
      maxAutomaticRetries: 0,
      turnTimeoutMs: 60_000,
      taskTimeoutMs: 120_000,
    },
    revision: 0,
    createdAt: 't0',
    updatedAt: 't0',
    ...partial,
  };
}

function turn(partial: Partial<TaskTurn> & { id: string }): TaskTurn {
  return {
    taskId: 'impl',
    sequence: 1,
    trigger: 'engine',
    status: 'queued',
    inputs: [],
    createdAt: 't0',
    ...partial,
  };
}

describe('buildTaskResultFromSummary', () => {
  it('starts at revision 1 and clamps summary', () => {
    const r = buildTaskResultFromSummary('hello');
    expect(r).toEqual({ version: 1, revision: 1, summary: 'hello' });
    const long = 'x'.repeat(TASK_RESULT_SUMMARY_MAX + 50);
    const clamped = buildTaskResultFromSummary(long);
    expect(clamped.truncated).toBe(true);
    expect(Buffer.byteLength(clamped.summary, 'utf8')).toBeLessThanOrEqual(TASK_RESULT_SUMMARY_MAX);
  });

  it('increments revision from previous', () => {
    const first = buildTaskResultFromSummary('a');
    const second = buildTaskResultFromSummary('b', first);
    expect(second.revision).toBe(2);
    expect(second.summary).toBe('b');
  });

  it('omits verdict when none is provided', () => {
    expect(buildTaskResultFromSummary('s')).toEqual({ version: 1, revision: 1, summary: 's' });
    expect('verdict' in buildTaskResultFromSummary('s')).toBe(false);
  });

  it('persists a provided verdict on the result', () => {
    const verdict = { status: 'pass', source: 'worker', at: 't0' } as const;
    const r = buildTaskResultFromSummary('s', undefined, verdict);
    expect(r.verdict).toEqual(verdict);
  });
});

describe('effectiveTaskResult', () => {
  it('returns the structured result', () => {
    const t = task({
      id: 'p',
      taskResult: { version: 1, revision: 3, summary: 'structured' },
    });
    expect(effectiveTaskResult(t)?.summary).toBe('structured');
    expect(effectiveTaskResult(t)?.revision).toBe(3);
  });

  it('returns undefined when no structured result exists', () => {
    expect(effectiveTaskResult(task({ id: 'p' }))).toBeUndefined();
  });
});

describe('resolveInputBindings', () => {
  it('returns empty pins when no bindings', () => {
    expect(resolveInputBindings(undefined, {})).toEqual({ ok: true, pins: [] });
  });

  it('resolves summary binding from producer taskResult', () => {
    const producers = {
      plan: task({
        id: 'plan',
        lifecycle: 'succeeded',
        taskResult: { version: 1, revision: 2, summary: 'do X then Y' },
      }),
    };
    const result = resolveInputBindings(
      [{ fromTaskId: 'plan', output: 'summary', as: 'implementationPlan' }],
      producers,
    );
    expect(result).toEqual({
      ok: true,
      pins: [
        {
          as: 'implementationPlan',
          fromTaskId: 'plan',
          output: 'summary',
          producerResultRevision: 2,
          text: 'do X then Y',
        },
      ],
    });
  });

  it('fails required missing producer result', () => {
    const result = resolveInputBindings(
      [{ fromTaskId: 'plan', output: 'summary', as: 'implementationPlan' }],
      { plan: task({ id: 'plan', lifecycle: 'succeeded' }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing?.[0]?.fromTaskId).toBe('plan');
    }
  });

  it('resolves a verdict binding to rendered verdict text', () => {
    const producers = {
      verify: task({
        id: 'verify',
        lifecycle: 'succeeded',
        taskResult: {
          version: 1,
          revision: 4,
          summary: 'checked',
          verdict: { status: 'fail', source: 'worker', at: 't0', rationale: 'unit tests failed' },
        },
      }),
    };
    const result = resolveInputBindings(
      [{ fromTaskId: 'verify', output: 'verdict', as: 'verify_failure' }],
      producers,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pins[0].output).toBe('verdict');
    expect(result.pins[0].producerResultRevision).toBe(4);
    expect(result.pins[0].text).toContain('status: fail');
    expect(result.pins[0].text).toContain('rationale: unit tests failed');
  });

  it('treats a required verdict binding as missing when the producer has no verdict', () => {
    const producers = {
      verify: task({
        id: 'verify',
        lifecycle: 'succeeded',
        taskResult: { version: 1, revision: 1, summary: 'no verdict here' },
      }),
    };
    const result = resolveInputBindings(
      [{ fromTaskId: 'verify', output: 'verdict', as: 'v' }],
      producers,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing?.[0]).toMatchObject({ fromTaskId: 'verify', output: 'verdict' });
    }
  });

  it('skips an optional verdict binding when the producer has no verdict', () => {
    const producers = {
      verify: task({
        id: 'verify',
        lifecycle: 'succeeded',
        taskResult: { version: 1, revision: 1, summary: 's' },
      }),
    };
    const result = resolveInputBindings(
      [{ fromTaskId: 'verify', output: 'verdict', as: 'v', required: false }],
      producers,
    );
    expect(result).toEqual({ ok: true, pins: [] });
  });

  it('rejects non-summary output keys in v1', () => {
    const result = resolveInputBindings(
      [{ fromTaskId: 'plan', output: 'plan' as 'summary', as: 'p' }],
      {
        plan: task({
          id: 'plan',
          taskResult: { version: 1, revision: 1, summary: 'x' },
        }),
      },
    );
    // cast above forces type; validateBindings catches real non-summary
    expect(validateBindingsForRelease([{ fromTaskId: 'a', output: 'summary', as: 'x' }]).ok).toBe(
      true,
    );
    expect(
      validateBindingsForRelease([
        { fromTaskId: 'a', output: 'artifact' as 'summary', as: 'x' },
      ]).ok,
    ).toBe(false);
    void result;
  });
});

describe('pinResolvedInputs', () => {
  it('treats empty resolvedInputs array as already pinned', () => {
    const t0 = turn({ id: 't1', resolvedInputs: [] });
    const attempt = pinResolvedInputs(t0, [
      {
        as: 'x',
        fromTaskId: 'p',
        output: 'summary',
        producerResultRevision: 1,
        text: 'later',
      },
    ]);
    expect(attempt.ok).toBe(false);
  });

  it('pins once and is idempotent for same content', () => {
    const pins = [
      {
        as: 'implementationPlan',
        fromTaskId: 'plan',
        output: 'summary' as const,
        producerResultRevision: 2,
        text: 'do X',
      },
    ];
    const t0 = turn({ id: 't1' });
    const first = pinResolvedInputs(t0, pins, 'compiled');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.next.resolvedInputs).toEqual(pins);
    expect(first.next.compiledPrompt).toBe('compiled');

    const second = pinResolvedInputs(first.next, pins, 'compiled');
    expect(second.ok).toBe(true);

    const conflict = pinResolvedInputs(first.next, [{ ...pins[0]!, text: 'changed' }], 'compiled');
    expect(conflict).toEqual({
      ok: false,
      reason: 'resolvedInputs already pinned with different content',
    });
  });

  it('producer reopen does not rewrite existing pin texts', () => {
    const pins = [
      {
        as: 'implementationPlan',
        fromTaskId: 'plan',
        output: 'summary' as const,
        producerResultRevision: 1,
        text: 'original plan',
      },
    ];
    const pinned = pinResolvedInputs(turn({ id: 't1' }), pins);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;

    // Re-resolve against a "reopened" producer with new summary
    const re = resolveInputBindings(
      [{ fromTaskId: 'plan', output: 'summary', as: 'implementationPlan' }],
      {
        plan: task({
          id: 'plan',
          taskResult: { version: 1, revision: 9, summary: 'rewritten plan' },
        }),
      },
    );
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    // Engine must keep existing pin, not re-pin — pinResolvedInputs rejects overwrite
    const attempt = pinResolvedInputs(pinned.next, re.pins);
    expect(attempt.ok).toBe(false);
    expect(pinned.next.resolvedInputs?.[0]?.text).toBe('original plan');
  });
});

describe('formatPinnedInputsForPrompt', () => {
  it('frames untrusted inputs', () => {
    const text = formatPinnedInputsForPrompt([
      {
        as: 'implementationPlan',
        fromTaskId: 'plan',
        output: 'summary',
        producerResultRevision: 1,
        text: 'step one',
      },
    ]);
    expect(text).toContain('untrusted');
    expect(text).toContain('implementationPlan');
    expect(text).toContain('step one');
  });
});

describe('clampSummary', () => {
  it('no-ops under max', () => {
    expect(clampSummary('abc')).toBe('abc');
  });
});
