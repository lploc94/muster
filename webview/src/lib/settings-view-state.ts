/**
 * Versioned Settings view-state envelope for webview hide/reveal.
 *
 * Persists only the active topic and non-sensitive Task Types / Retention /
 * Permissions drafts through vscode.getState / setState. Not a generic topic
 * registry — host save contracts remain explicit per domain. Errors and raw
 * host failure payloads are never stored in the envelope.
 */

import type {
  PermissionModeRisk,
  PermissionModeSetting,
  PermissionSettingsSnapshot,
  PermissionSettingsUpdateResult,
  RuntimeStorageSettingId,
  RuntimeStorageSettingsSnapshot,
  RunLimitSetting,
  SettingsUpdateResult,
  TaskTypeSettingsRow,
} from './protocol';
import { isSettingsTopicId, type SettingsTopicId } from './settings-topics';

/** Nested key under the shared vscode webview state bag. */
export const SETTINGS_VIEW_STATE_KEY = 'muster.settingsView.v1';

/** Envelope version — bump only with a coordinated migration. */
export const SETTINGS_VIEW_STATE_VERSION = 2 as const;

/** Bounds aligned with host task-type constraints (fail closed on restore). */
export const SETTINGS_TASK_TYPE_DRAFT_MAX = 32;
export const SETTINGS_TASK_TYPE_ID_MAX = 64;
export const SETTINGS_TASK_TYPE_STRING_MAX = 200;
export const SETTINGS_TASK_TYPE_DESCRIPTION_MAX = 200;
export const SETTINGS_RETENTION_DRAFT_STRING_MAX = 64;

const RETENTION_IDS: readonly RuntimeStorageSettingId[] = [
  'runLimit',
  'maxRetainedTurnsPerTask',
  'maxStoredOutputChars',
] as const;

const ROLES = new Set(['coordinator', 'worker']);

export type RetentionDrafts = Record<RuntimeStorageSettingId, string>;

/** Display labels for Retention fields (UI + sanitized save messages). */
export const RETENTION_SETTING_LABELS: Record<RuntimeStorageSettingId, string> = {
  runLimit: 'Maximum uninterrupted agent run',
  maxRetainedTurnsPerTask: 'Retained turns per completed task',
  maxStoredOutputChars: 'Stored output per turn',
};

export type SettingsTabIndicator = { kind: string; label: string };

export interface RetentionUpdateUiState {
  drafts: RetentionDrafts;
  fieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
  localFieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
  error: string | null;
  savedMessage: string | null;
  /** Present only on successful host write — App applies this to the saved snapshot. */
  confirmed?: { settingId: RuntimeStorageSettingId; value: number | RunLimitSetting };
}

export interface SettingsViewState {
  v: typeof SETTINGS_VIEW_STATE_VERSION;
  activeTopicId: SettingsTopicId;
  /** Present when the user has an in-progress Task Types draft (including empty). */
  taskTypeDrafts?: TaskTypeSettingsRow[];
  /** Present when the user has in-progress Retention field drafts. */
  retentionDrafts?: RetentionDrafts;
  /** Present when the user has an in-progress Permissions mode draft. */
  permissionDraftMode?: PermissionModeSetting;
}

export interface PermissionUpdateUiState {
  draftMode: PermissionModeSetting;
  error: string | null;
  savedMessage: string | null;
  /** Present only on successful host write — App applies this to the saved snapshot. */
  confirmed?: { mode: PermissionModeSetting };
}

/** UI labels for permission-mode risk badges (Allow is least safe; Ask recommended). */
export const PERMISSION_MODE_RISK_LABELS: Record<PermissionModeRisk, string> = {
  recommended: 'Recommended default',
  'least-safe': 'Least safe',
  restricted: 'Restricted',
};

const PERMISSION_MODES = new Set<PermissionModeSetting>(['ask', 'allow', 'readonly']);

function isPermissionModeSetting(value: unknown): value is PermissionModeSetting {
  return typeof value === 'string' && PERMISSION_MODES.has(value as PermissionModeSetting);
}

