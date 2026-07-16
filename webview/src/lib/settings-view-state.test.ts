import { describe, expect, it, vi } from 'vitest';
import type {
  PermissionModeSetting,
  PermissionSettingsSnapshot,
  RuntimeStorageSettingsSnapshot,
  TaskTypeSettingsRow,
} from './protocol';
import {
  PERMISSION_MODE_RISK_LABELS,
  RETENTION_SETTING_LABELS,
  SETTINGS_VIEW_STATE_KEY,
  SETTINGS_VIEW_STATE_VERSION,
  applyPermissionSnapshotToDraft,
  applyRetentionSnapshotToDrafts,
  applyTaskTypesSnapshotToDrafts,
  cloneRetentionDrafts,
  cloneTaskTypeDrafts,
  createDefaultSettingsViewState,
  createEmptyRetentionDrafts,
  isPermissionDraftDirty,
  isRetentionDraftsDirty,
  isTaskTypeDraftsDirty,
  mergeSettingsViewState,
  parseSettingsViewState,
  readSettingsViewState,
  reducePermissionSettingsUpdateResult,
  reduceRetentionUpdateResult,
  retentionDraftValidationMessage,
  retentionTabIndicator,
  permissionTabIndicator,
  serializeSettingsViewState,
  writeSettingsViewState,
  type SettingsViewState,
  type VsCodeStateApi,
} from './settings-view-state';

function sampleType(partial: Partial<TaskTypeSettingsRow> = {}): TaskTypeSettingsRow {
  return {
    id: 'worker',
    backend: 'opencode',
    role: 'worker',
    briefKind: 'generic',
    ...partial,
  };
}

function sampleRetentionSnapshot(
  values: {
    runLimit?: '15m' | '30m' | '1h' | '2h' | '4h' | '8h';
    maxRetainedTurnsPerTask?: number;
    maxStoredOutputChars?: number;
  } = {},
): RuntimeStorageSettingsSnapshot {
  return {
    settings: [
      {
        kind: 'enum',
        id: 'runLimit',
        label: 'Maximum uninterrupted agent run',
        description: 'desc',
        value: values.runLimit ?? '2h',
        defaultValue: '2h',
        options: ['15m', '30m', '1h', '2h', '4h', '8h'],
      },
      {
        kind: 'number',
        id: 'maxRetainedTurnsPerTask',
        label: 'Maximum turns per task',
        description: 'desc',
        value: values.maxRetainedTurnsPerTask ?? 40,
        defaultValue: 200,
        minimum: 1,
      },
      {
        kind: 'number',
        id: 'maxStoredOutputChars',
        label: 'Maximum stored output characters',
        description: 'desc',
        value: values.maxStoredOutputChars ?? 200_000,
        defaultValue: 200_000,
        minimum: 1024,
      },
    ],
  };
}

function memoryApi(initial: Record<string, unknown> = {}): VsCodeStateApi & {
  store: Record<string, unknown>;
} {
  const store = { ...initial };
  return {
    store,
    getState: () => store,
    setState: (next) => {
      Object.keys(store).forEach((key) => delete store[key]);
      Object.assign(store, next as Record<string, unknown>);
    },
  };
}

describe('createDefaultSettingsViewState', () => {
  it('starts on task-types with no drafts', () => {
    expect(createDefaultSettingsViewState()).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'task-types',
    });
  });
});

