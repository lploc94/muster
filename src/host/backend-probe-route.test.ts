import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BACKEND_PROBE_SCHEMA_VERSION,
  type BackendProbeProgress,
  type BackendProbeResult,
} from '../shared/backend-probe';
import {
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../shared/backend-readiness';
import {
  parseStartBackendProbeMessage,
  parseCancelBackendProbeMessage,
  routeStartBackendProbe,
  routeCancelBackendProbe,
  type BackendProbeRouteDeps,
  type BackendProbeHostMessage,
} from './backend-probe-route';
import type { StartBackendProbeInput } from './backend-probe';

function record(
  backendId: BackendReadinessId,
  overrides: Partial<BackendReadinessRecord> = {},
): BackendReadinessRecord {
  return {
    backendId,
    state: 'installed_unverified',
    code: 'none',
    recoveryAction: 'none',
    compatibility: 'unknown',
    versionEvidence: '1.0.0',
    checkedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<BackendReadinessSnapshot> = {},
): BackendReadinessSnapshot {
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 'corr-1',
    phase: 'settled',
    checkedAt: '2026-07-25T00:00:00.000Z',
    backends: [
      record('claude'),
      record('grok', { state: 'missing', code: 'executable_missing', recoveryAction: 'install', versionEvidence: null }),
      record('kiro'),
      record('codex'),
      record('opencode'),
    ],
    ...overrides,
  };
}

function readyResult(
  overrides: Partial<BackendProbeResult> = {},
): BackendProbeResult {
  return {
    schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
    probeId: 'probe-1',
    backendId: 'claude',
    outcome: 'ready',
    code: 'none',
    recoveryAction: 'none',
    compatibility: 'compatible',
    versionEvidence: '2.1.4',
    lastStage: 'model_catalog',
    modelCatalogAvailable: true,
    checkedAt: '2026-07-25T00:01:00.000Z',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<BackendProbeRouteDeps> = {},
): BackendProbeRouteDeps & {
  posts: BackendProbeHostMessage[];
  applied: BackendReadinessSnapshot[];
  startCalls: StartBackendProbeInput[];
  cancelCalls: BackendReadinessId[];
} {
  const posts: BackendProbeHostMessage[] = [];
  const applied: BackendReadinessSnapshot[] = [];
  const startCalls: StartBackendProbeInput[] = [];
  const cancelCalls: BackendReadinessId[] = [];
  let current = snapshot();
  let inFlight = false;

  const deps: BackendProbeRouteDeps & {
    posts: BackendProbeHostMessage[];
    applied: BackendReadinessSnapshot[];
    startCalls: StartBackendProbeInput[];
    cancelCalls: BackendReadinessId[];
  } = {
    posts,
    applied,
    startCalls,
    cancelCalls,
    getReadinessSnapshot: () => current,
    ensureReadiness: vi.fn(async () => current),
    applySnapshot: (next) => {
      current = next;
      applied.push(next);
    },
    isInFlight: () => inFlight,
    startProbe: vi.fn(async (input: StartBackendProbeInput) => {
      startCalls.push(input);
      inFlight = true;
      // Emit one progress stage so the route can forward it.
      input.onProgress?.({
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: input.probeId,
        backendId: input.backendId,
        stage: 'executable',
        startedAt: '2026-07-25T00:00:30.000Z',
      });
      inFlight = false;
      return readyResult({ probeId: input.probeId, backendId: input.backendId });
    }),
    cancelProbe: vi.fn((backendId: BackendReadinessId) => {
      cancelCalls.push(backendId);
      return true;
    }),
    post: (message) => {
      posts.push(message);
    },
    now: () => new Date('2026-07-25T00:00:15.000Z'),
    ...overrides,
  };
  return deps;
}

describe('parseStartBackendProbeMessage', () => {
  it('accepts a well-formed startBackendProbe message', () => {
    expect(
      parseStartBackendProbeMessage({
        type: 'startBackendProbe',
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: 'probe-1',
        backendId: 'claude',
      }),
    ).toEqual({
      schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
      probeId: 'probe-1',
      backendId: 'claude',
    });
  });

  it('rejects malformed, extra-key, wrong-type, and unknown-backend payloads', () => {
    expect(parseStartBackendProbeMessage(null)).toBeNull();
    expect(parseStartBackendProbeMessage([])).toBeNull();
    expect(
      parseStartBackendProbeMessage({
        type: 'cancelBackendProbe',
        schemaVersion: 1,
        probeId: 'p',
        backendId: 'claude',
      }),
    ).toBeNull();
    expect(
      parseStartBackendProbeMessage({
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: 'p',
        backendId: 'claude',
        extra: true,
      }),
    ).toBeNull();
    expect(
      parseStartBackendProbeMessage({
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: 'p',
        backendId: 'not-a-backend',
      }),
    ).toBeNull();
    expect(
      parseStartBackendProbeMessage({
        type: 'startBackendProbe',
        schemaVersion: 99,
        probeId: 'p',
        backendId: 'claude',
      }),
    ).toBeNull();
    expect(
      parseStartBackendProbeMessage({
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: '',
        backendId: 'claude',
      }),
    ).toBeNull();
  });
});

describe('parseCancelBackendProbeMessage', () => {
  it('accepts a well-formed cancelBackendProbe message', () => {
    expect(
      parseCancelBackendProbeMessage({
        type: 'cancelBackendProbe',
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: 'probe-1',
        backendId: 'claude',
      }),
    ).toEqual({
      schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
      probeId: 'probe-1',
      backendId: 'claude',
    });
  });

  it('rejects malformed cancel payloads', () => {
    expect(parseCancelBackendProbeMessage(null)).toBeNull();
    expect(
      parseCancelBackendProbeMessage({
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: 'p',
        backendId: 'claude',
      }),
    ).toBeNull();
    expect(
      parseCancelBackendProbeMessage({
        type: 'cancelBackendProbe',
        schemaVersion: 1,
        probeId: 'p',
        backendId: 'claude',
        extra: 1,
      }),
    ).toBeNull();
  });
});

describe('routeStartBackendProbe', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('fail-closed ignores malformed start messages without posting or starting', async () => {
    const outcome = await routeStartBackendProbe({ type: 'startBackendProbe' }, deps);
    expect(outcome.kind).toBe('ignored');
    expect(deps.startCalls).toHaveLength(0);
    expect(deps.posts).toHaveLength(0);
    expect(deps.applied).toHaveLength(0);
  });

  it('refuses ineligible backends (missing) without starting a probe', async () => {
    const outcome = await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: 'probe-x',
        backendId: 'grok',
      },
      deps,
    );
    expect(outcome.kind).toBe('refused');
    expect(deps.startCalls).toHaveLength(0);
    expect(deps.posts).toHaveLength(0);
  });

  it('marks testing, forwards progress, applies ready result, and posts snapshot', async () => {
    const outcome = await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: 'probe-1',
        backendId: 'claude',
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    expect(deps.startCalls).toHaveLength(1);
    expect(deps.startCalls[0]?.probeId).toBe('probe-1');
    expect(deps.startCalls[0]?.backendId).toBe('claude');

    // First apply = testing; second apply = ready result.
    expect(deps.applied).toHaveLength(2);
    expect(deps.applied[0]?.backends.find((b) => b.backendId === 'claude')?.state).toBe(
      'testing',
    );
    expect(deps.applied[1]?.backends.find((b) => b.backendId === 'claude')?.state).toBe(
      'ready',
    );
    // Sibling records stay reference-equal across testing apply.
    const snap0 = deps.applied[0]!;
    const grok0 = snap0.backends.find((b) => b.backendId === 'grok');
    // Original grok record object from the pre-route snapshot (same instance).
    expect(grok0?.backendId).toBe('grok');
    expect(grok0?.state).toBe('missing');
    // Claude changed; other ids still present.
    expect(snap0.backends.map((b) => b.backendId)).toEqual([
      'claude',
      'grok',
      'kiro',
      'codex',
      'opencode',
    ]);

    const progressMsgs = deps.posts.filter((m) => m.type === 'backendProbeProgress');
    const snapMsgs = deps.posts.filter((m) => m.type === 'backendReadinessSnapshot');
    expect(progressMsgs).toHaveLength(1);
    expect((progressMsgs[0] as { progress: BackendProbeProgress }).progress.stage).toBe(
      'executable',
    );
    expect(snapMsgs.length).toBeGreaterThanOrEqual(2);
    const finalSnap = (snapMsgs[snapMsgs.length - 1] as {
      snapshot: BackendReadinessSnapshot;
    }).snapshot;
    expect(finalSnap.backends.find((b) => b.backendId === 'claude')?.state).toBe('ready');
  });

  it('joins an in-flight probe without re-applying testing or double-starting', async () => {
    const startProbe = vi.fn(async (input: StartBackendProbeInput) => {
      deps.startCalls.push(input);
      return readyResult({ probeId: 'original-probe', backendId: input.backendId });
    });
    deps = makeDeps({
      isInFlight: () => true,
      startProbe,
    });

    const outcome = await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: 'duplicate-probe',
        backendId: 'claude',
      },
      deps,
    );

    expect(outcome.kind).toBe('joined');
    expect(startProbe).toHaveBeenCalledTimes(1);
    // Joining must not flip the snapshot to testing again — only the terminal result apply.
    expect(deps.applied).toHaveLength(1);
    expect(deps.applied[0]?.backends.find((b) => b.backendId === 'claude')?.state).toBe(
      'ready',
    );
    // Result still settles via the joined promise and posts the terminal snapshot.
    expect(deps.posts.some((m) => m.type === 'backendReadinessSnapshot')).toBe(true);
  });

  it('ensures readiness when peek is null before eligibility check', async () => {
    const ensured = snapshot();
    const ensureReadiness = vi.fn(async () => ensured);
    let current: BackendReadinessSnapshot | null = null;
    deps = makeDeps({
      getReadinessSnapshot: () => current,
      ensureReadiness,
      applySnapshot: (next) => {
        current = next;
        deps.applied.push(next);
      },
    });

    const outcome = await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: 'probe-1',
        backendId: 'claude',
      },
      deps,
    );
    expect(ensureReadiness).toHaveBeenCalled();
    expect(outcome.kind).toBe('completed');
  });

  it('never posts raw error text, stderr, or absolute paths on failure result', async () => {
    deps = makeDeps({
      startProbe: vi.fn(async (input: StartBackendProbeInput) =>
        readyResult({
          probeId: input.probeId,
          backendId: input.backendId,
          outcome: 'failed',
          code: 'acp_initialize_failed',
          recoveryAction: 'retry',
          lastStage: 'initialize',
          modelCatalogAvailable: false,
        }),
      ),
    });

    await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: 1,
        probeId: 'probe-fail',
        backendId: 'claude',
      },
      deps,
    );

    const serialized = JSON.stringify(deps.posts);
    expect(serialized).not.toMatch(/stderr|ECONNREFUSED|C:\\\\|\/Users\//i);
    expect(serialized).toMatch(/acp_initialize_failed/);
    const final = deps.applied[deps.applied.length - 1]!;
    expect(final.backends.find((b) => b.backendId === 'claude')?.state).toBe('failed');
  });
});

describe('routeCancelBackendProbe', () => {
  it('fail-closed ignores malformed cancel messages', () => {
    const deps = makeDeps();
    const outcome = routeCancelBackendProbe({ type: 'cancelBackendProbe' }, deps);
    expect(outcome.kind).toBe('ignored');
    expect(deps.cancelCalls).toHaveLength(0);
  });

  it('cancels the in-flight probe for the named backend', () => {
    const deps = makeDeps({ isInFlight: () => true });
    const outcome = routeCancelBackendProbe(
      {
        type: 'cancelBackendProbe',
        schemaVersion: 1,
        probeId: 'probe-1',
        backendId: 'claude',
      },
      deps,
    );
    expect(outcome.kind).toBe('cancelled');
    expect(deps.cancelCalls).toEqual(['claude']);
  });

  it('reports idle when no probe is in flight', () => {
    const deps = makeDeps({
      isInFlight: () => false,
      cancelProbe: vi.fn(() => false),
    });
    const outcome = routeCancelBackendProbe(
      {
        type: 'cancelBackendProbe',
        schemaVersion: 1,
        probeId: 'probe-1',
        backendId: 'claude',
      },
      deps,
    );
    expect(outcome.kind).toBe('idle');
  });
});
