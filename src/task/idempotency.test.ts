import { describe, expect, it } from 'vitest';
import { resolveChildWait, stageDisposition } from './transitions';
import type { MusterTask, TaskLifecycleState, TaskTurn } from './types';

const NOW = '2026-07-06T00:00:00.000Z';

function baseTask(overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id: 'task-1',
    role: 'coordinator',
    lifecycle: 'open',
    goal: 'test',
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: {
      maxTurns: 10,
      maxAutomaticRetries: 2,
      turnTimeoutMs: 60_000,
      taskTimeoutMs: 300_000,
    },
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function turn(overrides: Partial<TaskTurn> & Pick<TaskTurn, 'id' | 'status'>): TaskTurn {
  return {
    taskId: 'task-1',
    sequence: 1,
    trigger: 'user',
    inputs: [],
    createdAt: NOW,
    ...overrides,
  };
}

describe('stageDisposition idempotency', () => {
  const live = turn({ id: 't1', status: 'running', sequence: 1 });
  const limits = { maxResult: 5, maxError: 5 };

  it('stages once and replays same opId with equal disposition', () => {
    const disposition = { kind: 'complete' as const, result: 'hello' };
    const first = stageDisposition(live, disposition, 'op-1', { limits });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const second = stageDisposition(first.next.turn, disposition, 'op-1', {
      acceptedOpId: first.next.acceptedOpId,
      limits,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.next.turn).toBe(first.next.turn);
      expect(second.next.acceptedOpId).toBe('op-1');
    }
  });

  it('rejects same opId with different disposition', () => {
    const first = stageDisposition(
      live,
      { kind: 'complete', result: 'hello' },
      'op-1',
      { limits },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const second = stageDisposition(
      first.next.turn,
      { kind: 'complete', result: 'world' },
      'op-1',
      { acceptedOpId: 'op-1', limits },
    );
    expect(second).toEqual({ ok: false, reason: 'same opId with different disposition' });
  });

  it('rejects a different opId once staged', () => {
    const first = stageDisposition(live, { kind: 'idle' }, 'op-1', {});
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const second = stageDisposition(first.next.turn, { kind: 'idle' }, 'op-2', {});
    expect(second).toEqual({
      ok: false,
      reason: 'disposition already staged with a different opId',
    });
  });

  it('clamps over-long complete/fail payloads', () => {
    const complete = stageDisposition(
      live,
      { kind: 'complete', result: '123456789' },
      'op-1',
      { limits: { maxResult: 5, maxError: 5 } },
    );
    expect(complete.ok).toBe(true);
    if (complete.ok) {
      expect(complete.next.turn.disposition).toEqual({ kind: 'complete', result: '12345' });
    }

    const fail = stageDisposition(
      turn({ id: 't2', status: 'waiting_user', sequence: 1 }),
      { kind: 'fail', error: 'abcdefgh' },
      'op-2',
      { limits: { maxResult: 5, maxError: 3 } },
    );
    expect(fail.ok).toBe(true);
    if (fail.ok) {
      expect(fail.next.turn.disposition).toEqual({ kind: 'fail', error: 'abc' });
    }
  });

  it('rejects complete/fail without limits', () => {
    expect(
      stageDisposition(live, { kind: 'complete', result: 'x' }, 'op-1', {}),
    ).toEqual({
      ok: false,
      reason: 'limits are required for complete or fail dispositions',
    });
    expect(
      stageDisposition(live, { kind: 'fail', error: 'x' }, 'op-1', {}),
    ).toEqual({
      ok: false,
      reason: 'limits are required for complete or fail dispositions',
    });
  });

  it('rejects staging on non-live turns', () => {
    expect(
      stageDisposition(turn({ id: 't3', status: 'queued', sequence: 1 }), { kind: 'idle' }, 'op-1', {}),
    ).toEqual({ ok: false, reason: 'stageDisposition requires a live turn' });
  });
});

describe('resolveChildWait idempotency', () => {
  const task = baseTask({
    wait: { kind: 'children', taskIds: ['child-1'], registeredByTurnId: 't1' },
  });
  const lifecycles = new Map<string, TaskLifecycleState>([['child-1', 'succeeded']]);

  it('does not treat an older continuation as satisfying a later wait', () => {
    const firstWait = baseTask({
      wait: { kind: 'children', taskIds: ['child-1'], registeredByTurnId: 't1' },
    });
    const turns: TaskTurn[] = [
      turn({ id: 't1', status: 'succeeded', sequence: 1 }),
      {
        ...turn({ id: 'cont-old', status: 'queued', sequence: 5 }),
        trigger: 'engine',
        inputs: [{ kind: 'child_results', taskIds: ['child-1'] }],
      },
      turn({ id: 't8', status: 'succeeded', sequence: 8 }),
    ];
    const secondWait = baseTask({
      wait: { kind: 'children', taskIds: ['child-1'], registeredByTurnId: 't8' },
    });

    const result = resolveChildWait(
      secondWait,
      new Map([['child-1', 'succeeded']]),
      turns,
      { continuationTurnId: 'cont-new', now: NOW },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.turn?.id).toBe('cont-new');
      expect(result.effects).toEqual([{ kind: 'scheduleContinuation', waitTurnId: 't8' }]);
    }
  });

  it('creates exactly one continuation turn and effect across duplicate calls', () => {
    const first = resolveChildWait(task, lifecycles, [], {
      continuationTurnId: 'cont-1',
      now: NOW,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.next.turn?.id).toBe('cont-1');
    expect(first.next.task.wait).toBeUndefined();
    expect(first.effects).toEqual([{ kind: 'scheduleContinuation', waitTurnId: 't1' }]);

    const turns = first.next.turn ? [first.next.turn] : [];
    const second = resolveChildWait(first.next.task, lifecycles, turns, {
      continuationTurnId: 'cont-1',
      now: NOW,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.next.turn).toBeUndefined();
      expect(second.effects).toEqual([]);
    }
  });
});