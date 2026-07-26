import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../../../src/shared/backend-readiness';
import {
  createActiveBackendProbe,
  type ActiveBackendProbe,
} from './backend-eligibility';
import {
  buildBackendRowViews,
  resolveBackendsSectionState,
  resolveFirstRunJourney,
} from './backend-readiness-view';

function baseRecord(
  overrides: Partial<BackendReadinessRecord> & Pick<BackendReadinessRecord, 'backendId'>,
): BackendReadinessRecord {
  const base: BackendReadinessRecord = {
    backendId: overrides.backendId,
    state: 'missing',
    code: 'executable_missing',
    recoveryAction: 'install',
    compatibility: 'unknown',
    versionEvidence: null,
    checkedAt: '2026-07-25T12:34:56.000Z',
  };
  return { ...base, ...overrides };
}

function settledSnapshot(
  backends: BackendReadinessRecord[],
  overrides: Partial<BackendReadinessSnapshot> = {},
): BackendReadinessSnapshot {
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 'corr-view-1',
    phase: 'settled',
    checkedAt: '2026-07-25T12:34:56.000Z',
    backends,
    ...overrides,
  };
}

function fiveMissing(): BackendReadinessRecord[] {
  return BACKEND_READINESS_IDS.map((backendId) => baseRecord({ backendId }));
}

function allRowStrings(rows: ReturnType<typeof buildBackendRowViews>): string {
  return rows
    .flatMap((row) => [
      row.backendId,
      row.label,
      row.state,
      row.statusLabel,
      row.versionEvidence,
      row.diagnosticText,
      row.recoveryLabel,
      row.checkedAtLabel,
      row.stageLabel,
      row.accessibleName,
    ])
    .join('\n');
}

describe('resolveBackendsSectionState', () => {
  it('returns loading with no rows for null snapshot', () => {
    const section = resolveBackendsSectionState(null);
    expect(section.kind).toBe('loading');
    expect(section.rows).toEqual([]);
    expect(section.readyCount).toBe(0);
    expect(section.passiveCount).toBe(0);
    expect(section.summaryText).toMatch(/checking|loading/i);
  });

  it('returns loading with no rows for checking phase', () => {
    const section = resolveBackendsSectionState(
      settledSnapshot(fiveMissing(), { phase: 'checking' }),
    );
    expect(section.kind).toBe('loading');
    expect(section.rows).toEqual([]);
  });

  it('returns settled five rows for all-missing inventory', () => {
    const section = resolveBackendsSectionState(settledSnapshot(fiveMissing()));
    expect(section.kind).toBe('settled');
    expect(section.rows).toHaveLength(5);
    expect(section.readyCount).toBe(0);
    expect(section.passiveCount).toBe(0);
    expect(section.summaryText.length).toBeGreaterThan(0);
    expect(section.rows.every((r) => r.recoveryLabel.length > 0)).toBe(true);
  });
});

describe('buildBackendRowViews', () => {
  it('returns empty list when snapshot is null or not settled', () => {
    expect(buildBackendRowViews({ snapshot: null, activeProbe: null })).toEqual([]);
    expect(
      buildBackendRowViews({
        snapshot: settledSnapshot(fiveMissing(), { phase: 'checking' }),
        activeProbe: null,
      }),
    ).toEqual([]);
  });

  it('returns one row per provider in snapshot order', () => {
    const rows = buildBackendRowViews({
      snapshot: settledSnapshot(fiveMissing()),
      activeProbe: null,
    });
    expect(rows.map((r) => r.backendId)).toEqual([...BACKEND_READINESS_IDS]);
  });

  it('marks installed_unverified as canTest and not testing', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: '1.2.3',
    });
    const rows = buildBackendRowViews({
      snapshot: settledSnapshot(backends),
      activeProbe: null,
    });
    const claude = rows.find((r) => r.backendId === 'claude')!;
    expect(claude.canTest).toBe(true);
    expect(claude.isTesting).toBe(false);
    expect(claude.canCancel).toBe(false);
    expect(claude.versionEvidence).toBe('1.2.3');
    expect(claude.diagnosticText).toMatch(/not yet verified|Test Connection/i);
  });

  it('surfaces testing + activeProbe as isTesting/canCancel with stage label', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'testing',
      code: 'none',
      recoveryAction: 'none',
      versionEvidence: '1.2.3',
    });
    const activeProbe: ActiveBackendProbe = {
      ...createActiveBackendProbe('claude', 'probe-1'),
      stage: 'initialize',
      startedAt: '2026-07-25T12:35:00.000Z',
    };
    const rows = buildBackendRowViews({
      snapshot: settledSnapshot(backends),
      activeProbe,
    });
    const claude = rows.find((r) => r.backendId === 'claude')!;
    expect(claude.isTesting).toBe(true);
    expect(claude.canCancel).toBe(true);
    expect(claude.canTest).toBe(false);
    expect(claude.stageLabel).toMatch(/initializ/i);
    expect(claude.accessibleName).toMatch(/Claude/i);
  });

  it('surfaces auth_required diagnostic and recovery label', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'auth_required',
      code: 'auth_required',
      recoveryAction: 'login',
      versionEvidence: '1.2.3',
    });
    const rows = buildBackendRowViews({
      snapshot: settledSnapshot(backends),
      activeProbe: null,
    });
    const claude = rows.find((r) => r.backendId === 'claude')!;
    expect(claude.diagnosticText).toMatch(/sign in/i);
    expect(claude.recoveryLabel).toMatch(/sign in/i);
    expect(claude.canTest).toBe(true);
  });

  it('passes versionEvidence through without reformatting and labels checkedAt', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
      versionEvidence: '2.0.0-beta',
    });
    const rows = buildBackendRowViews({
      snapshot: settledSnapshot(backends),
      activeProbe: null,
    });
    const claude = rows.find((r) => r.backendId === 'claude')!;
    expect(claude.versionEvidence).toBe('2.0.0-beta');
    expect(claude.checkedAtLabel.length).toBeGreaterThan(0);
    expect(claude.statusLabel.toLowerCase()).toMatch(/ready/);
  });

  it('never leaks non-allowlisted extra fields into row strings', () => {
    const backends = fiveMissing();
    const dirty = baseRecord({
      backendId: 'claude',
      state: 'failed',
      code: 'internal_error',
      recoveryAction: 'retry',
    }) as BackendReadinessRecord & { stderr?: string; absolutePath?: string };
    dirty.stderr = 'ENOENT /Users/secret/.local/bin/claude boom';
    dirty.absolutePath = 'C:\\Users\\secret\\AppData\\Local\\claude.exe';
    backends[0] = dirty;

    const rows = buildBackendRowViews({
      snapshot: settledSnapshot(backends),
      activeProbe: null,
    });
    const blob = allRowStrings(rows);
    expect(blob).not.toContain('/Users/secret');
    expect(blob).not.toContain('C:\\Users\\secret');
    expect(blob).not.toContain('ENOENT');
    expect(blob).not.toContain('claude.exe');
  });
});

