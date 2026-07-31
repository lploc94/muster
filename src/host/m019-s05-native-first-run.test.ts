/**
 * M019/S05 T01 — Non-production native first-run acceptance adapter.
 *
 * Proves the adapter:
 * - observes readiness refresh / isolated probe / Doctor / first-send / cleanup
 * - delegates to production path deps (never reimplements eligibility)
 * - emits only bounded sanitized fields (no secrets, prompts, paths, store bodies)
 * - maps unavailable providers to ENVIRONMENT_BLOCKED rather than forged PASS
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../shared/backend-readiness';
import {
  NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION,
  NATIVE_FIRST_RUN_UAT_PROMPT,
  NATIVE_FIRST_RUN_UAT_COMMANDS,
  boundProviderObservation,
  isNativeFirstRunProviderId,
  observeNativeCleanup,
  observeNativeDoctor,
  observeNativeFirstTaskAcceptance,
  observeNativeIsolatedProbe,
  observeNativeReadinessRefresh,
  parseNativeFirstRunObservation,
  type NativeFirstRunObservation,
} from './m019-s05-native-first-run';
import { isUatModeEnabled, UAT_COMMANDS } from './uat-commands';

function readinessRecord(
  backendId: BackendReadinessId,
  overrides: Partial<BackendReadinessRecord> = {},
): BackendReadinessRecord {
  return {
    backendId,
    state: 'ready',
    code: 'none',
    recoveryAction: 'none',
    compatibility: 'compatible',
    versionEvidence: '2.1.4',
    checkedAt: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

function settledSnapshot(
  overrides: Partial<BackendReadinessSnapshot> = {},
  perProvider: Partial<Record<BackendReadinessId, Partial<BackendReadinessRecord>>> = {},
): BackendReadinessSnapshot {
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 's05-corr',
    phase: 'settled',
    checkedAt: '2026-07-26T12:00:00.000Z',
    backends: BACKEND_READINESS_IDS.map((id) =>
      readinessRecord(id, perProvider[id] ?? {}),
    ),
    ...overrides,
  };
}

function fixedNow(): Date {
  return new Date('2026-07-26T12:34:56.000Z');
}

describe('M019 S05 native first-run adapter (T01)', () => {
  it('exports allowlisted UAT command ids under muster.uat.* and env flag is sole opt-in', () => {
    expect(NATIVE_FIRST_RUN_UAT_COMMANDS.refreshReadiness).toBe(
      'muster.uat.refreshReadiness',
    );
    expect(NATIVE_FIRST_RUN_UAT_COMMANDS.probeBackend).toBe('muster.uat.probeBackend');
    expect(NATIVE_FIRST_RUN_UAT_COMMANDS.runDoctor).toBe('muster.uat.runDoctor');
    expect(NATIVE_FIRST_RUN_UAT_COMMANDS.acceptFirstTask).toBe(
      'muster.uat.acceptFirstTask',
    );
    expect(NATIVE_FIRST_RUN_UAT_COMMANDS.cleanup).toBe('muster.uat.nativeFirstRunCleanup');

    // Surfaced on the shared UAT command table for registration.
    expect(UAT_COMMANDS.refreshReadiness).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.refreshReadiness);
    expect(UAT_COMMANDS.probeBackend).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.probeBackend);
    expect(UAT_COMMANDS.runDoctor).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.runDoctor);
    expect(UAT_COMMANDS.acceptFirstTask).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.acceptFirstTask);
    expect(UAT_COMMANDS.nativeFirstRunCleanup).toBe(NATIVE_FIRST_RUN_UAT_COMMANDS.cleanup);

    // MUSTER_UAT_MODE=1 enables UAT even under Production ExtensionMode so the
    // M022/S05 install gate can observe bridge health from a CLI-installed VSIX.
    expect(isUatModeEnabled(true, { MUSTER_UAT_MODE: '1' })).toBe(true);
    expect(isUatModeEnabled(false, { MUSTER_UAT_MODE: '1' })).toBe(true);
    expect(isUatModeEnabled(true, {})).toBe(false);
  });

  it('accepts only allowlisted provider ids', () => {
    expect(isNativeFirstRunProviderId('claude')).toBe(true);
    expect(isNativeFirstRunProviderId('grok')).toBe(true);
    expect(isNativeFirstRunProviderId('not-a-backend')).toBe(false);
    expect(isNativeFirstRunProviderId('')).toBe(false);
    expect(isNativeFirstRunProviderId(null)).toBe(false);
  });

  it('bounds provider observation to sanitized readiness fields only', () => {
    const bounded = boundProviderObservation(
      readinessRecord('claude', {
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        versionEvidence: '1.2.3',
        checkedAt: '2026-07-26T11:00:00.000Z',
      }),
    );
    expect(bounded).toEqual({
      providerId: 'claude',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      checkedAt: '2026-07-26T11:00:00.000Z',
    });
    expect(JSON.stringify(bounded)).not.toMatch(/versionEvidence|1\.2\.3/);
  });

  it('observeNativeReadinessRefresh delegates to production refresh and reports settled provider state', async () => {
    const snapshot = settledSnapshot({}, {
      claude: {
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
      },
    });
    const refreshAndPublishReadiness = vi.fn(async () => undefined);
    const observation = await observeNativeReadinessRefresh('claude', {
      refreshAndPublishReadiness,
      getReadinessSnapshot: () => snapshot,
      now: fixedNow,
    });

    expect(refreshAndPublishReadiness).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      schemaVersion: NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION,
      providerId: 'claude',
      attemptedStep: 'refresh',
      verdict: 'PASS',
      evidenceAt: '2026-07-26T12:34:56.000Z',
      readiness: {
        providerId: 'claude',
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        checkedAt: '2026-07-26T12:00:00.000Z',
      },
    });
  });

  it('observeNativeReadinessRefresh marks host_unavailable as ENVIRONMENT_BLOCKED when refresh throws', async () => {
    const observation = await observeNativeReadinessRefresh('grok', {
      refreshAndPublishReadiness: async () => {
        throw new Error('secret PATH=/usr/bin/grok token=sk-live-xyz');
      },
      getReadinessSnapshot: () => null,
      now: fixedNow,
    });

    expect(observation.verdict).toBe('ENVIRONMENT_BLOCKED');
    expect(observation.environmentBlockCode).toBe('host_unavailable');
    expect(observation.attemptedStep).toBe('refresh');
    expect(JSON.stringify(observation)).not.toMatch(/sk-live|PATH=|\/usr\/bin/);
  });

  it('observeNativeIsolatedProbe routes through production startProbe and reports ready PASS', async () => {
    const after = settledSnapshot({}, {
      kiro: { state: 'ready', code: 'none', recoveryAction: 'none' },
    });
    const routeStart = vi.fn(async () => ({
      kind: 'completed' as const,
      probeId: 'probe-1',
      backendId: 'kiro' as const,
      result: {
        probeId: 'probe-1',
        backendId: 'kiro' as const,
        outcome: 'ready' as const,
        code: 'none' as const,
        recoveryAction: 'none' as const,
        versionEvidence: '9.9.9',
        checkedAt: '2026-07-26T12:00:00.000Z',
        lastStage: 'models' as const,
      },
    }));

    const observation = await observeNativeIsolatedProbe('kiro', {
      routeStart,
      getReadinessSnapshot: () => after,
      createProbeId: () => 'probe-1',
      now: fixedNow,
    });

    expect(routeStart).toHaveBeenCalledWith({
      type: 'startBackendProbe',
      probeId: 'probe-1',
      backendId: 'kiro',
    });
    expect(observation.verdict).toBe('PASS');
    expect(observation.attemptedStep).toBe('probe');
    expect(observation.readiness?.state).toBe('ready');
    expect(JSON.stringify(observation)).not.toMatch(/9\.9\.9|versionEvidence/);
  });

  it('observeNativeIsolatedProbe maps missing/ineligible provider to ENVIRONMENT_BLOCKED', async () => {
    const observation = await observeNativeIsolatedProbe('opencode', {
      routeStart: async () => ({ kind: 'refused', reason: 'ineligible' }),
      getReadinessSnapshot: () =>
        settledSnapshot({}, {
          opencode: {
            state: 'missing',
            code: 'executable_missing',
            recoveryAction: 'install',
          },
        }),
      createProbeId: () => 'probe-x',
      now: fixedNow,
    });

    expect(observation.verdict).toBe('ENVIRONMENT_BLOCKED');
    expect(observation.environmentBlockCode).toBe('provider_missing');
    expect(observation.readiness).toMatchObject({
      providerId: 'opencode',
      state: 'missing',
      code: 'executable_missing',
      recoveryAction: 'install',
    });
  });

  it('observeNativeIsolatedProbe maps auth_required probe completion to ENVIRONMENT_BLOCKED', async () => {
    const observation = await observeNativeIsolatedProbe('codex', {
      routeStart: async () => ({
        kind: 'completed',
        probeId: 'p',
        backendId: 'codex',
        result: {
          probeId: 'p',
          backendId: 'codex',
          outcome: 'auth_required',
          code: 'auth_required',
          recoveryAction: 'login',
          versionEvidence: null,
          checkedAt: '2026-07-26T12:00:00.000Z',
          lastStage: 'authenticate',
        },
      }),
      getReadinessSnapshot: () =>
        settledSnapshot({}, {
          codex: {
            state: 'auth_required',
            code: 'auth_required',
            recoveryAction: 'login',
          },
        }),
      createProbeId: () => 'p',
      now: fixedNow,
    });

    expect(observation.verdict).toBe('ENVIRONMENT_BLOCKED');
    expect(observation.environmentBlockCode).toBe('auth_required');
  });

  it('observeNativeDoctor delegates to production Doctor handler and records success', async () => {
    const runDoctor = vi.fn(async () => ({ kind: 'success' as const }));
    const observation = await observeNativeDoctor('claude', {
      runDoctor,
      getReadinessSnapshot: () => settledSnapshot(),
      now: fixedNow,
    });

    expect(runDoctor).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      attemptedStep: 'doctor',
      verdict: 'PASS',
      doctorResult: 'success',
      providerId: 'claude',
      readiness: { providerId: 'claude', state: 'ready' },
    });
  });

  it('observeNativeDoctor maps refresh_failed to ENVIRONMENT_BLOCKED without raw error text', async () => {
    const observation = await observeNativeDoctor('claude', {
      runDoctor: async () => ({ kind: 'error', code: 'refresh_failed' }),
      getReadinessSnapshot: () => null,
      now: fixedNow,
    });
    expect(observation.verdict).toBe('ENVIRONMENT_BLOCKED');
    expect(observation.doctorResult).toBe('refresh_failed');
    expect(observation.environmentBlockCode).toBe('doctor_failed');
  });

  it('observeNativeFirstTaskAcceptance records accepted without prompt or task bodies', async () => {
    const acceptFirstTask = vi.fn(async () => ({
      kind: 'accepted' as const,
      taskIdLength: 36,
      messageIdLength: 36,
    }));
    const observation = await observeNativeFirstTaskAcceptance('claude', {
      acceptFirstTask,
      getReadinessSnapshot: () => settledSnapshot(),
      createClientRequestId: () => 'uat-req-1',
      now: fixedNow,
    });

    expect(acceptFirstTask).toHaveBeenCalledWith({
      backendId: 'claude',
      clientRequestId: 'uat-req-1',
    });
    expect(observation.verdict).toBe('PASS');
    expect(observation.attemptedStep).toBe('first_send');
    expect(observation.firstSend).toEqual({ accepted: true });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain(NATIVE_FIRST_RUN_UAT_PROMPT);
    expect(serialized).not.toMatch(/taskId|messageId|content|prompt|goal/);
  });

  it('observeNativeFirstTaskAcceptance maps clean-workspace validation reject to FAIL when ready was expected', async () => {
    const observation = await observeNativeFirstTaskAcceptance('claude', {
      acceptFirstTask: async () => ({
        kind: 'rejected',
        code: 'validation',
      }),
      getReadinessSnapshot: () =>
        settledSnapshot({}, {
          claude: {
            state: 'installed_unverified',
            code: 'version_unknown',
            recoveryAction: 'retry',
          },
        }),
      createClientRequestId: () => 'uat-req-2',
      now: fixedNow,
    });

    expect(observation.verdict).toBe('FAIL');
    expect(observation.firstSend).toEqual({
      accepted: false,
      rejectCode: 'validation',
    });
    expect(observation.environmentBlockCode).toBeUndefined();
  });

  it('observeNativeFirstTaskAcceptance maps host_unavailable to ENVIRONMENT_BLOCKED', async () => {
    const observation = await observeNativeFirstTaskAcceptance('grok', {
      acceptFirstTask: async () => ({ kind: 'error', code: 'host_unavailable' }),
      getReadinessSnapshot: () => settledSnapshot(),
      createClientRequestId: () => 'uat-req-3',
      now: fixedNow,
    });
    expect(observation.verdict).toBe('ENVIRONMENT_BLOCKED');
    expect(observation.environmentBlockCode).toBe('host_unavailable');
  });

  it('observeNativeCleanup cancels probes and reports completion without payload bodies', async () => {
    const cancelProbe = vi.fn(() => true);
    const disposeAllProbes = vi.fn();
    const deleteCreatedTask = vi.fn(async () => undefined);

    const observation = await observeNativeCleanup('claude', {
      cancelProbe,
      disposeAllProbes,
      deleteCreatedTask,
      createdTaskId: 'task-abc',
      now: fixedNow,
    });

    expect(cancelProbe).toHaveBeenCalledWith('claude');
    expect(disposeAllProbes).toHaveBeenCalledTimes(1);
    expect(deleteCreatedTask).toHaveBeenCalledWith('task-abc');
    expect(observation).toMatchObject({
      attemptedStep: 'cleanup',
      verdict: 'PASS',
      cleanupCompleted: true,
      providerId: 'claude',
    });
    expect(JSON.stringify(observation)).not.toContain('task-abc');
  });

  it('parseNativeFirstRunObservation is fail-closed against secrets, prompts, paths, and store bodies', () => {
    const good: NativeFirstRunObservation = {
      schemaVersion: 1,
      providerId: 'claude',
      attemptedStep: 'probe',
      verdict: 'PASS',
      evidenceAt: '2026-07-26T12:34:56.000Z',
      readiness: {
        providerId: 'claude',
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        checkedAt: '2026-07-26T12:00:00.000Z',
      },
    };
    expect(parseNativeFirstRunObservation(good)).toEqual(good);

    expect(
      parseNativeFirstRunObservation({
        ...good,
        prompt: NATIVE_FIRST_RUN_UAT_PROMPT,
      }),
    ).toBeNull();
    expect(
      parseNativeFirstRunObservation({
        ...good,
        stderr: 'boom',
      }),
    ).toBeNull();
    expect(
      parseNativeFirstRunObservation({
        ...good,
        absolutePath: 'D:/secrets/token',
      }),
    ).toBeNull();
    expect(
      parseNativeFirstRunObservation({
        ...good,
        taskBody: { goal: 'x' },
      }),
    ).toBeNull();
    expect(parseNativeFirstRunObservation(null)).toBeNull();
    expect(parseNativeFirstRunObservation({ ...good, providerId: 'nope' })).toBeNull();
  });
});
