import { describe, expect, it, vi } from 'vitest';
import type {
  PermissionModeSetting,
  PermissionSettingsSnapshot,
  RuntimeStorageSettingsSnapshot,
  TaskTypeSettingsRow,
} from './protocol';
import {
  DATA_RUNTIME_STORAGE_IDS,
  EXECUTION_RUNTIME_STORAGE_IDS,
  PERMISSION_MODE_RISK_LABELS,
  RETENTION_SETTING_LABELS,
  SETTINGS_VIEW_STATE_KEY,
  SETTINGS_VIEW_STATE_VERSION,
  applyPermissionSnapshotToDraft,
  applyRuntimeStorageSnapshotToDrafts,
  applyTaskTypesSnapshotToDrafts,
  cloneRetentionDrafts,
  cloneTaskTypeDrafts,
  createDefaultSettingsViewState,
  createEmptyRetentionDrafts,
  isPermissionDraftDirty,
  isRetentionDraftsDirty,
  isRuntimeStorageDraftDirtyFor,
  isTaskTypeDraftsDirty,
  mergeSettingsIndicators,
  mergeSettingsViewState,
  parseSettingsViewState,
  readSettingsViewState,
  reducePermissionSettingsUpdateResult,
  reduceRetentionUpdateResult,
  retentionDraftValidationMessage,
  runtimeStorageTabIndicatorFor,
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
  it('starts on the agents domain with no drafts', () => {
    expect(createDefaultSettingsViewState()).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'agents',
    });
  });
});

