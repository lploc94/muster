import { describe, expect, it } from 'vitest';
import type { RepositoryCommand } from '../task/repository';
import type { MusterTask, TaskMessage, EngineProjection, TaskTurn } from '../task/types';
import {
  localCommitNeedsTranscriptRecovery,
  projectWorkspacePatches,
} from './workspace-patch';

function emptyFile(revision = 0): EngineProjection {
  return {
    schemaVersion: 6,
    revision,
    tasks: {},
    turns: {},
    messages: {},
    toolCalls: {},
    reasoning: {},
    operations: {},
    cancelRequests: {},
    sendReceipts: {},
    runtimeClaims: {},
  };
}

function task(id: string, overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id,
    parentId: null,
    goal: `Goal ${id}`,
    role: 'worker',
    lifecycle: 'open',
    backend: 'claude',
    revision: 1,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    prerequisites: [],
    capabilities: [],
    executionPolicy: { maxTurns: 100, maxAutomaticRetries: 0 },
    releaseState: 'released',
    ...overrides,
  };
}

function turn(id: string, taskId: string, overrides: Partial<TaskTurn> = {}): TaskTurn {
  return {
    id,
    taskId,
    sequence: 1,
    status: 'queued',
    trigger: 'user',
    inputs: [{ kind: 'message', messageId: 'm1' }],
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function userMessage(id: string, taskId: string, content = 'hi'): TaskMessage {
  return {
    id,
    taskId,
    role: 'user',
    content,
    state: 'complete',
    createdAt: '2026-07-06T00:00:00.000Z',
  };
}

describe('projectWorkspacePatches', () => {
  it('emits nothing when result.changed is false', () => {
    const before = emptyFile(1);
    const after = emptyFile(1);
    after.tasks['t1'] = task('t1');
    const patches = projectWorkspacePatches({
      command: {
        kind: 'renameTask',
        workspaceId: 'ws',
        taskId: 't1',
        goal: 'x',
        updatedAt: '2026-07-06T00:00:00.000Z',
      },
      result: { ok: true, changed: false },
      before,
      after,
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(),
    });
    expect(patches).toEqual([]);
  });

  it('rename emits taskUpserted', () => {
    const before = emptyFile(1);
    before.tasks['t1'] = task('t1', { goal: 'Old' });
    const after = emptyFile(2);
    after.tasks['t1'] = task('t1', { goal: 'New', revision: 2 });
    const patches = projectWorkspacePatches({
      command: {
        kind: 'renameTask',
        workspaceId: 'ws',
        taskId: 't1',
        goal: 'New',
        updatedAt: '2026-07-06T00:00:01.000Z',
      },
      result: { ok: true, changed: true },
      before,
      after,
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(),
    });
    expect(patches.some((p) => p.type === 'taskUpserted' && p.task.goal === 'New')).toBe(true);
  });

  it('appendTranscriptBatch emits append for unknown ids and patch for known', () => {
    const before = emptyFile(1);
    before.tasks['t1'] = task('t1');
    const after = emptyFile(2);
    after.tasks['t1'] = task('t1');
    const command: RepositoryCommand = {
      kind: 'appendTranscriptBatch',
      workspaceId: 'ws',
      taskId: 't1',
      messages: [
        {
          id: 'a1',
          taskId: 't1',
          role: 'assistant',
          content: 'hello',
          turnId: 'turn-1',
          order: 1,
          state: 'partial' as const,
          createdAt: '2026-07-06T00:00:00.000Z',
        },
        {
          id: 'a2',
          taskId: 't1',
          role: 'assistant',
          content: 'world',
          turnId: 'turn-1',
          order: 2,
          state: 'partial' as const,
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
    };
    const patches = projectWorkspacePatches({
      command,
      result: { ok: true, changed: true },
      before,
      after,
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(['a1']),
    });
    const append = patches.find((p) => p.type === 'transcriptItemsAppended');
    const patched = patches.filter((p) => p.type === 'transcriptItemPatched');
    expect(append).toMatchObject({
      type: 'transcriptItemsAppended',
      taskId: 't1',
      items: [{ id: 'a2' }],
    });
    expect(patched).toHaveLength(1);
    expect(patched[0]).toMatchObject({ type: 'transcriptItemPatched', item: { id: 'a1' } });
  });

  it('queued follow-up enqueue does not append transcript', () => {
    const before = emptyFile(1);
    before.tasks['t1'] = task('t1');
    before.turns['old'] = turn('old', 't1', { sequence: 1, status: 'succeeded' });
    const after = emptyFile(2);
    after.tasks['t1'] = task('t1', { revision: 2 });
    after.turns['old'] = before.turns['old'];
    after.turns['q2'] = turn('q2', 't1', {
      sequence: 2,
      status: 'queued',
      inputs: [{ kind: 'message', messageId: 'm2' }],
    });
    after.messages['m2'] = userMessage('m2', 't1', 'follow up');
    const patches = projectWorkspacePatches({
      command: {
        kind: 'enqueueMessageTurn',
        workspaceId: 'ws',
        expectedTaskRevision: 1,
        maxTurnsPerTask: 100,
        task: after.tasks['t1'],
        message: after.messages['m2'],
        turn: after.turns['q2'],
      },
      result: { ok: true, changed: true },
      before,
      after,
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(),
    });
    expect(patches.some((p) => p.type === 'transcriptItemsAppended')).toBe(false);
    expect(patches.some((p) => p.type === 'queuedTurnsChanged')).toBe(true);
  });

  it('opening createRootAndInitialTurn appends user transcript', () => {
    const before = emptyFile(0);
    const after = emptyFile(1);
    after.tasks['t1'] = task('t1');
    after.turns['turn-1'] = turn('turn-1', 't1', { sequence: 1, status: 'queued' });
    after.messages['m1'] = userMessage('m1', 't1', 'open');
    const patches = projectWorkspacePatches({
      command: {
        kind: 'createRootAndInitialTurn',
        workspaceId: 'ws',
        task: after.tasks['t1'],
        message: after.messages['m1'],
        turn: after.turns['turn-1'],
      },
      result: { ok: true, changed: true },
      before,
      after,
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(),
    });
    expect(patches.some((p) => p.type === 'taskUpserted')).toBe(true);
    expect(patches.some((p) => p.type === 'transcriptItemsAppended')).toBe(true);
  });

  it('delete emits taskRemoved', () => {
    const before = emptyFile(1);
    before.tasks['t1'] = task('t1');
    before.tasks['t2'] = task('t2');
    const after = emptyFile(2);
    after.tasks['t2'] = task('t2');
    const patches = projectWorkspacePatches({
      command: {
        kind: 'deleteTaskSubtree',
        workspaceId: 'ws',
        rootTaskId: 't1',
      },
      result: { ok: true, changed: true },
      before,
      after,
      focusedTaskId: 't2',
      knownTranscriptIds: new Set(),
    });
    expect(patches).toContainEqual({ type: 'taskRemoved', taskId: 't1' });
  });

  it('graph deleteTaskIds emits taskRemoved', () => {
    const before = emptyFile(1);
    before.tasks['parent'] = task('parent');
    before.tasks['child'] = task('child', { parentId: 'parent' });
    const after = emptyFile(2);
    after.tasks['parent'] = task('parent', { revision: 2 });
    const patches = projectWorkspacePatches({
      command: {
        kind: 'cancelChildTasks',
        workspaceId: 'ws',
        expectedTasks: [{ id: 'parent', revision: 1 }],
        tasks: [after.tasks['parent']],
        turns: [],
        deleteTaskIds: ['child'],
      },
      result: { ok: true, changed: true },
      before,
      after,
      focusedTaskId: 'parent',
      knownTranscriptIds: new Set(),
    });
    expect(patches).toContainEqual({ type: 'taskRemoved', taskId: 'child' });
  });

  it('deleteMessage removes a known focused transcript item without snapshot recovery', () => {
    const before = emptyFile(1);
    before.tasks['t1'] = task('t1');
    before.messages['m1'] = userMessage('m1', 't1');
    const after = emptyFile(2);
    after.tasks['t1'] = task('t1');
    const command: RepositoryCommand = {
      kind: 'deleteMessage',
      workspaceId: 'ws',
      messageId: 'm1',
    };
    const result = { ok: true as const, changed: true };
    const patches = projectWorkspacePatches({
      command,
      result,
      before,
      after,
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(['m1', 'older-loaded']),
    });
    expect(patches).toContainEqual({
      type: 'transcriptItemsRemoved',
      taskId: 't1',
      itemIds: ['m1'],
    });
    expect(localCommitNeedsTranscriptRecovery({
      command,
      result,
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(['m1']),
    })).toBe(false);
  });

  it('keeps bounded recovery for destructive effects without explicit entity ids', () => {
    expect(localCommitNeedsTranscriptRecovery({
      command: {
        kind: 'deleteTurn',
        workspaceId: 'ws',
        turnId: 'turn-old',
      },
      result: { ok: true, changed: true },
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(['older-loaded']),
    })).toBe(true);
    expect(localCommitNeedsTranscriptRecovery({
      command: {
        kind: 'applyRetentionPolicy',
        workspaceId: 'ws',
        taskId: 't1',
        keepLatestTurns: 10,
      },
      result: { ok: true, changed: true },
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(['older-loaded']),
    })).toBe(true);
  });

  it('non-focused transcript mutations are omitted', () => {
    const before = emptyFile(1);
    before.tasks['t1'] = task('t1');
    before.tasks['t2'] = task('t2');
    const after = emptyFile(2);
    after.tasks['t1'] = task('t1');
    after.tasks['t2'] = task('t2');
    const patches = projectWorkspacePatches({
      command: {
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: 't2',
        messages: [
          {
            id: 'a1',
            taskId: 't2',
            role: 'assistant',
            content: 'secret',
            turnId: 'turn-x',
            order: 1,
            state: 'partial' as const,
            createdAt: '2026-07-06T00:00:00.000Z',
          },
        ],
      },
      result: { ok: true, changed: true },
      before,
      after,
      focusedTaskId: 't1',
      knownTranscriptIds: new Set(),
    });
    expect(patches.some((p) => p.type.startsWith('transcript'))).toBe(false);
  });

  it('invisible coordination commands yield empty patch list', () => {
    const before = emptyFile(1);
    const after = emptyFile(2);
    const patches = projectWorkspacePatches({
      command: {
        kind: 'heartbeatRuntime',
        workspaceId: 'ws',
        turnId: 'turn-1',
        ownerId: 'owner',
        heartbeatAt: '2026-07-06T00:00:00.000Z',
        expiresAt: '2026-07-06T00:01:00.000Z',
      },
      result: { ok: true, changed: true },
      before,
      after,
      knownTranscriptIds: new Set(),
    });
    expect(patches).toEqual([]);
  });
});
