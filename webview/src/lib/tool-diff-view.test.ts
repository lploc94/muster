import { describe, expect, it } from 'vitest';
import {
  TOOL_DIFF_COLLAPSE_FILE_THRESHOLD,
  TOOL_DIFF_COLLAPSE_LINE_THRESHOLD,
  TOOL_DIFF_CONTEXT_LINES,
  buildToolDiffView,
  countDiffLines,
  describeDiffFileForScreenReader,
  sanitizeDomIdPart,
  type ToolDiffFileView,
  type ToolDiffLine,
} from './tool-diff-view';
import { TOOL_FILE_CHANGES_MAX_FILES, TOOL_FILE_CHANGE_SIDE_MAX_LINES } from '../../../src/shared/tool-file-change-contract';

const MINUS = '\u2212';

function change(
  path: string,
  oldText: string | null,
  newText: string,
  truncated?: boolean,
) {
  return truncated
    ? { path, oldText, newText, truncated: true as const }
    : { path, oldText, newText };
}

function nLines(n: number, prefix = 'line'): string {
  if (n <= 0) return '';
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n');
}

describe('countDiffLines', () => {
  it('drops exactly one trailing empty element when text ends with newline', () => {
    expect(countDiffLines('a\nb\n', 'x\ny\n')).toEqual({ removed: 2, added: 2 });
  });

  it('counts lines with no trailing newline', () => {
    expect(countDiffLines('a\nb', 'x\ny\nz')).toEqual({ removed: 2, added: 3 });
  });

  it('treats null oldText as create (removed: 0)', () => {
    expect(countDiffLines(null, 'new\ncontent\n')).toEqual({ removed: 0, added: 2 });
  });

  it('treats empty oldText as removed: 0', () => {
    expect(countDiffLines('', 'only-new')).toEqual({ removed: 0, added: 1 });
  });

  it('treats empty newText as added: 0', () => {
    expect(countDiffLines('gone', '')).toEqual({ removed: 1, added: 0 });
  });

  it('treats both empty as zeros', () => {
    expect(countDiffLines('', '')).toEqual({ removed: 0, added: 0 });
  });

  it('does not use regex (single-line content stays one line)', () => {
    expect(countDiffLines('plain', 'plain with spaces')).toEqual({
      removed: 1,
      added: 1,
    });
  });
});

describe('sanitizeDomIdPart', () => {
  it('encodes punctuation injectively instead of collapsing distinct ids', () => {
    expect(sanitizeDomIdPart('turn:producer/abc')).not.toBe(
      sanitizeDomIdPart('turn/producer:abc'),
    );
  });

  it('returns a non-empty selector-safe encoding for every string', () => {
    expect(sanitizeDomIdPart('')).toMatch(/^u[0-9a-f]*$/);
    expect(sanitizeDomIdPart('tool_call-1')).toMatch(/^u[0-9a-f]+$/);
    expect(sanitizeDomIdPart('🛠️')).toMatch(/^u[0-9a-f]+$/);
  });

  it('is stable for the same exact input', () => {
    expect(sanitizeDomIdPart('tool_call-1')).toBe(sanitizeDomIdPart('tool_call-1'));
  });
});

