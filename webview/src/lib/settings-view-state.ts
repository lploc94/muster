/**
 * Versioned Settings view-state envelope for webview hide/reveal.
 *
 * Persists only the active domain and non-sensitive Task profiles / runtime &
 * storage / permission drafts through vscode.getState / setState. Not a generic
 * topic registry — host save contracts remain explicit per config surface.
 * Errors and raw host failure payloads are never stored in the envelope.
 *
 * Only the current envelope and rendered domain ids are accepted. Development
 * builds intentionally discard stale webview state instead of migrating it.
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
export const SETTINGS_VIEW_STATE_KEY = 'muster.settingsView.v3';

/** Exact envelope version; stale versions are rejected. */
export const SETTINGS_VIEW_STATE_VERSION = 3 as const;

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

export type SettingsTabIndicator = {
  kind: 'saving' | 'error' | 'dirty' | 'diagnostic' | 'saved';
  label: string;
};

export interface RetentionUpdateUiState {
  drafts: RetentionDrafts;
  fieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
  localFieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
  error: string | null;
  savedMessage: string | null;
  /**
   * settingId that owns `error` / `savedMessage`, used to route banner feedback to
   * the domain that hosts that field (runLimit → Execution; retention numbers →
   * Data). Null when a failure carries no attributable owner (Settings-level).
   */
  feedbackOwner: RuntimeStorageSettingId | null;
  /** Present only on successful host write — App applies this to the saved snapshot. */
  confirmed?: { settingId: RuntimeStorageSettingId; value: number | RunLimitSetting };
}

export interface SettingsViewState {
  v: typeof SETTINGS_VIEW_STATE_VERSION;
  activeTopicId: SettingsTopicId;
  /** Present when the user has an in-progress Task profiles draft (including empty). */
  taskTypeDrafts?: TaskTypeSettingsRow[];
  /** Present when the user has in-progress Retention field drafts. */
  retentionDrafts?: RetentionDrafts;
  /**
   * Exact runtime/storage fields that were dirty when the v3 envelope was
   * written. The full draft record stays unchanged; this metadata lets the
   * first host snapshot after hide/reveal hydrate pristine fields independently.
   */
  retentionDirtySettingIds?: RuntimeStorageSettingId[];
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
    activeTopicId: 'agents',
  };
}

