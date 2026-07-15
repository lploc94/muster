/** Pure helpers for transcript scroll continuity (task-tree panel open/close). */

export const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 80;

export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx = CHAT_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx;
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

export function shouldAutoScrollToBottom(pinned: boolean, locked: boolean): boolean {
  return pinned && !locked;
}