describe('buildToolDiffView', () => {
  it('models unchanged context once and counts only changed line operations', () => {
    const view = buildToolDiffView({
      toolCallId: 'tc-exact',
      fileChanges: [
        change(
          'src/exact.ts',
          'const shared = true;\nconst value = "old";\nreturn shared;\n',
          'const shared = true;\nconst value = "new";\nreturn shared;\n',
        ),
      ],
    });

    expect(view.files[0]).toMatchObject({
      added: 1,
      removed: 1,
      lines: [
        { kind: 'context', text: 'const shared = true;' },
        { kind: 'removed', text: 'const value = "old";' },
        { kind: 'added', text: 'const value = "new";' },
        { kind: 'context', text: 'return shared;' },
      ],
    });
    expect(view.totalAdded).toBe(1);
    expect(view.totalRemoved).toBe(1);
  });

  it('normalizes CRLF terminators without changing line operation counts', () => {
    const view = buildToolDiffView({
      toolCallId: 'tc-crlf',
      fileChanges: [change('src/crlf.ts', 'shared\r\nold\r\n', 'shared\r\nnew\r\n')],
    });

    expect(view.files[0].lines).toEqual([
      { kind: 'context', text: 'shared' },
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' },
    ]);
    expect(view.files[0]).toMatchObject({ added: 1, removed: 1 });
  });

  it('builds per-file counts and leaves small single-file diffs expanded', () => {
    const view = buildToolDiffView({
      toolCallId: 'tc-1',
      fileChanges: [change('src/a.ts', 'old\n', 'new\nextra\n')],
    });
    expect(view.collapsedByDefault).toBe(false);
    expect(view.files).toHaveLength(1);
    expect(view.files[0]).toMatchObject({
      path: 'src/a.ts',
      removed: 1,
      added: 2,
      truncated: false,
      countsPartial: false,
      countsLabel: `+2 ${MINUS}1`,
    });
    expect(view.files[0].bodyId).toMatch(
      /^tool-diff-body-u[0-9a-f]+-u[0-9a-f]+-[0-9a-f]{8}-0$/,
    );
    expect(view.files[0].toggleId).toMatch(
      /^tool-diff-toggle-u[0-9a-f]+-u[0-9a-f]+-[0-9a-f]{8}-0$/,
    );
    expect(view.totalAdded).toBe(2);
    expect(view.totalRemoved).toBe(1);
    expect(view.fileChangesOmitted).toBeUndefined();
  });

  it('stays expanded at exactly the file threshold', () => {
    const files = Array.from({ length: TOOL_DIFF_COLLAPSE_FILE_THRESHOLD }, (_, i) =>
      change(`f${i}.ts`, 'a', 'b'),
    );
    // 3 files * 2 lines = 6 total changed — well under line threshold
    const view = buildToolDiffView({ toolCallId: 'tc', fileChanges: files });
    expect(files).toHaveLength(3);
    expect(view.collapsedByDefault).toBe(false);
  });

  it('collapses when file count exceeds the file threshold', () => {
    const files = Array.from({ length: TOOL_DIFF_COLLAPSE_FILE_THRESHOLD + 1 }, (_, i) =>
      change(`f${i}.ts`, 'a', 'b'),
    );
    const view = buildToolDiffView({ toolCallId: 'tc', fileChanges: files });
    expect(view.collapsedByDefault).toBe(true);
    expect(view.files).toHaveLength(4);
  });

  it('does not collapse large unchanged context around a small edit', () => {
    const context = nLines(30, 'shared');
    const view = buildToolDiffView({
      toolCallId: 'tc-context',
      fileChanges: [
        change('context.ts', `${context}\nold\n`, `${context}\nnew\n`),
      ],
    });

    expect(view.totalAdded + view.totalRemoved).toBe(2);
    expect(view.collapsedByDefault).toBe(false);
  });

  it('stays expanded at exactly the line threshold', () => {
    // 12 removed + 12 added = 24 total changed lines, one file
    const view = buildToolDiffView({
      toolCallId: 'tc',
      fileChanges: [change('big.ts', nLines(12, 'old'), nLines(12, 'new'))],
    });
    expect(view.totalAdded + view.totalRemoved).toBe(TOOL_DIFF_COLLAPSE_LINE_THRESHOLD);
    expect(view.collapsedByDefault).toBe(false);
  });

  it('collapses when total changed lines exceed the line threshold', () => {
    // 13 removed + 12 added = 25
    const view = buildToolDiffView({
      toolCallId: 'tc',
      fileChanges: [change('big.ts', nLines(13, 'old'), nLines(12, 'new'))],
    });
    expect(view.totalAdded + view.totalRemoved).toBe(TOOL_DIFF_COLLAPSE_LINE_THRESHOLD + 1);
    expect(view.collapsedByDefault).toBe(true);
  });

  it('reports comparison unavailable without inventing changed lines when work exceeds the cap', () => {
    const oldText = nLines(1_100, 'old');
    const newText = nLines(1_100, 'new');
    const view = buildToolDiffView({
      toolCallId: 'too-complex',
      fileChanges: [change('complex.ts', oldText, newText)],
    });
    expect(view.files[0]).toMatchObject({
      comparisonUnavailable: true,
      added: 0,
      removed: 0,
      lines: [],
      countsLabel: 'Comparison unavailable',
    });
    expect(describeDiffFileForScreenReader(view.files[0])).toContain('comparison unavailable');
  });

  it('marks truncated entries as partial and suffixes the counts label', () => {
    const view = buildToolDiffView({
      toolCallId: 'tc',
      fileChanges: [change('clip.ts', 'a\n', 'b\nc\n', true)],
    });
    expect(view.files[0].truncated).toBe(true);
    expect(view.files[0].countsPartial).toBe(true);
    expect(view.files[0].countsLabel).toBe(`+2 ${MINUS}1 (partial)`);
  });

  it('drops fileChangesOmitted when 0 or undefined and passes through positive values', () => {
    expect(
      buildToolDiffView({
        toolCallId: 'tc',
        fileChanges: [change('a.ts', null, 'x')],
        fileChangesOmitted: undefined,
      }).fileChangesOmitted,
    ).toBeUndefined();
    expect(
      buildToolDiffView({
        toolCallId: 'tc',
        fileChanges: [change('a.ts', null, 'x')],
        fileChangesOmitted: 0,
      }).fileChangesOmitted,
    ).toBeUndefined();
    expect(
      buildToolDiffView({
        toolCallId: 'tc',
        fileChanges: [change('a.ts', null, 'x')],
        fileChangesOmitted: 5,
      }).fileChangesOmitted,
    ).toBe(5);
  });

  it('creates stable injective body and toggle ids without embedding the path', () => {
    const colon = buildToolDiffView({
      toolCallId: 'turn:producer/abc',
      fileChanges: [change('src/evil:path.ts', null, 'x')],
    });
    const slash = buildToolDiffView({
      toolCallId: 'turn/producer:abc',
      fileChanges: [change('src/evil:path.ts', null, 'x')],
    });

    expect(colon.files[0].bodyId).toBe(
      buildToolDiffView({
        toolCallId: 'turn:producer/abc',
        fileChanges: [change('src/evil:path.ts', null, 'x')],
      }).files[0].bodyId,
    );
    expect(colon.files[0].bodyId).not.toBe(
      buildToolDiffView({
        toolCallId: 'turn:producer/abc',
        fileChanges: [change('src/evil:path.ts', 'different', 'content')],
      }).files[0].bodyId,
    );
    expect(colon.files[0].bodyId).not.toBe(
      buildToolDiffView({
        toolCallId: 'turn:producer/abc',
        fileChanges: [change('different-path.ts', null, 'y')],
      }).files[0].bodyId,
    );
    expect(colon.files[0].bodyId).not.toBe(slash.files[0].bodyId);
    expect(colon.files[0].toggleId).not.toBe(colon.files[0].bodyId);
    expect(colon.files[0].toggleId).not.toBe(slash.files[0].toggleId);
    expect(colon.files[0].bodyId).not.toContain('evil');
    expect(colon.files[0].bodyId).not.toContain(':');
    expect(colon.files[0].bodyId).not.toContain('/');
  });

  it('keeps file ids stable across reorder and unique for duplicate paths', () => {
    const first = buildToolDiffView({
      toolCallId: 'tool',
      fileChanges: [change('a.ts', 'a', 'A'), change('b.ts', 'b', 'B')],
    });
    const reordered = buildToolDiffView({
      toolCallId: 'tool',
      fileChanges: [change('b.ts', 'b', 'B'), change('a.ts', 'a', 'A')],
    });
    expect(first.files.find((file) => file.path === 'a.ts')?.bodyId).toBe(
      reordered.files.find((file) => file.path === 'a.ts')?.bodyId,
    );
    const duplicates = buildToolDiffView({
      toolCallId: 'tool',
      fileChanges: [change('a.ts', 'a', 'A'), change('a.ts', 'x', 'X')],
    });
    const duplicateReorder = buildToolDiffView({
      toolCallId: 'tool',
      fileChanges: [change('a.ts', 'x', 'X'), change('a.ts', 'a', 'A')],
    });
    expect(duplicates.files[0].bodyId).not.toBe(duplicates.files[1].bodyId);
    expect(duplicates.files[0].bodyId).toBe(duplicateReorder.files[1].bodyId);
    expect(duplicates.files[1].bodyId).toBe(duplicateReorder.files[0].bodyId);
  });

  it('does not mutate the input array or objects', () => {
    const entry = change('a.ts', 'old', 'new', true);
    const input = {
      toolCallId: 'tc',
      fileChanges: [entry],
      fileChangesOmitted: 2,
    };
    const snapshot = structuredClone(input);
    buildToolDiffView(input);
    expect(input).toEqual(snapshot);
    expect(input.fileChanges[0]).toBe(entry);
  });

  it('preserves oldText and newText on each file view for rendering', () => {
    const view = buildToolDiffView({
      toolCallId: 'tc',
      fileChanges: [change('a.ts', 'old-line', 'new-line')],
    });
    expect(view.files[0].oldText).toBe('old-line');
    expect(view.files[0].newText).toBe('new-line');
  });
});

