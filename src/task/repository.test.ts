import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonTaskRepository, SqliteTaskRepository } from './repository';
import { TaskStore } from './store';
import type { MusterTask, TaskStoreFile } from './types';
import { DbClient } from './sqlite/client';

function makeTask(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    goal: id,
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

function makeStore(filePath: string): TaskStore {
  const store = TaskStore.load({ filePath });
  store.commit((draft: TaskStoreFile) => {
    draft.tasks.a = makeTask('a');
    draft.turns.t2 = {
      id: 't2', taskId: 'a', sequence: 2, status: 'succeeded', trigger: 'user',
      inputs: [], createdAt: '2026-07-16T00:00:02.000Z',
    };
    draft.turns.t1 = {
      id: 't1', taskId: 'a', sequence: 1, status: 'queued', trigger: 'user',
      inputs: [], createdAt: '2026-07-16T00:00:01.000Z',
    };
    draft.messages.m = {
      id: 'm', taskId: 'a', role: 'user', content: 'hello', state: 'pending',
      createdAt: '2026-07-16T00:00:03.000Z',
    };
    return { ok: true };
  });
  return store;
}

describe('JsonTaskRepository', () => {
  it('queries cloned, ordered DTOs without exposing the store envelope', async () => {
    const path = `/tmp/muster-repository-${Date.now()}-${Math.random()}.json`;
    const store = makeStore(path);
    try {
      const repository = new JsonTaskRepository(store, 'ws');
      expect((await repository.listTasks('ws')).map((task) => task.id)).toEqual(['a']);
      expect((await repository.listTurns('a')).map((turn) => turn.id)).toEqual(['t1', 't2']);
      const task = await repository.getTask('a');
      task!.goal = 'mutated outside repository';
      expect(store.getFile().tasks.a.goal).toBe('a');
    } finally {
      try { fs.unlinkSync(path); } catch { /* test cleanup */ }
    }
  });

  it('supports scheduler-oriented root, subtree, and queued-turn queries', async () => {
    const filePath = `/tmp/muster-repository-${Date.now()}-${Math.random()}.json`;
    const store = makeStore(filePath);
    try {
      store.commit((draft: TaskStoreFile) => {
        const child = makeTask('child');
        child.parentId = 'a';
        draft.tasks.child = child;
        draft.turns.queued = {
          id: 'queued', taskId: 'a', sequence: 3, status: 'queued', trigger: 'engine',
          inputs: [], createdAt: '2026-07-16T00:00:04.000Z',
        };
        return { ok: true };
      });
      const repository = new JsonTaskRepository(store, 'ws');
      await expect(repository.listRootTasks('ws')).resolves.toMatchObject({ items: [{ id: 'a' }] });
      await expect(repository.listSubtree('a')).resolves.toMatchObject([
        { id: 'a' }, { id: 'child', parentId: 'a' },
      ]);
      await expect(repository.listQueuedTurns('a')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 't1' }),
        expect.objectContaining({ id: 'queued' }),
      ]));
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* test cleanup */ }
    }
  });
});

