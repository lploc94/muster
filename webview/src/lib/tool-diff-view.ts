/**
 * Pure tool-diff presentation helpers (M020 S03).
 *
 * I/O-free: no Svelte, DOM, or host imports. Counts changed lines and decides
 * size-gated collapse policy so ToolCard can render per-file summaries without
 * baking readability policy into the component.
 *
 * Input is already bounded by S02 (`TOOL_FILE_CHANGES_MAX_FILES`,
 * `TOOL_FILE_CHANGE_TEXT_MAX`), so counting stays a single O(n) pass over
 * already-bounded text with no regex.
 */

/** Collapse when the number of rendered file entries is greater than this. */
export const TOOL_DIFF_COLLAPSE_FILE_THRESHOLD = 3;

/**
 * Collapse when total changed lines (added + removed) across all entries is
 * greater than this. Deliberately above the S01/S02 Playwright fixture sizes.
 */
export const TOOL_DIFF_COLLAPSE_LINE_THRESHOLD = 24;

/** Structural input entry — local so the module stays free of host types. */
export interface ToolDiffFileChangeInput {
  path: string;
  oldText: string | null;
  newText: string;
  /** Present only when a side was clipped; never emitted as `false`. */
  truncated?: boolean;
}

export interface BuildToolDiffViewInput {
  toolCallId: string;
  fileChanges: ReadonlyArray<ToolDiffFileChangeInput>;
  fileChangesOmitted?: number;
}

export interface ToolDiffFileView {
  path: string;
  oldText: string | null;
  newText: string;
  added: number;
  removed: number;
  /** Normalized: `undefined` input becomes `false`. */
  truncated: boolean;
  /** True when the entry was truncated — counts of clipped text are not exact. */
  countsPartial: boolean;
  bodyId: string;
  /** Visual short form, e.g. `+2 −1` or `+2 −1 (partial)`. */
  countsLabel: string;
}

export interface ToolDiffView {
  collapsedByDefault: boolean;
  totalAdded: number;
  totalRemoved: number;
  files: ToolDiffFileView[];
  /** Pass-through only when greater than 0 (present-only, S02 rule). */
  fileChangesOmitted?: number;
}

const MINUS_SIGN = '\u2212';

/**
 * Count display lines on each side of a file change.
 * Matches ToolCard's `textLines`: split on `\n`, drop exactly one trailing
 * empty element when the text ends with `\n`. `null` / `''` oldText → removed 0.
 * No regex.
 */
export function countDiffLines(
  oldText: string | null,
  newText: string,
): { removed: number; added: number } {
  return {
    removed: countLines(oldText),
    added: countLines(newText),
  };
}

function countLines(text: string | null | undefined): number {
  if (text == null || text === '') return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) count += 1;
  }
  // Drop the empty trailing element produced by a final newline.
  if (text.charCodeAt(text.length - 1) === 10) count -= 1;
  return count;
}

/**
 * DOM-safe id fragment: replace every character outside [A-Za-z0-9_-] with `-`.
 * Falls back to `'tool'` when the result is empty so body ids stay valid.
 */
export function sanitizeDomIdPart(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    const ok =
      (ch >= 48 && ch <= 57) || // 0-9
      (ch >= 65 && ch <= 90) || // A-Z
      (ch >= 97 && ch <= 122) || // a-z
      ch === 95 || // _
      ch === 45; // -
    out += ok ? value[i]! : '-';
  }
  return out.length > 0 ? out : 'tool';
}

function formatCountsLabel(added: number, removed: number, partial: boolean): string {
  const base = `+${added} ${MINUS_SIGN}${removed}`;
  return partial ? `${base} (partial)` : base;
}

/**
 * Build the pure presentation model for a tool's file-change evidence.
 * Does not mutate the input array or its entries.
 */
export function buildToolDiffView(input: BuildToolDiffViewInput): ToolDiffView {
  const safeToolCallId = sanitizeDomIdPart(input.toolCallId);
  const files: ToolDiffFileView[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (let index = 0; index < input.fileChanges.length; index++) {
    const entry = input.fileChanges[index]!;
    const { added, removed } = countDiffLines(entry.oldText, entry.newText);
    const truncated = entry.truncated === true;
    const countsPartial = truncated;
    totalAdded += added;
    totalRemoved += removed;
    files.push({
      path: entry.path,
      oldText: entry.oldText,
      newText: entry.newText,
      added,
      removed,
      truncated,
      countsPartial,
      bodyId: `tool-diff-body-${safeToolCallId}-${index}`,
      countsLabel: formatCountsLabel(added, removed, countsPartial),
    });
  }

  const totalChanged = totalAdded + totalRemoved;
  const collapsedByDefault =
    files.length > TOOL_DIFF_COLLAPSE_FILE_THRESHOLD ||
    totalChanged > TOOL_DIFF_COLLAPSE_LINE_THRESHOLD;

  const view: ToolDiffView = {
    collapsedByDefault,
    totalAdded,
    totalRemoved,
    files,
  };

  if (typeof input.fileChangesOmitted === 'number' && input.fileChangesOmitted > 0) {
    view.fileChangesOmitted = input.fileChangesOmitted;
  }

  return view;
}

/**
 * Prose summary for assistive tech — no glyphs, correct singular/plural,
 * and an honest partial note when counts came from truncated text.
 */
export function describeDiffFileForScreenReader(file: ToolDiffFileView): string {
  const addedWord = file.added === 1 ? 'line' : 'lines';
  const removedWord = file.removed === 1 ? 'line' : 'lines';
  let prose = `${file.path}: ${file.added} ${addedWord} added, ${file.removed} ${removedWord} removed`;
  if (file.countsPartial) {
    prose += ', counts are partial because this diff was truncated';
  }
  return prose;
}
