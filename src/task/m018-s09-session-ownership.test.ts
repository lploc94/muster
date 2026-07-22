import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { DbClient } from './sqlite/client';
import type { MusterTask, TaskTurn } from './types';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const clients: DbClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function client(): DbClient {
  const value = new DbClient({ workerPath: WORKER_TS, execArgv: ['--import', 'tsx'] });
  clients.push(value);
  return value;
}

function task(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'released',
    goal: id,
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    runtimeEpoch: 1,
    revision: 0,
    createdAt: '2026-07-22T03:00:00.000Z',
    updatedAt: '2026-07-22T03:00:00.000Z',
  };
}

function turn(taskId: string): TaskTurn {
  return {
    id: `turn-${taskId}`,
    taskId,
    sequence: 1,
    status: 'running',
    trigger: 'engine',
    runtimeEpoch: 1,
    inputs: [],
    createdAt: '2026-07-22T03:00:01.000Z',
    startedAt: '2026-07-22T03:00:02.000Z',
  };
}

async function settleWithSession(
  repository: SqliteTaskRepository,
  taskId: string,
  sessionId: string,
) {
  const currentTask = await repository.getTask(taskId);
  const currentTurn = await repository.getTurn(`turn-${taskId}`);
  if (!currentTask || !currentTurn) throw new Error('fixture missing');
  const disposition = { kind: 'complete' as const, result: 'done' };
  await stageDispositionForSettlement(repository, currentTurn, disposition);
  return repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: 'ws',
    expectedTaskRevision: currentTask.revision,
    task: {
      ...currentTask,
      committedSessionId: sessionId,
      updatedAt: '2026-07-22T03:00:03.000Z',
    },
    turn: {
      ...currentTurn,
      status: 'succeeded',
      finishedAt: '2026-07-22T03:00:03.000Z',
      disposition,
    },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  });
}

describe('M018 relational backend session ownership', () => {
  it('duplicate backend session ownership rejected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s09-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const firstClient = client();
    const secondClient = client();
    await firstClient.open(dbPath);
    await secondClient.open(dbPath);
    await firstClient.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const first = new SqliteTaskRepository(firstClient, 'ws');
    const second = new SqliteTaskRepository(secondClient, 'ws');
    for (const taskId of ['task-a', 'task-b']) {
      await first.execute({ kind: 'createTask', workspaceId: 'ws', task: task(taskId) });
      await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn: turn(taskId) });
    }

    const results = await Promise.all([
      settleWithSession(first, 'task-a', 'shared-session'),
      settleWithSession(second, 'task-b', 'shared-session'),
    ]);
    expect(results.filter((result) => result.changed === true)).toHaveLength(1);
    expect(results.filter((result) => result.conflict === true)).toHaveLength(1);

    const owners = await firstClient.all<{
      task_id: string;
      backend: string;
      session_id: string;
    }>(
      `SELECT task_id, backend, session_id FROM session_owners WHERE workspace_id = 'ws'`,
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ backend: 'grok', session_id: 'shared-session' });
    const winner = owners[0]!.task_id;
    const loser = winner === 'task-a' ? 'task-b' : 'task-a';
    await expect(first.getTask(winner)).resolves.toMatchObject({
      committedSessionId: 'shared-session',
      runtimeEpoch: 1,
    });
    await expect(first.getTask(loser)).resolves.not.toHaveProperty('committedSessionId');
    await expect(first.getTurn(`turn-${loser}`)).resolves.toMatchObject({ status: 'running' });
  });

  it('session binding owner epoch and projection remain consistent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m018-s09-projection-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const db = client();
    await db.open(dbPath);
    await db.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES ('ws', 'identity', 'Workspace', 'now', 'now')`,
    );
    const repository = new SqliteTaskRepository(db, 'ws');
    await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: task('task-a') });
    await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: turn('task-a') });
    await expect(settleWithSession(repository, 'task-a', 'session-a')).resolves.toMatchObject({ changed: true });

    const reloaded = new SqliteTaskRepository(db, 'ws');
    await expect(reloaded.getTask('task-a')).resolves.toMatchObject({
      backend: 'grok',
      runtimeEpoch: 1,
      committedSessionId: 'session-a',
    });
    expect(
      await db.get(
        `SELECT owner.task_id, binding.runtime_epoch, binding.active
           FROM session_owners owner
           JOIN task_session_bindings binding
             ON binding.workspace_id = owner.workspace_id
            AND binding.backend = owner.backend
            AND binding.session_id = owner.session_id
            AND binding.task_id = owner.task_id
          WHERE owner.workspace_id = 'ws' AND owner.session_id = 'session-a'`,
      ),
    ).toMatchObject({ task_id: 'task-a', runtime_epoch: 1, active: 1 });

    await db.run(
      `UPDATE tasks
          SET payload_json = json_set(payload_json, '$.committedSessionId', 'foreign-session')
        WHERE workspace_id = 'ws' AND id = 'task-a'`,
    );
    await expect(reloaded.getTask('task-a')).rejects.toThrow(/session binding mismatch/i);
  });
});
