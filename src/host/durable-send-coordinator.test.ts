import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskEngine } from '../task/engine';
import { SqliteTaskRepository } from '../task/repository';
import { DbClient } from '../task/sqlite/client';
import { runDurableHostSend } from './durable-send-coordinator';

const WORKER_TS = path.join(__dirname, '../task/sqlite/worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const tempDirs: string[] = [];
const clients: DbClient[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-durable-send-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const backendCaps = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

const TS = '2026-07-18T00:00:01.000Z';

describe('runDurableHostSend production control flow', () => {
  it('put fault: one sendRejected, zero perform/projection', async () => {
    const dbPath = tempDbPath();
    const seed = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(seed);
    await seed.open(dbPath);
    const seedRepo = new SqliteTaskRepository(seed, 'ws');
    await seedRepo.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'k',
      displayName: 'WS',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    await seed.close();

    const fault = new DbClient({
      workerPath: WORKER_TS,
      execArgv: TSX_ARGV,
      faultCapability: true,
      faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
    });
    clients.push(fault);
    await fault.open(dbPath);
    const repository = new SqliteTaskRepository(fault, 'ws');

    const posts: unknown[] = [];
    const performSend = vi.fn(async () => ({
      ok: true as const,
      value: { taskId: 't', messageId: 'm' },
    }));
    const publishProjection = vi.fn();

    await runDurableHostSend(
      {
        repository,
        workspaceId: 'ws',
        postMessage: (msg) => posts.push(msg),
        publishProjection,
        clearOutbox: async () => undefined,
        rejectOutbox: async () => undefined,
        performSend,
      },
      {
        clientRequestId: 'req-1',
        text: 'hello',
        entry: {
          clientRequestId: 'req-1',
          status: 'pending',
          payload: { version: 1, text: 'hello' },
          createdAt: TS,
          updatedAt: TS,
        },
      },
    );

    expect(posts).toEqual([
      {
        type: 'sendRejected',
        clientRequestId: 'req-1',
        reason: 'unable to durably queue send',
        code: 'store',
      },
    ]);
    expect(performSend).toHaveBeenCalledTimes(0);
    expect(publishProjection).toHaveBeenCalledTimes(0);
  }, 30_000);

  it('performSend throws: one fixed sendRejected, no raw message, promise resolves', async () => {
    const dbPath = tempDbPath();
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(dbPath);
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'k',
      displayName: 'WS',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });

    const posts: unknown[] = [];
    const publishProjection = vi.fn();
    let rejected = 0;

    await expect(
      runDurableHostSend(
        {
          repository,
          workspaceId: 'ws',
          postMessage: (msg) => posts.push(msg),
          publishProjection,
          clearOutbox: async () => undefined,
          rejectOutbox: async () => {
            rejected += 1;
          },
          performSend: async () => {
            throw new Error('backend exploded with /secret/path');
          },
        },
        {
          clientRequestId: 'req-throw',
          text: 'hello',
          entry: {
            clientRequestId: 'req-throw',
            status: 'pending',
            payload: { version: 1, text: 'hello' },
          createdAt: TS,
          updatedAt: TS,
        },
      },
    ),
    ).resolves.toBeUndefined();

    expect(posts).toEqual([
      {
        type: 'sendRejected',
        clientRequestId: 'req-throw',
        reason: 'unable to process durably queued send',
        code: 'store',
      },
    ]);
    expect(JSON.stringify(posts)).not.toMatch(/exploded|secret|path/i);
    expect(rejected).toBe(1);
    expect(publishProjection).toHaveBeenCalledTimes(0);
  }, 30_000);

  it('result.ok false + rejectOutbox throws: still one sendRejected', async () => {
    const dbPath = tempDbPath();
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(dbPath);
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'k',
      displayName: 'WS',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });

    const posts: unknown[] = [];
    await expect(
      runDurableHostSend(
        {
          repository,
          workspaceId: 'ws',
          postMessage: (msg) => posts.push(msg),
          publishProjection: () => undefined,
          clearOutbox: async () => undefined,
          rejectOutbox: async () => {
            throw new Error('reject failed');
          },
          performSend: async () => ({
            ok: false,
            reason: 'capacity full',
            code: 'capacity',
          }),
        },
        {
          clientRequestId: 'req-rej',
          text: 'hello',
          entry: {
            clientRequestId: 'req-rej',
            status: 'pending',
            payload: { version: 1, text: 'hello' },
          createdAt: TS,
          updatedAt: TS,
        },
      },
    ),
    ).resolves.toBeUndefined();

    expect(posts).toEqual([
      {
        type: 'sendRejected',
        clientRequestId: 'req-rej',
        reason: 'capacity full',
        code: 'capacity',
      },
    ]);
  }, 30_000);

  it('success + clearOutbox throws: still sendAccepted, outbox may remain', async () => {
    const dbPath = tempDbPath();
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(dbPath);
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'k',
      displayName: 'WS',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });

    const posts: unknown[] = [];
    const publishProjection = vi.fn();
    const order: string[] = [];

    await expect(
      runDurableHostSend(
        {
          repository,
          workspaceId: 'ws',
          postMessage: (msg) => {
            order.push('accepted');
            posts.push(msg);
          },
          publishProjection,
          clearOutbox: async () => {
            order.push('clear');
            throw new Error('clear failed');
          },
          rejectOutbox: async () => undefined,
          performSend: async () => ({
            ok: true,
            value: {
              taskId: 'task-1',
              messageId: 'msg-1',
              turnId: 'turn-1',
              snapshotTaskId: 'task-1',
            },
          }),
        },
        {
          clientRequestId: 'req-ok',
          text: 'hello',
          entry: {
            clientRequestId: 'req-ok',
            status: 'pending',
            payload: { version: 1, text: 'hello' },
          createdAt: TS,
          updatedAt: TS,
        },
      },
    ),
    ).resolves.toBeUndefined();

    expect(posts).toEqual([
      {
        type: 'sendAccepted',
        clientRequestId: 'req-ok',
        taskId: 'task-1',
        messageId: 'msg-1',
        turnId: 'turn-1',
      },
    ]);
    expect(publishProjection).toHaveBeenCalledTimes(1);
    expect(publishProjection).toHaveBeenCalledWith('task-1');
    expect(order).toEqual(['accepted', 'clear']);
    // Outbox still present for idempotent replay after clear failure.
    expect(await repository.listSendOutbox()).toHaveLength(1);
  }, 30_000);

  it('new-task snapshot once; existing-task zero snapshots; ACK after durable', async () => {
    const dbPath = tempDbPath();
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(dbPath);
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'k',
      displayName: 'WS',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    let receiptReads = 0;
    const originalGetSendReceipt = repository.getSendReceipt.bind(repository);
    repository.getSendReceipt = async (clientRequestId) => {
      receiptReads += 1;
      return originalGetSendReceipt(clientRequestId);
    };

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () =>
        ({
          name: 'fake',
          capabilities: backendCaps,
          run: async function* () {
            yield { type: 'turnCompleted' };
          },
        }) as never,
    });

    const posts: unknown[] = [];
    const snapshots: string[] = [];
    const order: string[] = [];

    // New task
    await runDurableHostSend(
      {
        repository,
        workspaceId: 'ws',
        postMessage: (msg) => {
          if (msg.type === 'sendAccepted') {
            order.push('accepted');
          }
          posts.push(msg);
        },
        publishProjection: (id) => {
          order.push('snapshot');
          snapshots.push(id);
        },
        clearOutbox: async (id) => {
          order.push('clear');
          await repository.execute({
            kind: 'deleteSendOutbox',
            workspaceId: 'ws',
            clientRequestId: id,
          });
        },
        rejectOutbox: async () => undefined,
        performSend: async () => {
          order.push('perform');
          const result = await engine.startNewTask({
            goal: 'hello',
            message: 'hello',
            backend: 'fake',
            clientRequestId: 'req-new',
          });
          if (!result.ok) return { ok: false, reason: result.reason };
          order.push('receipt');
          expect(await repository.getSendReceipt('req-new')).toBeDefined();
          return {
            ok: true,
            value: {
              taskId: result.value.taskId,
              messageId: result.value.messageId,
              turnId: result.value.turnId,
              snapshotTaskId: result.value.taskId,
            },
          };
        },
      },
      {
        clientRequestId: 'req-new',
        text: 'hello',
        entry: {
          clientRequestId: 'req-new',
          status: 'pending',
          payload: { version: 1, text: 'hello' },
          createdAt: TS,
          updatedAt: TS,
        },
      },
    );

    expect(posts.filter((p) => (p as { type: string }).type === 'sendAccepted')).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(order.indexOf('perform')).toBeLessThan(order.indexOf('receipt'));
    expect(order.indexOf('receipt')).toBeLessThan(order.indexOf('accepted'));
    expect(order.indexOf('accepted')).toBeLessThan(order.indexOf('clear'));
    // One preflight plus this test's explicit durable-receipt proof. There is
    // no fallible post-commit receipt read inside startNewTask.
    expect(receiptReads).toBe(2);

    const taskId = (posts.find((p) => (p as { type: string }).type === 'sendAccepted') as {
      taskId: string;
    }).taskId;
    posts.length = 0;
    snapshots.length = 0;
    order.length = 0;

    // Existing task — no snapshot
    await runDurableHostSend(
      {
        repository,
        workspaceId: 'ws',
        postMessage: (msg) => posts.push(msg),
        publishProjection: (id) => snapshots.push(id),
        clearOutbox: async (id) => {
          await repository.execute({
            kind: 'deleteSendOutbox',
            workspaceId: 'ws',
            clientRequestId: id,
          });
        },
        rejectOutbox: async () => undefined,
        performSend: async () => {
          const result = await engine.sendAsync(taskId, 'follow-up', {
            clientRequestId: 'req-exist',
          });
          if (!result.ok) return { ok: false, reason: result.reason };
          if (!result.value.messageId) {
            return { ok: false, reason: 'missing message id' };
          }
          return {
            ok: true,
            value: {
              taskId,
              messageId: result.value.messageId,
              turnId: result.value.turnId,
              // no snapshotTaskId
            },
          };
        },
      },
      {
        clientRequestId: 'req-exist',
        taskId,
        text: 'follow-up',
        entry: {
          clientRequestId: 'req-exist',
          status: 'pending',
          taskId,
          payload: { version: 1, text: 'follow-up' },
          createdAt: TS,
          updatedAt: TS,
        },
      },
    );

    expect(posts).toHaveLength(1);
    expect((posts[0] as { type: string }).type).toBe('sendAccepted');
    expect(snapshots).toHaveLength(0);

    await engine.shutdown();
  }, 60_000);

  it('production extension imports runDurableHostSend', async () => {
    const src = await fs.promises.readFile(
      path.join(__dirname, '../extension.ts'),
      'utf8',
    );
    expect(src).toMatch(/runDurableHostSend/);
    expect(src).not.toMatch(/Legacy path without clientRequestId/);
  });
});