describe('parseSettingsViewState — fail closed', () => {
  it('rejects non-objects and wrong versions', () => {
    expect(parseSettingsViewState(null)).toBeNull();
    expect(parseSettingsViewState(undefined)).toBeNull();
    expect(parseSettingsViewState('x')).toBeNull();
    expect(parseSettingsViewState([])).toBeNull();
    expect(parseSettingsViewState({ v: 999, activeTopicId: 'task-types' })).toBeNull();
    expect(parseSettingsViewState({ activeTopicId: 'task-types' })).toBeNull();
  });

  it('rejects unknown active topics and falls back via readSettingsViewState', () => {
    expect(parseSettingsViewState({ v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: 'appearance' })).toBeNull();
    const api = memoryApi({
      [SETTINGS_VIEW_STATE_KEY]: { v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: 'telemetry' },
    });
    expect(readSettingsViewState(api)).toEqual(createDefaultSettingsViewState());
  });

  it('accepts known topics including coming-soon ids', () => {
    expect(parseSettingsViewState({ v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: 'retention' })).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'retention',
    });
    expect(parseSettingsViewState({ v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: 'models-and-clis' })?.activeTopicId).toBe(
      'models-and-clis',
    );
  });

  it('migrates v1 retention drafts while preserving the stable retention topic id', () => {
    expect(parseSettingsViewState({
      v: 1,
      activeTopicId: 'retention',
      retentionDrafts: {
        maxTurnsPerTask: '25',
        maxStoredOutputChars: '5000',
      },
    })).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'retention',
      retentionDrafts: {
        runLimit: '',
        maxRetainedTurnsPerTask: '25',
        maxStoredOutputChars: '5000',
      },
    });
  });

  it('bounds task type drafts and rejects oversized maps', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => sampleType({ id: `t${i}` }));
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'task-types',
        taskTypeDrafts: tooMany,
      }),
    ).toBeNull();

    const badRole = parseSettingsViewState({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'task-types',
      taskTypeDrafts: [sampleType({ role: 'admin' as 'worker' })],
    });
    expect(badRole).toBeNull();

    const longDesc = 'x'.repeat(201);
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'task-types',
        taskTypeDrafts: [sampleType({ description: longDesc })],
      }),
    ).toBeNull();
  });

  it('accepts explicit empty task type maps', () => {
    const parsed = parseSettingsViewState({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'task-types',
      taskTypeDrafts: [],
    });
    expect(parsed).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'task-types',
      taskTypeDrafts: [],
    });
  });

  it('bounds retention draft strings and drops unknown keys', () => {
    const parsed = parseSettingsViewState({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'retention',
      retentionDrafts: {
        runLimit: '',
        maxRetainedTurnsPerTask: '12',
        maxStoredOutputChars: '999',
        unknown: 'nope',
        maxRetainedTurnsPerTaskExtra: '1',
      },
    });
    expect(parsed).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'retention',
      retentionDrafts: {
        runLimit: '',
        maxRetainedTurnsPerTask: '12',
        maxStoredOutputChars: '999',
      },
    });

    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'retention',
        retentionDrafts: { maxRetainedTurnsPerTask: 'x'.repeat(65) },
      }),
    ).toBeNull();
  });

  it('rejects non-array taskTypeDrafts and non-object retentionDrafts', () => {
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'task-types',
        taskTypeDrafts: { id: 'worker' },
      }),
    ).toBeNull();
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'retention',
        retentionDrafts: ['12'],
      }),
    ).toBeNull();
  });
});

