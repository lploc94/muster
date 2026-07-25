import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from './backend-readiness';
import {
  RUNTIME_SETUP_FAILURE_CODES,
  applyRuntimeSetupFailure,
  classifyRuntimeSetupFailure,
  mapRuntimeSetupFailure,
  type RuntimeSetupFailureCode,
} from './backend-runtime-recovery';

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

function fiveBackends(
  overrides: Partial<
    Record<(typeof BACKEND_READINESS_IDS)[number], Partial<BackendReadinessRecord>>
  > = {},
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

describe('RUNTIME_SETUP_FAILURE_CODES', () => {
  it('is a closed subset of the readiness diagnostic taxonomy (no second vocabulary)', () => {
    expect(RUNTIME_SETUP_FAILURE_CODES).toEqual([
      'executable_missing',
      'auth_required',
      'version_incompatible',
      'version_unknown',
      'acp_initialize_failed',
      'session_probe_failed',
      'process_exited',
      'timeout',
      'internal_error',
    ]);
  });
});

describe('mapRuntimeSetupFailure', () => {
  it('maps each setup failure code onto state + recoveryAction + compatibility', () => {
    const cases: Array<{
      code: RuntimeSetupFailureCode;
      state: BackendReadinessRecord['state'];
      recoveryAction: BackendReadinessRecord['recoveryAction'];
      compatibility: BackendReadinessRecord['compatibility'];
    }> = [
      {
        code: 'executable_missing',
        state: 'missing',
        recoveryAction: 'install',
        compatibility: 'unknown',
      },
      {
        code: 'auth_required',
        state: 'auth_required',
        recoveryAction: 'login',
        compatibility: 'compatible',
      },
      {
        code: 'version_incompatible',
        state: 'incompatible',
        recoveryAction: 'update',
        compatibility: 'incompatible',
      },
      {
        code: 'version_unknown',
        state: 'installed_unverified',
        recoveryAction: 'none',
        compatibility: 'unknown',
      },
      {
        code: 'acp_initialize_failed',
        state: 'failed',
        recoveryAction: 'retry',
        compatibility: 'compatible',
      },
      {
        code: 'session_probe_failed',
        state: 'failed',
        recoveryAction: 'retry',
        compatibility: 'compatible',
      },
      {
        code: 'process_exited',
        state: 'failed',
        recoveryAction: 'retry',
        compatibility: 'compatible',
      },
      {
        code: 'timeout',
        state: 'failed',
        recoveryAction: 'retry',
        compatibility: 'compatible',
      },
      {
        code: 'internal_error',
        state: 'failed',
        recoveryAction: 'retry',
        compatibility: 'compatible',
      },
    ];

    for (const c of cases) {
      expect(mapRuntimeSetupFailure(c.code)).toEqual({
        state: c.state,
        code: c.code,
        recoveryAction: c.recoveryAction,
        compatibility: c.compatibility,
      });
    }
  });

  it('never returns raw message text or secrets — only closed enums', () => {
    const mapped = mapRuntimeSetupFailure('auth_required');
    for (const value of Object.values(mapped)) {
      expect(typeof value === 'string').toBe(true);
      expect(String(value)).not.toMatch(/sk-|Bearer |password|api[_-]?key=/i);
    }
  });
});

describe('classifyRuntimeSetupFailure', () => {
  it('maps spawn ENOENT / not-found signals to executable_missing', () => {
    expect(
      classifyRuntimeSetupFailure({
        stage: 'spawn',
        errorCode: 'ENOENT',
      }),
    ).toBe('executable_missing');
    expect(
      classifyRuntimeSetupFailure({
        stage: 'spawn',
        message: 'spawn claude ENOENT',
      }),
    ).toBe('executable_missing');
    expect(
      classifyRuntimeSetupFailure({
        message: 'command not found: codex',
      }),
    ).toBe('executable_missing');
  });

  it('maps auth-shaped messages and codes to auth_required', () => {
    expect(
      classifyRuntimeSetupFailure({
        stage: 'authenticate',
        message: 'not authenticated — please login',
      }),
    ).toBe('auth_required');
    expect(
      classifyRuntimeSetupFailure({
        stage: 'session',
        message: 'Unauthorized: invalid credentials',
      }),
    ).toBe('auth_required');
    expect(
      classifyRuntimeSetupFailure({
        errorCode: 'auth_required',
      }),
    ).toBe('auth_required');
  });

  it('maps process-exit and timeout signals', () => {
    expect(
      classifyRuntimeSetupFailure({
        stage: 'initialize',
        message: 'Claude agent exited (code 1)',
      }),
    ).toBe('process_exited');
    expect(
      classifyRuntimeSetupFailure({
        errorCode: 'setup_timeout',
      }),
    ).toBe('timeout');
    expect(
      classifyRuntimeSetupFailure({
        message: 'ACP setup timed out before run deadline',
      }),
    ).toBe('timeout');
  });

  it('maps initialize vs session stages when message is generic', () => {
    expect(
      classifyRuntimeSetupFailure({
        stage: 'initialize',
        message: 'handshake failed',
      }),
    ).toBe('acp_initialize_failed');
    expect(
      classifyRuntimeSetupFailure({
        stage: 'session',
        message: 'session/new rejected',
      }),
    ).toBe('session_probe_failed');
  });

  it('maps known version signals already in the readiness taxonomy', () => {
    expect(
      classifyRuntimeSetupFailure({
        stage: 'version',
        errorCode: 'version_incompatible',
      }),
    ).toBe('version_incompatible');
    expect(
      classifyRuntimeSetupFailure({
        stage: 'version',
        errorCode: 'version_unknown',
      }),
    ).toBe('version_unknown');
  });

  it('returns null for unmapped / empty signals (fail-closed — no invented codes)', () => {
    expect(classifyRuntimeSetupFailure({})).toBeNull();
    expect(
      classifyRuntimeSetupFailure({
        message: 'model returned a content filter',
      }),
    ).toBeNull();
    expect(
      classifyRuntimeSetupFailure({
        stage: 'unknown',
        message: 'user cancelled the turn',
      }),
    ).toBeNull();
  });

  it('never echoes the raw message into the classification result type', () => {
    const code = classifyRuntimeSetupFailure({
      stage: 'initialize',
      message: 'secret=sk-abc123 /Users/me/.config/token',
    });
    // Result is a closed enum string only.
    expect(code).toBe('acp_initialize_failed');
    expect(code).not.toContain('sk-');
    expect(code).not.toContain('/Users');
  });
});

describe('applyRuntimeSetupFailure', () => {
  it('updates only the failing provider with mapped taxonomy and new checkedAt', () => {
    const snapshot = settledSnapshot(
      fiveBackends({
        claude: {
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '1.2.3',
          checkedAt: '2026-07-25T00:00:00.000Z',
        },
        grok: {
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '2.0.0',
        },
      }),
    );
    Object.freeze(snapshot);
    Object.freeze(snapshot.backends);
    for (const record of snapshot.backends) Object.freeze(record);

    const next = applyRuntimeSetupFailure(snapshot, {
      backendId: 'claude',
      code: 'auth_required',
      checkedAt: '2026-07-25T12:00:00.000Z',
    });

    expect(next).not.toBe(snapshot);
    expect(next.backends).not.toBe(snapshot.backends);
    expect(next.phase).toBe('settled');
    expect(next.correlationId).toBe('corr-1');
    // Snapshot-level checkedAt is preserved — only the record is re-evidenced.
    expect(next.checkedAt).toBe(snapshot.checkedAt);

    expect(next.backends[0]).toEqual({
      backendId: 'claude',
      state: 'auth_required',
      code: 'auth_required',
      recoveryAction: 'login',
      compatibility: 'compatible',
      versionEvidence: '1.2.3',
      checkedAt: '2026-07-25T12:00:00.000Z',
    });
    // Siblings remain reference-equal.
    expect(next.backends[1]).toBe(snapshot.backends[1]);
    expect(next.backends[2]).toBe(snapshot.backends[2]);
    expect(next.backends[3]).toBe(snapshot.backends[3]);
    expect(next.backends[4]).toBe(snapshot.backends[4]);
    // Input untouched.
    expect(snapshot.backends[0].state).toBe('ready');
  });

  it('maps executable_missing to missing+install without leaking paths', () => {
    const snapshot = settledSnapshot(
      fiveBackends({
        codex: {
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '0.9.0',
        },
      }),
    );
    const next = applyRuntimeSetupFailure(snapshot, {
      backendId: 'codex',
      code: 'executable_missing',
      checkedAt: '2026-07-25T13:00:00.000Z',
    });
    const record = next.backends.find((r) => r.backendId === 'codex');
    expect(record).toEqual({
      backendId: 'codex',
      state: 'missing',
      code: 'executable_missing',
      recoveryAction: 'install',
      compatibility: 'unknown',
      versionEvidence: '0.9.0',
      checkedAt: '2026-07-25T13:00:00.000Z',
    });
  });

  it('maps version_incompatible and acp/session/process/timeout failures like the probe taxonomy', () => {
    const snapshot = settledSnapshot(
      fiveBackends({
        claude: {
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '1.0.0',
        },
      }),
    );

    const incompatible = applyRuntimeSetupFailure(snapshot, {
      backendId: 'claude',
      code: 'version_incompatible',
      checkedAt: '2026-07-25T14:00:00.000Z',
      versionEvidence: '0.1.0',
    });
    expect(incompatible.backends[0]).toMatchObject({
      state: 'incompatible',
      code: 'version_incompatible',
      recoveryAction: 'update',
      compatibility: 'incompatible',
      versionEvidence: '0.1.0',
    });

    const acp = applyRuntimeSetupFailure(snapshot, {
      backendId: 'claude',
      code: 'acp_initialize_failed',
      checkedAt: '2026-07-25T14:01:00.000Z',
    });
    expect(acp.backends[0]).toMatchObject({
      state: 'failed',
      code: 'acp_initialize_failed',
      recoveryAction: 'retry',
    });

    const session = applyRuntimeSetupFailure(snapshot, {
      backendId: 'claude',
      code: 'session_probe_failed',
      checkedAt: '2026-07-25T14:02:00.000Z',
    });
    expect(session.backends[0]).toMatchObject({
      state: 'failed',
      code: 'session_probe_failed',
      recoveryAction: 'retry',
    });

    const exited = applyRuntimeSetupFailure(snapshot, {
      backendId: 'claude',
      code: 'process_exited',
      checkedAt: '2026-07-25T14:03:00.000Z',
    });
    expect(exited.backends[0]).toMatchObject({
      state: 'failed',
      code: 'process_exited',
      recoveryAction: 'retry',
    });

    const timedOut = applyRuntimeSetupFailure(snapshot, {
      backendId: 'claude',
      code: 'timeout',
      checkedAt: '2026-07-25T14:04:00.000Z',
    });
    expect(timedOut.backends[0]).toMatchObject({
      state: 'failed',
      code: 'timeout',
      recoveryAction: 'retry',
    });
  });

  it('is a no-op when the backend id is absent from the snapshot', () => {
    const fourOnly: BackendReadinessSnapshot = {
      schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
      correlationId: 'corr-1',
      phase: 'settled',
      checkedAt: '2026-07-25T00:00:00.000Z',
      backends: [
        baseRecord({ backendId: 'claude', state: 'ready', code: 'none', recoveryAction: 'none' }),
        baseRecord({ backendId: 'grok' }),
        baseRecord({ backendId: 'kiro' }),
        baseRecord({ backendId: 'codex' }),
      ],
    };
    const next = applyRuntimeSetupFailure(fourOnly, {
      backendId: 'opencode',
      code: 'auth_required',
      checkedAt: '2026-07-25T15:00:00.000Z',
    });
    expect(next).toBe(fourOnly);
  });

  it('preserves prior versionEvidence when the signal does not supply a replacement', () => {
    const snapshot = settledSnapshot(
      fiveBackends({
        kiro: {
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: '3.4.5',
        },
      }),
    );
    const next = applyRuntimeSetupFailure(snapshot, {
      backendId: 'kiro',
      code: 'process_exited',
      checkedAt: '2026-07-25T16:00:00.000Z',
    });
    expect(next.backends.find((r) => r.backendId === 'kiro')?.versionEvidence).toBe('3.4.5');
  });

  it('allows an explicit null versionEvidence override (sanitized empty evidence)', () => {
    const snapshot = settledSnapshot(
      fiveBackends({
        opencode: {
          state: 'ready',
          code: 'none',
          recoveryAction: 'none',
          compatibility: 'compatible',
          versionEvidence: 'stale-1.0',
        },
      }),
    );
    const next = applyRuntimeSetupFailure(snapshot, {
      backendId: 'opencode',
      code: 'executable_missing',
      checkedAt: '2026-07-25T17:00:00.000Z',
      versionEvidence: null,
    });
    expect(next.backends.find((r) => r.backendId === 'opencode')?.versionEvidence).toBeNull();
  });
});
