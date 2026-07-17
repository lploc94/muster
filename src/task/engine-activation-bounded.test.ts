import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskEngine } from './engine';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask, TaskTurn } from './types';

function makeTask(id: string, overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'released',
    goal: id,
    parentId: null,
    dependencies: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: { maxTurns: 100, maxAutomaticRetries: 2 },
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeTurn(
  id: string,
  taskId: string,
  sequence: number,
  status: TaskTurn['status'],
  overrides: Partial<TaskTurn> = {},
): TaskTurn {
  return {
    id,
    taskId,
    sequence,
    status,
    trigger: 'user',
    inputs: [],
    createdAt: `2026-07-16T00:00:${String(Math.min(sequence, 59)).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

async function withRepo<T>(
  name: string,
  fn: (repo: SqliteTaskRepository, client: DbClient) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-${name}-`));
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  try {
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repo = new SqliteTaskRepository(client, 'ws');
    await repo.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: name,
      displayName: name,
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    return await fn(repo, client);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Bulk-seed N terminal turns for one task (raw SQL). */
async function seedTerminalTurns(client: DbClient, taskId: string, count: number): Promise<void> {
  const BATCH = 250;
  for (let start = 1; start <= count; start += BATCH) {
    const stmts = [];
    for (let i = start; i < start + BATCH && i <= count; i++) {
      const ts = `2026-07-16T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
      stmts.push({
        sql: `INSERT INTO turns (id, workspace_id, task_id, sequence, status, trigger, created_at, settled_at, payload_json)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        params: [
          `term-${i}`,
          'ws',
          taskId,
          i,
          'succeeded',
          'engine',
          ts,
          ts,
          JSON.stringify({ payloadVersion: 1, inputs: [] }),
        ],
      });
    }
    await client.transaction(stmts);
  }
}

function spyFullList(repo: SqliteTaskRepository) {
  return {
    listTurns: vi.spyOn(repo, 'listTurns'),
    listTurnsForTasks: vi.spyOn(repo, 'listTurnsForTasks'),
    listMessages: vi.spyOn(repo, 'listMessages'),
    listToolCalls: vi.spyOn(repo, 'listToolCalls'),
    listReasoning: vi.spyOn(repo, 'listReasoning'),
  };
}

function assertNoFullHistory(spies: ReturnType<typeof spyFullList>): void {
  expect(spies.listTurns).not.toHaveBeenCalled();
  expect(spies.listTurnsForTasks).not.toHaveBeenCalled();
  expect(spies.listMessages).not.toHaveBeenCalled();
  expect(spies.listToolCalls).not.toHaveBeenCalled();
  expect(spies.listReasoning).not.toHaveBeenCalled();
}

describe('TaskEngine.loadAsync — bounded activation (P4-W4 residual)', () => {
  it('orphan live + queued followers: holds queue without full listTurns', async () => {
    await withRepo('activation-orphan', async (repo, client) => {
      const task = makeTask('orphan-task');
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await seedTerminalTurns(client, task.id, 10_000);
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('live-turn', task.id, 10_001, 'running', {
          startedAt: '2026-07-16T02:00:00.000Z',
        }),
      });
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('follow-up', task.id, 10_002, 'queued'),
      });

      const spies = spyFullList(repo);
      await TaskEngine.loadAsync({
        repository: repo,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        clock: () => '2026-07-16T02:00:03.000Z',
      });

      assertNoFullHistory(spies);
      await expect(repo.getTurn('live-turn')).resolves.toMatchObject({
        status: 'interrupted',
        failureClass: 'uncertain',
      });
      await expect(repo.getTurn('follow-up')).resolves.toMatchObject({
        status: 'queued',
        holdAutoPromote: true,
      });
    });
  }, 60_000);

  it('child-wait reconcile: queues continuation without full listTurns', async () => {
    await withRepo('activation-child-wait', async (repo, client) => {
      const waitTurnId = 'wait-turn';
      const parent = makeTask('parent', {
        role: 'coordinator',
        // Cap high enough that 10k history + wait + continuation still fits.
        executionPolicy: { maxTurns: 20_000, maxAutomaticRetries: 0 },
        wait: {
          kind: 'children',
          taskIds: ['child'],
          registeredByTurnId: waitTurnId,
          wakeOn: ['terminal'],
        },
      });
      const child = makeTask('child', {
        parentId: parent.id,
        lifecycle: 'succeeded',
        taskResult: { version: 1, revision: 1, summary: 'done' },
        finishedAt: '2026-07-16T00:00:01.000Z',
      });
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: parent });
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
      await seedTerminalTurns(client, parent.id, 10_000);
      // registering wait turn at sequence 10001
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn(waitTurnId, parent.id, 10_001, 'succeeded', {
          finishedAt: '2026-07-16T00:00:00.500Z',
          trigger: 'engine',
        }),
      });

      const spies = spyFullList(repo);
      await TaskEngine.loadAsync({
        repository: repo,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        runTurn: async function* () {
          yield { type: 'turnCompleted' };
        },
        // Raise hard bound so 10k history + wait continuation can still allocate.
        resourceLimits: {
          maxDepth: 8,
          maxChildrenPerTask: 32,
          maxChildrenPerRoot: 64,
          maxTurnsPerTask: 20_000,
          maxConcurrentTurns: 10,
          maxConcurrentPerRoot: 10,
          maxConcurrentPerBackend: 10,
          maxResultBytes: 64_000,
          maxErrorBytes: 8_000,
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      assertNoFullHistory(spies);
      const continuationId = `${waitTurnId}-continuation`;
      await expect(repo.getTurn(continuationId)).resolves.toMatchObject({
        taskId: parent.id,
        status: 'queued',
        sequence: 10_002,
        inputs: [{ kind: 'child_results', taskIds: [child.id] }],
      });
      expect((await repo.getTask(parent.id))?.wait).toBeUndefined();
    });
  }, 60_000);

  it('safe-retry depth uses countRetryDepth, not full listTurns', async () => {
    await withRepo('activation-safe-retry', async (repo, client) => {
      const task = makeTask('retry-task', {
        executionPolicy: { maxTurns: 100, maxAutomaticRetries: 5 },
      });
      await repo.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await seedTerminalTurns(client, task.id, 10_000);
      // Failed predecessor marked safe_to_retry, then a queued retry of it.
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('failed-1', task.id, 10_001, 'failed', {
          finishedAt: '2026-07-16T01:00:00.000Z',
          failureClass: 'safe_to_retry',
          trigger: 'engine',
        }),
      });
      await repo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: makeTurn('retry-1', task.id, 10_002, 'queued', {
          retryOf: 'failed-1',
          trigger: 'retry',
        }),
      });

      const spies = spyFullList(repo);
      const countRetryDepth = vi.spyOn(repo, 'countRetryDepth');
      await TaskEngine.loadAsync({
        repository: repo,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        isWorkspaceTrusted: () => true,
        clock: () => '2026-07-16T01:00:01.000Z',
      });

      assertNoFullHistory(spies);
      expect(countRetryDepth).toHaveBeenCalled();
      // Depth of retry-1 is 1 (one predecessor).
      await expect(repo.countRetryDepth('retry-1')).resolves.toBe(1);
    });
  }, 60_000);
});
