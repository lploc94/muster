import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CredentialContext } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { fingerprintStartWorkflow } from './workflow';
import { stageDispositionForSettlement } from './m018-test-helpers';
import type { MusterTask } from './types';

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

function rootTask(createdAt: string): MusterTask {
  return {
    id: 'root-1', role: 'coordinator', lifecycle: 'open', releaseState: 'released',
    goal: 'coordinate workflow reuse', parentId: null, prerequisites: [], backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 }, revision: 0,
    createdAt, updatedAt: createdAt, releasedAt: createdAt,
  };
}

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

  it('persists the declared node and its reversed-edge ancestors as reused without execution rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s03-reuse-closure-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const createdAt = '2026-08-01T00:00:00.000Z';
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        ['ws', 'm024-s03-closure', 'M024 S03 closure', createdAt, createdAt],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: rootTask(createdAt) });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws',
        turn: {
          id: 'turn-1', taskId: 'root-1', sequence: 1, status: 'running', trigger: 'user',
          inputs: [], createdAt, startedAt: createdAt,
        },
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-producer', version: 1,
        name: 'producer', topology: {
          kind: 'one_node_v1', nodes: [{ nodeId: 'middle' }], entryNodeId: 'middle',
        }, createdAt,
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-graph', version: 1,
        name: 'graph', topology: {
          kind: 'graph_v1',
          nodes: [{ nodeId: 'source' }, { nodeId: 'middle' }, { nodeId: 'sink' }],
          edges: [
            { fromNodeId: 'source', toNodeId: 'middle', inputRef: 'source_result' },
            { fromNodeId: 'middle', toNodeId: 'sink', inputRef: 'middle_result' },
          ],
        }, createdAt,
      });
      const priorStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-producer', version: 1,
        startIdempotencyKey: 'prior', createdAt, ownerRootTaskId: 'root-1',
        callerTaskId: 'root-1', callerTurnId: 'turn-1',
      });
      expect(priorStart).toMatchObject({ ok: true, changed: true });
      const prior = priorStart.operation!.result.data as {
        runId: string; entryTaskId: string; activationTurnId: string;
      };
      await client.run(
        `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
        ['2026-08-01T00:00:00.500Z', 'ws', prior.activationTurnId],
      );
      const priorTurn = await repository.getTurn(prior.activationTurnId);
      const priorTask = await repository.getTask(prior.entryTaskId);
      const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result: 'reused middle' };
      await stageDispositionForSettlement(repository, priorTurn!, disposition);
      await expect(repository.execute({
        kind: 'settleTurnAndApplyEffects', workspaceId: 'ws', expectedTaskRevision: priorTask!.revision,
        task: { ...priorTask!, lifecycle: 'succeeded', updatedAt: '2026-08-01T00:00:00.750Z' },
        turn: { ...priorTurn!, status: 'succeeded', finishedAt: '2026-08-01T00:00:00.750Z', disposition },
        expectedStatuses: ['running'], relatedTurns: [], messages: [],
      })).resolves.toMatchObject({ ok: true, changed: true });

      const started = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-graph', version: 1,
        startIdempotencyKey: 'consumer', createdAt: '2026-08-01T00:00:01.000Z',
        reuse: [{ nodeId: 'middle', fromRun: prior.runId }], ownerRootTaskId: 'root-1',
        callerTaskId: 'root-1', callerTurnId: 'turn-1',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const consumer = started.operation!.result.data as { runId: string };

      await expect(client.all(
        `SELECT node_id, task_id, status FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        ['ws', consumer.runId],
      )).resolves.toEqual([
        { node_id: 'middle', task_id: null, status: 'reused' },
        { node_id: 'sink', task_id: expect.any(String), status: 'active' },
        { node_id: 'source', task_id: null, status: 'reused' },
      ]);
      await expect(client.get(
        `SELECT workflow_turns_reserved FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', consumer.runId],
      )).resolves.toEqual({ workflow_turns_reserved: 1 });
      await expect(client.all(
        `SELECT node.task_id
           FROM workflow_nodes node
           JOIN tasks task ON task.workspace_id = node.workspace_id AND task.id = node.task_id
          WHERE node.workspace_id = ? AND node.run_id = ? AND node.status = 'reused'`,
        ['ws', consumer.runId],
      )).resolves.toEqual([]);
      await expect(client.all(
        `SELECT turn.id
           FROM workflow_nodes node
           JOIN turns turn ON turn.workspace_id = node.workspace_id AND turn.task_id = node.task_id
          WHERE node.workspace_id = ? AND node.run_id = ? AND node.status = 'reused'`,
        ['ws', consumer.runId],
      )).resolves.toEqual([]);
      await expect(client.all(
        `SELECT message.id
           FROM workflow_nodes node
           JOIN messages message ON message.workspace_id = node.workspace_id AND message.task_id = node.task_id
          WHERE node.workspace_id = ? AND node.run_id = ? AND node.status = 'reused'`,
        ['ws', consumer.runId],
      )).resolves.toEqual([]);
      await expect(client.get(
        `SELECT binding.required_kind, fill.artifact_run_id, fill.artifact_id, fill.artifact_revision
           FROM workflow_gate_bindings binding
           JOIN workflow_gate_fills fill
             ON fill.workspace_id = binding.workspace_id
            AND fill.run_id = binding.run_id
            AND fill.gate_id = binding.gate_id
            AND fill.input_ref = binding.input_ref
          WHERE binding.workspace_id = ? AND binding.run_id = ?
            AND binding.producer_node_id = ? AND binding.input_ref = ?`,
        ['ws', consumer.runId, 'middle', 'middle_result'],
      )).resolves.toMatchObject({
        required_kind: 'next_result', artifact_run_id: prior.runId,
        artifact_id: expect.any(String), artifact_revision: 1,
      });
      await expect(client.get(
        `SELECT node.task_id, node.status, gate.status AS gate_status,
                activation.status AS activation_status, turn.status AS turn_status
           FROM workflow_nodes node
           JOIN workflow_dependency_gates gate
             ON gate.workspace_id = node.workspace_id AND gate.run_id = node.run_id
            AND gate.consumer_node_id = node.node_id
           JOIN workflow_activations activation
             ON activation.workspace_id = node.workspace_id AND activation.run_id = node.run_id
            AND activation.node_id = node.node_id
           JOIN turns turn ON turn.workspace_id = activation.workspace_id AND turn.id = activation.execution_turn_id
          WHERE node.workspace_id = ? AND node.run_id = ? AND node.node_id = ?`,
        ['ws', consumer.runId, 'sink'],
      )).resolves.toMatchObject({
        task_id: expect.any(String), status: 'active', gate_status: 'satisfied',
        activation_status: 'queued', turn_status: 'queued',
      });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
