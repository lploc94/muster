import { describe, expect, it } from 'vitest';
import type { CredentialContext } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';

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

describe('start_workflow entry input artifact reuse', () => {
  it('decodes a prior-run reference without accepting a literal value', () => {
    const result = dispatch(
      'start_workflow',
      {
        workflow,
        inputs: [{ node: 'entry', input: 'request', fromRun: 'run-prior' }],
      },
      ctx(),
    );

    expect(result).toMatchObject({
      ok: true,
      command: {
        kind: 'start_workflow',
        entryInputs: [{
          entryNodeId: 'entry',
          inputRef: 'request',
          fromRun: 'run-prior',
        }],
      },
    });
  });

  it.each([
    ['both value and fromRun', { node: 'entry', input: 'request', value: 'literal', fromRun: 'run-prior' }],
    ['neither value nor fromRun', { node: 'entry', input: 'request' }],
    ['unknown key', { node: 'entry', input: 'request', fromRun: 'run-prior', extra: true }],
    ['a non-string value alongside fromRun', { node: 'entry', input: 'request', value: 1, fromRun: 'run-prior' }],
  ])('rejects an entry input with %s', (_caseName, input) => {
    expect(dispatch('start_workflow', { workflow, inputs: [input] }, ctx())).toEqual({
      ok: false,
      toolError: 'invalid start_workflow inputs',
    });
  });
});
