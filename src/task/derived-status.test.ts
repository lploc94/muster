import { describe, expect, it } from 'vitest';
import {
  deriveRuntimeActivity,
  deriveViewStatus,
  isHardTerminalLifecycle,
  isSoftTerminalLifecycle,
} from './derived-status';
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

describe('lifecycle terminal helpers', () => {
  it('classifies hard vs soft terminal', () => {
    expect(isHardTerminalLifecycle('succeeded')).toBe(true);
    expect(isHardTerminalLifecycle('cancelled')).toBe(true);
    expect(isHardTerminalLifecycle('skipped')).toBe(true);
    expect(isHardTerminalLifecycle('failed')).toBe(false);
    expect(isSoftTerminalLifecycle('failed')).toBe(true);
    expect(isSoftTerminalLifecycle('open')).toBe(false);
  });
});

describe('deriveRuntimeActivity', () => {
  it('returns null for terminal lifecycle even with live turns', () => {
    const task = baseTask({ lifecycle: 'succeeded' });
    const turns = [turn({ id: 't1', status: 'running', sequence: 1 })];
    expect(deriveRuntimeActivity(task, turns, new Map())).toBeNull();
  });

  it('maps open + running turn to running', () => {
    const turns = [turn({ id: 't1', status: 'running', sequence: 1 })];
    expect(deriveRuntimeActivity(baseTask(), turns, new Map())).toBe('running');
  });
});

describe('deriveViewStatus', () => {
  it('maps terminal lifecycle directly', () => {
    for (const lifecycle of ['succeeded', 'failed', 'cancelled', 'skipped'] as const) {
      expect(deriveViewStatus(baseTask({ lifecycle }), [], new Map())).toBe(lifecycle);
    }
  });

  it('terminal lifecycle takes precedence over live turn', () => {
    const task = baseTask({ lifecycle: 'succeeded' });
    const turns = [turn({ id: 't1', status: 'running', sequence: 1 })];
    expect(deriveViewStatus(task, turns, new Map())).toBe('succeeded');
  });

  it('live running turn takes precedence over unsatisfied deps', () => {
    const task = baseTask({
      dependencies: [{ taskId: 'dep-1', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
    });
    const turns = [turn({ id: 't1', status: 'running', sequence: 1 })];
    expect(deriveViewStatus(task, turns, new Map())).toBe('running');
  });

  it('live waiting_user turn maps to waiting_user', () => {
    const turns = [turn({ id: 't1', status: 'waiting_user', sequence: 1 })];
    expect(deriveViewStatus(baseTask(), turns, new Map())).toBe('waiting_user');
  });

  it('unsatisfied deps take precedence over queued turn', () => {
    const task = baseTask({
      dependencies: [{ taskId: 'dep-1', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
    });
    const turns = [turn({ id: 't1', status: 'queued', sequence: 1 })];
    expect(deriveViewStatus(task, turns, new Map([['dep-1', 'open']]))).toBe(
      'waiting_dependencies',
    );
  });

  it('missing dep lifecycle entry is unsatisfied', () => {
    const task = baseTask({
      dependencies: [{ taskId: 'dep-1', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
    });
    expect(deriveViewStatus(task, [], new Map())).toBe('waiting_dependencies');
  });

  it('queued turn when deps satisfied', () => {
    const task = baseTask({
      dependencies: [{ taskId: 'dep-1', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
    });
    const turns = [turn({ id: 't1', status: 'queued', sequence: 1 })];
    expect(deriveViewStatus(task, turns, new Map([['dep-1', 'succeeded']]))).toBe('queued');
  });

  it('queued takes precedence over waiting_children', () => {
    const task = baseTask({
      wait: { kind: 'children', taskIds: ['child-1'], registeredByTurnId: 't0' },
    });
    const turns = [turn({ id: 't1', status: 'queued', sequence: 2 })];
    expect(deriveViewStatus(task, turns, new Map())).toBe('queued');
  });

  it('queued takes precedence over blocked external wait', () => {
    const task = baseTask({ wait: { kind: 'external', key: 'approval' } });
    const turns = [turn({ id: 't1', status: 'queued', sequence: 2 })];
    expect(deriveViewStatus(task, turns, new Map())).toBe('queued');
  });

  it('waiting_children takes precedence over needs_recovery', () => {
    const task = baseTask({
      wait: { kind: 'children', taskIds: ['child-1'], registeredByTurnId: 't0' },
    });
    const turns = [
      turn({ id: 't1', status: 'failed', sequence: 1 }),
    ];
    expect(deriveViewStatus(task, turns, new Map())).toBe('waiting_children');
  });

  it('blocked takes precedence over needs_recovery', () => {
    const task = baseTask({ wait: { kind: 'external', key: 'approval' } });
    const turns = [turn({ id: 't1', status: 'failed', sequence: 1 })];
    expect(deriveViewStatus(task, turns, new Map())).toBe('blocked');
  });

  it('needs_recovery from latest failed turn', () => {
    const turns = [turn({ id: 't1', status: 'failed', sequence: 1 })];
    expect(deriveViewStatus(baseTask(), turns, new Map())).toBe('needs_recovery');
  });

  it('needs_recovery from latest interrupted turn', () => {
    const turns = [turn({ id: 't1', status: 'interrupted', sequence: 1 })];
    expect(deriveViewStatus(baseTask(), turns, new Map())).toBe('needs_recovery');
  });

  it('open task with no turns is idle', () => {
    expect(deriveViewStatus(baseTask(), [], new Map())).toBe('idle');
  });
});