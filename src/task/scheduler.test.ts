import { describe, expect, it } from 'vitest';
import { canPromoteTurn } from './scheduler';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import type { TaskStoreFile } from './types';

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