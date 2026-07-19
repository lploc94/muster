import { describe, expect, it } from 'vitest';
import {
  buildCompactContinuationContext,
  captureContinuationCutoff,
  MAX_CONTINUATION_CHARS,
} from './engine-handoff';
import type { TaskContinuationHandoffState, EngineProjection } from './types';

function file(): EngineProjection {
  return {
    schemaVersion: 5,
    revision: 7,
    tasks: {},
    turns: {
      t1: {
        id: 't1', taskId: 'task-1', sequence: 1, trigger: 'user', status: 'succeeded',
        runtimeEpoch: 1, inputs: [{ kind: 'message', messageId: 'm1' }], createdAt: '2026-01-01T00:00:00Z',
      },
      t2: {
        id: 't2', taskId: 'task-1', sequence: 2, trigger: 'user', status: 'queued',
        runtimeEpoch: 1, inputs: [{ kind: 'message', messageId: 'm2' }], createdAt: '2026-01-01T00:01:00Z',
      },
    },
    messages: {
      m1: {
        id: 'm1', taskId: 'task-1', role: 'user', content: 'sửa file A', state: 'complete',
        createdAt: '2026-01-01T00:00:00Z',
      },
      a1: {
        id: 'a1', taskId: 'task-1', role: 'assistant', content: 'tôi sẽ sửa rồi test',
        state: 'complete', createdAt: '2026-01-01T00:00:01Z', turnId: 't1', order: 0,
      },
      m2: {
        id: 'm2', taskId: 'task-1', role: 'user', content: 'pending must not leak', state: 'pending',
        createdAt: '2026-01-01T00:01:00Z',
      },
    },
    toolCalls: {
      't1:tool-1': {
        id: 't1:tool-1', taskId: 'task-1', turnId: 't1', toolCallId: 'tool-1', order: 1,
        name: 'exec_command', status: 'success', input: { cmd: 'npm run test' }, output: '12 passed',
        createdAt: '2026-01-01T00:00:02Z', updatedAt: '2026-01-01T00:00:03Z',
      },
    },
  };
}

function handoff(contextCutoff: ReturnType<typeof captureContinuationCutoff>): TaskContinuationHandoffState {
  return {
    version: 2,
    operationId: 'hop-1',
    source: { backend: 'claude', model: 'sonnet', runtimeEpoch: 1 },
    target: { backend: 'codex', model: 'gpt-5', runtimeEpoch: 2 },
    contextCutoff,
    continuation: { status: 'pending' },
    switchedAt: '2026-01-01T00:02:00Z',
  };
}

describe('runtime switch compact continuation', () => {
  it('captures only committed turns and records a deterministic bounded cutoff', () => {
    const cutoff = captureContinuationCutoff(file(), 'task-1', '2026-01-01T00:02:00Z');
    expect(cutoff).toMatchObject({
      throughTurnSequence: 1,
      sourceStoreRevision: 7,
      messageCount: 2,
      toolCallCount: 1,
      capturedAt: '2026-01-01T00:02:00Z',
    });
    expect(cutoff.contextDigest).toMatch(/^[a-f0-9]{32}$/);
  });

  it('renders prose/edit/shell history instead of raw protocol JSON', () => {
    const source = file();
    const context = buildCompactContinuationContext(
      source,
      'task-1',
      handoff(captureContinuationCutoff(source, 'task-1', '2026-01-01T00:02:00Z')),
    );
    expect(context).toContain('User: sửa file A');
    expect(context).toContain('Assistant: tôi sẽ sửa rồi test');
    expect(context).toContain('bash npm run test');
    expect(context).toContain('12 passed');
    expect(context).not.toContain('pending must not leak');
    expect(context).not.toContain('createdAt');
    expect(context).not.toContain('toolCallId');
    expect(context.length).toBeLessThanOrEqual(MAX_CONTINUATION_CHARS);
  });

  it('freezes at the cutoff even if later committed turns appear', () => {
    const source = file();
    const cutoff = captureContinuationCutoff(source, 'task-1', '2026-01-01T00:02:00Z');
    source.turns.t2 = { ...source.turns.t2, status: 'succeeded' };
    source.messages.m2 = { ...source.messages.m2, state: 'complete' };
    source.messages.late = {
      id: 'late', taskId: 'task-1', role: 'assistant', content: 'late source event',
      state: 'complete', createdAt: '2026-01-01T00:03:00Z', turnId: 't1', order: 99,
    };
    source.toolCalls!['t1:late'] = {
      id: 't1:late', taskId: 'task-1', turnId: 't1', toolCallId: 'late', order: 100,
      name: 'exec_command', status: 'success', input: { cmd: 'late command' },
      createdAt: '2026-01-01T00:03:00Z', updatedAt: '2026-01-01T00:03:00Z',
    };
    const context = buildCompactContinuationContext(source, 'task-1', handoff(cutoff));
    expect(context).not.toContain('pending must not leak');
    expect(context).not.toContain('late source event');
    expect(context).not.toContain('late command');
  });

  it('does not treat a zero cutoff count as an unbounded slice', () => {
    const source = file();
    const cutoff = captureContinuationCutoff(source, 'task-1', '2026-01-01T00:02:00Z');
    const context = buildCompactContinuationContext(source, 'task-1', handoff({
      ...cutoff,
      throughMessageId: undefined,
      throughToolCallId: undefined,
      messageCount: 0,
      toolCallCount: 0,
    }));
    expect(context).not.toContain('sửa file A');
    expect(context).not.toContain('npm run test');
  });

  it('omits an in-flight tool whose outcome can still change after the switch', () => {
    const source = file();
    source.toolCalls!['t1:tool-1'] = {
      ...source.toolCalls!['t1:tool-1'],
      status: 'running',
      output: undefined,
    };
    const cutoff = captureContinuationCutoff(source, 'task-1', '2026-01-01T00:02:00Z');
    expect(cutoff.toolCallCount).toBe(0);
    source.toolCalls!['t1:tool-1'] = {
      ...source.toolCalls!['t1:tool-1'],
      status: 'success',
      output: 'late mutable result',
    };
    const context = buildCompactContinuationContext(source, 'task-1', handoff(cutoff));
    expect(context).not.toContain('late mutable result');
  });
});
