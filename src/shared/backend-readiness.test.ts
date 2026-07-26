import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  BACKEND_READINESS_STATES,
  BACKEND_READINESS_CODES,
  BACKEND_RECOVERY_ACTIONS,
  BACKEND_COMPATIBILITY_STATUSES,
  isBackendReadinessId,
  isPassivelySelectable,
  isTrustworthyFirstRunEligible,
  selectPickerBackends,
  derivePassivelySelectableBackendIds,
  parseBackendReadinessSnapshot,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from './backend-readiness';

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

function fiveMissing(): BackendReadinessRecord[] {
  return BACKEND_READINESS_IDS.map((backendId) => baseRecord({ backendId }));
}

describe('allowlists', () => {
  it('freezes the five ordered backend IDs', () => {
    expect(BACKEND_READINESS_IDS).toEqual(['claude', 'grok', 'kiro', 'codex', 'opencode']);
  });

  it('exposes closed state/code/action/compatibility taxonomies', () => {
    expect(BACKEND_READINESS_STATES).toContain('checking');
    expect(BACKEND_READINESS_STATES).toContain('installed_unverified');
    expect(BACKEND_READINESS_STATES).toContain('ready');
    expect(BACKEND_READINESS_STATES).toContain('incompatible');
    expect(BACKEND_READINESS_CODES).toContain('executable_missing');
    expect(BACKEND_READINESS_CODES).toContain('version_unknown');
    expect(BACKEND_READINESS_CODES).toContain('version_incompatible');
    expect(BACKEND_READINESS_CODES).toContain('auth_required');
    expect(BACKEND_RECOVERY_ACTIONS).toContain('install');
    expect(BACKEND_RECOVERY_ACTIONS).toContain('open_docs');
    expect(BACKEND_COMPATIBILITY_STATUSES).toEqual(['compatible', 'incompatible', 'unknown']);
  });

  it('isBackendReadinessId accepts only allowlisted ids', () => {
    expect(isBackendReadinessId('claude')).toBe(true);
    expect(isBackendReadinessId('gemini')).toBe(false);
    expect(isBackendReadinessId(null)).toBe(false);
  });
});

describe('D058 eligibility predicates', () => {
  it('passivelySelectable is true for installed_unverified when not known incompatible', () => {
    expect(
      isPassivelySelectable(
        baseRecord({
          backendId: 'claude',
          state: 'installed_unverified',
          code: 'version_unknown',
          recoveryAction: 'retry',
          compatibility: 'unknown',
          versionEvidence: '1.2.3',
        }),
      ),
    ).toBe(true);
  });

  it('passivelySelectable is true for ready', () => {
    expect(
      isPassivelySelectable(
        baseRecord({
          backendId: 'claude',
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '2.0.0',
        }),
      ),
    ).toBe(true);
  });

  it('passivelySelectable is true for testing and auth_required (detected, not incompatible)', () => {
    expect(
      isPassivelySelectable(
        baseRecord({
          backendId: 'grok',
          state: 'testing',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'unknown',
        }),
      ),
    ).toBe(true);
    expect(
      isPassivelySelectable(
        baseRecord({
          backendId: 'grok',
          state: 'auth_required',
          code: 'auth_required',
          recoveryAction: 'login',
          compatibility: 'compatible',
        }),
      ),
    ).toBe(true);
  });

  it('passivelySelectable is false for checking, missing, failed, incompatible', () => {
    for (const state of ['checking', 'missing', 'failed', 'incompatible'] as const) {
      expect(
        isPassivelySelectable(
          baseRecord({
            backendId: 'claude',
            state,
            code: state === 'missing' ? 'executable_missing' : 'internal_error',
            recoveryAction: state === 'missing' ? 'install' : 'retry',
          }),
        ),
      ).toBe(false);
    }
  });

  it('passivelySelectable is false when compatibility is known incompatible', () => {
    expect(
      isPassivelySelectable(
        baseRecord({
          backendId: 'codex',
          state: 'installed_unverified',
          code: 'version_incompatible',
          recoveryAction: 'update',
          compatibility: 'incompatible',
          versionEvidence: '0.1.0',
        }),
      ),
    ).toBe(false);
  });

  it('trustworthyFirstRunEligible is true only for ready', () => {
    expect(
      isTrustworthyFirstRunEligible(
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
      isTrustworthyFirstRunEligible(
        baseRecord({
          backendId: 'claude',
          state: 'installed_unverified',
          code: 'version_unknown',
          recoveryAction: 'retry',
          compatibility: 'unknown',
        }),
      ),
    ).toBe(false);
    expect(
      isTrustworthyFirstRunEligible(
        baseRecord({
          backendId: 'claude',
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'incompatible',
        }),
      ),
    ).toBe(false);
  });
});

describe('selectPickerBackends (tri-state)', () => {
  it('returns unknown for null / checking phase', () => {
    expect(selectPickerBackends(null)).toEqual({ kind: 'unknown' });
    expect(
      selectPickerBackends(
        settledSnapshot(fiveMissing(), { phase: 'checking' }),
      ),
    ).toEqual({ kind: 'unknown' });
  });

  it('returns empty when settled with zero passively selectable providers', () => {
    expect(selectPickerBackends(settledSnapshot(fiveMissing()))).toEqual({ kind: 'empty' });
  });

  it('returns ready with ordered passively selectable ids', () => {
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
      state: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
      versionEvidence: '2.0.0',
    });
    expect(selectPickerBackends(settledSnapshot(backends))).toEqual({
      kind: 'ready',
      backends: ['grok', 'codex'],
    });
  });

  it('excludes known-incompatible and missing from ready list', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'incompatible',
      code: 'version_incompatible',
      recoveryAction: 'update',
      compatibility: 'incompatible',
      versionEvidence: '0.0.1',
    });
    expect(selectPickerBackends(settledSnapshot(backends))).toEqual({ kind: 'empty' });
  });
});

