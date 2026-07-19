import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskEngine } from './engine';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask } from './types';
import { CredentialRegistry } from '../bridge/credentials';
import { deriveEntityId } from './engine-graph';
import { parseTaskTypeRegistry } from './task-types';
import { RepositoryProjection, withRepositoryProjection } from './repository-projection';

function currentTask(id: string, overrides: Partial<MusterTask> = {}): MusterTask {
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
    ...overrides,
  };
}

describe('TaskEngine repository-only boundary', () => {
  it('hydrates live operation/cancel/runtime coordination rows on reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-coordination-reload-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'coord-reload', displayName: 'Coord reload', createdAt: 'now', lastOpenedAt: 'now' });
      const task: MusterTask = {
        id: 'reload-task', role: 'coordinator', lifecycle: 'open', goal: 'reload coordination',
        parentId: null, dependencies: [], backend: 'grok', capabilities: ['create_child'],
        executionPolicy: { maxTurns: 4, maxAutomaticRetries: 0 }, releaseState: 'released',
        revision: 0, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
      };
      const turn = {
        id: 'reload-turn', taskId: task.id, sequence: 1, status: 'running' as const,
        trigger: 'user' as const, inputs: [], createdAt: '2026-07-16T00:00:01.000Z',
      };
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
      await repository.execute({
        kind: 'putOperation', workspaceId: 'ws', ledgerKey: `${turn.id}:op`,
        entry: { fingerprint: 'fp', result: { ok: true, data: { replay: true } } }, createdAt: 'now',
      });
      await repository.execute({
        kind: 'claimRuntime', workspaceId: 'ws', turnId: turn.id, ownerId: 'owner',
        claimedAt: 'now', heartbeatAt: 'now', expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const projection = await RepositoryProjection.load(repository, 'ws');
      const wrapped = withRepositoryProjection(repository, projection);
      expect(projection.getFile().operations?.[`${turn.id}:op`]?.result.data).toEqual({ replay: true });
      expect(projection.getFile().runtimeClaims?.[turn.id]?.ownerId).toBe('owner');
      await wrapped.execute({
        kind: 'putCancelRequest', workspaceId: 'ws', turnId: turn.id,
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-op', at: 'now' },
      });
      expect(projection.getFile().cancelRequests?.[turn.id]?.opId).toBe('cancel-op');
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('dispatches and settles with SQLite repository projection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-repository-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'engine-repository', displayName: 'Engine repository', createdAt: 'now', lastOpenedAt: 'now' });
      const task: MusterTask = {
        id: 'repository-task', role: 'worker', lifecycle: 'open', goal: 'run through sqlite',
        parentId: null, dependencies: [], backend: 'fake', capabilities: [],
        executionPolicy: { maxTurns: 4, maxAutomaticRetries: 0 }, releaseState: 'released',
        revision: 0, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
      };
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: {
        id: 'repository-turn', taskId: task.id, sequence: 1, status: 'queued', trigger: 'engine',
        inputs: [], createdAt: '2026-07-16T00:00:01.000Z', runtimeEpoch: 1,
      } });
      const engine = await TaskEngine.loadAsync({
        repository, workspaceId: 'ws', makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        runTurn: async function* () { yield { type: 'turnCompleted' }; },
        clock: () => '2026-07-16T00:00:02.000Z',
      });
      await expect(engine.resumeQueuedTurnAsync(task.id, 'repository-turn')).resolves.toEqual({ ok: true, value: undefined });
      await engine.whenIdle();
      await expect(repository.getTurn('repository-turn')).resolves.toMatchObject({ status: 'succeeded' });
      await expect(repository.getRuntimeClaim('repository-turn')).resolves.toBeUndefined();
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('fails a live turn exactly once when a timer stream flush cannot persist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-stream-failure-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'stream-failure', displayName: 'Stream failure', createdAt: 'now', lastOpenedAt: 'now' });
      const task = currentTask('stream-failure-task');
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws', turn: {
          id: 'stream-failure-turn', taskId: task.id, sequence: 1, status: 'queued',
          trigger: 'engine', inputs: [], createdAt: '2026-07-16T00:00:01.000Z', runtimeEpoch: 1,
        },
      });

      const execute = repository.execute.bind(repository);
      let appendAttempts = 0;
      vi.spyOn(repository, 'execute').mockImplementation(async (command) => {
        if (command.kind === 'appendTranscriptBatch') {
          appendAttempts += 1;
          return { changed: false, reason: 'injected disk full' };
        }
        return execute(command);
      });
      const engine = await TaskEngine.loadAsync({
        repository,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        runTurn: async function* (_backend, options) {
          yield { type: 'assistantDelta', messageId: 'assistant-1', content: 'durable me' };
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          if (!options.signal?.aborted) yield { type: 'turnCompleted' };
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      await engine.resumeQueuedTurnAsync(task.id, 'stream-failure-turn');
      await engine.whenIdle();

      // Timer flush + one bounded lifecycle-boundary retry.
      expect(appendAttempts).toBe(2);
      await expect(repository.getTurn('stream-failure-turn')).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('injected disk full'),
      });
    } finally {
      vi.restoreAllMocks();
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('flushes the pending stream batch before committing a local interrupt request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-stream-interrupt-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let deltaProcessed!: () => void;
    const processed = new Promise<void>((resolve) => { deltaProcessed = resolve; });
    let engine: TaskEngine | undefined;
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'stream-interrupt', displayName: 'Stream interrupt', createdAt: 'now', lastOpenedAt: 'now' });
      const task = currentTask('stream-interrupt-task');
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws', turn: {
          id: 'stream-interrupt-turn', taskId: task.id, sequence: 1, status: 'queued',
          trigger: 'engine', inputs: [], createdAt: '2026-07-16T00:00:01.000Z', runtimeEpoch: 1,
        },
      });

      const durableOrder: string[] = [];
      const execute = repository.execute.bind(repository);
      vi.spyOn(repository, 'execute').mockImplementation(async (command) => {
        if (command.kind === 'appendTranscriptBatch' || command.kind === 'putCancelRequest') {
          durableOrder.push(command.kind);
        }
        return execute(command);
      });
      engine = await TaskEngine.loadAsync({
        repository,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        runTurn: async function* () {
          yield { type: 'assistantDelta', messageId: 'assistant-1', content: 'last window' };
          deltaProcessed();
          await gate;
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      const runPromise = engine.resumeQueuedTurnAsync(task.id, 'stream-interrupt-turn');
      await processed;
      await expect(engine.interruptTurnAsync('stream-interrupt-turn')).resolves.toEqual({
        ok: true,
        value: undefined,
      });
      expect(durableOrder.slice(-2)).toEqual(['appendTranscriptBatch', 'putCancelRequest']);
      expect((await repository.listMessages(task.id)).some(
        (message) => message.content === 'last window',
      )).toBe(true);
      release();
      await runPromise;
    } finally {
      release();
      await engine?.whenIdle();
      vi.restoreAllMocks();
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('shutdown flushes before abort and awaits forced turn settlement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-stream-shutdown-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    let engine: TaskEngine | undefined;
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'stream-shutdown', displayName: 'Stream shutdown', createdAt: 'now', lastOpenedAt: 'now' });
      const task = currentTask('stream-shutdown-task');
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws', turn: {
          id: 'stream-shutdown-turn', taskId: task.id, sequence: 1, status: 'queued',
          trigger: 'engine', inputs: [], createdAt: '2026-07-16T00:00:01.000Z', runtimeEpoch: 1,
        },
      });
      engine = await TaskEngine.loadAsync({
        repository,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        runTurn: async function* (_backend, options) {
          yield { type: 'assistantDelta', messageId: 'assistant-1', content: 'before shutdown' };
          started();
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve();
            else options.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          // A misbehaving adapter may emit once after abort. The shutdown gate
          // must ignore this late event rather than opening a new dirty window.
          yield { type: 'assistantDelta', messageId: 'assistant-1', content: 'late' };
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      const runPromise = engine.resumeQueuedTurnAsync(task.id, 'stream-shutdown-turn');
      await streaming;
      await engine.shutdown();
      await runPromise;

      const messages = await repository.listMessages(task.id);
      expect(messages.find((message) => message.id === 'stream-shutdown-turn:0')?.content).toBe(
        'before shutdown',
      );
      await expect(repository.getTurn('stream-shutdown-turn')).resolves.toMatchObject({
        status: 'interrupted',
        interruptConfidence: 'forced',
      });
    } finally {
      await engine?.shutdown().catch(() => undefined);
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('reconciles a completed child wait into a deferred SQLite continuation on reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-child-wait-reload-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let runCalls = 0;
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'child-wait-reload',
        displayName: 'Child wait reload', createdAt: 'now', lastOpenedAt: 'now',
      });
      const waitTurnId = 'wait-turn';
      const parent = currentTask('parent', {
        role: 'coordinator',
        wait: {
          kind: 'children', taskIds: ['child'], registeredByTurnId: waitTurnId,
          wakeOn: ['terminal'],
        },
      });
      const child = currentTask('child', {
        parentId: parent.id,
        lifecycle: 'succeeded',
        taskResult: { version: 1, revision: 1, summary: 'done' },
        finishedAt: '2026-07-16T00:00:01.000Z',
      });
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: parent });
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws', turn: {
          id: waitTurnId, taskId: parent.id, sequence: 1, status: 'succeeded',
          trigger: 'engine', inputs: [], createdAt: '2026-07-16T00:00:00.000Z',
          finishedAt: '2026-07-16T00:00:00.500Z',
        },
      });

      const engine = await TaskEngine.loadAsync({
        repository,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        runTurn: async function* () {
          runCalls += 1;
          yield { type: 'turnCompleted' };
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      const continuationId = `${waitTurnId}-continuation`;
      await expect(repository.getTurn(continuationId)).resolves.toMatchObject({
        taskId: parent.id,
        status: 'queued',
        inputs: [{ kind: 'child_results', taskIds: [child.id] }],
      });
      expect((await repository.getTask(parent.id))?.wait).toBeUndefined();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(runCalls).toBe(0);

      await expect(engine.resumeQueuedTurnAsync(parent.id, continuationId)).resolves.toEqual({
        ok: true,
        value: undefined,
      });
      await engine.whenIdle();
      expect(runCalls).toBe(1);
      await expect(repository.getTurn(continuationId)).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('interrupts an unclaimed live turn and holds its queued follow-up on SQLite reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-orphan-reload-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'orphan-reload',
        displayName: 'Orphan reload', createdAt: 'now', lastOpenedAt: 'now',
      });
      const task = currentTask('orphan-task');
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws', turn: {
          id: 'live-turn', taskId: task.id, sequence: 1, status: 'running', trigger: 'user',
          inputs: [], createdAt: '2026-07-16T00:00:01.000Z', startedAt: '2026-07-16T00:00:01.500Z',
        },
      });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws', turn: {
          id: 'follow-up', taskId: task.id, sequence: 2, status: 'queued', trigger: 'user',
          inputs: [], createdAt: '2026-07-16T00:00:02.000Z',
        },
      });

      await TaskEngine.loadAsync({
        repository,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        clock: () => '2026-07-16T00:00:03.000Z',
      });

      await expect(repository.getTurn('live-turn')).resolves.toMatchObject({
        status: 'interrupted',
        failureClass: 'uncertain',
        dispatchPhase: 'prompt_outstanding',
      });
      await expect(repository.getTurn('follow-up')).resolves.toMatchObject({
        status: 'queued',
        holdAutoPromote: true,
      });
      await expect(repository.getRuntimeClaim('live-turn')).resolves.toBeUndefined();
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('edits and deletes queued follow-ups through the async SQLite engine boundary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-queued-mutations-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let engine: TaskEngine | undefined;
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'queued-mutations',
        displayName: 'Queued mutations', createdAt: 'now', lastOpenedAt: 'now',
      });
      engine = await TaskEngine.loadAsync({
        repository,
        workspaceId: 'ws',
        makeBackend: () => ({
          name: 'fake',
          capabilities: { supportsMCP: true, supportsReasoning: false, supportsDetailedToolEvents: false },
          run: async function* () {},
        }),
        runTurn: async function* () {
          await gate;
          yield { type: 'turnCompleted' };
        },
        clock: () => '2026-07-16T00:00:05.000Z',
      });
      const started = await engine.startNewTask({ goal: 'queue mutations', backend: 'fake' });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await repository.getTurn(started.value.turnId))?.status === 'running') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await expect(repository.getTurn(started.value.turnId)).resolves.toMatchObject({ status: 'running' });

      const queued = await engine.sendAsync(started.value.taskId, 'original follow-up');
      expect(queued.ok).toBe(true);
      if (!queued.ok || !queued.value.turnId) return;
      await expect(repository.getTurn(queued.value.turnId)).resolves.toMatchObject({ status: 'queued' });

      await expect(engine.editQueuedTurnAsync(
        started.value.taskId,
        queued.value.turnId,
        '  revised follow-up  ',
      )).resolves.toMatchObject({ ok: true });
      expect((await repository.listMessages(started.value.taskId)).find(
        (message) => message.id === queued.value.messageId,
      )?.content).toBe('revised follow-up');

      await expect(engine.deleteQueuedTurnAsync(
        started.value.taskId,
        queued.value.turnId,
      )).resolves.toMatchObject({
        ok: true,
        value: { turnId: queued.value.turnId, deletedMessageIds: [queued.value.messageId] },
      });
      await expect(repository.getTurn(queued.value.turnId)).resolves.toBeUndefined();
      expect((await repository.listMessages(started.value.taskId)).some(
        (message) => message.id === queued.value.messageId,
      )).toBe(false);

      await expect(engine.stageDispositionAsync(
        started.value.turnId,
        { kind: 'idle' },
        'queued-mutations-idle',
      )).resolves.toEqual({ ok: true, value: undefined });
      release();
      await engine.whenIdle();
      await expect(repository.getTurn(started.value.turnId)).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      release();
      await engine?.whenIdle();
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('applies dependency terminal policy before a queued SQLite turn can dispatch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-dependency-terminal-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let runCalls = 0;
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'dependency-terminal',
        displayName: 'Dependency terminal', createdAt: 'now', lastOpenedAt: 'now',
      });
      const producer = currentTask('producer', {
        lifecycle: 'failed',
        error: 'producer failed',
        finishedAt: '2026-07-16T00:00:01.000Z',
      });
      const dependent = currentTask('dependent', {
        dependencies: [{ taskId: producer.id, requiredOutcome: 'succeeded', onUnsatisfied: 'skip' }],
      });
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: producer });
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: dependent });
      await repository.execute({
        kind: 'createTurn', workspaceId: 'ws', turn: {
          id: 'dependent-turn', taskId: dependent.id, sequence: 1, status: 'queued', trigger: 'engine',
          inputs: [], createdAt: '2026-07-16T00:00:02.000Z',
        },
      });
      const engine = await TaskEngine.loadAsync({
        repository,
        workspaceId: 'ws',
        makeBackend: () => ({ name: 'fake', run: async function* () {} }),
        runTurn: async function* () {
          runCalls += 1;
          yield { type: 'turnCompleted' };
        },
        clock: () => '2026-07-16T00:00:03.000Z',
      });

      await expect(engine.resumeQueuedTurnAsync(dependent.id, 'dependent-turn')).resolves.toEqual({
        ok: true,
        value: undefined,
      });
      await engine.whenIdle();
      expect(runCalls).toBe(0);
      await expect(repository.getTask(dependent.id)).resolves.toMatchObject({
        lifecycle: 'skipped',
        sealedBy: { kind: 'coordinator', mode: 'dependency_policy' },
      });
      await expect(repository.getTurn('dependent-turn')).resolves.toMatchObject({ status: 'cancelled' });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs graph create/replay/conflict behavior through the SQLite projection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-engine-graph-repository-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let engine: TaskEngine | undefined;
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'engine-graph-repository', displayName: 'Engine graph repository', createdAt: 'now', lastOpenedAt: 'now' });
      const credentials = new CredentialRegistry();
      engine = await TaskEngine.loadAsync({
        repository,
        workspaceId: 'ws',
        credentialRegistry: credentials,
        makeBackend: (name) => ({
          name,
          capabilities: { supportsMCP: true, supportsReasoning: false, supportsDetailedToolEvents: false },
          run: async function* () {},
        }),
        runTurn: async function* () {
          await gate;
          yield { type: 'turnCompleted' };
        },
        getTaskTypeRegistry: () => parseTaskTypeRegistry({
          worker: { backend: 'grok', role: 'worker', briefKind: 'generic' },
        }),
      });
      const started = await engine.startNewTask({ goal: 'coordinate via sqlite', backend: 'grok', role: 'coordinator' });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const { taskId, turnId } = started.value;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await repository.getTurn(turnId))?.status === 'running') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await expect(repository.getTurn(turnId)).resolves.toMatchObject({ status: 'running' });
      const token = credentials.issue({
        rootId: taskId,
        callerTaskId: taskId,
        turnId,
        allowedActions: new Set([
          'create_task', 'create_tasks', 'delegate_task', 'release_tasks', 'set_task_lifecycle',
          'continue_child', 'cancel_tasks', 'answer_child_question', 'complete_task',
        ]),
        ttlMs: 60_000,
      });
      const context = credentials.verify(token)!;
      const command = {
        kind: 'create_task' as const,
        opId: 'sqlite-create',
        spec: { goal: 'sqlite child', taskType: 'worker', backend: 'grok', role: 'worker' as const },
      };
      await expect(engine.handleToolCall(context, 'create_task', command)).resolves.toMatchObject({ ok: true });
      const childId = deriveEntityId(turnId, command.opId, 'task');
      await expect(repository.getTask(childId)).resolves.toMatchObject({ parentId: taskId, releaseState: 'draft' });
      await expect(engine.handleToolCall(context, 'create_task', command)).resolves.toMatchObject({ ok: true });
      await expect(engine.handleToolCall(context, 'create_task', {
        ...command,
        spec: { ...command.spec, goal: 'different payload' },
      })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('conflict') });

      await expect(engine.handleToolCall(context, 'create_tasks', {
        kind: 'create_tasks', opId: 'sqlite-batch', specs: [
          { localId: 'a', goal: 'batch a', taskType: 'worker' },
          { localId: 'b', goal: 'batch b', taskType: 'worker' },
        ],
      })).resolves.toMatchObject({ ok: true });
      const batchA = deriveEntityId(turnId, 'sqlite-batch', 'task:a');
      const batchB = deriveEntityId(turnId, 'sqlite-batch', 'task:b');
      await expect(engine.handleToolCall(context, 'cancel_tasks', {
        kind: 'cancel_tasks', opId: 'sqlite-cancel-batch', childIds: [batchA, batchB],
      })).resolves.toMatchObject({ ok: true });
      await expect(repository.getTask(batchA)).resolves.toMatchObject({ lifecycle: 'cancelled' });
      await expect(repository.getTask(batchB)).resolves.toMatchObject({ lifecycle: 'cancelled' });

      await expect(engine.handleToolCall(context, 'release_tasks', {
        kind: 'release_tasks', opId: 'sqlite-release', taskIds: [childId],
      })).resolves.toMatchObject({ ok: true });
      await expect(repository.getTask(childId)).resolves.toMatchObject({ releaseState: 'released' });
      await expect(engine.handleToolCall(context, 'set_task_lifecycle', {
        kind: 'set_task_lifecycle', opId: 'sqlite-seal', taskId: childId,
        lifecycle: 'succeeded', result: 'first result',
      })).resolves.toMatchObject({ ok: true });
      await expect(repository.getTask(childId)).resolves.toMatchObject({ lifecycle: 'succeeded' });
      await expect(engine.handleToolCall(context, 'continue_child', {
        kind: 'continue_child', opId: 'sqlite-continue', childId, instruction: 'revise result',
      })).resolves.toMatchObject({ ok: true });
      const continuationId = deriveEntityId(turnId, 'sqlite-continue', 'turn');
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await repository.getTurn(continuationId))?.status === 'running') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await expect(repository.getTurn(continuationId)).resolves.toMatchObject({ status: 'running' });
      const childToken = credentials.issue({
        rootId: taskId, callerTaskId: childId, turnId: continuationId,
        allowedActions: new Set(['complete_task']), ttlMs: 60_000,
      });
      await expect(engine.handleToolCall(credentials.verify(childToken)!, 'complete_task', {
        kind: 'complete_task', opId: 'sqlite-child-complete', result: 'revised result',
      })).resolves.toMatchObject({ ok: true });

      await expect(engine.handleToolCall(context, 'delegate_task', {
        kind: 'delegate_task', opId: 'sqlite-question-child',
        spec: { goal: 'ask parent', taskType: 'worker' },
      })).resolves.toMatchObject({ ok: true });
      const questionChildId = deriveEntityId(turnId, 'sqlite-question-child', 'task');
      let questionTurnId: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const turns = await repository.listTurns(questionChildId);
        const live = turns.find((turn) => turn.status === 'running');
        if (live) { questionTurnId = live.id; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      expect(questionTurnId).toBeTruthy();
      const questionToken = credentials.issue({
        rootId: taskId, callerTaskId: questionChildId, turnId: questionTurnId!,
        allowedActions: new Set(['ask_parent', 'complete_task']), ttlMs: 60_000,
      });
      const questionContext = credentials.verify(questionToken)!;
      const asked = await engine.handleToolCall(questionContext, 'ask_parent', {
        kind: 'ask_parent', opId: 'sqlite-ask', questions: [{ prompt: 'Which option?' }],
      });
      expect(asked).toMatchObject({ ok: true });
      if (!asked.ok) return;
      const questionId = (asked.result as { questionId: string }).questionId;
      await expect(repository.getTask(taskId)).resolves.toMatchObject({
        pendingChildQuestions: { [questionId]: { fromChildId: questionChildId } },
      });
      await expect(engine.handleToolCall(context, 'answer_child_question', {
        kind: 'answer_child_question', opId: 'sqlite-answer', questionId, answers: ['option A'],
      })).resolves.toMatchObject({ ok: true });
      expect((await repository.getTask(taskId))?.pendingChildQuestions?.[questionId]).toBeUndefined();
      await expect(repository.listSubtree(taskId)).resolves.toHaveLength(5);
    } finally {
      release();
      await engine?.whenIdle();
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
