import { describe, expect, it } from 'vitest';
import { projectPrompt } from './engine';
import type { EngineProjection, MusterTask, TaskMessage, TaskTurn } from './types';

function childTask(summary: string): MusterTask {
  return {
    id: 'child-1',
    role: 'worker',
    lifecycle: 'succeeded',
    releaseState: 'released',
    goal: 'Produce a result',
    parentId: 'parent-1',
    prerequisites: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 },
    taskResult: { version: 1, revision: 1, summary },
    revision: 1,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:01.000Z',
  };
}

describe('projectPrompt', () => {
  it('projects message inputs in stable order and recovery instruction only', () => {
    const turn: TaskTurn = {
      id: 't1', taskId: 'task-1', sequence: 1, trigger: 'retry', status: 'queued',
      inputs: [
        { kind: 'message', messageId: 'm2' },
        { kind: 'message', messageId: 'm1' },
        { kind: 'recovery', interruptedTurnId: 't0', instruction: 'Try again carefully' },
      ],
      createdAt: '2026-07-06T00:00:00.000Z',
    };
    const messages = new Map<string, TaskMessage>([
      ['m1', {
        id: 'm1', taskId: 'task-1', role: 'user', content: 'first', state: 'assigned',
        createdAt: '2026-07-06T00:00:00.000Z',
      }],
      ['m2', {
        id: 'm2', taskId: 'task-1', role: 'user', content: 'second', state: 'assigned',
        createdAt: '2026-07-06T00:00:01.000Z',
      }],
    ]);
    expect(projectPrompt(turn, messages)).toBe('first\n\nsecond\n\nTry again carefully');
  });

  it('prefixes durable compiled prompt and resolved inputs before messages', () => {
    const turn: TaskTurn = {
      id: 't1', taskId: 'impl', sequence: 1, trigger: 'engine', status: 'queued',
      inputs: [{ kind: 'message', messageId: 'm1' }],
      createdAt: '2026-07-06T00:00:00.000Z',
      compiledPrompt: '## Bound predecessor outputs\nplan text',
      resolvedInputs: [{
        as: 'implementationPlan', fromTaskId: 'plan', output: 'summary',
        producerResultRevision: 1, text: 'plan text',
      }],
    };
    const messages = new Map<string, TaskMessage>([['m1', {
      id: 'm1', taskId: 'impl', role: 'user', content: 'implement it', state: 'assigned',
      createdAt: '2026-07-06T00:00:00.000Z',
    }]]);
    const prompt = projectPrompt(turn, messages);
    expect(prompt.startsWith('## Bound predecessor outputs')).toBe(true);
    expect(prompt).toContain('plan text');
    expect(prompt).toContain('implement it');
  });

  it('projects child results beyond the former 512-character preview', () => {
    const summary = 'result-'.repeat(1_000);
    const turn: TaskTurn = {
      id: 't1', taskId: 'parent-1', sequence: 1, trigger: 'engine', status: 'queued',
      inputs: [{ kind: 'child_results', taskIds: ['child-1'] }],
      createdAt: '2026-07-06T00:00:00.000Z',
    };
    const file = {
      tasks: { 'child-1': childTask(summary) },
    } as unknown as EngineProjection;

    expect(projectPrompt(turn, new Map(), file)).toContain(summary);
  });

  it('marks child-result projection when the aggregate byte budget is exhausted', () => {
    const summary = '界'.repeat(1_000);
    const turn: TaskTurn = {
      id: 't1', taskId: 'parent-1', sequence: 1, trigger: 'engine', status: 'queued',
      inputs: [{ kind: 'child_results', taskIds: ['child-1'] }],
      createdAt: '2026-07-06T00:00:00.000Z',
    };
    const file = {
      tasks: { 'child-1': childTask(summary) },
    } as unknown as EngineProjection;
    const prompt = projectPrompt(turn, new Map(), file, 256);

    expect(prompt).toContain('[truncated]');
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(256);
  });
});