export type VsCodeStateApi = {
  getState?: () => unknown;
  setState?: (state: unknown) => void;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteIntegerLikeString(value: string): boolean {
  return value.length <= SETTINGS_RETENTION_DRAFT_STRING_MAX;
}

function normalizeOptionalString(
  value: unknown,
  max: number,
): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  if (value.length > max) return null;
  return value;
}

function parseTaskTypeRow(raw: unknown): TaskTypeSettingsRow | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length > SETTINGS_TASK_TYPE_ID_MAX) return null;
  if (typeof raw.backend !== 'string' || raw.backend.length > SETTINGS_TASK_TYPE_STRING_MAX) {
    return null;
  }
  if (typeof raw.role !== 'string' || !ROLES.has(raw.role)) return null;
  if (
    typeof raw.briefKind !== 'string' ||
    raw.briefKind.length === 0 ||
    raw.briefKind.length > SETTINGS_TASK_TYPE_STRING_MAX
  ) {
    return null;
  }

  const model = normalizeOptionalString(raw.model, SETTINGS_TASK_TYPE_STRING_MAX);
  if (model === null) return null;
  const description = normalizeOptionalString(
    raw.description,
    SETTINGS_TASK_TYPE_DESCRIPTION_MAX,
  );
  if (description === null) return null;

  const row: TaskTypeSettingsRow = {
    id: raw.id,
    backend: raw.backend,
    role: raw.role as 'coordinator' | 'worker',
    briefKind: raw.briefKind,
  };
  if (model !== undefined && model.length > 0) row.model = model;
  if (description !== undefined && description.length > 0) row.description = description;
  return row;
}

function parseTaskTypeDrafts(raw: unknown): TaskTypeSettingsRow[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > SETTINGS_TASK_TYPE_DRAFT_MAX) return null;
  const out: TaskTypeSettingsRow[] = [];
  for (const item of raw) {
    const row = parseTaskTypeRow(item);
    if (!row) return null;
    out.push(row);
  }
  return out;
}

function parseRetentionDrafts(raw: unknown): RetentionDrafts | null {
  if (!isRecord(raw)) return null;
  const out = createEmptyRetentionDrafts();
  let sawKnown = false;
  for (const id of RETENTION_IDS) {
    if (!(id in raw)) continue;
    const value = raw[id];
    if (typeof value !== 'string' || !isFiniteIntegerLikeString(value)) return null;
    out[id] = value;
    sawKnown = true;
  }
  // Unknown keys are ignored; require at least one known key if the object was present.
  // Empty object is treated as absent (caller can omit).
  if (!sawKnown) return createEmptyRetentionDrafts();
  return out;
}

/** Default navigation envelope with no drafts. */
export function createDefaultSettingsViewState(): SettingsViewState {
  return {
    v: SETTINGS_VIEW_STATE_VERSION,
    activeTopicId: 'task-types',
  };
}

export function createEmptyRetentionDrafts(): RetentionDrafts {
  return {
    runLimit: '',
    maxRetainedTurnsPerTask: '',
    maxStoredOutputChars: '',
  };
}

export function cloneTaskTypeDrafts(rows: readonly TaskTypeSettingsRow[]): TaskTypeSettingsRow[] {
  return rows.map((row) => {
    const next: TaskTypeSettingsRow = {
      id: row.id,
      backend: row.backend,
      role: row.role,
      briefKind: row.briefKind,
    };
    if (row.model !== undefined) next.model = row.model;
    if (row.description !== undefined) next.description = row.description;
    return next;
  });
}

export function cloneRetentionDrafts(drafts: RetentionDrafts): RetentionDrafts {
  return {
    runLimit: drafts.runLimit,
    maxRetainedTurnsPerTask: drafts.maxRetainedTurnsPerTask,
    maxStoredOutputChars: drafts.maxStoredOutputChars,
  };
}

