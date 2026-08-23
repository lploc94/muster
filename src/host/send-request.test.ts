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
  NEW_TASK_BACKEND_FIRST_RUN_REJECT_REASON,
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

  it('accepts a valid attachments array of image paths', () => {
    expect(
      parseHostSendRequest({ ...valid, attachments: ['/workspace/shot.png', '/workspace/other.jpg'] }),
    ).toEqual({
      ok: true,
      value: {
        ...valid,
        skills: ['review'],
        mentionBindings: [['@plan', '/workspace/docs/plan.md']],
        attachments: ['/workspace/shot.png', '/workspace/other.jpg'],
      },
    });
  });

  it('omits attachments from the parsed value when absent', () => {
    const result = parseHostSendRequest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty('attachments');
    }
  });

  it('rejects attachments that are non-image, unsupported-extension, duplicate, or over the cap', () => {
    expect(parseHostSendRequest({ ...valid, attachments: ['/workspace/doc.txt'] }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, attachments: ['/workspace/noext'] }).ok).toBe(false);
    expect(
      parseHostSendRequest({ ...valid, attachments: ['/workspace/a.png', '/workspace/a.png'] }).ok,
    ).toBe(false);
    expect(
      parseHostSendRequest({
        ...valid,
        attachments: ['/a.png', '/b.png', '/c.png', '/d.png', '/e.png'],
      }).ok,
    ).toBe(false);
    expect(parseHostSendRequest({ ...valid, attachments: [] })).toEqual({
      ok: true,
      value: {
        ...valid,
        skills: ['review'],
        mentionBindings: [['@plan', '/workspace/docs/plan.md']],
      },
    });
    expect(parseHostSendRequest({ ...valid, attachments: 'not-an-array' }).ok).toBe(false);
    expect(parseHostSendRequest({ ...valid, attachments: [''] }).ok).toBe(false);
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

  it('rejects missing and known-incompatible backends; permits installed_unverified for non-clean workspaces', () => {
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
    // Existing users (non-clean workspace / default): S01 passivelySelectable rule.
    expect(evaluateNewTaskBackendEligibility(installed, 'opencode')).toEqual({
      ok: true,
      backend: 'opencode',
    });
    expect(
      evaluateNewTaskBackendEligibility(installed, 'opencode', { isCleanWorkspace: false }),
    ).toEqual({
      ok: true,
      backend: 'opencode',
    });
    // Stale preference against a settled-empty inventory is rejected.
    expect(evaluateNewTaskBackendEligibility(installed, 'claude').ok).toBe(false);
  });

  it('D060: clean workspace requires trustworthyFirstRunEligible (ready only)', () => {
    const installed = settledSnapshot({
      opencode: {
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        compatibility: 'unknown',
        versionEvidence: '1.0.0',
      },
    });
    // Clean workspace fails closed: installed_unverified is not enough.
    expect(
      evaluateNewTaskBackendEligibility(installed, 'opencode', { isCleanWorkspace: true }),
    ).toEqual({
      ok: false,
      reason: NEW_TASK_BACKEND_FIRST_RUN_REJECT_REASON,
      code: 'validation',
    });

    const ready = settledSnapshot({
      opencode: {
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility: 'compatible',
        versionEvidence: '1.0.0',
      },
    });
    expect(
      evaluateNewTaskBackendEligibility(ready, 'opencode', { isCleanWorkspace: true }),
    ).toEqual({
      ok: true,
      backend: 'opencode',
    });

    // Known-incompatible never passes even when clean + ready-shaped fields.
    const incompatibleReady = settledSnapshot({
      claude: {
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility: 'incompatible',
        versionEvidence: '1.0.0',
      },
    });
    expect(
      evaluateNewTaskBackendEligibility(incompatibleReady, 'claude', {
        isCleanWorkspace: true,
      }).ok,
    ).toBe(false);
  });

  it('D060: failed cleanliness read is fail-closed to the strict first-run rule', () => {
    // Caller maps a failed listRootTasks into isCleanWorkspace: true.
    const installed = settledSnapshot({
      grok: {
        state: 'installed_unverified',
        code: 'version_unknown',
        recoveryAction: 'retry',
        compatibility: 'unknown',
        versionEvidence: '2.0.0',
      },
    });
    expect(
      evaluateNewTaskBackendEligibility(installed, 'grok', { isCleanWorkspace: true }).ok,
    ).toBe(false);
  });
});
