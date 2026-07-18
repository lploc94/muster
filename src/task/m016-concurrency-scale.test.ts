/**
 * M016-S01 / D037 — named headless flow: m016-concurrency-scale
 *
 * Proves TaskEngine concurrency caps are enforced on a real engine with a
 * live getResourceLimits() getter, via the coordinator delegate_tasks path.
 * This is the S01 demo flow; S02 has its own higher-scale check.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../bridge/credentials';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine } from './engine';
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from './limits';
import { TaskStore } from './store';
import { parseTaskTypeRegistry } from './task-types';

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
  // Drain fire-and-forget scheduleTurn work before temp cleanup.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(activeEngines.splice(0).map((e) => e.whenIdle().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempStore(): { dir: string; filePath: string; store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m016-scale-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, '.muster-tasks.json');
  return { dir, filePath, store: TaskStore.load({ filePath }) };
}

async function waitFor(
  predicate: () => boolean,
  ms = 3000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe('m016-concurrency-scale (M016-S01 / D037)', () => {
  it('delegates ~10 workers under a live per-backend cap and re-reads raised caps', async () => {
    const { store } = makeTempStore();
    const credentials = new CredentialRegistry();

    // Shared hold gate for worker runs so peak concurrency is observable.
    let releaseWorkers!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });
    activeResumes.push(() => releaseWorkers());

    // Coordinator holds its turn open for the duration of handleToolCall.
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

    // Start with a tight per-backend cap so excess workers stay queued, then
    // raise mid-flow to prove the live getter is re-read on the next promote.
    // Keep global/root caps high so only the per-backend gate is the bottleneck.
    const PER_BACKEND_CAP = 5;
    let limits: ResourceLimits = {
      ...DEFAULT_RESOURCE_LIMITS,
      maxConcurrentPerBackend: 2,
      maxConcurrentTurns: 20,
      maxConcurrentPerRoot: 16,
    };

    const engine = TaskEngine.load({
      store,
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

    expect(
      engine.createTask({
        id: 'coord',
        goal: 'coordinate scale workers',
        backend: 'claude',
        role: 'coordinator',
        capabilities: ['create_child', 'wait_child', 'read_subtree'],
      }).ok,
    ).toBe(true);

    const started = engine.startTask('coord');
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('startTask failed');
    const turnId = started.value.turnId;

    // Let the coordinator turn enter running before issuing credentials.
    await waitFor(() => store.getFile().turns[turnId]?.status === 'running');

    const token = credentials.issue({
      rootId: 'coord',
      callerTaskId: 'coord',
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

    // Phase 1: tight cap of 2 — peak must settle at <= 2 and some turns stay queued.
    await waitFor(() => peak >= 2, 2000);
    // Give the scheduler a beat to try (and fail) promoting more under the tight cap.
    await new Promise((r) => setTimeout(r, 80));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);

    const workerTurnsAfterTight = Object.values(store.getFile().turns).filter(
      (t) => t.taskId !== 'coord' && t.trigger === 'engine',
    );
    expect(workerTurnsAfterTight.length).toBe(WORKER_COUNT);
    const queuedUnderTight = workerTurnsAfterTight.filter((t) => t.status === 'queued');
    expect(queuedUnderTight.length).toBeGreaterThan(0);

    // Phase 2: raise the live getter's per-backend cap and re-drive scheduling.
    limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      maxConcurrentPerBackend: PER_BACKEND_CAP,
      maxConcurrentTurns: 20,
      maxConcurrentPerRoot: 16,
    };

    // Resume every still-queued worker turn so the next promote reads the new cap.
    for (const turn of workerTurnsAfterTight) {
      if (turn.status === 'queued') {
        engine.resumeQueuedTurn(turn.id);
      }
    }

    // Wait until peak saturates at the raised per-backend cap.
    await waitFor(() => peak >= Math.min(PER_BACKEND_CAP, WORKER_COUNT), 3000);
    // Brief settle window so any over-cap promotion would have happened.
    await new Promise((r) => setTimeout(r, 80));

    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(PER_BACKEND_CAP);

    // Drain: release workers, re-drive any still-queued second-wave turns, then
    // release the coordinator and wait for idle.
    releaseWorkers();
    await new Promise((r) => setTimeout(r, 30));
    for (const turn of Object.values(store.getFile().turns)) {
      if (turn.taskId !== 'coord' && turn.status === 'queued') {
        engine.resumeQueuedTurn(turn.id);
      }
    }
    await waitFor(() => {
      const workers = Object.values(store.getFile().turns).filter(
        (t) => t.taskId !== 'coord' && t.trigger === 'engine',
      );
      return workers.length === WORKER_COUNT && workers.every((t) => t.status === 'succeeded');
    }, 5000);
    releaseCoord();
    await engine.whenIdle();

    const finalWorkerTurns = Object.values(store.getFile().turns).filter(
      (t) => t.taskId !== 'coord' && t.trigger === 'engine',
    );
    const nonSucceeded = finalWorkerTurns
      .filter((t) => t.status !== 'succeeded')
      .map((t) => ({ id: t.id, taskId: t.taskId, status: t.status }));
    expect(nonSucceeded).toEqual([]);
    expect(finalWorkerTurns).toHaveLength(WORKER_COUNT);
    expect(live).toBe(0);
  });
});
