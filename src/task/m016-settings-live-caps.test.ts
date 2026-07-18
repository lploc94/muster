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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m016-live-caps-'));
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

function workerTurns(store: TaskStore) {
  return Object.values(store.getFile().turns).filter(
    (t) => t.taskId !== 'coord' && t.trigger === 'engine',
  );
}

function countByStatus(store: TaskStore, status: string): number {
  return workerTurns(store).filter((t) => t.status === status).length;
}

describe('m016-settings-live-caps (M016-S02 / D037)', () => {
  it('re-reads a mutable settings-backed getter: raise promotes more, lower never preempts', async () => {
    const { store } = makeTempStore();
    const credentials = new CredentialRegistry();

    // Shared hold gate for worker runs so concurrency is observable.
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

    // Plain mutable object simulating live VS Code muster.execution settings.
    // getResourceLimits reads these fields on every call — no engine recreate.
    const INITIAL_CAP = 2;
    const RAISED_CAP = 5;
    const LOWERED_CAP = 1;
    const settings = {
      maxConcurrentPerBackend: INITIAL_CAP,
      maxConcurrentTurns: 30,
      maxConcurrentPerRoot: 20,
    };

    const engine = TaskEngine.load({
      store,
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

    expect(
      engine.createTask({
        id: 'coord',
        goal: 'coordinate live-cap workers',
        backend: 'claude',
        role: 'coordinator',
        capabilities: ['create_child', 'wait_child', 'read_subtree'],
      }).ok,
    ).toBe(true);

    const started = engine.startTask('coord');
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('startTask failed');
    const turnId = started.value.turnId;

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
      opId: 'op-live-caps-batch',
      specs,
    });
    if (!delegated.ok) {
      throw new Error(`delegate_tasks failed: ${JSON.stringify(delegated)}`);
    }

    // ── Phase 1: initial cap N promotes up to N turns ──────────────────────
    await waitFor(() => peak >= INITIAL_CAP, 2000);
    await new Promise((r) => setTimeout(r, 80));
    expect(peak).toBe(INITIAL_CAP);
    expect(live).toBe(INITIAL_CAP);
    expect(workerTurns(store)).toHaveLength(WORKER_COUNT);
    expect(countByStatus(store, 'queued')).toBeGreaterThan(0);
    expect(countByStatus(store, 'running')).toBe(INITIAL_CAP);

    // ── Phase 2: mutate settings object higher — next pass promotes more ───
    // No engine recreate: same TaskEngine instance, same getter reference.
    settings.maxConcurrentPerBackend = RAISED_CAP;

    for (const turn of workerTurns(store)) {
      if (turn.status === 'queued') {
        engine.resumeQueuedTurn(turn.id);
      }
    }

    await waitFor(() => peak >= RAISED_CAP, 3000);
    await new Promise((r) => setTimeout(r, 80));
    expect(peak).toBe(RAISED_CAP);
    expect(live).toBe(RAISED_CAP);
    expect(countByStatus(store, 'running')).toBe(RAISED_CAP);
    expect(countByStatus(store, 'queued')).toBe(WORKER_COUNT - RAISED_CAP);

    // ── Phase 3: lower the cap — do not preempt running; block new promotes ─
    const runningBeforeLower = countByStatus(store, 'running');
    const liveBeforeLower = live;
    expect(runningBeforeLower).toBe(RAISED_CAP);

    settings.maxConcurrentPerBackend = LOWERED_CAP;

    // Re-drive every queued turn; under the lowered cap none may promote.
    for (const turn of workerTurns(store)) {
      if (turn.status === 'queued') {
        engine.resumeQueuedTurn(turn.id);
      }
    }
    await new Promise((r) => setTimeout(r, 120));

    // Already-running turns stay running (non-preemptive).
    expect(live).toBe(liveBeforeLower);
    expect(countByStatus(store, 'running')).toBe(runningBeforeLower);
    // Peak must not climb past the raised-cap plateau after the lower.
    expect(peak).toBe(RAISED_CAP);
    // Queued work remains blocked under the lowered cap.
    expect(countByStatus(store, 'queued')).toBe(WORKER_COUNT - RAISED_CAP);

    // Release held workers so they finish. Residual queued turns still use the
    // original gate (now resolved) and complete quickly; sample running counts
    // while draining under the live lowered cap — never more than LOWERED_CAP.
    releaseWorkers();
    await waitFor(() => live === 0, 3000);

    let secondWavePeak = 0;
    for (const turn of workerTurns(store)) {
      if (turn.status === 'queued') {
        engine.resumeQueuedTurn(turn.id);
      }
    }

    const drainDeadline = Date.now() + 5000;
    while (Date.now() < drainDeadline) {
      secondWavePeak = Math.max(secondWavePeak, countByStatus(store, 'running'));
      const remaining = workerTurns(store).filter(
        (t) => t.status === 'queued' || t.status === 'running',
      );
      if (remaining.length === 0) break;
      for (const turn of remaining) {
        if (turn.status === 'queued') engine.resumeQueuedTurn(turn.id);
      }
      await new Promise((r) => setTimeout(r, 15));
    }

    expect(secondWavePeak).toBeLessThanOrEqual(LOWERED_CAP);

    const finalWorkers = workerTurns(store);
    const nonSucceeded = finalWorkers
      .filter((t) => t.status !== 'succeeded')
      .map((t) => ({ id: t.id, taskId: t.taskId, status: t.status }));
    expect(nonSucceeded).toEqual([]);
    expect(finalWorkers).toHaveLength(WORKER_COUNT);

    releaseCoord();
    await engine.whenIdle();
    expect(live).toBe(0);
  });
});
