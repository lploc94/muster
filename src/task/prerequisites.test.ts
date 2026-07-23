import { describe, expect, it } from 'vitest';
import {
  evaluatePrerequisite,
  isPrerequisiteMet,
  validatePrerequisites,
  type PrerequisiteGraph,
} from './prerequisites';
import type { TaskPrerequisite, TaskLifecycleState } from './types';

const LIFECYCLES: (TaskLifecycleState | undefined)[] = [
  undefined,
  'open',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
];

function prerequisite(overrides: Partial<TaskPrerequisite> = {}): TaskPrerequisite {
  return {
    producerTaskId: 'dep-1',
    requiredLifecycle: 'succeeded',
    onUnmet: 'block',
    ...overrides,
  };
}

describe('isPrerequisiteMet', () => {
  it.each([
    ['succeeded', 'succeeded', true],
    ['succeeded', 'failed', false],
    ['succeeded', 'open', false],
    ['succeeded', undefined, false],
    ['terminal', 'succeeded', true],
    ['terminal', 'failed', true],
    ['terminal', 'cancelled', true],
    ['terminal', 'skipped', true],
    ['terminal', 'open', false],
    ['terminal', undefined, false],
  ] as const)(
    'requiredLifecycle=%s lifecycle=%s → %s',
    (requiredLifecycle, lifecycle, expected) => {
      expect(
        isPrerequisiteMet(
          prerequisite({ requiredLifecycle }),
          lifecycle as TaskLifecycleState | undefined,
        ),
      ).toBe(expected);
    },
  );
});

describe('evaluatePrerequisite', () => {
  const outcomes = ['succeeded', 'terminal'] as const;
  const onUnmet = ['block', 'fail', 'skip'] as const;

  for (const requiredLifecycle of outcomes) {
    for (const lifecycle of LIFECYCLES) {
      it(`requiredLifecycle=${requiredLifecycle} lifecycle=${String(lifecycle)}`, () => {
        for (const policy of onUnmet) {
          const result = evaluatePrerequisite(
            prerequisite({ requiredLifecycle, onUnmet: policy }),
            lifecycle,
          );
          if (isPrerequisiteMet(prerequisite({ requiredLifecycle }), lifecycle)) {
            expect(result).toBe('met');
          } else if (lifecycle === undefined || lifecycle === 'open') {
            expect(result).toBe('pending');
          } else if (requiredLifecycle === 'terminal') {
            expect(result).toBe('met');
          } else {
            expect(result).toBe(policy);
          }
        }
      });
    }
  }
});

describe('evaluatePrerequisite with requiredVerdict', () => {
  const policies = ['block', 'fail', 'skip'] as const;
  const verdicts = ['pass', 'fail', 'inconclusive', undefined] as const;

  for (const policy of policies) {
    for (const verdict of verdicts) {
      it(`succeeded producer, onUnmet=${policy}, verdict=${String(verdict)}`, () => {
        const requirement = prerequisite({ requiredLifecycle: 'succeeded', onUnmet: policy, requiredVerdict: 'pass' });
        const outcome = evaluatePrerequisite(requirement, 'succeeded', verdict);
        // Only a passing verdict satisfies; anything else routes to onUnmet.
        expect(outcome).toBe(verdict === 'pass' ? 'met' : policy);
      });
    }
  }

  it('does not satisfy on a non-terminal producer even with a pass verdict pending', () => {
    const requirement = prerequisite({ requiredVerdict: 'pass' });
    expect(evaluatePrerequisite(requirement, 'open', 'pass')).toBe('pending');
    expect(evaluatePrerequisite(requirement, undefined, 'pass')).toBe('pending');
  });

  it('a failed producer stays terminal-unsatisfied regardless of verdict', () => {
    const requirement = prerequisite({ requiredLifecycle: 'succeeded', onUnmet: 'fail', requiredVerdict: 'pass' });
    expect(evaluatePrerequisite(requirement, 'failed', 'pass')).toBe('fail');
  });

  it('ignores verdict entirely when requiredVerdict is absent (unchanged behavior)', () => {
    const requirement = prerequisite({ requiredLifecycle: 'succeeded', onUnmet: 'block' });
    expect(evaluatePrerequisite(requirement, 'succeeded', 'fail')).toBe('met');
    expect(evaluatePrerequisite(requirement, 'succeeded', undefined)).toBe('met');
    expect(isPrerequisiteMet(requirement, 'succeeded', 'fail')).toBe(true);
  });

  it('terminal requiredLifecycle still honors the verdict gate', () => {
    const requirement = prerequisite({ requiredLifecycle: 'terminal', onUnmet: 'skip', requiredVerdict: 'pass' });
    expect(evaluatePrerequisite(requirement, 'failed', 'pass')).toBe('met');
    expect(evaluatePrerequisite(requirement, 'failed', 'fail')).toBe('skip');
  });
});

