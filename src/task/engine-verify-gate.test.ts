import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backend, BackendCapabilities, RunOptions } from '../types';
import { TaskEngine } from './engine';
import { dependenciesBlockTask } from './scheduler';
import { SOURCE_REVISION_UNAVAILABLE } from './source-revision';
import { TaskStore } from './store';
import type {
  MusterTask,
  TaskBriefV1,
  TaskExecutionPolicy,
  TaskTurn,
  TaskVerdict,
} from './types';

// Phase C engine wiring — host verdict OVERRIDES the worker self-report at settle,
// and source-revision drift downgrades a stored host `pass` and re-blocks a dependent.

const NOW = '2026-07-06T12:00:00.000Z';
const tempDirs: string[] = [];

function makeStore(): TaskStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-verify-gate-'));
  tempDirs.push(dir);
  return TaskStore.load({ filePath: path.join(dir, '.muster-tasks.json') });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsLiveInput: false,
};

function backend(): Backend {
  return {
    name: 'fake',
    capabilities: MCP_CAPS,
    // eslint-disable-next-line require-yield
    run: async function* (_options: RunOptions) {
      throw new Error('backend should not run in these tests');
    },
    extractSessionId: () => undefined,
  };
}

const POLICY: TaskExecutionPolicy = {
  maxTurns: 10,
  maxAutomaticRetries: 0,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 120_000,
};

