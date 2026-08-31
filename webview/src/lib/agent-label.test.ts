import { describe, expect, it } from 'vitest';
import { resolveAgentLabel } from './agent-label';

describe('resolveAgentLabel', () => {
  it('names the agent from the host brief kind', () => {
    expect(resolveAgentLabel({ role: 'worker', briefKind: 'plan' })).toBe('Planner');
    expect(resolveAgentLabel({ role: 'worker', briefKind: 'verify' })).toBe('Verifier');
    expect(resolveAgentLabel({ role: 'coordinator', briefKind: 'coordinate' })).toBe('Coordinator');
  });

  it('falls back to the role when the kind is absent, generic, or unknown', () => {
    expect(resolveAgentLabel({ role: 'worker' })).toBe('Agent');
    expect(resolveAgentLabel({ role: 'worker', briefKind: 'generic' })).toBe('Agent');
    expect(resolveAgentLabel({ role: 'worker', briefKind: 'not-a-kind' })).toBe('Agent');
    expect(resolveAgentLabel({ role: 'coordinator' })).toBe('Coordinator');
    expect(resolveAgentLabel({ role: 'coordinator', briefKind: '   ' })).toBe('Coordinator');
  });

  it('never returns the backend or model, which are configuration not identity', () => {
    const label = resolveAgentLabel({ role: 'worker', briefKind: 'implement' });
    expect(label).toBe('Implementer');
    expect(label).not.toMatch(/claude|grok|sonnet|opus/i);
  });
});
