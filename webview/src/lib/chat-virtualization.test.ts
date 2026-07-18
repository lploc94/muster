import { describe, expect, it } from 'vitest';
import type { ThreadItem } from './turn-state.svelte';
import {
  CHAT_VIRTUAL_MAX_MOUNTED_ROWS,
  CHAT_VIRTUAL_OVERSCAN,
  createTranscriptEstimateSize,
  expandRangeWithOverscan,
  findTranscriptIndexById,
  firstVisibleVirtualItemId,
  isBlockStartAtIndex,
  isMountedRowCountBounded,
  lastAssistantId,
  restoreVirtualPrependOffset,
  shouldRequestOlderFromVirtualTop,
  estimateTranscriptItemSize,
} from './chat-virtualization';

function user(id: string, text = 'hi'): ThreadItem {
  return { kind: 'user', id, text, turnId: `turn-${id}`, order: 0 };
}

function assistant(id: string, text = 'yo', turnId = 'turn-a'): ThreadItem {
  return { kind: 'assistant', id, text, turnId, order: 1 };
}

function tool(id: string, status: 'running' | 'success' | 'error' = 'success'): ThreadItem {
  return {
    kind: 'tool',
    id,
    name: 'bash',
    status,
    input: { cmd: 'echo' },
    turnId: 'turn-a',
    order: 2,
  };
}

describe('chat-virtualization range helpers', () => {
  it('expands a core range by overscan and clamps to list bounds', () => {
    expect(
      expandRangeWithOverscan({ count: 100, startIndex: 0, endIndex: 5, overscan: 8 }),
    ).toEqual({ startIndex: 0, endIndex: 13 });
    expect(
      expandRangeWithOverscan({ count: 100, startIndex: 90, endIndex: 99, overscan: 8 }),
    ).toEqual({ startIndex: 82, endIndex: 100 });
    expect(
      expandRangeWithOverscan({ count: 10, startIndex: 4, endIndex: 6, overscan: 2 }),
    ).toEqual({ startIndex: 2, endIndex: 8 });
    expect(expandRangeWithOverscan({ count: 0, startIndex: 0, endIndex: 0 })).toEqual({
      startIndex: 0,
      endIndex: 0,
    });
  });

  it('rejects mounted counts above the Phase 6 ceiling', () => {
    expect(isMountedRowCountBounded(0)).toBe(true);
    expect(isMountedRowCountBounded(CHAT_VIRTUAL_MAX_MOUNTED_ROWS)).toBe(true);
    expect(isMountedRowCountBounded(CHAT_VIRTUAL_MAX_MOUNTED_ROWS + 1)).toBe(false);
    expect(isMountedRowCountBounded(-1)).toBe(false);
    expect(CHAT_VIRTUAL_OVERSCAN).toBeGreaterThan(0);
  });
});

describe('full-list chronology at virtual boundaries', () => {
  const items: ThreadItem[] = [
    user('u1', 'hello'),
    assistant('a1', 'world', 't1'),
    tool('tool-1'),
    user('u2', 'again'),
    assistant('a2', 'ok', 't2'),
  ];

  it('detects block starts from full-list neighbors, not slice-local indexes', () => {
    expect(isBlockStartAtIndex(items, 0)).toBe(false); // user
    expect(isBlockStartAtIndex(items, 1)).toBe(true); // assistant after user
    expect(isBlockStartAtIndex(items, 2)).toBe(false); // tool continues block
    expect(isBlockStartAtIndex(items, 4)).toBe(true); // new block after user
    // Boundary case: if a virtual slice started at index 2, slice-local logic
    // would wrongly treat tool as block start; full-list neighbor does not.
    expect(isBlockStartAtIndex(items.slice(2), 0)).toBe(true); // slice-local trap
    expect(isBlockStartAtIndex(items, 2)).toBe(false); // correct full-list answer
  });

  it('resolves last assistant and index lookup across the full list', () => {
    expect(lastAssistantId(items)).toBe('a2');
    expect(findTranscriptIndexById(items, 'tool-1')).toBe(2);
    expect(findTranscriptIndexById(items, 'missing')).toBe(-1);
    expect(findTranscriptIndexById(items, undefined)).toBe(-1);
  });
});

describe('variable estimates and prepend offset restore', () => {
  it('estimates tall markdown larger than one-line bubbles', () => {
    const short = estimateTranscriptItemSize(assistant('a', 'ok'));
    const tall = estimateTranscriptItemSize(
      assistant('b', `${'paragraph\n'.repeat(40)}${'x'.repeat(400)}`),
    );
    expect(tall).toBeGreaterThan(short);
    expect(estimateTranscriptItemSize(tool('t', 'running'))).toBeGreaterThan(0);
  });

  it('includes block-start header/reasoning in estimates', () => {
    const base = estimateTranscriptItemSize(assistant('a', 'hi'));
    const withHeader = estimateTranscriptItemSize(assistant('a', 'hi'), {
      isBlockStart: true,
      reasoningChars: 200,
    });
    expect(withHeader).toBeGreaterThan(base);
  });

  it('createTranscriptEstimateSize uses full-list block-start', () => {
    const items = [user('u1'), assistant('a1', 'hi', 't1')];
    const estimate = createTranscriptEstimateSize(items, { t1: 'thinking hard' });
    expect(estimate(1)).toBeGreaterThan(estimateTranscriptItemSize(items[1]!));
    expect(estimate(99)).toBeGreaterThan(0);
  });

  it('restores prepend offset by stable item measurement delta', () => {
    expect(
      restoreVirtualPrependOffset({
        previousScrollOffset: 100,
        previousItemOffset: 200,
        nextItemOffset: 700,
        previousTotalSize: 1000,
        nextTotalSize: 1500,
      }),
    ).toBe(600);
  });

  it('falls back to total-size delta when the stable row is unmeasured', () => {
    expect(
      restoreVirtualPrependOffset({
        previousScrollOffset: 100,
        previousItemOffset: 200,
        nextItemOffset: undefined,
        previousTotalSize: 1000,
        nextTotalSize: 1500,
      }),
    ).toBe(600);
  });

  it('picks the first virtual row past the viewport top', () => {
    expect(
      firstVisibleVirtualItemId(
        [
          { id: 'a', start: 0, end: 40 },
          { id: 'b', start: 40, end: 80 },
          { id: 'c', start: 80, end: 120 },
        ],
        50,
      ),
    ).toBe('b');
  });
});

describe('virtual top older-page request', () => {
  const base = {
    hasMoreBefore: true,
    beforeCursor: 'v2.cursor',
    loading: false,
    scrollLocked: false,
    scrollOffset: 10,
    topThresholdPx: 80,
    overflow: true,
  };

  it('requests when near virtual top with more history', () => {
    expect(shouldRequestOlderFromVirtualTop(base)).toBe(true);
  });

  it('blocks when locked, loading, missing cursor, or no more', () => {
    expect(shouldRequestOlderFromVirtualTop({ ...base, scrollLocked: true })).toBe(false);
    expect(shouldRequestOlderFromVirtualTop({ ...base, loading: true })).toBe(false);
    expect(shouldRequestOlderFromVirtualTop({ ...base, beforeCursor: undefined })).toBe(false);
    expect(shouldRequestOlderFromVirtualTop({ ...base, hasMoreBefore: false })).toBe(false);
  });

  it('does not auto-fetch short non-overflow windows; force still works', () => {
    expect(shouldRequestOlderFromVirtualTop({ ...base, overflow: false })).toBe(false);
    expect(shouldRequestOlderFromVirtualTop({ ...base, overflow: false, force: true })).toBe(
      true,
    );
  });
});