describe('derivePassivelySelectableBackendIds', () => {
  it('returns ordered passively selectable ids from a settled snapshot', () => {
    const backends = fiveMissing();
    backends[4] = baseRecord({
      backendId: 'opencode',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
    });
    expect(derivePassivelySelectableBackendIds(settledSnapshot(backends))).toEqual(['opencode']);
  });

  it('returns empty for null or checking', () => {
    expect(derivePassivelySelectableBackendIds(null)).toEqual([]);
    expect(
      derivePassivelySelectableBackendIds(settledSnapshot(fiveMissing(), { phase: 'checking' })),
    ).toEqual([]);
  });
});

describe('parseBackendReadinessSnapshot', () => {
  const valid = settledSnapshot(fiveMissing());

  it('accepts a valid five-record settled snapshot', () => {
    expect(parseBackendReadinessSnapshot(valid)).toEqual(valid);
  });

  it('accepts checking phase with checking records', () => {
    const checking = settledSnapshot(
      BACKEND_READINESS_IDS.map((backendId) =>
        baseRecord({
          backendId,
          state: 'checking',
          code: 'none',
          recoveryAction: 'none',
        }),
      ),
      { phase: 'checking' },
    );
    expect(parseBackendReadinessSnapshot(checking)).toEqual(checking);
  });

  it('rejects null/undefined/non-object', () => {
    expect(parseBackendReadinessSnapshot(null)).toBeNull();
    expect(parseBackendReadinessSnapshot(undefined)).toBeNull();
    expect(parseBackendReadinessSnapshot('x')).toBeNull();
  });

  it('rejects wrong schemaVersion', () => {
    expect(parseBackendReadinessSnapshot({ ...valid, schemaVersion: 99 })).toBeNull();
    expect(parseBackendReadinessSnapshot({ ...valid, schemaVersion: '1' })).toBeNull();
  });

  it('rejects unknown phase/state/code/action/compatibility', () => {
    expect(parseBackendReadinessSnapshot({ ...valid, phase: 'done' })).toBeNull();
    const badState = fiveMissing();
    badState[0] = { ...badState[0], state: 'online' as never };
    expect(parseBackendReadinessSnapshot(settledSnapshot(badState))).toBeNull();
    const badCode = fiveMissing();
    badCode[0] = { ...badCode[0], code: 'boom' as never };
    expect(parseBackendReadinessSnapshot(settledSnapshot(badCode))).toBeNull();
    const badAction = fiveMissing();
    badAction[0] = { ...badAction[0], recoveryAction: 'reboot' as never };
    expect(parseBackendReadinessSnapshot(settledSnapshot(badAction))).toBeNull();
    const badCompat = fiveMissing();
    badCompat[0] = { ...badCompat[0], compatibility: 'maybe' as never };
    expect(parseBackendReadinessSnapshot(settledSnapshot(badCompat))).toBeNull();
  });

  it('rejects unknown, missing, extra, or duplicate backend ids', () => {
    const missingOne = fiveMissing().slice(0, 4);
    expect(parseBackendReadinessSnapshot(settledSnapshot(missingOne))).toBeNull();

    const extra = [...fiveMissing(), baseRecord({ backendId: 'claude' })];
    expect(parseBackendReadinessSnapshot(settledSnapshot(extra))).toBeNull();

    const wrongOrder = [...fiveMissing()].reverse();
    expect(parseBackendReadinessSnapshot(settledSnapshot(wrongOrder))).toBeNull();

    const unknownId = fiveMissing();
    unknownId[0] = { ...unknownId[0], backendId: 'gemini' as never };
    expect(parseBackendReadinessSnapshot(settledSnapshot(unknownId))).toBeNull();
  });

  it('rejects extra keys on snapshot or record', () => {
    expect(parseBackendReadinessSnapshot({ ...valid, secret: 'x' })).toBeNull();
    const withExtra = fiveMissing();
    withExtra[0] = { ...withExtra[0], path: '/usr/bin/claude' } as never;
    expect(parseBackendReadinessSnapshot(settledSnapshot(withExtra))).toBeNull();
  });

  it('rejects overlong correlationId, versionEvidence, and malformed timestamps', () => {
    expect(
      parseBackendReadinessSnapshot({ ...valid, correlationId: 'c'.repeat(200) }),
    ).toBeNull();
    expect(parseBackendReadinessSnapshot({ ...valid, correlationId: '' })).toBeNull();
    expect(parseBackendReadinessSnapshot({ ...valid, checkedAt: 'not-a-date' })).toBeNull();
    expect(parseBackendReadinessSnapshot({ ...valid, checkedAt: 0 })).toBeNull();

    const longEvidence = fiveMissing();
    longEvidence[0] = {
      ...longEvidence[0],
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: 'v'.repeat(200),
    };
    expect(parseBackendReadinessSnapshot(settledSnapshot(longEvidence))).toBeNull();
  });

  it('rejects non-finite schemaVersion and null versionEvidence incorrectly typed', () => {
    expect(parseBackendReadinessSnapshot({ ...valid, schemaVersion: Number.NaN })).toBeNull();
    expect(parseBackendReadinessSnapshot({ ...valid, schemaVersion: Infinity })).toBeNull();
    const badEvidence = fiveMissing();
    badEvidence[0] = { ...badEvidence[0], versionEvidence: 12 as never };
    expect(parseBackendReadinessSnapshot(settledSnapshot(badEvidence))).toBeNull();
  });

  it('rejects empty or non-version versionEvidence (use null)', () => {
    const unsafeEvidence = [
      '',
      'sk-live-READINESS_SECRET_CANARY',
      'RAW_STDERR_CANARY',
      'PROMPT_BODY_CANARY',
      'C:\\Users\\secret\\muster.db',
      'STORE_BODY_CANARY',
    ];

    for (const versionEvidence of unsafeEvidence) {
      const backends = fiveMissing();
      backends[0] = {
        ...backends[0],
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        versionEvidence,
      };
      expect(
        parseBackendReadinessSnapshot(settledSnapshot(backends)),
        `versionEvidence=${versionEvidence}`,
      ).toBeNull();
    }
  });

  it('accepts null versionEvidence and bounded semver-like evidence strings', () => {
    const backends = fiveMissing();
    backends[0] = {
      ...backends[0],
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: '1.2.3',
    };
    const snap = settledSnapshot(backends);
    expect(parseBackendReadinessSnapshot(snap)).toEqual(snap);
  });
});
