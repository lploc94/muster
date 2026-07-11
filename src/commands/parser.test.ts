import { describe, expect, it } from 'vitest';
import { isSlashCommand, parseInput, splitArgs } from './parser';

describe('parseInput', () => {
  it('treats plain text as a prompt', () => {
    expect(parseInput('fix the bug')).toEqual({ kind: 'plain', text: 'fix the bug' });
    expect(isSlashCommand('fix the bug')).toBe(false);
  });

  it('parses slash commands with args', () => {
    expect(parseInput('/help')).toEqual({
      kind: 'command',
      name: 'help',
      rawArgs: '',
      argv: [],
    });
    expect(parseInput('/new ship feature X')).toEqual({
      kind: 'command',
      name: 'new',
      rawArgs: 'ship feature X',
      argv: ['ship', 'feature', 'X'],
    });
    expect(isSlashCommand('/approve')).toBe(true);
  });

  it('returns empty for whitespace', () => {
    expect(parseInput('   ')).toEqual({ kind: 'empty' });
  });

  it('does not treat mid-line slash as a command', () => {
    expect(parseInput('see /path/to/file')).toEqual({
      kind: 'plain',
      text: 'see /path/to/file',
    });
  });
});

describe('splitArgs', () => {
  it('respects double quotes', () => {
    expect(splitArgs('one "two three" four')).toEqual(['one', 'two three', 'four']);
  });
});