describe('SqliteTaskRepository', () => {
  it('runs the same named-command and transcript-page contract on JSON and SQLite', async () => {
    const task = makeTask('contract-task');
    const turn = {
      id: 'contract-turn', taskId: task.id, sequence: 1, status: 'queued' as const,
      trigger: 'user' as const, inputs: [{ kind: 'message' as const, messageId: 'contract-user' }],
      createdAt: '2026-07-16T00:00:01.000Z',
    };
    const userMessage = {
      id: 'contract-user', taskId: task.id, role: 'user' as const, content: 'hello',
      state: 'complete' as const, createdAt: '2026-07-16T00:00:02.000Z',
    };
    const assistantMessage = {
      id: 'contract-assistant', taskId: task.id, turnId: turn.id, role: 'assistant' as const,
      content: 'world', state: 'complete' as const, createdAt: '2026-07-16T00:00:03.000Z', order: 0,
    };
    const jsonPath = `/tmp/muster-repository-contract-${Date.now()}-${Math.random()}.json`;
    const jsonStore = TaskStore.load({ filePath: jsonPath });
    const json = new JsonTaskRepository(jsonStore, 'ws');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-contract-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'contract-identity', 'Contract', 'now', 'now'],
      );
      const sqlite = new SqliteTaskRepository(client, 'ws');
      for (const repository of [json, sqlite]) {
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
        await repository.execute({ kind: 'appendMessage', workspaceId: 'ws', message: userMessage });
        await repository.execute({ kind: 'appendMessage', workspaceId: 'ws', message: assistantMessage });
        await expect(repository.execute({
          kind: 'promoteTurn', workspaceId: 'ws', turnId: turn.id,
          startedAt: '2026-07-16T00:00:02.500Z',
        })).resolves.toMatchObject({ ok: true, changed: true });
        await expect(repository.execute({
          kind: 'settleTurn', workspaceId: 'ws', turnId: turn.id, status: 'succeeded',
          finishedAt: '2026-07-16T00:00:04.000Z',
        })).resolves.toMatchObject({ ok: true, changed: true });
        await expect(repository.getTask(task.id)).resolves.toMatchObject({ id: task.id, goal: task.goal });
        await expect(repository.listTurns(task.id)).resolves.toMatchObject([{
          id: turn.id, status: 'succeeded', startedAt: '2026-07-16T00:00:02.500Z',
          finishedAt: '2026-07-16T00:00:04.000Z',
        }]);
        await expect(repository.listMessages(task.id)).resolves.toHaveLength(2);
        const latest = await repository.getTranscriptPage(task.id, undefined, 1);
        expect(latest.items.map((item) => item.id)).toEqual(['contract-assistant']);
        expect(latest.hasMoreBefore).toBe(true);
        const older = await repository.getTranscriptPage(task.id, latest.beforeCursor, 1);
        expect(older.items.map((item) => item.id)).toEqual(['contract-user']);
        expect(older.hasMoreBefore).toBe(false);
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
      try { fs.unlinkSync(jsonPath); } catch { /* test cleanup */ }
    }
  }, 20_000);

  it('hydrates domain DTOs from promoted columns and compatibility payloads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-sqlite-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(dbPath);
      const task = makeTask('task-1');
      task.goal = 'payload goal (stale)';
      task.model = 'payload-model';
      const turn = {
        id: 'turn-1', taskId: 'task-1', sequence: 1, status: 'succeeded' as const,
        trigger: 'user' as const, inputs: [], createdAt: '2026-07-16T00:00:01.000Z',
      };
      const message = {
        id: 'message-1', taskId: 'task-1', role: 'assistant' as const,
        content: 'payload content (stale)', state: 'complete' as const,
        createdAt: '2026-07-16T00:00:02.000Z',
      };
      await client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-1', 'identity-1', 'Workspace', 'now', 'now'],
        },
        {
          sql: `INSERT INTO tasks
                (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
                 revision, created_at, updated_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'task-1', 'ws-1', null, 'worker', 'succeeded', 'released', 'column goal', 'codex',
            'column-model', 4, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:03.000Z',
            JSON.stringify(task),
          ],
        },
        {
          sql: `INSERT INTO turns
                (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'turn-1', 'ws-1', 'task-1', 1, 'succeeded', 'user', turn.createdAt, null,
            '2026-07-16T00:00:02.000Z', JSON.stringify(turn),
          ],
        },
        {
          sql: `INSERT INTO messages
                (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'message-1', 'ws-1', 'task-1', 'turn-1', 'assistant', 'complete', 7,
            'column content', message.createdAt, null, JSON.stringify(message),
          ],
        },
        {
          sql: `INSERT INTO turns
                (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'turn-queued', 'ws-1', 'task-1', 2, 'queued', 'engine', '2026-07-16T00:00:04.000Z',
            null, null, JSON.stringify({
              id: 'turn-queued', taskId: 'task-1', sequence: 2, status: 'queued', trigger: 'engine',
              inputs: [], createdAt: '2026-07-16T00:00:04.000Z',
            }),
          ],
        },
      ]);

      const repository = new SqliteTaskRepository(client, 'ws-1');
      await expect(repository.getTask('task-1')).resolves.toMatchObject({
        id: 'task-1', goal: 'column goal', backend: 'codex', model: 'column-model',
        lifecycle: 'succeeded', releaseState: 'released', revision: 4,
      });
      await expect(repository.listTurns('task-1')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'turn-1', status: 'succeeded', finishedAt: '2026-07-16T00:00:02.000Z' }),
        expect.objectContaining({ id: 'turn-queued', status: 'queued' }),
      ]));
      await expect(repository.listMessages('task-1')).resolves.toMatchObject([
        { id: 'message-1', content: 'column content', order: 7, turnId: 'turn-1' },
      ]);
      await expect(repository.listRootTasks('ws-1')).resolves.toMatchObject({ items: [{ id: 'task-1' }] });
      await expect(repository.listSubtree('task-1')).resolves.toMatchObject([{ id: 'task-1' }]);
      await expect(repository.listQueuedTurns('task-1')).resolves.toMatchObject([{ id: 'turn-queued' }]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects malformed compatibility payloads instead of returning partial DTOs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-sqlite-invalid-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(dbPath);
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        ['ws-1', 'identity-1', 'Workspace', 'now', 'now'],
      );
      await client.run(
        `INSERT INTO tasks
         (id, workspace_id, parent_id, role, lifecycle, goal, backend, revision, created_at, updated_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ['task-1', 'ws-1', null, 'worker', 'open', 'goal', 'codex', 0, 'now', 'now', JSON.stringify({})],
      );
      const repository = new SqliteTaskRepository(client, 'ws-1');
      await expect(repository.getTask('task-1')).rejects.toThrow(/missing domain payload fields/);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
