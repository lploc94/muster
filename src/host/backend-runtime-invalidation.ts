/**
 * Host runtime setup-failure → readiness invalidation (M019/S04).
 *
 * Pure orchestration over injected readiness snapshot seams. Maps real-task
 * spawn/auth/version/ACP setup failures onto the shared sanitized readiness
 * taxonomy (via classifyRuntimeSetupFailure + applyRuntimeSetupFailure) and
 * republishes one BackendReadinessSnapshot. Never mutates tasks/sessions,
 * never replays prompts, never embeds raw provider text/paths/secrets.
 *
 * Turn error remains authoritative on the task surface; this module only
 * updates readiness publication for Agents Backends / Composer / Doctor.
 */

import {
  isBackendReadinessId,
  type BackendReadinessId,
  type BackendReadinessSnapshot,
} from '../shared/backend-readiness';
import {
  applyRuntimeSetupFailure,
  classifyRuntimeSetupFailure,
  type RuntimeSetupFailureCode,
  type RuntimeSetupStage,
} from '../shared/backend-runtime-recovery';

/** Host→webview messages emitted by runtime invalidation. */
export type RuntimeInvalidationHostMessage =
  | { type: 'backendReadinessSnapshot'; snapshot: BackendReadinessSnapshot }
  | { type: 'backendsAvailable'; backends: string[] };

/**
 * Host-facing input for a real-task setup failure.
 * Message is classification-only and is NEVER stored in readiness records.
 */
export interface RuntimeInvalidationSignal {
  /** Task backend id (must be a BackendReadinessId to apply). */
  backendId: string;
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
  /** Optional bounded version evidence override (never paths). */
  versionEvidence?: string | null;
}

export interface RuntimeInvalidationDeps {
  /** Last settled readiness snapshot (may be null before first inventory). */
  getReadinessSnapshot: () => BackendReadinessSnapshot | null;
  /** Ensure a settled inventory exists (passive only — never probes ACP). */
  ensureReadiness: () => Promise<BackendReadinessSnapshot>;
  /**
   * Replace the host-owned readiness snapshot after a pure reducer apply.
   * Must not write task/turn/message/outbox/session/composer state.
   */
  applySnapshot: (snapshot: BackendReadinessSnapshot) => void;
  /** Post a typed host→webview message (best-effort). */
  post: (message: RuntimeInvalidationHostMessage) => void;
  /** Clock for the invalidated record's checkedAt. */
  now: () => Date;
  /**
   * Optional: derive passively selectable backend ids for the legacy
   * backendsAvailable channel. Defaults to empty when omitted.
   */
  deriveAvailableBackends?: (snapshot: BackendReadinessSnapshot) => string[];
  /**
   * Optional sentinel seams used only by tests to prove this module never
   * replays prompts or mutates tasks. Production wiring omits these.
   * Implementation MUST NOT call them.
   */
  replayPrompt?: () => void;
  mutateTask?: () => void;
}

export type RuntimeInvalidationOutcome =
  | { kind: 'applied'; backendId: BackendReadinessId; code: RuntimeSetupFailureCode }
  | {
      kind: 'skipped';
      reason: 'unknown_backend' | 'unmapped' | 'no_snapshot' | 'backend_absent';
    };

function postSnapshot(
  deps: RuntimeInvalidationDeps,
  snapshot: BackendReadinessSnapshot,
): void {
  deps.post({ type: 'backendReadinessSnapshot', snapshot });
  if (deps.deriveAvailableBackends) {
    deps.post({
      type: 'backendsAvailable',
      backends: deps.deriveAvailableBackends(snapshot),
    });
  }
}

/**
 * Classify a real-task setup failure and, when mapped, invalidate only that
 * provider in the shared readiness snapshot and republish.
 *
 * Fail-closed: unknown backend, unmapped signal, or missing inventory → skip
 * without publishing and without mutating task/session state. Never calls
 * replayPrompt / mutateTask even when those optional deps are injected.
 */
export async function invalidateBackendReadinessFromRuntimeFailure(
  signal: RuntimeInvalidationSignal,
  deps: RuntimeInvalidationDeps,
): Promise<RuntimeInvalidationOutcome> {
  if (!isBackendReadinessId(signal.backendId)) {
    return { kind: 'skipped', reason: 'unknown_backend' };
  }
  const backendId = signal.backendId;

  const code = classifyRuntimeSetupFailure({
    stage: signal.stage,
    errorCode: signal.errorCode,
    message: signal.message,
  });
  if (!code) {
    return { kind: 'skipped', reason: 'unmapped' };
  }

  let snapshot = deps.getReadinessSnapshot();
  if (!snapshot) {
    try {
      snapshot = await deps.ensureReadiness();
    } catch {
      return { kind: 'skipped', reason: 'no_snapshot' };
    }
  }
  // Re-read after ensure in case applySnapshot was not used by ensure.
  snapshot = deps.getReadinessSnapshot() ?? snapshot;
  if (!snapshot) {
    return { kind: 'skipped', reason: 'no_snapshot' };
  }

  const checkedAt = deps.now().toISOString();
  const next = applyRuntimeSetupFailure(snapshot, {
    backendId,
    code,
    checkedAt,
    versionEvidence: signal.versionEvidence,
  });

  // applyRuntimeSetupFailure returns the input snapshot when backend is absent.
  if (next === snapshot) {
    return { kind: 'skipped', reason: 'backend_absent' };
  }

  deps.applySnapshot(next);
  postSnapshot(deps, next);

  return { kind: 'applied', backendId, code };
}

/**
 * Best-effort helper for host/engine call sites: fire-and-forget invalidation
 * that never throws into the turn path. Turn errors remain authoritative.
 */
export function scheduleRuntimeReadinessInvalidation(
  signal: RuntimeInvalidationSignal,
  deps: RuntimeInvalidationDeps,
): void {
  void invalidateBackendReadinessFromRuntimeFailure(signal, deps).catch(() => {
    // Best-effort only — readiness publication must not break turn settlement.
  });
}
