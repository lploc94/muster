/**
 * Shared BackendProbe contract (M019/S02).
 *
 * Pure value module — no Node/VS Code/webview I/O. Safe for host and webview
 * value imports (same pattern as backend-readiness).
 *
 * Defines the active Test Connection probe request/progress/result shapes,
 * fail-closed runtime parsers, and pure snapshot reducers that layer a probe
 * result onto a BackendReadinessSnapshot without mutating the input.
 */

import {
  BACKEND_READINESS_VERSION_EVIDENCE_MAX,
  isBackendReadinessId,
  isPassivelySelectable,
  type BackendCompatibilityStatus,
  type BackendReadinessCode,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
  type BackendReadinessState,
  type BackendRecoveryAction,
} from './backend-readiness';

/** Probe schema version. Bump only on breaking shape changes. */
export const BACKEND_PROBE_SCHEMA_VERSION = 1 as const;

/** Ordered probe stage taxonomy (progress + lastStage evidence). */
export const BACKEND_PROBE_STAGES = [
  'executable',
  'version',
  'initialize',
  'authenticate',
  'session',
  'model_catalog',
] as const;

export type BackendProbeStage = (typeof BACKEND_PROBE_STAGES)[number];

/** Terminal probe outcomes (mapped onto readiness states by the reducer). */
export const BACKEND_PROBE_OUTCOMES = [
  'ready',
  'auth_required',
  'incompatible',
  'failed',
  'cancelled',
] as const;

export type BackendProbeOutcome = (typeof BACKEND_PROBE_OUTCOMES)[number];

/** Bounded probe correlation id (same scale as readiness correlationId). */
export const BACKEND_PROBE_ID_MAX = 128;

export interface BackendProbeRequest {
  schemaVersion: typeof BACKEND_PROBE_SCHEMA_VERSION;
  probeId: string;
  backendId: BackendReadinessId;
}

export interface BackendProbeProgress {
  schemaVersion: typeof BACKEND_PROBE_SCHEMA_VERSION;
  probeId: string;
  backendId: BackendReadinessId;
  stage: BackendProbeStage;
  /** ISO-8601 timestamp for when this stage started. */
  startedAt: string;
}

export interface BackendProbeResult {
  schemaVersion: typeof BACKEND_PROBE_SCHEMA_VERSION;
  probeId: string;
  backendId: BackendReadinessId;
  outcome: BackendProbeOutcome;
  code: BackendReadinessCode;
  recoveryAction: BackendRecoveryAction;
  compatibility: BackendCompatibilityStatus;
  /** Bounded display version evidence only; never absolute paths or raw stdout. */
  versionEvidence: string | null;
  lastStage: BackendProbeStage;
  modelCatalogAvailable: boolean;
  /** ISO-8601 evidence timestamp. */
  checkedAt: string;
}

const STAGE_SET = new Set<string>(BACKEND_PROBE_STAGES);
const OUTCOME_SET = new Set<string>(BACKEND_PROBE_OUTCOMES);

const REQUEST_KEYS = new Set(['schemaVersion', 'probeId', 'backendId']);
const PROGRESS_KEYS = new Set([
  'schemaVersion',
  'probeId',
  'backendId',
  'stage',
  'startedAt',
]);
const RESULT_KEYS = new Set([
  'schemaVersion',
  'probeId',
  'backendId',
  'outcome',
  'code',
  'recoveryAction',
  'compatibility',
  'versionEvidence',
  'lastStage',
  'modelCatalogAvailable',
  'checkedAt',
]);

// Closed readiness taxonomies — mirrored as sets for fail-closed result parsing.
// Keep in sync with backend-readiness.ts (imported types already constrain callers).
const CODE_SET = new Set<string>([
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
]);
const ACTION_SET = new Set<string>(['none', 'install', 'login', 'update', 'retry', 'open_docs']);
const COMPAT_SET = new Set<string>(['compatible', 'incompatible', 'unknown']);

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function hasOnlyKeys(value: object, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasAllKeys(value: object, required: Set<string>): boolean {
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.has(key)) return false;
  }
  return true;
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