/**
 * Fail-closed parse of a raw envelope. Returns null for malformed / out-of-bounds
 * values so callers can fall back to defaults rather than partial corruption.
 */
export function parseSettingsViewState(raw: unknown): SettingsViewState | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== SETTINGS_VIEW_STATE_VERSION && raw.v !== 1) return null;
  if (!isSettingsTopicId(raw.activeTopicId)) return null;

  const state: SettingsViewState = {
    v: SETTINGS_VIEW_STATE_VERSION,
    activeTopicId: raw.activeTopicId,
  };

  if ('taskTypeDrafts' in raw) {
    const drafts = parseTaskTypeDrafts(raw.taskTypeDrafts);
    if (!drafts) return null;
    state.taskTypeDrafts = drafts;
  }

  if ('retentionDrafts' in raw) {
    const legacyDrafts = raw.v === 1 && isRecord(raw.retentionDrafts)
      ? {
          ...raw.retentionDrafts,
          runLimit: '',
          maxRetainedTurnsPerTask:
            typeof raw.retentionDrafts.maxTurnsPerTask === 'string'
              ? raw.retentionDrafts.maxTurnsPerTask
              : '',
        }
      : raw.retentionDrafts;
    const drafts = parseRetentionDrafts(legacyDrafts);
    if (!drafts) return null;
    state.retentionDrafts = drafts;
  }

  if ('permissionDraftMode' in raw) {
    if (!isPermissionModeSetting(raw.permissionDraftMode)) return null;
    state.permissionDraftMode = raw.permissionDraftMode;
  }

  return state;
}

/** Deep-clone a view state into plain JSON-safe data. */
export function serializeSettingsViewState(state: SettingsViewState): SettingsViewState {
  const out: SettingsViewState = {
    v: SETTINGS_VIEW_STATE_VERSION,
    activeTopicId: state.activeTopicId,
  };
  if (state.taskTypeDrafts) {
    out.taskTypeDrafts = cloneTaskTypeDrafts(state.taskTypeDrafts);
  }
  if (state.retentionDrafts) {
    out.retentionDrafts = cloneRetentionDrafts(state.retentionDrafts);
  }
  if (state.permissionDraftMode !== undefined) {
    out.permissionDraftMode = state.permissionDraftMode;
  }
  return out;
}

/**
 * Merge a settings view envelope into an existing webview state bag without
 * dropping unrelated keys (composer selection, send outbox, etc.).
 */
export function mergeSettingsViewState(
  prev: unknown,
  view: SettingsViewState,
): Record<string, unknown> {
  const base = isRecord(prev) ? { ...prev } : {};
  base[SETTINGS_VIEW_STATE_KEY] = serializeSettingsViewState(view);
  return base;
}

export function readSettingsViewState(api: VsCodeStateApi | undefined): SettingsViewState {
  try {
    const bag = api?.getState?.() as Record<string, unknown> | undefined;
    const raw = bag?.[SETTINGS_VIEW_STATE_KEY];
    return parseSettingsViewState(raw) ?? createDefaultSettingsViewState();
  } catch {
    return createDefaultSettingsViewState();
  }
}

export function writeSettingsViewState(
  api: VsCodeStateApi | undefined,
  view: SettingsViewState,
): void {
  try {
    const prev = api?.getState?.();
    api?.setState?.(mergeSettingsViewState(prev, view));
  } catch {
    // best-effort — hide/reveal persistence must never break the UI
  }
}

function normalizeOptionalField(value: string | undefined): string {
  return (value ?? '').trim();
}

function normalizeTaskTypeRowForCompare(row: TaskTypeSettingsRow): string {
  return JSON.stringify({
    id: row.id.trim(),
    backend: row.backend.trim(),
    model: normalizeOptionalField(row.model),
    role: row.role,
    briefKind: row.briefKind,
    description: normalizeOptionalField(row.description),
  });
}

