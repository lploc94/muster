import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../../../src/shared/backend-readiness';
import {
  pickerOptionLabelForRecord,
  resolveDraftComposerEligibility,
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
});