describe('merge and persistence', () => {
  it('merges settings view state without deleting composer or outbox keys', () => {
    const prev = {
      selectedBackend: 'claude',
      selectedModel: 'sonnet',
      sendOutbox: [{ clientRequestId: 'c1', text: 'hi', createdAt: 1, status: 'pending' }],
      otherKey: true,
    };
    const view: SettingsViewState = {
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'retention',
      retentionDrafts: createEmptyRetentionDrafts(),
      taskTypeDrafts: [sampleType({ id: 'coord', role: 'coordinator' })],
    };
    const merged = mergeSettingsViewState(prev, view);
    expect(merged.selectedBackend).toBe('claude');
    expect(merged.selectedModel).toBe('sonnet');
    expect(merged.sendOutbox).toEqual(prev.sendOutbox);
    expect(merged.otherKey).toBe(true);
    expect(merged[SETTINGS_VIEW_STATE_KEY]).toEqual(serializeSettingsViewState(view));
  });

  it('writeSettingsViewState clones and preserves unrelated keys via setState', () => {
    const api = memoryApi({
      selectedBackend: 'codex',
      sendOutbox: [{ clientRequestId: 'x', text: 'a', createdAt: 2, status: 'pending' }],
    });
    const drafts = [sampleType({ id: 'a' })];
    writeSettingsViewState(api, {
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'permissions',
      taskTypeDrafts: drafts,
    });
    // Mutating the original drafts must not affect stored state.
    drafts[0]!.id = 'mutated';
    const stored = api.store[SETTINGS_VIEW_STATE_KEY] as SettingsViewState;
    expect(stored.taskTypeDrafts?.[0]?.id).toBe('a');
    expect(api.store.selectedBackend).toBe('codex');
    expect(api.store.sendOutbox).toEqual([
      { clientRequestId: 'x', text: 'a', createdAt: 2, status: 'pending' },
    ]);
  });

  it('serializeSettingsViewState is clone-safe (JSON-safe plain data)', () => {
    const view: SettingsViewState = {
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'task-types',
      taskTypeDrafts: [sampleType({ model: 'm', description: 'd' })],
      retentionDrafts: {
        runLimit: '2h',
        maxRetainedTurnsPerTask: '3',
        maxStoredOutputChars: '4000',
      },
    };
    const serialized = serializeSettingsViewState(view);
    const roundTrip = JSON.parse(JSON.stringify(serialized)) as SettingsViewState;
    expect(roundTrip).toEqual(serialized);
    expect(roundTrip.taskTypeDrafts).not.toBe(view.taskTypeDrafts);
    expect(roundTrip.retentionDrafts).not.toBe(view.retentionDrafts);
  });

  it('readSettingsViewState recovers from getState throwing', () => {
    const api: VsCodeStateApi = {
      getState: () => {
        throw new Error('boom');
      },
      setState: vi.fn(),
    };
    expect(readSettingsViewState(api)).toEqual(createDefaultSettingsViewState());
  });
});

describe('dirty helpers', () => {
  it('detects retention dirty fields against saved snapshot', () => {
    const snapshot = sampleRetentionSnapshot({ maxRetainedTurnsPerTask: 40, maxStoredOutputChars: 200_000 });
    const pristine = {
      runLimit: '2h',
      maxRetainedTurnsPerTask: '40',
      maxStoredOutputChars: '200000',
    };
    expect(isRetentionDraftsDirty(pristine, snapshot)).toBe(false);
    expect(
      isRetentionDraftsDirty({ ...pristine, maxRetainedTurnsPerTask: '41' }, snapshot),
    ).toBe(true);
    expect(isRetentionDraftsDirty(pristine, null)).toBe(false);
  });

  it('detects task type draft dirtiness including explicit empty maps', () => {
    const saved = [sampleType({ id: 'worker' }), sampleType({ id: 'coord', role: 'coordinator' })];
    expect(isTaskTypeDraftsDirty(cloneTaskTypeDrafts(saved), saved)).toBe(false);
    expect(isTaskTypeDraftsDirty([], saved)).toBe(true);
    expect(isTaskTypeDraftsDirty([], [])).toBe(false);
    expect(
      isTaskTypeDraftsDirty(
        [sampleType({ id: 'worker', description: 'changed' })],
        [sampleType({ id: 'worker' })],
      ),
    ).toBe(true);
    // Optional empty model/description normalize equal to absent.
    expect(
      isTaskTypeDraftsDirty(
        [sampleType({ id: 'worker', model: '', description: '' })],
        [sampleType({ id: 'worker' })],
      ),
    ).toBe(false);
  });
});

