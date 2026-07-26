import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../../../src/shared/backend-readiness';
import type { BackendProbeProgress } from '../../../src/shared/backend-probe';
import {
  applyProbeProgressToActive,
  canStartBackendProbe,
  clearActiveProbeIfSettled,
  createActiveBackendProbe,
  pickerOptionLabelForRecord,
  probeRecoveryLabel,
  probeStageLabel,
  readinessDiagnosticGuidance,
  resolveDraftComposerEligibility,
  resolveProbeSurface,
  type ActiveBackendProbe,
} from './backend-eligibility';

function baseRecord(
  overrides: Partial<BackendReadinessRecord> & Pick<BackendReadinessRecord, 'backendId'>,
): BackendReadinessRecord {
  const base: BackendReadinessRecord = {
    backendId: overrides.backendId,
    state: 'missing',
    code: 'executable_missing',
    recoveryAction: 'install',
    compatibility: 'unknown',
    versionEvidence: null,
    checkedAt: '2026-07-25T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function settledSnapshot(
  backends: BackendReadinessRecord[],
  overrides: Partial<BackendReadinessSnapshot> = {},
): BackendReadinessSnapshot {
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 'corr-1',
    phase: 'settled',
    checkedAt: '2026-07-25T00:00:00.000Z',
    backends,
    ...overrides,
  };
}

function fiveMissing(): BackendReadinessRecord[] {
  return BACKEND_READINESS_IDS.map((backendId) => baseRecord({ backendId }));
}

describe('resolveDraftComposerEligibility', () => {
  it('returns loading for null snapshot (unknown / checking)', () => {
    const result = resolveDraftComposerEligibility({
      snapshot: null,
      preferredBackend: 'claude',
      preferredModel: 'sonnet',
    });
    expect(result.kind).toBe('loading');
    expect(result.canComposeNewTask).toBe(false);
    expect(result.pickerBackendIds).toEqual([]);
    expect(result.displayBackend).toBeNull();
    expect(result.setupGuidance).toMatch(/Checking/i);
  });

  it('returns loading for checking phase', () => {
    const result = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(fiveMissing(), { phase: 'checking' }),
      preferredBackend: 'claude',
    });
    expect(result.kind).toBe('loading');
    expect(result.canComposeNewTask).toBe(false);
  });

  it('returns empty when settled with zero passively selectable providers', () => {
    const result = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(fiveMissing()),
      preferredBackend: 'claude',
      preferredModel: 'sonnet',
    });
    expect(result.kind).toBe('empty');
    expect(result.canComposeNewTask).toBe(false);
    expect(result.pickerBackendIds).toEqual([]);
    expect(result.displayBackend).toBeNull();
    expect(result.preferenceStale).toBe(true);
    expect(result.setupGuidance).toMatch(/No supported agent CLIs/i);
  });

  it('excludes missing and known-incompatible from selectable options', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'incompatible',
      code: 'version_incompatible',
      recoveryAction: 'update',
      compatibility: 'incompatible',
      versionEvidence: '0.0.1',
    });
    backends[4] = baseRecord({
      backendId: 'opencode',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: '1.0.0',
    });
    const result = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(backends),
      preferredBackend: 'claude',
      preferredModel: 'sonnet',
    });
    expect(result.kind).toBe('ready');
    expect(result.pickerBackendIds).toEqual(['opencode']);
    expect(result.displayBackend).toBe('opencode');
    expect(result.displayModel).toBeNull();
    expect(result.preferenceStale).toBe(true);
    expect(result.canComposeNewTask).toBe(true);
    expect(result.setupGuidance).toMatch(/not available/i);
  });

  it('keeps preferred backend when passively selectable and does not clear model', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: '2.1.0',
    });
    const result = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(backends),
      preferredBackend: 'claude',
      preferredModel: 'sonnet',
    });
    expect(result.kind).toBe('ready');
    expect(result.displayBackend).toBe('claude');
    expect(result.displayModel).toBe('sonnet');
    expect(result.preferenceStale).toBe(false);
    expect(result.setupGuidance).toBe('');
  });

  it('selects first passively selectable without claiming preference when stale', () => {
    const backends = fiveMissing();
    backends[1] = baseRecord({
      backendId: 'grok',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: '1.0.0',
    });
    backends[3] = baseRecord({
      backendId: 'codex',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: '0.9.0',
    });
    const result = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(backends),
      preferredBackend: 'claude',
      preferredModel: 'sonnet',
    });
    expect(result.displayBackend).toBe('grok');
    expect(result.displayModel).toBeNull();
    expect(result.preferenceStale).toBe(true);
    expect(result.pickerBackendIds).toEqual(['grok', 'codex']);
  });

  it('surfaces incompatible guidance when only incompatible providers remain', () => {
    const backends = fiveMissing().map((r) =>
      baseRecord({
        backendId: r.backendId,
        state: 'incompatible',
        code: 'version_incompatible',
        recoveryAction: 'update',
        compatibility: 'incompatible',
        versionEvidence: '0.0.1',
      }),
    );
    const result = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(backends),
      preferredBackend: 'claude',
    });
    expect(result.kind).toBe('empty');
    expect(result.setupGuidance).toMatch(/Incompatible/i);
  });

  it('uses availableBackends transitional fallback when snapshot is null', () => {
    const result = resolveDraftComposerEligibility({
      snapshot: null,
      preferredBackend: 'claude',
      preferredModel: 'sonnet',
      availableBackends: ['opencode', 'claude'],
    });
    expect(result.kind).toBe('ready');
    expect(result.pickerBackendIds).toEqual(['claude', 'opencode']);
    expect(result.displayBackend).toBe('claude');
    expect(result.canComposeNewTask).toBe(true);
  });

  it('treats empty availableBackends as settled-empty when snapshot is null', () => {
    const result = resolveDraftComposerEligibility({
      snapshot: null,
      preferredBackend: 'claude',
      availableBackends: [],
    });
    expect(result.kind).toBe('empty');
    expect(result.canComposeNewTask).toBe(false);
  });

  it('keeps testing backends selectable while probe is in flight', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'testing',
      code: 'none',
      recoveryAction: 'none',
      versionEvidence: '2.1.0',
    });
    const result = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(backends),
      preferredBackend: 'claude',
      preferredModel: 'sonnet',
    });
    expect(result.kind).toBe('ready');
    expect(result.pickerBackendIds).toEqual(['claude']);
    expect(result.displayBackend).toBe('claude');
    expect(result.canComposeNewTask).toBe(true);
  });
});

