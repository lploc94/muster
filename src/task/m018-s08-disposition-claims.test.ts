import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask, TaskTurn, TurnDisposition } from './types';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const clients: DbClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeClient(): DbClient {
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  return client;
}

function makeTask(): MusterTask {
  return {
    id: 'task',
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'released',
    goal: 'disposition race',
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    runtimeEpoch: 1,
    revision: 0,
    createdAt: '2026-07-22T02:00:00.000Z',
    updatedAt: '2026-07-22T02:00:00.000Z',
  };
}

function makeTurn(id: string, sequence: number): TaskTurn {
  return {
    id,
    taskId: 'task',
    sequence,
    status: 'running',
    trigger: 'engine',
    runtimeEpoch: 1,
    inputs: [],
    createdAt: '2026-07-22T02:00:01.000Z',
    startedAt: '2026-07-22T02:00:02.000Z',
  };
}

async function stage(
  repository: SqliteTaskRepository,
  turn: TaskTurn,
  opId: string,
  disposition: TurnDisposition,
) {
  return repository.execute({
    kind: 'stageDisposition',
    workspaceId: 'ws',
    turnId: turn.id,
    opId,
    turn: { ...turn, disposition },
    expectedStatuses: ['running'],
    expectedRuntimeEpoch: 1,
  });
}

describe('M018 universal durable disposition claims', () => {
  it('cross-family disposition races have exactly one winner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = makeClient();
    const secondClient = makeClient();
    await firstClient.open(dbPath);
    await secondClient.open(dbPath);
    await firstClient.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const first = new SqliteTaskRepository(firstClient, 'ws');
    const second = new SqliteTaskRepository(secondClient, 'ws');
    await first.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask() });
    const turn = makeTurn('turn-race', 1);
    await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn });

    const results = await Promise.all([
      stage(first, turn, 'op-complete', { kind: 'complete', result: 'done' }),
      stage(second, turn, 'op-next', { kind: 'workflow_next', change: 'updated', result: 'next' }),
    ]);
    expect(results.filter((result) => result.changed === true)).toHaveLength(1);
    expect(results.filter((result) => result.conflict === true)).toHaveLength(1);

    const claims = await firstClient.all<{
      op_id: string;
      family: string;
      kind: string;
      status: string;
    }>(
      `SELECT op_id, family, kind, status
         FROM turn_disposition_claims
        WHERE workspace_id = 'ws' AND turn_id = 'turn-race'`,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).toBe('staged');
    expect([
      { op_id: 'op-complete', family: 'ordinary', kind: 'complete', status: 'staged' },
      { op_id: 'op-next', family: 'workflow', kind: 'next', status: 'staged' },
    ]).toContainEqual(claims[0]);

    await first.execute({
      kind: 'settleTurn',
      workspaceId: 'ws',
      turnId: turn.id,
      status: 'failed',
      finishedAt: '2026-07-22T02:00:03.000Z',
      error: 'adapter failed',
    });
    await expect(
      firstClient.get<{ status: string }>(
        `SELECT status FROM turn_disposition_claims WHERE workspace_id = 'ws' AND turn_id = ?`,
        [turn.id],
      ),
    ).resolves.toMatchObject({ status: 'discarded' });
  });

  it('same canonical disposition replays across operation ids and successful settlement consumes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s08-replay-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = makeClient();
    const secondClient = makeClient();
    await firstClient.open(dbPath);
    await secondClient.open(dbPath);
    await firstClient.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const first = new SqliteTaskRepository(firstClient, 'ws');
    const second = new SqliteTaskRepository(secondClient, 'ws');
    await first.execute({ kind: 'createTask', workspaceId: 'ws', task: makeTask() });
    const turn = makeTurn('turn-replay', 1);
    await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn });

    const disposition = { kind: 'complete' as const, result: 'same' };
    const results = await Promise.all([
      stage(first, turn, 'op-a', disposition),
      stage(second, turn, 'op-b', disposition),
    ]);
    expect(results.filter((result) => result.changed === true)).toHaveLength(1);
    expect(results.every((result) => result.conflict !== true)).toBe(true);

    await expect(
      stage(second, turn, 'op-a', { kind: 'fail', error: 'changed' }),
    ).resolves.toMatchObject({ changed: false, conflict: true });

    await first.execute({
      kind: 'settleTurn',
      workspaceId: 'ws',
      turnId: turn.id,
      status: 'succeeded',
      finishedAt: '2026-07-22T02:00:04.000Z',
    });
    await expect(
      firstClient.get<{ status: string }>(
        `SELECT status FROM turn_disposition_claims WHERE workspace_id = 'ws' AND turn_id = ?`,
        [turn.id],
      ),
    ).resolves.toMatchObject({ status: 'consumed' });
  });
});
