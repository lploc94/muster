import { describe, expect, it } from 'vitest';
import { parseBackendId, parseModelFromSelectValue } from './backend-resolve';

describe('parseBackendId', () => {
  it('parses backend::model select values (model picker format)', () => {
    expect(parseBackendId('grok::grok-4')).toBe('grok');
    expect(parseBackendId('claude::opus')).toBe('claude');
    expect(parseBackendId('opencode::some/model')).toBe('opencode');
  });

  it('accepts bare backend ids', () => {
    expect(parseBackendId('grok')).toBe('grok');
    expect(parseBackendId('codex')).toBe('codex');
  });

  it('rejects unknown / empty values', () => {
    expect(parseBackendId(undefined)).toBeNull();
    expect(parseBackendId(null)).toBeNull();
    expect(parseBackendId('')).toBeNull();
    expect(parseBackendId('gemini')).toBeNull();
    expect(parseBackendId('gemini::x')).toBeNull();
  });
});

describe('parseModelFromSelectValue', () => {
  it('extracts model from backend::model', () => {
    expect(parseModelFromSelectValue('grok::grok-4')).toBe('grok-4');
  });

  it('returns null for bare backend or empty model', () => {
    expect(parseModelFromSelectValue('grok')).toBeNull();
    expect(parseModelFromSelectValue('grok::')).toBeNull();
    expect(parseModelFromSelectValue(undefined)).toBeNull();
  });
});
