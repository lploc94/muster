import { describe, expect, it } from 'vitest';
import type { CredentialContext } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { fingerprintStartWorkflow } from './workflow';

function ctx(): CredentialContext {
  return {
    credentialId: 'credential-1',
    rootId: 'root-1',
    callerTaskId: 'task-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    allowedActions: new Set(['start_workflow']),
    expiry: Date.now() + 60_000,
  };
}

const workflow = `workflow-${'a'.repeat(32)}@3`;

const fingerprintBase = {
  definitionId: 'workflow-definition',
  version: 1,
  startIdempotencyKey: 'start-key',
  entryNodeId: 'entry',
  goal: 'workflow-definition',
  backend: 'grok',
};

describe('start_workflow mid-tree node reuse', () => {
  it('decodes reuse references into the engine command', () => {
    const result = dispatch(
      'start_workflow',
      { workflow, reuse: [{ node: 'four', fromRun: 'run-prior' }] },
      ctx(),
    );

    expect(result).toMatchObject({
      ok: true,
      command: {
        kind: 'start_workflow',
        reuse: [{ nodeId: 'four', fromRun: 'run-prior' }],
      },
    });
  });

  it('fingerprints reuse references distinctly', () => {
    const first = fingerprintStartWorkflow({
      ...fingerprintBase,
      reuse: [{ nodeId: 'four', fromRun: 'run-prior-a' }],
    });
    const second = fingerprintStartWorkflow({
      ...fingerprintBase,
      reuse: [{ nodeId: 'four', fromRun: 'run-prior-b' }],
    });

    expect(first).not.toBe(second);
  });

  it.each([
    ['missing fromRun', { node: 'four' }],
    ['missing node', { fromRun: 'run-prior' }],
    ['extra key', { node: 'four', fromRun: 'run-prior', value: 'forbidden' }],
    ['non-string fromRun', { node: 'four', fromRun: 1 }],
    ['duplicate node', { node: 'four', fromRun: 'run-prior' }, { node: 'four', fromRun: 'run-other' }],
  ])('rejects malformed reuse: %s', (_caseName, first, second?) => {
    const reuse = second === undefined ? [first] : [first, second];
    expect(dispatch('start_workflow', { workflow, reuse }, ctx())).toEqual({
      ok: false,
      toolError: 'invalid start_workflow reuse',
    });
  });
});
