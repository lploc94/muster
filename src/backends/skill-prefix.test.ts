import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKILL_PREFIX,
  SKILL_INVOCATION_PREFIX,
  SKILL_TRIGGER_PREFIX,
  skillPrefixForBackend,
} from './skill-prefix';

describe('skillPrefixForBackend (host injection prefix)', () => {
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

describe('SKILL_TRIGGER_PREFIX (composer trigger/display prefix)', () => {
  it('is a uniform `/` used for the picker trigger and chips on every backend', () => {
    expect(SKILL_TRIGGER_PREFIX).toBe('/');
  });

  it('is decoupled from the injection prefix — normalizing the UX must not change the wire text', () => {
    // The composer trigger/display is normalized to `/` for all backends, but the
    // host still injects `$` for Codex so the skill actually expands. Conflating
    // the two would silently break Codex skills (`/name` → "Unrecognized command").
    expect(SKILL_TRIGGER_PREFIX).toBe('/');
    expect(skillPrefixForBackend('codex')).toBe('$');
    expect(SKILL_TRIGGER_PREFIX).not.toBe(skillPrefixForBackend('codex'));
  });
});
