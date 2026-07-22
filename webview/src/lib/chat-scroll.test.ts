import { describe, expect, it } from 'vitest';
import {
  capturePrependAnchor,
  decidePrependRestore,
  firstVisibleTranscriptId,
  isNearBottom,
  isNearTop,
  pinnedAfterScroll,
  pinnedAfterUnlock,
  resolveLockedScrollTop,
  restorePrependScrollTop,
  shouldAutoScrollToBottom,
  shouldLoadOlder,
  type PrependRestoreAttempt,
  type PrependScrollAnchor,
} from './chat-scroll';

describe('chat-scroll continuity', () => {
  it('detects near-bottom within threshold', () => {
    expect(isNearBottom(920, 1000, 100)).toBe(true);
    expect(isNearBottom(800, 1000, 100)).toBe(false);
  });

  it('detects near-top within threshold', () => {
    expect(isNearTop(0)).toBe(true);
    expect(isNearTop(40)).toBe(true);
    expect(isNearTop(120)).toBe(false);
  });

  it('unpins on any upward scroll, even within the bottom threshold', () => {
    expect(pinnedAfterScroll(true, 920, 900, 1000, 100)).toBe(false);
    expect(pinnedAfterScroll(false, 900, 920, 1000, 100)).toBe(true);
    expect(pinnedAfterScroll(false, 920, 920, 1000, 100)).toBe(false);
  });

  it('freezes scrollTop while locked', () => {
    expect(resolveLockedScrollTop(true, 120, 400)).toBe(120);
    expect(resolveLockedScrollTop(false, 120, 400)).toBe(400);
    expect(resolveLockedScrollTop(true, null, 400)).toBe(400);
  });

  it('restores pin state from frozen position on unlock', () => {
    expect(pinnedAfterUnlock(920, 1000, 100)).toBe(true);
    expect(pinnedAfterUnlock(100, 1000, 100)).toBe(false);
  });

  it('disables auto-scroll while panel locks transcript or restoring prepend anchor', () => {
    expect(shouldAutoScrollToBottom(true, false)).toBe(true);
    expect(shouldAutoScrollToBottom(true, true)).toBe(false);
    expect(shouldAutoScrollToBottom(false, false)).toBe(false);
    expect(shouldAutoScrollToBottom(true, false, true)).toBe(false);
  });
});

describe('prepend scroll anchor', () => {
  it('restores by stable row top delta when available', () => {
    const anchor = capturePrependAnchor({
      scrollTop: 100,
      scrollHeight: 1000,
      itemId: 'msg-10',
      itemTop: 200,
    });
    expect(restorePrependScrollTop(anchor, { nextScrollHeight: 1500, nextItemTop: 700 })).toBe(
      600,
    );
  });

  it('falls back to scrollHeight delta when stable row is missing', () => {
    const anchor = capturePrependAnchor({
      scrollTop: 100,
      scrollHeight: 1000,
      itemId: 'msg-10',
      itemTop: 200,
    });
    expect(restorePrependScrollTop(anchor, { nextScrollHeight: 1500 })).toBe(600);
  });

  it('finds the first visible transcript id', () => {
    expect(
      firstVisibleTranscriptId(
        [
          { id: 'a', top: 0, bottom: 40 },
          { id: 'b', top: 40, bottom: 80 },
          { id: 'c', top: 80, bottom: 120 },
        ],
        50,
      ),
    ).toBe('b');
  });
});

describe('shouldLoadOlder', () => {
  const base = {
    hasMoreBefore: true,
    beforeCursor: 'v2.cursor',
    loading: false,
    scrollLocked: false,
    nearTop: true,
    overflow: true,
  };

  it('allows one request when near top with more history and overflow', () => {
    expect(shouldLoadOlder(base)).toBe(true);
  });

  it('blocks when locked, loading, missing cursor, or no more', () => {
    expect(shouldLoadOlder({ ...base, scrollLocked: true })).toBe(false);
    expect(shouldLoadOlder({ ...base, loading: true })).toBe(false);
    expect(shouldLoadOlder({ ...base, beforeCursor: undefined })).toBe(false);
    expect(shouldLoadOlder({ ...base, hasMoreBefore: false })).toBe(false);
  });

  it('does not auto-fetch short non-overflow transcripts, but force still works', () => {
    expect(shouldLoadOlder({ ...base, overflow: false, nearTop: true })).toBe(false);
    expect(shouldLoadOlder({ ...base, overflow: false, force: true })).toBe(true);
  });
});

describe('decidePrependRestore cancel-safety', () => {
  const anchor: PrependScrollAnchor = {
    scrollTop: 40,
    scrollHeight: 800,
    itemId: 'msg-10',
    itemTop: 100,
    taskId: 'task-1',
    requestId: 'req-1',
  };
  const attempt: PrependRestoreAttempt = {
    requestId: 'req-1',
    taskId: 'task-1',
    anchor,
    epoch: 1,
  };
  const ok = {
    attempt,
    currentEpoch: 1,
    currentTaskId: 'task-1',
    pendingRestoreRequestId: 'req-1',
    pendingAnchor: anchor,
    lastAppliedRequestId: 'req-1',
    scrollLocked: false,
  };

  it('restores when identity matches and unlocked', () => {
    expect(decidePrependRestore(ok)).toBe('restore');
  });

  it('cancels after focus change or epoch bump (stale post-tick closure)', () => {
    expect(decidePrependRestore({ ...ok, currentTaskId: 'task-2' })).toBe('cancel');
    expect(decidePrependRestore({ ...ok, currentEpoch: 2 })).toBe('cancel');
    expect(decidePrependRestore({ ...ok, lastAppliedRequestId: undefined })).toBe('cancel');
  });

  it('cancels same-task hydrate that cleared pending request identity', () => {
    expect(
      decidePrependRestore({
        ...ok,
        pendingRestoreRequestId: undefined,
        pendingAnchor: null,
        lastAppliedRequestId: undefined,
      }),
    ).toBe('cancel');
  });

  it('waits when scrollLocked mid-restore and does not cancel identity', () => {
    expect(decidePrependRestore({ ...ok, scrollLocked: true })).toBe('wait_unlock');
  });

  it('cancels when a newer request replaced the pending restore id', () => {
    expect(
      decidePrependRestore({
        ...ok,
        pendingRestoreRequestId: 'req-2',
        pendingAnchor: { ...anchor, requestId: 'req-2' },
      }),
    ).toBe('cancel');
  });
});