describe('snapshot → draft application (dirty-safe)', () => {
  it('initializes pristine retention drafts from snapshot but never overwrites dirty ones', () => {
    const snapshot = sampleRetentionSnapshot({ maxRetainedTurnsPerTask: 10 });
    const pristine = applyRetentionSnapshotToDrafts(null, snapshot, false);
    expect(pristine).toEqual({
      runLimit: '2h',
      maxRetainedTurnsPerTask: '10',
      maxStoredOutputChars: '200000',
    });

    const dirty = {
      runLimit: '4h',
      maxRetainedTurnsPerTask: '99',
      maxStoredOutputChars: '1234',
    };
    expect(applyRetentionSnapshotToDrafts(dirty, snapshot, true)).toEqual(dirty);
  });

  it('hydrates empty runLimit from host after v1 migration while keeping dirty retention fields', () => {
    const snapshot = sampleRetentionSnapshot({ maxRetainedTurnsPerTask: 25, maxStoredOutputChars: 5000 });
    const migrated = {
      runLimit: '',
      maxRetainedTurnsPerTask: '25',
      maxStoredOutputChars: '999',
    };
    expect(applyRetentionSnapshotToDrafts(migrated, snapshot, true)).toEqual({
      runLimit: '2h',
      maxRetainedTurnsPerTask: '25',
      maxStoredOutputChars: '999',
    });
  });

  it('does not refill a user-cleared retention number draft from incidental snapshots', () => {
    const snapshot = sampleRetentionSnapshot({ maxRetainedTurnsPerTask: 25, maxStoredOutputChars: 5000 });
    const clearing = {
      runLimit: '2h',
      maxRetainedTurnsPerTask: '',
      maxStoredOutputChars: '5000',
    };
    expect(applyRetentionSnapshotToDrafts(clearing, snapshot, true)).toEqual(clearing);
  });

  it('initializes pristine task type drafts from snapshot but never overwrites dirty ones', () => {
    const saved = [sampleType({ id: 'worker' })];
    const next = applyTaskTypesSnapshotToDrafts(undefined, saved, false);
    expect(next).toEqual(saved);
    expect(next).not.toBe(saved);

    const dirty = [sampleType({ id: 'custom' })];
    expect(applyTaskTypesSnapshotToDrafts(dirty, saved, true)).toEqual(dirty);
    expect(applyTaskTypesSnapshotToDrafts([], saved, true)).toEqual([]);
  });

  it('clone helpers return independent copies', () => {
    const rows = [sampleType({ id: 'a', model: 'm' })];
    const cloned = cloneTaskTypeDrafts(rows);
    cloned[0]!.id = 'b';
    expect(rows[0]!.id).toBe('a');

    const retention = createEmptyRetentionDrafts();
    const clonedR = cloneRetentionDrafts(retention);
    clonedR.maxRetainedTurnsPerTask = '1';
    expect(retention.maxRetainedTurnsPerTask).toBe('');
  });
});

