/**
 * Shared runtime setup-failure mapper + readiness invalidation reducer (M019/S04).
 *
 * Pure value module — no Node/VS Code/webview I/O. Safe for host and webview
 * value imports (same pattern as backend-probe / backend-readiness).
 *
 * Maps real-task spawn/auth/version/ACP setup failures onto the SAME sanitized
 * readiness taxonomy Agents Backends already renders. Does not invent a second
 * diagnostic vocabulary and never embeds raw provider text, paths, or secrets
 * in the mapped result.
 */

import type {
  BackendCompatibilityStatus,
  BackendReadinessCode,
  BackendReadinessId,
  BackendReadinessRecord,
  BackendReadinessSnapshot,
  BackendReadinessState,
  BackendRecoveryAction,
} from './backend-readiness';

/**
 * Closed subset of BACKEND_READINESS_CODES that real-task setup failures may
 * map onto. Intentionally excludes ready-path codes (`none`, `cancelled`,
 * `model_catalog_unavailable`) — those are probe/refresh outcomes, not
 * runtime invalidation signals.
 */
export const RUNTIME_SETUP_FAILURE_CODES = [
  'executable_missing',
  'auth_required',
  'version_incompatible',
  'version_unknown',
  'acp_initialize_failed',
  'session_probe_failed',
  'process_exited',
  'timeout',
  'internal_error',
] as const;

export type RuntimeSetupFailureCode = (typeof RUNTIME_SETUP_FAILURE_CODES)[number];

const RUNTIME_CODE_SET = new Set<string>(RUNTIME_SETUP_FAILURE_CODES);

/** Stages observed during real-task setup (spawn → session). */
export type RuntimeSetupStage =
  | 'spawn'
  | 'version'
  | 'initialize'
  | 'authenticate'
  | 'session'
  | 'unknown'
  | string;

/**
 * Host-facing input for classification. Message is used only as a matching
 * signal and is NEVER echoed into mapped readiness records.
 */
export interface RuntimeSetupFailureSignal {
  /** Optional setup stage hint from the turn path. */
  stage?: RuntimeSetupStage;
  /**
   * Stable error code when the runtime already has one
   * (e.g. ENOENT, setup_timeout, auth_required, version_incompatible).
   */
  errorCode?: string;
  /**
   * Raw provider/runtime message — classification only. Never stored.
   */
  message?: string;
}

/** Mapped readiness fields for one setup failure (no free-form text). */
export interface RuntimeSetupFailureMapping {
  state: BackendReadinessState;
  code: RuntimeSetupFailureCode;
  recoveryAction: BackendRecoveryAction;
  compatibility: BackendCompatibilityStatus;
}

/**
 * Input to the pure readiness invalidation reducer.
 * `versionEvidence` is optional bounded display evidence only (never paths).
 * When omitted, the previous record's versionEvidence is preserved.
 * When explicitly `null`, evidence is cleared.
 */
export interface RuntimeSetupFailureInput {
  backendId: BackendReadinessId;
  code: RuntimeSetupFailureCode;
  /** ISO-8601 evidence timestamp for the invalidated record. */
  checkedAt: string;
  versionEvidence?: string | null;
}

function isAuthErrorMessage(message: string): boolean {
  return (
    /\blogin\b/i.test(message) ||
    /\bauth(?:enticate|entication)?\b/i.test(message) ||
    /\bcredential/i.test(message) ||
    /\bapi[-_]?key\b/i.test(message) ||
    /\bnot authenticated\b/i.test(message) ||
    /\bunauthori[sz]ed\b/i.test(message)
  );
}