function task(
  patch: Partial<MusterTask> & Pick<MusterTask, 'id' | 'role' | 'lifecycle'>,
): MusterTask {
  return {
    goal: patch.id,
    parentId: 'coord',
    dependencies: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: POLICY,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function verifyBrief(hostRun: boolean): TaskBriefV1 {
  return {
    version: 1,
    kind: 'verify',
    title: 'verify widget',
    objective: 'verify widget',
    acceptanceCriteria: [],
    verification: { commands: ['npm test'], hostRun },
    expectedOutputs: ['summary'],
  };
}

function runningCompleteTurn(taskId: string, workerVerdict: TaskVerdict): TaskTurn {
  return {
    id: `${taskId}-t1`,
    taskId,
    sequence: 1,
    trigger: 'user',
    status: 'running',
    inputs: [],
    disposition: { kind: 'complete', result: 'worker says ok', verdict: workerVerdict },
    createdAt: NOW,
    startedAt: NOW,
  };
}

const workerPass: TaskVerdict = { status: 'pass', source: 'worker', at: NOW };
const hostFail: TaskVerdict = {
  status: 'fail',
  source: 'host',
  testedRevision: 'rev-host',
  evidence: [{ command: 'npm test', exitCode: 1, status: 'fail' }],
  at: NOW,
};

describe('Phase C settle: host verdict override', () => {
  it('overrides a worker self-reported pass with the host verdict when hostRun is set', async () => {
    const store = makeStore();
    // Load BEFORE seeding so reconcileReload does not reclaim the seeded running turn.
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      // Feature enabled + workspace trusted → host gate executes.
      allowHostVerification: true,
      isWorkspaceTrusted: () => true,
      // Injected host gate: worker claimed pass, host says fail.
      runVerificationGate: () => ({ verdict: hostFail }),
    });
    store.commit((draft) => {
      draft.tasks.coord = task({
        id: 'coord',
        role: 'coordinator',
        lifecycle: 'open',
        parentId: null,
        childOrchestrationSeal: 'parent_may_seal_direct',
      });
      draft.tasks.vfy = task({
        id: 'vfy',
        role: 'worker',
        lifecycle: 'open',
        brief: verifyBrief(true),
      });
      draft.turns['vfy-t1'] = runningCompleteTurn('vfy', workerPass);
      return { ok: true };
    });

    await (
      engine as unknown as {
        settleSuccess(
          turnId: string,
          observed: string | undefined,
          raw: string,
          be: Backend,
        ): Promise<boolean>;
      }
    ).settleSuccess('vfy-t1', undefined, '', backend());

    const persisted = store.getTask('vfy')?.taskResult?.verdict;
    expect(persisted?.source).toBe('host');
    expect(persisted?.status).toBe('fail');
    expect(persisted?.evidence?.[0]).toMatchObject({ command: 'npm test', exitCode: 1 });
  });

  it('leaves the worker verdict untouched (gate never invoked) without hostRun', async () => {
    const store = makeStore();
    let gateCalls = 0;
    // Load BEFORE seeding so reconcileReload does not reclaim the seeded running turn.
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      isWorkspaceTrusted: () => false,
      runVerificationGate: () => {
        gateCalls += 1;
        return { verdict: hostFail };
      },
    });
    store.commit((draft) => {
      draft.tasks.coord = task({
        id: 'coord',
        role: 'coordinator',
        lifecycle: 'open',
        parentId: null,
        childOrchestrationSeal: 'parent_may_seal_direct',
      });
      draft.tasks.vfy = task({
        id: 'vfy',
        role: 'worker',
        lifecycle: 'open',
        brief: verifyBrief(false),
      });
      draft.turns['vfy-t1'] = runningCompleteTurn('vfy', workerPass);
      return { ok: true };
    });

    await (
      engine as unknown as {
        settleSuccess(
          turnId: string,
          observed: string | undefined,
          raw: string,
          be: Backend,
        ): Promise<boolean>;
      }
    ).settleSuccess('vfy-t1', undefined, '', backend());

    expect(gateCalls).toBe(0);
    const persisted = store.getTask('vfy')?.taskResult?.verdict;
    expect(persisted?.source).toBe('worker');
    expect(persisted?.status).toBe('pass');
  });

  it('ISSUE 1 — falls back to the worker verdict (never executes) when allowHostVerification is off', async () => {
    const store = makeStore();
    let gateCalls = 0;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      // hostRun brief flag is set, but the USER has NOT authorized host execution.
      allowHostVerification: false,
      isWorkspaceTrusted: () => true,
      runVerificationGate: () => {
        gateCalls += 1;
        return { verdict: hostFail };
      },
    });
    store.commit((draft) => {
      draft.tasks.coord = task({
        id: 'coord',
        role: 'coordinator',
        lifecycle: 'open',
        parentId: null,
        childOrchestrationSeal: 'parent_may_seal_direct',
      });
      draft.tasks.vfy = task({ id: 'vfy', role: 'worker', lifecycle: 'open', brief: verifyBrief(true) });
      draft.turns['vfy-t1'] = runningCompleteTurn('vfy', workerPass);
      return { ok: true };
    });

    await (
      engine as unknown as {
        settleSuccess(t: string, o: string | undefined, r: string, b: Backend): Promise<boolean>;
      }
    ).settleSuccess('vfy-t1', undefined, '', backend());

    expect(gateCalls).toBe(0);
    const persisted = store.getTask('vfy')?.taskResult?.verdict;
    expect(persisted?.source).toBe('worker');
    expect(persisted?.status).toBe('pass');
  });

  it('ISSUE 2 — emits an inconclusive host verdict WITHOUT executing when the workspace is untrusted', async () => {
    const store = makeStore();
    let gateCalls = 0;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      // Feature authorized, but the workspace is NOT trusted → run nothing.
      allowHostVerification: true,
      isWorkspaceTrusted: () => false,
      runVerificationGate: () => {
        gateCalls += 1;
        return { verdict: hostFail };
      },
    });
    store.commit((draft) => {
      draft.tasks.coord = task({
        id: 'coord',
        role: 'coordinator',
        lifecycle: 'open',
        parentId: null,
        childOrchestrationSeal: 'parent_may_seal_direct',
      });
      draft.tasks.vfy = task({ id: 'vfy', role: 'worker', lifecycle: 'open', brief: verifyBrief(true) });
      draft.turns['vfy-t1'] = runningCompleteTurn('vfy', workerPass);
      return { ok: true };
    });

    await (
      engine as unknown as {
        settleSuccess(t: string, o: string | undefined, r: string, b: Backend): Promise<boolean>;
      }
    ).settleSuccess('vfy-t1', undefined, '', backend());

    expect(gateCalls).toBe(0);
    const persisted = store.getTask('vfy')?.taskResult?.verdict;
    expect(persisted?.source).toBe('host');
    expect(persisted?.status).toBe('inconclusive');
    expect(persisted?.rationale).toContain('not trusted');
  });

  it('ISSUE 13 — resolves allowHostVerification LIVE: flipping it off mid-session skips execution', async () => {
    const store = makeStore();
    let allow = true;
    let gateCalls = 0;
    // Load BEFORE seeding so reconcileReload does not reclaim the seeded running turns.
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      isWorkspaceTrusted: () => true,
      // Live RESOLVER: read the current authorization each settle (no reload needed).
      allowHostVerification: () => allow,
      runVerificationGate: () => {
        gateCalls += 1;
        return { verdict: hostFail };
      },
    });
    store.commit((draft) => {
      draft.tasks.coord = task({
        id: 'coord',
        role: 'coordinator',
        lifecycle: 'open',
        parentId: null,
        childOrchestrationSeal: 'parent_may_seal_direct',
      });
      draft.tasks.vfy1 = task({ id: 'vfy1', role: 'worker', lifecycle: 'open', brief: verifyBrief(true) });
      draft.tasks.vfy2 = task({ id: 'vfy2', role: 'worker', lifecycle: 'open', brief: verifyBrief(true) });
      draft.turns['vfy1-t1'] = runningCompleteTurn('vfy1', workerPass);
      draft.turns['vfy2-t1'] = runningCompleteTurn('vfy2', workerPass);
      return { ok: true };
    });

    const settle = (turnId: string): Promise<boolean> =>
      (
        engine as unknown as {
          settleSuccess(t: string, o: string | undefined, r: string, b: Backend): Promise<boolean>;
        }
      ).settleSuccess(turnId, undefined, '', backend());

    // Authorized → the host gate runs and overrides the worker pass with the host fail.
    await settle('vfy1-t1');
    expect(gateCalls).toBe(1);
    expect(store.getTask('vfy1')?.taskResult?.verdict?.source).toBe('host');

    // Disable the setting mid-session, then settle the SECOND verify task: because the
    // resolver is evaluated live, host execution is revoked immediately (no reload).
    allow = false;
    await settle('vfy2-t1');
    expect(gateCalls).toBe(1); // unchanged — never executed
    const persisted = store.getTask('vfy2')?.taskResult?.verdict;
    expect(persisted?.source).toBe('worker');
    expect(persisted?.status).toBe('pass');
  });
});

