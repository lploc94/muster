import { describe, expect, it } from 'vitest';
import { canPromoteTurn, dependenciesBlockTask, dependencyTerminalOutcome } from './scheduler';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import type { MusterTask, TaskDependency, TaskStoreFile, TaskVerdict } from './types';

function baseFile(): TaskStoreFile {
  return {
    schemaVersion: 2,
    revision: 1,
    tasks: {
      root: {
        id: 'root',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'root',
        parentId: null,
        dependencies: [],
        backend: 'grok',
        capabilities: [],
        executionPolicy: {
          maxTurns: 10,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 120_000,
        },
        revision: 0,
        createdAt: 't',
        updatedAt: 't',
      },
    },
    turns: {
      t1: {
        id: 't1',
        taskId: 'root',
        sequence: 1,
        trigger: 'user',
        status: 'queued',
        inputs: [],
        createdAt: 't',
      },
    },
    messages: {},
    operations: {},
    cancelRequests: {},
  };
}

describe('scheduler', () => {
  it('allows promoting a lone queued turn', () => {
    expect(canPromoteTurn(baseFile(), 't1', DEFAULT_RESOURCE_LIMITS).ok).toBe(true);
  });

  it('blocks when task already has a running turn', () => {
    const file = baseFile();
    file.turns.t2 = {
      id: 't2',
      taskId: 'root',
      sequence: 2,
      trigger: 'engine',
      status: 'running',
      inputs: [],
      createdAt: 't',
      startedAt: 't',
    };
    expect(canPromoteTurn(file, 't1', DEFAULT_RESOURCE_LIMITS).ok).toBe(false);
  });

  it('blocks promoting a later FIFO queued turn before an earlier one', () => {
    const file = baseFile();
    file.turns.t2 = {
      id: 't2',
      taskId: 'root',
      sequence: 2,
      trigger: 'user',
      status: 'queued',
      inputs: [],
      createdAt: 't2',
    };
    expect(canPromoteTurn(file, 't1', DEFAULT_RESOURCE_LIMITS)).toEqual({ ok: true });
    expect(canPromoteTurn(file, 't2', DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'earlier queued turn must run first',
    });
  });

  it('blocks promotion while task.wait children or external is active', () => {
    const children = baseFile();
    children.tasks.root = {
      ...children.tasks.root!,
      wait: { kind: 'children', taskIds: ['c1'], registeredByTurnId: 'prev' },
    };
    expect(canPromoteTurn(children, 't1', DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'waiting on child tasks',
    });

    const external = baseFile();
    external.tasks.root = {
      ...external.tasks.root!,
      wait: { kind: 'external', key: 'manual' },
    };
    expect(canPromoteTurn(external, 't1', DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'waiting on external blocker',
    });
  });

  it('blocks promotion while holdAutoPromote is set', () => {
    const file = baseFile();
    file.turns.t1 = { ...file.turns.t1!, holdAutoPromote: true };
    expect(canPromoteTurn(file, 't1', DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'held after previous turn failure',
    });
  });

  it('blocks promotion while dependencies are unsatisfied', () => {
    const file = baseFile();
    file.tasks.dep = {
      id: 'dep',
      role: 'worker',
      lifecycle: 'open',
      goal: 'dep',
      parentId: null,
      dependencies: [],
      backend: 'grok',
      capabilities: [],
      executionPolicy: file.tasks.root!.executionPolicy,
      revision: 0,
      createdAt: 't',
      updatedAt: 't',
    };
    file.tasks.root = {
      ...file.tasks.root!,
      dependencies: [{ taskId: 'dep', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
    };
    expect(canPromoteTurn(file, 't1', DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'dependencies not satisfied',
    });
  });
});

describe('verdict-gated dependencies (verify-gate-loop Phase A)', () => {
  function verdict(status: TaskVerdict['status']): TaskVerdict {
    return { status, source: 'worker', at: 't0' };
  }

  function makeTask(partial: Partial<MusterTask> & { id: string }): MusterTask {
    return {
      role: 'worker',
      lifecycle: 'open',
      goal: 'g',
      parentId: 'root',
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
      createdAt: 't',
      updatedAt: 't',
      ...partial,
    };
  }

  function gatedFile(dep: TaskDependency, producer: Partial<MusterTask>): TaskStoreFile {
    return {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        verify: makeTask({ id: 'verify', ...producer }),
        impl: makeTask({ id: 'impl', dependencies: [dep] }),
      },
      turns: {},
      messages: {},
      operations: {},
      cancelRequests: {},
    };
  }

  const failGate: TaskDependency = {
    taskId: 'verify',
    requiredOutcome: 'succeeded',
    onUnsatisfied: 'fail',
    requiredVerdict: 'pass',
  };

  it('a failing verdict on a succeeded producer seals the dependent as failed (no hang)', () => {
    const file = gatedFile(failGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's', verdict: verdict('fail') },
    });
    expect(dependencyTerminalOutcome(file, 'impl')).toBe('failed');
    expect(dependenciesBlockTask(file, 'impl')).toBe(true);
  });

  it('an absent verdict on a succeeded producer also seals the dependent as failed', () => {
    const file = gatedFile(failGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's' },
    });
    expect(dependencyTerminalOutcome(file, 'impl')).toBe('failed');
  });

  it('a passing verdict satisfies the gate: no terminal seal and not blocked', () => {
    const file = gatedFile(failGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's', verdict: verdict('pass') },
    });
    expect(dependencyTerminalOutcome(file, 'impl')).toBeUndefined();
    expect(dependenciesBlockTask(file, 'impl')).toBe(false);
  });

  it('onUnsatisfied:block with a failing verdict blocks but does not seal (Phase B remediation)', () => {
    const blockGate: TaskDependency = { ...failGate, onUnsatisfied: 'block' };
    const file = gatedFile(blockGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's', verdict: verdict('fail') },
    });
    expect(dependencyTerminalOutcome(file, 'impl')).toBeUndefined();
    expect(dependenciesBlockTask(file, 'impl')).toBe(true);
  });

  it('without requiredVerdict, a failing verdict is ignored (unchanged behavior)', () => {
    const plainGate: TaskDependency = {
      taskId: 'verify',
      requiredOutcome: 'succeeded',
      onUnsatisfied: 'fail',
    };
    const file = gatedFile(plainGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's', verdict: verdict('fail') },
    });
    expect(dependencyTerminalOutcome(file, 'impl')).toBeUndefined();
    expect(dependenciesBlockTask(file, 'impl')).toBe(false);
  });
});