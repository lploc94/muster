import { describe, expect, it } from 'vitest';
import {
  resolveFileMentionKeyIntent,
  shouldPreventDefaultForFileMentionKey,
  type FileMentionKeyboardInput,
  type FileMentionKeyboardOptions,
} from './file-mention-keyboard';

function key(
  partial: Partial<FileMentionKeyboardInput> & Pick<FileMentionKeyboardInput, 'key'>,
): FileMentionKeyboardInput {
  return {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...partial,
  };
}

function open(partial: Partial<FileMentionKeyboardOptions> = {}): FileMentionKeyboardOptions {
  return {
    popupOpen: true,
    itemCount: 3,
    activeIndex: 0,
    activeSelectable: true,
    ...partial,
  };
}

describe('resolveFileMentionKeyIntent', () => {
  it('returns none when popup is inactive so composer submit can own Enter', () => {
    const inactive = { popupOpen: false, itemCount: 0, activeIndex: -1 };
    expect(resolveFileMentionKeyIntent(key({ key: 'Enter' }), inactive)).toEqual({ kind: 'none' });
    expect(resolveFileMentionKeyIntent(key({ key: 'Tab' }), inactive)).toEqual({ kind: 'none' });
    expect(resolveFileMentionKeyIntent(key({ key: 'ArrowDown' }), inactive)).toEqual({ kind: 'none' });
    expect(resolveFileMentionKeyIntent(key({ key: 'Escape' }), inactive)).toEqual({ kind: 'none' });
    expect(shouldPreventDefaultForFileMentionKey(key({ key: 'Enter' }), inactive)).toBe(false);
  });

  it('returns none when popup is open but empty (no options to navigate)', () => {
    const empty = open({ itemCount: 0, activeIndex: -1 });
    expect(resolveFileMentionKeyIntent(key({ key: 'ArrowDown' }), empty)).toEqual({ kind: 'none' });
    expect(resolveFileMentionKeyIntent(key({ key: 'Enter' }), empty)).toEqual({ kind: 'none' });
    expect(resolveFileMentionKeyIntent(key({ key: 'Tab' }), empty)).toEqual({ kind: 'none' });
  });

  it('never accepts or navigates during IME composition or keyCode 229', () => {
    const opts = open();
    expect(
      resolveFileMentionKeyIntent(key({ key: 'Enter', isComposing: true }), opts),
    ).toEqual({ kind: 'none' });
    expect(
      resolveFileMentionKeyIntent(key({ key: 'Tab', keyCode: 229 }), opts),
    ).toEqual({ kind: 'none' });
    expect(
      resolveFileMentionKeyIntent(key({ key: 'ArrowDown', isComposing: true }), opts),
    ).toEqual({ kind: 'none' });
    expect(
      resolveFileMentionKeyIntent(key({ key: 'Escape', keyCode: 229 }), opts),
    ).toEqual({ kind: 'none' });
    expect(
      shouldPreventDefaultForFileMentionKey(key({ key: 'Enter', isComposing: true }), opts),
    ).toBe(false);
  });

  it('moves active option with ArrowDown using bounded wrap', () => {
    expect(resolveFileMentionKeyIntent(key({ key: 'ArrowDown' }), open({ activeIndex: 0 }))).toEqual({
      kind: 'move',
      activeIndex: 1,
    });
    expect(resolveFileMentionKeyIntent(key({ key: 'ArrowDown' }), open({ activeIndex: 2 }))).toEqual({
      kind: 'move',
      activeIndex: 0,
    });
    // No selection yet → first item
    expect(resolveFileMentionKeyIntent(key({ key: 'ArrowDown' }), open({ activeIndex: -1 }))).toEqual({
      kind: 'move',
      activeIndex: 0,
    });
    expect(shouldPreventDefaultForFileMentionKey(key({ key: 'ArrowDown' }), open())).toBe(true);
  });

  it('moves active option with ArrowUp using bounded wrap', () => {
    expect(resolveFileMentionKeyIntent(key({ key: 'ArrowUp' }), open({ activeIndex: 1 }))).toEqual({
      kind: 'move',
      activeIndex: 0,
    });
    expect(resolveFileMentionKeyIntent(key({ key: 'ArrowUp' }), open({ activeIndex: 0 }))).toEqual({
      kind: 'move',
      activeIndex: 2,
    });
    // No selection yet → last item
    expect(resolveFileMentionKeyIntent(key({ key: 'ArrowUp' }), open({ activeIndex: -1 }))).toEqual({
      kind: 'move',
      activeIndex: 2,
    });
  });

  it('accepts with Enter or Tab only when a selectable suggestion is active', () => {
    expect(resolveFileMentionKeyIntent(key({ key: 'Enter' }), open({ activeIndex: 1 }))).toEqual({
      kind: 'accept',
      activeIndex: 1,
    });
    expect(resolveFileMentionKeyIntent(key({ key: 'Tab' }), open({ activeIndex: 2 }))).toEqual({
      kind: 'accept',
      activeIndex: 2,
    });
    expect(shouldPreventDefaultForFileMentionKey(key({ key: 'Enter' }), open())).toBe(true);
    expect(shouldPreventDefaultForFileMentionKey(key({ key: 'Tab' }), open())).toBe(true);

    // No active option
    expect(
      resolveFileMentionKeyIntent(key({ key: 'Enter' }), open({ activeIndex: -1, activeSelectable: false })),
    ).toEqual({ kind: 'none' });
    // Active but not selectable
    expect(
      resolveFileMentionKeyIntent(
        key({ key: 'Enter' }),
        open({ activeIndex: 0, activeSelectable: false }),
      ),
    ).toEqual({ kind: 'none' });
    // Out of range
    expect(
      resolveFileMentionKeyIntent(key({ key: 'Enter' }), open({ activeIndex: 9 })),
    ).toEqual({ kind: 'none' });
  });

  it('does not accept on Shift+Enter or Ctrl/Meta+Enter while popup is open', () => {
    expect(
      resolveFileMentionKeyIntent(key({ key: 'Enter', shiftKey: true }), open()),
    ).toEqual({ kind: 'none' });
    expect(
      resolveFileMentionKeyIntent(key({ key: 'Enter', ctrlKey: true }), open()),
    ).toEqual({ kind: 'none' });
    expect(
      resolveFileMentionKeyIntent(key({ key: 'Enter', metaKey: true }), open()),
    ).toEqual({ kind: 'none' });
    // Leave Shift+Enter free (newline) — no preventDefault from popup policy
    expect(
      shouldPreventDefaultForFileMentionKey(key({ key: 'Enter', shiftKey: true }), open()),
    ).toBe(false);
  });

  it('dismisses with Escape when popup is open', () => {
    expect(resolveFileMentionKeyIntent(key({ key: 'Escape' }), open())).toEqual({ kind: 'dismiss' });
    expect(shouldPreventDefaultForFileMentionKey(key({ key: 'Escape' }), open())).toBe(true);
  });

  it('ignores unrelated keys while popup is open', () => {
    expect(resolveFileMentionKeyIntent(key({ key: 'a' }), open())).toEqual({ kind: 'none' });
    expect(resolveFileMentionKeyIntent(key({ key: 'Home' }), open())).toEqual({ kind: 'none' });
  });
});