describe('pickerOptionLabelForRecord', () => {
  it('labels installed_unverified honestly', () => {
    const label = pickerOptionLabelForRecord(
      baseRecord({
        backendId: 'claude',
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        versionEvidence: '1.2.3',
      }),
    );
    expect(label).toMatch(/installed, unverified/i);
    expect(label).toContain('1.2.3');
  });

  it('labels testing and auth_required honestly', () => {
    expect(
      pickerOptionLabelForRecord(
        baseRecord({
          backendId: 'claude',
          state: 'testing',
          code: 'none',
          recoveryAction: 'none',
          versionEvidence: '1.0.0',
        }),
      ),
    ).toMatch(/testing/i);
    expect(
      pickerOptionLabelForRecord(
        baseRecord({
          backendId: 'claude',
          state: 'auth_required',
          code: 'auth_required',
          recoveryAction: 'login',
          versionEvidence: '1.0.0',
        }),
      ),
    ).toMatch(/sign in|auth|login/i);
  });
});

describe('canStartBackendProbe', () => {
  it('allows installed_unverified, ready, and auth_required', () => {
    expect(
      canStartBackendProbe(
        baseRecord({
          backendId: 'claude',
          state: 'installed_unverified',
          code: 'version_unknown',
          recoveryAction: 'retry',
          versionEvidence: '1.0.0',
        }),
      ),
    ).toBe(true);
    expect(
      canStartBackendProbe(
        baseRecord({
          backendId: 'claude',
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '1.0.0',
        }),
      ),
    ).toBe(true);
    expect(
      canStartBackendProbe(
        baseRecord({
          backendId: 'claude',
          state: 'auth_required',
          code: 'auth_required',
          recoveryAction: 'login',
          versionEvidence: '1.0.0',
        }),
      ),
    ).toBe(true);
  });

  it('refuses missing, testing, checking, and known-incompatible', () => {
    expect(canStartBackendProbe(baseRecord({ backendId: 'claude', state: 'missing' }))).toBe(false);
    expect(
      canStartBackendProbe(
        baseRecord({
          backendId: 'claude',
          state: 'testing',
          code: 'none',
          recoveryAction: 'none',
          versionEvidence: '1.0.0',
        }),
      ),
    ).toBe(false);
    expect(
      canStartBackendProbe(
        baseRecord({
          backendId: 'claude',
          state: 'checking',
          code: 'none',
          recoveryAction: 'none',
        }),
      ),
    ).toBe(false);
    expect(
      canStartBackendProbe(
        baseRecord({
          backendId: 'claude',
          state: 'incompatible',
          code: 'version_incompatible',
          recoveryAction: 'update',
          compatibility: 'incompatible',
          versionEvidence: '0.0.1',
        }),
      ),
    ).toBe(false);
  });
});

