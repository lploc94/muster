/** Pure helpers for transcript scroll continuity (task-tree panel open/close). */

export const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 80;
/** Near-top threshold that can auto-request an older transcript page (W5). */
export const CHAT_SCROLL_TOP_THRESHOLD_PX = 80;

export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx = CHAT_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx;
}

export function pinnedAfterScroll(
  pinned: boolean,
  previousScrollTop: number,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  if (scrollTop < previousScrollTop) return false;
  if (scrollTop === previousScrollTop && !pinned) return false;
  return isNearBottom(scrollTop, scrollHeight, clientHeight);
}

export function isNearTop(
  scrollTop: number,
  thresholdPx = CHAT_SCROLL_TOP_THRESHOLD_PX,
): boolean {
  return scrollTop <= thresholdPx;
}

/**
 * When the tree panel locks scroll, keep the prior scrollTop.
 * Returns the scrollTop to apply (frozen value while locked).
 */
export function resolveLockedScrollTop(
  locked: boolean,
  frozenScrollTop: number | null,
  currentScrollTop: number,
): number {
  if (!locked || frozenScrollTop === null) return currentScrollTop;
  return frozenScrollTop;
}

export function captureScrollTop(scrollTop: number): number {
  return scrollTop;
}

/** After unlock, whether auto-pin-to-bottom should resume from frozen position. */
export function pinnedAfterUnlock(
  frozenScrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return isNearBottom(frozenScrollTop, scrollHeight, clientHeight);
}

/**
 * Auto-scroll to bottom only when pinned, unlocked, and not restoring a
 * prepend scroll anchor after loading older messages.
 */
export function shouldAutoScrollToBottom(
  pinned: boolean,
  locked: boolean,
  restoringPrependAnchor = false,
): boolean {
  return pinned && !locked && !restoringPrependAnchor;
}

/** Whether the chat may request an older page from scroll/button UX. */
export function shouldLoadOlder(opts: {
  hasMoreBefore: boolean;
  beforeCursor?: string;
  loading: boolean;
  scrollLocked: boolean;
  nearTop: boolean;
  overflow: boolean;
  /** Button click bypasses nearTop/overflow gates. */
  force?: boolean;
}): boolean {
  if (!opts.hasMoreBefore || !opts.beforeCursor) return false;
  if (opts.loading || opts.scrollLocked) return false;
  if (opts.force) return true;
  // Short transcripts that do not overflow must not auto-fetch indefinitely.
  if (!opts.overflow) return false;
  return opts.nearTop;
}

/** Capture stable-row + height metrics before an older page is prepended. */
export interface PrependScrollAnchor {
  itemId?: string;
  itemTop?: number;
  scrollTop: number;
  scrollHeight: number;
  /** Task that owned the request (required for cancel-safe restore). */
  taskId?: string;
  /** Request id that owned the request (required for cancel-safe restore). */
  requestId?: string;
}

/**
 * In-flight prepend restore attempt. Carries identity so a stale async closure
 * after `await tick()` cannot mutate scroll for a different task/request.
 */
export interface PrependRestoreAttempt {
  requestId: string;
  taskId: string;
  anchor: PrependScrollAnchor;
  /** Monotonic epoch; cleanup increments so cancelled closures become no-ops. */
  epoch: number;
}

export type PrependRestoreDecision = 'restore' | 'wait_unlock' | 'cancel' | 'noop';

/**
 * Pure gate for whether a post-tick prepend restore may mutate scrollTop.
 * - restore: all identity checks pass and unlocked
 * - wait_unlock: identity still valid but scroll is locked (keep anchor)
 * - cancel: identity invalidated (focus/hydrate/new request) — drop attempt
 * - noop: no attempt / incomplete
 */
export function decidePrependRestore(opts: {
  attempt: PrependRestoreAttempt | null | undefined;
  currentEpoch: number;
  currentTaskId: string | null | undefined;
  pendingRestoreRequestId?: string;
  pendingAnchor: PrependScrollAnchor | null | undefined;
  lastAppliedRequestId?: string;
  scrollLocked: boolean;
}): PrependRestoreDecision {
  const attempt = opts.attempt;
  if (!attempt) return 'noop';
  if (attempt.epoch !== opts.currentEpoch) return 'cancel';
  if (!opts.currentTaskId || attempt.taskId !== opts.currentTaskId) return 'cancel';
  if (opts.pendingRestoreRequestId !== attempt.requestId) return 'cancel';
  if (opts.lastAppliedRequestId !== attempt.requestId) return 'cancel';
  if (!opts.pendingAnchor || opts.pendingAnchor !== attempt.anchor) {
    // Identity by request/task is enough if anchor object was replaced with same request.
    if (
      !opts.pendingAnchor ||
      opts.pendingAnchor.requestId !== attempt.requestId ||
      opts.pendingAnchor.taskId !== attempt.taskId
    ) {
      return 'cancel';
    }
  }
  if (opts.scrollLocked) return 'wait_unlock';
  return 'restore';
}

export function capturePrependAnchor(opts: {
  scrollTop: number;
  scrollHeight: number;
  itemId?: string;
  itemTop?: number;
}): PrependScrollAnchor {
  return {
    scrollTop: opts.scrollTop,
    scrollHeight: opts.scrollHeight,
    ...(opts.itemId !== undefined ? { itemId: opts.itemId } : {}),
    ...(opts.itemTop !== undefined ? { itemTop: opts.itemTop } : {}),
  };
}

/**
 * Preferred: restore by stable row top delta after prepend.
 * Fallback: scrollHeight growth when the stable row is missing.
 */
export function restorePrependScrollTop(
  anchor: PrependScrollAnchor,
  opts: {
    nextScrollHeight: number;
    nextItemTop?: number;
  },
): number {
  if (
    anchor.itemId !== undefined &&
    anchor.itemTop !== undefined &&
    opts.nextItemTop !== undefined
  ) {
    return Math.max(0, anchor.scrollTop + (opts.nextItemTop - anchor.itemTop));
  }
  return Math.max(0, anchor.scrollTop + (opts.nextScrollHeight - anchor.scrollHeight));
}

/** Find the first visible row id from a list of top offsets. */
export function firstVisibleTranscriptId(
  rows: ReadonlyArray<{ id: string; top: number; bottom: number }>,
  viewportTop: number,
): string | undefined {
  for (const row of rows) {
    if (row.bottom > viewportTop) return row.id;
  }
  return rows[0]?.id;
}
