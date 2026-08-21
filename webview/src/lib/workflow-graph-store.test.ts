import { describe, expect, it } from 'vitest';
import { WorkflowGraphRefreshPolicy } from './workflow-graph-refresh-policy';

describe('WorkflowGraphStore patch ordering', () => {
  it('runs one trailing refresh when patches arrive during a successful request', () => {
    const policy = new WorkflowGraphRefreshPolicy();
    expect(policy.onPatch(true, false)).toBe('ignore');
    expect(policy.onPatch(true, false)).toBe('ignore');
    expect(policy.onResult(true)).toBe(true);
    expect(policy.onResult(true)).toBe(false);
  });

  it('keeps a settled error inert until explicit retry', () => {
    const policy = new WorkflowGraphRefreshPolicy();
    expect(policy.onPatch(true, false)).toBe('ignore');
    expect(policy.onResult(false)).toBe(false);
    expect(policy.onPatch(false, true)).toBe('ignore');
    policy.reset();
    expect(policy.onPatch(false, false)).toBe('fetch');
  });
});
