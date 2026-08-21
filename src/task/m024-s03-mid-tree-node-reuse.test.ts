import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CredentialContext } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { DEFAULT_WORKFLOW_POLICY, fingerprintStartWorkflow, validateStartWorkflow } from './workflow';
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

async function settleNext(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  result: string,
  finishedAt: string,
) {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
    [finishedAt, 'ws', turnId],
  );
  const task = await repository.getTask(taskId);
  const turn = await repository.getTurn(turnId);
  const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result };
  await stageDispositionForSettlement(repository, turn!, disposition);
  return repository.execute({
    kind: 'settleTurnAndApplyEffects', workspaceId: 'ws', expectedTaskRevision: task!.revision,
    task: { ...task!, lifecycle: 'succeeded', updatedAt: finishedAt },
    turn: { ...turn!, status: 'succeeded', finishedAt, disposition },
    expectedStatuses: ['running'], relatedTurns: [], messages: [],
  });
}

/** Bind a fully reused prefix to the same exact prior execution. */
function boundAncestors(prior: { runId: string; entryTaskId: string }) {
  return ['source', 'middle'].map((destinationNodeId) => ({
    destinationNodeId,
    sourceRunId: prior.runId,
    sourceNodeId: 'middle',
    sourceTaskId: prior.entryTaskId,
  }));
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
      {
        workflow,
        reuse: [{
          node: 'four', fromRun: 'run-prior', fromNode: 'produce', fromTask: 'wft_prior',
        }],
      },
      ctx(),
    );

    expect(result).toMatchObject({
      ok: true,
      command: {
        kind: 'start_workflow',
        // Source is addressed independently of the destination: `produce` is not a node
        // of this workflow at all, and `fromTask` names which execution of it is bound.
        reuse: [{
          destinationNodeId: 'four',
          sourceRunId: 'run-prior',
          sourceNodeId: 'produce',
          sourceTaskId: 'wft_prior',
        }],
      },
    });
  });

  it('fingerprints every reuse identity, not just the source run', () => {
    const base = {
      destinationNodeId: 'four', sourceRunId: 'run-prior', sourceNodeId: 'produce',
    };
    const first = fingerprintStartWorkflow({
      ...fingerprintBase, reuse: [{ ...base, sourceTaskId: 'wft_a' }],
    });
    // Same destination and same source run, different bound execution: a different start,
    // so it must not collide with `first` on the start idempotency ledger.
    expect(fingerprintStartWorkflow({
      ...fingerprintBase, reuse: [{ ...base, sourceTaskId: 'wft_b' }],
    })).not.toBe(first);
    expect(fingerprintStartWorkflow({
      ...fingerprintBase, reuse: [{ ...base, sourceNodeId: 'other', sourceTaskId: 'wft_a' }],
    })).not.toBe(first);
    expect(fingerprintStartWorkflow({
      ...fingerprintBase, reuse: [{ ...base, sourceRunId: 'run-other', sourceTaskId: 'wft_a' }],
    })).not.toBe(first);
  });

  it.each([
    ['missing fromRun', { node: 'four', fromNode: 'produce', fromTask: 'wft_prior' }],
    ['missing node', { fromRun: 'run-prior', fromNode: 'produce', fromTask: 'wft_prior' }],
    ['missing fromNode', { node: 'four', fromRun: 'run-prior', fromTask: 'wft_prior' }],
    ['missing fromTask', { node: 'four', fromRun: 'run-prior', fromNode: 'produce' }],
    ['extra key', { node: 'four', fromRun: 'run-prior', fromNode: 'produce', fromTask: 'wft_prior', value: 'forbidden' }],
    ['non-string fromRun', { node: 'four', fromRun: 1, fromNode: 'produce', fromTask: 'wft_prior' }],
    ['non-string fromTask', { node: 'four', fromRun: 'run-prior', fromNode: 'produce', fromTask: 1 }],
    [
      'duplicate destination',
      { node: 'four', fromRun: 'run-prior', fromNode: 'produce', fromTask: 'wft_a' },
      { node: 'four', fromRun: 'run-other', fromNode: 'produce', fromTask: 'wft_b' },
    ],
  ])('rejects malformed reuse: %s', (_caseName, first, second?) => {
    const reuse = second === undefined ? [first] : [first, second];
    expect(dispatch('start_workflow', { workflow, reuse }, ctx())).toEqual({
      ok: false,
      toolError: 'invalid start_workflow reuse',
    });
  });

  it('rejects a reuse destination outside the declared topology', () => {
    expect(validateStartWorkflow({
      definitionId: 'wf-graph', version: 1, startIdempotencyKey: 'unknown-reuse',
      createdAt: '2026-08-01T00:00:00.000Z', entryNodeId: 'source',
      entryNodeIds: ['source'], allNodeIds: ['source', 'middle', 'sink'],
      reuse: [{
        destinationNodeId: 'not-a-node', sourceRunId: 'prior-run',
        sourceNodeId: 'source', sourceTaskId: 'wft_prior',
      }],
    })).toEqual({ ok: false, reason: 'invalid reuse' });
  });

  it('accepts a source node id that is absent from the destination topology', () => {
    // The artifact may have been produced by a differently-named node under another
    // definition. Validating `sourceNodeId` against this topology would make exactly the
    // cross-definition reuse this contract exists for impossible to express.
    expect(validateStartWorkflow({
      definitionId: 'wf-graph', version: 1, startIdempotencyKey: 'foreign-source',
      createdAt: '2026-08-01T00:00:00.000Z', entryNodeId: 'source',
      entryNodeIds: ['source'], allNodeIds: ['source', 'middle', 'sink'],
      reuse: [{
        destinationNodeId: 'middle', sourceRunId: 'prior-run',
        sourceNodeId: 'not-in-this-topology', sourceTaskId: 'wft_prior',
      }],
    })).toMatchObject({ ok: true });
  });

  it.each([
    [
      'a terminal target',
      { destinationNodeId: 'sink', sourceRunId: 'prior-run', sourceNodeId: 'produce', sourceTaskId: 'wft_prior' },
      'terminal node cannot be reused',
    ],
    [
      'a missing producer result',
      { destinationNodeId: 'middle', sourceRunId: 'prior-run', sourceNodeId: 'produce', sourceTaskId: 'wft_prior' },
      'node reuse reference unresolved',
    ],
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
        startIdempotencyKey: `reject-${reuse.destinationNodeId}`, createdAt: '2026-08-01T00:00:00.000Z',
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

  it('persists every caller-bound node as reused with durable source provenance', async () => {
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

      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-multi-hop-gates', version: 1,
        name: 'multi hop gates', topology: {
          kind: 'graph_v1',
          nodes: ['source', 'other', 'middle', 'middle2', 'sink'].map((nodeId) => ({ nodeId })),
          edges: [
            { fromNodeId: 'source', toNodeId: 'middle', inputRef: 'source_result' },
            { fromNodeId: 'middle', toNodeId: 'middle2', inputRef: 'middle_result' },
            { fromNodeId: 'other', toNodeId: 'middle2', inputRef: 'other_result' },
            { fromNodeId: 'middle2', toNodeId: 'sink', inputRef: 'middle2_result' },
          ],
        }, createdAt,
      });
      const multiStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-multi-hop-gates', version: 1,
        startIdempotencyKey: 'multi-hop-gates', createdAt: '2026-08-01T00:00:00.800Z',
        reuse: ['middle', 'middle2'].map((destinationNodeId) => ({
          destinationNodeId,
          sourceRunId: prior.runId,
          sourceNodeId: 'middle',
          sourceTaskId: prior.entryTaskId,
        })),
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'turn-1',
      });
      expect(multiStart).toMatchObject({ ok: true, changed: true });
      const multi = multiStart.operation!.result.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
      };
      const multiEntries = new Map(multi.entries.map((entry) => [entry.nodeId, entry]));
      const sourceEntry = multiEntries.get('source')!;
      await expect(settleNext(
        repository, client, sourceEntry.taskId, sourceEntry.activationTurnId,
        'source result', '2026-08-01T00:00:00.850Z',
      )).resolves.toMatchObject({ ok: true, changed: true });
      await expect(client.all(
        `SELECT consumer_node_id, status FROM workflow_dependency_gates
          WHERE workspace_id = ? AND run_id = ? ORDER BY consumer_node_id`,
        ['ws', multi.runId],
      )).resolves.toEqual([
        { consumer_node_id: 'middle', status: 'consumed' },
        { consumer_node_id: 'middle2', status: 'open' },
        { consumer_node_id: 'other', status: 'satisfied' },
        { consumer_node_id: 'sink', status: 'open' },
        { consumer_node_id: 'source', status: 'consumed' },
      ]);
      const sinkBefore = await client.get<{ task_id: string; status: string }>(
        `SELECT task_id, status FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'sink'`,
        ['ws', multi.runId],
      );
      expect(sinkBefore?.status).toBe('pending');
      expect(await repository.listTurns(sinkBefore!.task_id)).toHaveLength(0);
      const otherEntry = multiEntries.get('other')!;
      await expect(settleNext(
        repository, client, otherEntry.taskId, otherEntry.activationTurnId,
        'other result', '2026-08-01T00:00:00.900Z',
      )).resolves.toMatchObject({ ok: true, changed: true });
      await expect(client.all(
        `SELECT consumer_node_id, status FROM workflow_dependency_gates
          WHERE workspace_id = ? AND run_id = ? AND consumer_node_id IN ('middle2','sink')
          ORDER BY consumer_node_id`,
        ['ws', multi.runId],
      )).resolves.toEqual([
        { consumer_node_id: 'middle2', status: 'consumed' },
        { consumer_node_id: 'sink', status: 'satisfied' },
      ]);
      expect(await repository.listTurns(sinkBefore!.task_id)).toHaveLength(1);

      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-kind-mismatch', version: 1,
        name: 'kind mismatch', topology: {
          kind: 'graph_v1',
          nodes: [{ nodeId: 'source' }, { nodeId: 'middle' }, { nodeId: 'sink' }],
          edges: [
            { fromNodeId: 'source', toNodeId: 'middle', inputRef: 'source_result' },
            { fromNodeId: 'middle', toNodeId: 'sink', inputRef: 'middle_result', expectedArtifactKind: 'workflow_input' },
          ],
        }, createdAt,
      });
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-kind-mismatch', version: 1,
        startIdempotencyKey: 'kind-mismatch', createdAt: '2026-08-01T00:00:00.800Z',
        reuse: boundAncestors(prior), ownerRootTaskId: 'root-1',
        callerTaskId: 'root-1', callerTurnId: 'turn-1',
      })).resolves.toMatchObject({ ok: false, conflict: true, reason: 'reuse artifact kind mismatch' });
      await expect(client.all(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND definition_id = ?`,
        ['ws', 'wf-kind-mismatch'],
      )).resolves.toEqual([]);

      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-budget-boundary', version: 1,
        name: 'budget boundary', topology: {
          kind: 'graph_v1',
          nodes: ['source', 'middle', 'sink', 'other', 'other_sink'].map((nodeId) => ({ nodeId })),
          edges: [
            { fromNodeId: 'source', toNodeId: 'middle', inputRef: 'source_result' },
            { fromNodeId: 'middle', toNodeId: 'sink', inputRef: 'middle_result' },
            { fromNodeId: 'other', toNodeId: 'other_sink', inputRef: 'other_result' },
          ],
        }, policy: { ...DEFAULT_WORKFLOW_POLICY, maxWorkflowTurnsPerRun: 1 }, createdAt,
      });
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-budget-boundary', version: 1,
        startIdempotencyKey: 'budget-boundary', createdAt: '2026-08-01T00:00:00.900Z',
        reuse: boundAncestors(prior), ownerRootTaskId: 'root-1',
        callerTaskId: 'root-1', callerTurnId: 'turn-1',
      })).resolves.toMatchObject({ ok: false, conflict: true, reason: 'invalid start' });
      await expect(client.all(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND definition_id = ?`,
        ['ws', 'wf-budget-boundary'],
      )).resolves.toEqual([]);

      const partialStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-graph', version: 1,
        startIdempotencyKey: 'unbound-ancestor', createdAt: '2026-08-01T00:00:00.950Z',
        reuse: [{
          destinationNodeId: 'middle', sourceRunId: prior.runId,
          sourceNodeId: 'middle', sourceTaskId: prior.entryTaskId,
        }],
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'turn-1',
      });
      expect(partialStart).toMatchObject({ ok: true, changed: true });
      const partial = partialStart.operation!.result.data as { runId: string; entryTaskId: string; activationTurnId: string };
      await expect(client.all(
        `SELECT node_id, task_id, status FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        ['ws', partial.runId],
      )).resolves.toEqual([
        { node_id: 'middle', task_id: null, status: 'reused' },
        { node_id: 'sink', task_id: expect.any(String), status: 'pending' },
        { node_id: 'source', task_id: partial.entryTaskId, status: 'active' },
      ]);
      const sinkNode = await client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = 'sink'`,
        ['ws', partial.runId],
      );
      const sinkTask = await repository.getTask(sinkNode!.task_id);
      expect(sinkTask?.workflowShell).toMatchObject({ runId: partial.runId, nodeId: 'sink' });
      expect(await repository.listTurns(sinkNode!.task_id)).toHaveLength(0);
      const started = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-graph', version: 1,
        startIdempotencyKey: 'consumer', createdAt: '2026-08-01T00:00:01.000Z',
        reuse: boundAncestors(prior), ownerRootTaskId: 'root-1',
        callerTaskId: 'root-1', callerTurnId: 'turn-1',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const consumer = started.operation!.result.data as { runId: string };
      const bound = {
        source_run_id: prior.runId,
        source_node_id: 'middle',
        source_task_id: prior.entryTaskId,
        source_artifact_id: expect.any(String),
        source_artifact_revision: 1,
      };
      await expect(repository.execute({
        kind: 'deleteTaskSubtree', workspaceId: 'ws', rootTaskId: prior.entryTaskId,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(repository.getTask(prior.entryTaskId)).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT 1 AS present FROM workflow_artifact_sources
          WHERE workspace_id = ? AND run_id = ? AND producer_task_id = ?`,
        ['ws', prior.runId, prior.entryTaskId],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT artifact.artifact_id
           FROM workflow_nodes reused
           JOIN workflow_artifacts artifact
             ON artifact.workspace_id = reused.workspace_id
            AND artifact.run_id = reused.source_run_id
            AND artifact.artifact_id = reused.source_artifact_id
            AND artifact.revision = reused.source_artifact_revision
          WHERE reused.workspace_id = ? AND reused.run_id = ? AND reused.node_id = 'middle'`,
        ['ws', partial.runId],
      )).resolves.toMatchObject({ artifact_id: expect.any(String) });
      const partialSourceTurn = await repository.getTurn(partial.activationTurnId);
      const partialSourceTask = await repository.getTask(partial.entryTaskId);
      await client.run(
        `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
        ['2026-08-01T00:00:00.960Z', 'ws', partial.activationTurnId],
      );
      const runningPartialSourceTurn = await repository.getTurn(partial.activationTurnId);
      const partialDisposition = {
        kind: 'workflow_next' as const,
        change: 'updated' as const,
        result: 'materialized source result',
      };
      await stageDispositionForSettlement(repository, runningPartialSourceTurn!, partialDisposition);
      await expect(repository.execute({
        kind: 'settleTurnAndApplyEffects', workspaceId: 'ws', expectedTaskRevision: partialSourceTask!.revision,
        task: { ...partialSourceTask!, lifecycle: 'succeeded', updatedAt: '2026-08-01T00:00:00.975Z' },
        turn: {
          ...runningPartialSourceTurn!, status: 'succeeded', finishedAt: '2026-08-01T00:00:00.975Z',
          disposition: partialDisposition,
        },
        expectedStatuses: ['running'], relatedTurns: [], messages: [],
      })).resolves.toMatchObject({ ok: true, changed: true, affectedTaskIds: expect.any(Array) });
      await expect(client.all(
        `SELECT node.node_id, node.status, gate.status AS gate_status
           FROM workflow_nodes node
           JOIN workflow_dependency_gates gate
             ON gate.workspace_id = node.workspace_id AND gate.run_id = node.run_id
            AND gate.consumer_node_id = node.node_id
          WHERE node.workspace_id = ? AND node.run_id = ? AND node.node_id IN ('middle', 'sink', 'source')
          ORDER BY node.node_id`,
        ['ws', partial.runId],
      )).resolves.toEqual([
        { node_id: 'middle', status: 'reused', gate_status: 'consumed' },
        { node_id: 'sink', status: 'active', gate_status: 'satisfied' },
        { node_id: 'source', status: 'succeeded', gate_status: 'consumed' },
      ]);

      await expect(client.all(
        `SELECT node_id, task_id, status, source_run_id, source_node_id, source_task_id,
                source_artifact_id, source_artifact_revision
           FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        ['ws', consumer.runId],
      )).resolves.toEqual([
        { node_id: 'middle', task_id: null, status: 'reused', ...bound },
        {
          node_id: 'sink', task_id: expect.any(String), status: 'active',
          source_run_id: null, source_node_id: null, source_task_id: null,
          source_artifact_id: null, source_artifact_revision: null,
        },
        { node_id: 'source', task_id: null, status: 'reused', ...bound },
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
      await expect(client.all(
        `SELECT consumer_node_id, status FROM workflow_dependency_gates
          WHERE workspace_id = ? AND run_id = ? ORDER BY consumer_node_id`,
        ['ws', consumer.runId],
      )).resolves.toEqual([
        { consumer_node_id: 'middle', status: 'consumed' },
        { consumer_node_id: 'sink', status: 'satisfied' },
        { consumer_node_id: 'source', status: 'consumed' },
      ]);
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
