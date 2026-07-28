import { diffLines } from 'diff';

/**
 * Pure tool-diff presentation helpers (M020 S03).
 *
 * I/O-free: no Svelte, DOM, or host imports. Builds an exact line-operation
 * model and applies the size-gated collapse policy so ToolCard does not need to
 * compare or duplicate old/new text itself.
 *
 * Input is already bounded by S02 (`TOOL_FILE_CHANGES_MAX_FILES`,
 * `TOOL_FILE_CHANGE_TEXT_MAX`).
 */

/** Collapse when the number of rendered file entries is greater than this. */
export const TOOL_DIFF_COLLAPSE_FILE_THRESHOLD = 3;

/**
 * Collapse when total rendered rows (including fold rows) across all entries is
 * greater than this. Deliberately above the S01/S02 Playwright fixture sizes.
 */
export const TOOL_DIFF_COLLAPSE_LINE_THRESHOLD = 24;
/**
 * Unchanged context lines retained immediately before and after each change hunk.
 * Contiguous omitted context is replaced by one counted fold row.
 */
export const TOOL_DIFF_CONTEXT_LINES = 3;
/** Synchronous jsdiff work budget; abort falls back to an explicitly partial view. */
export const TOOL_DIFF_MAX_EDIT_LENGTH = 1_000;
/** One synchronous comparison budget shared by every file in a ToolCard. */
export const TOOL_DIFF_TOTAL_TIMEOUT_MS = 40;

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

export type ToolDiffLineKind = 'context' | 'added' | 'removed' | 'fold';

export interface ToolDiffLine {
  kind: ToolDiffLineKind;
  /** Source text for context/added/removed; empty string for fold rows. */
  text: string;
  /** Exact omitted unchanged-line count; present only on fold rows. */
  omittedCount?: number;
}

export interface ToolDiffFileView {
  path: string;
  oldText: string | null;
  newText: string;
  /** Ordered line operations; unchanged context appears exactly once. */
  lines: ToolDiffLine[];
  added: number;
  removed: number;
  /** Normalized: `undefined` input becomes `false`. */
  truncated: boolean;
  /** True when retained evidence was clipped — shown counts are not exact totals. */
  countsPartial: boolean;
  /** Comparison exceeded the shared ToolCard work budget; no counts/lines are claimed. */
  comparisonUnavailable: boolean;
  bodyId: string;
  toggleId: string;
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

/** Split one jsdiff operation into render lines without inventing a final blank line. */
function operationLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function buildDiffLines(
  oldText: string | null,
  newText: string,
  timeoutMs: number,
): { lines: ToolDiffLine[]; removed: number; added: number; comparisonUnavailable: boolean } {
  if (timeoutMs <= 0) {
    return { lines: [], removed: 0, added: 0, comparisonUnavailable: true };
  }
  const lines: ToolDiffLine[] = [];
  let added = 0;
  let removed = 0;
  const operations = diffLines(oldText ?? '', newText, {
    stripTrailingCr: true,
    maxEditLength: TOOL_DIFF_MAX_EDIT_LENGTH,
    timeout: timeoutMs,
  });

  // Never present raw before/after sides as if every line changed. If Myers
  // exceeds the shared work budget, surface an explicit unavailable state.
  if (operations === undefined) {
    return { lines: [], removed: 0, added: 0, comparisonUnavailable: true };
  }

  for (const operation of operations) {
    const kind: ToolDiffLineKind = operation.added
      ? 'added'
      : operation.removed
        ? 'removed'
        : 'context';
    const operationLineValues = operationLines(operation.value);
    if (kind === 'added') added += operationLineValues.length;
    if (kind === 'removed') removed += operationLineValues.length;
    for (const text of operationLineValues) lines.push({ kind, text });
  }

  return {
    lines: compactDiffContext(lines),
    removed,
    added,
    comparisonUnavailable: false,
  };
}

/**
 * Keep only TOOL_DIFF_CONTEXT_LINES unchanged lines on each side of every
 * added/removed hunk, merge overlapping windows, and replace each omitted
 * contiguous context run with one fold row carrying the exact omitted count.
 * Never mutates the input array or its line objects.
 */
export function compactDiffContext(lines: ReadonlyArray<ToolDiffLine>): ToolDiffLine[] {
  if (lines.length === 0) return [];

  const keepContext = new Array<boolean>(lines.length).fill(false);
  for (let index = 0; index < lines.length; index++) {
    const kind = lines[index]!.kind;
    if (kind !== 'added' && kind !== 'removed') continue;
    for (let distance = 1; distance <= TOOL_DIFF_CONTEXT_LINES; distance++) {
      const before = index - distance;
      const after = index + distance;
      if (before >= 0 && lines[before]!.kind === 'context') keepContext[before] = true;
      if (after < lines.length && lines[after]!.kind === 'context') keepContext[after] = true;
    }
  }

  const compacted: ToolDiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === 'added' || line.kind === 'removed') {
      compacted.push(line);
      index += 1;
      continue;
    }
    if (line.kind === 'context' && keepContext[index]) {
      compacted.push(line);
      index += 1;
      continue;
    }
    // Contiguous omitted context (or pure-context input with no change anchors).
    let omitted = 0;
    while (
      index < lines.length &&
      lines[index]!.kind === 'context' &&
      !keepContext[index]
    ) {
      omitted += 1;
      index += 1;
    }
    if (omitted > 0) {
      compacted.push({ kind: 'fold', text: '', omittedCount: omitted });
    }
  }
  return compacted;
}

