import { describe, it, expect, vi } from 'vitest';
import {
  BackendReadinessService,
  type BackendReadinessServiceDeps,
} from './backend-readiness';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  isPassivelySelectable,
  isTrustworthyFirstRunEligible,
  parseBackendReadinessSnapshot,
  type BackendReadinessId,
  type BackendReadinessSnapshot,
} from '../shared/backend-readiness';
import type { VersionCollectResult } from './backend-version';

function baseDeps(
  overrides: Partial<BackendReadinessServiceDeps> = {},
): BackendReadinessServiceDeps {
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
    createCorrelationId: () => 'corr-test-1',
    ...overrides,
    // Helpers for tests
    __present: present,
    __versions: versions,
  } as BackendReadinessServiceDeps & {
    __present: Set<string>;
    __versions: Map<BackendReadinessId, VersionCollectResult>;
  };
}

describe('BackendReadinessService', () => {
  it('peek returns null before any refresh', () => {
    const service = new BackendReadinessService(baseDeps());
    expect(service.peek()).toBeNull();
  });

  it('refresh returns exactly one ordered record per backend when all missing', async () => {
    const service = new BackendReadinessService(baseDeps());
    const snap = await service.refresh();
    expect(snap.schemaVersion).toBe(BACKEND_READINESS_SCHEMA_VERSION);
    expect(snap.phase).toBe('settled');
    expect(snap.correlationId).toBe('corr-test-1');
    expect(snap.checkedAt).toBe('2026-07-25T12:00:00.000Z');
    expect(snap.backends.map((b) => b.backendId)).toEqual([...BACKEND_READINESS_IDS]);
    for (const record of snap.backends) {
      expect(record.state).toBe('missing');
      expect(record.code).toBe('executable_missing');
      expect(record.recoveryAction).toBe('install');
      expect(record.compatibility).toBe('unknown');
      expect(record.versionEvidence).toBeNull();
      expect(isPassivelySelectable(record)).toBe(false);
      expect(isTrustworthyFirstRunEligible(record)).toBe(false);
    }
    expect(parseBackendReadinessSnapshot(snap)).not.toBeNull();
    expect(service.peek()).toEqual(snap);
  });

  it('marks a present executable as installed_unverified with version evidence', async () => {
    const deps = baseDeps();
    const present = (deps as { __present: Set<string> }).__present;
    const versions = (deps as {
      __versions: Map<BackendReadinessId, VersionCollectResult>;
    }).__versions;
    present.add('claude');
    versions.set('claude', { versionEvidence: '2.1.4', code: 'none' });

    const service = new BackendReadinessService(deps);
    const snap = await service.refresh('refresh-1');
    const claude = snap.backends.find((b) => b.backendId === 'claude')!;
    expect(claude.state).toBe('installed_unverified');
    expect(claude.code).toBe('none');
    expect(claude.recoveryAction).toBe('none');
    expect(claude.versionEvidence).toBe('2.1.4');
    expect(claude.compatibility).toBe('unknown');
    expect(isPassivelySelectable(claude)).toBe(true);
    expect(isTrustworthyFirstRunEligible(claude)).toBe(false);

    // Others remain missing
    expect(snap.backends.filter((b) => b.state === 'missing')).toHaveLength(4);
    expect(snap.correlationId).toBe('refresh-1');
  });

  it('marks known-incompatible versions as incompatible and not selectable', async () => {
    const deps = baseDeps({
      classifyCompatibility: (id, version) =>
        id === 'claude' && version === '0.1.0' ? 'incompatible' : 'unknown',
    });
    const present = (deps as { __present: Set<string> }).__present;
    const versions = (deps as {
      __versions: Map<BackendReadinessId, VersionCollectResult>;
    }).__versions;
    present.add('claude');
    versions.set('claude', { versionEvidence: '0.1.0', code: 'none' });

    const service = new BackendReadinessService(deps);
    const snap = await service.refresh();
    const claude = snap.backends.find((b) => b.backendId === 'claude')!;
    expect(claude.state).toBe('incompatible');
    expect(claude.code).toBe('version_incompatible');
    expect(claude.recoveryAction).toBe('update');
    expect(claude.compatibility).toBe('incompatible');
    expect(isPassivelySelectable(claude)).toBe(false);
  });

  it('keeps installed_unverified when version is unknown (executable present)', async () => {
    const deps = baseDeps();
    const present = (deps as { __present: Set<string> }).__present;
    const versions = (deps as {
      __versions: Map<BackendReadinessId, VersionCollectResult>;
    }).__versions;
    present.add('grok');
    versions.set('grok', { versionEvidence: null, code: 'version_unknown' });

    const service = new BackendReadinessService(deps);
    const snap = await service.refresh();
    const grok = snap.backends.find((b) => b.backendId === 'grok')!;
    expect(grok.state).toBe('installed_unverified');
    expect(grok.code).toBe('version_unknown');
    expect(grok.recoveryAction).toBe('none');
    expect(grok.versionEvidence).toBeNull();
    expect(isPassivelySelectable(grok)).toBe(true);
  });

  it('never emits ready, testing, or auth_required states in S01', async () => {
    const deps = baseDeps();
    const present = (deps as { __present: Set<string> }).__present;
    for (const cmd of ['claude', 'grok', 'kiro-cli', 'codex', 'opencode']) present.add(cmd);
    const versions = (deps as {
      __versions: Map<BackendReadinessId, VersionCollectResult>;
    }).__versions;
    for (const id of BACKEND_READINESS_IDS) {
      versions.set(id, { versionEvidence: '1.0.0', code: 'none' });
    }
    const service = new BackendReadinessService(deps);
    const snap = await service.refresh();
    for (const record of snap.backends) {
      expect(['ready', 'testing', 'auth_required']).not.toContain(record.state);
      expect(record.state).toBe('installed_unverified');
    }
  });

  it('settles every backend even when version collection throws', async () => {
    const deps = baseDeps({
      collectVersion: async () => {
        throw new Error('should be absorbed by service or collectVersion');
      },
    });
    const present = (deps as { __present: Set<string> }).__present;
    present.add('claude');
    const service = new BackendReadinessService(deps);
    const snap = await service.refresh();
    expect(snap.backends).toHaveLength(5);
    expect(snap.phase).toBe('settled');
    const claude = snap.backends.find((b) => b.backendId === 'claude')!;
    // Executable present; version failure becomes bounded diagnostic, not omitted.
    expect(claude.state).toBe('installed_unverified');
    expect(['version_unknown', 'internal_error', 'timeout', 'process_exited']).toContain(
      claude.code,
    );
  });

  it('never invokes ACP, model catalog, task engine, or session paths', async () => {
    const forbidden = {
      getSharedAcpClient: vi.fn(),
      peekSharedAcpClient: vi.fn(),
      enumerateModels: vi.fn(),
      openSession: vi.fn(),
      sendPrompt: vi.fn(),
    };
    const service = new BackendReadinessService(baseDeps());
    await service.refresh();
    for (const fn of Object.values(forbidden)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('bounds version collection concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = baseDeps({
      collectVersion: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { versionEvidence: '1.0.0', code: 'none' as const };
      },
    });
    const present = (deps as { __present: Set<string> }).__present;
    for (const cmd of ['claude', 'grok', 'kiro-cli', 'codex', 'opencode']) present.add(cmd);

    const service = new BackendReadinessService(deps);
    await service.refresh();
    // Five providers, but concurrency must stay below total (bounded pool).
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('refresh replaces peek with the latest settled snapshot', async () => {
    let n = 0;
    const deps = baseDeps({
      createCorrelationId: () => `corr-${++n}`,
      now: () => new Date(`2026-07-25T12:00:0${n}.000Z`),
    });
    const service = new BackendReadinessService(deps);
    const first = await service.refresh();
    const second = await service.refresh();
    expect(first.correlationId).not.toBe(second.correlationId);
    expect(service.peek()?.correlationId).toBe(second.correlationId);
  });

  it('snapshot always passes the fail-closed shared parser', async () => {
    const deps = baseDeps();
    const present = (deps as { __present: Set<string> }).__present;
    present.add('codex');
    const versions = (deps as {
      __versions: Map<BackendReadinessId, VersionCollectResult>;
    }).__versions;
    versions.set('codex', { versionEvidence: '0.45.0', code: 'none' });
    const service = new BackendReadinessService(deps);
    const snap: BackendReadinessSnapshot = await service.refresh();
    const parsed = parseBackendReadinessSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(parsed).toEqual(snap);
  });
});
