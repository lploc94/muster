import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../../../src/shared/backend-readiness';
import { resolveDraftComposerEligibility } from './backend-eligibility';
import {
  OPEN_BACKEND_SETUP_LABEL,
  resolveComposerBackendSetupSurface,
  resolveOpenBackendSetupAction,
} from './composer-backend-setup';

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
    checkedAt: '2026-07-25T12:34:56.000Z',
  };
  return { ...base, ...overrides };
}

function settledSnapshot(backends: BackendReadinessRecord[]): BackendReadinessSnapshot {
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 'corr-setup-1',
    phase: 'settled',
    checkedAt: '2026-07-25T12:34:56.000Z',
    backends,
  };
}

function fiveMissing(): BackendReadinessRecord[] {
  return BACKEND_READINESS_IDS.map((backendId) => baseRecord({ backendId }));
}

describe('resolveComposerBackendSetupSurface', () => {
  it('hides surface in task mode', () => {
    const eligibility = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(fiveMissing()),
      preferredBackend: 'claude',
    });
    const surface = resolveComposerBackendSetupSurface({
      mode: 'task',
      eligibility,
    });
    expect(surface.visible).toBe(false);
    expect(surface.showOpenSetup).toBe(false);
  });

  it('shows open-setup when all backends are missing (blocked draft)', () => {
    const eligibility = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(fiveMissing()),
      preferredBackend: 'claude',
    });
    const surface = resolveComposerBackendSetupSurface({
      mode: 'draft',
      eligibility,
    });
    expect(surface.visible).toBe(true);
    expect(surface.showOpenSetup).toBe(true);
    expect(surface.needsSetup).toBe(true);
    expect(surface.setupGuidance.length).toBeGreaterThan(0);
  });

  it('shows open-setup for installed_unverified (relocated probe path)', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: '1.2.3',
    });
    const eligibility = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(backends),
      preferredBackend: 'claude',
    });
    expect(eligibility.canComposeNewTask).toBe(true);
    const surface = resolveComposerBackendSetupSurface({
      mode: 'draft',
      eligibility,
    });
    expect(surface.visible).toBe(true);
    expect(surface.showOpenSetup).toBe(true);
    expect(surface.needsSetup).toBe(true);
    expect(surface.setupGuidance).toMatch(/Test Connection|backend setup/i);
  });

  it('hides open-setup when display backend is ready', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
      versionEvidence: '1.0.0',
    });
    const eligibility = resolveDraftComposerEligibility({
      snapshot: settledSnapshot(backends),
      preferredBackend: 'claude',
    });
    const surface = resolveComposerBackendSetupSurface({
      mode: 'draft',
      eligibility,
    });
    expect(surface.needsSetup).toBe(false);
    expect(surface.showOpenSetup).toBe(false);
    expect(surface.visible).toBe(false);
  });

  it('shows guidance without open-setup while loading', () => {
    const eligibility = resolveDraftComposerEligibility({
      snapshot: null,
      preferredBackend: 'claude',
    });
    const surface = resolveComposerBackendSetupSurface({
      mode: 'draft',
      eligibility,
    });
    expect(surface.visible).toBe(true);
    expect(surface.showOpenSetup).toBe(false);
    expect(eligibility.setupGuidance).toMatch(/Checking/i);
  });
});

describe('resolveOpenBackendSetupAction', () => {
  it('deep-links to Agents with backends focus', () => {
    expect(resolveOpenBackendSetupAction()).toEqual({
      topicId: 'agents',
      focusBackends: true,
    });
    expect(OPEN_BACKEND_SETUP_LABEL).toMatch(/backend setup/i);
  });
});