describe('parseSettingsViewState — fail closed', () => {
  it('rejects non-objects and wrong versions', () => {
    expect(parseSettingsViewState(null)).toBeNull();
    expect(parseSettingsViewState(undefined)).toBeNull();
    expect(parseSettingsViewState('x')).toBeNull();
    expect(parseSettingsViewState([])).toBeNull();
    expect(parseSettingsViewState({ v: 999, activeTopicId: 'agents' })).toBeNull();
    expect(parseSettingsViewState({ activeTopicId: 'agents' })).toBeNull();
  });

  it('rejects unknown active domains and falls back via readSettingsViewState', () => {
    expect(parseSettingsViewState({ v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: 'appearance' })).toBeNull();
    const api = memoryApi({
      [SETTINGS_VIEW_STATE_KEY]: { v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: 'telemetry' },
    });
    expect(readSettingsViewState(api)).toEqual(createDefaultSettingsViewState());
  });

  it('accepts the three rendered v3 domain ids', () => {
    for (const id of ['agents', 'execution', 'data'] as const) {
      expect(
        parseSettingsViewState({ v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: id })?.activeTopicId,
      ).toBe(id);
    }
  });

  it('rejects the reserved (non-rendered) connections domain', () => {
    expect(
      parseSettingsViewState({ v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: 'connections' }),
    ).toBeNull();
  });

  it('does not migrate legacy topic ids inside a v3 envelope', () => {
    for (const legacy of [
      'task-types',
      'permissions',
      'retention',
      'models-and-clis',
      'context-and-mcp',
    ]) {
      expect(
        parseSettingsViewState({ v: SETTINGS_VIEW_STATE_VERSION, activeTopicId: legacy }),
      ).toBeNull();
    }
  });

  it('accepts unique v3 dirty-field metadata only when retention drafts exist', () => {
    const raw = {
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'data',
      retentionDrafts: {
        runLimit: '2h',
        maxRetainedTurnsPerTask: '99',
        maxStoredOutputChars: '200000',
      },
      retentionDirtySettingIds: ['maxRetainedTurnsPerTask'],
    };
    expect(parseSettingsViewState(raw)).toEqual(raw);
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'data',
        retentionDirtySettingIds: ['maxRetainedTurnsPerTask'],
      }),
    ).toBeNull();
    expect(parseSettingsViewState({ ...raw, retentionDirtySettingIds: ['unknown'] })).toBeNull();
    expect(
      parseSettingsViewState({
        ...raw,
        retentionDirtySettingIds: ['maxRetainedTurnsPerTask', 'maxRetainedTurnsPerTask'],
      }),
    ).toBeNull();
  });

  it('bounds task type drafts and rejects oversized maps', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => sampleType({ id: `t${i}` }));
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'agents',
        taskTypeDrafts: tooMany,
      }),
    ).toBeNull();

    const badRole = parseSettingsViewState({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'agents',
      taskTypeDrafts: [sampleType({ role: 'admin' as 'worker' })],
    });
    expect(badRole).toBeNull();

    const longDesc = 'x'.repeat(201);
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'agents',
        taskTypeDrafts: [sampleType({ description: longDesc })],
      }),
    ).toBeNull();
  });

  it('accepts explicit empty task type maps', () => {
    const parsed = parseSettingsViewState({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'agents',
      taskTypeDrafts: [],
    });
    expect(parsed).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'agents',
      taskTypeDrafts: [],
    });
  });

  it('bounds retention draft strings and drops unknown keys', () => {
    const parsed = parseSettingsViewState({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'data',
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
      activeTopicId: 'data',
      retentionDrafts: {
        runLimit: '',
        maxRetainedTurnsPerTask: '12',
        maxStoredOutputChars: '999',
      },
    });

    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'data',
        retentionDrafts: { maxRetainedTurnsPerTask: 'x'.repeat(65) },
      }),
    ).toBeNull();
  });

  it('rejects non-array taskTypeDrafts and non-object retentionDrafts', () => {
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'agents',
        taskTypeDrafts: { id: 'worker' },
      }),
    ).toBeNull();
    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'data',
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
      activeTopicId: 'data',
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
      activeTopicId: 'execution',
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
      activeTopicId: 'agents',
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

  it('scopes dirtiness per domain subset so one domain never marks the other dirty', () => {
    const snapshot = sampleRetentionSnapshot({ maxRetainedTurnsPerTask: 40, maxStoredOutputChars: 200_000 });
    const pristine = {
      runLimit: '2h',
      maxRetainedTurnsPerTask: '40',
      maxStoredOutputChars: '200000',
    };

    // A dirty Data field must not mark the Execution run-limit subset dirty.
    const dirtyData = { ...pristine, maxRetainedTurnsPerTask: '41' };
    expect(isRuntimeStorageDraftDirtyFor(EXECUTION_RUNTIME_STORAGE_IDS, dirtyData, snapshot)).toBe(false);
    expect(isRuntimeStorageDraftDirtyFor(DATA_RUNTIME_STORAGE_IDS, dirtyData, snapshot)).toBe(true);

    // A dirty run-limit must not mark the Data subset dirty.
    const dirtyRun = { ...pristine, runLimit: '4h' };
    expect(isRuntimeStorageDraftDirtyFor(EXECUTION_RUNTIME_STORAGE_IDS, dirtyRun, snapshot)).toBe(true);
    expect(isRuntimeStorageDraftDirtyFor(DATA_RUNTIME_STORAGE_IDS, dirtyRun, snapshot)).toBe(false);
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

describe('applyRuntimeStorageSnapshotToDrafts (field-by-field hydration)', () => {
  it('initializes uninitialized drafts fully from the snapshot', () => {
    const snapshot = sampleRetentionSnapshot({ maxRetainedTurnsPerTask: 10 });
    expect(applyRuntimeStorageSnapshotToDrafts(null, snapshot)).toEqual({
      runLimit: '2h',
      maxRetainedTurnsPerTask: '10',
      maxStoredOutputChars: '200000',
    });
  });

  it('hydrates a pristine Execution run-limit even when a Data field is dirty', () => {
    // Drafts were hydrated from prev; user then edited only maxRetainedTurnsPerTask.
    const prev = sampleRetentionSnapshot({
      runLimit: '2h',
      maxRetainedTurnsPerTask: 40,
      maxStoredOutputChars: 200_000,
    });
    const dirtyDataDraft = {
      runLimit: '2h',
      maxRetainedTurnsPerTask: '99',
      maxStoredOutputChars: '200000',
    };
    const incoming = sampleRetentionSnapshot({
      runLimit: '4h',
      maxRetainedTurnsPerTask: 40,
      maxStoredOutputChars: 200_000,
    });
    expect(applyRuntimeStorageSnapshotToDrafts(dirtyDataDraft, incoming, prev)).toEqual({
      runLimit: '4h', // pristine → refreshed
      maxRetainedTurnsPerTask: '99', // dirty → preserved
      maxStoredOutputChars: '200000',
    });
  });

  it('hydrates pristine Data fields even when the run-limit is dirty', () => {
    const prev = sampleRetentionSnapshot({
      runLimit: '2h',
      maxRetainedTurnsPerTask: 40,
      maxStoredOutputChars: 200_000,
    });
    const dirtyRunDraft = {
      runLimit: '8h',
      maxRetainedTurnsPerTask: '40',
      maxStoredOutputChars: '200000',
    };
    const incoming = sampleRetentionSnapshot({
      runLimit: '2h',
      maxRetainedTurnsPerTask: 55,
      maxStoredOutputChars: 300_000,
    });
    expect(applyRuntimeStorageSnapshotToDrafts(dirtyRunDraft, incoming, prev)).toEqual({
      runLimit: '8h', // dirty → preserved
      maxRetainedTurnsPerTask: '55', // pristine → refreshed
      maxStoredOutputChars: '300000', // pristine → refreshed
    });
  });

  it('uses persisted v3 dirty-field ownership on the first snapshot after restore', () => {
    const restoredDrafts = {
      runLimit: '2h',
      maxRetainedTurnsPerTask: '99',
      maxStoredOutputChars: '200000',
    };
    const incoming = sampleRetentionSnapshot({
      runLimit: '4h',
      maxRetainedTurnsPerTask: 40,
      maxStoredOutputChars: 300_000,
    });
    expect(
      applyRuntimeStorageSnapshotToDrafts(
        restoredDrafts,
        incoming,
        null,
        ['maxRetainedTurnsPerTask'],
      ),
    ).toEqual({
      runLimit: '4h',
      maxRetainedTurnsPerTask: '99',
      maxStoredOutputChars: '300000',
    });
  });

  it('does not refill a user-cleared Data number draft from incidental snapshots', () => {
    const clearing = {
      runLimit: '2h',
      maxRetainedTurnsPerTask: '',
      maxStoredOutputChars: '5000',
    };
    const incoming = sampleRetentionSnapshot({ maxRetainedTurnsPerTask: 25, maxStoredOutputChars: 5000 });
    expect(applyRuntimeStorageSnapshotToDrafts(
      clearing,
      incoming,
      null,
      ['maxRetainedTurnsPerTask'],
    )).toEqual({
      runLimit: '2h',
      maxRetainedTurnsPerTask: '', // cleared, dirty → preserved
      maxStoredOutputChars: '5000',
    });
  });
});

describe('task type snapshot → draft application (dirty-safe)', () => {
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

describe('reduceRetentionUpdateResult (owner-aware failure isolation)', () => {
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

  it('on success updates only the confirmed field draft, sets feedbackOwner, and clears only that field error', () => {
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
    expect(next.feedbackOwner).toBe('maxRetainedTurnsPerTask');
    expect(next.fieldErrors.maxRetainedTurnsPerTask).toBeUndefined();
    expect(next.fieldErrors.maxStoredOutputChars).toBe('keep-me');
    expect(next.localFieldErrors.maxRetainedTurnsPerTask).toBeUndefined();
    expect(next.confirmed).toEqual({ settingId: 'maxRetainedTurnsPerTask', value: 50 });
    // Original drafts object is not mutated.
    expect(baseDrafts.maxRetainedTurnsPerTask).toBe('99');
  });

  it('routes a run-limit save success to the runLimit owner', () => {
    const next = reduceRetentionUpdateResult(prev, { ok: true, settingId: 'runLimit', value: '4h' });
    expect(next.feedbackOwner).toBe('runLimit');
    expect(next.confirmed).toEqual({ settingId: 'runLimit', value: '4h' });
  });

  it('on host write failure keeps the attempted draft, sets owner, and surfaces a sanitized alert', () => {
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
    expect(next.feedbackOwner).toBe('maxRetainedTurnsPerTask');
    expect(next.error).toBe(
      `Unable to save ${RETENTION_SETTING_LABELS.maxRetainedTurnsPerTask}. Check the VS Code setting and try again.`,
    );
    // Never leak raw host paths/tokens into the domain surface.
    expect(next.error).not.toMatch(/ENOENT|token=|\/secret/);
  });

  it('on field validation failure from host keeps drafts, sets owner, and maps message to that field only', () => {
    const next = reduceRetentionUpdateResult(prev, {
      ok: false,
      settingId: 'maxStoredOutputChars',
      code: 'belowMinimum',
      message: 'Max stored output characters must be at least 1024.',
    });
    expect(next.drafts).toEqual(baseDrafts);
    expect(next.error).toBeNull();
    expect(next.savedMessage).toBeNull();
    expect(next.feedbackOwner).toBe('maxStoredOutputChars');
    expect(next.fieldErrors).toEqual({
      maxStoredOutputChars: 'Max stored output characters must be at least 1024.',
    });
  });

  it('on unknownSetting failure keeps drafts and uses a Settings-level alert with no owner', () => {
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
    expect(next.feedbackOwner).toBeNull();
  });

  it('attributes an unknownSetting failure to the pending save when available', () => {
    const next = reduceRetentionUpdateResult(
      prev,
      {
        ok: false,
        code: 'unknownSetting',
        message: 'Unsupported setting.',
      },
      'runLimit',
    );
    expect(next.feedbackOwner).toBe('runLimit');
    expect(next.error).toBe(
      'Unable to load or save settings. Check the VS Code setting and try again.',
    );
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
        activeTopicId: 'execution',
        permissionDraftMode: 'readonly',
      }),
    ).toEqual({
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'execution',
      permissionDraftMode: 'readonly',
    });

    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'execution',
        permissionDraftMode: 'prompt',
      }),
    ).toBeNull();

    expect(
      parseSettingsViewState({
        v: SETTINGS_VIEW_STATE_VERSION,
        activeTopicId: 'execution',
        permissionDraftMode: 1,
      }),
    ).toBeNull();
  });

  it('serializes and restores permissionDraftMode without errors or sensitive fields', () => {
    const view: SettingsViewState = {
      v: SETTINGS_VIEW_STATE_VERSION,
      activeTopicId: 'execution',
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

describe('reducePermissionSettingsUpdateResult (domain-local failure isolation)', () => {
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

  it('on host write failure keeps attempted draft and surfaces a sanitized Tool access alert', () => {
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
      permissionTabIndicator({ saving: true, error: 'x', dirty: true, savedMessage: 'Saved' }),
    ).toEqual({ kind: 'saving', label: 'Saving' });
    expect(
      permissionTabIndicator({ saving: false, error: 'Unable to save', dirty: true, savedMessage: null }),
    ).toEqual({ kind: 'error', label: 'Error' });
    expect(
      permissionTabIndicator({ saving: false, error: null, dirty: true, savedMessage: 'Saved' }),
    ).toEqual({ kind: 'dirty', label: 'Unsaved' });
    expect(
      permissionTabIndicator({ saving: false, error: null, dirty: false, savedMessage: 'Saved permission mode.' }),
    ).toEqual({ kind: 'saved', label: 'Saved' });
    expect(
      permissionTabIndicator({ saving: false, error: null, dirty: false, savedMessage: null }),
    ).toBeNull();
  });

  it('exposes risk labels that mark Allow as least safe and Ask as recommended', () => {
    expect(PERMISSION_MODE_RISK_LABELS.recommended).toMatch(/recommended/i);
    expect(PERMISSION_MODE_RISK_LABELS['least-safe']).toMatch(/least safe/i);
    expect(PERMISSION_MODE_RISK_LABELS.restricted).toMatch(/restricted|read only|read-only/i);
  });
});

describe('runtimeStorageTabIndicatorFor (per-domain subset)', () => {
  const clean = {
    savingSettingId: null,
    error: null,
    feedbackOwner: null,
    fieldErrors: {},
    localFieldErrors: {},
    dirty: false,
    savedMessage: null,
  } as const;

  it('only counts saving for a setting in the subset', () => {
    expect(
      runtimeStorageTabIndicatorFor(EXECUTION_RUNTIME_STORAGE_IDS, {
        ...clean,
        savingSettingId: 'runLimit',
      }),
    ).toEqual({ kind: 'saving', label: 'Saving' });
    // A Data field saving does not mark Execution as saving.
    expect(
      runtimeStorageTabIndicatorFor(EXECUTION_RUNTIME_STORAGE_IDS, {
        ...clean,
        savingSettingId: 'maxRetainedTurnsPerTask',
      }),
    ).toBeNull();
  });

  it('only counts field errors for settings in the subset', () => {
    expect(
      runtimeStorageTabIndicatorFor(DATA_RUNTIME_STORAGE_IDS, {
        ...clean,
        fieldErrors: { maxStoredOutputChars: 'bad' },
      }),
    ).toEqual({ kind: 'error', label: 'Error' });
    expect(
      runtimeStorageTabIndicatorFor(EXECUTION_RUNTIME_STORAGE_IDS, {
        ...clean,
        fieldErrors: { maxStoredOutputChars: 'bad' },
      }),
    ).toBeNull();
  });

  it('routes shared error/saved banners only to the owning subset', () => {
    // A run-limit save error/owner does not create a Data indicator, and vice versa.
    expect(
      runtimeStorageTabIndicatorFor(DATA_RUNTIME_STORAGE_IDS, {
        ...clean,
        error: 'Run limit save failed',
        feedbackOwner: 'runLimit',
      }),
    ).toBeNull();
    expect(
      runtimeStorageTabIndicatorFor(EXECUTION_RUNTIME_STORAGE_IDS, {
        ...clean,
        error: 'Run limit save failed',
        feedbackOwner: 'runLimit',
      }),
    ).toEqual({ kind: 'error', label: 'Error' });

    expect(
      runtimeStorageTabIndicatorFor(EXECUTION_RUNTIME_STORAGE_IDS, {
        ...clean,
        savedMessage: 'Saved Retained turns per completed task.',
        feedbackOwner: 'maxRetainedTurnsPerTask',
      }),
    ).toBeNull();
    expect(
      runtimeStorageTabIndicatorFor(DATA_RUNTIME_STORAGE_IDS, {
        ...clean,
        savedMessage: 'Saved Retained turns per completed task.',
        feedbackOwner: 'maxRetainedTurnsPerTask',
      }),
    ).toEqual({ kind: 'saved', label: 'Saved' });
  });

  it('prioritizes saving > error > dirty > saved within a subset', () => {
    expect(
      runtimeStorageTabIndicatorFor(DATA_RUNTIME_STORAGE_IDS, {
        ...clean,
        savingSettingId: 'maxStoredOutputChars',
        fieldErrors: { maxStoredOutputChars: 'bad' },
        dirty: true,
        savedMessage: 'Saved',
        feedbackOwner: 'maxStoredOutputChars',
      }),
    ).toEqual({ kind: 'saving', label: 'Saving' });
    expect(
      runtimeStorageTabIndicatorFor(DATA_RUNTIME_STORAGE_IDS, { ...clean, dirty: true }),
    ).toEqual({ kind: 'dirty', label: 'Unsaved' });
  });
});

describe('mergeSettingsIndicators', () => {
  it('folds indicators by severity: saving > error > dirty > diagnostic > saved', () => {
    expect(
      mergeSettingsIndicators(
        { kind: 'saved', label: 'Saved' },
        { kind: 'error', label: 'Error' },
      ),
    ).toEqual({ kind: 'error', label: 'Error' });
    expect(
      mergeSettingsIndicators(
        { kind: 'dirty', label: 'Unsaved' },
        { kind: 'saving', label: 'Saving' },
      ),
    ).toEqual({ kind: 'saving', label: 'Saving' });
    expect(
      mergeSettingsIndicators(
        { kind: 'diagnostic', label: 'Needs attention' },
        { kind: 'saved', label: 'Saved' },
      ),
    ).toEqual({ kind: 'diagnostic', label: 'Needs attention' });
  });

  it('ignores null/undefined inputs and returns null when nothing is set', () => {
    expect(mergeSettingsIndicators(null, undefined)).toBeNull();
    expect(mergeSettingsIndicators(null, { kind: 'dirty', label: 'Unsaved' })).toEqual({
      kind: 'dirty',
      label: 'Unsaved',
    });
  });
});
