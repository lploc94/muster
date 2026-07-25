import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_SCHEMA_VERSION,
  type BackendReadinessSnapshot,
} from '../shared/backend-readiness';
import { SEND_OUTBOX_TEXT_MAX } from '../task/repository';
import {
  evaluateNewTaskBackendEligibility,
  NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON,
  parseHostSendRequest,
} from './send-request';

function settledSnapshot(
  overrides: Partial<Record<(typeof BACKEND_READINESS_IDS)[number], Partial<BackendReadinessSnapshot['backends'][number]>>> = {},
): BackendReadinessSnapshot {
  const checkedAt = '2026-07-25T00:00:00.000Z';
  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: 'corr-elig',
    phase: 'settled',
    checkedAt,
    backends: BACKEND_READINESS_IDS.map((backendId) => ({
      backendId,
      state: 'missing',
      code: 'executable_missing',
      recoveryAction: 'install',
      compatibility: 'unknown',
      versionEvidence: null,
      checkedAt,
      ...overrides[backendId],
      backendId,
    })),
  };
}

describe('parseHostSendRequest', () => {
  const valid = {
    type: 'send',
    clientRequestId: 'request-1',
    taskId: 'task-1',
    text: '@plan',
    llmText: '/workspace/docs/plan.md',
    backend: 'grok',
    model: 'grok-4',
    skills: ['review'],
    mentionBindings: [['@plan', '/workspace/docs/plan.md']],
  } as const;

  it('accepts the exact current durable-send shape', () => {
    expect(parseHostSendRequest(valid)).toEqual({
      ok: true,
      value: {
        ...valid,
        skills: ['review'],
        mentionBindings: [['@plan', '/workspace/docs/plan.md']],
      },
    });
  });

  it('rejects missing correlation, extra keys, malformed bindings, and oversized content', () => {
    expect(parseHostSendRequest({ ...valid, clientRequestId: undefined }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, legacy: true }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, mentionBindings: [['x']] }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, skills: ['bad skill'] }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, text: 'x'.repeat(SEND_OUTBOX_TEXT_MAX + 1) }).ok).toBe(false);
  });

  it('returns only a validated correlation on rejection', () => {
    expect(parseHostSendRequest({ ...valid, backend: 'unknown' })).toEqual({
      ok: false,
      clientRequestId: 'request-1',
      taskId: 'task-1',
    });
    expect(parseHostSendRequest({ ...valid, clientRequestId: 'bad id', backend: 'unknown' })).toEqual({
      ok: false,
      taskId: 'task-1',
    });
  });
});

describe('evaluateNewTaskBackendEligibility', () => {
  it('rejects null/checking snapshots and absent backends with fixed validation reason', () => {
    expect(evaluateNewTaskBackendEligibility(null, 'claude')).toEqual({
      ok: false,
      reason: NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON,
      code: 'validation',
    });
    expect(
      evaluateNewTaskBackendEligibility(
        { ...settledSnapshot(), phase: 'checking' },
        'claude',
      ),
    ).toEqual({
      ok: false,
      reason: NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON,
      code: 'validation',
    });
    expect(evaluateNewTaskBackendEligibility(settledSnapshot(), undefined)).toEqual({
      ok: false,
      reason: NEW_TASK_BACKEND_ELIGIBILITY_REJECT_REASON,
      code: 'validation',
    });
  });

  it('rejects missing and known-incompatible backends; permits installed_unverified', () => {
    const missing = settledSnapshot();
    expect(evaluateNewTaskBackendEligibility(missing, 'claude').ok).toBe(false);

    const incompatible = settledSnapshot({
      claude: {
        state: 'incompatible',
        code: 'version_incompatible',
        recoveryAction: 'update',
        compatibility: 'incompatible',
        versionEvidence: '0.1.0',
      },
    });
    expect(evaluateNewTaskBackendEligibility(incompatible, 'claude').ok).toBe(false);

    const installed = settledSnapshot({
      opencode: {
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        compatibility: 'unknown',
        versionEvidence: '1.0.0',
      },
    });
    expect(evaluateNewTaskBackendEligibility(installed, 'opencode')).toEqual({
      ok: true,
      backend: 'opencode',
    });
    // Stale preference against a settled-empty inventory is rejected.
    expect(evaluateNewTaskBackendEligibility(installed, 'claude').ok).toBe(false);
  });
});