function isProcessExitMessage(message: string): boolean {
  return /\bexited\b/i.test(message) || /\bexit(?:ed)? \(code/i.test(message);
}

function isTimeoutMessage(message: string): boolean {
  return (
    /\btimeout\b/i.test(message) ||
    /\btimed out\b/i.test(message) ||
    /\bsetup timed out\b/i.test(message)
  );
}

function isExecutableMissingMessage(message: string): boolean {
  return (
    /\bENOENT\b/i.test(message) ||
    /\bcommand not found\b/i.test(message) ||
    /\bnot found\b/i.test(message) ||
    /\bno such file\b/i.test(message) ||
    /\bexecutable.?missing\b/i.test(message)
  );
}

function asRuntimeCode(value: string | undefined): RuntimeSetupFailureCode | null {
  if (!value) return null;
  return RUNTIME_CODE_SET.has(value) ? (value as RuntimeSetupFailureCode) : null;
}

/**
 * Classify a real-task setup failure signal into the closed readiness code
 * taxonomy. Returns null when the signal is not a mapped setup failure
 * (fail-closed — never invent a code).
 *
 * Priority: explicit errorCode (including Node errno) → message heuristics →
 * stage defaults. Message text is never returned.
 */
export function classifyRuntimeSetupFailure(
  signal: RuntimeSetupFailureSignal,
): RuntimeSetupFailureCode | null {
  const stage = typeof signal.stage === 'string' ? signal.stage : undefined;
  const errorCode =
    typeof signal.errorCode === 'string' ? signal.errorCode.trim() : undefined;
  const message = typeof signal.message === 'string' ? signal.message : '';

  // Explicit closed taxonomy codes win first.
  const direct = asRuntimeCode(errorCode);
  if (direct) return direct;

  // Node errno / known runtime codes.
  if (errorCode === 'ENOENT' || errorCode === 'EACCES' || errorCode === 'EPERM') {
    return 'executable_missing';
  }
  if (errorCode === 'setup_timeout' || errorCode === 'ETIMEDOUT' || errorCode === 'ESOCKETTIMEDOUT') {
    return 'timeout';
  }
  if (errorCode === 'mcp_unavailable') {
    // MCP setup failure is an ACP session-setup class failure, not a new code.
    return 'session_probe_failed';
  }

  // Message heuristics (classification only — never stored).
  if (message) {
    if (isExecutableMissingMessage(message)) return 'executable_missing';
    if (isAuthErrorMessage(message)) return 'auth_required';
    if (isTimeoutMessage(message)) return 'timeout';
    if (isProcessExitMessage(message)) return 'process_exited';
  }

  // Stage defaults when there is a non-empty signal but no stronger match.
  const hasSignal = Boolean(errorCode || message || (stage && stage !== 'unknown'));
  if (!hasSignal) return null;

  switch (stage) {
    case 'spawn':
      // Spawn failures without ENOENT still typically mean the executable path
      // is unusable; prefer executable_missing over inventing a code.
      if (message || errorCode) return 'executable_missing';
      return null;
    case 'version':
      // Version stage without an explicit code is not a known-incompatible claim.
      return message || errorCode ? 'version_unknown' : null;
    case 'initialize':
      return message || errorCode ? 'acp_initialize_failed' : null;
    case 'authenticate':
      // Auth stage with non-auth-shaped residual message still means auth path failed.
      return message || errorCode ? 'auth_required' : null;
    case 'session':
      return message || errorCode ? 'session_probe_failed' : null;
    default:
      // Unmapped stage + unmapped residual signal: do not invent a code.
      return null;
  }
}

/**
 * Map a closed setup-failure code onto the readiness state / recovery action /
 * compatibility fields Agents Backends already renders for the same code.
 */
export function mapRuntimeSetupFailure(
  code: RuntimeSetupFailureCode,
): RuntimeSetupFailureMapping {
  switch (code) {
    case 'executable_missing':
      return {
        state: 'missing',
        code,
        recoveryAction: 'install',
        compatibility: 'unknown',
      };
    case 'auth_required':
      return {
        state: 'auth_required',
        code,
        recoveryAction: 'login',
        compatibility: 'compatible',
      };
    case 'version_incompatible':
      return {
        state: 'incompatible',
        code,
        recoveryAction: 'update',
        compatibility: 'incompatible',
      };
    case 'version_unknown':
      return {
        state: 'installed_unverified',
        code,
        recoveryAction: 'none',
        compatibility: 'unknown',
      };
    case 'acp_initialize_failed':
    case 'session_probe_failed':
    case 'process_exited':
    case 'timeout':
    case 'internal_error':
      return {
        state: 'failed',
        code,
        recoveryAction: 'retry',
        compatibility: 'compatible',
      };
  }
}

/**
 * Pure reducer: invalidate one provider record from a mapped runtime setup
 * failure. Returns a NEW snapshot (and NEW backends array). Input snapshot and
 * every record object must not be mutated. Sibling records stay reference-equal.
 * Returns the input snapshot unchanged when the backend id is absent.
 *
 * Does not change snapshot-level checkedAt / correlationId / phase — only the
 * failing provider's evidence is refreshed. Turn errors remain authoritative
 * elsewhere; this reducer only updates readiness publication.
 */
export function applyRuntimeSetupFailure(
  snapshot: BackendReadinessSnapshot,
  input: RuntimeSetupFailureInput,
): BackendReadinessSnapshot {
  const index = snapshot.backends.findIndex((r) => r.backendId === input.backendId);
  if (index < 0) return snapshot;

  const prev = snapshot.backends[index];
  const mapped = mapRuntimeSetupFailure(input.code);

  const versionEvidence =
    input.versionEvidence !== undefined ? input.versionEvidence : prev.versionEvidence;

  const nextRecord: BackendReadinessRecord = {
    backendId: input.backendId,
    state: mapped.state,
    code: mapped.code as BackendReadinessCode,
    recoveryAction: mapped.recoveryAction,
    compatibility: mapped.compatibility,
    versionEvidence,
    checkedAt: input.checkedAt,
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