/** Build a max-side single-change fixture: full retained line budget, one central edit. */
function fullBudgetSingleChange(path: string): ReturnType<typeof change> {
  const half = Math.floor(TOOL_FILE_CHANGE_SIDE_MAX_LINES / 2);
  const leading = nLines(half, 'lead');
  const trailing = nLines(TOOL_FILE_CHANGE_SIDE_MAX_LINES - half - 1, 'trail');
  return change(
    path,
    `${leading}\nOLD\n${trailing}\n`,
    `${leading}\nNEW\n${trailing}\n`,
  );
}

function foldCount(lines: ToolDiffLine[]): number {
  return lines.filter((line) => line.kind === 'fold').length;
}

function totalOmitted(lines: ToolDiffLine[]): number {
  return lines.reduce(
    (sum, line) => (line.kind === 'fold' ? sum + (line.omittedCount ?? 0) : sum),
    0,
  );
}

describe('M021 S03 compact unchanged context windows', () => {
  it(`retains ${3} context lines around a hunk and folds the rest with exact counts`, () => {
    expect(TOOL_DIFF_CONTEXT_LINES).toBe(3);
    const leading = nLines(10, 'L');
    const trailing = nLines(10, 'T');
    const view = buildToolDiffView({
      toolCallId: 'tc-window',
      fileChanges: [
        change(
          'window.ts',
          `${leading}\nold\n${trailing}\n`,
          `${leading}\nnew\n${trailing}\n`,
        ),
      ],
    });

    const file = view.files[0]!;
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
    expect(view.totalAdded).toBe(1);
    expect(view.totalRemoved).toBe(1);

    expect(file.lines).toEqual([
      { kind: 'fold', text: '', omittedCount: 7 },
      { kind: 'context', text: 'L-8' },
      { kind: 'context', text: 'L-9' },
      { kind: 'context', text: 'L-10' },
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' },
      { kind: 'context', text: 'T-1' },
      { kind: 'context', text: 'T-2' },
      { kind: 'context', text: 'T-3' },
      { kind: 'fold', text: '', omittedCount: 7 },
    ]);
    expect(file.lines).toHaveLength(10);
    expect(totalOmitted(file.lines)).toBe(14);
  });

  it('does not emit fold rows when no context is omitted', () => {
    const view = buildToolDiffView({
      toolCallId: 'tc-small',
      fileChanges: [
        change(
          'small.ts',
          'a\nb\nc\nold\nd\ne\nf\n',
          'a\nb\nc\nnew\nd\ne\nf\n',
        ),
      ],
    });

    expect(foldCount(view.files[0]!.lines)).toBe(0);
    expect(view.files[0]!.lines.every((line) => line.kind !== 'fold')).toBe(true);
    expect(view.files[0]!.lines).toHaveLength(8);
  });

  it('merges overlapping context windows for nearby hunks without a middle fold', () => {
    // 3 context between hunks → fully covered by both windows, no middle omission.
    const view = buildToolDiffView({
      toolCallId: 'tc-near',
      fileChanges: [
        change(
          'near.ts',
          'A0\nA1\nA2\nA3\nold1\nM1\nM2\nM3\nold2\nB1\nB2\nB3\nB4\n',
          'A0\nA1\nA2\nA3\nnew1\nM1\nM2\nM3\nnew2\nB1\nB2\nB3\nB4\n',
        ),
      ],
    });

    const kinds = view.files[0]!.lines.map((line) =>
      line.kind === 'fold' ? `fold:${line.omittedCount}` : line.kind,
    );
    expect(kinds).toEqual([
      'fold:1',
      'context',
      'context',
      'context',
      'removed',
      'added',
      'context',
      'context',
      'context',
      'removed',
      'added',
      'context',
      'context',
      'context',
      'fold:1',
    ]);
    expect(kinds.filter((k) => k.startsWith('fold'))).toHaveLength(2);
  });

  it('inserts an exact middle fold between distant hunks', () => {
    const middle = nLines(7, 'M');
    const view = buildToolDiffView({
      toolCallId: 'tc-far',
      fileChanges: [
        change(
          'far.ts',
          `old1\n${middle}\nold2\n`,
          `new1\n${middle}\nnew2\n`,
        ),
      ],
    });

    const file = view.files[0]!;
    // 3 after first + 1 omitted + 3 before second = 7 middle context
    expect(file.lines).toEqual([
      { kind: 'removed', text: 'old1' },
      { kind: 'added', text: 'new1' },
      { kind: 'context', text: 'M-1' },
      { kind: 'context', text: 'M-2' },
      { kind: 'context', text: 'M-3' },
      { kind: 'fold', text: '', omittedCount: 1 },
      { kind: 'context', text: 'M-5' },
      { kind: 'context', text: 'M-6' },
      { kind: 'context', text: 'M-7' },
      { kind: 'removed', text: 'old2' },
      { kind: 'added', text: 'new2' },
    ]);
  });

  it('folds pure context (identical sides) into one counted row and keeps counts at zero', () => {
    const view = buildToolDiffView({
      toolCallId: 'tc-identical',
      fileChanges: [change('same.ts', nLines(12, 'same') + '\n', nLines(12, 'same') + '\n')],
    });

    expect(view.files[0]).toMatchObject({ added: 0, removed: 0 });
    expect(view.files[0]!.lines).toEqual([{ kind: 'fold', text: '', omittedCount: 12 }]);
  });

  it('does not count fold rows as added or removed', () => {
    const view = buildToolDiffView({
      toolCallId: 'tc-counts',
      fileChanges: [
        change('c.ts', `${nLines(20, 'L')}\nold\n${nLines(20, 'T')}\n`, `${nLines(20, 'L')}\nnew\n${nLines(20, 'T')}\n`),
      ],
    });
    expect(view.files[0]!.added).toBe(1);
    expect(view.files[0]!.removed).toBe(1);
    expect(view.totalAdded).toBe(1);
    expect(view.totalRemoved).toBe(1);
    expect(foldCount(view.files[0]!.lines)).toBe(2);
  });

  it('compacts CRLF context the same way as LF context', () => {
    const leading = Array.from({ length: 8 }, (_, i) => `L-${i + 1}`).join('\r\n');
    const trailing = Array.from({ length: 8 }, (_, i) => `T-${i + 1}`).join('\r\n');
    const view = buildToolDiffView({
      toolCallId: 'tc-crlf-fold',
      fileChanges: [
        change(
          'crlf-fold.ts',
          `${leading}\r\nold\r\n${trailing}\r\n`,
          `${leading}\r\nnew\r\n${trailing}\r\n`,
        ),
      ],
    });

    expect(view.files[0]!.lines[0]).toEqual({ kind: 'fold', text: '', omittedCount: 5 });
    expect(view.files[0]!.lines.at(-1)).toEqual({ kind: 'fold', text: '', omittedCount: 5 });
    expect(view.files[0]).toMatchObject({ added: 1, removed: 1 });
  });

  it('does not mutate the source line model input while compacting', () => {
    const entry = change('imm.ts', `${nLines(10, 'L')}\nold\n`, `${nLines(10, 'L')}\nnew\n`);
    const input = { toolCallId: 'tc-imm', fileChanges: [entry] };
    const snapshot = structuredClone(input);
    const view = buildToolDiffView(input);
    expect(input).toEqual(snapshot);
    expect(foldCount(view.files[0]!.lines)).toBe(1);
  });

  it('computes collapsedByDefault from rendered row total including fold rows', () => {
    // Three full-budget single-change files: ~10 rendered rows each → 30 > line threshold.
    const view = buildToolDiffView({
      toolCallId: 'tc-collapse-rendered',
      fileChanges: [
        fullBudgetSingleChange('a.ts'),
        fullBudgetSingleChange('b.ts'),
        fullBudgetSingleChange('c.ts'),
      ],
    });

    expect(view.files).toHaveLength(3);
    for (const file of view.files) {
      expect(file.lines.length).toBeLessThanOrEqual(10);
      expect(file.added).toBe(1);
      expect(file.removed).toBe(1);
      expect(foldCount(file.lines)).toBe(2);
    }
    const rendered = view.files.reduce((sum, file) => sum + file.lines.length, 0);
    expect(rendered).toBeGreaterThan(TOOL_DIFF_COLLAPSE_LINE_THRESHOLD);
    expect(view.totalAdded + view.totalRemoved).toBe(6); // would NOT collapse on changed-only metric
    expect(view.collapsedByDefault).toBe(true);
  });

  it('bounds the max 32-file retained-budget model to a counted row ceiling', () => {
    const files = Array.from({ length: TOOL_FILE_CHANGES_MAX_FILES }, (_, i) =>
      fullBudgetSingleChange(`f${i}.ts`),
    );
    const view = buildToolDiffView({ toolCallId: 'tc-max', fileChanges: files });

    expect(view.files).toHaveLength(TOOL_FILE_CHANGES_MAX_FILES);
    let rendered = 0;
    for (const file of view.files) {
      expect(file.lines.length).toBeLessThanOrEqual(10);
      expect(file.added + file.removed).toBe(2);
      // Every changed row remains visible.
      expect(file.lines.some((line) => line.kind === 'removed')).toBe(true);
      expect(file.lines.some((line) => line.kind === 'added')).toBe(true);
      rendered += file.lines.length;
    }
    // 32 files × ≤10 rows = ≤320 rendered nodes when expanded.
    expect(rendered).toBeLessThanOrEqual(TOOL_FILE_CHANGES_MAX_FILES * 10);
    expect(view.collapsedByDefault).toBe(true);
  });
});

