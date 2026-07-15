import { describe, expect, it } from 'vitest';
import {
  isNearBottom,
  pinnedAfterUnlock,
  resolveLockedScrollTop,
  shouldAutoScrollToBottom,
} from './chat-scroll';

describe('chat-scroll continuity', () => {
  it('detects near-bottom within threshold', () => {
    expect(isNearBottom(920, 1000, 100)).toBe(true);
    expect(isNearBottom(800, 1000, 100)).toBe(false);
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

  it('disables auto-scroll while panel locks transcript', () => {
    expect(shouldAutoScrollToBottom(true, false)).toBe(true);
    expect(shouldAutoScrollToBottom(true, true)).toBe(false);
    expect(shouldAutoScrollToBottom(false, false)).toBe(false);
  });
});