/** Count only real added/removed operations, excluding unchanged context. */
export function countDiffLines(
  oldText: string | null,
  newText: string,
): { removed: number; added: number } {
  const { removed, added } = buildDiffLines(oldText, newText, TOOL_DIFF_TOTAL_TIMEOUT_MS);
  return { removed, added };
}

/** Collision-free, selector-safe encoding of the exact JavaScript string. */
export function sanitizeDomIdPart(value: string): string {
  let encoded = '';
  for (let i = 0; i < value.length; i++) {
    encoded += value.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return `u${encoded}`;
}

function formatCountsLabel(
  added: number,
  removed: number,
  partial: boolean,
  comparisonUnavailable: boolean,
): string {
  if (comparisonUnavailable) return 'Comparison unavailable';
  const base = `+${added} ${MINUS_SIGN}${removed}`;
  return partial ? `${base} (partial)` : base;
}

function evidenceFingerprint(entry: ToolDiffFileChangeInput): string {
  // Deterministic FNV-1a over retained evidence. The hash is an identity hint,
  // not a security primitive; it keeps DOM ids stable without exposing content.
  let hash = 0x811c9dc5;
  for (const value of [entry.path, entry.oldText ?? '', entry.newText, entry.truncated ? '1' : '0']) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build the pure presentation model for a tool's file-change evidence.
 * Does not mutate the input array or its entries.
 */
export function buildToolDiffView(input: BuildToolDiffViewInput): ToolDiffView {
  const toolIdSeed = sanitizeDomIdPart(input.toolCallId);
  const evidenceOccurrences = new Map<string, number>();
  const files: ToolDiffFileView[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  const deadline = Date.now() + TOOL_DIFF_TOTAL_TIMEOUT_MS;

  for (let index = 0; index < input.fileChanges.length; index++) {
    const entry = input.fileChanges[index]!;
    const fingerprint = evidenceFingerprint(entry);
    const occurrence = evidenceOccurrences.get(fingerprint) ?? 0;
    evidenceOccurrences.set(fingerprint, occurrence + 1);
    const fileIdSeed = `${toolIdSeed}-${sanitizeDomIdPart(entry.path)}-${fingerprint}-${occurrence}`;
    const { lines, added, removed, comparisonUnavailable } = buildDiffLines(
      entry.oldText,
      entry.newText,
      Math.max(0, deadline - Date.now()),
    );
    const truncated = entry.truncated === true;
    const countsPartial = truncated;
    totalAdded += added;
    totalRemoved += removed;
    files.push({
      path: entry.path,
      oldText: entry.oldText,
      newText: entry.newText,
      lines,
      added,
      removed,
      truncated,
      countsPartial,
      comparisonUnavailable,
      bodyId: `tool-diff-body-${fileIdSeed}`,
      toggleId: `tool-diff-toggle-${fileIdSeed}`,
      countsLabel: formatCountsLabel(added, removed, countsPartial, comparisonUnavailable),
    });
  }

  // Collapse on rendered presentation cost (context + changes + fold rows),
  // not only added/removed counts — large unchanged context is already compacted
  // but three full-budget files still exceed the line threshold via fold rows.
  let totalRenderedRows = 0;
  for (const file of files) totalRenderedRows += file.lines.length;
  const collapsedByDefault =
    files.length > TOOL_DIFF_COLLAPSE_FILE_THRESHOLD ||
    totalRenderedRows > TOOL_DIFF_COLLAPSE_LINE_THRESHOLD;

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
  if (file.comparisonUnavailable) {
    return `${file.path}: comparison unavailable because this diff is too complex`;
  }
  if (file.countsPartial) {
    prose += ', counts are partial because this diff was truncated';
  }
  return prose;
}
