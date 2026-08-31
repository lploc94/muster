import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CredentialContext } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { fingerprintStartWorkflow, validateStartWorkflow } from './workflow';

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
        inputs: [{ name: 'request', fromRun: 'run-prior', output: 'verifiedPlan' }],
      },
      ctx(),
    );

    expect(result).toMatchObject({
      ok: true,
      command: {
        kind: 'start_workflow',
        inputs: [{
          name: 'request',
          fromRun: 'run-prior',
          output: 'verifiedPlan',
        }],
      },
    });
  });

  it('accepts a structurally valid prior-run reference and fingerprints it distinctly from a literal', () => {
    const base = {
      definitionId: 'workflow-definition',
      version: 1,
      startIdempotencyKey: 'start-key',
      createdAt: '2026-08-01T00:00:00.000Z',
      entryNodeId: 'entry',
      entryContracts: [{
        entryNodeId: 'entry',
        inputRef: 'request',
        expectedArtifactKind: 'workflow_input',
      }],
      inputContracts: [{
        name: 'request',
        semanticKind: 'plan',
        entryNodeId: 'entry',
        inputRef: 'request',
      }],
      ownerRootTaskId: 'root-1',
      callerTaskId: 'task-1',
      callerTurnId: 'turn-1',
    };
    const reference = validateStartWorkflow({
      ...base,
      inputs: [{ name: 'request', fromRun: 'run-prior', output: 'verifiedPlan' }],
    });
    const literal = fingerprintStartWorkflow({
      definitionId: base.definitionId,
      version: base.version,
      startIdempotencyKey: base.startIdempotencyKey,
      entryNodeId: base.entryNodeId,
      goal: base.definitionId,
      backend: 'grok',
      ownerRootTaskId: base.ownerRootTaskId,
      callerTaskId: base.callerTaskId,
      callerTurnId: base.callerTurnId,
      inputs: [{ name: 'request', value: 'run-prior' }],
    });

    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(reference.inputs).toEqual([
      { name: 'request', fromRun: 'run-prior', output: 'verifiedPlan' },
    ]);
    expect(reference.entryInputs).toEqual([
      {
        name: 'request',
        semanticKind: 'plan',
        entryNodeId: 'entry',
        inputRef: 'request',
        fromRun: 'run-prior',
        output: 'verifiedPlan',
      },
    ]);
    expect(reference.fingerprint).not.toBe(literal);
  });

  it('rejects an unresolved referenced result before it claims a workflow run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s02-unresolved-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-consumer', version: 1,
        name: 'consumer', topology: {
          kind: 'workflow',
          inputs: [{ name: 'request', semanticKind: 'plan', entryNodeId: 'entry', inputRef: 'request' }],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
          nodes: [{ nodeId: 'entry' }],
          edges: [],
        },
        entryContracts: [{
          entryNodeId: 'entry', inputRef: 'request', expectedArtifactKind: 'workflow_input',
        }],
        createdAt: '2026-08-01T00:00:00.000Z',
      });
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-consumer', version: 1,
        startIdempotencyKey: 'unresolved-reference', createdAt: '2026-08-01T00:00:00.000Z',
        inputs: [{ name: 'request', fromRun: 'missing-run', output: 'verifiedPlan' }],
        ownerRootTaskId: 'root-1', callerTaskId: 'caller-1', callerTurnId: 'turn-1',
      })).resolves.toMatchObject({
        ok: false, conflict: true, reason: 'workflow input reference unresolved',
      });
      await expect(client.all(
        'SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws'],
      )).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    ['both value and fromRun', { name: 'request', value: 'literal', fromRun: 'run-prior', output: 'result' }],
    ['neither value nor fromRun', { name: 'request' }],
    ['missing output', { name: 'request', fromRun: 'run-prior' }],
    ['unknown key', { name: 'request', fromRun: 'run-prior', output: 'result', extra: true }],
    ['a non-string value alongside fromRun', { name: 'request', value: 1, fromRun: 'run-prior', output: 'result' }],
  ])('rejects an entry input with %s', (_caseName, input) => {
    expect(dispatch('start_workflow', { workflow, inputs: [input] }, ctx())).toEqual({
      ok: false,
      toolError: 'invalid start_workflow inputs',
    });
  });

  it.each([
    ['unknown', [{ name: 'other', value: 'x' }]],
    ['duplicate', [{ name: 'request', value: 'x' }, { name: 'request', value: 'y' }]],
    ['missing', []],
  ])('rejects %s public destination coverage before allocating identities', (_caseName, inputs) => {
    const validated = validateStartWorkflow({
      definitionId: 'workflow-definition',
      version: 1,
      startIdempotencyKey: `invalid-${_caseName}`,
      createdAt: '2026-08-01T00:00:00.000Z',
      entryNodeId: 'entry',
      entryContracts: [{ entryNodeId: 'entry', inputRef: 'request', expectedArtifactKind: 'workflow_input' }],
      inputContracts: [{ name: 'request', semanticKind: 'plan', entryNodeId: 'entry', inputRef: 'request' }],
      inputs,
      ownerRootTaskId: 'root-1',
      callerTaskId: 'task-1',
      callerTurnId: 'turn-1',
    });
    expect(validated).toMatchObject({ ok: false });
  });

  it.each([
    ['literal plus source coordinates', {
      name: 'request', value: 'x', fromRun: 'run-prior', output: 'verifiedPlan',
    }],
    ['prior output plus destination coordinates', {
      name: 'request', fromRun: 'run-prior', output: 'verifiedPlan',
      entryNodeId: 'entry', inputRef: 'request', artifactId: 'artifact-1', artifactRevision: 1,
    }],
  ])('rejects trusted start input with %s', (_caseName, rawInput) => {
    expect(validateStartWorkflow({
      definitionId: 'workflow-definition',
      version: 1,
      startIdempotencyKey: `closed-${_caseName}`,
      createdAt: '2026-08-01T00:00:00.000Z',
      entryNodeId: 'entry',
      entryContracts: [{ entryNodeId: 'entry', inputRef: 'request', expectedArtifactKind: 'workflow_input' }],
      inputContracts: [{ name: 'request', semanticKind: 'plan', entryNodeId: 'entry', inputRef: 'request' }],
      inputs: [rawInput as any],
      ownerRootTaskId: 'root-1',
      callerTaskId: 'task-1',
      callerTurnId: 'turn-1',
    })).toMatchObject({ ok: false, reason: 'invalid workflow input' });
  });
});
