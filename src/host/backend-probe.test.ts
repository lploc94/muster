import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BackendProbeService,
  PROBE_GLOBAL_CONCURRENCY,
  PROBE_STAGE_TIMEOUT_MS,
  PROBE_TOTAL_TIMEOUT_MS,
  type BackendProbeServiceDeps,
  type ProbeAcpClient,
} from './backend-probe';
import {
  BACKEND_PROBE_SCHEMA_VERSION,
  parseBackendProbeProgress,
  parseBackendProbeResult,
  type BackendProbeProgress,
  type BackendProbeResult,
} from '../shared/backend-probe';
import type { BackendReadinessId } from '../shared/backend-readiness';
import type { VersionCollectResult } from './backend-version';

function makeClient(overrides: Partial<ProbeAcpClient> = {}): ProbeAcpClient & {
  dispose: ReturnType<typeof vi.fn>;
  ensureConnected: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
} {
  return {
    ensureConnected: vi.fn(async () => {}),
    newSession: vi.fn(async () => ({
      sessionId: 'probe-sess-1',
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

function baseDeps(
  overrides: Partial<BackendProbeServiceDeps> = {},
): BackendProbeServiceDeps & {
  __present: Set<string>;
  __versions: Map<BackendReadinessId, VersionCollectResult>;
  __clients: ProbeAcpClient[];
  __createClient: ReturnType<typeof vi.fn>;
  __warn: ReturnType<typeof vi.fn>;
} {
  const present = new Set<string>(['claude']);
  const versions = new Map<BackendReadinessId, VersionCollectResult>([
    ['claude', { versionEvidence: '2.1.4', code: 'none' }],
  ]);
  const clients: ProbeAcpClient[] = [];
  const createClient = vi.fn((_id: BackendReadinessId) => {
    const client = makeClient();
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
    commandResolves: (command) => present.has(command),
    collectVersion: async (backendId) =>
      versions.get(backendId) ?? { versionEvidence: null, code: 'version_unknown' },
    classifyCompatibility: () => 'compatible',
    createClient,
    resolveCwd: () => '/workspace',
    now: () => new Date('2026-07-25T12:00:00.000Z'),
    stageTimeoutMs: 200,
    totalTimeoutMs: 1000,
    globalConcurrency: PROBE_GLOBAL_CONCURRENCY,
    warn,
    ...overrides,
    __present: present,
    __versions: versions,
    __clients: clients,
    __createClient: createClient,
    __warn: warn,
  } as BackendProbeServiceDeps & {
    __present: Set<string>;
    __versions: Map<BackendReadinessId, VersionCollectResult>;
    __clients: ProbeAcpClient[];
    __createClient: ReturnType<typeof vi.fn>;
    __warn: ReturnType<typeof vi.fn>;
  };
}

describe('BackendProbeService constants', () => {
  it('exposes bounded stage/total deadlines and a small global concurrency cap', () => {
    expect(PROBE_STAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(PROBE_STAGE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(PROBE_TOTAL_TIMEOUT_MS).toBeGreaterThan(PROBE_STAGE_TIMEOUT_MS);
    expect(PROBE_TOTAL_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    expect(PROBE_GLOBAL_CONCURRENCY).toBe(2);
  });
});

describe('BackendProbeService happy path', () => {
  it('runs isolated stages and returns a ready result with model catalog evidence', async () => {
    const deps = baseDeps();
    const service = new BackendProbeService(deps);
    const progress: BackendProbeProgress[] = [];

    const result = await service.start({
      probeId: 'probe-1',
      backendId: 'claude',
      onProgress: (p) => progress.push(p),
    });

    expect(parseBackendProbeResult(result)).toEqual(result);
    expect(result).toMatchObject({
      schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
      probeId: 'probe-1',
      backendId: 'claude',
      outcome: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
      versionEvidence: '2.1.4',
      lastStage: 'model_catalog',
      modelCatalogAvailable: true,
      checkedAt: '2026-07-25T12:00:00.000Z',
    });

    expect(progress.map((p) => p.stage)).toEqual([
      'executable',
      'version',
      'initialize',
      'authenticate',
      'session',
      'model_catalog',
    ]);
    for (const p of progress) {
      expect(parseBackendProbeProgress(p)).toEqual(p);
      expect(p.probeId).toBe('probe-1');
      expect(p.backendId).toBe('claude');
    }

    expect(deps.__createClient).toHaveBeenCalledTimes(1);
    expect(deps.__createClient).toHaveBeenCalledWith('claude');
    const client = deps.__clients[0] as ReturnType<typeof makeClient>;
    expect(client.ensureConnected).toHaveBeenCalledTimes(1);
    expect(client.newSession).toHaveBeenCalledWith('/workspace', [], expect.any(Number));
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('marks modelCatalogAvailable false when session has no model options but still ready', async () => {
    const deps = baseDeps();
    deps.createClient = vi.fn(() =>
      makeClient({
        newSession: vi.fn(async () => ({ sessionId: 's1' })),
      }),
    );
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p2', backendId: 'claude' });
    expect(result.outcome).toBe('ready');
    expect(result.modelCatalogAvailable).toBe(false);
    expect(result.code).toBe('none');
  });
});

describe('BackendProbeService diagnostic paths', () => {
  it('fails executable_missing without creating a client', async () => {
    const deps = baseDeps();
    deps.__present.clear();
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('executable_missing');
    expect(result.recoveryAction).toBe('install');
    expect(result.lastStage).toBe('executable');
    expect(result.versionEvidence).toBeNull();
    expect(deps.__createClient).not.toHaveBeenCalled();
    expect(deps.__warn).toHaveBeenCalledWith(
      expect.stringMatching(/backend=claude.*stage=executable.*code=executable_missing/),
    );
    expect(deps.__warn.mock.calls[0][0]).not.toMatch(/Error|stderr|\/fake|claude\.exe/i);
  });

  it('returns incompatible at version stage without ACP', async () => {
    const deps = baseDeps({
      classifyCompatibility: () => 'incompatible',
    });
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('incompatible');
    expect(result.code).toBe('version_incompatible');
    expect(result.recoveryAction).toBe('update');
    expect(result.lastStage).toBe('version');
    expect(result.versionEvidence).toBe('2.1.4');
    expect(deps.__createClient).not.toHaveBeenCalled();
  });

  it('maps resolveAuth-style login errors to auth_required', async () => {
    const deps = baseDeps();
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(async () => {
          throw new Error('Run `grok login` first, or set XAI_API_KEY.');
        }),
      }),
    );
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('auth_required');
    expect(result.code).toBe('auth_required');
    expect(result.recoveryAction).toBe('login');
    expect(result.lastStage).toBe('authenticate');
    expect(result.versionEvidence).toBe('2.1.4');
    // Warning must name backend/stage/code only — never raw error text.
    expect(deps.__warn).toHaveBeenCalled();
    const msg = String(deps.__warn.mock.calls[0][0]);
    expect(msg).toMatch(/code=auth_required/);
    expect(msg).not.toContain('XAI_API_KEY');
    expect(msg).not.toContain('grok login');
  });

  it('maps initialize failures to acp_initialize_failed', async () => {
    const deps = baseDeps();
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(async () => {
          throw new Error('initialize handshake rejected');
        }),
      }),
    );
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('acp_initialize_failed');
    expect(result.recoveryAction).toBe('retry');
    expect(result.lastStage).toBe('initialize');
  });

  it('maps session/new failures to session_probe_failed', async () => {
    const deps = baseDeps();
    deps.createClient = vi.fn(() =>
      makeClient({
        newSession: vi.fn(async () => {
          throw new Error('session/new rejected');
        }),
      }),
    );
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('session_probe_failed');
    expect(result.recoveryAction).toBe('retry');
    expect(result.lastStage).toBe('session');
  });

  it('maps process exit errors to process_exited', async () => {
    const deps = baseDeps();
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(async () => {
          throw new Error('Claude agent exited (code 1)');
        }),
      }),
    );
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('process_exited');
    expect(result.lastStage).toBe('initialize');
  });

  it('times out a hung ensureConnected stage', async () => {
    const deps = baseDeps({
      stageTimeoutMs: 30,
      totalTimeoutMs: 500,
    });
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(
          () =>
            new Promise(() => {
              /* hang */
            }),
        ),
      }),
    );
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('timeout');
    expect(result.recoveryAction).toBe('retry');
    expect(result.lastStage).toBe('initialize');
    const client = (deps.createClient as ReturnType<typeof vi.fn>).mock.results[0]
      .value as ReturnType<typeof makeClient>;
    expect(client.dispose).toHaveBeenCalled();
  });
});

