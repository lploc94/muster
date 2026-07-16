import { describe, expect, it } from 'vitest';
import { parseActiveSkillQuery, stripActiveSkillQuery } from './skill-mention-query';

describe('parseActiveSkillQuery', () => {
  it('detects a bare prefix at input start as an empty query', () => {
    const text = '/';
    expect(parseActiveSkillQuery(text, 1, '/')).toEqual({ start: 0, end: 1, query: '' });
  });

  it('returns the range and query for an in-progress trigger at input start', () => {
    const text = '/re';
    expect(parseActiveSkillQuery(text, text.length, '/')).toEqual({
      start: 0,
      end: 3,
      query: 're',
    });
  });

  it('triggers after whitespace mid-text', () => {
    const text = 'run /plan';
    expect(parseActiveSkillQuery(text, text.length, '/')).toEqual({
      start: 4,
      end: text.length,
      query: 'plan',
    });
  });

  it('extends the range over the whole token when the caret is mid-token', () => {
    const text = '/planning';
    // Caret after "/plan": the range still covers the full contiguous token so a
    // later strip removes the entire name (no "ning" remnant).
    const caret = '/plan'.length;
    expect(parseActiveSkillQuery(text, caret, '/')).toEqual({
      start: 0,
      end: 9,
      query: 'planning',
    });
  });

  it('rejects a prefix embedded mid-path (no whitespace before)', () => {
    const text = 'src/utils';
    // caret after "src/ut"
    const caret = 'src/ut'.length;
    expect(parseActiveSkillQuery(text, caret, '/')).toBeNull();
  });

  it('rejects a prefix embedded mid-word for the Codex `$` variant', () => {
    const text = 'foo$bar';
    const caret = 'foo$ba'.length;
    expect(parseActiveSkillQuery(text, caret, '$')).toBeNull();
  });

  it('triggers on the Codex `$` prefix after whitespace', () => {
    const text = 'use $brainstorm';
    expect(parseActiveSkillQuery(text, text.length, '$')).toEqual({
      start: 4,
      end: text.length,
      query: 'brainstorm',
    });
  });

  it('returns null when the caret is not on a trigger token', () => {
    const text = 'just some text';
    expect(parseActiveSkillQuery(text, text.length, '/')).toBeNull();
  });

  it('returns null for out-of-range caret or non-single-char prefix', () => {
    expect(parseActiveSkillQuery('/re', 99, '/')).toBeNull();
    expect(parseActiveSkillQuery('/re', 3, '//')).toBeNull();
  });
});

describe('stripActiveSkillQuery', () => {
  it('removes the prefix+query slice at input start', () => {
    const text = '/plan';
    expect(stripActiveSkillQuery(text, { start: 0, end: 5 })).toEqual({ text: '', caret: 0 });
  });

  it('removes a mid-text trigger and keeps surrounding text', () => {
    const text = 'run /plan now';
    // strip the "/plan" slice (indices 4..9)
    expect(stripActiveSkillQuery(text, { start: 4, end: 9 })).toEqual({
      text: 'run  now',
      caret: 4,
    });
  });

  it('strips the whole token for a caret that landed mid-token (no remnant)', () => {
    // Range produced by parseActiveSkillQuery('/planning', 5, '/') → {start:0,end:9}.
    expect(stripActiveSkillQuery('/planning', { start: 0, end: 9 })).toEqual({
      text: '',
      caret: 0,
    });
  });
});
