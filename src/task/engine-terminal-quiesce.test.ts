import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskEngine } from './engine';
import { SqliteTaskRepository, type TaskRepository } from './repository';
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

function instrumentRepository(repository: TaskRepository): {
  calls: string[];
  clear: () => void;
} {
  const calls: string[] = [];
  const proto = Object.getPrototypeOf(repository) as object;
  const names = new Set<string>();
  let cur: object | null = proto;
  while (cur && cur !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cur)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(cur, name);
      if (desc && typeof desc.value === 'function') names.add(name);
    }
    cur = Object.getPrototypeOf(cur);
  }
  for (const name of names) {
    const original = (repository as unknown as Record<string, unknown>)[name];
    if (typeof original !== 'function') continue;
    (repository as unknown as Record<string, unknown>)[name] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (name === 'execute') {
        const cmd = args[0] as { kind?: string } | undefined;
        calls.push(cmd?.kind ? `execute:${cmd.kind}` : 'execute');
      } else {
        calls.push(name);
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  return {
    calls,
    clear: () => {
      calls.length = 0;
    },
  };
}

async function seedQueuedTurn(repository: SqliteTaskRepository, taskId: string, turnId: string) {
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
}

describe('TaskEngine.quiesceForTerminalStorage live turn', () => {
  it('idle engine: zero repository writes and rejects new send', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-terminal-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'terminal-q',
      displayName: 'Terminal',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    const executeSpy = vi.spyOn(repository, 'execute');
    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () =>
        ({
          name: 'fake',
          capabilities: { mcp: true },
        }) as never,
    });
    executeSpy.mockClear();
    engine.quiesceForTerminalStorage();
    expect(engine.isStorageTerminal()).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();

    const send = await engine.sendAsync('missing', 'hello', { clientRequestId: 'c1' });
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.reason).toMatch(/storage terminal/i);
    expect(executeSpy).not.toHaveBeenCalled();

    await engine.shutdown();
    expect(executeSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('live turn: zero repository reads/writes after terminal latch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-live-terminal-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'live-term',
      displayName: 'Live term',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    await seedQueuedTurn(repository, 'live-task', 'live-turn');

    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let runActive!: () => void;
    const active = new Promise<void>((resolve) => {
      runActive = resolve;
    });

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* (_backend, options) {
        runActive();
        await streamGate;
        if (!options.signal?.aborted) {
          yield { type: 'turnCompleted' };
        }
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    const turnPromise = engine.resumeQueuedTurnAsync('live-task', 'live-turn');
    await active;
    // Wait for claim + projection afterExecute tail before measuring post-latch I/O.
    await vi.waitFor(async () => {
      expect(await repository.getRuntimeClaim('live-turn')).toBeDefined();
    });
    await new Promise((r) => setTimeout(r, 50));

    const instrument = instrumentRepository(repository);
    instrument.clear();
    engine.quiesceForTerminalStorage();
    expect(engine.isStorageTerminal()).toBe(true);
    instrument.clear();

    releaseStream();
    await turnPromise.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(instrument.calls).toEqual([]);

    const turn = await new SqliteTaskRepository(client, 'ws').getTurn('live-turn');
    expect(turn?.status).not.toBe('succeeded');
  }, 30_000);

  it('watchdog past deadline after latch: zero post-latch repository calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-wd-terminal-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'wd-term',
      displayName: 'WD',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    await seedQueuedTurn(repository, 'wd-task', 'wd-turn');

    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let runActive!: () => void;
    const active = new Promise<void>((resolve) => {
      runActive = resolve;
    });

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      getRunLimitMs: () => 1_000,
      runTurn: async function* (_backend, options) {
        runActive();
        // Ignore abort; stay blocked past watchdog.
        await streamGate;
        void options.signal;
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    const turnPromise = engine.resumeQueuedTurnAsync('wd-task', 'wd-turn');
    await active;
    await vi.waitFor(async () => {
      expect(await repository.getRuntimeClaim('wd-turn')).toBeDefined();
    });
    await new Promise((r) => setTimeout(r, 50));
    const instrument = instrumentRepository(repository);
    instrument.clear();
    engine.quiesceForTerminalStorage();
    instrument.clear();
    // Wait past 1s deadline so a non-cleared watchdog would fire.
    await new Promise((r) => setTimeout(r, 1_200));
    releaseStream();
    await turnPromise.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(instrument.calls).toEqual([]);
  }, 30_000);

  it('late backend event after latch: zero post-latch repository calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-late-terminal-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'late-term',
      displayName: 'Late',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    await seedQueuedTurn(repository, 'late-task', 'late-turn');

    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let runActive!: () => void;
    const active = new Promise<void>((resolve) => {
      runActive = resolve;
    });

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        runActive();
        await streamGate;
        yield { type: 'assistantDelta', messageId: 'm1', content: 'late' };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    const turnPromise = engine.resumeQueuedTurnAsync('late-task', 'late-turn');
    await active;
    await vi.waitFor(async () => {
      expect(await repository.getRuntimeClaim('late-turn')).toBeDefined();
    });
    await new Promise((r) => setTimeout(r, 50));
    const instrument = instrumentRepository(repository);
    instrument.clear();
    engine.quiesceForTerminalStorage();
    instrument.clear();
    releaseStream();
    await turnPromise.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(instrument.calls).toEqual([]);
  }, 30_000);

  it('onBeforePrompt after latch: zero post-latch repository calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-prompt-terminal-'));
    tempDirs.push(dir);
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'prompt-term',
      displayName: 'Prompt',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    await seedQueuedTurn(repository, 'prompt-task', 'prompt-turn');

    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let reachedBeforePrompt = false;

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* (_backend, options) {
        if (options.onBeforePrompt) {
          reachedBeforePrompt = true;
          await promptGate;
          await options.onBeforePrompt();
        }
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    const turnPromise = engine.resumeQueuedTurnAsync('prompt-task', 'prompt-turn');
    await vi.waitFor(() => expect(reachedBeforePrompt).toBe(true));
    await vi.waitFor(async () => {
      expect(await repository.getRuntimeClaim('prompt-turn')).toBeDefined();
    });
    await new Promise((r) => setTimeout(r, 50));
    const instrument = instrumentRepository(repository);
    instrument.clear();
    engine.quiesceForTerminalStorage();
    instrument.clear();
    releasePrompt();
    await turnPromise.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(instrument.calls).toEqual([]);
  }, 30_000);
});
