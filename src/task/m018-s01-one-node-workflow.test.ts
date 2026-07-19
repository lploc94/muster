/**
 * M018 S01 named flow (domain + repository boundary):
 * define immutable one-node workflow → start → exactly one ordinary queued entry turn.
 * Does not open MCP bridge (T06); uses real SQLite worker.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { SqliteTaskRepository } from './repository';
import { canPromoteTurn } from './scheduler';
import { DbClient } from './sqlite/client';
import type { TaskStoreFile } from './types';
import {
  deriveStartIdentities,
  fingerprintStartWorkflow,
  makeOneNodeDefinition,
  startWorkflowLedgerKey,
  validateStartWorkflow,
} from './workflow';

const TOPOLOGY = {
  kind: 'one_node_v1' as const,
  nodes: [{ nodeId: 'entry' }],
  entryNodeId: 'entry',
};

async function openRepo(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m018-s01-${label}-`));
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  await client.open(path.join(dir, 'muster.sqlite3'));
  const repository = new SqliteTaskRepository(client, 'ws');
  return {
    dir,
    client,
    repository,
    async close() {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('M018 S01 one-node workflow activation', () => {
  it('domain validates start input and derives stable activation identities', () => {
    const def = makeOneNodeDefinition();
    const valid = validateStartWorkflow({
      definitionId: def.definitionId,
      version: def.version,
      startIdempotencyKey: 'start-key-1',
      createdAt: '2026-07-19T00:00:00.000Z',
      entryNodeId: def.topology.entryNodeId,
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const ids = deriveStartIdentities({
      definitionId: def.definitionId,
      version: def.version,
      startIdempotencyKey: 'start-key-1',
      entryNodeId: def.topology.entryNodeId,
    });
    expect(ids.runId).toMatch(/^wfr_/);
    expect(ids.activationTurnId).toMatch(/^wftn_/);
    expect(ids.entryTaskId).toMatch(/^wft_/);
    expect(startWorkflowLedgerKey('start-key-1')).toBe('start_workflow:start-key-1');
    expect(
      fingerprintStartWorkflow({
        definitionId: def.definitionId,
        version: def.version,
        startIdempotencyKey: 'start-key-1',
        entryNodeId: 'entry',
        goal: 'one-node',
        backend: 'grok',
      }),
    ).toEqual(expect.any(String));
    expect(
      validateStartWorkflow({
        definitionId: '',
        version: 1,
        startIdempotencyKey: 'k',
        createdAt: '2026-07-19T00:00:00.000Z',
        entryNodeId: 'entry',
      }).ok,
    ).toBe(false);
    expect(
      validateStartWorkflow({
        definitionId: 'wf',
        version: 1,
        startIdempotencyKey: '',
        createdAt: '2026-07-19T00:00:00.000Z',
        entryNodeId: 'entry',
      }).ok,
    ).toBe(false);
  });

  it('define + start produces exactly one durable satisfied entry activation turn', async () => {
    const ctx = await openRepo('start');
    try {
      const createdAt = '2026-07-19T00:00:00.000Z';
      const defined = await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology: TOPOLOGY,
        createdAt,
      });
      expect(defined.ok).toBe(true);
      expect(defined.changed).toBe(true);

      const start = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'idem-entry-1',
        createdAt,
        goal: 'run one-node',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      expect(start.changed).toBe(true);
      const payload = start.operation?.result?.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
        entryGateId: string;
        entryGateStatus: string;
        entryMessageId: string;
      };
      expect(payload).toMatchObject({
        entryGateStatus: 'satisfied',
        definitionId: 'wf-one',
        version: 1,
      });
      expect(payload.runId).toBeTruthy();
      expect(payload.activationTurnId).toBeTruthy();

      const runs = await ctx.client.all(
        'SELECT run_id, status, definition_id, definition_version FROM workflow_runs WHERE workspace_id = ?',
        ['ws'],
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        run_id: payload.runId,
        status: 'running',
        definition_id: 'wf-one',
        definition_version: 1,
      });

      const gates = await ctx.client.all(
        'SELECT gate_id, consumer_node_id, status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ?',
        ['ws', payload.runId],
      );
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({
        gate_id: payload.entryGateId,
        consumer_node_id: 'entry',
        status: 'satisfied',
      });

      const nodes = await ctx.client.all(
        'SELECT node_id, task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ?',
        ['ws', payload.runId],
      );
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({
        node_id: 'entry',
        task_id: payload.entryTaskId,
        status: 'active',
      });

      const task = await ctx.repository.getTask(payload.entryTaskId);
      expect(task).toMatchObject({
        id: payload.entryTaskId,
        parentId: null,
        lifecycle: 'open',
        releaseState: 'released',
        backend: 'grok',
      });

      const turns = await ctx.repository.listTurns(payload.entryTaskId);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        id: payload.activationTurnId,
        status: 'queued',
        trigger: 'engine',
        sequence: 1,
      });
      expect(turns[0]!.inputs).toEqual([
        { kind: 'message', messageId: payload.entryMessageId },
      ]);

      const queued = await ctx.repository.listQueuedTurns(payload.entryTaskId);
      expect(queued).toHaveLength(1);

      const file: TaskStoreFile = {
        schemaVersion: 2,
        revision: 1,
        tasks: { [task!.id]: task! },
        turns: { [turns[0]!.id]: turns[0]! },
        messages: {},
      };
      expect(canPromoteTurn(file, payload.activationTurnId, DEFAULT_RESOURCE_LIMITS)).toEqual({
        ok: true,
      });

      // Idempotent replay: same key, no second turn/run.
      const replay = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'idem-entry-1',
        createdAt: '2099-01-01T00:00:00.000Z',
        goal: 'run one-node',
        backend: 'grok',
      });
      expect(replay.ok).toBe(true);
      expect(replay.changed).toBe(false);
      expect(replay.operation?.result?.data).toMatchObject({
        runId: payload.runId,
        activationTurnId: payload.activationTurnId,
        replay: true,
      });
      expect(
        await ctx.client.all('SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws']),
      ).toHaveLength(1);
      expect(await ctx.repository.listTurns(payload.entryTaskId)).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('fails closed without partial rows when definition is missing or start key conflicts', async () => {
    const ctx = await openRepo('fail');
    try {
      const createdAt = '2026-07-19T00:00:00.000Z';
      const missing = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-missing',
        version: 1,
        startIdempotencyKey: 'idem-missing',
        createdAt,
      });
      expect(missing.ok).toBe(false);
      expect(missing.conflict).toBe(true);
      expect(missing.reason).toMatch(/definition not found/i);
      expect(
        await ctx.client.all('SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws']),
      ).toHaveLength(0);
      expect(
        await ctx.client.all('SELECT id FROM tasks WHERE workspace_id = ?', ['ws']),
      ).toHaveLength(0);

      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-a',
        version: 1,
        name: 'a',
        topology: TOPOLOGY,
        createdAt,
      });
      await ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-b',
        version: 1,
        name: 'b',
        topology: TOPOLOGY,
        createdAt,
      });
      const first = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-a',
        version: 1,
        startIdempotencyKey: 'shared-key',
        createdAt,
        goal: 'a',
        backend: 'grok',
      });
      expect(first.ok).toBe(true);
      const conflict = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-b',
        version: 1,
        startIdempotencyKey: 'shared-key',
        createdAt,
        goal: 'b',
        backend: 'grok',
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.conflict).toBe(true);
      expect(conflict.reason).toMatch(/fingerprint conflict|start fingerprint conflict/i);
      expect(
        await ctx.client.all('SELECT run_id, definition_id FROM workflow_runs WHERE workspace_id = ?', [
          'ws',
        ]),
      ).toEqual([expect.objectContaining({ definition_id: 'wf-a' })]);
    } finally {
      await ctx.close();
    }
  }, 30_000);
});
