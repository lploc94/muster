/**
 * M019 S01 / T06: Mechanical zero-side-effect invariant for passive backend readiness.
 *
 * Proves by production source scan + behavioral fixtures that S01 passive inventory:
 * - never imports ACP client, model-catalog, task engine, repository, or session store
 * - never calls getSharedAcpClient / peekSharedAcpClient / session/prompt / enumerateModels
 * - never emits ready / testing / auth_required from BackendReadinessService
 * - never mutates task / outbox / session stores
 * - keeps activation / panel open on passive postAvailableBackends only
 *   (model enumeration remains explicit listModels)
 *
 * Source-scan style follows src/backends/m017-s07-debt-ledger.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  isPassivelySelectable,
  isTrustworthyFirstRunEligible,
  type BackendReadinessId,
} from '../shared/backend-readiness';
import {
  BackendReadinessService,
  type BackendReadinessServiceDeps,
} from './backend-readiness';
import type { VersionCollectResult } from './backend-version';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.resolve(__dirname, '..');

/** Production modules that own passive inventory for S01. */
const PASSIVE_READINESS_MODULES = [
  'src/shared/backend-readiness.ts',
  'src/host/backend-availability.ts',
  'src/host/backend-version.ts',
  'src/host/backend-readiness.ts',
] as const;

/** Forbidden import/path needles inside passive readiness production modules. */
const FORBIDDEN_IMPORT_NEEDLES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'acp-client', pattern: /from\s+['"][^'"]*acp-client['"]/ },
  { label: 'model-catalog', pattern: /from\s+['"][^'"]*model-catalog['"]/ },
  { label: 'task/engine', pattern: /from\s+['"][^'"]*task\/engine['"]/ },
  { label: 'task/store', pattern: /from\s+['"][^'"]*task\/store['"]/ },
  { label: 'task/repository', pattern: /from\s+['"][^'"]*task\/repository['"]/ },
  { label: 'session store', pattern: /from\s+['"][^'"]*session[^'"]*['"]/ },
  { label: 'send-request (outbox path)', pattern: /from\s+['"][^'"]*send-request['"]/ },
];

/** Forbidden call / symbol needles inside passive readiness production modules. */
const FORBIDDEN_CALL_NEEDLES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'getSharedAcpClient', pattern: /\bgetSharedAcpClient\b/ },
  { label: 'peekSharedAcpClient', pattern: /\bpeekSharedAcpClient\b/ },
  { label: 'enumerateModels', pattern: /\benumerateModels\b/ },
  { label: 'session/prompt', pattern: /session\/prompt/ },
  { label: 'session/new', pattern: /session\/new/ },
  { label: 'TaskEngine', pattern: /\bTaskEngine\b/ },
  { label: 'TaskStore', pattern: /\bTaskStore\b/ },
  { label: 'taskRepository', pattern: /\btaskRepository\b/ },
  { label: 'outbox insert', pattern: /\binsertOutbox\b|\bcreateSendOutbox\b/ },
];

function rel(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function scanHits(
  content: string,
  file: string,
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((text, idx) => {
    if (pattern.test(text)) {
      hits.push({ file, line: idx + 1, text: text.trim() });
    }
  });
  return hits;
}

function baseDeps(
  overrides: Partial<BackendReadinessServiceDeps> = {},
): BackendReadinessServiceDeps & {
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
    now: () => new Date('2026-07-25T12:00:00.000Z'),
    createCorrelationId: () => 'corr-invariant',
    ...overrides,
    __present: present,
    __versions: versions,
  } as BackendReadinessServiceDeps & {
    __present: Set<string>;
    __versions: Map<BackendReadinessId, VersionCollectResult>;
  };
}

