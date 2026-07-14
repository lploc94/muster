import { describe, expect, it } from 'vitest';
import { GrokBackend } from '../backends/grok';
import { ClaudeBackend } from '../backends/claude';
import { canBindTaskToBackend } from './backend-eligibility';

describe('§9 gate regression — backend MCP eligibility', () => {
  it('accepts shipping Grok and Claude backends (supportsMCP: true)', () => {
    const grok = new GrokBackend();
    const claude = new ClaudeBackend();
    expect(canBindTaskToBackend(grok.capabilities)).toBe(true);
    expect(canBindTaskToBackend(claude.capabilities)).toBe(true);
    expect(grok.capabilities?.supportsMCP).toBe(true);
    expect(claude.capabilities?.supportsMCP).toBe(true);
  });

  it('rejects backends without MCP support', () => {
    expect(
      canBindTaskToBackend({
        supportsMCP: false,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsLiveInput: false
      }),
    ).toBe(false);
  });
});