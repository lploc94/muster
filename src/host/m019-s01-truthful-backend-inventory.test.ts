/**
 * Named M019 S01 flow: five-missing → refresh one installed_unverified →
 * derived availability + new-task accept/reject with zero mutation on rejects,
 * and no ACP/model/session invocation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  derivePassivelySelectableBackendIds,
  isPassivelySelectable,
  isTrustworthyFirstRunEligible,
  parseBackendReadinessSnapshot,
} from '../shared/backend-readiness';
import {
  BackendReadinessService,
  type BackendReadinessServiceDeps,
} from './backend-readiness';
import type { BackendReadinessId } from '../shared/backend-readiness';
import type { VersionCollectResult } from './backend-version';
import {
  evaluateNewTaskBackendEligibility,
  NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON,
} from './send-request';

function baseDeps(
  overrides: Partial<BackendReadinessServiceDeps> = {},
): BackendReadinessServiceDeps & {
  __present: Set<string>;
  __versions: Map<BackendReadinessId, VersionCollectResult>;
  __forbidden: {
    acp: ReturnType<typeof vi.fn>;
    model: ReturnType<typeof vi.fn>;
    session: ReturnType<typeof vi.fn>;
  };
} {
  const present = new Set<string>();
  const versions = new Map<BackendReadinessId, VersionCollectResult>();
  const forbidden = {
    acp: vi.fn(),
    model: vi.fn(),
    session: vi.fn(),
  };
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
    collectVersion: async (backendId) => {
      // Version collection is passive execFile-style only — no ACP/model/session.
      return (
        versions.get(backendId) ?? {
          versionEvidence: null,
          code: 'version_unknown',
        }
      );
    },
    classifyCompatibility: () => 'unknown',
    now: () => new Date('2026-07-25T12:00:00.000Z'),
    createCorrelationId: () => 'corr-s01-flow',
    ...overrides,
    __present: present,
    __versions: versions,
    __forbidden: forbidden,
  } as BackendReadinessServiceDeps & {
    __present: Set<string>;
    __versions: Map<BackendReadinessId, VersionCollectResult>;
    __forbidden: {
      acp: ReturnType<typeof vi.fn>;
      model: ReturnType<typeof vi.fn>;
      session: ReturnType<typeof vi.fn>;
    };
  };
}

describe('M019 S01 truthful backend inventory flow', () => {
  it('starts five-missing, refreshes one installed_unverified, gates new-task, never touches ACP', async () => {
    const deps = baseDeps();
    const present = deps.__present;
    const versions = deps.__versions;
    const forbidden = deps.__forbidden;
    const service = new BackendReadinessService(deps);

    // --- Phase 1: all five missing ---
    const missing = await service.refresh('flow-missing');
    expect(missing.phase).toBe('settled');
    expect(missing.backends).toHaveLength(5);
    expect(missing.backends.map((b) => b.backendId)).toEqual([...BACKEND_READINESS_IDS]);
    for (const record of missing.backends) {
      expect(record.state).toBe('missing');
      expect(isPassivelySelectable(record)).toBe(false);
      expect(isTrustworthyFirstRunEligible(record)).toBe(false);
    }
    expect(derivePassivelySelectableBackendIds(missing)).toEqual([]);
    expect(service.peek()).toEqual(missing);

    // New-task rejects for every backend + absent preference; zero mutation surface.
    let mutationCount = 0;
    const recordMutation = () => {
      mutationCount += 1;
    };
    for (const id of BACKEND_READINESS_IDS) {
      const result = evaluateNewTaskBackendEligibility(service.peek(), id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON);
        expect(result.code).toBe('validation');
      } else {
        recordMutation();
      }
    }
    expect(evaluateNewTaskBackendEligibility(service.peek(), undefined).ok).toBe(false);
    expect(evaluateNewTaskBackendEligibility(null, 'claude').ok).toBe(false);
    expect(mutationCount).toBe(0);

    // --- Phase 2: fake opencode executable + version evidence ---
    present.add('opencode');
    versions.set('opencode', { versionEvidence: '1.2.3', code: 'none' });
    const refreshed = await service.refresh('flow-refresh');
    expect(refreshed.correlationId).toBe('flow-refresh');
    const opencode = refreshed.backends.find((b) => b.backendId === 'opencode')!;
    expect(opencode.state).toBe('installed_unverified');
    expect(opencode.versionEvidence).toBe('1.2.3');
    expect(isPassivelySelectable(opencode)).toBe(true);
    expect(isTrustworthyFirstRunEligible(opencode)).toBe(false);

    // Derived hostEnv.availableBackends is only the passive target.
    expect(derivePassivelySelectableBackendIds(refreshed)).toEqual(['opencode']);

    // Accept only the installed-unverified provider; reject stale claude preference.
    expect(evaluateNewTaskBackendEligibility(service.peek(), 'opencode')).toEqual({
      ok: true,
      backend: 'opencode',
    });
    expect(evaluateNewTaskBackendEligibility(service.peek(), 'claude')).toEqual({
      ok: false,
      reason: NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON,
      code: 'validation',
    });

    // Wire-safe: snapshot survives parse round-trip (host→webview contract).
    expect(parseBackendReadinessSnapshot(JSON.parse(JSON.stringify(refreshed)))).toEqual(
      refreshed,
    );

    // No ACP / model / session methods were invoked by inventory or gate.
    expect(forbidden.acp).not.toHaveBeenCalled();
    expect(forbidden.model).not.toHaveBeenCalled();
    expect(forbidden.session).not.toHaveBeenCalled();
  });
});
