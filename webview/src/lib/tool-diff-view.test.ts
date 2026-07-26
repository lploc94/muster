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
  it('replaces characters outside [A-Za-z0-9_-] with -', () => {
    expect(sanitizeDomIdPart('turn:producer/abc')).toBe('turn-producer-abc');
  });

  it('falls back to tool when result is empty', () => {
    // All-punctuation input becomes dashes (not empty); only truly empty falls back.
    expect(sanitizeDomIdPart(':::')).toBe('---');
    expect(sanitizeDomIdPart('')).toBe('tool');
  });

  it('preserves alphanumerics underscores and hyphens', () => {
    expect(sanitizeDomIdPart('tool_call-1')).toBe('tool_call-1');
  });
});

describe('buildToolDiffView', () => {
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
      bodyId: 'tool-diff-body-tc-1-0',
    });
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

  it('sanitizes toolCallId for bodyId and never embeds the path', () => {
    const view = buildToolDiffView({
      toolCallId: 'turn:producer/abc',
      fileChanges: [change('src/evil:path.ts', null, 'x')],
    });
    expect(view.files[0].bodyId).toBe('tool-diff-body-turn-producer-abc-0');
    expect(view.files[0].bodyId).not.toContain('evil');
    expect(view.files[0].bodyId).not.toContain(':');
    expect(view.files[0].bodyId).not.toContain('/');
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
      bodyId: 'tool-diff-body-x-0',
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
