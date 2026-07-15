import { describe, expect, it } from 'vitest';
import { parseActiveFileMentionQuery } from './file-mention-query';

describe('parseActiveFileMentionQuery', () => {
  it('detects a bare @ at the caret as parentDepth 0 with empty relative query', () => {
    const text = 'see @';
    const caret = text.length;
    expect(parseActiveFileMentionQuery(text, caret)).toEqual({
      start: 4,
      end: caret,
      parentDepth: 0,
      relativeQuery: '',
    });
  });

  it('returns the replacement range and relative query for an in-progress unquoted mention', () => {
    const text = 'open @src/app';
    const caret = text.length;
    expect(parseActiveFileMentionQuery(text, caret)).toEqual({
      start: 5,
      end: caret,
      parentDepth: 0,
      relativeQuery: 'src/app',
    });
  });

  it('accepts caret inside the active token and ends the range at the caret', () => {
    const text = 'open @readme.md more';
    // caret after "read"
    const caret = 'open @read'.length;
    expect(parseActiveFileMentionQuery(text, caret)).toEqual({
      start: 5,
      end: caret,
      parentDepth: 0,
      relativeQuery: 'read',
    });
  });

  it('allows query characters matching unquoted mention grammar', () => {
    const text = '@a_b-1.ts';
    expect(parseActiveFileMentionQuery(text, text.length)).toEqual({
      start: 0,
      end: text.length,
      parentDepth: 0,
      relativeQuery: 'a_b-1.ts',
    });
  });

  it('ignores email-like @ when a word character precedes it', () => {
    expect(parseActiveFileMentionQuery('user@example.com', 5)).toBeNull();
    expect(parseActiveFileMentionQuery('mail user@ex', 'mail user@ex'.length)).toBeNull();
    expect(parseActiveFileMentionQuery('a@b', 2)).toBeNull();
  });

  it('ignores completed quoted mentions', () => {
    const text = 'see @"my file.md" please';
    // caret after the closed quote
    expect(parseActiveFileMentionQuery(text, 'see @"my file.md"'.length)).toBeNull();
    // caret inside the completed quoted body
    expect(parseActiveFileMentionQuery(text, 'see @"my fi'.length)).toBeNull();
  });

  it('ignores incomplete quoted mentions (S01 has no quoted-query path)', () => {
    const text = 'see @"partial';
    expect(parseActiveFileMentionQuery(text, text.length)).toBeNull();
  });

  it('ignores control characters in the active query', () => {
    expect(parseActiveFileMentionQuery('@foo\u0000bar', 5)).toBeNull();
    expect(parseActiveFileMentionQuery('@foo\nbar', 5)).toBeNull();
    expect(parseActiveFileMentionQuery('@foo\t', 5)).toBeNull();
  });

  it('parses @../ as parentDepth 1 with empty relative query and exact range', () => {
    const text = 'see @../';
    const caret = text.length;
    expect(parseActiveFileMentionQuery(text, caret)).toEqual({
      start: 4,
      end: caret,
      parentDepth: 1,
      relativeQuery: '',
    });
  });

  it('parses @../../ as parentDepth 2 with empty relative query and exact range', () => {
    const text = 'open @../../';
    const caret = text.length;
    expect(parseActiveFileMentionQuery(text, caret)).toEqual({
      start: 5,
      end: caret,
      parentDepth: 2,
      relativeQuery: '',
    });
  });

  it('accepts incomplete trailing parent segments without a slash', () => {
    expect(parseActiveFileMentionQuery('@..', 3)).toEqual({
      start: 0,
      end: 3,
      parentDepth: 1,
      relativeQuery: '',
    });
    expect(parseActiveFileMentionQuery('@../..', 6)).toEqual({
      start: 0,
      end: 6,
      parentDepth: 2,
      relativeQuery: '',
    });
  });

  it('preserves relative directory and basename query under parent scopes', () => {
    expect(parseActiveFileMentionQuery('@../src', 7)).toEqual({
      start: 0,
      end: 7,
      parentDepth: 1,
      relativeQuery: 'src',
    });
    const grand = '@../../lib/util';
    expect(parseActiveFileMentionQuery(grand, grand.length)).toEqual({
      start: 0,
      end: grand.length,
      parentDepth: 2,
      relativeQuery: 'lib/util',
    });
    // caret mid-token ends the replacement range and relative query at the caret
    const text = 'go @../src/app more';
    const caret = 'go @../src'.length;
    expect(parseActiveFileMentionQuery(text, caret)).toEqual({
      start: 3,
      end: caret,
      parentDepth: 1,
      relativeQuery: 'src',
    });
  });

  it('normalizes backslash parent prefixes to parentDepth', () => {
    expect(parseActiveFileMentionQuery('@..\\', 4)).toEqual({
      start: 0,
      end: 4,
      parentDepth: 1,
      relativeQuery: '',
    });
    expect(parseActiveFileMentionQuery('@..\\foo', 7)).toEqual({
      start: 0,
      end: 7,
      parentDepth: 1,
      relativeQuery: 'foo',
    });
  });

  it('rejects parent depth greater than 2', () => {
    expect(parseActiveFileMentionQuery('@../../../', 10)).toBeNull();
    expect(parseActiveFileMentionQuery('@../../../x', 11)).toBeNull();
    expect(parseActiveFileMentionQuery('@../../..', 9)).toBeNull();
  });

  it('rejects embedded or repeated traversal outside leading parent prefixes', () => {
    expect(parseActiveFileMentionQuery('@src/../x', 9)).toBeNull();
    expect(parseActiveFileMentionQuery('@../src/../x', 12)).toBeNull();
    expect(parseActiveFileMentionQuery('@../../a/../b', 13)).toBeNull();
    expect(parseActiveFileMentionQuery('@./x', 4)).toBeNull();
    expect(parseActiveFileMentionQuery('@.././x', 7)).toBeNull();
    expect(parseActiveFileMentionQuery('@foo/./bar', 10)).toBeNull();
    expect(parseActiveFileMentionQuery('@a//b', 5)).toBeNull();
  });

  it('ignores absolute roots, drive, and UNC-style prefixes', () => {
    expect(parseActiveFileMentionQuery('@/etc/passwd', 12)).toBeNull();
    expect(parseActiveFileMentionQuery('@\\windows', 9)).toBeNull();
    expect(parseActiveFileMentionQuery('@C:/Windows', 11)).toBeNull();
    expect(parseActiveFileMentionQuery('@c:\\temp', 8)).toBeNull();
    expect(parseActiveFileMentionQuery('@//server/share', 15)).toBeNull();
  });

  it('returns null when the caret is outside the active token', () => {
    const text = 'open @file.ts now';
    // caret before @
    expect(parseActiveFileMentionQuery(text, 3)).toBeNull();
    // caret on the @ itself (not yet past trigger)
    expect(parseActiveFileMentionQuery(text, 5)).toBeNull();
    // caret after whitespace past the token
    expect(parseActiveFileMentionQuery(text, text.length)).toBeNull();
  });

  it('returns null for empty text, out-of-range caret, or missing @', () => {
    expect(parseActiveFileMentionQuery('', 0)).toBeNull();
    expect(parseActiveFileMentionQuery('hello', 3)).toBeNull();
    expect(parseActiveFileMentionQuery('@ok', -1)).toBeNull();
    expect(parseActiveFileMentionQuery('@ok', 99)).toBeNull();
  });

  it('does not treat a closed unquoted mention as active when caret is after a boundary', () => {
    // space ends the token; caret after space is outside
    expect(parseActiveFileMentionQuery('@file ', 6)).toBeNull();
    // punctuation that is not part of unquoted grammar ends the token
    expect(parseActiveFileMentionQuery('@file)', 6)).toBeNull();
  });

  it('requires a valid trigger boundary before @ (start or non-word)', () => {
    expect(parseActiveFileMentionQuery('(@file', 6)).toEqual({
      start: 1,
      end: 6,
      parentDepth: 0,
      relativeQuery: 'file',
    });
    expect(parseActiveFileMentionQuery('\n@file', 6)).toEqual({
      start: 1,
      end: 6,
      parentDepth: 0,
      relativeQuery: 'file',
    });
  });
});
