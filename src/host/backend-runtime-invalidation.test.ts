/**
 * M019/S04 T03 — Host runtime setup-failure → readiness invalidation.
 *
 * Proves: classify → pure reducer → replaceSnapshot + publish, fail-closed
 * skip for unmapped errors, no task/session/prompt mutation, no raw message
 * leakage into published readiness records.
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
  invalidateBackendReadinessFromRuntimeFailure,
  type RuntimeInvalidationDeps,
  type RuntimeInvalidationHostMessage,
  type RuntimeInvalidationSignal,
} from './backend-runtime-invalidation';

function record(
  backendId: BackendReadinessId,
  overrides: Partial<BackendReadinessRecord> = {},
): BackendReadinessRecord {
  return {
    backendId,
    state: 'ready',
    code: 'none',
    recoveryAction: 'none',
    compatibility: 'compatible',
    versionEvidence: '2.0.0',
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
    backends: BACKEND_READINESS_IDS.map((id) => record(id)),
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<RuntimeInvalidationDeps> = {},
): RuntimeInvalidationDeps & {
  posts: RuntimeInvalidationHostMessage[];
  applied: BackendReadinessSnapshot[];
  ensureCalls: number;
  taskMutations: string[];
} {
  const posts: RuntimeInvalidationHostMessage[] = [];
  const applied: BackendReadinessSnapshot[] = [];
  const taskMutations: string[] = [];
  let current: BackendReadinessSnapshot | null = snapshot();
  let ensureCalls = 0;

  const deps: RuntimeInvalidationDeps & {
    posts: RuntimeInvalidationHostMessage[];
    applied: BackendReadinessSnapshot[];
    ensureCalls: number;
    taskMutations: string[];
  } = {
    posts,
    applied,
    ensureCalls,
    taskMutations,
    getReadinessSnapshot: () => current,
    ensureReadiness: async () => {
      ensureCalls += 1;
      deps.ensureCalls = ensureCalls;
      if (!current) {
        current = snapshot({ correlationId: 'ensured' });
      }
      return current;
    },
    applySnapshot: (next) => {
      applied.push(next);
      current = next;
    },
    post: (message) => {
      posts.push(message);
    },
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    deriveAvailableBackends: (snap) =>
      snap.backends
        .filter((b) => b.state === 'ready' || b.state === 'installed_unverified')
        .map((b) => b.backendId),
    // Sentinel seams that must NEVER be invoked by invalidation:
    replayPrompt: () => {
      taskMutations.push('replayPrompt');
    },
    mutateTask: () => {
      taskMutations.push('mutateTask');
    },
    ...overrides,
  };
  return deps;
}

describe('invalidateBackendReadinessFromRuntimeFailure', () => {
  it('maps spawn ENOENT onto executable_missing and publishes only that provider', async () => {
    const deps = makeDeps();
    const signal: RuntimeInvalidationSignal = {
      backendId: 'claude',
      stage: 'spawn',
      errorCode: 'ENOENT',
      message: 'spawn claude ENOENT /Users/secret/.local/bin/claude',
    };

    const outcome = await invalidateBackendReadinessFromRuntimeFailure(signal, deps);

    expect(outcome).toEqual({ kind: 'applied', backendId: 'claude', code: 'executable_missing' });
    expect(deps.applied).toHaveLength(1);
    const next = deps.applied[0];
    const claude = next.backends.find((b) => b.backendId === 'claude');
    expect(claude).toMatchObject({
      backendId: 'claude',
      state: 'missing',
      code: 'executable_missing',
      recoveryAction: 'install',
      checkedAt: '2026-07-26T12:00:00.000Z',
    });
    // Sibling records stay reference-equal / ready.
    for (const id of BACKEND_READINESS_IDS) {
      if (id === 'claude') continue;
      const rec = next.backends.find((b) => b.backendId === id);
      expect(rec?.state).toBe('ready');
      expect(rec?.code).toBe('none');
    }
    // Snapshot-level correlation/phase/checkedAt preserved.
    expect(next.correlationId).toBe('corr-1');
    expect(next.phase).toBe('settled');
    expect(next.checkedAt).toBe('2026-07-25T00:00:00.000Z');

    expect(deps.posts).toEqual(
      expect.arrayContaining([
        { type: 'backendReadinessSnapshot', snapshot: next },
        { type: 'backendsAvailable', backends: expect.not.arrayContaining(['claude']) },
      ]),
    );
    // No raw path / secret leakage into published record.
    const published = JSON.stringify(deps.posts);
    expect(published).not.toContain('/Users/secret');
    expect(published).not.toContain('ENOENT /Users');
    expect(deps.taskMutations).toEqual([]);
  });

  it('maps auth_required message onto login recovery and does not replay prompt', async () => {
    const deps = makeDeps();
    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'codex',
        stage: 'authenticate',
        message: 'not authenticated — please login',
      },
      deps,
    );

    expect(outcome).toEqual({ kind: 'applied', backendId: 'codex', code: 'auth_required' });
    const codex = deps.applied[0].backends.find((b) => b.backendId === 'codex');
    expect(codex).toMatchObject({
      state: 'auth_required',
      code: 'auth_required',
      recoveryAction: 'login',
    });
    expect(deps.taskMutations).toEqual([]);
  });

  it('maps setup_timeout errorCode onto timeout with retry recovery', async () => {
    const deps = makeDeps();
    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'grok',
        stage: 'session',
        errorCode: 'setup_timeout',
        message: 'ACP setup timed out before run deadline',
      },
      deps,
    );

    expect(outcome).toEqual({ kind: 'applied', backendId: 'grok', code: 'timeout' });
    const grok = deps.applied[0].backends.find((b) => b.backendId === 'grok');
    expect(grok).toMatchObject({
      state: 'failed',
      code: 'timeout',
      recoveryAction: 'retry',
    });
  });

  it('maps process exit message onto process_exited', async () => {
    const deps = makeDeps();
    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'kiro',
        message: 'Kiro agent exited (code 1)',
      },
      deps,
    );

    expect(outcome).toEqual({ kind: 'applied', backendId: 'kiro', code: 'process_exited' });
    expect(deps.applied[0].backends.find((b) => b.backendId === 'kiro')).toMatchObject({
      state: 'failed',
      code: 'process_exited',
      recoveryAction: 'retry',
    });
  });

  it('maps initialize-stage residual onto acp_initialize_failed', async () => {
    const deps = makeDeps();
    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'opencode',
        stage: 'initialize',
        message: 'initialize rejected by agent',
      },
      deps,
    );

    expect(outcome).toEqual({
      kind: 'applied',
      backendId: 'opencode',
      code: 'acp_initialize_failed',
    });
  });

  it('fail-closes: skips unmapped mid-turn model failures without publishing', async () => {
    const deps = makeDeps();
    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'claude',
        message: 'model returned empty response after tool call',
      },
      deps,
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'unmapped' });
    expect(deps.applied).toEqual([]);
    expect(deps.posts).toEqual([]);
    expect(deps.taskMutations).toEqual([]);
  });

  it('fail-closes: rejects unknown backend ids without publishing', async () => {
    const deps = makeDeps();
    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'not-a-backend',
        errorCode: 'ENOENT',
        message: 'spawn failed',
      },
      deps,
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'unknown_backend' });
    expect(deps.applied).toEqual([]);
    expect(deps.posts).toEqual([]);
  });

  it('ensures inventory when no snapshot exists, then invalidates', async () => {
    let current: BackendReadinessSnapshot | null = null;
    const applied: BackendReadinessSnapshot[] = [];
    const posts: RuntimeInvalidationHostMessage[] = [];
    const deps: RuntimeInvalidationDeps = {
      getReadinessSnapshot: () => current,
      ensureReadiness: async () => {
        current = snapshot({ correlationId: 'boot' });
        return current;
      },
      applySnapshot: (next) => {
        applied.push(next);
        current = next;
      },
      post: (m) => posts.push(m),
      now: () => new Date('2026-07-26T12:00:00.000Z'),
    };

    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      { backendId: 'claude', errorCode: 'ENOENT', message: 'missing' },
      deps,
    );

    expect(outcome.kind).toBe('applied');
    expect(applied).toHaveLength(1);
    expect(posts.some((p) => p.type === 'backendReadinessSnapshot')).toBe(true);
  });

  it('skips when ensure still yields no snapshot', async () => {
    const deps = makeDeps({
      getReadinessSnapshot: () => null,
      ensureReadiness: async () => {
        throw new Error('inventory collapsed');
      },
    });

    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      { backendId: 'claude', errorCode: 'ENOENT' },
      deps,
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'no_snapshot' });
    expect(deps.applied).toEqual([]);
  });

  it('does not invoke optional prompt-replay or task-mutation seams when applied', async () => {
    const replayPrompt = vi.fn();
    const mutateTask = vi.fn();
    const deps = makeDeps({ replayPrompt, mutateTask });

    await invalidateBackendReadinessFromRuntimeFailure(
      { backendId: 'claude', errorCode: 'auth_required', message: 'login required' },
      deps,
    );

    expect(replayPrompt).not.toHaveBeenCalled();
    expect(mutateTask).not.toHaveBeenCalled();
    expect(deps.taskMutations).toEqual([]);
  });

  it('never embeds the raw signal message in the published snapshot', async () => {
    const deps = makeDeps();
    await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'claude',
        stage: 'spawn',
        message: 'spawn failed: secret-token-abc path=/abs/secret/bin',
      },
      deps,
    );

    const body = JSON.stringify(deps.posts);
    expect(body).not.toContain('secret-token-abc');
    expect(body).not.toContain('/abs/secret');
    expect(body).not.toContain('spawn failed');
  });
});
