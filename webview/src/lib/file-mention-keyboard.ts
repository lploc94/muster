/**
 * Pure keyboard policy for file-mention autocomplete popup interaction.
 *
 * Composes *ahead of* the existing composer submit policy: when the popup is
 * inactive this module returns `{ kind: 'none' }` so Enter / Shift+Enter /
 * Ctrl|Meta+Enter remain owned by `resolveComposerKeyIntent`.
 *
 * Independent of Svelte DOM code.
 */

/** Keyboard event shape used by the file-mention popup policy. */
export interface FileMentionKeyboardInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  isComposing: boolean;
  /** Legacy IME composition signal (keyCode 229). */
  keyCode?: number;
}

/** Popup state needed to resolve a key intent. */
export interface FileMentionKeyboardOptions {
  /** True when the listbox is open and visible. */
  popupOpen: boolean;
  /** Number of options currently rendered. */
  itemCount: number;
  /**
   * Currently highlighted option index, or -1 when none is active.
   * Callers clamp/seed this after `move` intents.
   */
  activeIndex: number;
  /**
   * Whether the active option can be accepted (e.g. file row or directory
   * refinement). Defaults to true when omitted and activeIndex is in range.
   */
  activeSelectable?: boolean;
}

/** Resolved keyboard intent for the file-mention popup. */
export type FileMentionKeyIntent =
  | { kind: 'none' }
  | { kind: 'move'; activeIndex: number }
  | { kind: 'accept'; activeIndex: number }
  | { kind: 'dismiss' };

function isIme(event: FileMentionKeyboardInput): boolean {
  return event.isComposing || event.keyCode === 229;
}

function hasActiveSelectable(
  opts: FileMentionKeyboardOptions,
): opts is FileMentionKeyboardOptions & { activeIndex: number } {
  if (!opts.popupOpen || opts.itemCount <= 0) return false;
  if (opts.activeIndex < 0 || opts.activeIndex >= opts.itemCount) return false;
  if (opts.activeSelectable === false) return false;
  return true;
}

/**
 * Pure keyboard → popup intent mapping.
 *
 * - IME composition / keyCode 229: none (never accept or send)
 * - Popup inactive or empty: none (composer submit policy owns Enter)
 * - ArrowDown / ArrowUp: move with bounded wrap
 * - Enter / Tab: accept only when a selectable suggestion is active
 * - Shift+Enter, Ctrl/Meta+Enter: none while popup open (do not accept; leave
 *   newline / live-inject free for the surrounding handler to decide)
 * - Escape: dismiss
 */
export function resolveFileMentionKeyIntent(
  event: FileMentionKeyboardInput,
  opts: FileMentionKeyboardOptions,
): FileMentionKeyIntent {
  if (isIme(event)) return { kind: 'none' };
  if (!opts.popupOpen) return { kind: 'none' };

  const { key } = event;

  if (key === 'Escape') {
    return { kind: 'dismiss' };
  }

  // Empty open popup: no navigation or accept (status/error may still show).
  if (opts.itemCount <= 0) {
    return { kind: 'none' };
  }

  if (key === 'ArrowDown') {
    const next =
      opts.activeIndex < 0 || opts.activeIndex >= opts.itemCount
        ? 0
        : (opts.activeIndex + 1) % opts.itemCount;
    return { kind: 'move', activeIndex: next };
  }

  if (key === 'ArrowUp') {
    const next =
      opts.activeIndex < 0 || opts.activeIndex >= opts.itemCount
        ? opts.itemCount - 1
        : (opts.activeIndex - 1 + opts.itemCount) % opts.itemCount;
    return { kind: 'move', activeIndex: next };
  }

  if (key === 'Enter' || key === 'Tab') {
    // Only plain Enter/Tab accept. Shift/Ctrl/Meta+Enter stay out of the way
    // so newline and live-inject policies remain available.
    if (key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      return { kind: 'none' };
    }
    if (!hasActiveSelectable(opts)) {
      return { kind: 'none' };
    }
    return { kind: 'accept', activeIndex: opts.activeIndex };
  }

  return { kind: 'none' };
}

/** Whether the key handler should preventDefault for a popup-owned key. */
export function shouldPreventDefaultForFileMentionKey(
  event: FileMentionKeyboardInput,
  opts: FileMentionKeyboardOptions,
): boolean {
  return resolveFileMentionKeyIntent(event, opts).kind !== 'none';
}
