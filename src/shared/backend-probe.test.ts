import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from './backend-readiness';
import {
  BACKEND_PROBE_ID_MAX,
  BACKEND_PROBE_OUTCOMES,
  BACKEND_PROBE_SCHEMA_VERSION,
  BACKEND_PROBE_STAGES,
  applyBackendProbeResult,
  applyBackendProbeTesting,
  isProbeEligible,
  parseBackendProbeProgress,
  parseBackendProbeRequest,
  parseBackendProbeResult,
  probeOutcomeToReadinessState,
  type BackendProbeProgress,
  type BackendProbeRequest,
  type BackendProbeResult,
} from './backend-probe';

function baseRecord(
  overrides: Partial<BackendReadinessRecord> & Pick<BackendReadinessRecord, 'backendId'>,
): BackendReadinessRecord {
  return {
    state: 'missing',
    code: 'executable_missing',
    recoveryAction: 'install',
    compatibility: 'unknown',
    versionEvidence: null,
    checkedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
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

function fiveBackends(
  overrides: Partial<Record<(typeof BACKEND_READINESS_IDS)[number], Partial<BackendReadinessRecord>>> = {},
): BackendReadinessRecord[] {
  return BACKEND_READINESS_IDS.map((backendId) =>
    baseRecord({
      backendId,
      state: 'missing',
      code: 'executable_missing',
      recoveryAction: 'install',
      ...overrides[backendId],
    }),
  );
}

function validRequest(overrides: Partial<BackendProbeRequest> = {}): BackendProbeRequest {
  return {
    schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
    probeId: 'probe-1',
    backendId: 'claude',
    ...overrides,
  };
}

function validProgress(overrides: Partial<BackendProbeProgress> = {}): BackendProbeProgress {
  return {
    schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
    probeId: 'probe-1',
    backendId: 'claude',
    stage: 'initialize',
    startedAt: '2026-07-25T00:00:01.000Z',
    ...overrides,
  };
}

function validResult(overrides: Partial<BackendProbeResult> = {}): BackendProbeResult {
  return {
    schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
    probeId: 'probe-1',
    backendId: 'claude',
    outcome: 'ready',
    code: 'none',
    recoveryAction: 'none',
    compatibility: 'compatible',
    versionEvidence: '1.2.3',
    lastStage: 'model_catalog',
    modelCatalogAvailable: true,
    checkedAt: '2026-07-25T00:00:05.000Z',
    ...overrides,
  };
}

describe('probe allowlists', () => {
  it('freezes schema version and closed stage/outcome taxonomies', () => {
    expect(BACKEND_PROBE_SCHEMA_VERSION).toBe(1);
    expect(BACKEND_PROBE_STAGES).toEqual([
      'executable',
      'version',
      'initialize',
      'authenticate',
      'session',
      'model_catalog',
    ]);
    expect(BACKEND_PROBE_OUTCOMES).toEqual([
      'ready',
      'auth_required',
      'incompatible',
      'failed',
      'cancelled',
    ]);
    expect(BACKEND_PROBE_ID_MAX).toBe(128);
  });
});

describe('parseBackendProbeRequest', () => {
  it('accepts a valid request round-trip', () => {
    const valid = validRequest();
    expect(parseBackendProbeRequest(valid)).toEqual(valid);
  });

  it('rejects null/undefined/array/non-object', () => {
    expect(parseBackendProbeRequest(null)).toBeNull();
    expect(parseBackendProbeRequest(undefined)).toBeNull();
    expect(parseBackendProbeRequest([])).toBeNull();
    expect(parseBackendProbeRequest('x')).toBeNull();
  });

  it('rejects wrong schemaVersion', () => {
    expect(parseBackendProbeRequest(validRequest({ schemaVersion: 99 as 1 }))).toBeNull();
    expect(parseBackendProbeRequest({ ...validRequest(), schemaVersion: '1' })).toBeNull();
  });

  it('rejects unknown backend id', () => {
    expect(parseBackendProbeRequest(validRequest({ backendId: 'gemini' as 'claude' }))).toBeNull();
  });

  it('rejects empty or overlong probeId', () => {
    expect(parseBackendProbeRequest(validRequest({ probeId: '' }))).toBeNull();
    expect(
      parseBackendProbeRequest(validRequest({ probeId: 'p'.repeat(BACKEND_PROBE_ID_MAX + 1) })),
    ).toBeNull();
  });

  it('rejects extra or missing keys', () => {
    expect(parseBackendProbeRequest({ ...validRequest(), secret: 'x' })).toBeNull();
    const { probeId: _drop, ...missing } = validRequest();
    expect(parseBackendProbeRequest(missing)).toBeNull();
  });
});

describe('parseBackendProbeProgress', () => {
  it('accepts a valid progress round-trip', () => {
    const valid = validProgress();
    expect(parseBackendProbeProgress(valid)).toEqual(valid);
  });

  it('rejects null/array and unknown stage/backend', () => {
    expect(parseBackendProbeProgress(null)).toBeNull();
    expect(parseBackendProbeProgress([])).toBeNull();
    expect(parseBackendProbeProgress(validProgress({ stage: 'prompt' as 'initialize' }))).toBeNull();
    expect(parseBackendProbeProgress(validProgress({ backendId: 'gemini' as 'claude' }))).toBeNull();
  });

  it('rejects malformed timestamp, empty/overlong probeId, wrong schema, extra keys', () => {
    expect(parseBackendProbeProgress(validProgress({ startedAt: 'not-a-date' }))).toBeNull();
    expect(parseBackendProbeProgress(validProgress({ startedAt: '' }))).toBeNull();
    expect(parseBackendProbeProgress(validProgress({ probeId: '' }))).toBeNull();
    expect(
      parseBackendProbeProgress(validProgress({ probeId: 'p'.repeat(BACKEND_PROBE_ID_MAX + 1) })),
    ).toBeNull();
    expect(parseBackendProbeProgress(validProgress({ schemaVersion: 2 as 1 }))).toBeNull();
    expect(parseBackendProbeProgress({ ...validProgress(), secret: 1 })).toBeNull();
  });
});

describe('parseBackendProbeResult', () => {
  it('accepts a valid result round-trip', () => {
    const valid = validResult();
    expect(parseBackendProbeResult(valid)).toEqual(valid);
  });

  it('accepts null versionEvidence', () => {
    const valid = validResult({ versionEvidence: null });
    expect(parseBackendProbeResult(valid)).toEqual(valid);
  });

  it('rejects null/array input', () => {
    expect(parseBackendProbeResult(null)).toBeNull();
    expect(parseBackendProbeResult([])).toBeNull();
  });

  it('rejects unknown outcome/code/recovery/compatibility/stage/backend', () => {
    expect(parseBackendProbeResult(validResult({ outcome: 'success' as 'ready' }))).toBeNull();
    expect(parseBackendProbeResult(validResult({ code: 'raw_stderr' as 'none' }))).toBeNull();
    expect(parseBackendProbeResult(validResult({ recoveryAction: 'reboot' as 'none' }))).toBeNull();
    expect(
      parseBackendProbeResult(validResult({ compatibility: 'maybe' as 'compatible' })),
    ).toBeNull();
    expect(parseBackendProbeResult(validResult({ lastStage: 'prompt' as 'session' }))).toBeNull();
    expect(parseBackendProbeResult(validResult({ backendId: 'gemini' as 'claude' }))).toBeNull();
  });

  it('rejects empty/overlong probeId and overlong versionEvidence', () => {
    expect(parseBackendProbeResult(validResult({ probeId: '' }))).toBeNull();
    expect(
      parseBackendProbeResult(validResult({ probeId: 'p'.repeat(BACKEND_PROBE_ID_MAX + 1) })),
    ).toBeNull();
    expect(parseBackendProbeResult(validResult({ versionEvidence: 'v'.repeat(65) }))).toBeNull();
    expect(parseBackendProbeResult(validResult({ versionEvidence: '' }))).toBeNull();
  });

  it('rejects malformed timestamp, wrong schema, non-boolean modelCatalogAvailable, extra keys', () => {
    expect(parseBackendProbeResult(validResult({ checkedAt: 'yesterday' }))).toBeNull();
    expect(parseBackendProbeResult(validResult({ schemaVersion: 0 as 1 }))).toBeNull();
    expect(
      parseBackendProbeResult({ ...validResult(), modelCatalogAvailable: 'yes' }),
    ).toBeNull();
    expect(parseBackendProbeResult({ ...validResult(), secret: true })).toBeNull();
  });
});

describe('probeOutcomeToReadinessState', () => {
  it('maps each outcome including cancelled→installed_unverified', () => {
    expect(probeOutcomeToReadinessState('ready')).toBe('ready');
    expect(probeOutcomeToReadinessState('auth_required')).toBe('auth_required');
    expect(probeOutcomeToReadinessState('incompatible')).toBe('incompatible');
    expect(probeOutcomeToReadinessState('failed')).toBe('failed');
    expect(probeOutcomeToReadinessState('cancelled')).toBe('installed_unverified');
  });
});

describe('applyBackendProbeResult', () => {
  it('layers a ready result onto only the matching backend without mutating input', () => {
    const backends = fiveBackends({
      claude: {
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        compatibility: 'unknown',
        versionEvidence: '1.0.0',
      },
      grok: {
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility: 'compatible',
        versionEvidence: '2.0.0',
      },
    });
    const snapshot = settledSnapshot(backends);
    Object.freeze(snapshot);
    Object.freeze(snapshot.backends);
    for (const record of snapshot.backends) Object.freeze(record);

    const result = validResult({
      backendId: 'claude',
      outcome: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
      versionEvidence: '1.2.3',
      checkedAt: '2026-07-25T01:00:00.000Z',
    });

    const next = applyBackendProbeResult(snapshot, result);

    expect(next).not.toBe(snapshot);
    expect(next.backends).not.toBe(snapshot.backends);
    expect(next.phase).toBe('settled');
    expect(next.correlationId).toBe('corr-1');
    expect(next.backends[0]).toEqual({
      backendId: 'claude',
      state: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
      versionEvidence: '1.2.3',
      checkedAt: '2026-07-25T01:00:00.000Z',
    });
    // Sibling records remain reference-equal.
    expect(next.backends[1]).toBe(snapshot.backends[1]);
    expect(next.backends[2]).toBe(snapshot.backends[2]);
    expect(next.backends[3]).toBe(snapshot.backends[3]);
    expect(next.backends[4]).toBe(snapshot.backends[4]);
    // Original input untouched.
    expect(snapshot.backends[0].state).toBe('installed_unverified');
  });

  it('maps auth_required and failed outcomes correctly', () => {
    const snapshot = settledSnapshot(
      fiveBackends({
        claude: {
          state: 'testing',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '1.2.3',
        },
      }),
    );

    const auth = applyBackendProbeResult(
      snapshot,
      validResult({
        outcome: 'auth_required',
        code: 'auth_required',
        recoveryAction: 'login',
      }),
    );
    expect(auth.backends[0].state).toBe('auth_required');
    expect(auth.backends[0].code).toBe('auth_required');
    expect(auth.backends[0].recoveryAction).toBe('login');

    const failed = applyBackendProbeResult(
      snapshot,
      validResult({
        outcome: 'failed',
        code: 'acp_initialize_failed',
        recoveryAction: 'retry',
      }),
    );
    expect(failed.backends[0].state).toBe('failed');
    expect(failed.backends[0].code).toBe('acp_initialize_failed');
  });

  it('maps cancelled back to installed_unverified without claiming failure', () => {
    const snapshot = settledSnapshot(
      fiveBackends({
        claude: {
          state: 'testing',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'unknown',
          versionEvidence: '1.0.0',
        },
      }),
    );
    const next = applyBackendProbeResult(
      snapshot,
      validResult({
        outcome: 'cancelled',
        code: 'cancelled',
        recoveryAction: 'none',
        compatibility: 'unknown',
        versionEvidence: '1.0.0',
      }),
    );
    expect(next.backends[0].state).toBe('installed_unverified');
    expect(next.backends[0].code).toBe('cancelled');
  });

  it('is a no-op when the backend id is absent from the snapshot', () => {
    // Build a snapshot that only has the five allowlisted backends, then pass a
    // result whose backendId is allowlisted but not present because we simulate
    // absence by targeting a backend that we remove via a custom backends list
    // that the reducer still iterates — the contract says return input unchanged
    // when backend id is absent. Use a snapshot whose backends omit the target
    // by constructing a valid five-backend snapshot and asserting no-op for a
    // backend that exists but is already identical is NOT the case; instead
    // exercise the absent path via a result for a backend that won't match any
    // record after we hand a malformed-for-lookup snapshot with only four
    // records (allowed for the pure reducer — it is not a parser).
    const partial = settledSnapshot([
      baseRecord({
        backendId: 'claude',
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
      }),
      baseRecord({ backendId: 'grok' }),
      baseRecord({ backendId: 'kiro' }),
      baseRecord({ backendId: 'codex' }),
      // opencode present as missing — result for a synthetic miss uses backendId
      // that simply does not appear: the reducer walks backends and finds none.
    ]);
    // Remove opencode by replacing backends with four entries.
    const fourOnly: BackendReadinessSnapshot = {
      ...partial,
      backends: partial.backends.slice(0, 4),
    };
    Object.freeze(fourOnly);
    Object.freeze(fourOnly.backends);

    const next = applyBackendProbeResult(
      fourOnly,
      validResult({ backendId: 'opencode', outcome: 'ready' }),
    );
    expect(next).toBe(fourOnly);
  });
});

describe('applyBackendProbeTesting', () => {
  it('sets only the target record to testing and preserves version evidence', () => {
    const backends = fiveBackends({
      claude: {
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        compatibility: 'unknown',
        versionEvidence: '1.2.3',
      },
    });
    const snapshot = settledSnapshot(backends);
    Object.freeze(snapshot);
    Object.freeze(snapshot.backends);
    for (const record of snapshot.backends) Object.freeze(record);

    const next = applyBackendProbeTesting(snapshot, 'claude', '2026-07-25T02:00:00.000Z');
    expect(next).not.toBe(snapshot);
    expect(next.backends[0]).toEqual({
      backendId: 'claude',
      state: 'testing',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'unknown',
      versionEvidence: '1.2.3',
      checkedAt: '2026-07-25T02:00:00.000Z',
    });
    expect(next.backends[1]).toBe(snapshot.backends[1]);
    expect(snapshot.backends[0].state).toBe('installed_unverified');
  });

  it('returns input unchanged for unknown backend id', () => {
    const snapshot = settledSnapshot(fiveBackends());
    Object.freeze(snapshot);
    Object.freeze(snapshot.backends);
    // Cast only for the no-op path; production callers pass allowlisted ids.
    const next = applyBackendProbeTesting(
      snapshot,
      'gemini' as (typeof BACKEND_READINESS_IDS)[number],
      '2026-07-25T02:00:00.000Z',
    );
    expect(next).toBe(snapshot);
  });
});

describe('isProbeEligible', () => {
  it('is true for installed_unverified / ready / auth_required when not incompatible', () => {
    expect(
      isProbeEligible(
        baseRecord({
          backendId: 'claude',
          state: 'installed_unverified',
          code: 'version_unknown',
          recoveryAction: 'retry',
          compatibility: 'unknown',
        }),
      ),
    ).toBe(true);
    expect(
      isProbeEligible(
        baseRecord({
          backendId: 'claude',
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
        }),
      ),
    ).toBe(true);
    expect(
      isProbeEligible(
        baseRecord({
          backendId: 'claude',
          state: 'auth_required',
          code: 'auth_required',
          recoveryAction: 'login',
          compatibility: 'compatible',
        }),
      ),
    ).toBe(true);
  });

  it('is false for missing, checking, testing, and known-incompatible records', () => {
    expect(
      isProbeEligible(
        baseRecord({
          backendId: 'claude',
          state: 'missing',
          code: 'executable_missing',
          recoveryAction: 'install',
        }),
      ),
    ).toBe(false);
    expect(
      isProbeEligible(
        baseRecord({
          backendId: 'claude',
          state: 'checking',
          code: 'none',
          recoveryAction: 'none',
        }),
      ),
    ).toBe(false);
    expect(
      isProbeEligible(
        baseRecord({
          backendId: 'claude',
          state: 'testing',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '1.0.0',
        }),
      ),
    ).toBe(false);
    expect(
      isProbeEligible(
        baseRecord({
          backendId: 'claude',
          state: 'installed_unverified',
          code: 'version_incompatible',
          recoveryAction: 'update',
          compatibility: 'incompatible',
          versionEvidence: '0.1.0',
        }),
      ),
    ).toBe(false);
  });
});
