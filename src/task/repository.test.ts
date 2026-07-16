import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonTaskRepository, SqliteTaskRepository, type TaskRepository } from './repository';
import { TaskStore } from './store';
import type { MusterTask, OperationLedgerEntry, TaskStoreFile } from './types';
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
  it('keeps host history commands atomic and parity-compatible across adapters', async () => {
    const jsonPath = `/tmp/muster-repository-history-${Date.now()}-${Math.random()}.json`;
    const jsonStore = TaskStore.load({ filePath: jsonPath });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-history-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repositories: TaskRepository[] = [
        new JsonTaskRepository(jsonStore, 'ws'),
        new SqliteTaskRepository(client, 'ws'),
      ];
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'history-identity', 'History', 'now', 'now'],
      );
      for (const [index, repository] of repositories.entries()) {
        const root = makeTask(`history-root-${index}`);
        const child = makeTask(`history-child-${index}`);
        child.parentId = root.id;
        const active = makeTask(`history-active-${index}`);
        const queued = makeTask(`history-queued-${index}`);
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: active });
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: queued });
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: { id: `active-turn-${index}`, taskId: active.id, sequence: 1, status: 'running', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:01.000Z' },
        });
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: { id: `queued-turn-${index}`, taskId: queued.id, sequence: 1, status: 'queued', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:02.000Z' },
        });

        await expect(repository.execute({
          kind: 'renameTask', workspaceId: 'ws', taskId: root.id, goal: 'renamed',
          expectedTaskRevision: 0, updatedAt: '2026-07-16T00:00:03.000Z',
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.getTask(root.id)).resolves.toMatchObject({ goal: 'renamed', revision: 1 });
        await expect(repository.execute({
          kind: 'renameTask', workspaceId: 'ws', taskId: root.id, goal: 'stale',
          expectedTaskRevision: 0, updatedAt: '2026-07-16T00:00:04.000Z',
        })).resolves.toMatchObject({ changed: false });

        await expect(repository.execute({
          kind: 'deleteTaskSubtreeIfIdle', workspaceId: 'ws', rootTaskId: queued.id,
        })).resolves.toMatchObject({ changed: false });
        await expect(repository.getTask(queued.id)).resolves.toBeDefined();

        await expect(repository.execute({
          kind: 'clearHistory', workspaceId: 'ws', preserveRootTaskId: active.id,
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.getTask(root.id)).resolves.toBeUndefined();
        await expect(repository.getTask(child.id)).resolves.toBeUndefined();
        await expect(repository.getTask(active.id)).resolves.toBeDefined();
        await expect(repository.getTask(queued.id)).resolves.toBeDefined();
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
      try { fs.unlinkSync(jsonPath); } catch { /* test cleanup */ }
    }
  }, 20_000);

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
        await expect(repository.execute({
          kind: 'createRootAndInitialTurn', workspaceId: 'ws', task, message: userMessage, turn,
          receipt: {
            clientRequestId: 'contract-initial-send', fingerprint: 'initial-send', taskId: task.id,
            messageId: userMessage.id, turnId: turn.id, createdAt: '2026-07-16T00:00:02.000Z',
          },
        })).resolves.toMatchObject({ ok: true, changed: true });
        await repository.execute({ kind: 'appendMessage', workspaceId: 'ws', message: assistantMessage });
        await expect(repository.execute({
          kind: 'prepareDispatch', workspaceId: 'ws', expectedTaskRevision: task.revision,
          task,
          turn: {
            ...turn,
            status: 'running',
            startedAt: '2026-07-16T00:00:02.500Z',
            dispatchPhase: 'pre_dispatch',
          },
          messages: [],
          startedAt: '2026-07-16T00:00:02.500Z',
          rootTaskId: task.id,
          maxConcurrentTurns: 10,
          maxConcurrentPerRoot: 10,
          maxConcurrentPerBackend: 10,
          resourceKeys: [],
        })).resolves.toMatchObject({ ok: true, changed: true });
        await expect(repository.execute({
          kind: 'settleTurnAndApplyEffects', workspaceId: 'ws', expectedTaskRevision: task.revision,
          task,
          turn: {
            ...turn,
            status: 'succeeded',
            startedAt: '2026-07-16T00:00:02.500Z',
            finishedAt: '2026-07-16T00:00:04.000Z',
            dispatchPhase: 'terminal_received',
          },
          expectedStatuses: ['running'],
          relatedTurns: [],
          messages: [],
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

        const operation: OperationLedgerEntry = {
          fingerprint: 'contract-operation', result: { ok: true, data: { turnId: turn.id } },
        };
        await expect(repository.execute({
          kind: 'claimOperation', workspaceId: 'ws', ledgerKey: `${turn.id}:operation`, entry: operation,
          createdAt: '2026-07-16T00:00:05.000Z',
        })).resolves.toMatchObject({ changed: true, operation });
        await expect(repository.execute({
          kind: 'claimOperation', workspaceId: 'ws', ledgerKey: `${turn.id}:operation`, entry: operation,
          createdAt: '2026-07-16T00:00:06.000Z',
        })).resolves.toMatchObject({ changed: false, operation });
        await repository.execute({
          kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id,
          toolCalls: [{
            id: `${turn.id}:tool`, taskId: task.id, turnId: turn.id, toolCallId: 'tool', order: 1,
            name: 'tool', status: 'success', output: 'done',
            createdAt: '2026-07-16T00:00:05.000Z', updatedAt: '2026-07-16T00:00:05.000Z',
          }],
          reasoning: [{
            id: `${turn.id}:reasoning`, taskId: task.id, turnId: turn.id, content: 'think',
            createdAt: '2026-07-16T00:00:05.000Z', updatedAt: '2026-07-16T00:00:05.000Z',
          }],
        });
        await repository.execute({
          kind: 'putCancelRequest', workspaceId: 'ws', turnId: turn.id,
          request: { kind: 'interrupt', by: 'user', opId: 'cancel', at: '2026-07-16T00:00:05.000Z' },
        });
        await repository.execute({
          kind: 'putSendReceipt', workspaceId: 'ws',
          receipt: { clientRequestId: `${turn.id}:send`, fingerprint: 'send', taskId: task.id, messageId: userMessage.id, turnId: turn.id, createdAt: '2026-07-16T00:00:05.000Z' },
        });
        await expect(repository.listToolCalls(task.id)).resolves.toMatchObject([{ id: `${turn.id}:tool` }]);
        await expect(repository.listReasoning(task.id)).resolves.toMatchObject([{ id: `${turn.id}:reasoning` }]);
        await expect(repository.getOperation(`${turn.id}:operation`)).resolves.toEqual(operation);
        await expect(repository.getCancelRequest(turn.id)).resolves.toMatchObject({ opId: 'cancel' });
        await expect(repository.getSendReceipt('contract-initial-send')).resolves.toMatchObject({
          taskId: task.id, messageId: userMessage.id, turnId: turn.id,
        });
        await expect(repository.getSendReceipt(`${turn.id}:send`)).resolves.toMatchObject({ turnId: turn.id });
        const exported = await repository.readEnvelopeForMigration();
        expect(exported.toolCalls?.[`${turn.id}:tool`]).toMatchObject({ output: 'done' });
        expect(exported.reasoning?.[`${turn.id}:reasoning`]).toMatchObject({ content: 'think' });
        await expect(repository.execute({ kind: 'applyRetentionPolicy', workspaceId: 'ws', taskId: task.id, keepLatestTurns: 1 })).resolves.toMatchObject({ changed: false });
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
      try { fs.unlinkSync(jsonPath); } catch { /* test cleanup */ }
    }
  }, 20_000);

  it('atomically enqueues a message turn with revision and turn-cap guards in both adapters', async () => {
    const jsonPath = `/tmp/muster-repository-enqueue-${Date.now()}-${Math.random()}.json`;
    const jsonStore = TaskStore.load({ filePath: jsonPath });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-enqueue-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'enqueue-identity', 'Enqueue', 'now', 'now'],
      );
      const repositories = [
        new JsonTaskRepository(jsonStore, 'ws'),
        new SqliteTaskRepository(client, 'ws'),
      ];
      for (const [index, repository] of repositories.entries()) {
        const task = makeTask(`enqueue-task-${index}`);
        task.releaseState = 'released';
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        const message = {
          id: `enqueue-message-${index}`, taskId: task.id, role: 'user' as const,
          content: 'follow up', state: 'pending' as const, createdAt: '2026-07-16T00:00:01.000Z',
        };
        const turn = {
          id: `enqueue-turn-${index}`, taskId: task.id, sequence: 1, trigger: 'user' as const,
          status: 'queued' as const, inputs: [{ kind: 'message' as const, messageId: message.id }],
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        await expect(repository.execute({
          kind: 'enqueueMessageTurn', workspaceId: 'ws', expectedTaskRevision: task.revision,
          maxTurnsPerTask: 10, task, message, turn,
          receipt: {
            clientRequestId: `enqueue-receipt-${index}`, fingerprint: 'enqueue', taskId: task.id,
            messageId: message.id, turnId: turn.id, createdAt: turn.createdAt,
          },
        })).resolves.toMatchObject({ ok: true, changed: true });
        await expect(repository.listTurns(task.id)).resolves.toMatchObject([{ id: turn.id }]);
        await expect(repository.listMessages(task.id)).resolves.toMatchObject([{ id: message.id }]);
        await expect(repository.getSendReceipt(`enqueue-receipt-${index}`)).resolves.toMatchObject({
          turnId: turn.id,
        });

        const staleMessage = { ...message, id: `stale-message-${index}` };
        const staleTurn = {
          ...turn,
          id: `stale-turn-${index}`,
          sequence: 2,
          inputs: [{ kind: 'message' as const, messageId: staleMessage.id }],
        };
        await expect(repository.execute({
          kind: 'enqueueMessageTurn', workspaceId: 'ws', expectedTaskRevision: task.revision + 1,
          maxTurnsPerTask: 10, task, message: staleMessage, turn: staleTurn,
        })).resolves.toMatchObject({ ok: true, changed: false });
        await expect(repository.getTask(task.id)).resolves.toMatchObject({ id: task.id });
        await expect(repository.listMessages(task.id)).resolves.not.toContainEqual(
          expect.objectContaining({ id: staleMessage.id }),
        );
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
      try { fs.unlinkSync(jsonPath); } catch { /* test cleanup */ }
    }
  }, 20_000);

  it('edits, deletes, and resumes only queued message turns in both adapters', async () => {
    const jsonPath = `/tmp/muster-repository-queue-mutations-${Date.now()}-${Math.random()}.json`;
    const json = new JsonTaskRepository(TaskStore.load({ filePath: jsonPath }), 'ws');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-queue-mutations-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'queue-mutations', 'Queue mutations', 'now', 'now'],
      );
      const sqlite = new SqliteTaskRepository(client, 'ws');
      for (const [index, repository] of [json, sqlite].entries()) {
        const task = makeTask(`queue-task-${index}`);
        task.releaseState = 'released';
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        const message = {
          id: `queue-message-${index}`, taskId: task.id, role: 'user' as const, content: 'before',
          agentContent: '/absolute/expanded/path', state: 'pending' as const,
          createdAt: '2026-07-16T00:00:00.000Z',
        };
        const turn = {
          id: `queue-turn-${index}`, taskId: task.id, sequence: 1, trigger: 'user' as const,
          status: 'queued' as const, inputs: [{ kind: 'message' as const, messageId: message.id }],
          createdAt: '2026-07-16T00:00:00.000Z',
        };
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
        await repository.execute({ kind: 'appendMessage', workspaceId: 'ws', message });
        await expect(repository.execute({
          kind: 'editQueuedMessage', workspaceId: 'ws', taskId: task.id, turnId: turn.id, content: 'after',
        })).resolves.toMatchObject({ changed: true, messageId: message.id });
        const editedMessages = await repository.listMessages(task.id);
        expect(editedMessages).toMatchObject([{ id: message.id, content: 'after' }]);
        expect(editedMessages[0]).not.toHaveProperty('agentContent');
        await expect(repository.execute({
          kind: 'deleteQueuedTurnAndMessages', workspaceId: 'ws', taskId: task.id, turnId: turn.id,
        })).resolves.toMatchObject({ changed: true, deletedMessageIds: [message.id] });
        await expect(repository.listTurns(task.id)).resolves.toEqual([]);
        await expect(repository.listMessages(task.id)).resolves.toEqual([]);
        await expect(repository.execute({
          kind: 'editQueuedMessage', workspaceId: 'ws', taskId: task.id, turnId: turn.id, content: 'late',
        })).resolves.toMatchObject({ changed: false });

        const held = {
          id: `queue-held-${index}`, taskId: task.id, sequence: 2, trigger: 'user' as const,
          status: 'queued' as const, holdAutoPromote: true, inputs: [],
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: held });
        await expect(repository.execute({
          kind: 'clearQueuedTurnHold', workspaceId: 'ws', taskId: task.id, turnId: held.id,
        })).resolves.toMatchObject({ changed: true });
        const resumedTurns = await repository.listTurns(task.id);
        expect(resumedTurns).toMatchObject([{ id: held.id }]);
        expect(resumedTurns[0]).not.toHaveProperty('holdAutoPromote');
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
      try { fs.unlinkSync(jsonPath); } catch { /* test cleanup */ }
    }
  }, 20_000);

  it('allocates a retry turn atomically with its task state in both adapters', async () => {
    const jsonPath = `/tmp/muster-repository-retry-${Date.now()}-${Math.random()}.json`;
    const json = new JsonTaskRepository(TaskStore.load({ filePath: jsonPath }), 'ws');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-retry-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'retry-contract', 'Retry contract', 'now', 'now'],
      );
      for (const [index, repository] of [json, new SqliteTaskRepository(client, 'ws')].entries()) {
        const task = makeTask(`retry-task-${index}`);
        task.releaseState = 'released';
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        const oldTurn = {
          id: `retry-old-${index}`, taskId: task.id, sequence: 1, trigger: 'user' as const,
          status: 'failed' as const, inputs: [], createdAt: '2026-07-16T00:00:00.000Z',
          finishedAt: '2026-07-16T00:00:01.000Z',
        };
        const retry = {
          id: `retry-new-${index}`, taskId: task.id, sequence: 2, trigger: 'retry' as const,
          status: 'queued' as const, retryOf: oldTurn.id,
          inputs: [{ kind: 'recovery' as const, interruptedTurnId: oldTurn.id, instruction: 'try again' }],
          createdAt: '2026-07-16T00:00:02.000Z',
        };
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: oldTurn });
        await expect(repository.execute({
          kind: 'retryTurn', workspaceId: 'ws', expectedTaskRevision: task.revision,
          maxTurnsPerTask: 10, task, turn: retry,
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.listTurns(task.id)).resolves.toMatchObject([
          { id: oldTurn.id }, { id: retry.id, retryOf: oldTurn.id },
        ]);
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

  it('persists every TaskStore aggregate as normalized rows and exports a parity envelope', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-parity-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'file:///repo', displayName: 'Repo',
        createdAt: '2026-07-16T00:00:00.000Z', lastOpenedAt: '2026-07-16T00:00:00.000Z',
      });
      await repository.execute({
        kind: 'recordWorkspaceLocation', workspaceId: 'ws', canonicalUri: 'file:///repo',
        firstSeenAt: '2026-07-16T00:00:00.000Z', lastSeenAt: '2026-07-16T00:00:00.000Z',
      });
      await expect(repository.getWorkspace()).resolves.toMatchObject({ identityKey: 'file:///repo' });
      await expect(repository.listWorkspaceLocations()).resolves.toMatchObject([{ canonicalUri: 'file:///repo' }]);
      const producer = makeTask('producer');
      producer.description = 'normalised task payload';
      producer.releaseState = 'released';
      const consumer = makeTask('consumer');
      consumer.dependencies = [{ taskId: producer.id, requiredOutcome: 'succeeded', onUnsatisfied: 'block' }];
      consumer.description = 'consumer payload';
      consumer.releaseState = 'released';
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: producer });
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: consumer });
      const turn = {
        id: 'turn-1', taskId: consumer.id, sequence: 1, status: 'queued' as const, trigger: 'user' as const,
        inputs: [
          { kind: 'message' as const, messageId: 'message-1' },
          { kind: 'recovery' as const, interruptedTurnId: 'old-turn', instruction: 'continue safely' },
        ],
        createdAt: '2026-07-16T00:00:01.000Z',
      };
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
      const message = {
        id: 'message-1', taskId: consumer.id, turnId: turn.id, role: 'assistant' as const,
        content: 'stream fragment', agentContent: 'full stream fragment', state: 'partial' as const,
        order: 0, createdAt: '2026-07-16T00:00:02.000Z',
      };
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: consumer.id,
        messages: [message],
        toolCalls: [{
          id: 'turn-1:tool-1', taskId: consumer.id, turnId: turn.id, toolCallId: 'tool-1', order: 1,
          name: 'read_file', kind: 'builtin', status: 'success', input: { path: 'a.ts' }, output: 'ok',
          createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
        }],
        reasoning: [{
          id: turn.id, taskId: consumer.id, turnId: turn.id, content: 'reasoning',
          createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
        }],
      });
      const batchFeed = await client.all<{ revision: number; n: number }>(
        `SELECT revision, COUNT(*) AS n FROM change_log
          WHERE workspace_id = ? AND entity_kind IN ('message', 'tool_call', 'reasoning')
          GROUP BY revision ORDER BY revision`,
        ['ws'],
      );
      expect(batchFeed).toHaveLength(1);
      expect(batchFeed[0]?.n).toBe(3);
      const operation: OperationLedgerEntry = { fingerprint: 'fp', result: { ok: true, data: { created: true } } };
      await repository.execute({ kind: 'putOperation', workspaceId: 'ws', ledgerKey: 'turn-1:op-1', entry: operation, createdAt: '2026-07-16T00:00:05.000Z' });
      await repository.execute({
        kind: 'putCancelRequest', workspaceId: 'ws', turnId: turn.id,
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-1', at: '2026-07-16T00:00:06.000Z', reason: 'stop' },
      });
      await repository.execute({
        kind: 'putSendReceipt', workspaceId: 'ws',
        receipt: { clientRequestId: 'request-1', fingerprint: 'send-fp', taskId: consumer.id, messageId: message.id, turnId: turn.id, createdAt: '2026-07-16T00:00:07.000Z' },
      });

      const taskRow = await client.get<{ payload_json: string }>('SELECT payload_json FROM tasks WHERE workspace_id = ? AND id = ?', ['ws', consumer.id]);
      const turnRow = await client.get<{ payload_json: string }>('SELECT payload_json FROM turns WHERE workspace_id = ? AND id = ?', ['ws', turn.id]);
      expect(taskRow?.payload_json).not.toContain('"dependencies"');
      expect(taskRow?.payload_json).not.toContain('"goal"');
      expect(turnRow?.payload_json).not.toContain('"inputs"');
      expect(await client.all('SELECT * FROM turn_inputs WHERE workspace_id = ? AND turn_id = ?', ['ws', turn.id])).toHaveLength(2);

      const envelope = await repository.readEnvelopeForMigration();
      expect(envelope.tasks.consumer).toMatchObject({ dependencies: consumer.dependencies, description: consumer.description });
      expect(envelope.turns[turn.id]).toMatchObject({ inputs: turn.inputs });
      expect(envelope.messages[message.id]).toMatchObject({ agentContent: message.agentContent });
      expect(envelope.toolCalls?.['turn-1:tool-1']).toMatchObject({ output: 'ok' });
      expect(envelope.reasoning?.[turn.id]).toMatchObject({ content: 'reasoning' });
      expect(envelope.operations?.['turn-1:op-1']).toEqual(operation);
      expect(envelope.cancelRequests?.[turn.id]).toMatchObject({ kind: 'interrupt', reason: 'stop' });
      expect(envelope.sendReceipts?.['request-1']).toMatchObject({ taskId: consumer.id });
      await expect(repository.listToolCalls(consumer.id)).resolves.toMatchObject([{ id: 'turn-1:tool-1' }]);
      await expect(repository.listReasoning(consumer.id)).resolves.toMatchObject([{ id: turn.id }]);
      await expect(repository.getOperation('turn-1:op-1')).resolves.toEqual(operation);
      await expect(repository.getCancelRequest(turn.id)).resolves.toMatchObject({ opId: 'cancel-1' });
      await expect(repository.getSendReceipt('request-1')).resolves.toMatchObject({ turnId: turn.id });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('claims operations idempotently without advancing revision on a replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-operations-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'ops', displayName: 'Ops', createdAt: 'now', lastOpenedAt: 'now' });
      const entry: OperationLedgerEntry = { fingerprint: 'fp-1', result: { ok: true, data: { value: 1 } } };
      const first = await repository.execute({ kind: 'claimOperation', workspaceId: 'ws', ledgerKey: 'turn:op', entry, createdAt: 'now' });
      const revisionAfterFirst = await client.get<{ revision: number }>('SELECT revision FROM workspace_revisions WHERE workspace_id = ?', ['ws']);
      const replay = await repository.execute({ kind: 'claimOperation', workspaceId: 'ws', ledgerKey: 'turn:op', entry, createdAt: 'later' });
      const revisionAfterReplay = await client.get<{ revision: number }>('SELECT revision FROM workspace_revisions WHERE workspace_id = ?', ['ws']);
      const conflict = await repository.execute({
        kind: 'claimOperation', workspaceId: 'ws', ledgerKey: 'turn:op',
        entry: { fingerprint: 'different', result: { ok: false, error: 'not used' } }, createdAt: 'later',
      });
      expect(first).toMatchObject({ changed: true, operation: entry });
      expect(replay).toMatchObject({ changed: false, operation: entry });
      expect(conflict).toMatchObject({ changed: false, conflict: true, operation: entry });
      expect(revisionAfterReplay?.revision).toBe(revisionAfterFirst?.revision);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('serializes same-session and git claims across two DB workers, then releases them on settlement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-claims-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const one = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    const two = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await one.open(dbPath);
      await two.open(dbPath);
      const first = new SqliteTaskRepository(one, 'ws');
      const second = new SqliteTaskRepository(two, 'ws');
      await first.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'claims', displayName: 'Claims', createdAt: 'now', lastOpenedAt: 'now' });
      const root = makeTask('root');
      root.releaseState = 'released';
      const a = makeTask('a'); a.parentId = root.id; a.releaseState = 'released'; a.claimsGit = true;
      const b = makeTask('b'); b.parentId = root.id; b.releaseState = 'released'; b.claimsGit = true;
      await first.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
      await first.execute({ kind: 'createTask', workspaceId: 'ws', task: a });
      await first.execute({ kind: 'createTask', workspaceId: 'ws', task: b });
      await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn: { id: 'ta', taskId: a.id, sequence: 1, status: 'queued', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:01.000Z' } });
      await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn: { id: 'tb', taskId: b.id, sequence: 1, status: 'queued', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:01.000Z' } });
      const claim = (repository: SqliteTaskRepository, turnId: string, startedAt: string) => repository.execute({
        kind: 'claimTurn' as const, workspaceId: 'ws', turnId, startedAt, rootTaskId: root.id,
        maxConcurrentTurns: 10, maxConcurrentPerRoot: 10, maxConcurrentPerBackend: 10,
        sessionId: 'shared-session', resourceKeys: ['git'],
      });
      const [left, right] = await Promise.all([claim(first, 'ta', '2026-07-16T00:00:02.000Z'), claim(second, 'tb', '2026-07-16T00:00:02.000Z')]);
      expect([left.changed, right.changed].filter(Boolean)).toHaveLength(1);
      expect(await one.all(
        `SELECT * FROM change_log WHERE workspace_id = ? AND entity_kind = 'turn' AND change_kind = 'promote'`,
        ['ws'],
      )).toHaveLength(1);
      const winner = left.changed ? { repository: first, turnId: 'ta' } : { repository: second, turnId: 'tb' };
      const loser = left.changed ? { repository: second, turnId: 'tb' } : { repository: first, turnId: 'ta' };
      // A stale settlement of the queued loser must not run the trailing claim
      // cleanup statements. This protects the winner's session/resource lease.
      await expect(loser.repository.execute({ kind: 'settleTurn', workspaceId: 'ws', turnId: loser.turnId, status: 'succeeded', finishedAt: '2026-07-16T00:00:02.500Z' })).resolves.toMatchObject({ changed: false });
      expect(await one.all('SELECT * FROM session_claims WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
      expect(await one.all('SELECT * FROM resource_claims WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
      await winner.repository.execute({ kind: 'settleTurn', workspaceId: 'ws', turnId: winner.turnId, status: 'succeeded', finishedAt: '2026-07-16T00:00:03.000Z' });
      await expect(claim(loser.repository, loser.turnId, '2026-07-16T00:00:04.000Z')).resolves.toMatchObject({ changed: true });
      expect(await one.all('SELECT * FROM session_claims WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
      expect(await one.all('SELECT * FROM resource_claims WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
    } finally {
      await Promise.all([one.close(), two.close()]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps the final SQLite claim gate aligned with scheduler readiness blockers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-readiness-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'readiness', displayName: 'Readiness', createdAt: 'now', lastOpenedAt: 'now' });
      const task = makeTask('blocked-task');
      task.releaseState = 'released';
      task.wait = { kind: 'external', key: 'approval' };
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: { id: 'blocked-turn', taskId: task.id, sequence: 1, status: 'queued', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:01.000Z', runtimeEpoch: 1 } });
      const claim = () => repository.execute({
        kind: 'claimTurn' as const, workspaceId: 'ws', turnId: 'blocked-turn', startedAt: '2026-07-16T00:00:02.000Z',
        rootTaskId: task.id, maxConcurrentTurns: 10, maxConcurrentPerRoot: 10, maxConcurrentPerBackend: 10,
        resourceKeys: [],
      });
      await expect(claim()).resolves.toMatchObject({ changed: false });

      task.wait = undefined;
      task.runtimeEpoch = 2;
      await repository.execute({ kind: 'upsertTask', workspaceId: 'ws', task });
      await expect(claim()).resolves.toMatchObject({ changed: false });

      task.runtimeEpoch = 1;
      task.inputBindings = [{ fromTaskId: 'missing-producer', output: 'summary', as: 'input' }];
      await repository.execute({ kind: 'upsertTask', workspaceId: 'ws', task });
      await expect(claim()).resolves.toMatchObject({ changed: false });

      task.inputBindings = undefined;
      task.handoff = {
        version: 1, operationId: 'handoff', phase: 'requested', source: { backend: 'codex' },
        target: { backend: 'grok' }, conversationContext: { status: 'pending' },
        createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
      };
      await repository.execute({ kind: 'upsertTask', workspaceId: 'ws', task });
      await expect(claim()).resolves.toMatchObject({ changed: false });

      task.handoff = undefined;
      await repository.execute({ kind: 'upsertTask', workspaceId: 'ws', task });
      await expect(claim()).resolves.toMatchObject({ changed: true });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('applies retention with an indexed turn delete and cascades turn-bound transcript rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-retention-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'retention', displayName: 'Retention', createdAt: 'now', lastOpenedAt: 'now' });
      const task = makeTask('retention-task');
      task.lifecycle = 'succeeded';
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      for (const sequence of [1, 2, 3]) {
        const turnId = `turn-${sequence}`;
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: { id: turnId, taskId: task.id, sequence, status: 'succeeded', trigger: 'user', inputs: [], createdAt: `2026-07-16T00:00:0${sequence}.000Z`, finishedAt: `2026-07-16T00:00:1${sequence}.000Z` },
        });
        await repository.execute({
          kind: 'appendMessage', workspaceId: 'ws',
          message: { id: `message-${sequence}`, taskId: task.id, turnId, role: 'assistant', content: String(sequence), state: 'complete', order: 0, createdAt: `2026-07-16T00:00:2${sequence}.000Z` },
        });
      }
      await expect(repository.execute({ kind: 'applyRetention', workspaceId: 'ws', taskId: task.id, keepLatestTurns: 1 })).resolves.toMatchObject({ changed: true });
      await expect(repository.listTurns(task.id)).resolves.toMatchObject([{ id: 'turn-3' }]);
      await expect(repository.listMessages(task.id)).resolves.toMatchObject([{ id: 'message-3' }]);
      const queryPlan = await client.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT id FROM turns WHERE workspace_id = ? AND task_id = ? ORDER BY sequence DESC, created_at DESC, id DESC`,
        ['ws', task.id],
      );
      expect(queryPlan.some((row) => row.detail.includes('SEARCH turns'))).toBe(true);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('retains retry ancestors on terminal tasks and truncates only settled output on open tasks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-retention-policy-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'retention-policy', displayName: 'Retention policy', createdAt: 'now', lastOpenedAt: 'now' });

      const terminal = makeTask('terminal-retention');
      terminal.lifecycle = 'succeeded';
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: terminal });
      for (const sequence of [1, 2, 3]) {
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: {
            id: `terminal-turn-${sequence}`, taskId: terminal.id, sequence, status: 'succeeded',
            trigger: 'user', inputs: [], createdAt: `2026-07-16T00:00:0${sequence}.000Z`,
            ...(sequence === 3 ? { retryOf: 'terminal-turn-2' } : {}),
          },
        });
      }
      await repository.execute({ kind: 'applyRetention', workspaceId: 'ws', taskId: terminal.id, keepLatestTurns: 1 });
      await expect(repository.listTurns(terminal.id)).resolves.toMatchObject([
        { id: 'terminal-turn-2' }, { id: 'terminal-turn-3', retryOf: 'terminal-turn-2' },
      ]);

      const open = makeTask('open-retention');
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: open });
      const openTurn = {
        id: 'open-turn', taskId: open.id, sequence: 1, status: 'succeeded' as const,
        trigger: 'user' as const, inputs: [], createdAt: '2026-07-16T00:01:00.000Z',
      };
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: openTurn });
      const oversized = 'x'.repeat(100);
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: open.id,
        messages: [{ id: 'open-assistant', taskId: open.id, turnId: openTurn.id, role: 'assistant', content: oversized, state: 'complete', order: 0, createdAt: openTurn.createdAt }],
        toolCalls: [{ id: 'open-tool', taskId: open.id, turnId: openTurn.id, toolCallId: 'tool', order: 1, name: 'read', status: 'success', output: oversized, createdAt: openTurn.createdAt, updatedAt: openTurn.createdAt }],
        reasoning: [{ id: 'open-reasoning', taskId: open.id, turnId: openTurn.id, content: oversized, createdAt: openTurn.createdAt, updatedAt: openTurn.createdAt }],
      });
      await expect(repository.execute({
        kind: 'applyRetention', workspaceId: 'ws', taskId: open.id, keepLatestTurns: 1,
        maxStoredOutputChars: 30,
      })).resolves.toMatchObject({ changed: true });
      await expect(repository.listTurns(open.id)).resolves.toMatchObject([{ id: openTurn.id }]);
      await expect(repository.listMessages(open.id)).resolves.toMatchObject([
        { id: 'open-assistant', content: expect.stringContaining('[output truncated by retention policy]') },
      ]);
      await expect(repository.listToolCalls(open.id)).resolves.toMatchObject([
        { id: 'open-tool', output: expect.stringContaining('[output truncated by retention policy]') },
      ]);
      await expect(repository.listReasoning(open.id)).resolves.toMatchObject([
        { id: 'open-reasoning', content: expect.stringContaining('[output truncated by retention policy]') },
      ]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