describe('reduceRetentionUpdateResult (topic-local failure isolation)', () => {
  const baseDrafts = {
    runLimit: '2h',
    maxRetainedTurnsPerTask: '99',
    maxStoredOutputChars: '1234',
  };
  const prev = {
    drafts: baseDrafts,
    fieldErrors: {} as Partial<Record<'maxRetainedTurnsPerTask' | 'maxStoredOutputChars', string>>,
    localFieldErrors: {} as Partial<Record<'maxRetainedTurnsPerTask' | 'maxStoredOutputChars', string>>,
  };

  it('on success updates only the confirmed field draft and clears only that field error', () => {
    const next = reduceRetentionUpdateResult(
      {
        ...prev,
        fieldErrors: { maxRetainedTurnsPerTask: 'stale', maxStoredOutputChars: 'keep-me' },
        localFieldErrors: { maxRetainedTurnsPerTask: 'client' },
      },
      { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 50 },
    );
    expect(next.drafts).toEqual({
      runLimit: '2h',
      maxRetainedTurnsPerTask: '50',
      maxStoredOutputChars: '1234',
    });
    expect(next.error).toBeNull();
    expect(next.savedMessage).toBe(`Saved ${RETENTION_SETTING_LABELS.maxRetainedTurnsPerTask}.`);
    expect(next.fieldErrors.maxRetainedTurnsPerTask).toBeUndefined();
    expect(next.fieldErrors.maxStoredOutputChars).toBe('keep-me');
    expect(next.localFieldErrors.maxRetainedTurnsPerTask).toBeUndefined();
    expect(next.confirmed).toEqual({ settingId: 'maxRetainedTurnsPerTask', value: 50 });
    // Original drafts object is not mutated.
    expect(baseDrafts.maxRetainedTurnsPerTask).toBe('99');
  });

  it('on host write failure keeps the attempted draft and surfaces a sanitized Retention-local alert', () => {
    const next = reduceRetentionUpdateResult(prev, {
      ok: false,
      settingId: 'maxRetainedTurnsPerTask',
      code: 'updateFailed',
      message: 'Unable to update Max turns per task.',
    });
    expect(next.drafts).toEqual(baseDrafts);
    expect(next.drafts).not.toBe(baseDrafts);
    expect(next.confirmed).toBeUndefined();
    expect(next.savedMessage).toBeNull();
    expect(next.error).toBe(
      `Unable to save ${RETENTION_SETTING_LABELS.maxRetainedTurnsPerTask}. Check the VS Code setting and try again.`,
    );
    // Never leak raw host paths/tokens into the Retention-local surface.
    expect(next.error).not.toMatch(/ENOENT|token=|\/secret/);
  });

  it('on field validation failure from host keeps drafts and maps message to that field only', () => {
    const next = reduceRetentionUpdateResult(prev, {
      ok: false,
      settingId: 'maxStoredOutputChars',
      code: 'belowMinimum',
      message: 'Max stored output characters must be at least 1024.',
    });
    expect(next.drafts).toEqual(baseDrafts);
    expect(next.error).toBeNull();
    expect(next.savedMessage).toBeNull();
    expect(next.fieldErrors).toEqual({
      maxStoredOutputChars: 'Max stored output characters must be at least 1024.',
    });
  });

  it('on unknownSetting failure keeps drafts and uses Retention-local load/save alert', () => {
    const next = reduceRetentionUpdateResult(prev, {
      ok: false,
      code: 'unknownSetting',
      message: 'Unknown setting.',
    });
    expect(next.drafts).toEqual(baseDrafts);
    expect(next.error).toBe(
      'Unable to load or save settings. Check the VS Code setting and try again.',
    );
    expect(next.savedMessage).toBeNull();
  });
});

describe('retentionDraftValidationMessage', () => {
  it('rejects empty, non-numeric, non-finite, non-integer, and below-minimum values', () => {
    const id = 'maxRetainedTurnsPerTask' as const;
    const label = RETENTION_SETTING_LABELS[id];
    expect(retentionDraftValidationMessage(id, '', 1, label)).toBe(`${label} must be a number.`);
    expect(retentionDraftValidationMessage(id, '  ', 1, label)).toBe(`${label} must be a number.`);
    expect(retentionDraftValidationMessage(id, 'abc', 1, label)).toBe(`${label} must be a number.`);
    expect(retentionDraftValidationMessage(id, 'Infinity', 1, label)).toBe(`${label} must be a number.`);
    expect(retentionDraftValidationMessage(id, '1.5', 1, label)).toBe(`${label} must be an integer.`);
    expect(retentionDraftValidationMessage(id, '0', 1, label)).toBe(`${label} must be at least 1.`);
    expect(retentionDraftValidationMessage(id, '10', 1, label)).toBeNull();
  });
});

function samplePermissionSnapshot(
  mode: PermissionModeSetting = 'ask',
): PermissionSettingsSnapshot {
  return {
    mode,
    defaultMode: 'ask',
    description:
      "How Muster handles agent tool-permission requests. 'ask' (safe): auto-allow read-only, prompt for writes/commands. 'allow': auto-approve everything (less safe). 'readonly': deny all writes/commands.",
    options: [
      {
        mode: 'ask',
        label: 'Ask',
        description: 'Safe: auto-allow read-only tool calls, prompt for writes/commands/unknown actions.',
        risk: 'recommended',
      },
      {
        mode: 'allow',
        label: 'Allow',
        description: 'Auto-approve every tool-permission request (least safe; still audit-logged).',
        risk: 'least-safe',
      },
      {
        mode: 'readonly',
        label: 'Read only',
        description: 'Allow read-only tool calls, deny all writes/commands without prompting.',
        risk: 'restricted',
      },
    ],
  };
}

