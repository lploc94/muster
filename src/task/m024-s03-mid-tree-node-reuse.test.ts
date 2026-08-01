import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CredentialContext } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
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

  it.each([
    ['a terminal target', { nodeId: 'sink', fromRun: 'prior-run' }, 'terminal node cannot be reused'],
    ['a missing producer result', { nodeId: 'middle', fromRun: 'prior-run' }, 'node reuse reference unresolved'],
  ])('rejects %s before it claims a consumer run', async (_caseName, reuse, reason) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s03-reuse-reject-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-graph', version: 1,
        name: 'graph', topology: {
          kind: 'graph_v1',
          nodes: [{ nodeId: 'source' }, { nodeId: 'middle' }, { nodeId: 'sink' }],
          edges: [
            { fromNodeId: 'source', toNodeId: 'middle', inputRef: 'source_result' },
            { fromNodeId: 'middle', toNodeId: 'sink', inputRef: 'middle_result' },
          ],
        }, createdAt: '2026-08-01T00:00:00.000Z',
      });

      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-graph', version: 1,
        startIdempotencyKey: `reject-${reuse.nodeId}`, createdAt: '2026-08-01T00:00:00.000Z',
        reuse: [reuse], ownerRootTaskId: 'root-1', callerTaskId: 'caller-1', callerTurnId: 'turn-1',
      })).resolves.toMatchObject({ ok: false, conflict: true, reason });
      await expect(client.all(
        'SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws'],
      )).resolves.toEqual([]);
      await expect(client.all(
        "SELECT ledger_key FROM operations WHERE workspace_id = ? AND ledger_key LIKE 'start_workflow:%'", ['ws'],
      )).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