describe('describeDiffFileForScreenReader', () => {
  function file(partial: Partial<ToolDiffFileView> & Pick<ToolDiffFileView, 'path' | 'added' | 'removed'>): ToolDiffFileView {
    return {
      oldText: null,
      newText: '',
      truncated: false,
      countsPartial: false,
      comparisonUnavailable: false,
      outsideWorkspace: false,
      bodyId: 'tool-diff-body-x-0',
      toggleId: 'tool-diff-toggle-x-0',
      lines: [],
      countsLabel: '',
      ...partial,
    };
  }

  it('uses singular forms for one added and one removed', () => {
    expect(
      describeDiffFileForScreenReader(file({ path: 'src/a.ts', added: 1, removed: 1 })),
    ).toBe('src/a.ts: 1 line added, 1 line removed');
  });

  it('uses plural forms for multi-line counts', () => {
    expect(
      describeDiffFileForScreenReader(file({ path: 'src/b.ts', added: 2, removed: 3 })),
    ).toBe('src/b.ts: 2 lines added, 3 lines removed');
  });

  it('appends partial truncation note when countsPartial', () => {
    expect(
      describeDiffFileForScreenReader(
        file({ path: 'src/c.ts', added: 2, removed: 0, countsPartial: true, truncated: true }),
      ),
    ).toBe(
      'src/c.ts: 2 lines added, 0 lines removed, counts are partial because this diff was truncated',
    );
  });

  it('appends outside workspace for marked files only', () => {
    expect(
      describeDiffFileForScreenReader(
        file({ path: 'outside.ts', added: 1, removed: 0, outsideWorkspace: true }),
      ),
    ).toBe('outside.ts: 1 line added, 0 lines removed, outside workspace');
    expect(
      describeDiffFileForScreenReader(file({ path: 'src/a.ts', added: 1, removed: 0 })),
    ).not.toContain('outside workspace');
  });
});

