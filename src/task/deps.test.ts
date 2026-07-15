import { describe, expect, it } from 'vitest';
import {
  evaluateDependency,
  isDependencySatisfied,
  validateDependencies,
  type DepGraph,
} from './deps';
import type { TaskDependency, TaskLifecycleState } from './types';

const LIFECYCLES: (TaskLifecycleState | undefined)[] = [
  undefined,
  'open',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
];

function dep(overrides: Partial<TaskDependency> = {}): TaskDependency {
  return {
    taskId: 'dep-1',
    requiredOutcome: 'succeeded',
    onUnsatisfied: 'block',
    ...overrides,
  };
}

describe('isDependencySatisfied', () => {
  it.each([
    ['succeeded', 'succeeded', true],
    ['succeeded', 'failed', false],
    ['succeeded', 'open', false],
    ['succeeded', undefined, false],
    ['settled', 'succeeded', true],
    ['settled', 'failed', true],
    ['settled', 'cancelled', true],
    ['settled', 'skipped', true],
    ['settled', 'open', false],
    ['settled', undefined, false],
  ] as const)(
    'requiredOutcome=%s lifecycle=%s → %s',
    (requiredOutcome, lifecycle, expected) => {
      expect(
        isDependencySatisfied(
          dep({ requiredOutcome }),
          lifecycle as TaskLifecycleState | undefined,
        ),
      ).toBe(expected);
    },
  );
});

describe('evaluateDependency', () => {
  const outcomes = ['succeeded', 'settled'] as const;
  const onUnsatisfied = ['block', 'fail', 'skip'] as const;

  for (const requiredOutcome of outcomes) {
    for (const lifecycle of LIFECYCLES) {
      it(`requiredOutcome=${requiredOutcome} lifecycle=${String(lifecycle)}`, () => {
        for (const policy of onUnsatisfied) {
          const result = evaluateDependency(
            dep({ requiredOutcome, onUnsatisfied: policy }),
            lifecycle,
          );
          if (isDependencySatisfied(dep({ requiredOutcome }), lifecycle)) {
            expect(result).toBe('satisfied');
          } else if (lifecycle === undefined || lifecycle === 'open') {
            expect(result).toBe('pending');
          } else if (requiredOutcome === 'settled') {
            expect(result).toBe('satisfied');
          } else {
            expect(result).toBe(policy);
          }
        }
      });
    }
  }
});

describe('evaluateDependency with requiredVerdict', () => {
  const policies = ['block', 'fail', 'skip'] as const;
  const verdicts = ['pass', 'fail', 'inconclusive', undefined] as const;

  for (const policy of policies) {
    for (const verdict of verdicts) {
      it(`succeeded producer, onUnsatisfied=${policy}, verdict=${String(verdict)}`, () => {
        const d = dep({ requiredOutcome: 'succeeded', onUnsatisfied: policy, requiredVerdict: 'pass' });
        const outcome = evaluateDependency(d, 'succeeded', verdict);
        // Only a passing verdict satisfies; anything else routes to onUnsatisfied.
        expect(outcome).toBe(verdict === 'pass' ? 'satisfied' : policy);
      });
    }
  }

  it('does not satisfy on a non-terminal producer even with a pass verdict pending', () => {
    const d = dep({ requiredVerdict: 'pass' });
    expect(evaluateDependency(d, 'open', 'pass')).toBe('pending');
    expect(evaluateDependency(d, undefined, 'pass')).toBe('pending');
  });

  it('a failed producer stays terminal-unsatisfied regardless of verdict', () => {
    const d = dep({ requiredOutcome: 'succeeded', onUnsatisfied: 'fail', requiredVerdict: 'pass' });
    expect(evaluateDependency(d, 'failed', 'pass')).toBe('fail');
  });

  it('ignores verdict entirely when requiredVerdict is absent (unchanged behavior)', () => {
    const d = dep({ requiredOutcome: 'succeeded', onUnsatisfied: 'block' });
    expect(evaluateDependency(d, 'succeeded', 'fail')).toBe('satisfied');
    expect(evaluateDependency(d, 'succeeded', undefined)).toBe('satisfied');
    expect(isDependencySatisfied(d, 'succeeded', 'fail')).toBe(true);
  });

  it('settled requiredOutcome still honors the verdict gate', () => {
    const d = dep({ requiredOutcome: 'settled', onUnsatisfied: 'skip', requiredVerdict: 'pass' });
    expect(evaluateDependency(d, 'failed', 'pass')).toBe('satisfied');
    expect(evaluateDependency(d, 'failed', 'fail')).toBe('skip');
  });
});

function makeGraph(edges: Record<string, string[]>, roots: Record<string, string>): DepGraph {
  return {
    rootOf: (taskId) => roots[taskId],
    dependsOn: (taskId) => edges[taskId] ?? [],
  };
}

describe('validateDependencies', () => {
  it('rejects self-dependency', () => {
    const graph = makeGraph({}, { 'task-a': 'root' });
    const result = validateDependencies(
      { taskId: 'task-a', rootId: 'root' },
      [dep({ taskId: 'task-a' })],
      graph,
      false,
    );
    expect(result).toEqual({ ok: false, reason: 'dependency cycle detected' });
  });

  it('rejects multi-node cycle A→B→C→A', () => {
    const graph = makeGraph(
      { 'task-b': ['task-c'], 'task-c': ['task-a'] },
      { 'task-a': 'root', 'task-b': 'root', 'task-c': 'root' },
    );
    const result = validateDependencies(
      { taskId: 'task-a', rootId: 'root' },
      [dep({ taskId: 'task-b' })],
      graph,
      false,
    );
    expect(result).toEqual({ ok: false, reason: 'dependency cycle detected' });
  });

  it('rejects cross-root dependency', () => {
    const graph = makeGraph({}, { 'other-task': 'other-root' });
    const result = validateDependencies(
      { taskId: 'task-a', rootId: 'root' },
      [dep({ taskId: 'other-task' })],
      graph,
      false,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'dependency other-task is not in the same root graph',
    });
  });

  it('rejects dependency mutation after first turn queued', () => {
    const graph = makeGraph({}, { 'dep-1': 'root' });
    const result = validateDependencies(
      { taskId: 'task-a', rootId: 'root' },
      [dep()],
      graph,
      true,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'dependencies are immutable after the first turn is queued',
    });
  });

  it('rejects clearing dependencies after first turn queued', () => {
    const graph = makeGraph({}, { 'dep-1': 'root' });
    const existing = [dep()];
    const result = validateDependencies(
      { taskId: 'task-a', rootId: 'root' },
      [],
      graph,
      true,
      existing,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'dependencies are immutable after the first turn is queued',
    });
  });

  it('allows re-validation of unchanged dependencies after first turn queued', () => {
    const graph = makeGraph({}, { 'dep-1': 'root' });
    const existing = [dep()];
    const result = validateDependencies(
      { taskId: 'task-a', rootId: 'root' },
      existing,
      graph,
      true,
      existing,
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts valid same-root acyclic dependencies', () => {
    const graph = makeGraph({ 'dep-1': [] }, { 'dep-1': 'root' });
    const result = validateDependencies(
      { taskId: 'task-a', rootId: 'root' },
      [dep()],
      graph,
      false,
    );
    expect(result).toEqual({ ok: true });
  });
});