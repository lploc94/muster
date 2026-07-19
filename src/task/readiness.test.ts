import { describe, expect, it } from 'vitest';
import { evaluateTaskReadiness } from './readiness';
import type { MusterTask, EngineProjection, TaskTurn } from './types';

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
    releaseState: 'released',
    ...partial,
  };
}

function file(tasks: Record<string, MusterTask>, turns: Record<string, TaskTurn> = {}): EngineProjection {
  return {
    schemaVersion: 5,
    revision: 1,
    tasks,
    turns,
    messages: {},
  };
}

describe('evaluateTaskReadiness', () => {
  it('marks draft as not schedulable', () => {
    const f = file({
      a: task({ id: 'a', releaseState: 'draft' }),
    });
    const r = evaluateTaskReadiness(f, 'a');
    expect(r.code).toBe('draft');
    expect(r.schedulable).toBe(false);
  });

  it('distinguishes waiting_dependencies vs missing_input', () => {
    const f = file({
      plan: task({ id: 'plan', lifecycle: 'open', releaseState: 'released' }),
      impl: task({
        id: 'impl',
        releaseState: 'released',
        dependencies: [{ taskId: 'plan', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
        inputBindings: [{ fromTaskId: 'plan', output: 'summary', as: 'p' }],
      }),
    }, {
      t1: {
        id: 't1',
        taskId: 'impl',
        sequence: 1,
        trigger: 'engine',
        status: 'queued',
        inputs: [],
        createdAt: 't0',
      },
    });
    const r = evaluateTaskReadiness(f, 'impl');
    expect(r.schedulable).toBe(false);
    expect(r.reasons.some((x) => x.code === 'waiting_dependencies')).toBe(true);
  });

  it('ready when released, deps satisfied, queued', () => {
    const f = file({
      plan: task({
        id: 'plan',
        lifecycle: 'succeeded',
        releaseState: 'released',
        taskResult: { version: 1, revision: 1, summary: 'ok' },
      }),
      impl: task({
        id: 'impl',
        releaseState: 'released',
        dependencies: [{ taskId: 'plan', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
        inputBindings: [{ fromTaskId: 'plan', output: 'summary', as: 'p' }],
      }),
    }, {
      t1: {
        id: 't1',
        taskId: 'impl',
        sequence: 1,
        trigger: 'engine',
        status: 'queued',
        inputs: [],
        createdAt: 't0',
      },
    });
    const r = evaluateTaskReadiness(f, 'impl');
    expect(r.schedulable).toBe(true);
    expect(r.code).toBe('queued');
  });

  it('missing_input when dep succeeded without result', () => {
    const f = file({
      plan: task({ id: 'plan', lifecycle: 'succeeded', releaseState: 'released' }),
      impl: task({
        id: 'impl',
        releaseState: 'released',
        dependencies: [{ taskId: 'plan', requiredOutcome: 'succeeded', onUnsatisfied: 'block' }],
        inputBindings: [{ fromTaskId: 'plan', output: 'summary', as: 'p' }],
      }),
    }, {
      t1: {
        id: 't1',
        taskId: 'impl',
        sequence: 1,
        trigger: 'engine',
        status: 'queued',
        inputs: [],
        createdAt: 't0',
      },
    });
    const r = evaluateTaskReadiness(f, 'impl');
    expect(r.schedulable).toBe(false);
    expect(r.reasons.some((x) => x.code === 'missing_input_binding')).toBe(true);
  });
});