describe('probe stage / recovery labels and diagnostic guidance', () => {
  it('maps closed stages and recovery actions to bounded UI labels', () => {
    expect(probeStageLabel('executable')).toMatch(/executable/i);
    expect(probeStageLabel('model_catalog')).toMatch(/model/i);
    expect(probeRecoveryLabel('login')).toMatch(/sign in|login/i);
    expect(probeRecoveryLabel('retry')).toMatch(/retry|test/i);
    expect(probeRecoveryLabel('none')).toBe('');
  });

  it('renders precise sanitized diagnostics without paths or raw errors', () => {
    const auth = readinessDiagnosticGuidance(
      baseRecord({
        backendId: 'claude',
        state: 'auth_required',
        code: 'auth_required',
        recoveryAction: 'login',
        versionEvidence: '2.1.0',
      }),
    );
    expect(auth).toMatch(/sign in|authenticate|login/i);
    expect(auth).not.toMatch(/[A-Za-z]:\\|\//);

    const timeout = readinessDiagnosticGuidance(
      baseRecord({
        backendId: 'opencode',
        state: 'failed',
        code: 'timeout',
        recoveryAction: 'retry',
        versionEvidence: '1.0.0',
      }),
    );
    expect(timeout).toMatch(/timed out|timeout/i);

    const ready = readinessDiagnosticGuidance(
      baseRecord({
        backendId: 'claude',
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility: 'compatible',
        versionEvidence: '2.1.0',
      }),
    );
    expect(ready).toMatch(/ready|connected/i);
  });
});

describe('active probe correlation helpers', () => {
  it('creates an active probe with bounded probeId', () => {
    const active = createActiveBackendProbe('claude', 'probe-abc');
    expect(active).toEqual({
      backendId: 'claude',
      probeId: 'probe-abc',
      stage: null,
      startedAt: null,
    });
  });

  it('applies matching progress and drops stale/unsolicited progress fail-closed', () => {
    const active: ActiveBackendProbe = {
      backendId: 'claude',
      probeId: 'probe-1',
      stage: null,
      startedAt: null,
    };
    const matching: BackendProbeProgress = {
      schemaVersion: 1,
      probeId: 'probe-1',
      backendId: 'claude',
      stage: 'initialize',
      startedAt: '2026-07-25T00:02:00.000Z',
    };
    expect(applyProbeProgressToActive(active, matching)).toEqual({
      backendId: 'claude',
      probeId: 'probe-1',
      stage: 'initialize',
      startedAt: '2026-07-25T00:02:00.000Z',
    });

    // Wrong probeId
    expect(
      applyProbeProgressToActive(active, {
        ...matching,
        probeId: 'other',
      }),
    ).toBe(active);

    // Wrong backend
    expect(
      applyProbeProgressToActive(active, {
        ...matching,
        backendId: 'grok',
      }),
    ).toBe(active);

    // No active probe
    expect(applyProbeProgressToActive(null, matching)).toBeNull();
  });

  it('clears active probe when the snapshot leaves testing for that backend', () => {
    const active: ActiveBackendProbe = {
      backendId: 'claude',
      probeId: 'probe-1',
      stage: 'session',
      startedAt: '2026-07-25T00:02:00.000Z',
    };
    const stillTesting = settledSnapshot([
      baseRecord({
        backendId: 'claude',
        state: 'testing',
        code: 'none',
        recoveryAction: 'none',
        versionEvidence: '1.0.0',
      }),
      ...fiveMissing().slice(1),
    ]);
    expect(clearActiveProbeIfSettled(active, stillTesting)).toBe(active);

    const readySnap = settledSnapshot([
      baseRecord({
        backendId: 'claude',
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility: 'compatible',
        versionEvidence: '1.0.0',
      }),
      ...fiveMissing().slice(1),
    ]);
    expect(clearActiveProbeIfSettled(active, readySnap)).toBeNull();

    const authSnap = settledSnapshot([
      baseRecord({
        backendId: 'claude',
        state: 'auth_required',
        code: 'auth_required',
        recoveryAction: 'login',
        versionEvidence: '1.0.0',
      }),
      ...fiveMissing().slice(1),
    ]);
    expect(clearActiveProbeIfSettled(active, authSnap)).toBeNull();
  });

  it('does not clear active probe for an unrelated backend settlement', () => {
    const active: ActiveBackendProbe = {
      backendId: 'claude',
      probeId: 'probe-1',
      stage: 'version',
      startedAt: '2026-07-25T00:02:00.000Z',
    };
    const snap = settledSnapshot([
      baseRecord({
        backendId: 'claude',
        state: 'testing',
        code: 'none',
        recoveryAction: 'none',
        versionEvidence: '1.0.0',
      }),
      baseRecord({
        backendId: 'grok',
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility: 'compatible',
        versionEvidence: '1.0.0',
      }),
      ...fiveMissing().slice(2),
    ]);
    expect(clearActiveProbeIfSettled(active, snap)).toBe(active);
  });
});

describe('resolveProbeSurface', () => {
  it('returns hidden when no record or not draft-relevant', () => {
    expect(
      resolveProbeSurface({
        record: null,
        activeProbe: null,
        backendId: 'claude',
      }).kind,
    ).toBe('hidden');
  });

  it('offers Test Connection for installed_unverified', () => {
    const surface = resolveProbeSurface({
      record: baseRecord({
        backendId: 'claude',
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        versionEvidence: '1.0.0',
      }),
      activeProbe: null,
      backendId: 'claude',
    });
    expect(surface.kind).toBe('idle');
    expect(surface.canStart).toBe(true);
    expect(surface.canCancel).toBe(false);
    expect(surface.statusText).toMatch(/unverified|Test Connection/i);
  });

  it('shows correlated testing progress with cancel', () => {
    const surface = resolveProbeSurface({
      record: baseRecord({
        backendId: 'claude',
        state: 'testing',
        code: 'none',
        recoveryAction: 'none',
        versionEvidence: '1.0.0',
      }),
      activeProbe: {
        backendId: 'claude',
        probeId: 'probe-1',
        stage: 'authenticate',
        startedAt: '2026-07-25T00:02:00.000Z',
      },
      backendId: 'claude',
    });
    expect(surface.kind).toBe('testing');
    expect(surface.canStart).toBe(false);
    expect(surface.canCancel).toBe(true);
    expect(surface.statusText).toMatch(/authenticate|auth/i);
  });

  it('shows ready and auth_required diagnostics', () => {
    const ready = resolveProbeSurface({
      record: baseRecord({
        backendId: 'claude',
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility: 'compatible',
        versionEvidence: '1.0.0',
      }),
      activeProbe: null,
      backendId: 'claude',
    });
    expect(ready.kind).toBe('ready');
    expect(ready.canStart).toBe(true);
    expect(ready.statusText).toMatch(/ready|connected/i);

    const auth = resolveProbeSurface({
      record: baseRecord({
        backendId: 'claude',
        state: 'auth_required',
        code: 'auth_required',
        recoveryAction: 'login',
        versionEvidence: '1.0.0',
      }),
      activeProbe: null,
      backendId: 'claude',
    });
    expect(auth.kind).toBe('diagnostic');
    expect(auth.canStart).toBe(true);
    expect(auth.recoveryLabel).toMatch(/sign in|login/i);
    expect(auth.statusText).toMatch(/sign in|authenticate|login/i);
  });

  it('hides surface when active probe targets another backend', () => {
    const surface = resolveProbeSurface({
      record: baseRecord({
        backendId: 'claude',
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        versionEvidence: '1.0.0',
      }),
      activeProbe: {
        backendId: 'grok',
        probeId: 'probe-x',
        stage: 'version',
        startedAt: '2026-07-25T00:02:00.000Z',
      },
      backendId: 'claude',
    });
    expect(surface.kind).toBe('idle');
    expect(surface.canStart).toBe(true);
  });
});