describe('resolveFirstRunJourney', () => {
  it('hides the journey while loading', () => {
    const journey = resolveFirstRunJourney({
      snapshot: null,
      taskCount: 0,
    });
    expect(journey.visible).toBe(false);
  });

  it('hides the journey when taskCount > 0 regardless of readiness', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
    });
    const journey = resolveFirstRunJourney({
      snapshot: settledSnapshot(backends),
      taskCount: 1,
    });
    expect(journey.visible).toBe(false);
  });

  it('activates install when settled with zero passively selectable backends', () => {
    const journey = resolveFirstRunJourney({
      snapshot: settledSnapshot(fiveMissing()),
      taskCount: 0,
    });
    expect(journey.visible).toBe(true);
    expect(journey.activeStepId).toBe('install');
    expect(journey.steps.map((s) => s.id)).toEqual([
      'install',
      'refresh',
      'test',
      'first-task',
    ]);
    const install = journey.steps.find((s) => s.id === 'install')!;
    expect(install.state).toBe('active');
    expect(journey.headline.length).toBeGreaterThan(0);
    expect(journey.detail.length).toBeGreaterThan(0);
  });

  it('activates test when at least one passive backend exists but none are ready', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      versionEvidence: '1.0.0',
    });
    const journey = resolveFirstRunJourney({
      snapshot: settledSnapshot(backends),
      taskCount: 0,
    });
    expect(journey.visible).toBe(true);
    expect(journey.activeStepId).toBe('test');
    expect(journey.steps.find((s) => s.id === 'install')?.state).toBe('done');
    expect(journey.steps.find((s) => s.id === 'refresh')?.state).toBe('done');
    expect(journey.steps.find((s) => s.id === 'test')?.state).toBe('active');
    expect(journey.steps.find((s) => s.id === 'first-task')?.state).toBe('todo');
  });

  it('activates first-task when a trustworthy ready backend exists', () => {
    const backends = fiveMissing();
    backends[0] = baseRecord({
      backendId: 'claude',
      state: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
      versionEvidence: '1.0.0',
    });
    const journey = resolveFirstRunJourney({
      snapshot: settledSnapshot(backends),
      taskCount: 0,
    });
    expect(journey.visible).toBe(true);
    expect(journey.activeStepId).toBe('first-task');
    expect(journey.steps.every((s) => s.state === 'done' || s.id === 'first-task')).toBe(
      true,
    );
    expect(journey.steps.find((s) => s.id === 'first-task')?.state).toBe('active');
    expect(journey.detail).toMatch(/Claude|first task/i);
  });

  it('does not invent paths or stderr in journey copy', () => {
    const journey = resolveFirstRunJourney({
      snapshot: settledSnapshot(fiveMissing()),
      taskCount: 0,
    });
    const blob = `${journey.headline}\n${journey.detail}\n${journey.steps.map((s) => s.label).join('\n')}`;
    expect(blob).not.toMatch(/[/\\]Users[/\\]/);
    expect(blob).not.toMatch(/stderr|ENOENT/i);
  });
});