/**
 * Fail-closed runtime parser for webview→host probe start requests.
 * Rejects rather than repairs. Returns null on any contract violation.
 */
export function parseBackendProbeRequest(raw: unknown): BackendProbeRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (!hasOnlyKeys(raw, REQUEST_KEYS) || !hasAllKeys(raw, REQUEST_KEYS)) return null;

  const req = raw as Record<string, unknown>;
  if (
    !isFiniteInteger(req.schemaVersion) ||
    req.schemaVersion !== BACKEND_PROBE_SCHEMA_VERSION
  ) {
    return null;
  }
  if (!isBoundedNonEmptyString(req.probeId, BACKEND_PROBE_ID_MAX)) return null;
  if (!isBackendReadinessId(req.backendId)) return null;

  return {
    schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
    probeId: req.probeId,
    backendId: req.backendId,
  };
}

/**
 * Fail-closed runtime parser for host→webview probe progress messages.
 */
export function parseBackendProbeProgress(raw: unknown): BackendProbeProgress | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (!hasOnlyKeys(raw, PROGRESS_KEYS) || !hasAllKeys(raw, PROGRESS_KEYS)) return null;

  const prog = raw as Record<string, unknown>;
  if (
    !isFiniteInteger(prog.schemaVersion) ||
    prog.schemaVersion !== BACKEND_PROBE_SCHEMA_VERSION
  ) {
    return null;
  }
  if (!isBoundedNonEmptyString(prog.probeId, BACKEND_PROBE_ID_MAX)) return null;
  if (!isBackendReadinessId(prog.backendId)) return null;
  if (typeof prog.stage !== 'string' || !STAGE_SET.has(prog.stage)) return null;
  if (!isIsoTimestamp(prog.startedAt)) return null;

  return {
    schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
    probeId: prog.probeId,
    backendId: prog.backendId,
    stage: prog.stage as BackendProbeStage,
    startedAt: prog.startedAt,
  };
}

/**
 * Fail-closed runtime parser for host→webview probe results.
 * No raw stderr, paths, error text, or secrets are accepted — only closed enums
 * and bounded version evidence.
 */
export function parseBackendProbeResult(raw: unknown): BackendProbeResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (!hasOnlyKeys(raw, RESULT_KEYS) || !hasAllKeys(raw, RESULT_KEYS)) return null;

  const res = raw as Record<string, unknown>;
  if (
    !isFiniteInteger(res.schemaVersion) ||
    res.schemaVersion !== BACKEND_PROBE_SCHEMA_VERSION
  ) {
    return null;
  }
  if (!isBoundedNonEmptyString(res.probeId, BACKEND_PROBE_ID_MAX)) return null;
  if (!isBackendReadinessId(res.backendId)) return null;
  if (typeof res.outcome !== 'string' || !OUTCOME_SET.has(res.outcome)) return null;
  if (typeof res.code !== 'string' || !CODE_SET.has(res.code)) return null;
  if (typeof res.recoveryAction !== 'string' || !ACTION_SET.has(res.recoveryAction)) {
    return null;
  }
  if (typeof res.compatibility !== 'string' || !COMPAT_SET.has(res.compatibility)) {
    return null;
  }
  if (typeof res.lastStage !== 'string' || !STAGE_SET.has(res.lastStage)) return null;
  if (typeof res.modelCatalogAvailable !== 'boolean') return null;
  if (!isIsoTimestamp(res.checkedAt)) return null;

  let versionEvidence: string | null;
  if (res.versionEvidence === null) {
    versionEvidence = null;
  } else if (
    typeof res.versionEvidence === 'string' &&
    res.versionEvidence.length > 0 &&
    res.versionEvidence.length <= BACKEND_READINESS_VERSION_EVIDENCE_MAX
  ) {
    versionEvidence = res.versionEvidence;
  } else {
    return null;
  }

  return {
    schemaVersion: BACKEND_PROBE_SCHEMA_VERSION,
    probeId: res.probeId,
    backendId: res.backendId,
    outcome: res.outcome as BackendProbeOutcome,
    code: res.code as BackendReadinessCode,
    recoveryAction: res.recoveryAction as BackendRecoveryAction,
    compatibility: res.compatibility as BackendCompatibilityStatus,
    versionEvidence,
    lastStage: res.lastStage as BackendProbeStage,
    modelCatalogAvailable: res.modelCatalogAvailable,
    checkedAt: res.checkedAt,
  };
}

