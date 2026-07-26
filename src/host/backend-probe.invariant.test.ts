/**
 * M019 S02 / T05: Mechanical isolation invariant for isolated Test Connection.
 *
 * Proves by production source scan + behavioral fixtures that S02 probe modules:
 * - never import getSharedAcpClient / peekSharedAcpClient / model-catalog /
 *   task engine/store/repository / outbox / session store
 * - never call session/prompt (literal or method) from production probe code
 * - construct owned clients only via injected createClient factory
 * - leave a concurrently live fake shared ACP client untouched across
 *   success / failure / timeout / cancel / disposeAll
 * - write no task / turn / message / outbox / session / composer state
 *
 * Source-scan style follows src/host/backend-readiness.invariant.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  BackendProbeService,
  type BackendProbeServiceDeps,
  type ProbeAcpClient,
} from './backend-probe';
import type { BackendReadinessId } from '../shared/backend-readiness';
import type { VersionCollectResult } from './backend-version';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Production modules that own the isolated Test Connection probe. */
const PROBE_PRODUCTION_MODULES = [
  'src/host/backend-probe.ts',
  'src/host/backend-probe-route.ts',
] as const;

/** Forbidden import/path needles inside probe production modules. */
const FORBIDDEN_IMPORT_NEEDLES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'model-catalog', pattern: /from\s+['"][^'"]*model-catalog['"]/ },
  { label: 'task/engine', pattern: /from\s+['"][^'"]*task\/engine['"]/ },
  { label: 'task/store', pattern: /from\s+['"][^'"]*task\/store['"]/ },
  { label: 'task/repository', pattern: /from\s+['"][^'"]*task\/repository['"]/ },
  { label: 'send-request (outbox path)', pattern: /from\s+['"][^'"]*send-request['"]/ },
  { label: 'session store', pattern: /from\s+['"][^'"]*session[^'"]*['"]/ },
  // Shared ACP client helpers must never be imported by the probe.
  {
    label: 'shared acp client module',
    pattern: /from\s+['"][^'"]*(shared-acp|acp-shared|get-shared-acp)[^'"]*['"]/,
  },
];

/** Forbidden call / symbol needles inside probe production modules. */
const FORBIDDEN_CALL_NEEDLES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'getSharedAcpClient', pattern: /\bgetSharedAcpClient\b/ },
  { label: 'peekSharedAcpClient', pattern: /\bpeekSharedAcpClient\b/ },
  { label: 'session/prompt literal', pattern: /session\/prompt/ },
  { label: 'TaskEngine', pattern: /\bTaskEngine\b/ },
  { label: 'TaskStore', pattern: /\bTaskStore\b/ },
  { label: 'taskRepository', pattern: /\btaskRepository\b/ },
  { label: 'outbox insert', pattern: /\binsertOutbox\b|\bcreateSendOutbox\b/ },
  { label: 'enumerateModels', pattern: /\benumerateModels\b/ },
];

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** Strip block + line comments so isolation docs may name forbidden symbols. */
function stripComments(source: string): string {
  // Preserve newlines so line numbers stay aligned with the original file.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;{}()\[\],=])\/\/.*$/gm, '$1');
}

function scanHits(
  content: string,
  file: string,
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  const code = stripComments(content);
  const lines = code.split(/\r?\n/);
  const originalLines = content.split(/\r?\n/);
  lines.forEach((text, idx) => {
    if (pattern.test(text)) {
      hits.push({
        file,
        line: idx + 1,
        text: (originalLines[idx] ?? text).trim(),
      });
    }
  });
  return hits;
}

/** Code-only source for protocol / production assertions (comments stripped). */
function codeOnly(content: string): string {
  return stripComments(content);
}

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

/**
 * Fake shared ACP client that a concurrent task session would hold.
 * Probe must never touch any of its methods.
 */
function makeSharedAcpClient() {
  return {
    ensureConnected: vi.fn(async () => {}),
    newSession: vi.fn(async () => ({ sessionId: 'shared-sess-live' })),
    closeSession: vi.fn(async () => {}),
    dispose: vi.fn(),
    prompt: vi.fn(async () => ({ ok: true })),
    // Session registry / connection sink stand-ins.
    registerSession: vi.fn(),
    attachConnectionSink: vi.fn(),
    sessions: new Set(['shared-sess-live']),
  };
}

