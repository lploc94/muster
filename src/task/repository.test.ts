import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository, type TaskRepository } from './repository';
import type { MusterTask, OperationLedgerEntry } from './types';
import { DbClient } from './sqlite/client';

function makeTask(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'draft',
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

describe('SqliteTaskRepository', () => {
  it('applies graph create atomically with operation replay/conflict parity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-graph-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'graph-identity', 'Graph', 'now', 'now'],
      );
      for (const repository of [new SqliteTaskRepository(client, 'ws')]) {
        const root = makeTask(`graph-root-${Math.random()}`);
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
        const child = { ...makeTask(`${root.id}-child`), parentId: root.id, revision: 0 };
        const message = {
          id: `${child.id}-message`, taskId: child.id, role: 'user' as const,
          content: 'run', state: 'assigned' as const, turnId: `${child.id}-turn`,
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        const turn = {
          id: `${child.id}-turn`, taskId: child.id, sequence: 1, status: 'queued' as const,
          trigger: 'engine' as const, inputs: [{ kind: 'message' as const, messageId: message.id }],
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        const operation = { ledgerKey: `${root.id}:graph-op`, entry: {
          fingerprint: 'graph-fingerprint', result: { ok: true, data: { taskId: child.id, turnId: turn.id } },
        }, createdAt: '2026-07-16T00:00:01.000Z' };
        const command = {
          kind: 'createChildTask' as const, workspaceId: 'ws', expectedTasks: [{ id: root.id, revision: root.revision }],
          insertTaskIds: [child.id], tasks: [child], insertTurnIds: [turn.id], turns: [turn],
          insertMessageIds: [message.id], messages: [message], operation,
        };
        await expect(repository.execute(command)).resolves.toMatchObject({ changed: true, operation: operation.entry });
        await expect(repository.getTask(child.id)).resolves.toMatchObject({ parentId: root.id });
        await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ taskId: child.id });
        await expect(repository.execute(command)).resolves.toMatchObject({ changed: false, operation: operation.entry });
        await expect(repository.execute({ ...command, operation: { ...operation, entry: { ...operation.entry, fingerprint: 'different' } } })).resolves.toMatchObject({ conflict: true });
        const badChild = { ...makeTask(`${root.id}-bad`), parentId: root.id, dependencies: [{ taskId: 'missing', requiredOutcome: 'succeeded' as const, onUnsatisfied: 'fail' as const }] };
        await expect(repository.execute({ ...command, operation: { ...operation, ledgerKey: `${root.id}:bad`, entry: { ...operation.entry, fingerprint: 'bad' } }, insertTaskIds: [badChild.id], tasks: [badChild], insertTurnIds: [], turns: [], insertMessageIds: [], messages: [] })).resolves.toMatchObject({ changed: false });
        await expect(repository.getTask(badChild.id)).resolves.toBeUndefined();
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('consumes a cancel request with owner/request fences and releases all claims', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-cancel-consumer-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(`INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`, ['ws', 'cancel-consumer', 'Cancel', 'now', 'now']);
      const repositories = [new SqliteTaskRepository(client, 'ws')];
      for (const repository of repositories) {
        const task = { ...makeTask(`cancel-task-${Math.random()}`), releaseState: 'released' as const };
        const turn = { id: `${task.id}-turn`, taskId: task.id, sequence: 1, status: 'running' as const, trigger: 'engine' as const, inputs: [], createdAt: '2026-07-16T00:00:01.000Z' };
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
        await repository.execute({ kind: 'claimRuntime', workspaceId: 'ws', turnId: turn.id, ownerId: 'owner', claimedAt: '2026-07-16T00:00:01.000Z', heartbeatAt: '2026-07-16T00:00:01.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
        const request = { kind: 'cancel' as const, by: 'user', opId: 'cancel-op', at: '2026-07-16T00:00:02.000Z' };
        await repository.execute({ kind: 'putCancelRequest', workspaceId: 'ws', turnId: turn.id, request });
        await client.run(`INSERT INTO session_claims (workspace_id, session_id, turn_id, claimed_at) VALUES (?,?,?,?)`, ['ws', `${turn.id}-session`, turn.id, 'now']);
        await client.run(`INSERT INTO resource_claims (workspace_id, resource_key, task_id, turn_id, claimed_at) VALUES (?,?,?,?,?)`, ['ws', 'git', task.id, turn.id, 'now']);
        const nextTurn = { ...turn, status: 'cancelled' as const, finishedAt: '2026-07-16T00:00:03.000Z' };
        const consume = {
          kind: 'consumeCancelRequest', workspaceId: 'ws', expectedTasks: [{ id: task.id, revision: task.revision }],
          expectedTurns: [{ id: turn.id, status: 'running' }], expectedRuntimeClaims: [{ turnId: turn.id, ownerId: 'owner' }],
          expectedCancelRequests: [{ turnId: turn.id, kind: 'cancel', opId: request.opId }],
          tasks: [], turns: [nextTurn], messages: [], deleteOperationKeys: [],
          deleteCancelRequestTurnIds: [turn.id], deleteRuntimeClaimTurnIds: [turn.id],
          deleteSessionClaimTurnIds: [turn.id], deleteResourceClaimTurnIds: [turn.id],
        } as const;
        await expect(repository.execute({
          ...consume,
          expectedTurns: [{ id: turn.id, status: 'waiting_user' as const }],
        })).resolves.toMatchObject({ changed: false });
        await expect(repository.getCancelRequest(turn.id)).resolves.toEqual(request);
        await expect(repository.getRuntimeClaim(turn.id)).resolves.toMatchObject({ ownerId: 'owner' });
        await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ status: 'running' });

        await expect(repository.execute(consume)).resolves.toMatchObject({ changed: true });
        await expect(repository.getCancelRequest(turn.id)).resolves.toBeUndefined();
        await expect(repository.getRuntimeClaim(turn.id)).resolves.toBeUndefined();
        await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ status: 'cancelled' });
        await expect(client.get(`SELECT 1 AS present FROM session_claims WHERE workspace_id=? AND turn_id=?`, ['ws', turn.id])).resolves.toBeUndefined();
        await expect(client.get(`SELECT 1 AS present FROM resource_claims WHERE workspace_id=? AND turn_id=?`, ['ws', turn.id])).resolves.toBeUndefined();
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps host history commands atomic in SQLite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-history-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repositories: TaskRepository[] = [new SqliteTaskRepository(client, 'ws')];
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

        const queuedTask = makeTask(`history-queue-command-${index}`);
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: queuedTask });
        await expect(repository.execute({
          kind: 'queueTaskTurn', workspaceId: 'ws', expectedTaskRevision: queuedTask.revision,
          maxTurnsPerTask: 10, task: queuedTask,
          turn: {
            id: `history-queue-turn-${index}`, taskId: queuedTask.id, sequence: 1,
            status: 'queued', trigger: 'engine', inputs: [], createdAt: '2026-07-16T00:00:02.500Z',
          },
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.listTurns(queuedTask.id)).resolves.toMatchObject([
          { id: `history-queue-turn-${index}`, status: 'queued' },
        ]);

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
    }
  }, 20_000);

  it('runs the named-command and transcript-page contract on SQLite', async () => {
    const task = makeTask('contract-task');
    task.releaseState = 'released';
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-contract-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'contract-identity', 'Contract', 'now', 'now'],
      );
      const sqlite = new SqliteTaskRepository(client, 'ws');
      for (const repository of [sqlite]) {
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
        await expect(repository.execute({ kind: 'applyRetentionPolicy', workspaceId: 'ws', taskId: task.id, keepLatestTurns: 1 })).resolves.toMatchObject({ changed: false });
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('atomically enqueues a message turn with revision and turn-cap guards', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-enqueue-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'enqueue-identity', 'Enqueue', 'now', 'now'],
      );
      const repositories = [new SqliteTaskRepository(client, 'ws')];
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
    }
  }, 20_000);

  it('edits, deletes, and resumes only queued message turns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-queue-mutations-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'queue-mutations', 'Queue mutations', 'now', 'now'],
      );
      const sqlite = new SqliteTaskRepository(client, 'ws');
      for (const [index, repository] of [sqlite].entries()) {
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
    }
  }, 20_000);

  it('allocates a retry turn atomically with its task state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-retry-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'retry-contract', 'Retry contract', 'now', 'now'],
      );
      for (const [index, repository] of [new SqliteTaskRepository(client, 'ws')].entries()) {
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
    }
  }, 20_000);

  it('keeps lifecycle, disposition, and cascade commands fenced and atomic', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-lifecycle-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(`INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`, ['ws', 'lifecycle-contract', 'Lifecycle', 'now', 'now']);
      for (const [index, repository] of [new SqliteTaskRepository(client, 'ws')].entries()) {
        const task = makeTask(`lifecycle-task-${index}`);
        task.releaseState = 'released';
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        const live = { id: `lifecycle-turn-${index}`, taskId: task.id, sequence: 1, status: 'running' as const, trigger: 'user' as const, inputs: [], createdAt: '2026-07-16T00:00:00.000Z' };
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: live });
        const staged = { ...live, disposition: { kind: 'complete' as const, result: 'done' }, status: 'running' as const };
        await expect(repository.execute({ kind: 'stageDisposition', workspaceId: 'ws', turnId: live.id, opId: 'op-1', turn: staged, expectedStatuses: ['running'] })).resolves.toMatchObject({ changed: true });
        await expect(repository.execute({ kind: 'stageDisposition', workspaceId: 'ws', turnId: live.id, opId: 'stale', turn: { ...staged, disposition: { kind: 'fail', error: 'bad' } }, expectedStatuses: ['running'], expectedDisposition: staged.disposition })).resolves.toMatchObject({ changed: false });
        const sealedTask = { ...task, lifecycle: 'cancelled' as const, revision: 1, updatedAt: '2026-07-16T00:00:01.000Z' };
        const sealedTurn = { ...staged, status: 'interrupted' as const, finishedAt: '2026-07-16T00:00:01.000Z' };
        await expect(repository.execute({ kind: 'applyTaskLifecycle', workspaceId: 'ws', taskId: task.id, expectedTaskRevision: task.revision, task: sealedTask, turns: [sealedTurn], expectedTurns: [{ id: live.id, status: 'running' }] })).resolves.toMatchObject({ changed: true });
        await expect(repository.getTask(task.id)).resolves.toMatchObject({ lifecycle: 'cancelled', revision: 1 });
        await expect(repository.listTurns(task.id)).resolves.toMatchObject([{ status: 'interrupted' }]);
        await expect(repository.execute({ kind: 'applyTaskLifecycle', workspaceId: 'ws', taskId: task.id, expectedTaskRevision: task.revision, task: sealedTask, turns: [], expectedTurns: [{ id: live.id, status: 'running' }] })).resolves.toMatchObject({ changed: false });

        const root = makeTask(`cascade-root-${index}`);
        const child = makeTask(`cascade-child-${index}`); child.parentId = root.id;
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
        const skippedRoot = { ...root, lifecycle: 'skipped' as const, revision: 1, updatedAt: '2026-07-16T00:00:02.000Z' };
        const skippedChild = { ...child, lifecycle: 'skipped' as const, revision: 1, updatedAt: '2026-07-16T00:00:02.000Z' };
        await expect(repository.execute({ kind: 'cascadeTaskLifecycle', workspaceId: 'ws', rootTaskId: root.id, mode: 'skip', expectedTasks: [{ id: root.id, revision: 0 }, { id: child.id, revision: 0 }], tasks: [skippedChild, skippedRoot], turns: [] })).resolves.toMatchObject({ changed: true });
        await expect(repository.listSubtree(root.id)).resolves.toMatchObject([{ lifecycle: 'skipped' }, { lifecycle: 'skipped' }]);
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('claims, heartbeats, reclaims, and releases runtime ownership', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-runtime-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'runtime-identity', 'Runtime', 'now', 'now'],
      );
      for (const [index, repository] of [new SqliteTaskRepository(client, 'ws')].entries()) {
        const task = makeTask(`runtime-task-${index}`);
        const turnId = `runtime-turn-${index}`;
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: {
          id: turnId, taskId: task.id, sequence: 1, status: 'queued', trigger: 'engine', inputs: [],
          createdAt: '2026-07-16T00:00:00.000Z',
        } });
        await expect(repository.execute({
          kind: 'claimRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-a',
          claimedAt: '2026-07-16T00:00:01.000Z', heartbeatAt: '2026-07-16T00:00:01.000Z',
          expiresAt: '2026-07-16T00:00:10.000Z',
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.execute({
          kind: 'claimRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-b',
          claimedAt: '2026-07-16T00:00:02.000Z', heartbeatAt: '2026-07-16T00:00:02.000Z',
          expiresAt: '2026-07-16T00:00:20.000Z',
        })).resolves.toMatchObject({ changed: false });
        await expect(repository.execute({
          kind: 'heartbeatRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-a',
          heartbeatAt: '2026-07-16T00:00:05.000Z', expiresAt: '2026-07-16T00:00:15.000Z',
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.execute({
          kind: 'claimRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-b',
          claimedAt: '2026-07-16T00:00:16.000Z', heartbeatAt: '2026-07-16T00:00:16.000Z',
          expiresAt: '2026-07-16T00:00:30.000Z',
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.getRuntimeClaim(turnId)).resolves.toMatchObject({ ownerId: 'owner-b' });
        await expect(repository.execute({ kind: 'releaseRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-a' }))
          .resolves.toMatchObject({ changed: false });
        await expect(repository.execute({ kind: 'releaseRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-b' }))
          .resolves.toMatchObject({ changed: true });
        await expect(repository.getRuntimeClaim(turnId)).resolves.toBeUndefined();
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps live transcript rows byte-for-byte during retention', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-live-retention-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        ['ws', 'live-retention', 'Live retention', 'now', 'now'],
      );
      const repositories: TaskRepository[] = [new SqliteTaskRepository(client, 'ws')];
      const oversized = 'live-output'.repeat(20);
      for (const [index, repository] of repositories.entries()) {
        const task = makeTask(`live-retention-task-${index}`);
        const turn = {
          id: `live-retention-turn-${index}`, taskId: task.id, sequence: 1,
          status: 'running' as const, trigger: 'engine' as const, inputs: [],
          createdAt: '2026-07-16T00:00:01.000Z', startedAt: '2026-07-16T00:00:02.000Z',
        };
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
        await repository.execute({
          kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id,
          messages: [{
            id: `live-retention-message-${index}`, taskId: task.id, turnId: turn.id,
            role: 'assistant', content: oversized, state: 'partial', order: 0,
            createdAt: '2026-07-16T00:00:03.000Z',
          }],
          toolCalls: [{
            id: `${turn.id}:tool`, taskId: task.id, turnId: turn.id, toolCallId: 'tool',
            order: 1, name: 'read', status: 'running', output: oversized,
            createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
          }],
          reasoning: [{
            id: turn.id, taskId: task.id, turnId: turn.id, content: oversized,
            createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
          }],
        });

        await expect(repository.execute({
          kind: 'applyRetentionPolicy', workspaceId: 'ws', taskId: task.id,
          keepLatestTurns: 1, maxStoredOutputChars: 30,
        })).resolves.toMatchObject({ changed: false });
        await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ status: 'running' });
        await expect(repository.listMessages(task.id)).resolves.toMatchObject([{ content: oversized }]);
        await expect(repository.listToolCalls(task.id)).resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({ id: `${turn.id}:tool`, output: oversized }),
        ]));
        await expect(repository.listReasoning(task.id)).resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({ id: turn.id, content: oversized }),
        ]));
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('hydrates current domain DTOs with promoted columns as the single source of truth', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-sqlite-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(dbPath);
      const task = makeTask('task-1');
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
            JSON.stringify({
              payloadVersion: 1,
              capabilities: task.capabilities,
              executionPolicy: task.executionPolicy,
            }),
          ],
        },
        {
          sql: `INSERT INTO turns
                (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'turn-1', 'ws-1', 'task-1', 1, 'succeeded', 'user', turn.createdAt, null,
            '2026-07-16T00:00:02.000Z', JSON.stringify({ payloadVersion: 1 }),
          ],
        },
        {
          sql: `INSERT INTO messages
                (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'message-1', 'ws-1', 'task-1', 'turn-1', 'assistant', 'complete', 7,
            'column content', message.createdAt, null, JSON.stringify({ payloadVersion: 1 }),
          ],
        },
        {
          sql: `INSERT INTO turns
                (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'turn-queued', 'ws-1', 'task-1', 2, 'queued', 'engine', '2026-07-16T00:00:04.000Z',
            null, null, JSON.stringify({ payloadVersion: 1 }),
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

  it('rejects malformed current payloads instead of returning partial DTOs', async () => {
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
         (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['task-1', 'ws-1', null, 'worker', 'open', 'draft', 'goal', 'codex', 0, 'now', 'now', JSON.stringify({ payloadVersion: 1 })],
      );
      const repository = new SqliteTaskRepository(client, 'ws-1');
      await expect(repository.getTask('task-1')).rejects.toThrow(/missing domain payload fields/);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('persists every task aggregate as normalized rows exposed by focused queries', async () => {
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
      consumer.wait = { kind: 'external', key: 'approval', message: 'waiting for approval' };
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

      await expect(repository.getTask(consumer.id)).resolves.toMatchObject({
        dependencies: consumer.dependencies,
        description: consumer.description,
        wait: consumer.wait,
      });
      await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ inputs: turn.inputs });
      await expect(repository.listMessages(consumer.id)).resolves.toContainEqual(
        expect.objectContaining({ id: message.id, agentContent: message.agentContent }),
      );
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

  it('derives the owning root in SQLite instead of trusting the caller root id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-root-claim-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'root-claim', displayName: 'Root claim', createdAt: 'now', lastOpenedAt: 'now' });
      const rootA = makeTask('root-a'); rootA.releaseState = 'released';
      const rootB = makeTask('root-b'); rootB.releaseState = 'released';
      const a1 = makeTask('a-1'); a1.parentId = rootA.id; a1.releaseState = 'released';
      const a2 = makeTask('a-2'); a2.parentId = rootA.id; a2.releaseState = 'released';
      const b1 = makeTask('b-1'); b1.parentId = rootB.id; b1.releaseState = 'released';
      for (const task of [rootA, rootB, a1, a2, b1]) await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      for (const [turnId, taskId] of [['ta1', a1.id], ['ta2', a2.id], ['tb1', b1.id]] as const) {
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: {
          id: turnId, taskId, sequence: 1, status: 'queued', trigger: 'engine', inputs: [], createdAt: '2026-07-16T00:00:00.000Z',
        } });
      }
      const claim = (turnId: string, callerRoot: string) => repository.execute({
        kind: 'claimTurn' as const, workspaceId: 'ws', turnId, startedAt: `2026-07-16T00:00:0${turnId.length}.000Z`,
        rootTaskId: callerRoot, maxConcurrentTurns: 10, maxConcurrentPerRoot: 1,
        maxConcurrentPerBackend: 10, resourceKeys: [],
      });
      await expect(claim('ta1', rootA.id)).resolves.toMatchObject({ changed: true });
      // Lying with root-b must not bypass root-a's concurrency ceiling.
      await expect(claim('ta2', rootB.id)).resolves.toMatchObject({ changed: false });
      await expect(claim('tb1', rootA.id)).resolves.toMatchObject({ changed: true });
    } finally {
      await client.close();
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
      const liveTurn = {
        id: 'open-live-turn', taskId: open.id, sequence: 2, status: 'running' as const,
        trigger: 'engine' as const, inputs: [], createdAt: '2026-07-16T00:02:00.000Z',
        startedAt: '2026-07-16T00:02:01.000Z',
      };
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: liveTurn });
      const oversized = 'x'.repeat(100);
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: open.id,
        messages: [
          { id: 'open-assistant', taskId: open.id, turnId: openTurn.id, role: 'assistant', content: oversized, state: 'complete', order: 0, createdAt: openTurn.createdAt },
          { id: 'live-assistant', taskId: open.id, turnId: liveTurn.id, role: 'assistant', content: oversized, state: 'partial', order: 0, createdAt: liveTurn.createdAt },
        ],
        toolCalls: [
          { id: 'open-tool', taskId: open.id, turnId: openTurn.id, toolCallId: 'tool', order: 1, name: 'read', status: 'success', output: oversized, createdAt: openTurn.createdAt, updatedAt: openTurn.createdAt },
          { id: 'live-tool', taskId: open.id, turnId: liveTurn.id, toolCallId: 'live-tool', order: 1, name: 'read', status: 'running', output: oversized, createdAt: liveTurn.createdAt, updatedAt: liveTurn.createdAt },
        ],
        reasoning: [
          { id: 'open-reasoning', taskId: open.id, turnId: openTurn.id, content: oversized, createdAt: openTurn.createdAt, updatedAt: openTurn.createdAt },
          { id: 'live-reasoning', taskId: open.id, turnId: liveTurn.id, content: oversized, createdAt: liveTurn.createdAt, updatedAt: liveTurn.createdAt },
        ],
      });
      await expect(repository.execute({
        kind: 'applyRetention', workspaceId: 'ws', taskId: open.id, keepLatestTurns: 1,
        maxStoredOutputChars: 30,
      })).resolves.toMatchObject({ changed: true });
      await expect(repository.listTurns(open.id)).resolves.toMatchObject([
        { id: openTurn.id }, { id: liveTurn.id, status: 'running' },
      ]);
      await expect(repository.listMessages(open.id)).resolves.toMatchObject([
        { id: 'open-assistant', content: expect.stringContaining('[output truncated by retention policy]') },
        { id: 'live-assistant', content: oversized },
      ]);
      await expect(repository.listToolCalls(open.id)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'open-tool', output: expect.stringContaining('[output truncated by retention policy]') }),
        expect.objectContaining({ id: 'live-tool', output: oversized }),
      ]));
      await expect(repository.listReasoning(open.id)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'open-reasoning', content: expect.stringContaining('[output truncated by retention policy]') }),
        expect.objectContaining({ id: 'live-reasoning', content: oversized }),
      ]));
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);



  it('starts a one-node workflow run with one queued entry turn and idempotent replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-start-wf-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const topology = {
        kind: 'one_node_v1' as const,
        nodes: [{ nodeId: 'entry' }],
        entryNodeId: 'entry',
      };
      const createdAt = '2026-07-19T00:00:00.000Z';
      await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology,
        createdAt,
      });
      const start = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'repo-start-1',
        createdAt,
        goal: 'entry goal',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      expect(start.changed).toBe(true);
      const data = start.operation?.result?.data as { activationTurnId: string; entryTaskId: string; runId: string };
      expect(data.activationTurnId).toEqual(expect.any(String));
      const turns = await repository.listQueuedTurns(data.entryTaskId);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.id).toBe(data.activationTurnId);
      const replay = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'repo-start-1',
        createdAt,
        goal: 'entry goal',
        backend: 'grok',
      });
      expect(replay.ok).toBe(true);
      expect(replay.changed).toBe(false);
      expect(await repository.listTurns(data.entryTaskId)).toHaveLength(1);
      expect(await client.all('SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('defines an immutable one-node workflow with replay and fingerprint conflict', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-define-wf-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const topology = {
        kind: 'one_node_v1' as const,
        nodes: [{ nodeId: 'entry' }],
        entryNodeId: 'entry',
      };
      const createdAt = '2026-07-19T00:00:00.000Z';
      const first = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology,
        createdAt,
      });
      expect(first.ok).toBe(true);
      expect(first.changed).toBe(true);
      expect(first.operation?.fingerprint).toEqual(expect.any(String));

      const rows = await client.all(
        'SELECT definition_id, version, name, entry_node_id, topology_json FROM workflow_definitions WHERE workspace_id = ?',
        ['ws'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        definition_id: 'wf-one',
        version: 1,
        name: 'one-node',
        entry_node_id: 'entry',
      });

      // Same key + same fingerprint → replay (no second row)
      const replay = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology,
        createdAt: '2099-01-01T00:00:00.000Z',
      });
      expect(replay.ok).toBe(true);
      expect(replay.changed).toBe(false);
      expect(await client.all(
        'SELECT definition_id FROM workflow_definitions WHERE workspace_id = ?',
        ['ws'],
      )).toHaveLength(1);

      // Same key + different topology → conflict, no partial overwrite
      const conflict = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node-renamed',
        topology,
        createdAt,
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.conflict).toBe(true);
      expect(conflict.reason).toMatch(/fingerprint conflict|definition fingerprint conflict/);
      const afterConflict = await client.all(
        'SELECT name, topology_json FROM workflow_definitions WHERE workspace_id = ?',
        ['ws'],
      );
      expect(afterConflict).toHaveLength(1);
      expect(afterConflict[0]).toMatchObject({ name: 'one-node' });

      // Invalid topology fails closed without rows
      const invalid = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-bad',
        version: 1,
        name: 'bad',
        topology: { kind: 'one_node_v1', nodes: [{ nodeId: 'a' }, { nodeId: 'b' }], entryNodeId: 'a' },
        createdAt,
      });
      expect(invalid.ok).toBe(false);
      expect(await client.all(
        'SELECT definition_id FROM workflow_definitions WHERE workspace_id = ? AND definition_id = ?',
        ['ws', 'wf-bad'],
      )).toHaveLength(0);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

});
