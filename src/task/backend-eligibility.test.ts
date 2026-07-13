import { describe, expect, it } from 'vitest';
import { canBindTaskToBackend } from './backend-eligibility';

describe('canBindTaskToBackend', () => {
  it('accepts backends with supportsMCP true', () => {
    expect(
      canBindTaskToBackend({
        supportsReasoning: false,
      supportsDetailedToolEvents: false,
      supportsMCP: true,
      supportsLiveInput: false
      }),
    ).toBe(true);
  });

  it('rejects backends with supportsMCP false', () => {
    expect(
      canBindTaskToBackend({
        supportsReasoning: true,
      supportsDetailedToolEvents: true,
      supportsMCP: false,
      supportsLiveInput: false
      }),
    ).toBe(false);
  });

  it('rejects undefined capabilities', () => {
    expect(canBindTaskToBackend(undefined)).toBe(false);
  });
});