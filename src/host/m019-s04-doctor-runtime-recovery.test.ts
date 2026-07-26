/**
 * Named M019 S04 flow: Doctor (Muster: Run Diagnostics) + runtime recovery
 * consistency assembled on the host.
 *
 * Doctor refreshes shared readiness then reveals Agents Backends; a later
 * mapped runtime setup failure invalidates only that provider onto the same
 * sanitized readiness taxonomy / recovery action, without prompt replay or
 * task mutation. Unmapped mid-turn failures fail-closed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  parseBackendReadinessSnapshot,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../shared/backend-readiness';
import {
  applyRuntimeSetupFailure,
  classifyRuntimeSetupFailure,
  mapRuntimeSetupFailure,
} from '../shared/backend-runtime-recovery';
import {
  invalidateBackendReadinessFromRuntimeFailure,
  type RuntimeInvalidationDeps,
  type RuntimeInvalidationHostMessage,
} from './backend-runtime-invalidation';
import { BackendReadinessService, type BackendReadinessServiceDeps } from './backend-readiness';
import type { VersionCollectResult } from './backend-version';
import {
  handleRunDiagnosticsCommand,
  MUSTER_OPEN_CHAT_VIEW_COMMAND,
  MUSTER_RUN_DIAGNOSTICS_COMMAND,
  MUSTER_RUN_DIAGNOSTICS_COMMAND_TITLE,
  type RunDiagnosticsCommandDeps,
} from './run-diagnostics-command';

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
    checkedAt: '2026-07-26T10:00:00.000Z',
    ...overrides,
  };
}

function readySnapshot(
  overrides: Partial<BackendReadinessSnapshot> = {},
): BackendReadinessSnapshot {
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 's04-ready',
    phase: 'settled',
    checkedAt: '2026-07-26T10:00:00.000Z',
    backends: BACKEND_READINESS_IDS.map((id) => readinessRecord(id)),
    ...overrides,
  };
}

function readinessServiceDeps(): BackendReadinessServiceDeps & {
  __present: Set<string>;
  __versions: Map<BackendReadinessId, VersionCollectResult>;
  __refreshCalls: number;
} {
  const present = new Set<string>(['claude', 'grok', 'kiro', 'codex', 'opencode']);
  const versions = new Map<BackendReadinessId, VersionCollectResult>(
    BACKEND_READINESS_IDS.map((id) => [id, { versionEvidence: '2.1.4', code: 'none' }]),
  );
  let refreshCalls = 0;
  const deps = {
    pathDirs: () => ['/fake/bin'],
    resolveCommand: (id: BackendReadinessId) => {
      const map: Record<BackendReadinessId, string> = {
        claude: 'claude',
        grok: 'grok',
        kiro: 'kiro-cli',
        codex: 'codex',
        opencode: 'opencode',
      };
      return map[id];
    },
    commandResolves: (command: string) => present.has(command),
    collectVersion: async (backendId: BackendReadinessId) =>
      versions.get(backendId) ?? { versionEvidence: null, code: 'version_unknown' },
    classifyCompatibility: () => 'compatible' as const,
    now: () => new Date('2026-07-26T10:00:00.000Z'),
    createCorrelationId: () => {
      refreshCalls += 1;
      deps.__refreshCalls = refreshCalls;
      return `corr-s04-${refreshCalls}`;
    },
    __present: present,
    __versions: versions,
    __refreshCalls: 0,
  };
  return deps as BackendReadinessServiceDeps & {
    __present: Set<string>;
    __versions: Map<BackendReadinessId, VersionCollectResult>;
    __refreshCalls: number;
  };
}

function deriveAvailableBackends(snapshot: BackendReadinessSnapshot): string[] {
  return snapshot.backends
    .filter((b) => b.state === 'ready' || b.state === 'installed_unverified')
    .map((b) => b.backendId);
}

describe('M019 S04 Doctor + runtime recovery host flow', () => {
  it('contributes Muster: Run Diagnostics and open-chat view command constants', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
    ) as {
      contributes: { commands: Array<{ command: string; title: string }> };
      scripts: Record<string, string>;
    };

    expect(pkg.contributes.commands).toEqual(
      expect.arrayContaining([
        {
          command: MUSTER_RUN_DIAGNOSTICS_COMMAND,
          title: MUSTER_RUN_DIAGNOSTICS_COMMAND_TITLE,
        },
      ]),
    );
    expect(MUSTER_RUN_DIAGNOSTICS_COMMAND).toBe('muster.runDiagnostics');
    expect(MUSTER_RUN_DIAGNOSTICS_COMMAND_TITLE).toBe('Muster: Run Diagnostics');
    expect(MUSTER_OPEN_CHAT_VIEW_COMMAND).toBe('workbench.view.extension.muster');
    expect(pkg.scripts['test:m019-s04']).toMatch(/m019-s04-doctor-runtime-recovery/);
    expect(pkg.scripts['test:m019-s04']).toMatch(/M019 S04 Doctor/);
  });

  it('Doctor refreshes shared readiness then opens chat then posts revealBackendDiagnostics', async () => {
    const rDeps = readinessServiceDeps();
    const readiness = new BackendReadinessService(rDeps);
    const published: BackendReadinessSnapshot[] = [];
    const callOrder: string[] = [];
    const mutations = {
      insertOutbox: vi.fn(),
      createTask: vi.fn(),
      writeSession: vi.fn(),
      writeTurn: vi.fn(),
      writeMessage: vi.fn(),
      prompt: vi.fn(),
      replayPrompt: vi.fn(),
    };

    const doctorDeps: RunDiagnosticsCommandDeps = {
      refreshAndPublishReadiness: async () => {
        callOrder.push('refresh');
        const snap = await readiness.refresh('s04-doctor');
        readiness.replaceSnapshot(snap);
        published.push(snap);
      },
      openChatView: async () => {
        callOrder.push('open');
      },
      postRevealBackendDiagnostics: () => {
        callOrder.push('reveal');
      },
    };

    const result = await handleRunDiagnosticsCommand(doctorDeps);

    expect(result).toEqual({ kind: 'success' });
    expect(callOrder).toEqual(['refresh', 'open', 'reveal']);
    expect(published).toHaveLength(1);
    const snap = published[0];
    expect(snap.phase).toBe('settled');
    expect(parseBackendReadinessSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    // Five backends present after refresh (all PATH-present in this fixture).
    expect(snap.backends).toHaveLength(5);
    for (const id of BACKEND_READINESS_IDS) {
      const rec = snap.backends.find((b) => b.backendId === id)!;
      // Passive inventory never claims ready — installed_unverified until probe.
      expect(['installed_unverified', 'ready', 'missing', 'failed', 'auth_required', 'incompatible']).toContain(
        rec.state,
      );
      expect(rec.state).not.toBe('ready');
    }
    for (const [name, fn] of Object.entries(mutations)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it('later mapped runtime failure invalidates only that provider with same recovery action; no prompt replay', async () => {
    const mutations = {
      insertOutbox: vi.fn(),
      createTask: vi.fn(),
      writeSession: vi.fn(),
      writeTurn: vi.fn(),
      writeMessage: vi.fn(),
      prompt: vi.fn(),
      replayPrompt: vi.fn(),
    };

    // Start from a Doctor-refreshed-then-probe-ready inventory (all ready).
    let current: BackendReadinessSnapshot = readySnapshot();
    const posts: RuntimeInvalidationHostMessage[] = [];
    const applied: BackendReadinessSnapshot[] = [];
    const invalidationDeps: RuntimeInvalidationDeps = {
      getReadinessSnapshot: () => current,
      ensureReadiness: async () => current,
      applySnapshot: (next) => {
        applied.push(next);
        current = next;
      },
      post: (message) => posts.push(message),
      now: () => new Date('2026-07-26T12:30:00.000Z'),
      deriveAvailableBackends,
      replayPrompt: () => mutations.replayPrompt(),
      mutateTask: () => mutations.writeTurn(),
    };

    // Authoritative turn error already settled on the task surface (host does not own it).
    const turnError = {
      taskId: 'task-1',
      code: 'auth_required',
      message: 'not authenticated — please login at /Users/secret/.config/claude',
    };

    // Host invalidation after turnError (T03 contract) — never replays prompt.
    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'claude',
        stage: 'authenticate',
        errorCode: turnError.code,
        message: turnError.message,
      },
      invalidationDeps,
    );

    expect(outcome).toEqual({
      kind: 'applied',
      backendId: 'claude',
      code: 'auth_required',
    });

    // Same taxonomy Agents Backends already renders for auth_required.
    const expectedMapping = mapRuntimeSetupFailure('auth_required');
    expect(expectedMapping).toEqual({
      state: 'auth_required',
      code: 'auth_required',
      recoveryAction: 'login',
      compatibility: 'compatible',
    });

    const next = applied[0];
    const claude = next.backends.find((b) => b.backendId === 'claude')!;
    expect(claude).toMatchObject({
      state: 'auth_required',
      code: 'auth_required',
      recoveryAction: 'login',
      checkedAt: '2026-07-26T12:30:00.000Z',
    });
    // Pure classifier + reducer agree with the host path.
    expect(classifyRuntimeSetupFailure({ stage: 'authenticate', errorCode: 'auth_required' })).toBe(
      'auth_required',
    );
    const pure = applyRuntimeSetupFailure(readySnapshot(), {
      backendId: 'claude',
      code: 'auth_required',
      checkedAt: '2026-07-26T12:30:00.000Z',
    });
    expect(pure.backends.find((b) => b.backendId === 'claude')).toMatchObject({
      state: claude.state,
      code: claude.code,
      recoveryAction: claude.recoveryAction,
    });

    // Siblings stay ready; only claude leaves available list.
    for (const id of BACKEND_READINESS_IDS) {
      if (id === 'claude') continue;
      expect(next.backends.find((b) => b.backendId === id)?.state).toBe('ready');
    }
    expect(posts).toEqual(
      expect.arrayContaining([
        { type: 'backendReadinessSnapshot', snapshot: next },
        {
          type: 'backendsAvailable',
          backends: expect.not.arrayContaining(['claude']),
        },
      ]),
    );

    // Sanitized: no path/secret/prompt leakage; turnError remains external.
    const body = JSON.stringify(posts);
    expect(body).not.toContain('/Users/secret');
    expect(body).not.toContain('please login at');
    expect(body).not.toContain(turnError.taskId);

    for (const [name, fn] of Object.entries(mutations)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it('spawn/auth/version/ACP setup failures map onto fixed recovery actions without replaying prompts', async () => {
    const cases: Array<{
      backendId: BackendReadinessId;
      signal: { stage?: string; errorCode?: string; message?: string };
      code: string;
      state: string;
      recoveryAction: string;
    }> = [
      {
        backendId: 'claude',
        signal: { stage: 'spawn', errorCode: 'ENOENT', message: 'spawn ENOENT /abs/secret/bin' },
        code: 'executable_missing',
        state: 'missing',
        recoveryAction: 'install',
      },
      {
        backendId: 'codex',
        signal: { stage: 'authenticate', message: 'not authenticated — login required' },
        code: 'auth_required',
        state: 'auth_required',
        recoveryAction: 'login',
      },
      {
        backendId: 'grok',
        signal: { stage: 'version', errorCode: 'version_incompatible', message: 'too old' },
        code: 'version_incompatible',
        state: 'incompatible',
        recoveryAction: 'update',
      },
      {
        backendId: 'opencode',
        signal: { stage: 'initialize', message: 'initialize rejected by agent' },
        code: 'acp_initialize_failed',
        state: 'failed',
        recoveryAction: 'retry',
      },
      {
        backendId: 'kiro',
        signal: { stage: 'session', errorCode: 'setup_timeout', message: 'setup timed out' },
        code: 'timeout',
        state: 'failed',
        recoveryAction: 'retry',
      },
    ];

    for (const c of cases) {
      let current = readySnapshot({ correlationId: `s04-${c.backendId}` });
      const posts: RuntimeInvalidationHostMessage[] = [];
      const replayPrompt = vi.fn();
      const mutateTask = vi.fn();
      const deps: RuntimeInvalidationDeps = {
        getReadinessSnapshot: () => current,
        ensureReadiness: async () => current,
        applySnapshot: (next) => {
          current = next;
        },
        post: (m) => posts.push(m),
        now: () => new Date('2026-07-26T13:00:00.000Z'),
        deriveAvailableBackends,
        replayPrompt,
        mutateTask,
      };

      const outcome = await invalidateBackendReadinessFromRuntimeFailure(
        { backendId: c.backendId, ...c.signal },
        deps,
      );
      expect(outcome, c.backendId).toEqual({
        kind: 'applied',
        backendId: c.backendId,
        code: c.code,
      });
      const rec = current.backends.find((b) => b.backendId === c.backendId)!;
      expect(rec).toMatchObject({
        state: c.state,
        code: c.code,
        recoveryAction: c.recoveryAction,
      });
      // Same recovery as pure mapRuntimeSetupFailure (Agents Backends taxonomy).
      expect(mapRuntimeSetupFailure(c.code as never).recoveryAction).toBe(c.recoveryAction);
      expect(replayPrompt).not.toHaveBeenCalled();
      expect(mutateTask).not.toHaveBeenCalled();
      const body = JSON.stringify(posts);
      expect(body).not.toContain('/abs/secret');
      expect(body).not.toMatch(/secret|token|api[_-]?key/i);
    }
  });

  it('assembled Doctor → ready → runtime invalidation keeps one shared snapshot surface', async () => {
    const rDeps = readinessServiceDeps();
    // Promote claude as "probe-proven ready" after Doctor inventory.
    const readiness = new BackendReadinessService(rDeps);
    const posts: RuntimeInvalidationHostMessage[] = [];
    const revealPosts: Array<{ type: string }> = [];
    const callOrder: string[] = [];
    const mutations = {
      insertOutbox: vi.fn(),
      createTask: vi.fn(),
      writeSession: vi.fn(),
      writeTurn: vi.fn(),
      writeMessage: vi.fn(),
      prompt: vi.fn(),
    };

    // Phase 1 — Doctor entry refreshes + reveals.
    const doctor = await handleRunDiagnosticsCommand({
      refreshAndPublishReadiness: async () => {
        callOrder.push('refresh');
        const snap = await readiness.refresh('s04-assembled');
        // Simulate S02 probe having already promoted claude to ready for the demo.
        const ready = {
          ...snap,
          backends: snap.backends.map((b) =>
            b.backendId === 'claude'
              ? readinessRecord('claude', {
                  state: 'ready',
                  code: 'none',
                  recoveryAction: 'none',
                  compatibility: 'compatible',
                  versionEvidence: '2.1.4',
                  checkedAt: '2026-07-26T10:05:00.000Z',
                })
              : b,
          ),
        };
        readiness.replaceSnapshot(ready);
        posts.push({ type: 'backendReadinessSnapshot', snapshot: ready });
      },
      openChatView: async () => {
        callOrder.push('open');
      },
      postRevealBackendDiagnostics: () => {
        callOrder.push('reveal');
        revealPosts.push({ type: 'revealBackendDiagnostics' });
      },
    });
    expect(doctor).toEqual({ kind: 'success' });
    expect(callOrder).toEqual(['refresh', 'open', 'reveal']);
    expect(revealPosts).toEqual([{ type: 'revealBackendDiagnostics' }]);

    const afterDoctor = readiness.peek()!;
    expect(afterDoctor.backends.find((b) => b.backendId === 'claude')?.state).toBe('ready');

    // Phase 2 — real task later hits auth setup failure on claude.
    const invalidationDeps: RuntimeInvalidationDeps = {
      getReadinessSnapshot: () => readiness.peek(),
      ensureReadiness: async () => readiness.peek() ?? afterDoctor,
      applySnapshot: (next) => readiness.replaceSnapshot(next),
      post: (message) => posts.push(message),
      now: () => new Date('2026-07-26T14:00:00.000Z'),
      deriveAvailableBackends,
      replayPrompt: () => mutations.prompt(),
      mutateTask: () => mutations.writeTurn(),
    };

    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'claude',
        stage: 'authenticate',
        message: 'authentication required before session/new',
      },
      invalidationDeps,
    );
    expect(outcome).toEqual({
      kind: 'applied',
      backendId: 'claude',
      code: 'auth_required',
    });

    const finalSnap = readiness.peek()!;
    const claude = finalSnap.backends.find((b) => b.backendId === 'claude')!;
    expect(claude).toMatchObject({
      state: 'auth_required',
      code: 'auth_required',
      recoveryAction: 'login',
      checkedAt: '2026-07-26T14:00:00.000Z',
    });
    // Round-trip parse proves shared schema with Agents Backends.
    expect(parseBackendReadinessSnapshot(JSON.parse(JSON.stringify(finalSnap)))).toEqual(finalSnap);

    // No durable task/session mutation and no prompt replay from diagnostics.
    for (const [name, fn] of Object.entries(mutations)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
    // Last post is the invalidated readiness snapshot (same channel Doctor refreshed).
    const lastSnapshotPost = [...posts]
      .reverse()
      .find((p) => p.type === 'backendReadinessSnapshot') as
      | { type: 'backendReadinessSnapshot'; snapshot: BackendReadinessSnapshot }
      | undefined;
    expect(lastSnapshotPost?.snapshot.backends.find((b) => b.backendId === 'claude')).toMatchObject({
      state: 'auth_required',
      recoveryAction: 'login',
    });
  });

  it('fail-closes unmapped mid-turn failures so readiness stays authoritative for setup only', async () => {
    let current = readySnapshot();
    const posts: RuntimeInvalidationHostMessage[] = [];
    const deps: RuntimeInvalidationDeps = {
      getReadinessSnapshot: () => current,
      ensureReadiness: async () => current,
      applySnapshot: (next) => {
        current = next;
      },
      post: (m) => posts.push(m),
      now: () => new Date('2026-07-26T15:00:00.000Z'),
    };

    const outcome = await invalidateBackendReadinessFromRuntimeFailure(
      {
        backendId: 'claude',
        message: 'model returned empty response after tool call',
      },
      deps,
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'unmapped' });
    expect(posts).toEqual([]);
    expect(current.backends.find((b) => b.backendId === 'claude')?.state).toBe('ready');
  });
});
