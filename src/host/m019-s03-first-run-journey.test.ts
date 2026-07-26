/**
 * Named M019 S03 flow: clean first-run journey assembled on the host.
 *
 * empty inventory → refresh installed_unverified → first-task gate rejects →
 * isolated Test Connection → ready → first-task gate accepts; existing-task
 * workspaces keep the passive S01 rule. No task/outbox mutation on rejects.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKEND_PROBE_SCHEMA_VERSION,
  parseBackendProbeResult,
} from '../shared/backend-probe';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  isPassivelySelectable,
  isTrustworthyFirstRunEligible,
  parseBackendReadinessSnapshot,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../shared/backend-readiness';
import {
  BackendProbeService,
  type BackendProbeServiceDeps,
  type ProbeAcpClient,
} from './backend-probe';
import {
  routeStartBackendProbe,
  type BackendProbeHostMessage,
  type BackendProbeRouteDeps,
} from './backend-probe-route';
import { BackendReadinessService, type BackendReadinessServiceDeps } from './backend-readiness';
import type { VersionCollectResult } from './backend-version';
import {
  evaluateNewTaskBackendEligibility,
  NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON,
  NEW_TASK_BACKEND_FIRST_RUN_REJECT_REASON,
} from './send-request';

function makeProbeClient(overrides: Partial<ProbeAcpClient> = {}): ProbeAcpClient & {
  dispose: ReturnType<typeof vi.fn>;
  ensureConnected: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
} {
  return {
    ensureConnected: vi.fn(async () => {}),
    newSession: vi.fn(async () => ({
      sessionId: 'probe-sess-s03',
      modelConfig: {
        id: 'model',
        options: [{ value: 'm1', name: 'Model 1' }],
      },
    })),
    closeSession: vi.fn(async () => {}),
    dispose: vi.fn(),
    prompt: vi.fn(async () => {
      throw new Error('session/prompt must never be called by probe');
    }),
    ...overrides,
  } as ProbeAcpClient & {
    dispose: ReturnType<typeof vi.fn>;
    ensureConnected: ReturnType<typeof vi.fn>;
    newSession: ReturnType<typeof vi.fn>;
    closeSession: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
  };
}

function readinessRecord(
  backendId: BackendReadinessId,
  overrides: Partial<BackendReadinessRecord> = {},
): BackendReadinessRecord {
  return {
    backendId,
    state: 'missing',
    code: 'executable_missing',
    recoveryAction: 'install',
    compatibility: 'unknown',
    versionEvidence: null,
    checkedAt: '2026-07-25T14:00:00.000Z',
    ...overrides,
  };
}

function inventorySnapshot(
  overrides: Partial<BackendReadinessSnapshot> = {},
): BackendReadinessSnapshot {
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 's03-inventory',
    phase: 'settled',
    checkedAt: '2026-07-25T14:00:00.000Z',
    backends: BACKEND_READINESS_IDS.map((id) =>
      id === 'claude'
        ? readinessRecord('claude', {
            state: 'installed_unverified',
            code: 'none',
            recoveryAction: 'none',
            versionEvidence: '2.1.4',
          })
        : readinessRecord(id),
    ),
    ...overrides,
  };
}

function readinessServiceDeps(): BackendReadinessServiceDeps & {
  __present: Set<string>;
  __versions: Map<BackendReadinessId, VersionCollectResult>;
} {
  const present = new Set<string>();
  const versions = new Map<BackendReadinessId, VersionCollectResult>();
  return {
    pathDirs: () => ['/fake/bin'],
    resolveCommand: (id) => {
      const map: Record<BackendReadinessId, string> = {
        claude: 'claude',
        grok: 'grok',
        kiro: 'kiro-cli',
        codex: 'codex',
        opencode: 'opencode',
      };
      return map[id];
    },
    commandResolves: (command) => present.has(command),
    collectVersion: async (backendId) =>
      versions.get(backendId) ?? { versionEvidence: null, code: 'version_unknown' },
    classifyCompatibility: () => 'unknown',
    now: () => new Date('2026-07-25T14:00:00.000Z'),
    createCorrelationId: () => 'corr-s03-flow',
    __present: present,
    __versions: versions,
  } as BackendReadinessServiceDeps & {
    __present: Set<string>;
    __versions: Map<BackendReadinessId, VersionCollectResult>;
  };
}

function probeDeps(
  overrides: Partial<BackendProbeServiceDeps> = {},
): BackendProbeServiceDeps & {
  __createClient: ReturnType<typeof vi.fn>;
  __clients: ProbeAcpClient[];
} {
  const clients: ProbeAcpClient[] = [];
  const createClient = vi.fn((_id: BackendReadinessId) => {
    const client = makeProbeClient();
    clients.push(client);
    return client;
  });
  return {
    pathDirs: () => ['/fake/bin'],
    resolveCommand: (id) => {
      const map: Record<BackendReadinessId, string> = {
        claude: 'claude',
        grok: 'grok',
        kiro: 'kiro-cli',
        codex: 'codex',
        opencode: 'opencode',
      };
      return map[id];
    },
    commandResolves: (command) => command === 'claude',
    collectVersion: async () => ({ versionEvidence: '2.1.4', code: 'none' }),
    classifyCompatibility: () => 'compatible',
    createClient,
    resolveCwd: () => '/workspace',
    now: () => new Date('2026-07-25T14:01:00.000Z'),
    stageTimeoutMs: 200,
    totalTimeoutMs: 1000,
    globalConcurrency: 2,
    warn: vi.fn(),
    ...overrides,
    __createClient: createClient,
    __clients: clients,
  } as BackendProbeServiceDeps & {
    __createClient: ReturnType<typeof vi.fn>;
    __clients: ProbeAcpClient[];
  };
}

describe('M019 S03 first-run journey host flow', () => {
  it('clean workspace: missing → refresh → reject → probe ready → accept; no mutation on reject', async () => {
    const mutations = {
      insertOutbox: vi.fn(),
      createTask: vi.fn(),
      writeSession: vi.fn(),
      writeTurn: vi.fn(),
      writeMessage: vi.fn(),
      writeComposer: vi.fn(),
    };

    const rDeps = readinessServiceDeps();
    const present = rDeps.__present;
    const versions = rDeps.__versions;
    const readiness = new BackendReadinessService(rDeps);

    // Phase 1 — clean workspace, five missing: first task rejected for every backend.
    const missing = await readiness.refresh('s03-missing');
    expect(missing.phase).toBe('settled');
    expect(missing.backends.every((b) => b.state === 'missing')).toBe(true);
    for (const id of BACKEND_READINESS_IDS) {
      const result = evaluateNewTaskBackendEligibility(readiness.peek(), id, {
        isCleanWorkspace: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON);
      }
    }
    for (const fn of Object.values(mutations)) {
      expect(fn).not.toHaveBeenCalled();
    }

    // Phase 2 — refresh surfaces installed_unverified (passive selectable, not trustworthy).
    present.add('claude');
    versions.set('claude', { versionEvidence: '2.1.4', code: 'none' });
    const inventory = await readiness.refresh('s03-refresh');
    readiness.replaceSnapshot(inventory);
    const claudeInstalled = inventory.backends.find((b) => b.backendId === 'claude')!;
    expect(claudeInstalled.state).toBe('installed_unverified');
    expect(isPassivelySelectable(claudeInstalled)).toBe(true);
    expect(isTrustworthyFirstRunEligible(claudeInstalled)).toBe(false);

    // Clean first-run gate rejects installed_unverified (D058/D060).
    const rejected = evaluateNewTaskBackendEligibility(readiness.peek(), 'claude', {
      isCleanWorkspace: true,
    });
    expect(rejected).toEqual({
      ok: false,
      reason: NEW_TASK_BACKEND_FIRST_RUN_REJECT_REASON,
      code: 'validation',
    });
    for (const fn of Object.values(mutations)) {
      expect(fn).not.toHaveBeenCalled();
    }

    // Non-clean / existing-task workspace still accepts passive selection (R031 note).
    expect(
      evaluateNewTaskBackendEligibility(readiness.peek(), 'claude', {
        isCleanWorkspace: false,
      }),
    ).toEqual({ ok: true, backend: 'claude' });

    // Phase 3 — isolated Test Connection promotes claude to ready.
    const pDeps = probeDeps();
    const probeService = new BackendProbeService(pDeps);
    const posts: BackendProbeHostMessage[] = [];
    const routeDeps: BackendProbeRouteDeps = {
      getReadinessSnapshot: () => readiness.peek(),
      ensureReadiness: async () => readiness.peek() ?? inventorySnapshot(),
      applySnapshot: (snapshot) => readiness.replaceSnapshot(snapshot),
      isInFlight: (backendId) => probeService.isInFlight(backendId),
      startProbe: (input) => probeService.start(input),
      cancelProbe: (backendId) => probeService.cancel(backendId),
      post: (message) => posts.push(message),
      now: () => new Date('2026-07-25T14:01:00.000Z'),
      deriveAvailableBackends: (snapshot) =>
        snapshot.backends
          .filter((b) => b.state === 'ready' || b.state === 'installed_unverified')
          .map((b) => b.backendId),
    };

    const outcome = await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: 's03-probe-1',
        backendId: 'claude',
      },
      routeDeps,
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    expect(parseBackendProbeResult(outcome.result)).toEqual(outcome.result);
    expect(outcome.result).toMatchObject({
      probeId: 's03-probe-1',
      backendId: 'claude',
      outcome: 'ready',
      code: 'none',
    });
    expect(posts.some((m) => m.type === 'backendProbeProgress')).toBe(true);

    const after = readiness.peek()!;
    const claudeReady = after.backends.find((b) => b.backendId === 'claude')!;
    expect(claudeReady.state).toBe('ready');
    expect(isTrustworthyFirstRunEligible(claudeReady)).toBe(true);
    expect(parseBackendReadinessSnapshot(JSON.parse(JSON.stringify(after)))).toEqual(after);

    // Probe isolation: owned client disposed, never prompt.
    expect(pDeps.__createClient).toHaveBeenCalledTimes(1);
    const owned = pDeps.__clients[0] as ReturnType<typeof makeProbeClient>;
    expect(owned.prompt).not.toHaveBeenCalled();
    expect(owned.dispose).toHaveBeenCalledTimes(1);

    // Phase 4 — clean first task now accepted for the probe-proven ready backend.
    expect(
      evaluateNewTaskBackendEligibility(readiness.peek(), 'claude', {
        isCleanWorkspace: true,
      }),
    ).toEqual({ ok: true, backend: 'claude' });

    // Still no durable mutation from the gate itself (caller owns accept path).
    for (const [name, fn] of Object.entries(mutations)) {
      expect(fn, name).not.toHaveBeenCalled();
    }

    // Other backends remain missing / not trustworthy.
    for (const id of BACKEND_READINESS_IDS) {
      if (id === 'claude') continue;
      const record = after.backends.find((b) => b.backendId === id)!;
      expect(isTrustworthyFirstRunEligible(record)).toBe(false);
      expect(
        evaluateNewTaskBackendEligibility(after, id, { isCleanWorkspace: true }).ok,
      ).toBe(false);
    }
  });

  it('existing-task workspace keeps passive rule without requiring re-test', async () => {
    const rDeps = readinessServiceDeps();
    rDeps.__present.add('opencode');
    rDeps.__versions.set('opencode', { versionEvidence: '1.0.0', code: 'none' });
    const readiness = new BackendReadinessService(rDeps);
    const snap = await readiness.refresh('s03-existing');
    const opencode = snap.backends.find((b) => b.backendId === 'opencode')!;
    expect(opencode.state).toBe('installed_unverified');

    // History users are not forced through trustworthy first-run.
    expect(
      evaluateNewTaskBackendEligibility(snap, 'opencode', { isCleanWorkspace: false }),
    ).toEqual({ ok: true, backend: 'opencode' });
    expect(
      evaluateNewTaskBackendEligibility(snap, 'opencode', { isCleanWorkspace: true }),
    ).toEqual({
      ok: false,
      reason: NEW_TASK_BACKEND_FIRST_RUN_REJECT_REASON,
      code: 'validation',
    });
  });
});