describe('M021 S04 outsideWorkspace marker', () => {
  it('normalizes present-only outsideWorkspace onto the file view', () => {
    const marked = buildToolDiffView({
      toolCallId: 'tc-out',
      fileChanges: [{ path: 'outside.ts', oldText: 'a', newText: 'b', outsideWorkspace: true }],
    });
    const plain = buildToolDiffView({
      toolCallId: 'tc-in',
      fileChanges: [change('src/a.ts', 'a', 'b')],
    });
    expect(marked.files[0].outsideWorkspace).toBe(true);
    expect(plain.files[0].outsideWorkspace).toBe(false);
  });

  it('includes outside workspace in the accessible summary without host layout', () => {
    const marked = buildToolDiffView({
      toolCallId: 'tc-out',
      fileChanges: [
        { path: 'outside.ts', oldText: 'old\n', newText: 'new\n', outsideWorkspace: true },
      ],
    });
    expect(describeDiffFileForScreenReader(marked.files[0])).toContain('outside workspace');
    expect(describeDiffFileForScreenReader(marked.files[0])).not.toMatch(/\/tmp\/|C:\\|Users\//);
    expect(marked.files[0].path).toBe('outside.ts');
  });

  it('keeps the marker when truncated and when comparison is unavailable', () => {
    const truncated = buildToolDiffView({
      toolCallId: 'tc-trunc',
      fileChanges: [
        { path: 'out.ts', oldText: 'a\n', newText: 'b\n', truncated: true, outsideWorkspace: true },
      ],
    });
    expect(truncated.files[0].outsideWorkspace).toBe(true);
    expect(describeDiffFileForScreenReader(truncated.files[0])).toContain('outside workspace');
    expect(describeDiffFileForScreenReader(truncated.files[0])).toContain('counts are partial');

    const complex = buildToolDiffView({
      toolCallId: 'tc-complex',
      fileChanges: [
        {
          path: 'out.ts',
          oldText: nLines(1100, 'old'),
          newText: nLines(1100, 'new'),
          outsideWorkspace: true,
        },
      ],
    });
    expect(complex.files[0].comparisonUnavailable).toBe(true);
    expect(complex.files[0].outsideWorkspace).toBe(true);
    expect(describeDiffFileForScreenReader(complex.files[0])).toMatch(
      /comparison unavailable.*outside workspace/,
    );
  });
});
