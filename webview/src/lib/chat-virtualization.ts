/**
 * Pure helpers for bounded chat virtualization (Phase 6).
 * Virtualization mounts only viewport+overscan settled rows; TaskThread ownership is unchanged.
 */

import type { ThreadItem } from './turn-state.svelte';

/** Default overscan (rows above/below viewport) for variable-height chat. */
export const CHAT_VIRTUAL_OVERSCAN = 8;

/**
 * Hard ceiling used by Playwright/bench oracles. Real mounted count is viewport-driven
 * and must stay at or below this for the standard desktop fixture.
 */
export const CHAT_VIRTUAL_MAX_MOUNTED_ROWS = 80;

/** Fallback estimate when content length is unknown (px). */
export const CHAT_DEFAULT_ESTIMATE_PX = 72;

/** Minimum estimate for a single-line bubble (px). */
export const CHAT_MIN_ESTIMATE_PX = 40;

/** Extra height reserved when a block-start header/reasoning may render (px). */
export const CHAT_BLOCK_HEADER_ESTIMATE_PX = 36;

/**
 * Estimate a settled transcript row height from content. Used only as the
 * virtualizer's initial guess; ResizeObserver measurement replaces it.
 */
export function estimateTranscriptItemSize(
  item: ThreadItem,
  opts?: { isBlockStart?: boolean; reasoningChars?: number },
): number {
  let body = CHAT_MIN_ESTIMATE_PX;
  switch (item.kind) {
    case 'user':
    case 'assistant': {
      const text = item.text ?? '';
      const lines = Math.max(1, text.split('\n').length);
      const wrapped = Math.ceil(text.length / 72);
      body = Math.min(480, CHAT_MIN_ESTIMATE_PX + Math.max(lines, wrapped) * 18);
      break;
    }
    case 'tool':
      body = item.status === 'running' ? 88 : 120;
      break;
    case 'error':
      body = 48;
      break;
    default:
      body = CHAT_DEFAULT_ESTIMATE_PX;
  }
  let total = body;
  if (opts?.isBlockStart) {
    total += CHAT_BLOCK_HEADER_ESTIMATE_PX;
    if (opts.reasoningChars && opts.reasoningChars > 0) {
      total += Math.min(200, 24 + Math.ceil(opts.reasoningChars / 80) * 16);
    }
  }
  return total;
}

/**
 * Whether index starts a response block (backend chip + optional reasoning).
 * Uses full-list neighbors, never the virtual slice index alone.
 */
export function isBlockStartAtIndex(
  items: ReadonlyArray<Pick<ThreadItem, 'kind'>>,
  index: number,
): boolean {
  if (index < 0 || index >= items.length) return false;
  const item = items[index]!;
  if (item.kind !== 'assistant' && item.kind !== 'tool') return false;
  const prev = index > 0 ? items[index - 1] : null;
  return index === 0 || prev?.kind === 'user';
}

/** Id of the last settled assistant item, or null. */
export function lastAssistantId(
  items: ReadonlyArray<Pick<ThreadItem, 'kind' | 'id'>>,
): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === 'assistant') return item.id;
  }
  return null;
}

/** Index of an item id in the full settled list, or -1. */
export function findTranscriptIndexById(
  items: ReadonlyArray<{ id: string }>,
  id: string | undefined,
): number {
  if (!id) return -1;
  return items.findIndex((item) => item.id === id);
}

/**
 * Expand a core visible range by overscan and clamp to [0, count).
 * Rejects naive single-fixture special cases by remaining purely arithmetic.
 */
export function expandRangeWithOverscan(opts: {
  count: number;
  startIndex: number;
  endIndex: number;
  overscan?: number;
}): { startIndex: number; endIndex: number } {
  const count = Math.max(0, opts.count);
  if (count === 0) return { startIndex: 0, endIndex: 0 };
  const overscan = opts.overscan ?? CHAT_VIRTUAL_OVERSCAN;
  const startIndex = Math.max(0, Math.min(count - 1, opts.startIndex) - overscan);
  const endIndex = Math.min(count, Math.max(opts.startIndex, opts.endIndex) + overscan);
  return { startIndex, endIndex };
}

/**
 * Whether the mounted virtual window size is within the Phase 6 ceiling.
 * end is exclusive.
 */
export function isMountedRowCountBounded(
  mountedCount: number,
  maxMounted = CHAT_VIRTUAL_MAX_MOUNTED_ROWS,
): boolean {
  return (
    Number.isFinite(mountedCount) &&
    mountedCount >= 0 &&
    mountedCount <= maxMounted
  );
}

/**
 * Resolve the first visible settled item id from virtualizer measurements.
 * Prefers the first row whose end is past viewportTop (same contract as chat-scroll).
 */
export function firstVisibleVirtualItemId(
  rows: ReadonlyArray<{ id: string; start: number; end: number }>,
  viewportTop: number,
): string | undefined {
  for (const row of rows) {
    if (row.end > viewportTop) return row.id;
  }
  return rows[0]?.id;
}

/**
 * Scroll offset that keeps a previously visible row at the same viewport offset
 * after a variable-height prepend (measurement-keyed by id).
 */
export function restoreVirtualPrependOffset(opts: {
  previousScrollOffset: number;
  previousItemOffset: number | undefined;
  nextItemOffset: number | undefined;
  previousTotalSize: number;
  nextTotalSize: number;
}): number {
  if (
    opts.previousItemOffset !== undefined &&
    opts.nextItemOffset !== undefined
  ) {
    return Math.max(
      0,
      opts.previousScrollOffset + (opts.nextItemOffset - opts.previousItemOffset),
    );
  }
  return Math.max(
    0,
    opts.previousScrollOffset + (opts.nextTotalSize - opts.previousTotalSize),
  );
}

/**
 * Auto-load older pages when the virtual window reaches the top overscan zone.
 * Force bypasses near-top/overflow (button path).
 */
export function shouldRequestOlderFromVirtualTop(opts: {
  hasMoreBefore: boolean;
  beforeCursor?: string;
  loading: boolean;
  scrollLocked: boolean;
  scrollOffset: number;
  topThresholdPx: number;
  overflow: boolean;
  force?: boolean;
}): boolean {
  if (!opts.hasMoreBefore || !opts.beforeCursor) return false;
  if (opts.loading || opts.scrollLocked) return false;
  if (opts.force) return true;
  if (!opts.overflow) return false;
  return opts.scrollOffset <= opts.topThresholdPx;
}

/**
 * Build estimateSize(index) using full-list chronology and optional reasoning.
 */
export function createTranscriptEstimateSize(
  items: ReadonlyArray<ThreadItem>,
  reasoningByTurn: Readonly<Record<string, string>>,
): (index: number) => number {
  return (index: number) => {
    const item = items[index];
    if (!item) return CHAT_DEFAULT_ESTIMATE_PX;
    const blockStart = isBlockStartAtIndex(items, index);
    const turnId =
      item.kind === 'assistant' || item.kind === 'tool' ? item.turnId : undefined;
    const reasoning = turnId ? reasoningByTurn[turnId] : undefined;
    return estimateTranscriptItemSize(item, {
      isBlockStart: blockStart,
      reasoningChars: reasoning?.length ?? 0,
    });
  };
}
