import { describe, expect, it } from 'vitest';
import {
  TOOL_DIFF_COLLAPSE_FILE_THRESHOLD,
  TOOL_DIFF_COLLAPSE_LINE_THRESHOLD,
  buildToolDiffView,
  countDiffLines,
  describeDiffFileForScreenReader,
  sanitizeDomIdPart,
  type ToolDiffFileView,
} from './tool-diff-view';

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

describe('describeDiffFileForScreenReader', () => {
  function file(partial: Partial<ToolDiffFileView> & Pick<ToolDiffFileView, 'path' | 'added' | 'removed'>): ToolDiffFileView {
    return {
      oldText: null,
      newText: '',
      truncated: false,
      countsPartial: false,
      comparisonUnavailable: false,
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
});