/**
 * Map a terminal probe outcome onto a readiness state.
 * Cancelled must not claim failure — the executable is still installed.
 */
export function probeOutcomeToReadinessState(
  outcome: BackendProbeOutcome,
): BackendReadinessState {
  switch (outcome) {
    case 'ready':
      return 'ready';
    case 'auth_required':
      return 'auth_required';
    case 'incompatible':
      return 'incompatible';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'installed_unverified';
  }
}

/**
 * Pure reducer: layer a probe result onto one backend record.
 * Returns a NEW snapshot (and NEW backends array). Input snapshot and every
 * record object must not be mutated. Sibling records stay reference-equal.
 * Returns the input snapshot unchanged when the backend id is absent.
 */
export function applyBackendProbeResult(
  snapshot: BackendReadinessSnapshot,
  result: BackendProbeResult,
): BackendReadinessSnapshot {
  const index = snapshot.backends.findIndex((r) => r.backendId === result.backendId);
  if (index < 0) return snapshot;

  const nextRecord: BackendReadinessRecord = {
    backendId: result.backendId,
    state: probeOutcomeToReadinessState(result.outcome),
    code: result.code,
    recoveryAction: result.recoveryAction,
    compatibility: result.compatibility,
    versionEvidence: result.versionEvidence,
    checkedAt: result.checkedAt,
  };

  const backends = snapshot.backends.slice();
  backends[index] = nextRecord;

  return {
    schemaVersion: snapshot.schemaVersion,
    correlationId: snapshot.correlationId,
    phase: snapshot.phase,
    checkedAt: snapshot.checkedAt,
    backends,
  };
}

/**
 * Pure reducer: mark one backend as actively testing.
 * Preserves existing compatibility and versionEvidence; sets code/action to none.
 * Returns the input snapshot unchanged when the backend id is absent.
 */
export function applyBackendProbeTesting(
  snapshot: BackendReadinessSnapshot,
  backendId: BackendReadinessId,
  startedAt: string,
): BackendReadinessSnapshot {
  const index = snapshot.backends.findIndex((r) => r.backendId === backendId);
  if (index < 0) return snapshot;

  const prev = snapshot.backends[index];
  const nextRecord: BackendReadinessRecord = {
    backendId,
    state: 'testing',
    code: 'none',
    recoveryAction: 'none',
    compatibility: prev.compatibility,
    versionEvidence: prev.versionEvidence,
    checkedAt: startedAt,
  };

  const backends = snapshot.backends.slice();
  backends[index] = nextRecord;

  return {
    schemaVersion: snapshot.schemaVersion,
    correlationId: snapshot.correlationId,
    phase: snapshot.phase,
    checkedAt: snapshot.checkedAt,
    backends,
  };
}

/**
 * Whether an explicit Test Connection may be started for this record.
 * Requires passive selectability and excludes checking / testing states
 * (missing and known-incompatible are already excluded by isPassivelySelectable).
 */
export function isProbeEligible(record: BackendReadinessRecord): boolean {
  if (!isPassivelySelectable(record)) return false;
  if (record.state === 'checking' || record.state === 'testing') return false;
  return true;
}