function makeGraph(edges: Record<string, string[]>, roots: Record<string, string>): PrerequisiteGraph {
  return {
    rootOf: (taskId) => roots[taskId],
    prerequisitesOf: (taskId) => edges[taskId] ?? [],
  };
}

describe('validatePrerequisites', () => {
  it('rejects a self-prerequisite', () => {
    const graph = makeGraph({}, { 'task-a': 'root' });
    const result = validatePrerequisites(
      { taskId: 'task-a', rootId: 'root' },
      [prerequisite({ producerTaskId: 'task-a' })],
      graph,
      false,
    );
    expect(result).toEqual({ ok: false, reason: 'prerequisite cycle detected' });
  });

  it('rejects multi-node cycle A→B→C→A', () => {
    const graph = makeGraph(
      { 'task-b': ['task-c'], 'task-c': ['task-a'] },
      { 'task-a': 'root', 'task-b': 'root', 'task-c': 'root' },
    );
    const result = validatePrerequisites(
      { taskId: 'task-a', rootId: 'root' },
      [prerequisite({ producerTaskId: 'task-b' })],
      graph,
      false,
    );
    expect(result).toEqual({ ok: false, reason: 'prerequisite cycle detected' });
  });

  it('rejects a cross-root prerequisite', () => {
    const graph = makeGraph({}, { 'other-task': 'other-root' });
    const result = validatePrerequisites(
      { taskId: 'task-a', rootId: 'root' },
      [prerequisite({ producerTaskId: 'other-task' })],
      graph,
      false,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'prerequisite other-task is not in the same root graph',
    });
  });

  it('rejects prerequisite mutation after first turn queued', () => {
    const graph = makeGraph({}, { 'dep-1': 'root' });
    const result = validatePrerequisites(
      { taskId: 'task-a', rootId: 'root' },
      [prerequisite()],
      graph,
      true,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'prerequisites are immutable after the first turn is queued',
    });
  });

  it('rejects clearing prerequisites after first turn queued', () => {
    const graph = makeGraph({}, { 'dep-1': 'root' });
    const existing = [prerequisite()];
    const result = validatePrerequisites(
      { taskId: 'task-a', rootId: 'root' },
      [],
      graph,
      true,
      existing,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'prerequisites are immutable after the first turn is queued',
    });
  });

  it('allows re-validation of unchanged prerequisites after first turn queued', () => {
    const graph = makeGraph({}, { 'dep-1': 'root' });
    const existing = [prerequisite()];
    const result = validatePrerequisites(
      { taskId: 'task-a', rootId: 'root' },
      existing,
      graph,
      true,
      existing,
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts valid same-root acyclic prerequisites', () => {
    const graph = makeGraph({ 'dep-1': [] }, { 'dep-1': 'root' });
    const result = validatePrerequisites(
      { taskId: 'task-a', rootId: 'root' },
      [prerequisite()],
      graph,
      false,
    );
    expect(result).toEqual({ ok: true });
  });
});