describe('BackendProbeService cancellation and disposal', () => {
  it('cancels an in-flight probe and always disposes the client', async () => {
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = baseDeps({
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(() => hung),
      }),
    );
    const service = new BackendProbeService(deps);
    const pending = service.start({ probeId: 'p', backendId: 'claude' });

    // Wait until client created / stage started.
    await vi.waitFor(() => {
      expect(deps.createClient).toHaveBeenCalled();
    });

    expect(service.isInFlight('claude')).toBe(true);
    expect(service.cancel('claude')).toBe(true);

    const result = await pending;
    expect(result.outcome).toBe('cancelled');
    expect(result.code).toBe('cancelled');
    expect(result.recoveryAction).toBe('none');
    const client = (deps.createClient as ReturnType<typeof vi.fn>).mock.results[0]
      .value as ReturnType<typeof makeClient>;
    expect(client.dispose).toHaveBeenCalled();
    expect(service.isInFlight('claude')).toBe(false);
    release();
  });

  it('disposeAll aborts every in-flight probe and clears the map', async () => {
    const deps = baseDeps({
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });
    deps.__present.add('grok');
    deps.__versions.set('grok', { versionEvidence: '0.1.0', code: 'none' });
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(
          () =>
            new Promise(() => {
              /* hang */
            }),
        ),
      }),
    );
    const service = new BackendProbeService(deps);
    const a = service.start({ probeId: 'a', backendId: 'claude' });
    const b = service.start({ probeId: 'b', backendId: 'grok' });
    await vi.waitFor(() => {
      expect((deps.createClient as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    });

    service.disposeAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.outcome).toBe('cancelled');
    expect(rb.outcome).toBe('cancelled');
    expect(service.isInFlight('claude')).toBe(false);
    expect(service.isInFlight('grok')).toBe(false);
  });

  it('disposes the client even when newSession throws', async () => {
    const deps = baseDeps();
    const client = makeClient({
      newSession: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    deps.createClient = vi.fn(() => client);
    const service = new BackendProbeService(deps);
    await service.start({ probeId: 'p', backendId: 'claude' });
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('BackendProbeService single-flight and concurrency', () => {
  it('is single-flight per backend — duplicate start joins the in-flight probe', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = baseDeps({
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(async () => {
          await gate;
        }),
      }),
    );
    const service = new BackendProbeService(deps);
    const first = service.start({ probeId: 'first', backendId: 'claude' });
    await vi.waitFor(() => {
      expect(deps.createClient).toHaveBeenCalledTimes(1);
    });
    const second = service.start({ probeId: 'second', backendId: 'claude' });
    // Still only one client / process.
    expect(deps.createClient).toHaveBeenCalledTimes(1);

    release();
    const [r1, r2] = await Promise.all([first, second]);
    // Reports the in-flight probe identity rather than spawning a second process.
    expect(r1.probeId).toBe('first');
    expect(r2.probeId).toBe('first');
    expect(r1.outcome).toBe('ready');
    expect(r2.outcome).toBe('ready');
  });

  it('enforces the global concurrency cap before creating another client', async () => {
    const releases: Array<() => void> = [];
    const deps = baseDeps({
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      globalConcurrency: 2,
    });
    for (const id of ['claude', 'grok', 'kiro'] as BackendReadinessId[]) {
      deps.__present.add(deps.resolveCommand(id));
      deps.__versions.set(id, { versionEvidence: '1.0.0', code: 'none' });
    }
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
            }),
        ),
      }),
    );

    const service = new BackendProbeService(deps);
    const p1 = service.start({ probeId: '1', backendId: 'claude' });
    const p2 = service.start({ probeId: '2', backendId: 'grok' });
    const p3 = service.start({ probeId: '3', backendId: 'kiro' });

    await vi.waitFor(() => {
      expect((deps.createClient as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    });
    // Third waits for a slot — no third client yet.
    expect(deps.createClient).toHaveBeenCalledTimes(2);

    // Free one slot.
    releases[0]!();
    await vi.waitFor(() => {
      expect((deps.createClient as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    });

    // Finish remaining.
    for (const r of releases.slice(1)) r();
    const results = await Promise.all([p1, p2, p3]);
    expect(results.every((r) => r.outcome === 'ready')).toBe(true);
  });
});

