/**
 * Pure webview helper for Composer draft backend eligibility + Test Connection
 * surface (M019 S01/S02).
 *
 * Vitest cannot safely import Svelte rune stores, so all picker eligibility,
 * stale-preference resolution, and probe correlation lives here and delegates
 * state semantics to the shared BackendReadiness / BackendProbe selectors.
 */
import {
  BACKEND_READINESS_IDS,
  derivePassivelySelectableBackendIds,
  selectPickerBackends,
  type BackendReadinessCode,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
  type BackendRecoveryAction,
} from '../../../src/shared/backend-readiness';
import {
  isProbeEligible,
  type BackendProbeProgress,
  type BackendProbeStage,
} from '../../../src/shared/backend-probe';
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

/** Correlated in-flight Test Connection owned by the webview (display only). */
export interface ActiveBackendProbe {
  backendId: BackendReadinessId;
  probeId: string;
  stage: BackendProbeStage | null;
  startedAt: string | null;
}

export type ProbeSurfaceKind =
  | 'hidden'
  | 'idle'
  | 'testing'
  | 'ready'
  | 'diagnostic';

export interface ProbeSurface {
  kind: ProbeSurfaceKind;
  /** Whether the user may start (or re-start) a Test Connection. */
  canStart: boolean;
  /** Whether cancel is available for the correlated in-flight probe. */
  canCancel: boolean;
  /** Bounded status/diagnostic text (never paths, stderr, secrets). */
  statusText: string;
  /** Allowlisted recovery action label, or empty. */
  recoveryLabel: string;
  /** Current stage label when testing, else empty. */
  stageLabel: string;
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

/** Honest option label for a passively selectable record (S01/S02). */
export function pickerOptionLabelForRecord(record: BackendReadinessRecord): string {
  if (record.state === 'installed_unverified') {
    return formatInstalledUnverifiedLabel(record);
  }
  if (record.state === 'ready') {
    return backendLabel(record.backendId);
  }
  if (record.state === 'testing') {
    return `${backendLabel(record.backendId)} (testing…)`;
  }
  if (record.state === 'auth_required') {
    return `${backendLabel(record.backendId)} (sign in required)`;
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

/** Whether the webview may post startBackendProbe for this record. */
export function canStartBackendProbe(
  record: BackendReadinessRecord | null | undefined,
): boolean {
  if (!record) return false;
  return isProbeEligible(record);
}

/** Bounded human label for a probe stage (never raw host strings). */
export function probeStageLabel(stage: BackendProbeStage | null | undefined): string {
  switch (stage) {
    case 'executable':
      return 'Checking executable';
    case 'version':
      return 'Checking version';
    case 'initialize':
      return 'Initializing connection';
    case 'authenticate':
      return 'Checking authentication';
    case 'session':
      return 'Opening probe session';
    case 'model_catalog':
      return 'Checking model catalog';
    default:
      return '';
  }
}

/** Bounded recovery action label for UI buttons/status. */
export function probeRecoveryLabel(action: BackendRecoveryAction | null | undefined): string {
  switch (action) {
    case 'install':
      return 'Install CLI';
    case 'login':
      return 'Sign in required';
    case 'update':
      return 'Update CLI';
    case 'retry':
      return 'Retry Test Connection';
    case 'open_docs':
      return 'Open docs';
    case 'none':
    default:
      return '';
  }
}

function codeGuidance(code: BackendReadinessCode, label: string): string {
  switch (code) {
    case 'executable_missing':
      return `${label} is not installed. Install the CLI, then refresh.`;
    case 'version_unknown':
      return `${label} is installed but not yet verified. Run Test Connection.`;
    case 'version_incompatible':
      return `${label} version is incompatible. Update the CLI, then retry.`;
    case 'auth_required':
      return `${label} needs you to sign in with its CLI, then retry Test Connection.`;
    case 'acp_initialize_failed':
      return `${label} failed to initialize its agent connection. Retry Test Connection.`;
    case 'session_probe_failed':
      return `${label} could not open a probe session. Retry Test Connection.`;
    case 'model_catalog_unavailable':
      return `${label} connected but its model catalog is unavailable. Retry Test Connection.`;
    case 'timeout':
      return `${label} timed out during Test Connection. Retry when the CLI is responsive.`;
    case 'process_exited':
      return `${label} process exited during Test Connection. Retry after checking the CLI.`;
    case 'cancelled':
      return `${label} Test Connection was cancelled.`;
    case 'internal_error':
      return `${label} reported an internal error during Test Connection. Retry.`;
    case 'none':
    default:
      return '';
  }
}

/**
 * Bounded diagnostic guidance for a readiness record.
 * Never includes paths, stderr, env values, or raw host error text.
 */
export function readinessDiagnosticGuidance(
  record: BackendReadinessRecord | null | undefined,
): string {
  if (!record) return '';
  const label = backendLabel(record.backendId);
  if (record.state === 'ready') {
    const version =
      typeof record.versionEvidence === 'string' && record.versionEvidence.length > 0
        ? ` (${record.versionEvidence})`
        : '';
    return `${label} is ready${version}.`;
  }
  if (record.state === 'testing') {
    return `Testing ${label}…`;
  }
  if (record.state === 'installed_unverified') {
    return codeGuidance('version_unknown', label);
  }
  const fromCode = codeGuidance(record.code, label);
  if (fromCode) return fromCode;
  if (record.state === 'auth_required') {
    return codeGuidance('auth_required', label);
  }
  if (record.state === 'incompatible') {
    return codeGuidance('version_incompatible', label);
  }
  if (record.state === 'failed') {
    return `${label} failed Test Connection. Retry after checking the CLI.`;
  }
  if (record.state === 'missing') {
    return codeGuidance('executable_missing', label);
  }
  return '';
}

export function createActiveBackendProbe(
  backendId: BackendReadinessId,
  probeId: string,
): ActiveBackendProbe {
  return {
    backendId,
    probeId,
    stage: null,
    startedAt: null,
  };
}

/**
 * Apply correlated host progress onto the active probe.
 * Drops stale/unsolicited progress (wrong probeId or backend) fail-closed.
 */
export function applyProbeProgressToActive(
  active: ActiveBackendProbe | null,
  progress: BackendProbeProgress,
): ActiveBackendProbe | null {
  if (!active) return null;
  if (active.probeId !== progress.probeId) return active;
  if (active.backendId !== progress.backendId) return active;
  return {
    backendId: active.backendId,
    probeId: active.probeId,
    stage: progress.stage,
    startedAt: progress.startedAt,
  };
}

/**
 * Clear the active probe once the host snapshot leaves `testing` for that
 * backend (terminal ready / auth / failed / cancelled→installed_unverified).
 * Unrelated backend settlements leave the active probe untouched.
 */
export function clearActiveProbeIfSettled(
  active: ActiveBackendProbe | null,
  snapshot: BackendReadinessSnapshot | null | undefined,
): ActiveBackendProbe | null {
  if (!active) return null;
  if (!snapshot) return active;
  const record = snapshot.backends.find((r) => r.backendId === active.backendId);
  if (!record) return null;
  if (record.state === 'testing') return active;
  return null;
}

/**
 * Resolve the draft Composer Test Connection surface for one backend.
 * Pure: never posts messages; never invents readiness truth.
 */
export function resolveProbeSurface(input: {
  record: BackendReadinessRecord | null | undefined;
  activeProbe: ActiveBackendProbe | null;
  backendId: BackendReadinessId | string | null | undefined;
}): ProbeSurface {
  const hidden: ProbeSurface = {
    kind: 'hidden',
    canStart: false,
    canCancel: false,
    statusText: '',
    recoveryLabel: '',
    stageLabel: '',
  };
  const record = input.record;
  if (!record) return hidden;

  const backendId =
    typeof input.backendId === 'string' && input.backendId.length > 0
      ? input.backendId
      : record.backendId;
  if (record.backendId !== backendId) return hidden;

  const activeForBackend =
    input.activeProbe && input.activeProbe.backendId === record.backendId
      ? input.activeProbe
      : null;

  const recoveryLabel = probeRecoveryLabel(record.recoveryAction);
  const stageLabel = probeStageLabel(activeForBackend?.stage ?? null);

  // Host testing state wins for progress/cancel even if local active is missing
  // (e.g. joined single-flight from another start).
  if (record.state === 'testing' || activeForBackend) {
    const stagePart = stageLabel || 'Test Connection in progress';
    return {
      kind: 'testing',
      canStart: false,
      canCancel: activeForBackend != null,
      statusText: `${backendLabel(record.backendId)}: ${stagePart}…`,
      recoveryLabel: '',
      stageLabel,
    };
  }

  if (record.state === 'ready') {
    return {
      kind: 'ready',
      canStart: canStartBackendProbe(record),
      canCancel: false,
      statusText: readinessDiagnosticGuidance(record),
      recoveryLabel: '',
      stageLabel: '',
    };
  }

  if (
    record.state === 'auth_required' ||
    record.state === 'failed' ||
    record.state === 'incompatible'
  ) {
    return {
      kind: 'diagnostic',
      canStart: canStartBackendProbe(record),
      canCancel: false,
      statusText: readinessDiagnosticGuidance(record),
      recoveryLabel,
      stageLabel: '',
    };
  }

  if (record.state === 'installed_unverified') {
    return {
      kind: 'idle',
      canStart: canStartBackendProbe(record),
      canCancel: false,
      statusText: readinessDiagnosticGuidance(record),
      recoveryLabel: '',
      stageLabel: '',
    };
  }

  // missing / checking — not a Test Connection surface (setup guidance owns this).
  return hidden;
}
