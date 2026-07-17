import { describe, expect, it } from 'vitest';
import { retryCountOf } from './transitions';
import { applyRetention, DEFAULT_RETENTION_CONFIG, TRUNCATION_MARKER } from './retention';
import type { MusterTask, TaskStoreFile, TaskTurn } from './types';

function sampleTask(id: string, lifecycle: MusterTask['lifecycle'] = 'open'): MusterTask {
  return {
    id,
    role: 'coordinator',
    lifecycle,
    goal: 'test',
    parentId: null,
    dependencies: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: {
      maxTurns: 200,
      maxAutomaticRetries: 2,
      turnTimeoutMs: 1_000,
      taskTimeoutMs: 5_000,
    },
    revision: 0,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    finishedAt: lifecycle === 'open' ? undefined : '2026-07-06T01:00:00.000Z',
  };
}

function turn(id: string, taskId: string, sequence: number, status: TaskTurn['status'] = 'succeeded'): TaskTurn {
  return {
    id,
    taskId,
    sequence,
    trigger: 'user',
    status,
    inputs: [],
    createdAt: `2026-07-06T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    finishedAt: status === 'succeeded' ? `2026-07-06T00:00:${String(sequence).padStart(2, '0')}.100Z` : undefined,
  };
}

function emptyFile(): TaskStoreFile {
  return {
    schemaVersion: 2,
    revision: 1,
    tasks: {},
    turns: {},
    messages: {},
    operations: {},
    cancelRequests: {},
  };
}

describe('applyRetention', () => {
  it('truncates oversized settled assistant output on open tasks without removing turns', () => {
    const file = emptyFile();
    file.tasks['task-1'] = sampleTask('task-1', 'open');
    file.turns['t1'] = turn('t1', 'task-1', 1);
    const huge = 'x'.repeat(300_000);
    file.messages['m1'] = {
      id: 'm1',
      taskId: 'task-1',
      role: 'assistant',
      content: huge,
      state: 'complete',
      createdAt: '2026-07-06T00:00:01.000Z',
      turnId: 't1',
    };

    const pruned = applyRetention(file, { maxTurnsPerTask: 200, maxStoredOutputChars: 200_000 });
    expect(Object.keys(pruned.turns)).toHaveLength(1);
    expect(pruned.messages['m1'].content.length).toBeLessThan(huge.length);
    expect(pruned.messages['m1'].content.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(retryCountOf(Object.values(pruned.turns), 't1')).toBe(0);
  });

  it('does not truncate partial assistant output on open tasks', () => {
    const file = emptyFile();
    file.tasks['task-1'] = sampleTask('task-1', 'open');
    const huge = 'y'.repeat(300_000);
    file.messages['m1'] = {
      id: 'm1',
      taskId: 'task-1',
      role: 'assistant',
      content: huge,
      state: 'partial',
      createdAt: '2026-07-06T00:00:01.000Z',
      turnId: 't1',
    };

    const pruned = applyRetention(file, { maxTurnsPerTask: 200, maxStoredOutputChars: 200_000 });
    expect(pruned.messages['m1'].content).toBe(huge);
  });

  it('drops oldest turns on terminal tasks beyond the cap while preserving retry chains', () => {
    const file = emptyFile();
    file.tasks['task-1'] = sampleTask('task-1', 'succeeded');
    for (let i = 1; i <= 5; i += 1) {
      file.turns[`t${i}`] = turn(`t${i}`, 'task-1', i);
      file.messages[`m${i}`] = {
        id: `m${i}`,
        taskId: 'task-1',
        role: 'assistant',
        content: `out-${i}`,
        state: 'complete',
        createdAt: `2026-07-06T00:00:0${i}.000Z`,
        turnId: `t${i}`,
      };
    }
    file.turns['t5'].retryOf = 't4';

    const pruned = applyRetention(file, { maxTurnsPerTask: 3, maxStoredOutputChars: 200_000 });
    expect(Object.keys(pruned.turns).sort()).toEqual(['t3', 't4', 't5']);
    expect(pruned.messages['m1']).toBeUndefined();
    expect(pruned.messages['m2']).toBeUndefined();
    expect(pruned.messages['m5']).toBeDefined();
    expect(pruned.tasks['task-1'].lifecycle).toBe('succeeded');
  });

  it('is idempotent', () => {
    const file = emptyFile();
    file.tasks['task-1'] = sampleTask('task-1', 'failed');
    for (let i = 1; i <= 4; i += 1) {
      file.turns[`t${i}`] = turn(`t${i}`, 'task-1', i);
    }
    const once = applyRetention(file, DEFAULT_RETENTION_CONFIG);
    const twice = applyRetention(once, DEFAULT_RETENTION_CONFIG);
    expect(twice).toEqual(once);
  });

  it('truncates oversized tool output and reasoning content on open tasks', () => {
    const file = emptyFile();
    file.schemaVersion = 3;
    file.toolCalls = {};
    file.reasoning = {};
    file.tasks['task-1'] = sampleTask('task-1', 'open');
    file.turns['t1'] = turn('t1', 'task-1', 1);
    const huge = 'z'.repeat(300_000);
    file.toolCalls['t1:tc1'] = {
      id: 't1:tc1',
      taskId: 'task-1',
      turnId: 't1',
      toolCallId: 'tc1',
      order: 0,
      name: 'read',
      status: 'success',
      output: huge,
      createdAt: '2026-07-06T00:00:01.000Z',
      updatedAt: '2026-07-06T00:00:01.000Z',
    };
    file.reasoning['t1'] = {
      id: 't1',
      taskId: 'task-1',
      turnId: 't1',
      content: huge,
      createdAt: '2026-07-06T00:00:01.000Z',
      updatedAt: '2026-07-06T00:00:01.000Z',
    };

    const pruned = applyRetention(file, { maxTurnsPerTask: 200, maxStoredOutputChars: 200_000 });
    expect((pruned.toolCalls!['t1:tc1'].output as string).length).toBeLessThan(huge.length);
    expect((pruned.toolCalls!['t1:tc1'].output as string).endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(pruned.reasoning!['t1'].content.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('never truncates transcript rows owned by a live turn', () => {
    const file = emptyFile();
    file.schemaVersion = 3;
    file.toolCalls = {};
    file.reasoning = {};
    file.tasks['task-1'] = sampleTask('task-1', 'open');
    file.turns['t1'] = turn('t1', 'task-1', 1, 'running');
    const huge = 'l'.repeat(300_000);
    file.messages['m1'] = {
      id: 'm1', taskId: 'task-1', turnId: 't1', role: 'assistant', content: huge,
      state: 'partial', createdAt: '2026-07-06T00:00:01.000Z',
    };
    file.toolCalls['t1:tc1'] = {
      id: 't1:tc1', taskId: 'task-1', turnId: 't1', toolCallId: 'tc1', order: 0,
      name: 'read', status: 'running', output: huge,
      createdAt: '2026-07-06T00:00:01.000Z', updatedAt: '2026-07-06T00:00:01.000Z',
    };
    file.reasoning['t1'] = {
      id: 't1', taskId: 'task-1', turnId: 't1', content: huge,
      createdAt: '2026-07-06T00:00:01.000Z', updatedAt: '2026-07-06T00:00:01.000Z',
    };

    const retained = applyRetention(file, { maxTurnsPerTask: 1, maxStoredOutputChars: 30 });
    expect(retained.turns.t1).toEqual(file.turns.t1);
    expect(retained.messages.m1).toEqual(file.messages.m1);
    expect(retained.toolCalls?.['t1:tc1']).toEqual(file.toolCalls['t1:tc1']);
    expect(retained.reasoning?.t1).toEqual(file.reasoning.t1);
  });

  it('drops tool calls and reasoning for pruned turns on terminal tasks', () => {
    const file = emptyFile();
    file.schemaVersion = 3;
    file.toolCalls = {};
    file.reasoning = {};
    file.tasks['task-1'] = sampleTask('task-1', 'succeeded');
    for (let i = 1; i <= 5; i += 1) {
      file.turns[`t${i}`] = turn(`t${i}`, 'task-1', i);
      file.toolCalls[`t${i}:tc`] = {
        id: `t${i}:tc`,
        taskId: 'task-1',
        turnId: `t${i}`,
        toolCallId: 'tc',
        order: 0,
        name: 'read',
        status: 'success',
        createdAt: `2026-07-06T00:00:0${i}.000Z`,
        updatedAt: `2026-07-06T00:00:0${i}.000Z`,
      };
      file.reasoning[`t${i}`] = {
        id: `t${i}`,
        taskId: 'task-1',
        turnId: `t${i}`,
        content: `r${i}`,
        createdAt: `2026-07-06T00:00:0${i}.000Z`,
        updatedAt: `2026-07-06T00:00:0${i}.000Z`,
      };
    }

    const pruned = applyRetention(file, { maxTurnsPerTask: 3, maxStoredOutputChars: 200_000 });
    expect(pruned.toolCalls!['t1:tc']).toBeUndefined();
    expect(pruned.toolCalls!['t2:tc']).toBeUndefined();
    expect(pruned.toolCalls!['t5:tc']).toBeDefined();
    expect(pruned.reasoning!['t1']).toBeUndefined();
    expect(pruned.reasoning!['t5']).toBeDefined();
  });
});