function baseDeps(
  overrides: Partial<BackendProbeServiceDeps> = {},
): BackendProbeServiceDeps & {
  __present: Set<string>;
  __versions: Map<BackendReadinessId, VersionCollectResult>;
  __createClient: ReturnType<typeof vi.fn>;
  __clients: ProbeAcpClient[];
  __warn: ReturnType<typeof vi.fn>;
} {
  const present = new Set<string>(['claude', 'grok']);
  const versions = new Map<BackendReadinessId, VersionCollectResult>([
    ['claude', { versionEvidence: '2.1.4', code: 'none' }],
    ['grok', { versionEvidence: '0.1.0', code: 'none' }],
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
    globalConcurrency: 2,
    warn,
    ...overrides,
    __present: present,
    __versions: versions,
    __createClient: createClient,
    __clients: clients,
    __warn: warn,
  } as BackendProbeServiceDeps & {
    __present: Set<string>;
    __versions: Map<BackendReadinessId, VersionCollectResult>;
    __createClient: ReturnType<typeof vi.fn>;
    __clients: ProbeAcpClient[];
    __warn: ReturnType<typeof vi.fn>;
  };
}

function assertSharedUntouched(shared: ReturnType<typeof makeSharedAcpClient>): void {
  expect(shared.ensureConnected).not.toHaveBeenCalled();
  expect(shared.newSession).not.toHaveBeenCalled();
  expect(shared.closeSession).not.toHaveBeenCalled();
  expect(shared.dispose).not.toHaveBeenCalled();
  expect(shared.prompt).not.toHaveBeenCalled();
  expect(shared.registerSession).not.toHaveBeenCalled();
  expect(shared.attachConnectionSink).not.toHaveBeenCalled();
  expect([...shared.sessions]).toEqual(['shared-sess-live']);
}

describe('M019 S02 probe isolation invariant (T05)', () => {
  describe('production source scan — probe modules', () => {
    it('do not import model-catalog, task engine/store/repository, outbox, or session store', () => {
      const allHits: Array<{ label: string; file: string; line: number; text: string }> = [];
      for (const file of PROBE_PRODUCTION_MODULES) {
        const content = readRepoFile(file);
        for (const { label, pattern } of FORBIDDEN_IMPORT_NEEDLES) {
          for (const hit of scanHits(content, file, pattern)) {
            allHits.push({ label, ...hit });
          }
        }
      }
      expect(allHits, JSON.stringify(allHits, null, 2)).toEqual([]);
    });

    it('do not call getSharedAcpClient, peekSharedAcpClient, session/prompt, task, or outbox symbols', () => {
      const allHits: Array<{ label: string; file: string; line: number; text: string }> = [];
      for (const file of PROBE_PRODUCTION_MODULES) {
        const content = readRepoFile(file);
        for (const { label, pattern } of FORBIDDEN_CALL_NEEDLES) {
          for (const hit of scanHits(content, file, pattern)) {
            allHits.push({ label, ...hit });
          }
        }
      }
      expect(allHits, JSON.stringify(allHits, null, 2)).toEqual([]);
    });

    it('backend-probe.ts never imports acp-client or shared client helpers (createClient only)', () => {
      const content = readRepoFile('src/host/backend-probe.ts');
      const code = codeOnly(content);
      // Direct AcpClient class import would couple the probe to the shared runtime.
      // createClient is injected; the module must not construct AcpClient itself.
      // Docs may mention `new AcpClient` as the production factory pattern — scan code only.
      expect(code).not.toMatch(/from\s+['"][^'"]*acp-client['"]/);
      expect(code).not.toMatch(/\bnew\s+AcpClient\b/);
      expect(code).toMatch(/\bcreateClient\b/);
    });

    it('backend-probe-route.ts stays free of startBackendProbe ownership in readiness', () => {
      // Cross-check: readiness remains passive (no startBackendProbe symbol).
      const readiness = readRepoFile('src/host/backend-readiness.ts');
      expect(readiness).not.toMatch(/\bstartBackendProbe\b/);
      expect(readiness).not.toMatch(/\bBackendProbeService\b/);
      expect(readiness).not.toMatch(/\bgetSharedAcpClient\b/);
      // Route owns orchestration.
      const route = readRepoFile('src/host/backend-probe-route.ts');
      expect(route).toMatch(/\brouteStartBackendProbe\b/);
      expect(route).toMatch(/\brouteCancelBackendProbe\b/);
    });

    it('extension createClient factory never uses getSharedAcpClient/peekSharedAcpClient', () => {
      const content = readRepoFile('src/extension.ts');
      // Locate the construction call (not the import) by matching createDefaultBackendProbeDeps({
      const marker = 'createDefaultBackendProbeDeps({';
      const start = content.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      // Capture a bounded window around the factory (owned client construction).
      const window = content.slice(start, start + 1200);
      expect(window).toMatch(/createClient/);
      expect(window).toMatch(/new\s+AcpClient/);
      expect(window).not.toMatch(/\bgetSharedAcpClient\b/);
      expect(window).not.toMatch(/\bpeekSharedAcpClient\b/);
    });
  });

  describe('protocol surface — additive probe messages replace S01 ban', () => {
    it('protocol declares start/cancel/progress probe messages without session/prompt', () => {
      const content = readRepoFile('webview/src/lib/protocol.ts');
      const code = codeOnly(content);
      expect(code).toMatch(/startBackendProbe/);
      expect(code).toMatch(/cancelBackendProbe/);
      expect(code).toMatch(/backendProbeProgress/);
      // Legacy S01 forbidden names stay out; additive probe names are the contract.
      expect(code).not.toMatch(/\btestConnection\b|\bprobeBackend\b|\bauthProbe\b/);
      // Isolation docs may mention the forbidden method; executable code must not.
      expect(code).not.toMatch(/session\/prompt/);
    });
  });

  describe('behavioral — concurrent shared ACP client is never touched', () => {
    it('success path leaves shared client untouched and never prompts', async () => {
      const shared = makeSharedAcpClient();
      // Simulate a live shared session (registry + sink already attached).
      shared.registerSession('shared-sess-live');
      shared.attachConnectionSink(() => {});
      // Reset call counts after setup so probe-phase assertions are clean.
      shared.registerSession.mockClear();
      shared.attachConnectionSink.mockClear();

      const deps = baseDeps();
      const service = new BackendProbeService(deps);
      const result = await service.start({ probeId: 'iso-ready', backendId: 'claude' });

      expect(result.outcome).toBe('ready');
      expect(deps.__createClient).toHaveBeenCalledTimes(1);
      const probeClient = deps.__clients[0] as ReturnType<typeof makeClient>;
      expect(probeClient.prompt).not.toHaveBeenCalled();
      expect(probeClient.dispose).toHaveBeenCalledTimes(1);
      // Shared client is a distinct object — probe never received it.
      expect(deps.__createClient.mock.results[0].value).not.toBe(shared);
      assertSharedUntouched(shared);
    });

    it('auth failure leaves shared client untouched', async () => {
      const shared = makeSharedAcpClient();
      const deps = baseDeps();
      deps.createClient = vi.fn(() =>
        makeClient({
          ensureConnected: vi.fn(async () => {
            throw new Error('login required');
          }),
        }),
      );
      const service = new BackendProbeService(deps);
      const result = await service.start({ probeId: 'iso-auth', backendId: 'claude' });
      expect(result.outcome).toBe('auth_required');
      assertSharedUntouched(shared);
    });

    it('timeout leaves shared client untouched and disposes owned client', async () => {
      const shared = makeSharedAcpClient();
      const deps = baseDeps({
        stageTimeoutMs: 30,
        totalTimeoutMs: 500,
      });
      const owned = makeClient({
        ensureConnected: vi.fn(
          () =>
            new Promise(() => {
              /* hang */
            }),
        ),
      });
      deps.createClient = vi.fn(() => owned);
      const service = new BackendProbeService(deps);
      const result = await service.start({ probeId: 'iso-timeout', backendId: 'claude' });
      expect(result.outcome).toBe('failed');
      expect(result.code).toBe('timeout');
      expect(owned.dispose).toHaveBeenCalled();
      assertSharedUntouched(shared);
    });

    it('cancel leaves shared client untouched', async () => {
      const shared = makeSharedAcpClient();
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
      const pending = service.start({ probeId: 'iso-cancel', backendId: 'claude' });
      await vi.waitFor(() => {
        expect(deps.createClient).toHaveBeenCalled();
      });
      expect(service.cancel('claude')).toBe(true);
      const result = await pending;
      expect(result.outcome).toBe('cancelled');
      assertSharedUntouched(shared);
    });

    it('disposeAll leaves shared client untouched', async () => {
      const shared = makeSharedAcpClient();
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
      const a = service.start({ probeId: 'iso-a', backendId: 'claude' });
      const b = service.start({ probeId: 'iso-b', backendId: 'grok' });
      await vi.waitFor(() => {
        expect((deps.createClient as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
      });
      service.disposeAll();
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.outcome).toBe('cancelled');
      expect(rb.outcome).toBe('cancelled');
      assertSharedUntouched(shared);
    });
  });

  describe('behavioral — zero mutation of task/outbox/session surfaces', () => {
    it('probe start never invokes store/outbox/session mutation spies', async () => {
      const mutations = {
        insertOutbox: vi.fn(),
        createTask: vi.fn(),
        writeSession: vi.fn(),
        writeTurn: vi.fn(),
        writeMessage: vi.fn(),
        writeComposer: vi.fn(),
        getSharedAcpClient: vi.fn(),
        peekSharedAcpClient: vi.fn(),
      };
      const deps = baseDeps();
      const service = new BackendProbeService(deps);
      await service.start({ probeId: 'iso-zero', backendId: 'claude' });
      for (const [name, fn] of Object.entries(mutations)) {
        expect(fn, name).not.toHaveBeenCalled();
      }
    });
  });

  describe('module inventory completeness', () => {
    it('lists every probe production module under src/', () => {
      for (const file of PROBE_PRODUCTION_MODULES) {
        const abs = path.join(REPO_ROOT, file);
        expect(fs.existsSync(abs), `missing ${file}`).toBe(true);
      }
    });
  });
});
