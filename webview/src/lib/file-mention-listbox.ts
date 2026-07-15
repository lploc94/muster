/**
 * Pure helpers for accessible file-mention listbox semantics.
 * Independent of Svelte DOM code — Composer maps these to aria attributes.
 */

/** Stable listbox element id used by aria-controls / aria-owns. */
export const FILE_MENTION_LISTBOX_ID = 'file-mention-listbox';

/** Accessible name announced for the suggestion listbox. */
export const FILE_MENTION_LISTBOX_LABEL = 'File mention suggestions';

/**
 * High-level popup outcome for status text and visibility.
 * - closed: no active query / dismissed
 * - loading: request in flight
 * - ready: suggestions available
 * - empty: host returned zero items for a valid query
 * - error: host returned a bounded failure (no free-form text)
 */
export type FileMentionListboxOutcome =
  | 'closed'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error';

/** Deterministic option element id for aria-activedescendant. */
export function fileMentionOptionId(index: number): string {
  return `file-mention-option-${index}`;
}

/**
 * Clamp a keyboard-driven active index into [0, itemCount).
 * Seeds -1 to 0 when items exist so the first Arrow key can accept immediately
 * after the list paints; empty lists stay at -1.
 */
export function clampFileMentionActiveIndex(activeIndex: number, itemCount: number): number {
  if (itemCount <= 0) return -1;
  if (activeIndex < 0) return 0;
  if (activeIndex >= itemCount) return itemCount - 1;
  return activeIndex;
}

/** aria-activedescendant id when the active option is in range. */
export function resolveFileMentionActiveDescendant(
  activeIndex: number,
  itemCount: number,
): string | undefined {
  if (itemCount <= 0) return undefined;
  if (activeIndex < 0 || activeIndex >= itemCount) return undefined;
  return fileMentionOptionId(activeIndex);
}

/**
 * User-facing status text for empty/error/loading outcomes.
 * Never includes host error codes, absolute paths, or free-form host text.
 */
export function fileMentionStatusText(outcome: FileMentionListboxOutcome): string | null {
  switch (outcome) {
    case 'loading':
      return 'Loading file suggestions…';
    case 'empty':
      return 'No matching files';
    case 'error':
      return 'File suggestions unavailable';
    case 'closed':
    case 'ready':
    default:
      return null;
  }
}
