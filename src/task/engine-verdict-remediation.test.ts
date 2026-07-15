import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backend, BackendCapabilities, RunOptions } from '../types';
import { TaskEngine } from './engine';
import { deriveEntityId } from './engine-graph';
import { DEFAULT_RESOURCE_LIMITS } from './limits';
import { failureSignature } from './recovery-policy';
import { TaskStore } from './store';
import type { MusterTask, TaskBriefV1, TaskExecutionPolicy, TaskVerdict } from './types';

// Phase B — bounded verify-remediation engine pass (applyVerdictRemediation).
// Drives the private tick pass directly against a hand-seeded graph so each
// decision branch (remediate / pause / abort / no-op / idempotent) is isolated.

const NOW = '2026-07-06T12:00:00.000Z';
const RATIONALE = 'unit tests failed: 2 red';
const FAIL_SIG = failureSignature(RATIONALE);
const REMEDIATION_ID = deriveEntityId('ship', 'verdict-remediation', '0');
const REMEDIATION_TURN_ID = deriveEntityId('ship', 'verdict-remediation-turn', '0');

const tempDirs: string[] = [];

function makeStore(): TaskStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-verdict-remediation-'));
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
      throw new Error('backend should not run in these trust-gated tests');
    },
  };
}

const POLICY: TaskExecutionPolicy = {
  maxTurns: 10,
  maxAutomaticRetries: 0,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 120_000,
};

