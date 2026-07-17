import { describe, expect, it } from 'vitest';
import type {
  SnapshotMessage,
  TaskSummary,
  TranscriptItem,
  WorkspacePatchBatchMessage,
} from './protocol';
import {
  applySnapshotToPatchView,
  applyWorkspacePatchBatch,
  emptyWorkspacePatchViewState,
  enterWorkspacePatchRecovery,
  syncTranscriptPageIntoPatchView,
} from './workspace-patch-reducer';

const task = (id: string, overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  parentId: null,
  goal: `Goal ${id}`,
  role: 'worker',
  lifecycle: 'open',
  runtimeActivity: 'idle',
  viewStatus: 'idle',
  currentTurnActivity: null,
  updatedAt: '2026-07-06T00:00:00.000Z',
  backend: 'claude-cli',
  ...overrides,
});

const userItem = (id: string, text = 'hi'): TranscriptItem => ({
  id,
  kind: 'user',
  content: text,
  turnId: 'turn-1',
  order: 0,
});

const assistantItem = (id: string, text = 'yo'): TranscriptItem => ({
  id,
  kind: 'assistant',
  content: text,
  turnId: 'turn-1',
  order: 1,
  state: 'complete',
});

const reasoningItem = (turnId: string, text: string): TranscriptItem => ({
  id: turnId,
  kind: 'reasoning',
  turnId,
  content: text,
});

const toolItem = (id: string): TranscriptItem => ({
  id,
  kind: 'tool',
  turnId: 'turn-1',
  order: 2,
  content: {
    toolCallId: 'tc-1',
    name: 'bash',
    status: 'running',
  },
});

function batch(revision: number, patches: WorkspacePatchBatchMessage['patches']): WorkspacePatchBatchMessage {
  return { type: 'workspacePatchBatch', revision, patches };
}

function focusedSnapshot(revision: number, opts?: {
  tasks?: TaskSummary[];
  transcript?: TranscriptItem[];
}): SnapshotMessage {
  const tasks = opts?.tasks ?? [task('task-1')];
  return {
    type: 'snapshot',
    protocolVersion: 8,
    rootTasks: tasks,
    focusedTaskId: 'task-1',
    subtree: tasks,
    transcript: opts?.transcript ?? [],
    transcriptPage: { hasMoreBefore: false, workspaceRevision: revision },
    storeRevision: revision,
    queuedTurns: [],
  };
}

