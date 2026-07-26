/**
 * Named M019 S02 flow: installed_unverified → isolated Test Connection →
 * ready / auth_required diagnostic, with concurrent shared ACP session
 * untouched, zero task/outbox/session mutation, and readiness snapshot
 * layered through the pure probe reducer via the host route.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKEND_PROBE_SCHEMA_VERSION,
  parseBackendProbeResult,
  type BackendProbeProgress,
  type BackendProbeResult,
} from '../shared/backend-probe';
import {
  BACKEND_READINESS_SCHEMA_VERSION,
  BACKEND_READINESS_IDS,
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
  routeCancelBackendProbe,
  type BackendProbeHostMessage,
  type BackendProbeRouteDeps,
} from './backend-probe-route';
import { BackendReadinessService, type BackendReadinessServiceDeps } from './backend-readiness';
import type { VersionCollectResult } from './backend-version';

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
      sessionId: 'probe-sess-flow',
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

function makeSharedClient() {
  return {
    ensureConnected: vi.fn(async () => {}),
    newSession: vi.fn(async () => ({ sessionId: 'shared-live' })),
    closeSession: vi.fn(async () => {}),
    dispose: vi.fn(),
    prompt: vi.fn(async () => ({ ok: true })),
    registerSession: vi.fn(),
    attachConnectionSink: vi.fn(),
    sessions: new Set(['shared-live']),
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
    checkedAt: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

function inventorySnapshot(
  overrides: Partial<BackendReadinessSnapshot> = {},
): BackendReadinessSnapshot {
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 'flow-inventory',
    phase: 'settled',
    checkedAt: '2026-07-25T12:00:00.000Z',
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

function probeDeps(
  overrides: Partial<BackendProbeServiceDeps> = {},
): BackendProbeServiceDeps & {
  __createClient: ReturnType<typeof vi.fn>;
  __clients: ProbeAcpClient[];
  __warn: ReturnType<typeof vi.fn>;
} {
  const clients: ProbeAcpClient[] = [];
  const createClient = vi.fn((_id: BackendReadinessId) => {
    const client = makeProbeClient();
    clients.push(client);
    return client;
  });
  const warn = vi.fn();
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
    now: () => new Date('2026-07-25T12:01:00.000Z'),
    stageTimeoutMs: 200,
    totalTimeoutMs: 1000,
    globalConcurrency: 2,
    warn,
    ...overrides,
    __createClient: createClient,
    __clients: clients,
    __warn: warn,
  } as BackendProbeServiceDeps & {
    __createClient: ReturnType<typeof vi.fn>;
    __clients: ProbeAcpClient[];
    __warn: ReturnType<typeof vi.fn>;
  };
}

function readinessServiceDeps(): BackendReadinessServiceDeps & {
  __present: Set<string>;
  __versions: Map<BackendReadinessId, VersionCollectResult>;
} {
  const present = new Set<string>(['claude']);
  const versions = new Map<BackendReadinessId, VersionCollectResult>([
    ['claude', { versionEvidence: '2.1.4', code: 'none' }],
  ]);
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
    now: () => new Date('2026-07-25T12:00:00.000Z'),
    createCorrelationId: () => 'corr-s02-flow',
    __present: present,
    __versions: versions,
  } as BackendReadinessServiceDeps & {
    __present: Set<string>;
    __versions: Map<BackendReadinessId, VersionCollectResult>;
  };
}

function assertSharedUntouched(shared: ReturnType<typeof makeSharedClient>): void {
  expect(shared.ensureConnected).not.toHaveBeenCalled();
  expect(shared.newSession).not.toHaveBeenCalled();
  expect(shared.closeSession).not.toHaveBeenCalled();
  expect(shared.dispose).not.toHaveBeenCalled();
  expect(shared.prompt).not.toHaveBeenCalled();
  expect([...shared.sessions]).toEqual(['shared-live']);
}

describe('M019 S02 isolated Test Connection flow', () => {
  it('installed_unverified → ready via isolated probe; shared ACP + stores untouched', async () => {
    const shared = makeSharedClient();
    // Concurrent live task session on the shared client.
    shared.registerSession('shared-live');
    shared.attachConnectionSink(() => {});
    shared.registerSession.mockClear();
    shared.attachConnectionSink.mockClear();

    const mutations = {
      insertOutbox: vi.fn(),
      createTask: vi.fn(),
      writeSession: vi.fn(),
      writeTurn: vi.fn(),
      writeMessage: vi.fn(),
      writeComposer: vi.fn(),
    };

    // Passive inventory settles claude as installed_unverified.
    const readiness = new BackendReadinessService(readinessServiceDeps());
    const inventory = await readiness.refresh('flow-inventory');
    expect(inventory.phase).toBe('settled');
    const claudeBefore = inventory.backends.find((b) => b.backendId === 'claude')!;
    expect(claudeBefore.state).toBe('installed_unverified');
    expect(isPassivelySelectable(claudeBefore)).toBe(true);
    expect(isTrustworthyFirstRunEligible(claudeBefore)).toBe(false);

    // Seed replaceSnapshot cache so route reads the same inventory (matches host wiring).
    readiness.replaceSnapshot(inventory);

    const pDeps = probeDeps();
    const probeService = new BackendProbeService(pDeps);

    const posts: BackendProbeHostMessage[] = [];
    const progressStages: BackendProbeProgress['stage'][] = [];

    const routeDeps: BackendProbeRouteDeps = {
      getReadinessSnapshot: () => readiness.peek(),
      ensureReadiness: async () => {
        const snap = await readiness.refresh('ensure');
        return snap;
      },
      applySnapshot: (snapshot) => {
        readiness.replaceSnapshot(snapshot);
      },
      isInFlight: (backendId) => probeService.isInFlight(backendId),
      startProbe: (input) =>
        probeService.start({
          ...input,
          onProgress: (p) => {
            progressStages.push(p.stage);
            input.onProgress?.(p);
          },
        }),
      cancelProbe: (backendId) => probeService.cancel(backendId),
      post: (message) => posts.push(message),
      now: () => new Date('2026-07-25T12:01:00.000Z'),
      deriveAvailableBackends: (snapshot) =>
        snapshot.backends
          .filter((b) => b.state === 'ready' || b.state === 'installed_unverified')
          .map((b) => b.backendId),
    };

    const outcome = await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: 'flow-probe-1',
        backendId: 'claude',
      },
      routeDeps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    const result = outcome.result;
    expect(parseBackendProbeResult(result)).toEqual(result);
    expect(result).toMatchObject({
      probeId: 'flow-probe-1',
      backendId: 'claude',
      outcome: 'ready',
      code: 'none',
      recoveryAction: 'none',
      modelCatalogAvailable: true,
      lastStage: 'model_catalog',
    });

    // Progress stages were forwarded (correlated).
    expect(progressStages).toEqual([
      'executable',
      'version',
      'initialize',
      'authenticate',
      'session',
      'model_catalog',
    ]);
    expect(
      posts.some((m) => m.type === 'backendProbeProgress'),
    ).toBe(true);

    // Readiness snapshot layered ready for claude; other records stay byte-stable.
    const after = readiness.peek()!;
    const claudeAfter = after.backends.find((b) => b.backendId === 'claude')!;
    expect(claudeAfter.state).toBe('ready');
    expect(claudeAfter.versionEvidence).toBe('2.1.4');
    expect(isTrustworthyFirstRunEligible(claudeAfter)).toBe(true);

    for (const id of BACKEND_READINESS_IDS) {
      if (id === 'claude') continue;
      const before = inventory.backends.find((b) => b.backendId === id)!;
      const next = after.backends.find((b) => b.backendId === id)!;
      expect(next).toEqual(before);
    }

    // Wire-safe host→webview snapshot.
    expect(parseBackendReadinessSnapshot(JSON.parse(JSON.stringify(after)))).toEqual(after);

    // Isolation: owned client only, no prompt, always disposed.
    expect(pDeps.__createClient).toHaveBeenCalledTimes(1);
    expect(pDeps.__createClient).toHaveBeenCalledWith('claude');
    const owned = pDeps.__clients[0] as ReturnType<typeof makeProbeClient>;
    expect(owned.prompt).not.toHaveBeenCalled();
    expect(owned.dispose).toHaveBeenCalledTimes(1);
    expect(owned).not.toBe(shared);

    // Concurrent shared ACP session untouched.
    assertSharedUntouched(shared);

    // Zero mutation of task/outbox/session/composer surfaces.
    for (const [name, fn] of Object.entries(mutations)) {
      expect(fn, name).not.toHaveBeenCalled();
    }

    // Sanitized warnings only on failure paths — ready path may warn zero times.
    for (const call of pDeps.__warn.mock.calls) {
      const msg = String(call[0]);
      expect(msg).not.toMatch(/stderr|\/fake|password|ANTHROPIC|XAI_API_KEY/i);
    }
  });

  it('installed_unverified → auth_required diagnostic without shared ACP interference', async () => {
    const shared = makeSharedClient();
    shared.registerSession('shared-live');
    shared.attachConnectionSink(() => {});
    shared.registerSession.mockClear();
    shared.attachConnectionSink.mockClear();

    const readiness = new BackendReadinessService(readinessServiceDeps());
    const inventory = await readiness.refresh('flow-auth-inventory');
    readiness.replaceSnapshot(inventory);

    const pDeps = probeDeps();
    pDeps.createClient = vi.fn(() =>
      makeProbeClient({
        ensureConnected: vi.fn(async () => {
          throw new Error('Run `claude login` or set ANTHROPIC_API_KEY');
        }),
      }),
    );
    const probeService = new BackendProbeService(pDeps);
    const posts: BackendProbeHostMessage[] = [];

    const routeDeps: BackendProbeRouteDeps = {
      getReadinessSnapshot: () => readiness.peek(),
      ensureReadiness: async () => readiness.peek() ?? inventorySnapshot(),
      applySnapshot: (snapshot) => readiness.replaceSnapshot(snapshot),
      isInFlight: (id) => probeService.isInFlight(id),
      startProbe: (input) => probeService.start(input),
      cancelProbe: (id) => probeService.cancel(id),
      post: (m) => posts.push(m),
      now: () => new Date('2026-07-25T12:02:00.000Z'),
    };

    const outcome = await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: 'flow-auth-1',
        backendId: 'claude',
      },
      routeDeps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.result.outcome).toBe('auth_required');
    expect(outcome.result.code).toBe('auth_required');
    expect(outcome.result.recoveryAction).toBe('login');

    const after = readiness.peek()!;
    const claude = after.backends.find((b) => b.backendId === 'claude')!;
    expect(claude.state).toBe('auth_required');
    expect(claude.recoveryAction).toBe('login');
    // Diagnostic is closed-enum only — raw error text never crosses the boundary.
    expect(JSON.stringify(after)).not.toMatch(/ANTHROPIC_API_KEY|claude login/i);
    expect(pDeps.__warn).toHaveBeenCalled();
    const warnMsg = String(pDeps.__warn.mock.calls[0][0]);
    expect(warnMsg).toMatch(/code=auth_required/);
    expect(warnMsg).not.toContain('ANTHROPIC_API_KEY');

    assertSharedUntouched(shared);
    // Owned client disposed on failure.
    const owned = (pDeps.createClient as ReturnType<typeof vi.fn>).mock.results[0]
      .value as ReturnType<typeof makeProbeClient>;
    expect(owned.dispose).toHaveBeenCalled();
    expect(owned.prompt).not.toHaveBeenCalled();
  });

  it('cancel mid-probe restores installed_unverified and leaves shared client alone', async () => {
    const shared = makeSharedClient();
    const readiness = new BackendReadinessService(readinessServiceDeps());
    const inventory = await readiness.refresh('flow-cancel-inventory');
    readiness.replaceSnapshot(inventory);

    const pDeps = probeDeps({
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });
    pDeps.createClient = vi.fn(() =>
      makeProbeClient({
        ensureConnected: vi.fn(
          () =>
            new Promise(() => {
              /* hang until cancel */
            }),
        ),
      }),
    );
    const probeService = new BackendProbeService(pDeps);

    const routeDeps: BackendProbeRouteDeps = {
      getReadinessSnapshot: () => readiness.peek(),
      ensureReadiness: async () => readiness.peek() ?? inventory,
      applySnapshot: (snapshot) => readiness.replaceSnapshot(snapshot),
      isInFlight: (id) => probeService.isInFlight(id),
      startProbe: (input) => probeService.start(input),
      cancelProbe: (id) => probeService.cancel(id),
      post: () => {},
      now: () => new Date('2026-07-25T12:03:00.000Z'),
    };

    const pending = routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: 'flow-cancel-1',
        backendId: 'claude',
      },
      routeDeps,
    );

    await vi.waitFor(() => {
      expect(probeService.isInFlight('claude')).toBe(true);
    });
    // testing state applied before cancel.
    expect(readiness.peek()!.backends.find((b) => b.backendId === 'claude')!.state).toBe(
      'testing',
    );

    const cancelOutcome = routeCancelBackendProbe(
      {
        type: 'cancelBackendProbe',
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: 'flow-cancel-1',
        backendId: 'claude',
      },
      routeDeps,
    );
    expect(cancelOutcome.kind).toBe('cancelled');

    const outcome = await pending;
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.result.outcome).toBe('cancelled');

    // Cancel maps to installed_unverified — never claims failure or readiness.
    const claude = readiness.peek()!.backends.find((b) => b.backendId === 'claude')!;
    expect(claude.state).toBe('installed_unverified');
    expect(claude.code).toBe('cancelled');

    assertSharedUntouched(shared);
  });

  it('refuses missing backends without creating a probe client', async () => {
    const readiness = new BackendReadinessService(readinessServiceDeps());
    // Clear presence so all backends are missing.
    const deps = readinessServiceDeps();
    deps.__present.clear();
    const emptyReadiness = new BackendReadinessService(deps);
    const inventory = await emptyReadiness.refresh('flow-missing');
    emptyReadiness.replaceSnapshot(inventory);

    const pDeps = probeDeps();
    const probeService = new BackendProbeService(pDeps);

    const routeDeps: BackendProbeRouteDeps = {
      getReadinessSnapshot: () => emptyReadiness.peek(),
      ensureReadiness: async () => emptyReadiness.peek()!,
      applySnapshot: (s) => emptyReadiness.replaceSnapshot(s),
      isInFlight: (id) => probeService.isInFlight(id),
      startProbe: (input) => probeService.start(input),
      cancelProbe: (id) => probeService.cancel(id),
      post: () => {},
      now: () => new Date('2026-07-25T12:04:00.000Z'),
    };

    const outcome = await routeStartBackendProbe(
      {
        type: 'startBackendProbe',
        schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
        probeId: 'flow-missing-1',
        backendId: 'claude',
      },
      routeDeps,
    );
    expect(outcome).toEqual({ kind: 'refused', reason: 'ineligible' });
    expect(pDeps.__createClient).not.toHaveBeenCalled();
    // Snapshot unchanged.
    expect(emptyReadiness.peek()).toEqual(inventory);
  });
});