describe('permission draft helpers', () => {
  it('detects dirty permission draft against saved snapshot mode', () => {
    expect(isPermissionDraftDirty('ask', samplePermissionSnapshot('ask'))).toBe(false);
    expect(isPermissionDraftDirty('allow', samplePermissionSnapshot('ask'))).toBe(true);
    expect(isPermissionDraftDirty(undefined, samplePermissionSnapshot('ask'))).toBe(false);
    expect(isPermissionDraftDirty('readonly', null)).toBe(false);
  });

  it('initializes pristine draft from snapshot but never overwrites dirty drafts', () => {
    const snapshot = samplePermissionSnapshot('ask');
    expect(applyPermissionSnapshotToDraft(undefined, snapshot, false)).toBe('ask');
    expect(applyPermissionSnapshotToDraft('allow', snapshot, true)).toBe('allow');
    expect(applyPermissionSnapshotToDraft('allow', samplePermissionSnapshot('readonly'), false)).toBe(
      'readonly',
    );
  });

  it('force-hydrate path replaces dirty draft after host success', () => {
    // dirty=false always hydrates from snapshot (used after force-hydrate success).
    expect(applyPermissionSnapshotToDraft('allow', samplePermissionSnapshot('readonly'), false)).toBe(
      'readonly',
    );
  });
});

describe('parseSettingsViewState — permission draft', () => {
  it('accepts known permission draft modes and rejects unknown modes', () => {
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'permissions',
        permissionDraftMode: 'readonly',
      }),
    ).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'permissions',
      permissionDraftMode: 'readonly',
    });

    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'permissions',
        permissionDraftMode: 'prompt',
      }),
    ).toBeNull();

    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'permissions',
        permissionDraftMode: 1,
      }),
    ).toBeNull();
  });

  it('serializes and restores permissionDraftMode without errors or sensitive fields', () => {
    const view: SettingsViewState = {
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'permissions',
      permissionDraftMode: 'allow',
    };
    const serialized = serializeSettingsViewState(view);
    expect(serialized).toEqual(view);
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(view);
    // Envelope never stores errors / raw host payloads.
    expect(serialized).not.toHaveProperty('error');
    expect(serialized).not.toHaveProperty('permissionError');
  });
});

describe('reducePermissionSettingsUpdateResult (topic-local failure isolation)', () => {
  it('on success updates draft mode, clears error, and exposes confirmed mode', () => {
    const next = reducePermissionSettingsUpdateResult(
      { draftMode: 'allow' },
      { ok: true, mode: 'allow' },
    );
    expect(next.draftMode).toBe('allow');
    expect(next.error).toBeNull();
    expect(next.savedMessage).toBe('Saved permission mode.');
    expect(next.confirmed).toEqual({ mode: 'allow' });
  });

  it('on host write failure keeps attempted draft and surfaces a sanitized Permissions-local alert', () => {
    const next = reducePermissionSettingsUpdateResult(
      { draftMode: 'allow' },
      {
        ok: false,
        code: 'updateFailed',
        message: 'Error: ENOENT /secret/token=abc stack',
      },
    );
    expect(next.draftMode).toBe('allow');
    expect(next.confirmed).toBeUndefined();
    expect(next.savedMessage).toBeNull();
    expect(next.error).toBe(
      'Unable to save permission mode. Check the VS Code setting and try again.',
    );
    expect(next.error).not.toMatch(/ENOENT|token=|\/secret|stack/);
  });

  it('on invalidPayload / unknownMode keeps draft and uses sanitized alert', () => {
    for (const code of ['invalidPayload', 'unknownMode'] as const) {
      const next = reducePermissionSettingsUpdateResult(
        { draftMode: 'readonly' },
        { ok: false, code, message: 'Unsupported permission mode update.' },
      );
      expect(next.draftMode).toBe('readonly');
      expect(next.savedMessage).toBeNull();
      expect(next.confirmed).toBeUndefined();
      expect(next.error).toBe(
        'Unable to save permission mode. Check the VS Code setting and try again.',
      );
    }
  });
});

