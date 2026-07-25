/**
 * Pure webview helper for Composer draft backend eligibility (M019 S01).
 *
 * Vitest cannot safely import Svelte rune stores, so all picker eligibility and
 * stale-preference resolution lives here and delegates state semantics to the
 * shared BackendReadiness selectors.
 */
import {
  BACKEND_READINESS_IDS,
  derivePassivelySelectableBackendIds,
  selectPickerBackends,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
} from '../../../src/shared/backend-readiness';
import { BACKENDS } from './backends';
import type { WebviewBackendId } from './backend-resolve';

export type DraftComposerEligibilityKind = 'loading' | 'empty' | 'ready';

export interface DraftComposerEligibility {
  kind: DraftComposerEligibilityKind;
  /** Passively selectable backend ids (empty when loading/empty). */
  pickerBackendIds: BackendReadinessId[];
  /**
   * Backend shown in the draft picker. When the durable preference is not
   * passively selectable, this is the first passive target without overwriting
   * the preference. Null when loading or settled-empty.
   */
  displayBackend: BackendReadinessId | null;
  /**
   * Model shown with displayBackend. Cleared when falling back away from the
   * durable preference so a stale model is never submitted.
   */
  displayModel: string | null;
  /** True when preferredBackend is set but not among passively selectable ids. */
  preferenceStale: boolean;
  /** New-task draft may accept input/send only when a passive target exists. */
  canComposeNewTask: boolean;
  /** Bounded setup guidance for loading/empty/stale states (never secrets/paths). */
  setupGuidance: string;
  /** Ordered backend records from a settled snapshot (empty when loading). */
  records: BackendReadinessRecord[];
}

export interface DraftComposerEligibilityInput {
  snapshot: BackendReadinessSnapshot | null | undefined;
  preferredBackend: WebviewBackendId | string | null | undefined;
  preferredModel?: string | null;
  /**
   * Transitional host-derived list (backendsAvailable). Used only when snapshot
   * is absent so existing e2e/host paths that post the string list still settle.
   * Prefer BackendReadinessSnapshot when present.
   */
  availableBackends?: string[] | null;
}

function backendLabel(id: string): string {
  return BACKENDS.find((b) => b.id === id)?.label ?? id;
}

function formatInstalledUnverifiedLabel(record: BackendReadinessRecord): string {
  const base = backendLabel(record.backendId);
  const version =
    typeof record.versionEvidence === 'string' && record.versionEvidence.length > 0
      ? ` ${record.versionEvidence}`
      : '';
  return `${base} (installed, unverified${version})`;
}

/** Honest option label for a passively selectable record (S01). */
export function pickerOptionLabelForRecord(record: BackendReadinessRecord): string {
  if (record.state === 'installed_unverified') {
    return formatInstalledUnverifiedLabel(record);
  }
  if (record.state === 'ready') {
    return backendLabel(record.backendId);
  }
  return `${backendLabel(record.backendId)} (${record.state.replace(/_/g, ' ')})`;
}

function buildEmptyGuidance(records: BackendReadinessRecord[]): string {
  const missing = records.filter((r) => r.state === 'missing').map((r) => backendLabel(r.backendId));
  const incompatible = records
    .filter((r) => r.state === 'incompatible' || r.compatibility === 'incompatible')
    .map((r) => backendLabel(r.backendId));
  const parts: string[] = [];
  if (missing.length === records.length && records.length > 0) {
    parts.push(
      'No supported agent CLIs detected. Install Claude, Grok, Kiro, Codex, or OpenCode, then refresh.',
    );
  } else {
    if (missing.length > 0) {
      parts.push(`Missing: ${missing.join(', ')}.`);
    }
    if (incompatible.length > 0) {
      parts.push(`Incompatible: ${incompatible.join(', ')}.`);
    }
    if (parts.length === 0) {
      parts.push('No passively selectable backends. Install or update a supported CLI, then refresh.');
    } else {
      parts.push('Install or update a supported CLI, then refresh.');
    }
  }
  return parts.join(' ');
}

/**
 * Resolve draft Composer eligibility from a host-owned readiness snapshot and
 * the durable preferred backend/model. Never mutates preference; never treats
 * missing/incompatible as selectable.
 */
export function resolveDraftComposerEligibility(
  input: DraftComposerEligibilityInput,
): DraftComposerEligibility {
  const preferred =
    typeof input.preferredBackend === 'string' && input.preferredBackend.length > 0
      ? input.preferredBackend
      : null;
  const preferredModel =
    typeof input.preferredModel === 'string' && input.preferredModel.length > 0
      ? input.preferredModel
      : null;

  let selection = selectPickerBackends(input.snapshot);
  let records: BackendReadinessRecord[] = input.snapshot?.backends
    ? [...input.snapshot.backends]
    : [];

  // Transitional fallback: backendsAvailable string list without a snapshot.
  if (
    selection.kind === 'unknown' &&
    input.availableBackends !== undefined &&
    input.availableBackends !== null
  ) {
    const ids = input.availableBackends.filter((id): id is BackendReadinessId =>
      (BACKEND_READINESS_IDS as readonly string[]).includes(id),
    );
    const ordered = BACKEND_READINESS_IDS.filter((id) => ids.includes(id));
    selection =
      ordered.length === 0 ? { kind: 'empty' } : { kind: 'ready', backends: ordered };
    records = [];
  }

  if (selection.kind === 'unknown') {
    return {
      kind: 'loading',
      pickerBackendIds: [],
      displayBackend: null,
      displayModel: null,
      preferenceStale: false,
      canComposeNewTask: false,
      setupGuidance: 'Checking installed agent CLIs…',
      records: input.snapshot?.phase === 'checking' ? [...(input.snapshot.backends ?? [])] : [],
    };
  }

  if (selection.kind === 'empty') {
    return {
      kind: 'empty',
      pickerBackendIds: [],
      displayBackend: null,
      displayModel: null,
      preferenceStale: preferred != null,
      canComposeNewTask: false,
      setupGuidance: buildEmptyGuidance(records),
      records,
    };
  }

  const pickerBackendIds = selection.backends;
  const preferenceStale =
    preferred == null || !pickerBackendIds.includes(preferred as BackendReadinessId);
  const displayBackend = preferenceStale
    ? pickerBackendIds[0]
    : (preferred as BackendReadinessId);
  const displayModel = preferenceStale ? null : preferredModel;

  let setupGuidance = '';
  if (preferenceStale && preferred) {
    setupGuidance = `Saved preference ${backendLabel(preferred)} is not available. Showing ${backendLabel(displayBackend)} without changing your preference.`;
  }

  return {
    kind: 'ready',
    pickerBackendIds,
    displayBackend,
    displayModel,
    preferenceStale,
    canComposeNewTask: true,
    setupGuidance,
    records,
  };
}

/** Convenience: passively selectable ids from a snapshot (or empty). */
export function passivelySelectableBackendIds(
  snapshot: BackendReadinessSnapshot | null | undefined,
): BackendReadinessId[] {
  return derivePassivelySelectableBackendIds(snapshot);
}