/** True when drafts differ from the last saved Task Types snapshot rows. */
export function isTaskTypeDraftsDirty(
  drafts: readonly TaskTypeSettingsRow[] | undefined | null,
  saved: readonly TaskTypeSettingsRow[] | undefined | null,
): boolean {
  if (drafts === undefined || drafts === null) return false;
  const savedRows = saved ?? [];
  if (drafts.length !== savedRows.length) return true;
  for (let i = 0; i < drafts.length; i += 1) {
    if (
      normalizeTaskTypeRowForCompare(drafts[i]!) !==
      normalizeTaskTypeRowForCompare(savedRows[i]!)
    ) {
      return true;
    }
  }
  return false;
}

/** True when any retention draft string differs from the saved snapshot value. */
export function isRetentionDraftsDirty(
  drafts: RetentionDrafts | undefined | null,
  snapshot: RuntimeStorageSettingsSnapshot | null | undefined,
): boolean {
  if (!drafts || !snapshot) return false;
  for (const setting of snapshot.settings) {
    const draft = drafts[setting.id];
    if (draft === undefined) continue;
    if (draft.trim() !== String(setting.value)) return true;
  }
  return false;
}

/** True when the permission draft mode differs from the last saved snapshot mode. */
export function isPermissionDraftDirty(
  draft: PermissionModeSetting | undefined | null,
  snapshot: PermissionSettingsSnapshot | null | undefined,
): boolean {
  if (draft === undefined || draft === null || !snapshot) return false;
  return draft !== snapshot.mode;
}

/**
 * Apply a host retention snapshot into draft strings.
 * When `dirty` is true, preserve user edits unchanged — except a blank `runLimit`
 * left by v1 migration, which is still absent data and hydrates once from host.
 */
export function applyRetentionSnapshotToDrafts(
  current: RetentionDrafts | null | undefined,
  snapshot: RuntimeStorageSettingsSnapshot,
  dirty: boolean,
): RetentionDrafts {
  if (dirty && current) {
    const next = cloneRetentionDrafts(current);
    // Only the migration-missing runtime enum is filled; cleared number fields stay empty.
    if (next.runLimit.trim() === '') {
      const runLimit = snapshot.settings.find((s) => s.id === 'runLimit');
      if (runLimit) next.runLimit = String(runLimit.value);
    }
    return next;
  }
  const next = createEmptyRetentionDrafts();
  for (const setting of snapshot.settings) {
    next[setting.id] = String(setting.value);
  }
  return next;
}

/**
 * Apply a host task-types snapshot into draft rows.
 * When `dirty` is true, the existing drafts (including explicit empty) are preserved.
 */
export function applyTaskTypesSnapshotToDrafts(
  current: TaskTypeSettingsRow[] | null | undefined,
  saved: readonly TaskTypeSettingsRow[],
  dirty: boolean,
): TaskTypeSettingsRow[] {
  if (dirty && current !== undefined && current !== null) {
    return cloneTaskTypeDrafts(current);
  }
  return cloneTaskTypeDrafts(saved);
}

/**
 * Apply a host permission snapshot into the draft mode.
 * When `dirty` is true, the existing draft is preserved unchanged.
 */
export function applyPermissionSnapshotToDraft(
  current: PermissionModeSetting | null | undefined,
  snapshot: PermissionSettingsSnapshot,
  dirty: boolean,
): PermissionModeSetting {
  if (dirty && current !== undefined && current !== null) return current;
  return snapshot.mode;
}

/**
 * Reduce a host settingsUpdateResult into Retention-local UI state.
 * Drafts are never rehydrated to saved on failure; only confirmed success updates one field.
 * Task Types state is intentionally not part of this reducer.
 */