function task(patch: Partial<MusterTask> & Pick<MusterTask, 'id' | 'role' | 'lifecycle'>): MusterTask {
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

function implBrief(): TaskBriefV1 {
  return {
    version: 1,
    kind: 'implement',
    title: 'implement widget',
    objective: 'implement widget',
    acceptanceCriteria: [],
    writePaths: ['src/widget.ts'],
    expectedOutputs: ['summary'],
  };
}

function failVerdict(status: TaskVerdict['status'] = 'fail'): TaskVerdict {
  return { status, rationale: RATIONALE, source: 'worker', at: NOW };
}

/** Engine with the remediation tick reachable and turns trust-gated (never run). */
function makeEngine(store: TaskStore): TaskEngine {
  return TaskEngine.load({
    store,
    makeBackend: () => backend(),
    clock: () => NOW,
    isWorkspaceTrusted: () => false,
  });
}

function runRemediation(engine: TaskEngine): void {
  (engine as unknown as { applyVerdictRemediation(): void }).applyVerdictRemediation();
}

interface SeedOptions {
  requiredVerdict?: boolean;
  verifyHasUpstream?: boolean;
  verdictStatus?: TaskVerdict['status'];
  /** Terminal-succeeded verify with NO verdict at all (ISSUE 4). */
  noVerdict?: boolean;
  /** Override the verify task's lifecycle (default succeeded); ISSUE 12 uses `failed`. */
  verifyLifecycle?: MusterTask['lifecycle'];
  shipRemediation?: MusterTask['remediation'];
}

/** coord → { impl (done), vfy (done, fail verdict) }; ship gated on vfy's verdict. */
function seed(store: TaskStore, opts: SeedOptions = {}): void {
  const requiredVerdict = opts.requiredVerdict ?? true;
  store.commit((draft) => {
    draft.tasks.coord = task({ id: 'coord', role: 'coordinator', lifecycle: 'open', parentId: null });
    draft.tasks.impl = task({
      id: 'impl',
      role: 'worker',
      lifecycle: 'succeeded',
      goal: 'implement widget',
      brief: implBrief(),
      claimsGit: true,
      taskResult: { version: 1, revision: 1, summary: 'implemented widget' },
    });
    draft.tasks.vfy = task({
      id: 'vfy',
      role: 'worker',
      lifecycle: opts.verifyLifecycle ?? 'succeeded',
      goal: 'verify widget',
      ...(opts.verifyHasUpstream === false
        ? {}
        : { inputBindings: [{ fromTaskId: 'impl', output: 'summary', as: 'artifact' }] }),
      taskResult: {
        version: 1,
        revision: 1,
        summary: 'ran verification',
        ...(opts.noVerdict ? {} : { verdict: failVerdict(opts.verdictStatus) }),
      },
    });
    draft.tasks.ship = task({
      id: 'ship',
      role: 'worker',
      lifecycle: 'open',
      goal: 'ship widget',
      dependencies: [
        {
          taskId: 'vfy',
          requiredOutcome: 'succeeded',
          onUnsatisfied: 'block',
          ...(requiredVerdict ? { requiredVerdict: 'pass' as const } : {}),
        },
      ],
      ...(opts.shipRemediation ? { remediation: opts.shipRemediation } : {}),
    });
    return { ok: true };
  });
}

describe('applyVerdictRemediation', () => {
  it('creates one bounded fix task, binds the failure, and re-points the gate', () => {
    const store = makeStore();
    const engine = makeEngine(store);
    seed(store);

    runRemediation(engine);

    const file = store.getFile();
    // Exactly one new task (coord, impl, vfy, ship, + remediation).
    expect(Object.keys(file.tasks).sort()).toEqual(
      [REMEDIATION_ID, 'coord', 'impl', 'ship', 'vfy'].sort(),
    );

    const fix = file.tasks[REMEDIATION_ID];
    expect(fix).toBeDefined();
    expect(fix.role).toBe('worker');
    expect(fix.parentId).toBe('coord');
    expect(fix.releaseState).toBe('released');
    expect(fix.brief?.kind).toBe('implement');
    // Upstream writePaths carried so the git-mutex still serializes the fix.
    expect(fix.brief?.writePaths).toEqual(['src/widget.ts']);
    expect(fix.claimsGit).toBe(true);
    // Failing verdict pinned as an untrusted input on the fix.
    expect(fix.inputBindings).toEqual([
      { fromTaskId: 'vfy', output: 'verdict', as: 'verify_failure' },
    ]);
    // Fix depends on the (already-succeeded) verify task.
    expect(fix.dependencies).toContainEqual({
      taskId: 'vfy',
      requiredOutcome: 'succeeded',
      onUnsatisfied: 'block',
    });
    // A first turn was queued for the fix.
    const fixTurn = file.turns[REMEDIATION_TURN_ID];
    expect(fixTurn?.status).toBe('queued');
    expect(fixTurn?.taskId).toBe(REMEDIATION_ID);

    // Ship's failed verdict gate is re-pointed to the fix (requiredVerdict dropped).
    const ship = file.tasks.ship;
    expect(ship.dependencies).toEqual([
      { taskId: REMEDIATION_ID, requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
    ]);
    expect(ship.lifecycle).toBe('open');
    expect(ship.remediation).toEqual({
      uses: 1,
      lastFailureSig: FAIL_SIG,
      fixTaskId: REMEDIATION_ID,
    });
  });

  it('pauses (no second task) when the identical failure recurs', () => {
    const store = makeStore();
    const engine = makeEngine(store);
    seed(store, { shipRemediation: { uses: 1, lastFailureSig: FAIL_SIG } });

    runRemediation(engine);

    const file = store.getFile();
    expect(Object.keys(file.tasks).sort()).toEqual(['coord', 'impl', 'ship', 'vfy']);
    const ship = file.tasks.ship;
    expect(ship.attention?.code).toBe('verdict_failed');
    expect(ship.attention?.message).toContain('identical');
    // Not re-pointed, budget not bumped.
    expect(ship.dependencies[0].requiredVerdict).toBe('pass');
    expect(ship.remediation).toEqual({ uses: 1, lastFailureSig: FAIL_SIG });
    expect(ship.lifecycle).toBe('open');
  });

  it('seals the blocked task failed once the remediation budget is exhausted', () => {
    const store = makeStore();
    const engine = makeEngine(store);
    // uses at maxUses (2) with no prior sig → remediate-branch then abort.
    seed(store, { shipRemediation: { uses: 2 } });

    runRemediation(engine);

    const file = store.getFile();
    expect(Object.keys(file.tasks).sort()).toEqual(['coord', 'impl', 'ship', 'vfy']);
    const ship = file.tasks.ship;
    expect(ship.lifecycle).toBe('failed');
    expect(ship.attention?.code).toBe('verdict_failed');
    expect(ship.attention?.message).toContain('budget exhausted');
    expect(ship.sealedBy).toBeDefined();
  });

  it('is idempotent: running the tick twice creates no duplicate and does not re-bump uses', () => {
    const store = makeStore();
    const engine = makeEngine(store);
    seed(store);

    runRemediation(engine);
    runRemediation(engine);

    const file = store.getFile();
    expect(Object.keys(file.tasks).sort()).toEqual(
      [REMEDIATION_ID, 'coord', 'impl', 'ship', 'vfy'].sort(),
    );
    // One fix task, one fix turn, uses stays at 1.
    expect(Object.values(file.turns).filter((t) => t.taskId === REMEDIATION_ID)).toHaveLength(1);
    expect(file.tasks.ship.remediation).toEqual({
      uses: 1,
      lastFailureSig: FAIL_SIG,
      fixTaskId: REMEDIATION_ID,
    });
  });

  it('is a no-op when no dependency opts into a verdict gate', () => {
    const store = makeStore();
    const engine = makeEngine(store);
    // Same failing verdict, but the gate does not require a passing verdict.
    seed(store, { requiredVerdict: false });

    const before = store.getFile();
    const beforeTaskIds = Object.keys(before.tasks).sort();
    const beforeShip = before.tasks.ship;

    runRemediation(engine);

    const file = store.getFile();
    expect(Object.keys(file.tasks).sort()).toEqual(beforeTaskIds);
    const ship = file.tasks.ship;
    expect(ship.dependencies).toEqual(beforeShip.dependencies);
    expect(ship.attention).toBeUndefined();
    expect(ship.remediation).toBeUndefined();
    expect(ship.lifecycle).toBe('open');
  });

  it('ISSUE 4 — seals the blocked task failed (verdict_missing) when the producer has no verdict', () => {
    const store = makeStore();
    const engine = makeEngine(store);
    // Verify terminal-succeeded but emitted NO verdict → gate can never pass.
    seed(store, { noVerdict: true });

    runRemediation(engine);

    const file = store.getFile();
    // No un-runnable remediation task is fabricated.
    expect(Object.keys(file.tasks).sort()).toEqual(['coord', 'impl', 'ship', 'vfy']);
    const ship = file.tasks.ship;
    expect(ship.lifecycle).toBe('failed');
    expect(ship.attention?.code).toBe('verdict_missing');
    expect(ship.attention?.message).toContain('no verdict');
    expect(ship.sealedBy).toBeDefined();
  });

  it('ISSUE 3 — a terminally-failed fix retries within budget, then seals (loop always terminates)', () => {
    const FIX2_ID = deriveEntityId('ship', 'verdict-remediation', '1');
    const store = makeStore();
    const engine = makeEngine(store);
    seed(store);

    /** Force a fix task to a terminal `failed` state (as if its work could not fix it). */
    const failFix = (fixId: string, error: string): void => {
      store.commit((draft) => {
        const fix = draft.tasks[fixId];
        draft.tasks[fixId] = {
          ...fix,
          lifecycle: 'failed',
          error,
          finishedAt: NOW,
          taskResult: { version: 1, revision: 1, summary: error },
        };
        return { ok: true };
      });
    };

    // Attempt 1: the verdict-fail trigger creates fix #0 (uses 0 → 1).
    runRemediation(engine);
    expect(store.getTask(REMEDIATION_ID)).toBeDefined();
    expect(store.getTask('ship')?.remediation).toMatchObject({ uses: 1, fixTaskId: REMEDIATION_ID });

    // fix #0 fails → the failed-fix trigger creates fix #1 within budget (uses 1 → 2).
    failFix(REMEDIATION_ID, 'fix #0 could not compile');
    runRemediation(engine);
    const shipAfter2 = store.getTask('ship');
    expect(store.getTask(FIX2_ID)).toBeDefined();
    expect(shipAfter2?.lifecycle).toBe('open');
    expect(shipAfter2?.remediation).toMatchObject({ uses: 2, fixTaskId: FIX2_ID });
    // The gate now waits on the second fix.
    expect(shipAfter2?.dependencies).toEqual([
      { taskId: FIX2_ID, requiredOutcome: 'succeeded', onUnsatisfied: 'block' },
    ]);

    // fix #1 fails too → budget exhausted → the blocked task is sealed failed (no hang).
    failFix(FIX2_ID, 'fix #1 still red');
    runRemediation(engine);
    const shipFinal = store.getTask('ship');
    expect(shipFinal?.lifecycle).toBe('failed');
    expect(shipFinal?.attention?.code).toBe('verdict_failed');
    expect(shipFinal?.attention?.message).toContain('budget exhausted');
    expect(shipFinal?.sealedBy).toBeDefined();
  });

  it('ISSUE 11 — seals the blocked task failed (no silent hang) when the remediation turn cannot be created', () => {
    const store = makeStore();
    // maxTurnsPerTask 0 → canCreateTurn() rejects the staged fix's first turn, exercising
    // the creation-failure branch that must SEAL (not delete-and-return silently).
    const engine = TaskEngine.load({
      store,
      makeBackend: () => backend(),
      clock: () => NOW,
      isWorkspaceTrusted: () => false,
      resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, maxTurnsPerTask: 0 },
    });
    seed(store);

    runRemediation(engine);

    const file = store.getFile();
    // The partially-staged fix task + turn are rolled back in the same commit (no leak).
    expect(Object.keys(file.tasks).sort()).toEqual(['coord', 'impl', 'ship', 'vfy']);
    expect(file.turns[REMEDIATION_TURN_ID]).toBeUndefined();
    // The blocked task terminates with an honest failed seal + attention (never hangs).
    const ship = file.tasks.ship;
    expect(ship.lifecycle).toBe('failed');
    expect(ship.attention?.code).toBe('verdict_failed');
    expect(ship.attention?.message).toContain('could not create remediation task');
    expect(ship.sealedBy).toBeDefined();
  });

  it('ISSUE 12 — seals the blocked task failed (verdict_failed) when the producer is terminal but NOT succeeded', () => {
    const store = makeStore();
    const engine = makeEngine(store);
    // Verify is terminal-FAILED (not succeeded) but still carries a fail verdict. A
    // verdict-binding fix would wire an unsatisfiable requiredOutcome:'succeeded' dep on
    // vfy, so no un-promotable fix is created — the gate is sealed instead.
    seed(store, { verifyLifecycle: 'failed' });

    runRemediation(engine);

    const file = store.getFile();
    expect(Object.keys(file.tasks).sort()).toEqual(['coord', 'impl', 'ship', 'vfy']);
    const ship = file.tasks.ship;
    expect(ship.lifecycle).toBe('failed');
    expect(ship.attention?.code).toBe('verdict_failed');
    expect(ship.attention?.message).toContain('did not succeed');
    expect(ship.sealedBy).toBeDefined();
  });
});