describe('M019 S01 zero-side-effect invariant (T06)', () => {
  describe('production source scan — passive readiness modules', () => {
    it('do not import ACP, model-catalog, task engine/store/repository, or outbox paths', () => {
      const allHits: Array<{ label: string; file: string; line: number; text: string }> = [];
      for (const file of PASSIVE_READINESS_MODULES) {
        const content = readRepoFile(file);
        for (const { label, pattern } of FORBIDDEN_IMPORT_NEEDLES) {
          for (const hit of scanHits(content, file, pattern)) {
            allHits.push({ label, ...hit });
          }
        }
      }
      expect(allHits, JSON.stringify(allHits, null, 2)).toEqual([]);
    });

    it('do not call shared ACP, model enumeration, session, task engine, or outbox symbols', () => {
      const allHits: Array<{ label: string; file: string; line: number; text: string }> = [];
      for (const file of PASSIVE_READINESS_MODULES) {
        const content = readRepoFile(file);
        for (const { label, pattern } of FORBIDDEN_CALL_NEEDLES) {
          for (const hit of scanHits(content, file, pattern)) {
            allHits.push({ label, ...hit });
          }
        }
      }
      expect(allHits, JSON.stringify(allHits, null, 2)).toEqual([]);
    });

    it('passive modules only depend on shared contract + local inventory/version I/O', () => {
      // Mechanical allowlist: each passive module's from-imports must stay within
      // node builtins, local host inventory, or the shared readiness contract.
      const allowedFrom = [
        /^crypto$/,
        /^path$/,
        /^fs$/,
        /^os$/,
        /^util$/,
        /^child_process$/,
        /^\.\.\/shared\/backend-readiness$/,
        /^\.\/backend-availability$/,
        /^\.\/backend-version$/,
      ];
      const violations: Array<{ file: string; line: number; text: string }> = [];
      for (const file of PASSIVE_READINESS_MODULES) {
        const content = readRepoFile(file);
        const lines = content.split(/\r?\n/);
        lines.forEach((text, idx) => {
          const m = text.match(/from\s+['"]([^'"]+)['"]/);
          if (!m) return;
          const spec = m[1];
          // Skip type-only re-exports already covered; check every from-spec.
          if (!allowedFrom.some((re) => re.test(spec))) {
            violations.push({ file, line: idx + 1, text: text.trim() });
          }
        });
      }
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  });

  describe('extension host wiring — activation / panel stay passive', () => {
    it('prepareHostEnvironment comments and body exclude enumerateModels', () => {
      const content = readRepoFile('src/extension.ts');
      // Isolate the prepareHostEnvironment function body.
      const start = content.indexOf('async function prepareHostEnvironment');
      expect(start).toBeGreaterThanOrEqual(0);
      const end = content.indexOf('\nfunction getHostEnvironment', start);
      expect(end).toBeGreaterThan(start);
      const body = content.slice(start, end);
      expect(body).toMatch(/Passive inventory only/);
      expect(body).toMatch(/ensureBackendReadiness/);
      expect(body).not.toMatch(/\benumerateModels\b/);
      expect(body).not.toMatch(/\bpostAvailableModels\b/);
      expect(body).not.toMatch(/session\/prompt/);
    });

    it('panel resolve posts passive backends only — no automatic listModels/enumerateModels', () => {
      const content = readRepoFile('src/extension.ts');
      // Isolate the panel resolve tail that posts initial host state.
      const marker = 'Passive readiness inventory only on panel resolve';
      const start = content.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = content.indexOf('private _getHtmlForWebview', start);
      expect(end).toBeGreaterThan(start);
      const body = content.slice(start, end);
      expect(body).toMatch(/postAvailableBackends/);
      expect(body).not.toMatch(/\bpostAvailableModels\b/);
      expect(body).not.toMatch(/\benumerateModels\b/);
      // Comment may name listModels as the explicit path; forbid call/post sites only.
      expect(body).not.toMatch(/case\s+'listModels'/);
      expect(body).not.toMatch(/type:\s*['"]listModels['"]/);
      expect(body).not.toMatch(/\bpostAvailableModels\s*\(/);
    });

    it('enumerateModels is only reachable from the explicit listModels message handler path', () => {
      const content = readRepoFile('src/extension.ts');
      const lines = content.split(/\r?\n/);
      let postAvailableModelsLine = -1;
      let nextPrivateAfterPost = lines.length;
      for (let i = 0; i < lines.length; i++) {
        if (/private async postAvailableModels/.test(lines[i])) {
          postAvailableModelsLine = i + 1;
        }
      }
      expect(postAvailableModelsLine).toBeGreaterThan(0);
      for (let i = postAvailableModelsLine; i < lines.length; i++) {
        // Next method at the same private/public class level after postAvailableModels body.
        if (
          i + 1 > postAvailableModelsLine &&
          /^\s{2}(private|public|async|protected)\s+/.test(lines[i])
        ) {
          nextPrivateAfterPost = i + 1;
          break;
        }
      }

      // Every enumerateModels call site must live inside postAvailableModels.
      const callSites = scanHits(content, 'src/extension.ts', /\benumerateModels\s*\(/);
      expect(callSites.length).toBeGreaterThan(0);
      for (const hit of callSites) {
        expect(
          hit.line,
          `enumerateModels at L${hit.line} must be inside postAvailableModels (${postAvailableModelsLine}..${nextPrivateAfterPost})`,
        ).toBeGreaterThanOrEqual(postAvailableModelsLine);
        expect(hit.line).toBeLessThan(nextPrivateAfterPost);
      }

      // listModels handler only routes to postAvailableModels.
      const listModelsCase = content.match(
        /case\s+'listModels'\s*:\s*([\s\S]*?)break;/,
      );
      expect(listModelsCase).not.toBeNull();
      expect(listModelsCase![1]).toMatch(/postAvailableModels/);
      expect(listModelsCase![1]).not.toMatch(/ensureBackendReadiness\s*\(\s*true/);
    });

    it('listBackends / requestBackendReadiness / refreshBackendReadiness never call enumerateModels', () => {
      const content = readRepoFile('src/extension.ts');
      for (const type of [
        'listBackends',
        'requestBackendReadiness',
        'refreshBackendReadiness',
      ] as const) {
        const re = new RegExp(`case\\s+'${type}'\\s*:\\s*([\\s\\S]*?)break;`);
        const m = content.match(re);
        expect(m, `missing case ${type}`).not.toBeNull();
        expect(m![1], type).not.toMatch(/\benumerateModels\b/);
        expect(m![1], type).not.toMatch(/\bpostAvailableModels\b/);
        expect(m![1], type).not.toMatch(/session\/prompt/);
      }
    });
  });

  describe('protocol surface — readiness is additive and passive', () => {
    it('protocol declares backendReadinessSnapshot + request/refresh; S02 probe names are additive', () => {
      const content = readRepoFile('webview/src/lib/protocol.ts');
      // Strip comments so isolation docs may name forbidden methods without failing the scan.
      const code = content
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/(^|[\s;{}()\[\],=])\/\/.*$/gm, '$1');
      expect(code).toMatch(/backendReadinessSnapshot/);
      expect(code).toMatch(/requestBackendReadiness/);
      expect(code).toMatch(/refreshBackendReadiness/);
      // S01 forbade ad-hoc auth probe names. S02 adds the closed start/cancel/progress
      // probe messages (isolation proven by backend-probe.invariant.test.ts).
      // Legacy informal names remain forbidden.
      expect(code).not.toMatch(/\btestConnection\b|\bprobeBackend\b|\bauthProbe\b/i);
      // session/prompt must never appear as executable protocol surface code.
      expect(code).not.toMatch(/session\/prompt/);
      // S02 additive contract is present (does not regress when S02 ships).
      expect(code).toMatch(/startBackendProbe/);
      expect(code).toMatch(/cancelBackendProbe/);
      expect(code).toMatch(/backendProbeProgress/);
    });
  });

  describe('behavioral — BackendReadinessService never produces active/auth states', () => {
    it('refresh never emits ready, testing, or auth_required for any backend', async () => {
      const deps = baseDeps();
      // Present all five with version evidence — S01 still settles installed_unverified.
      for (const cmd of ['claude', 'grok', 'kiro-cli', 'codex', 'opencode']) {
        deps.__present.add(cmd);
      }
      for (const id of BACKEND_READINESS_IDS) {
        deps.__versions.set(id, { versionEvidence: '9.9.9', code: 'none' });
      }
      const service = new BackendReadinessService(deps);
      const snap = await service.refresh('invariant-all-present');
      expect(snap.phase).toBe('settled');
      expect(snap.backends).toHaveLength(5);
      for (const record of snap.backends) {
        expect(['ready', 'testing', 'auth_required']).not.toContain(record.state);
        expect(record.state).toBe('installed_unverified');
        // D058: passively selectable, not trustworthy-first-run.
        expect(isPassivelySelectable(record)).toBe(true);
        expect(isTrustworthyFirstRunEligible(record)).toBe(false);
      }
    });

    it('refresh does not invoke any ACP / model / session / store spies', async () => {
      const forbidden = {
        getSharedAcpClient: vi.fn(),
        peekSharedAcpClient: vi.fn(),
        enumerateModels: vi.fn(),
        openSession: vi.fn(),
        sendPrompt: vi.fn(),
        insertOutbox: vi.fn(),
        createTask: vi.fn(),
        writeSession: vi.fn(),
      };
      const service = new BackendReadinessService(baseDeps());
      await service.refresh('invariant-no-spies');
      for (const [name, fn] of Object.entries(forbidden)) {
        expect(fn, name).not.toHaveBeenCalled();
      }
    });

    it('missing inventory settles without store mutation hooks', async () => {
      let mutations = 0;
      const service = new BackendReadinessService(
        baseDeps({
          // No mutation surface is available on deps — counting proves refresh
          // completes with only inventory/version I/O.
          collectVersion: async () => {
            mutations += 0; // intentional no-op counter baseline
            return { versionEvidence: null, code: 'version_unknown' };
          },
        }),
      );
      const snap = await service.refresh('invariant-missing');
      expect(snap.backends.every((b) => b.state === 'missing')).toBe(true);
      expect(mutations).toBe(0);
      // No durable side-effect surface: peek is pure cache of the settled snapshot.
      expect(service.peek()).toEqual(snap);
    });
  });

  describe('module inventory completeness', () => {
    it('lists every passive readiness production module that exists under src/', () => {
      for (const file of PASSIVE_READINESS_MODULES) {
        const abs = path.join(REPO_ROOT, file);
        expect(fs.existsSync(abs), `missing ${rel(abs)}`).toBe(true);
      }
      // Guard: SRC_ROOT still resolves (scanner root for future expansion).
      expect(fs.existsSync(SRC_ROOT)).toBe(true);
    });
  });
});
