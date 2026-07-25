/**
 * Shared BackendReadiness contract (M019).
 *
 * Pure value module — no Node/VS Code/webview I/O. Safe for host and webview
 * value imports (same pattern as file-mention-icons).
 *
 * D058: passivelySelectable allows detected installed_unverified or later
 * ready-path states that are not known-incompatible; trustworthyFirstRunEligible
 * is true only for ready (and not known-incompatible).
 */

/** Snapshot schema version. Bump only on breaking shape changes. */
export const BACKEND_READINESS_SCHEMA_VERSION = 1 as const;

/** Allowlisted backend IDs in canonical display/inventory order. */
export const BACKEND_READINESS_IDS = [
  'claude',
  'grok',
  'kiro',
  'codex',
  'opencode',
] as const;

export type BackendReadinessId = (typeof BACKEND_READINESS_IDS)[number];

/**
 * Closed readiness state taxonomy for the full milestone.
 * S01 only produces checking / missing / installed_unverified / incompatible / failed;
 * ready / testing / auth_required are reserved for S02+ active probe.
 */
export const BACKEND_READINESS_STATES = [
  'checking',
  'missing',
  'installed_unverified',
  'testing',
  'ready',
  'auth_required',
  'incompatible',
  'failed',
] as const;

export type BackendReadinessState = (typeof BACKEND_READINESS_STATES)[number];

/** Stable diagnostic codes (sanitized; no raw stderr/paths/secrets). */
export const BACKEND_READINESS_CODES = [
  'none',
  'executable_missing',
  'version_unknown',
  'version_incompatible',
  'auth_required',
  'acp_initialize_failed',
  'session_probe_failed',
  'model_catalog_unavailable',
  'timeout',
  'process_exited',
  'cancelled',
  'internal_error',
] as const;

export type BackendReadinessCode = (typeof BACKEND_READINESS_CODES)[number];

/** Allowlisted recovery actions for UI guidance. */
export const BACKEND_RECOVERY_ACTIONS = [
  'none',
  'install',
  'login',
  'update',
  'retry',
  'open_docs',
] as const;

export type BackendRecoveryAction = (typeof BACKEND_RECOVERY_ACTIONS)[number];

/** Host-owned compatibility classification. */
export const BACKEND_COMPATIBILITY_STATUSES = [
  'compatible',
  'incompatible',
  'unknown',
] as const;

export type BackendCompatibilityStatus = (typeof BACKEND_COMPATIBILITY_STATUSES)[number];

/** Snapshot discovery phase. */
export const BACKEND_READINESS_PHASES = ['checking', 'settled'] as const;
export type BackendReadinessPhase = (typeof BACKEND_READINESS_PHASES)[number];

/** Bounded field limits (parser rejects, never truncates). */
export const BACKEND_READINESS_CORRELATION_ID_MAX = 128;
export const BACKEND_READINESS_VERSION_EVIDENCE_MAX = 64;

export interface BackendReadinessRecord {
  backendId: BackendReadinessId;
  state: BackendReadinessState;
  code: BackendReadinessCode;
  recoveryAction: BackendRecoveryAction;
  compatibility: BackendCompatibilityStatus;
  /** Bounded display version evidence only; never absolute paths or raw stdout. */
  versionEvidence: string | null;
  /** ISO-8601 timestamp for this record's evidence. */
  checkedAt: string;
}

export interface BackendReadinessSnapshot {
  schemaVersion: typeof BACKEND_READINESS_SCHEMA_VERSION;
  /** Correlates refresh requests with their results. */
  correlationId: string;
  phase: BackendReadinessPhase;
  /** ISO-8601 timestamp for the snapshot settlement/check. */
  checkedAt: string;
  /**
   * Exactly one record per BACKEND_READINESS_IDS entry, in that order.
   * Parser rejects missing, extra, duplicate, or out-of-order records.
   */
  backends: BackendReadinessRecord[];
}

/** Tri-state Composer picker result (loading vs settled-empty vs ready). */
export type PickerBackendSelection =
  | { kind: 'unknown' }
  | { kind: 'empty' }
  | { kind: 'ready'; backends: BackendReadinessId[] };

const BACKEND_ID_SET = new Set<string>(BACKEND_READINESS_IDS);
const STATE_SET = new Set<string>(BACKEND_READINESS_STATES);
const CODE_SET = new Set<string>(BACKEND_READINESS_CODES);
const ACTION_SET = new Set<string>(BACKEND_RECOVERY_ACTIONS);
const COMPAT_SET = new Set<string>(BACKEND_COMPATIBILITY_STATUSES);
const PHASE_SET = new Set<string>(BACKEND_READINESS_PHASES);

const SNAPSHOT_KEYS = new Set([
  'schemaVersion',
  'correlationId',
  'phase',
  'checkedAt',
  'backends',
]);

const RECORD_KEYS = new Set([
  'backendId',
  'state',
  'code',
  'recoveryAction',
  'compatibility',
  'versionEvidence',
  'checkedAt',
]);

