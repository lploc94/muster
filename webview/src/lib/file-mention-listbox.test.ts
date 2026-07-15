import { describe, expect, it } from 'vitest';
import {
  FILE_MENTION_LISTBOX_ID,
  FILE_MENTION_LISTBOX_LABEL,
  clampFileMentionActiveIndex,
  fileMentionOptionId,
  fileMentionStatusText,
  resolveFileMentionActiveDescendant,
  type FileMentionListboxOutcome,
} from './file-mention-listbox';

describe('file-mention-listbox helpers', () => {
  it('uses stable listbox id and accessible label', () => {
    expect(FILE_MENTION_LISTBOX_ID).toBe('file-mention-listbox');
    expect(FILE_MENTION_LISTBOX_LABEL).toBe('File mention suggestions');
  });

  it('builds deterministic option ids from index', () => {
    expect(fileMentionOptionId(0)).toBe('file-mention-option-0');
    expect(fileMentionOptionId(3)).toBe('file-mention-option-3');
  });

  it('clamps active index into range and seeds -1 to 0 when items exist', () => {
    expect(clampFileMentionActiveIndex(-1, 0)).toBe(-1);
    expect(clampFileMentionActiveIndex(-1, 3)).toBe(0);
    expect(clampFileMentionActiveIndex(0, 3)).toBe(0);
    expect(clampFileMentionActiveIndex(2, 3)).toBe(2);
    expect(clampFileMentionActiveIndex(5, 3)).toBe(2);
    expect(clampFileMentionActiveIndex(1, 0)).toBe(-1);
  });

  it('resolves active-descendant only for in-range options', () => {
    expect(resolveFileMentionActiveDescendant(-1, 3)).toBeUndefined();
    expect(resolveFileMentionActiveDescendant(0, 0)).toBeUndefined();
    expect(resolveFileMentionActiveDescendant(1, 3)).toBe('file-mention-option-1');
    expect(resolveFileMentionActiveDescendant(9, 3)).toBeUndefined();
  });

  it('maps empty and error outcomes to sanitized status text without paths', () => {
    const cases: Array<{ outcome: FileMentionListboxOutcome; text: string | null }> = [
      { outcome: 'closed', text: null },
      { outcome: 'loading', text: 'Loading file suggestions…' },
      { outcome: 'ready', text: null },
      { outcome: 'empty', text: 'No matching files' },
      { outcome: 'error', text: 'File suggestions unavailable' },
    ];
    for (const c of cases) {
      expect(fileMentionStatusText(c.outcome)).toBe(c.text);
    }
    // Never echo host codes or absolute paths in the public status string.
    expect(fileMentionStatusText('error')).not.toMatch(/listingFailed|invalidRequest|\/Users|C:\\/);
  });
});
