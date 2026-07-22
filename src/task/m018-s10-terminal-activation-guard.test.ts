import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { SqliteTaskRepository } from './repository';
import { canPromoteTurn } from './scheduler';
import { DbClient } from './sqlite/client';
import type { EngineProjection, TaskTurn } from './types';

const clients: DbClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('M018 terminal workflow activation guards', () => {
  it('terminal run rejects stale activation but permits later ordinary turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s10-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    clients.push(client);
    await client.open(dbPath);
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-one',
      version: 1,
      name: 'one',
      topology: {
        kind: 'one_node_v1',
        nodes: [{ nodeId: 'entry' }],
        entryNodeId: 'entry',
      },
      createdAt: '2026-07-22T04:00:00.000Z',
    });
    const started = await repository.execute({
      kind: 'startWorkflowRun',
      workspaceId: 'ws',
      definitionId: 'wf-one',
      version: 1,
      startIdempotencyKey: 'terminal-guard',
      createdAt: '2026-07-22T04:00:00.000Z',
      goal: 'guard',
      backend: 'grok',
    });
    const data = started.operation?.result.data as {
      runId: string;
      entryTaskId: string;
      activationTurnId: string;
    };
    const task = await repository.getTask(data.entryTaskId);
    const activationTurn = await repository.getTurn(data.activationTurnId);
    expect(task).toBeTruthy();
    expect(activationTurn?.workflowActivation).toMatchObject({
      runId: data.runId,
      runStatus: 'running',
      activationStatus: 'queued',
    });

    await client.transaction([
      {
        sql: `UPDATE turns SET status = 'cancelled', settled_at = ?
              WHERE workspace_id = 'ws' AND id = ?`,
        params: ['2026-07-22T04:00:01.000Z', data.activationTurnId],
      },
      {
        sql: `UPDATE workflow_activations SET status = 'failed', updated_at = ?
              WHERE workspace_id = 'ws' AND execution_turn_id = ?`,
        params: ['2026-07-22T04:00:01.000Z', data.activationTurnId],
      },
      {
        sql: `UPDATE workflow_runs SET status = 'failed', updated_at = ?
              WHERE workspace_id = 'ws' AND run_id = ?`,
        params: ['2026-07-22T04:00:01.000Z', data.runId],
      },
    ]);
    const stale = await repository.getTurn(data.activationTurnId);
    const staleProjection: EngineProjection = {
      schemaVersion: 2,
      revision: 1,
      tasks: { [task!.id]: task! },
      turns: { [stale!.id]: stale! },
      messages: {},
    };
    expect(canPromoteTurn(staleProjection, stale!.id, DEFAULT_RESOURCE_LIMITS)).toEqual({
      ok: false,
      reason: 'turn is not queued',
    });
    await expect(repository.execute({
      kind: 'claimTurn',
      workspaceId: 'ws',
      turnId: stale!.id,
      startedAt: '2026-07-22T04:00:02.000Z',
      rootTaskId: task!.id,
      maxConcurrentTurns: 10,
      maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: false, reason: 'turn is no longer eligible' });

    const ordinary: TaskTurn = {
      id: 'ordinary-turn',
      taskId: task!.id,
      sequence: 2,
      status: 'queued',
      trigger: 'user',
      runtimeEpoch: task!.runtimeEpoch ?? 1,
      inputs: [],
      createdAt: '2026-07-22T04:00:04.000Z',
    };
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: ordinary });
    const reloadedTask = await repository.getTask(task!.id);
    const reloadedOrdinary = await repository.getTurn(ordinary.id);
    expect(reloadedOrdinary?.workflowActivation).toBeUndefined();
    const ordinaryProjection: EngineProjection = {
      schemaVersion: 2,
      revision: 2,
      tasks: { [task!.id]: reloadedTask! },
      turns: { [ordinary.id]: reloadedOrdinary! },
      messages: {},
    };
    expect(canPromoteTurn(ordinaryProjection, ordinary.id, DEFAULT_RESOURCE_LIMITS)).toEqual({ ok: true });
    await expect(repository.execute({
      kind: 'claimTurn',
      workspaceId: 'ws',
      turnId: ordinary.id,
      startedAt: '2026-07-22T04:00:05.000Z',
      rootTaskId: task!.id,
      maxConcurrentTurns: 10,
      maxConcurrentPerRoot: 10,
      maxConcurrentPerBackend: 10,
      resourceKeys: [],
    })).resolves.toMatchObject({ changed: true });
  });
});
