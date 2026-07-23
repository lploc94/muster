import { describe, expect, it } from 'vitest';
import { canPromoteTurn, prerequisitesBlockTask, prerequisiteTerminalLifecycle } from './scheduler';
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from './limits';
import type { MusterTask, TaskPrerequisite, EngineProjection, TaskTurn, TaskVerdict } from './types';

function baseFile(): EngineProjection {
  return {
    schemaVersion: 2,
    revision: 1,
    tasks: {
      root: {
        id: 'root',
        role: 'coordinator',
        lifecycle: 'open',
        releaseState: 'released',
        goal: 'root',
        parentId: null,
        prerequisites: [],
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

  it('allows only the start-workflow resume through a continuation wait', () => {
    const file = baseFile();
    file.turns.t1 = {
      ...file.turns.t1!,
      workflowWait: { hasOpenFeedbackRound: false, hasPendingContinuation: true },
    };
    expect(canPromoteTurn(file, 't1', DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'waiting on workflow continuation',
    });

    file.turns.t1 = {
      ...file.turns.t1!,
      workflowResume: {
        kind: 'start_workflow',
        runId: 'wfr_1',
        continuationId: 'wfcn_1',
      },
    };
    expect(canPromoteTurn(file, 't1', DEFAULT_RESOURCE_LIMITS)).toEqual({ ok: true });
  });

  it('blocks promotion while prerequisites are unmet', () => {
    const file = baseFile();
    file.tasks.dep = {
      id: 'dep',
      role: 'worker',
      lifecycle: 'open',
      releaseState: 'released',
      goal: 'dep',
      parentId: null,
      prerequisites: [],
      backend: 'grok',
      capabilities: [],
      executionPolicy: file.tasks.root!.executionPolicy,
      revision: 0,
      createdAt: 't',
      updatedAt: 't',
    };
    file.tasks.root = {
      ...file.tasks.root!,
      prerequisites: [{ producerTaskId: 'dep', requiredLifecycle: 'succeeded', onUnmet: 'block' }],
    };
    expect(canPromoteTurn(file, 't1', DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'prerequisites not met',
    });
  });

  // Explicit small caps (not DEFAULT_RESOURCE_LIMITS) so raising M016 defaults
  // cannot silently leave gate behavior untested at a convenient fixture size.
  const SMALL_CAPS: ResourceLimits = {
    ...DEFAULT_RESOURCE_LIMITS,
    maxConcurrentTurns: 2,
    maxConcurrentPerRoot: 2,
    maxConcurrentPerBackend: 1,
  };

  function siblingWorker(
    file: EngineProjection,
    id: string,
    backend: string,
    parentId: string | null = 'root',
  ): void {
    file.tasks[id] = {
      id,
      role: 'worker',
      lifecycle: 'open',
      goal: id,
      parentId,
      prerequisites: [],
      backend,
      capabilities: [],
      executionPolicy: file.tasks.root!.executionPolicy,
      revision: 0,
      createdAt: 't',
      updatedAt: 't',
    };
  }

  function runningTurn(taskId: string, id: string): TaskTurn {
    return {
      id,
      taskId,
      sequence: 1,
      trigger: 'engine',
      status: 'running',
      inputs: [],
      createdAt: 't',
      startedAt: 't',
    };
  }

  it('blocks on global concurrency limit with an explicit small cap', () => {
    const file = baseFile();
    siblingWorker(file, 'w1', 'other');
    siblingWorker(file, 'w2', 'other');
    // Two live turns already occupy the global cap of 2.
    file.turns.r1 = runningTurn('w1', 'r1');
    file.turns.r2 = runningTurn('w2', 'r2');
    expect(canPromoteTurn(file, 't1', SMALL_CAPS)).toEqual({
      ok: false,
      reason: 'global concurrency limit',
    });
  });

  it('blocks on root concurrency limit with an explicit small cap', () => {
    const file = baseFile();
    siblingWorker(file, 'w1', 'other');
    siblingWorker(file, 'w2', 'other');
    // Two children of root already occupy maxConcurrentPerRoot=2; root's t1 waits.
    file.turns.r1 = runningTurn('w1', 'r1');
    file.turns.r2 = runningTurn('w2', 'r2');
    // Raise global so root gate is the one that fires.
    const limits: ResourceLimits = { ...SMALL_CAPS, maxConcurrentTurns: 10 };
    expect(canPromoteTurn(file, 't1', limits)).toEqual({
      ok: false,
      reason: 'root concurrency limit',
    });
  });

  it('blocks on backend concurrency limit with an explicit small cap', () => {
    const file = baseFile();
    siblingWorker(file, 'w1', 'grok'); // same backend as root
    file.turns.r1 = runningTurn('w1', 'r1');
    // Raise global/root so backend gate is the one that fires.
    const limits: ResourceLimits = {
      ...SMALL_CAPS,
      maxConcurrentTurns: 10,
      maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 1,
    };
    expect(canPromoteTurn(file, 't1', limits)).toEqual({
      ok: false,
      reason: 'backend concurrency limit',
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
      prerequisites: [],
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

  function gatedFile(dep: TaskPrerequisite, producer: Partial<MusterTask>): EngineProjection {
    return {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        verify: makeTask({ id: 'verify', ...producer }),
        impl: makeTask({ id: 'impl', prerequisites: [dep] }),
      },
      turns: {},
      messages: {},
      operations: {},
      cancelRequests: {},
    };
  }

  const failGate: TaskPrerequisite = {
    producerTaskId: 'verify',
    requiredLifecycle: 'succeeded',
    onUnmet: 'fail',
    requiredVerdict: 'pass',
  };

  it('a failing verdict on a succeeded producer seals the dependent as failed (no hang)', () => {
    const file = gatedFile(failGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's', verdict: verdict('fail') },
    });
    expect(prerequisiteTerminalLifecycle(file, 'impl')).toBe('failed');
    expect(prerequisitesBlockTask(file, 'impl')).toBe(true);
  });

  it('an absent verdict on a succeeded producer also seals the dependent as failed', () => {
    const file = gatedFile(failGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's' },
    });
    expect(prerequisiteTerminalLifecycle(file, 'impl')).toBe('failed');
  });

  it('a passing verdict satisfies the gate: no terminal seal and not blocked', () => {
    const file = gatedFile(failGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's', verdict: verdict('pass') },
    });
    expect(prerequisiteTerminalLifecycle(file, 'impl')).toBeUndefined();
    expect(prerequisitesBlockTask(file, 'impl')).toBe(false);
  });

  it('onUnmet:block with a failing verdict blocks but does not seal (Phase B remediation)', () => {
    const blockGate: TaskPrerequisite = { ...failGate, onUnmet: 'block' };
    const file = gatedFile(blockGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's', verdict: verdict('fail') },
    });
    expect(prerequisiteTerminalLifecycle(file, 'impl')).toBeUndefined();
    expect(prerequisitesBlockTask(file, 'impl')).toBe(true);
  });

  it('without requiredVerdict, a failing verdict is ignored (unchanged behavior)', () => {
    const plainGate: TaskPrerequisite = {
      producerTaskId: 'verify',
      requiredLifecycle: 'succeeded',
      onUnmet: 'fail',
    };
    const file = gatedFile(plainGate, {
      lifecycle: 'succeeded',
      taskResult: { version: 1, revision: 1, summary: 's', verdict: verdict('fail') },
    });
    expect(prerequisiteTerminalLifecycle(file, 'impl')).toBeUndefined();
    expect(prerequisitesBlockTask(file, 'impl')).toBe(false);
  });
});
