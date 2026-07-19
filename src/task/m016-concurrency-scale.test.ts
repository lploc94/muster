/**
 * M016 — named headless flow: m016-concurrency-scale
 *
 * S01 / D037: live getResourceLimits() under a tight→raised per-backend cap
 *   (workers stay queued under cap 2, then promote when raised to 5).
 * S03 / SC4: scale proof — ≥30 workers on one backend saturate the shipped
 *   default maxConcurrentPerBackend (15), not the legacy hard 2.
 *
 * S02 keeps its own settings-live-caps flow (raise/lower without recreate).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../bridge/credentials';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine } from './engine';
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from './limits';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { parseTaskTypeRegistry } from './task-types';
import type { TaskTurn } from './types';

const WORKER_TS = path.join(__dirname, 'sqlite/worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

/** Use allowlisted backend names (graph path rejects unknown backends). */
const TEST_TASK_TYPES = parseTaskTypeRegistry({
  worker: { backend: 'grok', role: 'worker', briefKind: 'generic' },
  coordinate: { backend: 'claude', role: 'coordinator', briefKind: 'coordinate' },
});

const tempDirs: string[] = [];
const clients: DbClient[] = [];
const activeResumes: Array<() => void> = [];
const activeEngines: TaskEngine[] = [];