/** Detected / ready-path states that may be passively selectable when not known-incompatible. */
const PASSIVELY_SELECTABLE_STATES = new Set<BackendReadinessState>([
  'installed_unverified',
  'testing',
  'ready',
  'auth_required',
]);

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isBackendReadinessId(value: unknown): value is BackendReadinessId {
  return typeof value === 'string' && BACKEND_ID_SET.has(value);
}

/**
 * D058: passively selectable when the backend is detected at installed_unverified
 * or a later ready-path state, and is not known incompatible.
 */
export function isPassivelySelectable(record: BackendReadinessRecord): boolean {
  if (record.compatibility === 'incompatible') return false;
  return PASSIVELY_SELECTABLE_STATES.has(record.state);
}

/**
 * D058: trustworthy first-run eligibility requires ready (and not known-incompatible).
 * S01 does not produce ready; S03 enforces this after S02 probes.
 */
export function isTrustworthyFirstRunEligible(record: BackendReadinessRecord): boolean {
  if (record.compatibility === 'incompatible') return false;
  return record.state === 'ready';
}

/** Tri-state picker selector: preserves unknown/checking vs settled-empty vs ready. */
export function selectPickerBackends(
  snapshot: BackendReadinessSnapshot | null | undefined,
): PickerBackendSelection {
  if (!snapshot || snapshot.phase === 'checking') {
    return { kind: 'unknown' };
  }
  const backends = snapshot.backends
    .filter(isPassivelySelectable)
    .map((r) => r.backendId);
  if (backends.length === 0) return { kind: 'empty' };
  return { kind: 'ready', backends };
}

/**
 * Derived passively-selectable backend ID list for HostEnvironmentSnapshot.availableBackends.
 * Empty when snapshot is null/checking or no provider is passively selectable.
 */
export function derivePassivelySelectableBackendIds(
  snapshot: BackendReadinessSnapshot | null | undefined,
): BackendReadinessId[] {
  const selection = selectPickerBackends(snapshot);
  return selection.kind === 'ready' ? selection.backends : [];
}

function hasOnlyKeys(value: object, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function isBoundedNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function parseRecord(raw: unknown, expectedId: BackendReadinessId): BackendReadinessRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (!hasOnlyKeys(raw, RECORD_KEYS)) return null;

  const record = raw as Record<string, unknown>;
  if (record.backendId !== expectedId) return null;
  if (typeof record.state !== 'string' || !STATE_SET.has(record.state)) return null;
  if (typeof record.code !== 'string' || !CODE_SET.has(record.code)) return null;
  if (typeof record.recoveryAction !== 'string' || !ACTION_SET.has(record.recoveryAction)) {
    return null;
  }
  if (typeof record.compatibility !== 'string' || !COMPAT_SET.has(record.compatibility)) {
    return null;
  }
  if (!isIsoTimestamp(record.checkedAt)) return null;

  let versionEvidence: string | null;
  if (record.versionEvidence === null) {
    versionEvidence = null;
  } else if (
    typeof record.versionEvidence === 'string' &&
    record.versionEvidence.length > 0 &&
    record.versionEvidence.length <= BACKEND_READINESS_VERSION_EVIDENCE_MAX
  ) {
    versionEvidence = record.versionEvidence;
  } else {
    return null;
  }

  return {
    backendId: expectedId,
    state: record.state as BackendReadinessState,
    code: record.code as BackendReadinessCode,
    recoveryAction: record.recoveryAction as BackendRecoveryAction,
    compatibility: record.compatibility as BackendCompatibilityStatus,
    versionEvidence,
    checkedAt: record.checkedAt,
  };
}

/**
 * Fail-closed runtime parser for host→webview readiness snapshots.
 * Rejects missing/extra/duplicate/unknown/overlong/non-finite/malformed data
 * rather than repairing it. Returns null on any contract violation.
 */
export function parseBackendReadinessSnapshot(raw: unknown): BackendReadinessSnapshot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (!hasOnlyKeys(raw, SNAPSHOT_KEYS)) return null;

  const snap = raw as Record<string, unknown>;

  if (
    !isFiniteInteger(snap.schemaVersion) ||
    snap.schemaVersion !== BACKEND_READINESS_SCHEMA_VERSION
  ) {
    return null;
  }
  if (!isBoundedNonEmptyString(snap.correlationId, BACKEND_READINESS_CORRELATION_ID_MAX)) {
    return null;
  }
  if (typeof snap.phase !== 'string' || !PHASE_SET.has(snap.phase)) return null;
  if (!isIsoTimestamp(snap.checkedAt)) return null;
  if (!Array.isArray(snap.backends) || snap.backends.length !== BACKEND_READINESS_IDS.length) {
    return null;
  }

  const backends: BackendReadinessRecord[] = [];
  for (let i = 0; i < BACKEND_READINESS_IDS.length; i++) {
    const parsed = parseRecord(snap.backends[i], BACKEND_READINESS_IDS[i]);
    if (!parsed) return null;
    backends.push(parsed);
  }

  return {
    schemaVersion: BACKEND_READINESS_SCHEMA_VERSION,
    correlationId: snap.correlationId,
    phase: snap.phase as BackendReadinessPhase,
    checkedAt: snap.checkedAt,
    backends,
  };
}