describe('Phase C revalidateVerdicts: drift invalidation', () => {
  /** coord → vfy (succeeded, host PASS bound to rev-A) → ship gated on vfy's verdict. */
  function seedDrift(store: TaskStore): void {
    store.commit((draft) => {
      draft.tasks.coord = task({
        id: 'coord',
        role: 'coordinator',
        lifecycle: 'open',
        parentId: null,
      });
      draft.tasks.vfy = task({
        id: 'vfy',
        role: 'worker',
        lifecycle: 'succeeded',
        brief: verifyBrief(true),
        taskResult: {
          version: 1,
          revision: 1,
          summary: 'verified',
          verdict: {
            status: 'pass',
            source: 'host',
            testedRevision: 'rev-A',
            at: NOW,
          },
        },
      });
      draft.tasks.ship = task({
        id: 'ship',
        role: 'worker',
        lifecycle: 'open',
        dependencies: [
          {
            taskId: 'vfy',
            requiredOutcome: 'succeeded',
            onUnsatisfied: 'block',
            requiredVerdict: 'pass',
          },
        ],
      });
      return { ok: true };
    });
  }

  it('downgrades a stale host pass to inconclusive and re-blocks the gated dependent', () => {
    const store = makeStore();
    seedDrift(store);
    // Before drift: the passing verdict satisfies ship's gate.
    expect(dependenciesBlockTask(store.getFile(), 'ship')).toBe(false);

    const before = store.getTask('vfy')?.taskResult?.revision ?? 0;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      // Trusted so the drift probe may shell git (ISSUE 2 guard is satisfied).
      isWorkspaceTrusted: () => true,
      // Working tree has moved since the verdict was produced.
      computeSourceRevision: () => 'rev-B',
    });

    (engine as unknown as { revalidateVerdicts(): void }).revalidateVerdicts();

    const result = store.getTask('vfy')?.taskResult;
    expect(result?.verdict?.status).toBe('inconclusive');
    expect(result?.verdict?.source).toBe('host');
    // ISSUE 9 — the RESULT revision is bumped on downgrade so downstream pins observe it.
    expect(result?.revision).toBe(before + 1);
    // Re-blocked: the downgraded verdict no longer satisfies the gate.
    expect(dependenciesBlockTask(store.getFile(), 'ship')).toBe(true);
  });

  it('is a no-op (never shells git) when no host verdict exists', () => {
    const store = makeStore();
    store.commit((draft) => {
      draft.tasks.coord = task({
        id: 'coord',
        role: 'coordinator',
        lifecycle: 'open',
        parentId: null,
      });
      draft.tasks.vfy = task({
        id: 'vfy',
        role: 'worker',
        lifecycle: 'succeeded',
        taskResult: {
          version: 1,
          revision: 1,
          summary: 'verified',
          // Worker-sourced verdict — cannot drift; git must never be probed.
          verdict: { status: 'pass', source: 'worker', at: NOW },
        },
      });
      return { ok: true };
    });

    let probes = 0;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      // Trusted: proves the CANDIDATE guard (no host verdict) prevents the git probe,
      // not merely the untrusted-workspace guard.
      isWorkspaceTrusted: () => true,
      computeSourceRevision: () => {
        probes += 1;
        return 'rev-B';
      },
    });

    const before = store.getTask('vfy')?.taskResult?.verdict;
    (engine as unknown as { revalidateVerdicts(): void }).revalidateVerdicts();

    expect(probes).toBe(0);
    expect(store.getTask('vfy')?.taskResult?.verdict).toEqual(before);
  });

  it('leaves the verdict intact when the revision is unchanged', () => {
    const store = makeStore();
    seedDrift(store);

    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      isWorkspaceTrusted: () => true,
      // Same revision the verdict was bound to → no drift.
      computeSourceRevision: () => 'rev-A',
    });

    (engine as unknown as { revalidateVerdicts(): void }).revalidateVerdicts();

    expect(store.getTask('vfy')?.taskResult?.verdict?.status).toBe('pass');
    expect(dependenciesBlockTask(store.getFile(), 'ship')).toBe(false);
  });

  it('downgrades a stale host pass to inconclusive when the current revision is UNAVAILABLE', () => {
    const store = makeStore();
    seedDrift(store);
    // Before: the passing verdict (bound to rev-A) satisfies ship's gate.
    expect(dependenciesBlockTask(store.getFile(), 'ship')).toBe(false);

    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      isWorkspaceTrusted: () => true,
      // The working tree can no longer be fingerprinted (e.g. an untracked file over the
      // byte cap) → the verdict cannot be confirmed source-bound → inconclusive.
      computeSourceRevision: () => SOURCE_REVISION_UNAVAILABLE,
    });

    (engine as unknown as { revalidateVerdicts(): void }).revalidateVerdicts();

    expect(store.getTask('vfy')?.taskResult?.verdict?.status).toBe('inconclusive');
    expect(store.getTask('vfy')?.taskResult?.verdict?.source).toBe('host');
    // Re-blocked: the downgraded verdict no longer satisfies the gate.
    expect(dependenciesBlockTask(store.getFile(), 'ship')).toBe(true);
  });

  it('ISSUE 2 — skips the git probe entirely on an untrusted workspace', () => {
    const store = makeStore();
    seedDrift(store);

    let probes = 0;
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      // Untrusted → never shell git; the stale verdict is left intact for now.
      isWorkspaceTrusted: () => false,
      computeSourceRevision: () => {
        probes += 1;
        return 'rev-B';
      },
    });

    (engine as unknown as { revalidateVerdicts(): void }).revalidateVerdicts();

    expect(probes).toBe(0);
    expect(store.getTask('vfy')?.taskResult?.verdict?.status).toBe('pass');
  });
});
