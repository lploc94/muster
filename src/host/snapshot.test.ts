import { describe, expect, it } from 'vitest';
import {
  activeTurnIdForTask,
  buildSnapshot,
  projectQueuedTurns,
  type PendingAskOverlay,
} from './snapshot';
import type { TaskStore } from '../task/store';
import type { MusterTask, TaskMessage, TaskStoreFile, TaskTurn } from '../task/types';

const POLICY = {
  maxTurns: 10,
  maxAutomaticRetries: 1,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 300_000,
};

function task(id: string, overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    goal: `Goal for ${id}`,
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: POLICY,
    revision: 0,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function turn(overrides: Partial<TaskTurn> & Pick<TaskTurn, 'id' | 'taskId' | 'status' | 'sequence'>): TaskTurn {
  return {
    trigger: 'user',
    inputs: [],
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<TaskMessage> & Pick<TaskMessage, 'id' | 'taskId' | 'role' | 'content'>): TaskMessage {
  return {
    state: 'complete',
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function storeFrom(file: TaskStoreFile): TaskStore {
  return {
    getFile: () => file,
  } as TaskStore;
}

describe('host task snapshot projection', () => {
  it('orders roots by projected activity and projects a focused task contract', () => {
    const file: TaskStoreFile = {
      schemaVersion: 2,
      revision: 7,
      tasks: {
        'root-old': task('root-old', {
          goal: 'Older root',
          updatedAt: '2026-07-06T00:02:00.000Z',
        }),
        'root-active': task('root-active', {
          role: 'coordinator',
          goal: 'Active root',
          updatedAt: '2026-07-06T00:01:00.000Z',
        }),
        'child-b': task('child-b', {
          goal: 'Second child',
          parentId: 'root-active',
          updatedAt: '2026-07-06T00:03:00.000Z',
        }),
        'child-a': task('child-a', {
          goal: 'First child',
          parentId: 'root-active',
          dependencies: [
            { taskId: 'root-old', requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
          ],
          updatedAt: '2026-07-06T00:04:00.000Z',
        }),
        grandchild: task('grandchild', {
          goal: 'Nested child',
          parentId: 'child-a',
          updatedAt: '2026-07-06T00:05:00.000Z',
        }),
      },
      turns: {
        'root-active-succeeded': turn({
          id: 'root-active-succeeded',
          taskId: 'root-active',
          status: 'succeeded',
          sequence: 1,
          finishedAt: '2026-07-06T00:10:00.000Z',
        }),
        'root-active-running': turn({
          id: 'root-active-running',
          taskId: 'root-active',
          status: 'running',
          sequence: 2,
          startedAt: '2026-07-06T00:11:00.000Z',
        }),
        'root-active-queued': turn({
          id: 'root-active-queued',
          taskId: 'root-active',
          status: 'queued',
          sequence: 3,
          createdAt: '2026-07-06T00:12:00.000Z',
        }),
      },
      messages: {
        system: message({
          id: 'system',
          taskId: 'root-active',
          role: 'system',
          content: 'hidden from transcript',
          createdAt: '2026-07-06T00:14:00.000Z',
        }),
        assistant: message({
          id: 'assistant',
          taskId: 'root-active',
          role: 'assistant',
          content: 'assistant answer',
          createdAt: '2026-07-06T00:13:00.000Z',
        }),
        user: message({
          id: 'user',
          taskId: 'root-active',
          role: 'user',
          content: 'user request',
          createdAt: '2026-07-06T00:12:30.000Z',
        }),
      },
      operations: {},
      cancelRequests: {},
    };
    const pendingAsk: PendingAskOverlay = {
      taskId: 'root-active',
      turnId: 'root-active-running',
      askId: 'ask-1',
      questions: [{ name: 'direction', question: 'Continue?', type: 'text' }],
    };

    const snapshot = buildSnapshot(storeFrom(file), 'root-active', new Map([['root-active', pendingAsk]]));

    expect(snapshot.storeRevision).toBe(7);
    expect(snapshot.rootTasks.map((summary) => summary.id)).toEqual(['root-active', 'root-old']);
    expect(snapshot.rootTasks[0]).toMatchObject({
      id: 'root-active',
      role: 'coordinator',
      lifecycle: 'open',
      runtimeActivity: 'running',
      viewStatus: 'running',
      updatedAt: '2026-07-06T00:14:00.000Z',
    });
    expect(snapshot.focusedTaskId).toBe('root-active');
    expect(snapshot.subtree?.map((summary) => [summary.id, summary.lifecycle, summary.runtimeActivity, summary.viewStatus])).toEqual([
      ['child-a', 'open', 'waiting_dependencies', 'waiting_dependencies'],
      ['child-b', 'open', 'idle', 'idle'],
      ['grandchild', 'open', 'idle', 'idle'],
      ['root-active', 'open', 'running', 'running'],
    ]);
    expect(snapshot.transcript).toEqual([
      {
        id: 'user',
        kind: 'user',
        content: 'user request',
        turnId: undefined,
        order: undefined,
        state: 'complete',
      },
      {
        id: 'assistant',
        kind: 'assistant',
        content: 'assistant answer',
        turnId: undefined,
        order: undefined,
        state: 'complete',
      },
    ]);
    // Live turn wins over higher-sequence queued follow-ups (R012 multi-queue).
    expect(snapshot.activeTurnId).toBe('root-active-running');
    expect(snapshot.queuedTurns).toEqual([
      {
        turnId: 'root-active-queued',
        sequence: 3,
        status: 'queued',
        messageIds: [],
        createdAt: '2026-07-06T00:12:00.000Z',
      },
    ]);
    expect(snapshot.pendingAsk).toEqual({
      turnId: 'root-active-running',
      askId: 'ask-1',
      questions: [{ name: 'direction', question: 'Continue?', type: 'text' }],
    });
  });

  it('projects multi-queued follow-ups in FIFO order with one message identity each', () => {
    const file: TaskStoreFile = {
      schemaVersion: 2,
      revision: 3,
      tasks: {
        multi: task('multi', { role: 'coordinator', goal: 'Multi queue' }),
      },
      turns: {
        'turn-live': turn({
          id: 'turn-live',
          taskId: 'multi',
          status: 'running',
          sequence: 1,
          startedAt: '2026-07-06T00:01:00.000Z',
          inputs: [{ kind: 'message', messageId: 'msg-a' }],
        }),
        'turn-q1': turn({
          id: 'turn-q1',
          taskId: 'multi',
          status: 'queued',
          sequence: 2,
          createdAt: '2026-07-06T00:02:00.000Z',
          inputs: [{ kind: 'message', messageId: 'msg-b' }],
        }),
        'turn-q2': turn({
          id: 'turn-q2',
          taskId: 'multi',
          status: 'queued',
          sequence: 3,
          createdAt: '2026-07-06T00:03:00.000Z',
          inputs: [{ kind: 'message', messageId: 'msg-c' }],
        }),
      },
      messages: {
        'msg-a': message({
          id: 'msg-a',
          taskId: 'multi',
          role: 'user',
          content: 'a',
          state: 'assigned',
          turnId: 'turn-live',
        }),
        'msg-b': message({
          id: 'msg-b',
          taskId: 'multi',
          role: 'user',
          content: 'b',
          state: 'pending',
          createdAt: '2026-07-06T00:02:00.000Z',
        }),
        'msg-c': message({
          id: 'msg-c',
          taskId: 'multi',
          role: 'user',
          content: 'c',
          state: 'pending',
          createdAt: '2026-07-06T00:03:00.000Z',
        }),
      },
      operations: {},
      cancelRequests: {},
    };

    expect(activeTurnIdForTask(file, 'multi')).toBe('turn-live');
    expect(projectQueuedTurns(file, 'multi')).toEqual([
      {
        turnId: 'turn-q1',
        sequence: 2,
        status: 'queued',
        messageIds: ['msg-b'],
        createdAt: '2026-07-06T00:02:00.000Z',
      },
      {
        turnId: 'turn-q2',
        sequence: 3,
        status: 'queued',
        messageIds: ['msg-c'],
        createdAt: '2026-07-06T00:03:00.000Z',
      },
    ]);

    const snapshot = buildSnapshot(storeFrom(file), 'multi');
    expect(snapshot.activeTurnId).toBe('turn-live');
    expect(snapshot.queuedTurns).toEqual([
      {
        turnId: 'turn-q1',
        sequence: 2,
        status: 'queued',
        messageIds: ['msg-b'],
        createdAt: '2026-07-06T00:02:00.000Z',
      },
      {
        turnId: 'turn-q2',
        sequence: 3,
        status: 'queued',
        messageIds: ['msg-c'],
        createdAt: '2026-07-06T00:03:00.000Z',
      },
    ]);
    // Transcript still binds each user message to its dedicated turn identity.
    expect(snapshot.transcript?.filter((item) => item.kind === 'user')).toEqual([
      {
        id: 'msg-a',
        kind: 'user',
        content: 'a',
        turnId: 'turn-live',
        order: undefined,
        state: 'assigned',
      },
      {
        id: 'msg-b',
        kind: 'user',
        content: 'b',
        turnId: 'turn-q1',
        order: undefined,
        state: 'pending',
      },
      {
        id: 'msg-c',
        kind: 'user',
        content: 'c',
        turnId: 'turn-q2',
        order: undefined,
        state: 'pending',
      },
    ]);
  });

  it('omits queuedTurns and prefers waiting_user over later queued when live is ask', () => {
    const file: TaskStoreFile = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        ask: task('ask'),
      },
      turns: {
        live: turn({
          id: 'live',
          taskId: 'ask',
          status: 'waiting_user',
          sequence: 1,
        }),
        queued: turn({
          id: 'queued',
          taskId: 'ask',
          status: 'queued',
          sequence: 2,
          createdAt: '2026-07-06T00:02:00.000Z',
          inputs: [{ kind: 'message', messageId: 'msg-q' }],
        }),
      },
      messages: {
        'msg-q': message({
          id: 'msg-q',
          taskId: 'ask',
          role: 'user',
          content: 'queued follow-up',
          state: 'pending',
        }),
      },
      operations: {},
      cancelRequests: {},
    };

    expect(activeTurnIdForTask(file, 'ask')).toBe('live');
    expect(projectQueuedTurns(file, 'ask')).toEqual([
      {
        turnId: 'queued',
        sequence: 2,
        status: 'queued',
        messageIds: ['msg-q'],
        createdAt: '2026-07-06T00:02:00.000Z',
      },
    ]);
    expect(buildSnapshot(storeFrom(file), 'ask').activeTurnId).toBe('live');
  });

  it('returns empty queuedTurns when only a live turn exists', () => {
    const file: TaskStoreFile = {
      schemaVersion: 2,
      revision: 1,
      tasks: { only: task('only') },
      turns: {
        live: turn({ id: 'live', taskId: 'only', status: 'running', sequence: 1 }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(projectQueuedTurns(file, 'only')).toEqual([]);
    expect(buildSnapshot(storeFrom(file), 'only').queuedTurns).toEqual([]);
  });

  it('selects the latest retryable turn only for recovery state', () => {
    const file: TaskStoreFile = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        recovering: task('recovering'),
        settled: task('settled'),
      },
      turns: {
        failed: turn({ id: 'failed', taskId: 'recovering', status: 'failed', sequence: 1 }),
        interrupted: turn({
          id: 'interrupted',
          taskId: 'recovering',
          status: 'interrupted',
          sequence: 2,
        }),
        succeeded: turn({ id: 'succeeded', taskId: 'settled', status: 'succeeded', sequence: 1 }),
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };

    expect(activeTurnIdForTask(file, 'recovering')).toBe('interrupted');
    expect(activeTurnIdForTask(file, 'settled')).toBeUndefined();
    expect(activeTurnIdForTask(file, 'missing')).toBeUndefined();
  });
});
