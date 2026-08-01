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
      ownerRootTaskId: 'root-1',
      callerTaskId: 'task-1',
      callerTurnId: 'turn-1',
    };
    const reference = validateStartWorkflow({
      ...base,
      entryInputs: [{ entryNodeId: 'entry', inputRef: 'request', fromRun: 'run-prior' }],
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
      entryInputs: [{
        entryNodeId: 'entry', inputRef: 'request', kind: 'workflow_input', value: 'run-prior',
      }],
    });

    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(reference.entryInputs).toEqual([
      { entryNodeId: 'entry', inputRef: 'request', fromRun: 'run-prior' },
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
          kind: 'one_node_v1', nodes: [{ nodeId: 'entry' }], entryNodeId: 'entry',
        },
        entryContracts: [{
          entryNodeId: 'entry', inputRef: 'request', expectedArtifactKind: 'workflow_input',
        }],
        createdAt: '2026-08-01T00:00:00.000Z',
      });
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-consumer', version: 1,
        startIdempotencyKey: 'unresolved-reference', createdAt: '2026-08-01T00:00:00.000Z',
        entryInputs: [{ entryNodeId: 'entry', inputRef: 'request', fromRun: 'missing-run' }],
        ownerRootTaskId: 'root-1', callerTaskId: 'caller-1', callerTurnId: 'turn-1',
      })).resolves.toMatchObject({
        ok: false, conflict: true, reason: 'entry input reference unresolved',
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