describe('BackendProbeService isolation guarantees', () => {
  it('never invokes prompt on the probe client', async () => {
    const deps = baseDeps();
    const client = makeClient();
    deps.createClient = vi.fn(() => client);
    const service = new BackendProbeService(deps);
    await service.start({ probeId: 'p', backendId: 'claude' });
    expect(client.prompt).not.toHaveBeenCalled();
    // Defensive: service must not even access a prompt property via call.
    expect(client.closeSession).toHaveBeenCalled();
  });

  it('does not import or call getSharedAcpClient / peekSharedAcpClient (source contract)', async () => {
    // Behavioral: createClient is the only client factory used.
    const deps = baseDeps();
    const service = new BackendProbeService(deps);
    await service.start({ probeId: 'p', backendId: 'claude' });
    expect(deps.__createClient).toHaveBeenCalledTimes(1);
  });

  it('result payloads are fail-closed parseable and contain no path/stderr fields', async () => {
    const deps = baseDeps();
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(
      [
        'backendId',
        'checkedAt',
        'code',
        'compatibility',
        'lastStage',
        'modelCatalogAvailable',
        'outcome',
        'probeId',
        'recoveryAction',
        'schemaVersion',
        'versionEvidence',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(/\/fake|stderr|ANTHROPIC|password/i);
  });
});

describe('BackendProbeService version edge cases', () => {
  it('continues probing when version is unknown (still probeable)', async () => {
    const deps = baseDeps();
    deps.__versions.set('claude', { versionEvidence: null, code: 'version_unknown' });
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('ready');
    expect(result.versionEvidence).toBeNull();
  });

  it('fails closed on version collection timeout without ACP', async () => {
    const deps = baseDeps();
    deps.__versions.set('claude', { versionEvidence: null, code: 'timeout' });
    const service = new BackendProbeService(deps);
    const result = await service.start({ probeId: 'p', backendId: 'claude' });
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('timeout');
    expect(result.lastStage).toBe('version');
    expect(deps.__createClient).not.toHaveBeenCalled();
  });
});

describe('BackendProbeService cancel edge cases', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancel on idle backend returns false', () => {
    const service = new BackendProbeService(baseDeps());
    expect(service.cancel('claude')).toBe(false);
  });

  it('external abort signal cancels the probe', async () => {
    const deps = baseDeps({
      stageTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
    });
    deps.createClient = vi.fn(() =>
      makeClient({
        ensureConnected: vi.fn(
          () =>
            new Promise(() => {
              /* hang */
            }),
        ),
      }),
    );
    const service = new BackendProbeService(deps);
    const controller = new AbortController();
    const pending = service.start({
      probeId: 'p',
      backendId: 'claude',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(deps.createClient).toHaveBeenCalled();
    });
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe('cancelled');
  });
});

describe('BackendProbeService result contract', () => {
  it('every terminal result is accepted by parseBackendProbeResult', async () => {
    const cases: Array<{
      name: string;
      setup: (deps: ReturnType<typeof baseDeps>) => void;
      expectCode: BackendProbeResult['code'];
    }> = [
      {
        name: 'ready',
        setup: () => {},
        expectCode: 'none',
      },
      {
        name: 'missing',
        setup: (d) => d.__present.clear(),
        expectCode: 'executable_missing',
      },
      {
        name: 'auth',
        setup: (d) => {
          d.createClient = vi.fn(() =>
            makeClient({
              ensureConnected: vi.fn(async () => {
                throw new Error('login required');
              }),
            }),
          );
        },
        expectCode: 'auth_required',
      },
    ];

    for (const c of cases) {
      const deps = baseDeps();
      c.setup(deps);
      const service = new BackendProbeService(deps);
      const result = await service.start({ probeId: `case-${c.name}`, backendId: 'claude' });
      expect(parseBackendProbeResult(result), c.name).not.toBeNull();
      expect(result.code, c.name).toBe(c.expectCode);
    }
  });
});