export function reduceRetentionUpdateResult(
  prev: {
    drafts: RetentionDrafts;
    fieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
    localFieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
  },
  result: SettingsUpdateResult,
): RetentionUpdateUiState {
  const drafts = cloneRetentionDrafts(prev.drafts);
  const fieldErrors = { ...prev.fieldErrors };
  const localFieldErrors = { ...prev.localFieldErrors };

  if (result.ok) {
    drafts[result.settingId] = String(result.value);
    fieldErrors[result.settingId] = undefined;
    localFieldErrors[result.settingId] = undefined;
    return {
      drafts,
      fieldErrors,
      localFieldErrors,
      error: null,
      savedMessage: `Saved ${RETENTION_SETTING_LABELS[result.settingId]}.`,
      confirmed: { settingId: result.settingId, value: result.value },
    };
  }

  if ('settingId' in result) {
    if (result.code === 'updateFailed') {
      return {
        drafts,
        fieldErrors,
        localFieldErrors,
        error: `Unable to save ${RETENTION_SETTING_LABELS[result.settingId]}. Check the VS Code setting and try again.`,
        savedMessage: null,
      };
    }
    return {
      drafts,
      fieldErrors: { ...fieldErrors, [result.settingId]: result.message },
      localFieldErrors,
      error: null,
      savedMessage: null,
    };
  }

  return {
    drafts,
    fieldErrors,
    localFieldErrors,
    error: 'Unable to load or save settings. Check the VS Code setting and try again.',
    savedMessage: null,
  };
}

/** Field-level Retention draft validation (empty / non-numeric / non-finite / non-integer / below min). */
export function retentionDraftValidationMessage(
  settingId: RuntimeStorageSettingId,
  raw: string,
  minimum: number,
  label: string,
): string | null {
  const trimmed = raw.trim();
  if (settingId === 'runLimit') {
    return ['15m', '30m', '1h', '2h', '4h', '8h'].includes(trimmed)
      ? null
      : `${label} must be a supported duration.`;
  }
  const value = Number(trimmed);
  if (!trimmed || !Number.isFinite(value)) return `${label} must be a number.`;
  if (!Number.isInteger(value)) return `${label} must be an integer.`;
  if (value < minimum) return `${label} must be at least ${minimum}.`;
  return null;
}

/** Topic-local Retention tab badge priority: saving > error > dirty > saved. */
export function retentionTabIndicator(input: {
  saving: boolean;
  error: string | null;
  fieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
  localFieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
  dirty: boolean;
  savedMessage: string | null;
}): SettingsTabIndicator | null {
  if (input.saving) return { kind: 'saving', label: 'Saving' };
  const hasFieldError =
    Object.values(input.fieldErrors).some((v) => Boolean(v)) ||
    Object.values(input.localFieldErrors).some((v) => Boolean(v));
  if (input.error || hasFieldError) return { kind: 'error', label: 'Error' };
  if (input.dirty) return { kind: 'dirty', label: 'Unsaved' };
  if (input.savedMessage) return { kind: 'saved', label: 'Saved' };
  return null;
}

/**
 * Reduce a host permissionSettingsUpdateResult into Permissions-local UI state.
 * Draft mode is never rehydrated to saved on failure; only confirmed success updates mode.
 * Task Types / Retention state is intentionally not part of this reducer.
 */
export function reducePermissionSettingsUpdateResult(
  prev: { draftMode: PermissionModeSetting },
  result: PermissionSettingsUpdateResult,
): PermissionUpdateUiState {
  if (result.ok) {
    return {
      draftMode: result.mode,
      error: null,
      savedMessage: 'Saved permission mode.',
      confirmed: { mode: result.mode },
    };
  }

  return {
    draftMode: prev.draftMode,
    error: 'Unable to save permission mode. Check the VS Code setting and try again.',
    savedMessage: null,
  };
}

/** Topic-local Permissions tab badge priority: saving > error > dirty > saved. */
export function permissionTabIndicator(input: {
  saving: boolean;
  error: string | null;
  dirty: boolean;
  savedMessage: string | null;
}): SettingsTabIndicator | null {
  if (input.saving) return { kind: 'saving', label: 'Saving' };
  if (input.error) return { kind: 'error', label: 'Error' };
  if (input.dirty) return { kind: 'dirty', label: 'Unsaved' };
  if (input.savedMessage) return { kind: 'saved', label: 'Saved' };
  return null;
}
