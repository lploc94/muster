import { describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

import type { OutMessage, QueuedTurnProjection, TranscriptItem } from './protocol';
import {
  buildDeleteQueuedTurnMessage,
  buildEditQueuedTurnMessage,
  canMutateQueuedTurn,
  isQueuedTurnMutable,
  resolveQueuedTurnPreview,
  sortQueuedTurns,
  type QueuedTurnControlState,
  queuedTurnControlState,
} from './queued-turns';

const baseTurn = (overrides: Partial<QueuedTurnProjection> = {}): QueuedTurnProjection => ({
  turnId: 'turn-q1',
  sequence: 2,
  status: 'queued',
  messageIds: ['msg-1'],
  createdAt: '2026-01-01T00:00:02.000Z',
  ...overrides,
});

describe('sortQueuedTurns', () => {
  it('orders by FIFO sequence then createdAt then turnId', () => {
    const turns = [
      baseTurn({ turnId: 'c', sequence: 3, createdAt: '2026-01-01T00:00:03.000Z' }),
      baseTurn({ turnId: 'a', sequence: 1, createdAt: '2026-01-01T00:00:01.000Z' }),
      baseTurn({ turnId: 'b', sequence: 2, createdAt: '2026-01-01T00:00:02.000Z' }),
    ];
    expect(sortQueuedTurns(turns).map((t) => t.turnId)).toEqual(['a', 'b', 'c']);
  });
});

describe('resolveQueuedTurnPreview', () => {
  it('joins bound user message content from transcript by messageIds order', () => {
    const transcript: TranscriptItem[] = [
      { id: 'msg-other', kind: 'user', content: 'noise', turnId: 'turn-live' },
      { id: 'msg-1', kind: 'user', content: 'first half', turnId: 'turn-q1' },
      { id: 'msg-2', kind: 'user', content: 'second half', turnId: 'turn-q1' },
      { id: 'msg-a', kind: 'assistant', content: 'reply', turnId: 'turn-live' },
    ];
    const turn = baseTurn({ messageIds: ['msg-1', 'msg-2'] });
    expect(resolveQueuedTurnPreview(turn, transcript)).toBe('first half\nsecond half');
  });

  it('returns empty string when bound messages are missing from transcript', () => {
    expect(resolveQueuedTurnPreview(baseTurn(), [])).toBe('');
  });

  it('ignores non-user transcript items even if ids match', () => {
    const transcript: TranscriptItem[] = [
      { id: 'msg-1', kind: 'assistant', content: 'not user', turnId: 'turn-q1' },
    ];
    expect(resolveQueuedTurnPreview(baseTurn(), transcript)).toBe('');
  });
});

describe('canMutateQueuedTurn / isQueuedTurnMutable', () => {
  it('allows mutation only while projection status is queued', () => {
    expect(canMutateQueuedTurn(baseTurn())).toBe(true);
    expect(canMutateQueuedTurn({ ...baseTurn(), status: 'queued' })).toBe(true);
    // Defensive: any non-queued status locks controls (dispatched / stale).
    expect(canMutateQueuedTurn({ status: 'running' })).toBe(false);
  });

  it('locks controls when turnId is no longer present in the live queuedTurns projection', () => {
    const queued = [baseTurn({ turnId: 'still-queued' })];
    expect(isQueuedTurnMutable('still-queued', queued)).toBe(true);
    expect(isQueuedTurnMutable('dispatched-turn', queued)).toBe(false);
    expect(isQueuedTurnMutable('still-queued', [])).toBe(false);
  });
});

describe('queuedTurnControlState', () => {
  it('builds editable control state for an undispatched queued turn', () => {
    const turn = baseTurn();
    const transcript: TranscriptItem[] = [
      { id: 'msg-1', kind: 'user', content: '  revise me  ', turnId: turn.turnId },
    ];
    const state: QueuedTurnControlState = queuedTurnControlState(turn, transcript, [turn]);
    expect(state).toEqual({
      turnId: 'turn-q1',
      sequence: 2,
      previewText: 'revise me',
      locked: false,
      canEdit: true,
      canDelete: true,
    });
  });

  it('locks edit/delete once the turn leaves the queuedTurns projection (dispatch boundary)', () => {
    const turn = baseTurn({ turnId: 'was-queued' });
    const state = queuedTurnControlState(turn, [], []);
    expect(state.locked).toBe(true);
    expect(state.canEdit).toBe(false);
    expect(state.canDelete).toBe(false);
  });
});

describe('buildEditQueuedTurnMessage / buildDeleteQueuedTurnMessage', () => {
  it('builds edit OutMessage only for non-empty trimmed content', () => {
    const ok = buildEditQueuedTurnMessage('task-1', 'turn-q1', '  revised follow-up  ');
    expect(ok).toEqual({
      type: 'editQueuedTurn',
      taskId: 'task-1',
      turnId: 'turn-q1',
      content: 'revised follow-up',
    } satisfies OutMessage);
    expect(buildEditQueuedTurnMessage('task-1', 'turn-q1', '   ')).toBeNull();
    expect(buildEditQueuedTurnMessage('task-1', 'turn-q1', '')).toBeNull();
  });

  it('builds delete OutMessage by turn identity without cancelProcess semantics', () => {
    expect(buildDeleteQueuedTurnMessage('task-1', 'turn-q1')).toEqual({
      type: 'deleteQueuedTurn',
      taskId: 'task-1',
      turnId: 'turn-q1',
    } satisfies OutMessage);
  });

  it('refuses to build mutation messages when controls are locked', () => {
    expect(
      buildEditQueuedTurnMessage('task-1', 'turn-q1', 'too late', { locked: true }),
    ).toBeNull();
    expect(buildDeleteQueuedTurnMessage('task-1', 'turn-q1', { locked: true })).toBeNull();
  });

  it('treats ThreadItem-shaped previews (text field) the same as transcript content', () => {
    const turn = baseTurn({ messageIds: ['msg-1'] });
    const threadItems = [{ id: 'msg-1', kind: 'user' as const, text: 'from thread' }];
    expect(resolveQueuedTurnPreview(turn, threadItems)).toBe('from thread');
    expect(queuedTurnControlState(turn, threadItems, [turn]).previewText).toBe('from thread');
  });
});
