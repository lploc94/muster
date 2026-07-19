/**
 * M016-S02 / D037 — named headless flow: m016-settings-live-caps
 *
 * Proves TaskEngine re-reads a live getResourceLimits() getter on every
 * scheduling pass without engine recreation — the S02 settings contract.
 *
 * Distinct from S01's m016-concurrency-scale (peak under a raised cap):
 * this flow uses a plain mutable settings object (simulating VS Code
 * muster.execution.* values) and also proves lowering a cap never preempts
 * already-running turns while still blocking new promotions.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m016-live-caps-'));
  tempDirs.push(dir);
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  await client.open(path.join(dir, 'muster.sqlite3'));
  const repository = new SqliteTaskRepository(client, 'ws');
  await repository.execute({
    kind: 'upsertWorkspace',
    workspaceId: 'ws',
    identityKey: 'm016-live-caps',
    displayName: 'M016 live caps',
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

function countByStatus(engine: TaskEngine, coordId: string, status: string): number {
  return workerTurns(engine, coordId).filter((t) => t.status === status).length;
}

describe('m016-settings-live-caps (M016-S02 / D037)', () => {
  it('re-reads a mutable settings-backed getter: raise promotes more, lower never preempts', async () => {
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

    const INITIAL_CAP = 2;
    const RAISED_CAP = 5;
    const LOWERED_CAP = 1;
    const settings = {
      maxConcurrentPerBackend: INITIAL_CAP,
      maxConcurrentTurns: 30,
      maxConcurrentPerRoot: 20,
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
      getResourceLimits: (): ResourceLimits => ({
        ...DEFAULT_RESOURCE_LIMITS,
        maxConcurrentPerBackend: settings.maxConcurrentPerBackend,
        maxConcurrentTurns: settings.maxConcurrentTurns,
        maxConcurrentPerRoot: settings.maxConcurrentPerRoot,
      }),
    });
    activeEngines.push(engine);

    const started = await engine.startNewTask({
      goal: 'coordinate live-cap workers',
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
      opId: 'op-live-caps-batch',
      specs,
    });
    if (!delegated.ok) {
      throw new Error(`delegate_tasks failed: ${JSON.stringify(delegated)}`);
    }

    await waitFor(() => peak >= INITIAL_CAP, 5000, 10, 'peak at initial cap');
    await new Promise((r) => setTimeout(r, 80));
    expect(peak).toBe(INITIAL_CAP);
    expect(live).toBe(INITIAL_CAP);
    expect(workerTurns(engine, coordId)).toHaveLength(WORKER_COUNT);
    expect(countByStatus(engine, coordId, 'queued')).toBeGreaterThan(0);
    expect(countByStatus(engine, coordId, 'running')).toBe(INITIAL_CAP);

    settings.maxConcurrentPerBackend = RAISED_CAP;

    for (const turn of workerTurns(engine, coordId)) {
      if (turn.status === 'queued') {
        void engine.resumeQueuedTurnAsync(turn.taskId, turn.id);
      }
    }

    await waitFor(() => peak >= RAISED_CAP, 5000, 10, 'peak at raised cap');
    await new Promise((r) => setTimeout(r, 80));
    expect(peak).toBe(RAISED_CAP);
    expect(live).toBe(RAISED_CAP);
    expect(countByStatus(engine, coordId, 'running')).toBe(RAISED_CAP);
    expect(countByStatus(engine, coordId, 'queued')).toBe(WORKER_COUNT - RAISED_CAP);

    const runningBeforeLower = countByStatus(engine, coordId, 'running');
    const liveBeforeLower = live;
    expect(runningBeforeLower).toBe(RAISED_CAP);

    settings.maxConcurrentPerBackend = LOWERED_CAP;

    for (const turn of workerTurns(engine, coordId)) {
      if (turn.status === 'queued') {
        void engine.resumeQueuedTurnAsync(turn.taskId, turn.id);
      }
    }
    await new Promise((r) => setTimeout(r, 120));

    // Already-running turns stay running (non-preemptive); peak does not climb.
    expect(live).toBe(liveBeforeLower);
    expect(countByStatus(engine, coordId, 'running')).toBe(runningBeforeLower);
    expect(peak).toBe(RAISED_CAP);
    expect(countByStatus(engine, coordId, 'queued')).toBe(WORKER_COUNT - RAISED_CAP);

    // Second-wave under lowered cap: release first wave, then re-drive queue.
    // Backend closes over the resolved gate so turns finish quickly; sample peak.
    releaseWorkers();
    await waitFor(() => live === 0, 5000, 10, 'first wave drained');

    let secondWavePeak = 0;
    for (const turn of workerTurns(engine, coordId)) {
      if (turn.status === 'queued') {
        void engine.resumeQueuedTurnAsync(turn.taskId, turn.id);
      }
    }
    const sampleDeadline = Date.now() + 1500;
    while (Date.now() < sampleDeadline) {
      secondWavePeak = Math.max(secondWavePeak, live, countByStatus(engine, coordId, 'running'));
      const remaining = workerTurns(engine, coordId).filter(
        (t) => t.status === 'queued' || t.status === 'running',
      );
      if (remaining.length === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(secondWavePeak).toBeLessThanOrEqual(LOWERED_CAP);

    releaseCoord();
    engine.quiesceForTerminalStorage();
  }, 15_000);
});
