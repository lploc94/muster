/**
 * P5-W3 durable write failure contract.
 *
 * Uses explicit DbClient faultCapability + faultPlan (never ambient env).
 * Faults fire at commit boundary after statements run so rollback is real.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbClient, DbWorkerError } from './client';
import type { SqliteFaultCode } from './errors';
import { SqliteTaskRepository } from '../repository';
import { RepositoryProjection, withRepositoryProjection } from '../repository-projection';
import type { MusterTask } from '../types';

const WORKER_TS = path.join(__dirname, 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

const tempDirs: string[] = [];
const clients: DbClient[] = [];

function makeClient(opts: {
  faultCode?: SqliteFaultCode;
  remaining?: number;
  onTerminal?: (error: DbWorkerError) => void;
} = {}): DbClient {
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
    ...(opts.faultCode
      ? {
          faultCapability: true,
          faultPlan: {
            code: opts.faultCode,
            operation: 'transaction',
            remaining: opts.remaining ?? 1,
          },
        }
      : {}),
    ...(opts.onTerminal ? { onTerminalStorageError: opts.onTerminal } : {}),
  });
  clients.push(client);
  return client;
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-write-fail-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

function task(id: string): MusterTask {
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
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function seedWorkspace(dbPath: string): Promise<void> {
  const client = makeClient();
  await client.open(dbPath);
  const repository = new SqliteTaskRepository(client, 'ws');
  await repository.execute({
    kind: 'upsertWorkspace',
    workspaceId: 'ws',
    identityKey: 'write-fail',
    displayName: 'Write fail',
    createdAt: 'now',
    lastOpenedAt: 'now',
  });
  await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: task('t1') });
  await client.close();
}

describe('P5-W3 durable write failures', () => {
  it('ambient fault env does not inject on a normal production client', async () => {
    process.env.MUSTER_SQLITE_FAULT_INJECT = '1';
    process.env.MUSTER_SQLITE_FAULT_CODE = 'full';
    process.env.MUSTER_SQLITE_FAULT_OPERATION = 'transaction';
    process.env.MUSTER_SQLITE_FAULT_REMAINING = '5';
    try {
      const dbPath = tempDbPath();
      const client = makeClient(); // no faultCapability
      await client.open(dbPath);
      await client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-ambient', 'k', 'WS', 'now', 'now'],
        },
      ]);
      const rows = await client.all('SELECT id FROM workspaces');
      expect(rows).toHaveLength(1);
    } finally {
      delete process.env.MUSTER_SQLITE_FAULT_INJECT;
      delete process.env.MUSTER_SQLITE_FAULT_CODE;
      delete process.env.MUSTER_SQLITE_FAULT_OPERATION;
      delete process.env.MUSTER_SQLITE_FAULT_REMAINING;
    }
  }, 30_000);

  for (const code of ['full', 'readonly', 'io', 'busy'] as const) {
    it(`rolls back after statements run on injected ${code} without advancing revision`, async () => {
      const dbPath = tempDbPath();
      await seedWorkspace(dbPath);

      const baseline = makeClient();
      await baseline.open(dbPath);
      const baseRepo = new SqliteTaskRepository(baseline, 'ws');
      const beforeRevision = await baseRepo.getWorkspaceRevision();
      const beforeTasks = await baseRepo.listTasks('ws');
      await baseline.close();

      const client = makeClient({ faultCode: code, remaining: 1 });
      await client.open(dbPath);
      const repository = new SqliteTaskRepository(client, 'ws');

      try {
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: task('t-fail') });
        expect.unreachable('write must fail at commit boundary');
      } catch (error) {
        expect(error).toBeInstanceOf(DbWorkerError);
        const detail = (error as DbWorkerError).detail;
        expect(detail.code).toBe(code);
        expect(detail.operation).toBe('transaction');
        expect(detail.kind).toBe('operational');
        expect(JSON.stringify(detail)).not.toMatch(/INSERT|SELECT|\/Users\/|t-fail|payload/i);
      }

      expect(await repository.getWorkspaceRevision()).toBe(beforeRevision);
      const afterTasks = await repository.listTasks('ws');
      expect(afterTasks.map((t) => t.id).sort()).toEqual(beforeTasks.map((t) => t.id).sort());
      expect(afterTasks.some((t) => t.id === 't-fail')).toBe(false);

      await client.close();
      const reopened = makeClient();
      await reopened.open(dbPath);
      const repo2 = new SqliteTaskRepository(reopened, 'ws');
      expect(await repo2.getWorkspaceRevision()).toBe(beforeRevision);
      expect((await repo2.listTasks('ws')).map((t) => t.id).sort()).toEqual(
        beforeTasks.map((t) => t.id).sort(),
      );
    }, 30_000);
  }

  it('does not fire commit fault on conditional zero-change abort', async () => {
    const dbPath = tempDbPath();
    await seedWorkspace(dbPath);
    // remaining=1 but abortIfFirstUnchanged should return before fault.
    const client = makeClient({ faultCode: 'full', remaining: 1 });
    await client.open(dbPath);
    const results = await client.transaction(
      [
        {
          sql: 'UPDATE workspaces SET display_name = ? WHERE id = ?',
          params: ['never', 'missing'],
        },
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['should-not', 'k', 'WS', 'now', 'now'],
        },
      ],
      { abortIfFirstUnchanged: true },
    );
    expect(results[0]?.changes).toBe(0);
    // Fault remaining still 1 — a later real transaction should hit it.
    await expect(
      client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-hit', 'kh', 'WS', 'now', 'now'],
        },
      ]),
    ).rejects.toMatchObject({ detail: { code: 'full' } });
  }, 30_000);

  it('does not commit outbox or revision on injected full during putSendOutbox', async () => {
    const dbPath = tempDbPath();
    await seedWorkspace(dbPath);
    const base = makeClient();
    await base.open(dbPath);
    const beforeRevision = await new SqliteTaskRepository(base, 'ws').getWorkspaceRevision();
    await base.close();

    const client = makeClient({ faultCode: 'full', remaining: 1 });
    await client.open(dbPath);
    const repository = new SqliteTaskRepository(client, 'ws');

    await expect(
      repository.execute({
        kind: 'putSendOutbox',
        workspaceId: 'ws',
        entry: {
          clientRequestId: 'outbox-fail',
          status: 'pending',
          payload: { version: 1, text: 'must-not-persist' },
          createdAt: '2026-07-18T00:00:01.000Z',
          updatedAt: '2026-07-18T00:00:01.000Z',
        },
      }),
    ).rejects.toMatchObject({ detail: { code: 'full' } });

    expect(await repository.getWorkspaceRevision()).toBe(beforeRevision);
    expect(await repository.listSendOutbox()).toEqual([]);
  }, 30_000);

  it('projection/onAfterCommit stay silent when write fails', async () => {
    const dbPath = tempDbPath();
    await seedWorkspace(dbPath);
    const client = makeClient({ faultCode: 'io', remaining: 1 });
    await client.open(dbPath);
    const raw = new SqliteTaskRepository(client, 'ws');
    const projection = await RepositoryProjection.load(raw, 'ws');
    const before = structuredClone(projection.getFile());
    const beforeRevision = await raw.getWorkspaceRevision();
    const onAfterCommit = vi.fn();
    const repo = withRepositoryProjection(raw, projection, { onAfterCommit });

    await expect(
      repo.execute({ kind: 'createTask', workspaceId: 'ws', task: task('ghost') }),
    ).rejects.toMatchObject({ detail: { code: 'io' } });

    expect(onAfterCommit).not.toHaveBeenCalled();
    expect(projection.getFile()).toEqual(before);
    expect(await raw.getWorkspaceRevision()).toBe(beforeRevision);
  }, 30_000);

  it('latches client on corrupt and rejects future operations once after worker exit', async () => {
    const dbPath = tempDbPath();
    await seedWorkspace(dbPath);
    const terminal = vi.fn();
    const client = makeClient({ faultCode: 'corrupt', remaining: 1, onTerminal: terminal });
    await client.open(dbPath);

    await expect(
      client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-c', 'kc', 'WS', 'now', 'now'],
        },
      ]),
    ).rejects.toMatchObject({ detail: { code: 'corrupt' } });

    expect(terminal).toHaveBeenCalledTimes(1);
    // Allow worker exit/onFatal race window — first fatal must win.
    await new Promise((r) => setTimeout(r, 150));
    await expect(
      client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-c2', 'kc2', 'WS', 'now', 'now'],
        },
      ]),
    ).rejects.toMatchObject({ detail: { code: 'corrupt' } });
    expect(terminal).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('holds real lock longer than busyTimeout and SAME contender recovers after release', async () => {
    const dbPath = tempDbPath();
    await seedWorkspace(dbPath);
    const { Worker } = await import('node:worker_threads');
    const lockWorker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.path);
      db.exec('PRAGMA busy_timeout = 0');
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      parentPort.postMessage({ held: true });
      const end = Date.now() + workerData.holdMs;
      while (Date.now() < end) { /* hold lock */ }
      db.exec('COMMIT');
      db.close();
      parentPort.postMessage({ released: true });
      `,
      { eval: true, workerData: { path: dbPath, holdMs: 800 } },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('lock worker never held')), 5_000);
        lockWorker.once('message', (msg: { held?: boolean }) => {
          clearTimeout(timer);
          if (msg.held) resolve();
          else reject(new Error('lock not held'));
        });
        lockWorker.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const contender = makeClient();
      await contender.open(dbPath, 80);
      const started = Date.now();
      let ticks = 0;
      const heartbeat = setInterval(() => {
        ticks += 1;
      }, 20);
      let busyAttempts = 0;
      try {
        const busyWrite = (async () => {
          busyAttempts += 1;
          await contender.transaction([
            {
              sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                    VALUES (?,?,?,?,?)`,
              params: ['ws-busy', 'kb', 'WS', 'now', 'now'],
            },
          ]);
        })();
        // Hard ceiling so a stuck busy_timeout cannot hang the suite (CI load flake).
        await expect(
          Promise.race([
            busyWrite,
            new Promise((_, reject) =>
              setTimeout(() => reject(Object.assign(new Error('busy wait exceeded'), { detail: { code: 'busy' } })), 3_000),
            ),
          ]),
        ).rejects.toMatchObject({ detail: { code: 'busy' } });
        expect(Date.now() - started).toBeLessThan(3_500);
        expect(ticks).toBeGreaterThan(0);
        expect(busyAttempts).toBe(1);
      } finally {
        clearInterval(heartbeat);
      }

      // Wait for lock holder to finish (bounded).
      await Promise.race([
        new Promise<void>((resolve) => lockWorker.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);

      // SAME contender client recovers after release — no new client.
      await contender.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-after', 'ka', 'WS', 'now', 'now'],
        },
      ]);
      expect(await contender.all('SELECT id FROM workspaces WHERE id = ?', ['ws-after'])).toHaveLength(
        1,
      );
    } finally {
      await lockWorker.terminate().catch(() => undefined);
    }
  }, 15_000);

  it('stream timer path uses production persist adapter: exact one revision/feed/row', async () => {
    vi.useFakeTimers();
    try {
      const dbPath = tempDbPath();
      await seedWorkspace(dbPath);
      const setup = makeClient();
      await setup.open(dbPath);
      const setupRepo = new SqliteTaskRepository(setup, 'ws');
      await setupRepo.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: {
          id: 'turn-1',
          taskId: 't1',
          sequence: 1,
          status: 'running',
          trigger: 'user',
          inputs: [],
          createdAt: '2026-07-18T00:00:01.000Z',
          startedAt: '2026-07-18T00:00:01.000Z',
        },
      });
      const beforeRevision = await setupRepo.getWorkspaceRevision();
      await setup.close();

      const faultClient = makeClient({ faultCode: 'full', remaining: 1 });
      await faultClient.open(dbPath);
      const repository = new SqliteTaskRepository(faultClient, 'ws');
      const { TranscriptStreamBatcher } = await import('../transcript-stream-batcher');
      const { createTranscriptStreamPersist } = await import('../transcript-stream-persist');
      const onTimerFlushError = vi.fn(async () => undefined);
      let persistAttempts = 0;
      const productionPersist = createTranscriptStreamPersist({
        repository,
        workspaceId: 'ws',
      });
      const batcher = new TranscriptStreamBatcher({
        windowMs: 75,
        persist: async (payload) => {
          persistAttempts += 1;
          return productionPersist(payload);
        },
        onTimerFlushError,
      });

      batcher.noteAssistant({
        storeId: 'turn-1:0',
        sourceMessageId: 'src',
        content: 'hello-stream',
        createdAt: '2026-07-18T00:00:02.000Z',
        order: 0,
        taskId: 't1',
        turnId: 'turn-1',
      });
      await vi.advanceTimersByTimeAsync(80);
      await vi.waitFor(() => expect(onTimerFlushError).toHaveBeenCalledTimes(1));
      expect(batcher.hasPending('turn-1')).toBe(true);
      expect(await repository.getWorkspaceRevision()).toBe(beforeRevision);
      expect(await repository.listMessages('t1')).toHaveLength(0);
      const feedFail = await repository.getWorkspaceChangesSince(beforeRevision);
      expect(feedFail.kind).toBe('changes');
      if (feedFail.kind === 'changes') expect(feedFail.revisions).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(500);
      expect(onTimerFlushError).toHaveBeenCalledTimes(1);
      expect(persistAttempts).toBe(1);

      const ok = await batcher.flushTurn('turn-1');
      expect(ok.ok).toBe(true);
      expect(batcher.hasPending('turn-1')).toBe(false);
      expect(await repository.getWorkspaceRevision()).toBe(beforeRevision + 1);
      const messages = await repository.listMessages('t1');
      expect(messages.filter((m) => m.id === 'turn-1:0')).toHaveLength(1);
      const feedOk = await repository.getWorkspaceChangesSince(beforeRevision);
      expect(feedOk.kind).toBe('changes');
      if (feedOk.kind === 'changes') {
        expect(feedOk.revisions).toHaveLength(1);
        expect(feedOk.revisions[0]?.revision).toBe(beforeRevision + 1);
      }
      expect(persistAttempts).toBe(2);

      await faultClient.close();
      const reopened = makeClient();
      await reopened.open(dbPath);
      const repo2 = new SqliteTaskRepository(reopened, 'ws');
      expect(await repo2.getWorkspaceRevision()).toBe(beforeRevision + 1);
      expect((await repo2.listMessages('t1')).filter((m) => m.id === 'turn-1:0')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('statement constraint wins over armed commit fault; fault remains for next txn', async () => {
    const dbPath = tempDbPath();
    await seedWorkspace(dbPath);
    const client = makeClient({ faultCode: 'full', remaining: 1 });
    await client.open(dbPath);
    const beforeRevision = await new SqliteTaskRepository(client, 'ws').getWorkspaceRevision();
    // Real constraint: duplicate workspace primary key.
    await expect(
      client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws', 'dup-key', 'WS', 'now', 'now'],
        },
      ]),
    ).rejects.toMatchObject({ detail: { code: 'constraint' } });
    expect(await new SqliteTaskRepository(client, 'ws').getWorkspaceRevision()).toBe(beforeRevision);
    // Fault still armed — next valid txn hits full.
    await expect(
      client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-hit', 'kh', 'WS', 'now', 'now'],
        },
      ]),
    ).rejects.toMatchObject({ detail: { code: 'full' } });
    expect(await client.all('SELECT id FROM workspaces WHERE id = ?', ['ws-hit'])).toHaveLength(0);
  }, 30_000);

  it('failed appendTranscriptBatch leaves change-feed empty and reopen at pre-error revision', async () => {
    const dbPath = tempDbPath();
    await seedWorkspace(dbPath);
    const setup = makeClient();
    await setup.open(dbPath);
    const setupRepo = new SqliteTaskRepository(setup, 'ws');
    await setupRepo.execute({
      kind: 'createTurn',
      workspaceId: 'ws',
      turn: {
        id: 'turn-x',
        taskId: 't1',
        sequence: 1,
        status: 'running',
        trigger: 'user',
        inputs: [],
        createdAt: '2026-07-18T00:00:01.000Z',
        startedAt: '2026-07-18T00:00:01.000Z',
      },
    });
    const beforeRevision = await setupRepo.getWorkspaceRevision();
    await setup.close();

    const client = makeClient({ faultCode: 'io', remaining: 1 });
    await client.open(dbPath);
    const repository = new SqliteTaskRepository(client, 'ws');
    await expect(
      repository.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: 'ws',
        taskId: 't1',
        messages: [
          {
            id: 'm-fail',
            taskId: 't1',
            turnId: 'turn-x',
            role: 'assistant',
            state: 'complete',
            content: 'nope',
            createdAt: '2026-07-18T00:00:02.000Z',
          },
        ],
      }),
    ).rejects.toMatchObject({ detail: { code: 'io' } });
    expect(await repository.getWorkspaceRevision()).toBe(beforeRevision);
    const feed = await repository.getWorkspaceChangesSince(beforeRevision);
    expect(feed.kind).toBe('changes');
    if (feed.kind === 'changes') expect(feed.revisions).toHaveLength(0);
    await client.close();
    const reopened = makeClient();
    await reopened.open(dbPath);
    const repo2 = new SqliteTaskRepository(reopened, 'ws');
    expect(await repo2.getWorkspaceRevision()).toBe(beforeRevision);
    expect((await repo2.listMessages('t1')).some((m) => m.id === 'm-fail')).toBe(false);

    // Successful retry advances exactly one revision.
    await repo2.execute({
      kind: 'appendTranscriptBatch',
      workspaceId: 'ws',
      taskId: 't1',
      messages: [
        {
          id: 'm-ok',
          taskId: 't1',
          turnId: 'turn-x',
          role: 'assistant',
          state: 'complete',
          content: 'ok',
          createdAt: '2026-07-18T00:00:03.000Z',
        },
      ],
    });
    expect(await repo2.getWorkspaceRevision()).toBe(beforeRevision + 1);
  }, 30_000);
});