describe('permissionTabIndicator', () => {
  it('prioritizes saving, error, dirty, then saved', () => {
    expect(
      permissionTabIndicator({
        saving: true,
        error: 'x',
        dirty: true,
        savedMessage: 'Saved',
      }),
    ).toEqual({ kind: 'saving', label: 'Saving' });

    expect(
      permissionTabIndicator({
        saving: false,
        error: 'Unable to save',
        dirty: true,
        savedMessage: null,
      }),
    ).toEqual({ kind: 'error', label: 'Error' });

    expect(
      permissionTabIndicator({
        saving: false,
        error: null,
        dirty: true,
        savedMessage: 'Saved',
      }),
    ).toEqual({ kind: 'dirty', label: 'Unsaved' });

    expect(
      permissionTabIndicator({
        saving: false,
        error: null,
        dirty: false,
        savedMessage: 'Saved permission mode.',
      }),
    ).toEqual({ kind: 'saved', label: 'Saved' });

    expect(
      permissionTabIndicator({
        saving: false,
        error: null,
        dirty: false,
        savedMessage: null,
      }),
    ).toBeNull();
  });

  it('exposes risk labels that mark Allow as least safe and Ask as recommended', () => {
    expect(PERMISSION_MODE_RISK_LABELS.recommended).toMatch(/recommended/i);
    expect(PERMISSION_MODE_RISK_LABELS['least-safe']).toMatch(/least safe/i);
    expect(PERMISSION_MODE_RISK_LABELS.restricted).toMatch(/restricted|read only|read-only/i);
  });
});

describe('retentionTabIndicator', () => {
  it('prioritizes saving, error, dirty, then saved; field errors count as error', () => {
    expect(
      retentionTabIndicator({
        saving: true,
        error: 'x',
        fieldErrors: {},
        localFieldErrors: {},
        dirty: true,
        savedMessage: 'Saved',
      }),
    ).toEqual({ kind: 'saving', label: 'Saving' });

    expect(
      retentionTabIndicator({
        saving: false,
        error: 'Unable to save',
        fieldErrors: {},
        localFieldErrors: {},
        dirty: true,
        savedMessage: null,
      }),
    ).toEqual({ kind: 'error', label: 'Error' });

    expect(
      retentionTabIndicator({
        saving: false,
        error: null,
        fieldErrors: { maxRetainedTurnsPerTask: 'bad' },
        localFieldErrors: {},
        dirty: true,
        savedMessage: null,
      }),
    ).toEqual({ kind: 'error', label: 'Error' });

    expect(
      retentionTabIndicator({
        saving: false,
        error: null,
        fieldErrors: {},
        localFieldErrors: { maxStoredOutputChars: 'client' },
        dirty: false,
        savedMessage: null,
      }),
    ).toEqual({ kind: 'error', label: 'Error' });

    expect(
      retentionTabIndicator({
        saving: false,
        error: null,
        fieldErrors: {},
        localFieldErrors: {},
        dirty: true,
        savedMessage: 'Saved',
      }),
    ).toEqual({ kind: 'dirty', label: 'Unsaved' });

    expect(
      retentionTabIndicator({
        saving: false,
        error: null,
        fieldErrors: {},
        localFieldErrors: {},
        dirty: false,
        savedMessage: 'Saved Maximum turns per task.',
      }),
    ).toEqual({ kind: 'saved', label: 'Saved' });

    expect(
      retentionTabIndicator({
        saving: false,
        error: null,
        fieldErrors: {},
        localFieldErrors: {},
        dirty: false,
        savedMessage: null,
      }),
    ).toBeNull();
  });
});
