import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKILL_PREFIX,
  SKILL_INVOCATION_PREFIX,
  skillPrefixForBackend,
} from './skill-prefix';

describe('skillPrefixForBackend', () => {
  it('returns `$` for Codex', () => {
    expect(skillPrefixForBackend('codex')).toBe('$');
  });

  it('returns the default `/` for Claude and other backends', () => {
    expect(skillPrefixForBackend('claude')).toBe('/');
    expect(skillPrefixForBackend('opencode')).toBe('/');
    expect(skillPrefixForBackend('grok')).toBe('/');
  });

  it('falls back to the default `/` for unknown backend ids', () => {
    expect(skillPrefixForBackend('does-not-exist')).toBe(DEFAULT_SKILL_PREFIX);
    expect(skillPrefixForBackend('')).toBe('/');
  });

  it('exposes the raw map with only the Codex override', () => {
    expect(SKILL_INVOCATION_PREFIX).toEqual({ codex: '$' });
    expect(DEFAULT_SKILL_PREFIX).toBe('/');
  });
});
