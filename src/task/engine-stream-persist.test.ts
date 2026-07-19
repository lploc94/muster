import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskEngine } from './engine';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask } from './types';

const WORKER_TS = path.join(__dirname, 'sqlite/worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const tempDirs: string[] = [];
const clients: DbClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function task(id: string): MusterTask {
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
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 },
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

async function seedTurn(repository: SqliteTaskRepository, taskId: string, turnId: string) {
  const t = task(taskId);
  await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: t });
  await repository.execute({
    kind: 'createTurn',
    workspaceId: 'ws',
    turn: {
      id: turnId,
      taskId: t.id,
      sequence: 1,
      status: 'queued',
      trigger: 'engine',
      inputs: [],
      createdAt: '2026-07-16T00:00:01.000Z',
      runtimeEpoch: 1,
    },
  });
  return t;
}

describe('TaskEngine immediate stream-boundary persistence (P5-W3 residual A)', () => {
  it('delta then return <75ms: one-shot fail then retry persists + failed + no claim', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-stream-fast-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'stream-fast',
      displayName: 'Stream',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    const t = await seedTurn(repository, 'fast-task', 'fast-turn');

    let appendAttempts = 0;
    const originalExecute = repository.execute.bind(repository);
    repository.execute = async (command) => {
      if (command.kind === 'appendTranscriptBatch') {
        appendAttempts += 1;
        if (appendAttempts === 1) {
          throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
        }
      }
      return originalExecute(command);
    };

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'assistantDelta',
          messageId: 'src-1',
          content: 'must survive',
        };
        // Return immediately — before 75ms timer — so boundary flush is first attempt.
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'fast-turn');
    await engine.whenIdle().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(appendAttempts).toBe(2);
    const messages = (await repository.listMessages(t.id)).filter((m) => m.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('must survive');
    const turn = await repository.getTurn('fast-turn');
    expect(turn?.status).toBe('failed');
    expect(await repository.getRuntimeClaim('fast-turn')).toBeUndefined();

    await client.close();
    const reopened = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(reopened);
    await reopened.open(path.join(dir, 'muster.sqlite3'));
    const repo2 = new SqliteTaskRepository(reopened, 'ws');
    expect(
      (await repo2.listMessages(t.id)).filter((m) => m.role === 'assistant'),
    ).toHaveLength(1);
  }, 60_000);

  it('delta then throw <75ms: same bounded retry + failed + no claim', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-stream-throw-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'stream-throw',
      displayName: 'Stream',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    const t = await seedTurn(repository, 'throw-task', 'throw-turn');

    let appendAttempts = 0;
    const originalExecute = repository.execute.bind(repository);
    repository.execute = async (command) => {
      if (command.kind === 'appendTranscriptBatch') {
        appendAttempts += 1;
        if (appendAttempts === 1) {
          throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
        }
      }
      return originalExecute(command);
    };

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'assistantDelta',
          messageId: 'src-1',
          content: 'must survive throw',
        };
        throw new Error('backend crashed');
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'throw-turn');
    await engine.whenIdle().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(appendAttempts).toBe(2);
    const messages = (await repository.listMessages(t.id)).filter((m) => m.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('must survive throw');
    expect((await repository.getTurn('throw-turn'))?.status).toBe('failed');
    expect(await repository.getRuntimeClaim('throw-turn')).toBeUndefined();
  }, 60_000);

  it('persistent failure at immediate boundary: 2 attempts, no false success, never running+no claim', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-stream-persist-fail-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'stream-pfail',
      displayName: 'Stream',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    const t = await seedTurn(repository, 'pfail-task', 'pfail-turn');

    let appendAttempts = 0;
    let failAppend = true;
    const originalExecute = repository.execute.bind(repository);
    repository.execute = async (command) => {
      if (command.kind === 'appendTranscriptBatch' && failAppend) {
        appendAttempts += 1;
        throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
      }
      if (command.kind === 'appendTranscriptBatch') {
        appendAttempts += 1;
      }
      return originalExecute(command);
    };

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'assistantDelta',
          messageId: 'src-1',
          content: 'dirty retain',
        };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'pfail-turn');
    await engine.whenIdle().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(appendAttempts).toBe(2);
    expect(await repository.listMessages(t.id)).toHaveLength(0);
    const turn = await repository.getTurn('pfail-turn');
    // Must not be success; never running without claim.
    expect(turn?.status).not.toBe('succeeded');
    if (turn?.status === 'running') {
      expect(await repository.getRuntimeClaim('pfail-turn')).toBeDefined();
    } else {
      // Settled failed after persistent append failure is also valid.
      expect(turn?.status).toBe('failed');
      expect(await repository.getRuntimeClaim('pfail-turn')).toBeUndefined();
    }

    // Public recovery must flush the retained engine buffer. Do not reconstruct
    // or insert the message directly through the repository in this proof.
    failAppend = false;
    await engine.flushPendingTranscriptForTask(t.id);
    expect(appendAttempts).toBe(3);
    expect(
      (await repository.listMessages(t.id)).filter((m) => m.content === 'dirty retain'),
    ).toHaveLength(1);

    await engine.shutdown();
    await client.close();
    const reopened = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(reopened);
    await reopened.open(path.join(dir, 'muster.sqlite3'));
    const repo2 = new SqliteTaskRepository(reopened, 'ws');
    expect(
      (await repo2.listMessages(t.id)).filter((m) => m.content === 'dirty retain'),
    ).toHaveLength(1);
  }, 60_000);

  it('settlement read failure reuses the same finish promise and never starts a third retry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-stream-finish-latch-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'stream-finish-latch',
      displayName: 'Stream',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    const t = await seedTurn(repository, 'latch-task', 'latch-turn');

    let appendAttempts = 0;
    let failAppend = true;
    let failSettlementRead = false;
    const originalExecute = repository.execute.bind(repository);
    repository.execute = async (command) => {
      if (command.kind === 'appendTranscriptBatch') {
        appendAttempts += 1;
        if (failAppend) {
          if (appendAttempts === 2) failSettlementRead = true;
          throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
        }
      }
      return originalExecute(command);
    };
    const originalGetTurn = repository.getTurn.bind(repository);
    repository.getTurn = async (turnId) => {
      if (turnId === 'latch-turn' && failSettlementRead) {
        failSettlementRead = false;
        throw Object.assign(new Error('transient read I/O'), { code: 'SQLITE_IOERR' });
      }
      return originalGetTurn(turnId);
    };

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'assistantDelta',
          messageId: 'src-1',
          content: 'finish once',
        };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'latch-turn');
    await engine.whenIdle().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(appendAttempts).toBe(2);
    expect((await repository.getTurn('latch-turn'))?.status).toBe('running');
    expect(await repository.getRuntimeClaim('latch-turn')).toBeDefined();
    expect(await repository.listMessages(t.id)).toHaveLength(0);

    failAppend = false;
    await engine.flushPendingTranscriptForTask(t.id);
    expect(appendAttempts).toBe(3);
    expect(
      (await repository.listMessages(t.id)).filter((m) => m.content === 'finish once'),
    ).toHaveLength(1);
    // Recovery persisted the retained content, but did not invent a terminal
    // settlement. The running turn therefore keeps its durable claim.
    expect((await repository.getTurn('latch-turn'))?.status).toBe('running');
    expect(await repository.getRuntimeClaim('latch-turn')).toBeDefined();
    engine.quiesceForTerminalStorage();
  }, 60_000);

  it('timer path one-shot still works with bounded retry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-stream-timer-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'stream-timer',
      displayName: 'Stream',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    const t = await seedTurn(repository, 'timer-task', 'timer-turn');

    let appendAttempts = 0;
    const originalExecute = repository.execute.bind(repository);
    repository.execute = async (command) => {
      if (command.kind === 'appendTranscriptBatch') {
        appendAttempts += 1;
        if (appendAttempts === 1) {
          throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
        }
      }
      return originalExecute(command);
    };

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'assistantDelta',
          messageId: 'src-1',
          content: 'timer survive',
        };
        await new Promise((r) => setTimeout(r, 200));
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'timer-turn');
    await engine.whenIdle().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(appendAttempts).toBe(2);
    expect(
      (await repository.listMessages(t.id)).filter((m) => m.role === 'assistant'),
    ).toHaveLength(1);
    expect((await repository.getTurn('timer-turn'))?.status).toBe('failed');
  }, 60_000);
});