function parseRuntimeStorageSettingIds(raw: unknown): RuntimeStorageSettingId[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RuntimeStorageSettingId[] = [];
  const seen = new Set<RuntimeStorageSettingId>();
  for (const value of raw) {
    if (typeof value !== 'string' || !RETENTION_IDS.includes(value as RuntimeStorageSettingId)) {
      return null;
    }
    const id = value as RuntimeStorageSettingId;
    if (seen.has(id)) return null;
    seen.add(id);
    out.push(id);
  }
  return out;
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
  if (raw.v !== SETTINGS_VIEW_STATE_VERSION || !isSettingsTopicId(raw.activeTopicId)) return null;
  const activeTopicId = raw.activeTopicId;

  const state: SettingsViewState = {
    v: SETTINGS_VIEW_STATE_VERSION,
    activeTopicId,
  };

  if ('taskTypeDrafts' in raw) {
    const drafts = parseTaskTypeDrafts(raw.taskTypeDrafts);
    if (!drafts) return null;
    state.taskTypeDrafts = drafts;
  }

  if ('retentionDrafts' in raw) {
    const drafts = parseRetentionDrafts(raw.retentionDrafts);
    if (!drafts) return null;
    state.retentionDrafts = drafts;
  }

  if ('retentionDirtySettingIds' in raw) {
    if (!state.retentionDrafts) return null;
    const ids = parseRuntimeStorageSettingIds(raw.retentionDirtySettingIds);
    if (!ids) return null;
    state.retentionDirtySettingIds = ids;
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
  if (state.retentionDirtySettingIds) {
    out.retentionDirtySettingIds = [...state.retentionDirtySettingIds];
  }
  if (state.permissionDraftMode !== undefined) {
    out.permissionDraftMode = state.permissionDraftMode;
  }
  return out;
}

/**
 * Merge a settings view envelope into an existing webview state bag without
 * dropping unrelated ephemeral UI chrome. Composer selection lives in VS Code
 * Settings and durable user data (including send drafts) lives in SQLite.
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

/**
 * Runtime & Storage config keys grouped by rendered domain. The single host
 * snapshot is split visually: the run-limit enum lives under Execution, while
 * the history/output number fields live under Data.
 */
export const EXECUTION_RUNTIME_STORAGE_IDS: readonly RuntimeStorageSettingId[] = [
  'runLimit',
] as const;
export const DATA_RUNTIME_STORAGE_IDS: readonly RuntimeStorageSettingId[] = [
  'maxRetainedTurnsPerTask',
  'maxStoredOutputChars',
] as const;

/**
 * True when any draft in `ids` differs from the saved snapshot value. Subset
 * variant of {@link isRetentionDraftsDirty} so a dirty Data field never marks
 * the Execution run-limit dirty (and vice versa).
 */
export function isRuntimeStorageDraftDirtyFor(
  ids: readonly RuntimeStorageSettingId[],
  drafts: RetentionDrafts | undefined | null,
  snapshot: RuntimeStorageSettingsSnapshot | null | undefined,
): boolean {
  if (!drafts || !snapshot) return false;
  const wanted = new Set(ids);
  for (const setting of snapshot.settings) {
    if (!wanted.has(setting.id)) continue;
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
 * Apply a host snapshot into draft strings field-by-field.
 *
 * The Runtime & Storage snapshot backs two rendered domains (Execution's run
 * limit and Data's history/output numbers). Hydration must therefore decide per
 * field: a field the user has edited (dirty) is preserved, while a pristine
 * field always takes the incoming saved value. This means a dirty Data field can
 * never block a pristine Execution run-limit from refreshing, and vice versa.
 *
 * "Dirty" is measured against `prevSnapshot` (the last saved snapshot the drafts
 * were hydrated from) — a field whose draft still matches the previously saved
 * value is pristine and refreshes; a field the user changed away from it is
 * preserved. On the first snapshot after restore, dirty-field metadata makes
 * the same decision without a prior in-memory snapshot.
 */
export function applyRuntimeStorageSnapshotToDrafts(
  current: RetentionDrafts | null | undefined,
  snapshot: RuntimeStorageSettingsSnapshot,
  prevSnapshot?: RuntimeStorageSettingsSnapshot | null,
  restoredDirtySettingIds?: readonly RuntimeStorageSettingId[],
): RetentionDrafts {
  // No drafts at all → hydrate fully from host.
  if (!current) {
    const fresh = createEmptyRetentionDrafts();
    for (const setting of snapshot.settings) fresh[setting.id] = String(setting.value);
    return fresh;
  }

  const next = cloneRetentionDrafts(current);
  const prevById = new Map<RuntimeStorageSettingId, string>();
  for (const setting of prevSnapshot?.settings ?? []) {
    prevById.set(setting.id, String(setting.value));
  }

  for (const setting of snapshot.settings) {
    const incoming = String(setting.value);
    const draft = current[setting.id];

    let fieldDirty: boolean;
    if (!prevSnapshot) {
      fieldDirty = restoredDirtySettingIds?.includes(setting.id) ?? false;
    } else {
      // Incidental refresh: a field is pristine when its draft still equals the
      // value it was last hydrated from (prevSnapshot). Pristine fields take the
      // incoming value; edited fields are preserved.
      const prevValue = prevById.get(setting.id);
      fieldDirty = draft !== undefined && draft.trim() !== (prevValue ?? '');
    }

    if (!fieldDirty) {
      next[setting.id] = incoming;
      continue;
    }
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
 * Reduce a host settingsUpdateResult into owner-aware Runtime & Storage UI state.
 * Drafts are never rehydrated to saved on failure; only confirmed success updates one field.
 * Task profiles state is intentionally not part of this reducer.
 */
export function reduceRetentionUpdateResult(
  prev: {
    drafts: RetentionDrafts;
    fieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
    localFieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
  },
  result: SettingsUpdateResult,
  pendingSettingId: RuntimeStorageSettingId | null = null,
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
      feedbackOwner: result.settingId,
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
        feedbackOwner: result.settingId,
      };
    }
    return {
      drafts,
      fieldErrors: { ...fieldErrors, [result.settingId]: result.message },
      localFieldErrors,
      error: null,
      savedMessage: null,
      feedbackOwner: result.settingId,
    };
  }

  // unknownSetting omits settingId by protocol. Attribute it to the pending save
  // when available; unsolicited/unmatched failures remain Settings-level.
  return {
    drafts,
    fieldErrors,
    localFieldErrors,
    error: 'Unable to load or save settings. Check the VS Code setting and try again.',
    savedMessage: null,
    feedbackOwner: pendingSettingId,
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

/**
 * Runtime & Storage tab indicator scoped to a subset of setting ids.
 *
 * Only field-errors, dirty state, saving, and saved feedback attributable to a
 * setting in `ids` count — so the Execution run-limit and the Data history/output
 * fields produce independent indicators from the one shared host snapshot. The
 * shared `error` / `savedMessage` banners belong to a single `feedbackOwner`
 * setting and only count for the subset that owns them.
 */
export function runtimeStorageTabIndicatorFor(
  ids: readonly RuntimeStorageSettingId[],
  input: {
    savingSettingId: RuntimeStorageSettingId | null;
    error: string | null;
    feedbackOwner: RuntimeStorageSettingId | null;
    fieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
    localFieldErrors: Partial<Record<RuntimeStorageSettingId, string>>;
    dirty: boolean;
    savedMessage: string | null;
  },
): SettingsTabIndicator | null {
  const wanted = new Set(ids);
  const ownedByThisSubset = input.feedbackOwner !== null && wanted.has(input.feedbackOwner);

  if (input.savingSettingId !== null && wanted.has(input.savingSettingId)) {
    return { kind: 'saving', label: 'Saving' };
  }
  const hasFieldError = ids.some(
    (id) => Boolean(input.fieldErrors[id]) || Boolean(input.localFieldErrors[id]),
  );
  if ((input.error && ownedByThisSubset) || hasFieldError) {
    return { kind: 'error', label: 'Error' };
  }
  if (input.dirty) return { kind: 'dirty', label: 'Unsaved' };
  if (input.savedMessage && ownedByThisSubset) return { kind: 'saved', label: 'Saved' };
  return null;
}

/**
 * Merge several tab indicators into one, respecting a fixed severity order:
 * saving > error > dirty > needs-attention (diagnostic) > saved. Used to fold a
 * domain that renders multiple config surfaces (e.g. Execution = run limit +
 * permission mode) into a single tab badge. Null inputs are ignored.
 */
export function mergeSettingsIndicators(
  ...indicators: (SettingsTabIndicator | null | undefined)[]
): SettingsTabIndicator | null {
  const order = ['saving', 'error', 'dirty', 'diagnostic', 'saved'];
  let best: SettingsTabIndicator | null = null;
  let bestRank = order.length;
  for (const indicator of indicators) {
    if (!indicator) continue;
    const rank = order.indexOf(indicator.kind);
    const effectiveRank = rank < 0 ? order.length - 1 : rank;
    if (effectiveRank < bestRank) {
      best = indicator;
      bestRank = effectiveRank;
    }
  }
  return best;
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