afterEach(async () => {
  for (const resume of activeResumes.splice(0)) {
    try {
      resume();
    } catch {
      /* ignore */
    }
  }
  for (const e of activeEngines.splice(0)) {
    try {
      e.quiesceForTerminalStorage();
    } catch {
      /* ignore */
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function makeRepo(): Promise<SqliteTaskRepository> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m016-scale-'));
  tempDirs.push(dir);
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  await client.open(path.join(dir, 'muster.sqlite3'));
  const repository = new SqliteTaskRepository(client, 'ws');
  await repository.execute({
    kind: 'upsertWorkspace',
    workspaceId: 'ws',
    identityKey: 'm016-scale',
    displayName: 'M016 scale',
    createdAt: 'now',
    lastOpenedAt: 'now',
  });
  return repository;
}

async function waitFor(
  predicate: () => boolean,
  ms = 3000,
  stepMs = 10,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${ms}ms waiting for ${label}`);
}

function workerTurns(engine: TaskEngine, coordId: string): TaskTurn[] {
  return Object.values(engine.getReadModel().getFile().turns).filter(
    (t) => t.taskId !== coordId && t.trigger === 'engine',
  );
}

describe('m016-concurrency-scale (M016-S01 / D037)', () => {
  it('delegates ~10 workers under a live per-backend cap and re-reads raised caps', async () => {
    const repository = await makeRepo();
    const credentials = new CredentialRegistry();

    let releaseWorkers!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });
    activeResumes.push(() => releaseWorkers());

    let releaseCoord!: () => void;
    const coordGate = new Promise<void>((resolve) => {
      releaseCoord = resolve;
    });
    activeResumes.push(() => releaseCoord());

    let live = 0;
    let peak = 0;

    const workerBackend: Backend = {
      name: 'grok',
      capabilities: MCP_CAPS,
      async *run(_options: RunOptions): AsyncIterable<NormalizedEvent> {
        live += 1;
        peak = Math.max(peak, live);
        try {
          yield { type: 'sessionStarted', sessionId: `worker-sess-${live}` };
          await workerGate;
          yield { type: 'turnCompleted' };
        } finally {
          live -= 1;
        }
      },
    };

    const coordBackend: Backend = {
      name: 'claude',
      capabilities: MCP_CAPS,
      async *run(_options: RunOptions): AsyncIterable<NormalizedEvent> {
        yield { type: 'sessionStarted', sessionId: 'coord-sess' };
        await coordGate;
        yield { type: 'turnCompleted' };
      },
    };

    const PER_BACKEND_CAP = 5;
    let limits: ResourceLimits = {
      ...DEFAULT_RESOURCE_LIMITS,
      maxConcurrentPerBackend: 2,
      maxConcurrentTurns: 20,
      maxConcurrentPerRoot: 16,
    };

    const engine = await TaskEngine.loadAsync({
      repository,
      workspaceId: 'ws',
      makeBackend: (name) => {
        if (name === 'claude') return { ...coordBackend, name: 'claude' };
        return { ...workerBackend, name: name || 'grok' };
      },
      credentialRegistry: credentials,
      bridgePort: 19999,
      getTaskTypeRegistry: () => TEST_TASK_TYPES,
      getResourceLimits: () => limits,
    });
    activeEngines.push(engine);

    const started = await engine.startNewTask({
      goal: 'coordinate scale workers',
      backend: 'claude',
      role: 'coordinator',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('startNewTask failed');
    const { taskId: coordId, turnId } = started.value;

    await waitFor(
      () => engine.getReadModel().getFile().turns[turnId]?.status === 'running',
      5000,
      10,
      'coord running',
    );

    const token = credentials.issue({
      rootId: coordId,
      callerTaskId: coordId,
      turnId,
      attemptId: 'a0',
      allowedActions: new Set([
        'delegate_task',
        'delegate_tasks',
        'create_task',
        'release_tasks',
        'complete_task',
      ]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;

    const WORKER_COUNT = 10;
    const specs = Array.from({ length: WORKER_COUNT }, (_, i) => ({
      localId: `w${i}`,
      goal: `worker ${i}`,
      taskType: 'worker' as const,
      backend: 'grok',
      role: 'worker' as const,
    }));

    const delegated = await engine.handleToolCall(ctx, 'delegate_tasks', {
      kind: 'delegate_tasks',
      opId: 'op-scale-batch',
      specs,
    });
    if (!delegated.ok) {
      throw new Error(`delegate_tasks failed: ${JSON.stringify(delegated)}`);
    }

    await waitFor(() => peak >= 2, 5000, 10, 'peak>=2 under tight cap');
    await new Promise((r) => setTimeout(r, 80));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);

    const workerTurnsAfterTight = workerTurns(engine, coordId);
    expect(workerTurnsAfterTight.length).toBe(WORKER_COUNT);
    const queuedUnderTight = workerTurnsAfterTight.filter((t) => t.status === 'queued');
    expect(queuedUnderTight.length).toBeGreaterThan(0);

    limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      maxConcurrentPerBackend: PER_BACKEND_CAP,
      maxConcurrentTurns: 20,
      maxConcurrentPerRoot: 16,
    };

    for (const turn of workerTurnsAfterTight) {
      if (turn.status === 'queued') {
        void engine.resumeQueuedTurnAsync(turn.taskId, turn.id);
      }
    }

    await waitFor(
      () => peak >= Math.min(PER_BACKEND_CAP, WORKER_COUNT),
      5000,
      10,
      `peak>=${PER_BACKEND_CAP} after raise`,
    );
    await new Promise((r) => setTimeout(r, 80));

    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(PER_BACKEND_CAP);

    // Core concurrency proof is done — release gates and hard-quiesce.
    releaseWorkers();
    releaseCoord();
    engine.quiesceForTerminalStorage();
  }, 15_000);

  it(
    'SC4: saturates shipped per-backend default (15) with 30+ single-backend workers',
    async () => {
    const repository = await makeRepo();
    const credentials = new CredentialRegistry();

    let releaseWorkers!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });
    activeResumes.push(() => releaseWorkers());

    let releaseCoord!: () => void;
    const coordGate = new Promise<void>((resolve) => {
      releaseCoord = resolve;
    });
    activeResumes.push(() => releaseCoord());

    let live = 0;
    let peak = 0;

    const workerBackend: Backend = {
      name: 'grok',
      capabilities: MCP_CAPS,
      async *run(_options: RunOptions): AsyncIterable<NormalizedEvent> {
        live += 1;
        peak = Math.max(peak, live);
        try {
          yield { type: 'sessionStarted', sessionId: `worker-sess-sc4-${live}` };
          await workerGate;
          yield { type: 'turnCompleted' };
        } finally {
          live -= 1;
        }
      },
    };

    const coordBackend: Backend = {
      name: 'claude',
      capabilities: MCP_CAPS,
      async *run(_options: RunOptions): AsyncIterable<NormalizedEvent> {
        yield { type: 'sessionStarted', sessionId: 'coord-sess-sc4' };
        await coordGate;
        yield { type: 'turnCompleted' };
      },
    };

    const PER_BACKEND_CAP = DEFAULT_RESOURCE_LIMITS.maxConcurrentPerBackend;
    expect(PER_BACKEND_CAP).toBe(15);

    const limits: ResourceLimits = {
      ...DEFAULT_RESOURCE_LIMITS,
      maxConcurrentPerBackend: PER_BACKEND_CAP,
      maxConcurrentTurns: 40,
      maxConcurrentPerRoot: 40,
    };

    const engine = await TaskEngine.loadAsync({
      repository,
      workspaceId: 'ws',
      makeBackend: (name) => {
        if (name === 'claude') return { ...coordBackend, name: 'claude' };
        return { ...workerBackend, name: name || 'grok' };
      },
      credentialRegistry: credentials,
      bridgePort: 19998,
      getTaskTypeRegistry: () => TEST_TASK_TYPES,
      getResourceLimits: () => limits,
    });
    activeEngines.push(engine);

    const started = await engine.startNewTask({
      goal: 'coordinate SC4 scale workers',
      backend: 'claude',
      role: 'coordinator',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('startNewTask failed');
    const { taskId: coordId, turnId } = started.value;

    await waitFor(() => engine.getReadModel().getFile().turns[turnId]?.status === 'running');

    const token = credentials.issue({
      rootId: coordId,
      callerTaskId: coordId,
      turnId,
      attemptId: 'a0-sc4',
      allowedActions: new Set([
        'delegate_task',
        'delegate_tasks',
        'create_task',
        'release_tasks',
        'complete_task',
      ]),
      ttlMs: 60_000,
    });
    const ctx = credentials.verify(token)!;

    const WORKER_COUNT = 30;
    const BATCH_SIZE = 15;
    const specs = Array.from({ length: WORKER_COUNT }, (_, i) => ({
      localId: `sc4-w${i}`,
      goal: `sc4 worker ${i}`,
      taskType: 'worker' as const,
      backend: 'grok',
      role: 'worker' as const,
    }));

    for (let batch = 0; batch * BATCH_SIZE < WORKER_COUNT; batch += 1) {
      const slice = specs.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);
      const delegated = await engine.handleToolCall(ctx, 'delegate_tasks', {
        kind: 'delegate_tasks',
        opId: `op-sc4-batch-${batch}`,
        specs: slice,
      });
      if (!delegated.ok) {
        throw new Error(`delegate_tasks batch ${batch} failed: ${JSON.stringify(delegated)}`);
      }
    }

    await waitFor(() => peak >= Math.min(PER_BACKEND_CAP, WORKER_COUNT), 5000);
    await new Promise((r) => setTimeout(r, 100));

    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeGreaterThanOrEqual(Math.min(PER_BACKEND_CAP, WORKER_COUNT));
    expect(peak).toBeLessThanOrEqual(PER_BACKEND_CAP);

    const turns = workerTurns(engine, coordId);
    expect(turns).toHaveLength(WORKER_COUNT);
    expect(turns.some((t) => t.status === 'queued')).toBe(true);
    expect(turns.filter((t) => t.status === 'running').length).toBeLessThanOrEqual(
      PER_BACKEND_CAP,
    );

    releaseWorkers();
    releaseCoord();
    engine.quiesceForTerminalStorage();
    },
    15_000,
  );
});