describe('workspace-patch-reducer', () => {
  it('snapshot hydrate sets revision and clears recovery', () => {
    let state = emptyWorkspacePatchViewState();
    state = {
      ...state,
      needsRecovery: true,
      revision: 3,
      observedRevision: 9,
    };
    state = applySnapshotToPatchView(state, focusedSnapshot(5, {
      transcript: [userItem('u1')],
    }));
    expect(state.revision).toBe(5);
    expect(state.needsRecovery).toBe(false);
    expect(state.observedRevision).toBeUndefined();
    expect(state.loadedTranscriptIds.has('u1')).toBe(true);
    expect(state.transcriptItems).toHaveLength(1);
  });

  it('applies multi-patch batch atomically at current+1', () => {
    let state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const result = applyWorkspacePatchBatch(
      state,
      batch(2, [
        { type: 'taskUpserted', task: task('task-2', { goal: 'New' }) },
        {
          type: 'queuedTurnsChanged',
          taskId: 'task-1',
          queuedTurns: [
            {
              turnId: 'q1',
              sequence: 1,
              status: 'queued',
              messageIds: ['m1'],
              createdAt: '2026-07-06T00:00:00.000Z',
              previewText: 'later',
            },
          ],
        },
        {
          type: 'transcriptItemsAppended',
          taskId: 'task-1',
          items: [userItem('u1'), assistantItem('a1')],
        },
      ]),
    );
    expect(result.kind).toBe('applied');
    expect(result.applied).toBe(true);
    expect(result.state.revision).toBe(2);
    expect(result.state.tasks.has('task-2')).toBe(true);
    expect(result.state.queuedTurns).toHaveLength(1);
    expect(result.state.transcriptItems.map((i) => i.id)).toEqual(['u1', 'a1']);
  });

  it('stale revision is a no-op', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(5));
    const result = applyWorkspacePatchBatch(
      state,
      batch(3, [{ type: 'taskRemoved', taskId: 'task-1' }]),
    );
    expect(result.kind).toBe('stale');
    expect(result.state).toBe(state);
    expect(result.state.tasks.has('task-1')).toBe(true);
  });

  it('duplicate revision is a no-op', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(5));
    const result = applyWorkspacePatchBatch(
      state,
      batch(5, [{ type: 'taskRemoved', taskId: 'task-1' }]),
    );
    expect(result.kind).toBe('duplicate');
    expect(result.state.tasks.has('task-1')).toBe(true);
  });

  it('empty batch advances revision', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const result = applyWorkspacePatchBatch(state, batch(2, []));
    expect(result.kind).toBe('applied');
    expect(result.state.revision).toBe(2);
    expect(result.state.tasks.has('task-1')).toBe(true);
  });

  it('gap sets needsRecovery with zero partial mutation', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const result = applyWorkspacePatchBatch(
      state,
      batch(4, [
        { type: 'taskRemoved', taskId: 'task-1' },
        {
          type: 'transcriptItemsAppended',
          taskId: 'task-1',
          items: [userItem('u1')],
        },
      ]),
    );
    expect(result.kind).toBe('gap');
    expect(result.enteredRecovery).toBe(true);
    expect(result.state.needsRecovery).toBe(true);
    expect(result.state.revision).toBe(1);
    expect(result.state.tasks.has('task-1')).toBe(true);
    expect(result.state.transcriptItems).toHaveLength(0);
    expect(result.state.observedRevision).toBe(4);
  });

  it('unknown transcript item patch is atomic invariant failure', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const result = applyWorkspacePatchBatch(
      state,
      batch(2, [
        { type: 'taskUpserted', task: task('task-1', { goal: 'changed' }) },
        {
          type: 'transcriptItemPatched',
          taskId: 'task-1',
          item: assistantItem('missing-a1', 'nope'),
        },
      ]),
    );
    expect(result.kind).toBe('invariant');
    expect(result.enteredRecovery).toBe(true);
    expect(result.state.needsRecovery).toBe(true);
    expect(result.state.revision).toBe(1);
    expect(result.state.tasks.get('task-1')?.goal).toBe('Goal task-1');
  });

  it('while recovering, later patches are ignored until snapshot', () => {
    let state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const gap = applyWorkspacePatchBatch(state, batch(5, []));
    state = gap.state;
    expect(state.needsRecovery).toBe(true);

    const ignored = applyWorkspacePatchBatch(
      state,
      batch(2, [{ type: 'taskRemoved', taskId: 'task-1' }]),
    );
    expect(ignored.kind).toBe('recovering');
    expect(ignored.state.tasks.has('task-1')).toBe(true);

    state = applySnapshotToPatchView(state, focusedSnapshot(5));
    expect(state.needsRecovery).toBe(false);
    expect(state.revision).toBe(5);

    const next = applyWorkspacePatchBatch(
      state,
      batch(6, [{ type: 'taskUpserted', task: task('task-9') }]),
    );
    expect(next.kind).toBe('applied');
    expect(next.state.tasks.has('task-9')).toBe(true);
  });

  it('task remove clears focused stale objects', () => {
    let state = applySnapshotToPatchView(
      emptyWorkspacePatchViewState(),
      focusedSnapshot(1, { transcript: [userItem('u1')] }),
    );
    state = {
      ...state,
      queuedTurns: [
        {
          turnId: 'q1',
          sequence: 1,
          status: 'queued',
          messageIds: ['m1'],
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
    };
    const result = applyWorkspacePatchBatch(
      state,
      batch(2, [{ type: 'taskRemoved', taskId: 'task-1' }]),
    );
    expect(result.state.focusedTaskId).toBeNull();
    expect(result.state.queuedTurns).toEqual([]);
    expect(result.state.transcriptItems).toEqual([]);
    expect(result.state.tasks.has('task-1')).toBe(false);
  });

  it('queuedTurnsChanged only applies for matching focused task', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const result = applyWorkspacePatchBatch(
      state,
      batch(2, [
        {
          type: 'queuedTurnsChanged',
          taskId: 'other-task',
          queuedTurns: [
            {
              turnId: 'q1',
              sequence: 1,
              status: 'queued',
              messageIds: ['m1'],
              createdAt: '2026-07-06T00:00:00.000Z',
            },
          ],
        },
      ]),
    );
    expect(result.state.queuedTurns).toEqual([]);
  });

  it('transcript append/patch covers user/assistant/tool/reasoning and rejects relabeled appends', () => {
    let state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const append = applyWorkspacePatchBatch(
      state,
      batch(2, [
        {
          type: 'transcriptItemsAppended',
          taskId: 'task-1',
          items: [
            userItem('u1'),
            assistantItem('a1', 'hello'),
            toolItem('turn-1:tc-1'),
            reasoningItem('turn-1', 'think'),
          ],
        },
      ]),
    );
    state = append.state;
    expect(state.transcriptItems.map((i) => i.id)).toEqual(['u1', 'a1', 'turn-1:tc-1']);
    expect(state.reasoningByTurn['turn-1']).toBe('think');
    expect(state.loadedTranscriptIds.has('turn-1')).toBe(true);

    const dup = applyWorkspacePatchBatch(
      state,
      batch(3, [
        {
          type: 'transcriptItemsAppended',
          taskId: 'task-1',
          items: [userItem('u1', 'again'), assistantItem('a1', 'again')],
        },
      ]),
    );
    expect(dup.kind).toBe('invariant');
    expect(dup.state.needsRecovery).toBe(true);
    expect(dup.state.revision).toBe(2);
    expect(dup.state.transcriptItems.filter((i) => i.id === 'u1')).toHaveLength(1);
    expect(dup.state.transcriptItems.find((i) => i.id === 'a1' && i.kind === 'assistant')).toMatchObject({
      text: 'hello',
    });

    const patched = applyWorkspacePatchBatch(
      state,
      batch(3, [
        {
          type: 'transcriptItemPatched',
          taskId: 'task-1',
          item: assistantItem('a1', 'hello world'),
        },
        {
          type: 'transcriptItemPatched',
          taskId: 'task-1',
          item: {
            id: 'turn-1:tc-1',
            kind: 'tool',
            turnId: 'turn-1',
            order: 2,
            content: {
              toolCallId: 'tc-1',
              name: 'bash',
              status: 'success',
              output: { ok: true },
            },
          },
        },
        {
          type: 'transcriptItemPatched',
          taskId: 'task-1',
          item: reasoningItem('turn-1', 'think harder'),
        },
      ]),
    );
    expect(patched.kind).toBe('applied');
    expect(patched.state.transcriptItems.find((i) => i.id === 'a1')).toMatchObject({ text: 'hello world' });
    expect(patched.state.transcriptItems.find((i) => i.id === 'turn-1:tc-1')).toMatchObject({
      status: 'success',
    });
    expect(patched.state.reasoningByTurn['turn-1']).toBe('think harder');
  });

  it('unknown reasoning patch is an atomic invariant failure', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const result = applyWorkspacePatchBatch(
      state,
      batch(2, [
        { type: 'taskUpserted', task: task('task-1', { goal: 'must-not-apply' }) },
        {
          type: 'transcriptItemPatched',
          taskId: 'task-1',
          item: reasoningItem('turn-1', 'unknown'),
        },
      ]),
    );
    expect(result.kind).toBe('invariant');
    expect(result.state.revision).toBe(1);
    expect(result.state.tasks.get('task-1')?.goal).toBe('Goal task-1');
    expect(result.state.reasoningByTurn).toEqual({});
  });

  it('duplicate stable identities recover before any patch is applied', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const result = applyWorkspacePatchBatch(
      state,
      batch(2, [
        { type: 'taskUpserted', task: task('task-2', { goal: 'first' }) },
        { type: 'turnActivityChanged', task: task('task-2', { goal: 'second' }) },
      ]),
    );
    expect(result.kind).toBe('invariant');
    expect(result.state.revision).toBe(1);
    expect(result.state.tasks.has('task-2')).toBe(false);
  });

  it('ignores a snapshot older than the already-applied patch revision', () => {
    let state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(5));
    state = applyWorkspacePatchBatch(
      state,
      batch(6, [{ type: 'taskUpserted', task: task('task-2') }]),
    ).state;
    const stale = applySnapshotToPatchView(state, focusedSnapshot(5));
    expect(stale).toBe(state);
    expect(stale.revision).toBe(6);
    expect(stale.tasks.has('task-2')).toBe(true);
  });

  it('enters malformed-envelope recovery once without advancing revision', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(4));
    const first = enterWorkspacePatchRecovery(state, 5);
    const second = enterWorkspacePatchRecovery(first.state, 6);
    expect(first.kind).toBe('invariant');
    expect(first.enteredRecovery).toBe(true);
    expect(first.state.revision).toBe(4);
    expect(second.kind).toBe('recovering');
    expect(second.enteredRecovery).toBe(false);
  });

  it('live patch preserves older prepended pages and advances transcript revision via max', () => {
    let state = applySnapshotToPatchView(
      emptyWorkspacePatchViewState(),
      focusedSnapshot(2, { transcript: [userItem('u-live')] }),
    );
    // Simulate W5 older-page ownership already prepended.
    state = {
      ...state,
      transcriptItems: [
        { kind: 'user', id: 'u-old', text: 'older', turnId: 't0', order: 0 },
        ...state.transcriptItems,
      ],
      loadedTranscriptIds: new Set(['u-old', 'u-live']),
      transcriptWorkspaceRevision: 2,
    };

    const result = applyWorkspacePatchBatch(
      state,
      batch(3, [
        {
          type: 'transcriptItemsAppended',
          taskId: 'task-1',
          items: [assistantItem('a-live', 'new')],
        },
      ]),
    );
    expect(result.state.transcriptItems.map((i) => i.id)).toEqual(['u-old', 'u-live', 'a-live']);
    expect(result.state.loadedTranscriptIds.has('u-old')).toBe(true);
    expect(result.state.transcriptWorkspaceRevision).toBe(3);
  });

  it('syncTranscriptPageIntoPatchView keeps older pages for the next live batch', () => {
    let state = applySnapshotToPatchView(
      emptyWorkspacePatchViewState(),
      focusedSnapshot(2, { transcript: [userItem('u-live')] }),
    );
    state = syncTranscriptPageIntoPatchView(state, {
      focusedTaskId: 'task-1',
      transcriptItems: [
        { kind: 'user', id: 'u-old', text: 'older', turnId: 't0', order: 0 },
        { kind: 'user', id: 'u-live', text: 'hi', turnId: 'turn-1', order: 0 },
      ],
      reasoningByTurn: {},
      loadedTranscriptIds: new Set(['u-old', 'u-live']),
      transcriptWorkspaceRevision: 2,
    });
    const result = applyWorkspacePatchBatch(
      state,
      batch(3, [
        {
          type: 'transcriptItemsAppended',
          taskId: 'task-1',
          items: [assistantItem('a-live', 'new')],
        },
      ]),
    );
    expect(result.state.transcriptItems.map((i) => i.id)).toEqual(['u-old', 'u-live', 'a-live']);
  });

  it('does not invent unrelated root membership into focused subtree', () => {
    const state = applySnapshotToPatchView(
      emptyWorkspacePatchViewState(),
      focusedSnapshot(1, { tasks: [task('task-1')] }),
    );
    const result = applyWorkspacePatchBatch(
      state,
      batch(2, [{ type: 'taskUpserted', task: task('other-root') }]),
    );
    expect(result.state.tasks.has('other-root')).toBe(true);
    expect(result.state.subtree.map((t) => t.id)).toEqual(['task-1']);
  });

  it('revision never regresses across gap/recovery/snapshot', () => {
    let state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(10));
    state = applyWorkspacePatchBatch(state, batch(20, [])).state;
    expect(state.revision).toBe(10);
    expect(state.needsRecovery).toBe(true);

    state = applySnapshotToPatchView(state, focusedSnapshot(15));
    expect(state.revision).toBe(15);

    const stale = applyWorkspacePatchBatch(state, batch(14, []));
    expect(stale.kind).toBe('stale');
    expect(stale.state.revision).toBe(15);
  });

  it('turnActivityChanged uses full TaskSummary payload', () => {
    const state = applySnapshotToPatchView(emptyWorkspacePatchViewState(), focusedSnapshot(1));
    const next = task('task-1', {
      runtimeActivity: 'running',
      viewStatus: 'running',
      currentTurnActivity: { state: 'executing', turnId: 'turn-1', phase: 'streaming' },
    });
    const result = applyWorkspacePatchBatch(
      state,
      batch(2, [{ type: 'turnActivityChanged', task: next }]),
    );
    expect(result.state.tasks.get('task-1')).toEqual(next);
  });
});
