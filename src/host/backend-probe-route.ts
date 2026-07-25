/**
 * Host routing for webview Test Connection (M019/S02).
 *
 * Pure orchestration over injected BackendProbeService + readiness snapshot seams.
 * Never imports shared ACP clients, model-catalog, task engine, store, or outbox.
 * All webview-facing payloads are closed enums + bounded fields only.
 */

import {
  applyBackendProbeResult,
  applyBackendProbeTesting,
  isProbeEligible,
  parseBackendProbeProgress,
  parseBackendProbeRequest,
  parseBackendProbeResult,
  type BackendProbeProgress,
  type BackendProbeRequest,
  type BackendProbeResult,
} from '../shared/backend-probe';
import type {
  BackendReadinessId,
  BackendReadinessSnapshot,
} from '../shared/backend-readiness';
import type { StartBackendProbeInput } from './backend-probe';

/** Host→webview messages emitted by the probe route. */
export type BackendProbeHostMessage =
  | { type: 'backendProbeProgress'; progress: BackendProbeProgress }
  | { type: 'backendReadinessSnapshot'; snapshot: BackendReadinessSnapshot }
  | { type: 'backendsAvailable'; backends: string[] };

export interface BackendProbeRouteDeps {
  /** Last settled readiness snapshot (may be null before first inventory). */
  getReadinessSnapshot: () => BackendReadinessSnapshot | null;
  /** Ensure a settled inventory exists (passive only — never probes ACP). */
  ensureReadiness: () => Promise<BackendReadinessSnapshot>;
  /**
   * Replace the host-owned readiness snapshot after a pure reducer apply.
   * Must not write task/turn/message/outbox/session/composer state.
   */
  applySnapshot: (snapshot: BackendReadinessSnapshot) => void;
  /** Whether a probe is already single-flight for this backend. */
  isInFlight: (backendId: BackendReadinessId) => boolean;
  /** Start (or join) the isolated BackendProbeService probe. */
  startProbe: (input: StartBackendProbeInput) => Promise<BackendProbeResult>;
  /** Abort the in-flight probe for a backend. Returns true if one was active. */
  cancelProbe: (backendId: BackendReadinessId) => boolean;
  /** Post a typed host→webview message (best-effort). */
  post: (message: BackendProbeHostMessage) => void;
  /** Clock for testing timestamps when inventory must be bootstrapped. */
  now: () => Date;
  /**
   * Optional: derive passively selectable backend ids for the legacy
   * backendsAvailable channel. Defaults to empty when omitted.
   */
  deriveAvailableBackends?: (snapshot: BackendReadinessSnapshot) => string[];
}

export type BackendProbeStartOutcome =
  | { kind: 'ignored' }
  | { kind: 'refused'; reason: 'ineligible' | 'no_snapshot' }
  | { kind: 'joined'; probeId: string; backendId: BackendReadinessId }
  | { kind: 'completed'; probeId: string; backendId: BackendReadinessId; result: BackendProbeResult };

export type BackendProbeCancelOutcome =
  | { kind: 'ignored' }
  | { kind: 'cancelled'; backendId: BackendReadinessId }
  | { kind: 'idle'; backendId: BackendReadinessId };

/**
 * Fail-closed parser for webview `startBackendProbe` messages.
 * Requires exact type + closed probe request shape; rejects extra keys.
 */
export function parseStartBackendProbeMessage(data: unknown): BackendProbeRequest | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'startBackendProbe') return null;
  // Strip type and parse the remaining closed request keys.
  const { type: _type, ...rest } = record;
  return parseBackendProbeRequest(rest);
}

/**
 * Fail-closed parser for webview `cancelBackendProbe` messages.
 * Same closed shape as start (probeId + backendId) so cancel is correlated.
 */
export function parseCancelBackendProbeMessage(data: unknown): BackendProbeRequest | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'cancelBackendProbe') return null;
  const { type: _type, ...rest } = record;
  return parseBackendProbeRequest(rest);
}

function postSnapshot(deps: BackendProbeRouteDeps, snapshot: BackendReadinessSnapshot): void {
  deps.post({ type: 'backendReadinessSnapshot', snapshot });
  if (deps.deriveAvailableBackends) {
    deps.post({
      type: 'backendsAvailable',
      backends: deps.deriveAvailableBackends(snapshot),
    });
  }
}

function applyAndPost(
  deps: BackendProbeRouteDeps,
  snapshot: BackendReadinessSnapshot,
): BackendReadinessSnapshot {
  deps.applySnapshot(snapshot);
  postSnapshot(deps, snapshot);
  return snapshot;
}

function postProgress(deps: BackendProbeRouteDeps, progress: BackendProbeProgress): void {
  // Re-parse fail-closed so a buggy service cannot smuggle raw fields.
  const parsed = parseBackendProbeProgress(progress);
  if (!parsed) return;
  deps.post({ type: 'backendProbeProgress', progress: parsed });
}

/**
 * Route a webview startBackendProbe message:
 * 1. Fail-closed parse.
 * 2. Ensure readiness inventory exists.
 * 3. Refuse ineligible backends (missing / checking / testing / known-incompatible).
 * 4. If already in-flight, join without re-marking testing.
 * 5. Otherwise mark testing, start isolated probe, forward progress, apply result.
 */
export async function routeStartBackendProbe(
  data: unknown,
  deps: BackendProbeRouteDeps,
): Promise<BackendProbeStartOutcome> {
  const request = parseStartBackendProbeMessage(data);
  if (!request) {
    return { kind: 'ignored' };
  }

  let snapshot = deps.getReadinessSnapshot();
  if (!snapshot) {
    snapshot = await deps.ensureReadiness();
  }
  // Re-read after ensure in case applySnapshot was not used by ensure.
  snapshot = deps.getReadinessSnapshot() ?? snapshot;
  if (!snapshot) {
    return { kind: 'refused', reason: 'no_snapshot' };
  }

  const record = snapshot.backends.find((b) => b.backendId === request.backendId);
  if (!record || !isProbeEligible(record)) {
    return { kind: 'refused', reason: 'ineligible' };
  }

  const joining = deps.isInFlight(request.backendId);

  if (!joining) {
    const testingAt = deps.now().toISOString();
    const testingSnap = applyBackendProbeTesting(snapshot, request.backendId, testingAt);
    applyAndPost(deps, testingSnap);
  }

  const result = await deps.startProbe({
    probeId: request.probeId,
    backendId: request.backendId,
    onProgress: (progress) => postProgress(deps, progress),
  });

  // Fail-closed: only apply a parseable closed result.
  const parsedResult = parseBackendProbeResult(result);
  if (!parsedResult) {
    // Drop unsolicited/malformed terminal payloads; leave testing state if set.
    // Callers should not receive a forged ready/failed claim.
    return joining
      ? { kind: 'joined', probeId: request.probeId, backendId: request.backendId }
      : {
          kind: 'completed',
          probeId: request.probeId,
          backendId: request.backendId,
          result,
        };
  }

  const base = deps.getReadinessSnapshot() ?? snapshot;
  const next = applyBackendProbeResult(base, parsedResult);
  applyAndPost(deps, next);

  if (joining) {
    return {
      kind: 'joined',
      probeId: request.probeId,
      backendId: request.backendId,
    };
  }

  return {
    kind: 'completed',
    probeId: request.probeId,
    backendId: request.backendId,
    result: parsedResult,
  };
}

/**
 * Route a webview cancelBackendProbe message.
 * Abort is best-effort; terminal settlement still arrives via the start route's
 * joined promise (cancelled outcome → installed_unverified).
 */
export function routeCancelBackendProbe(
  data: unknown,
  deps: BackendProbeRouteDeps,
): BackendProbeCancelOutcome {
  const request = parseCancelBackendProbeMessage(data);
  if (!request) {
    return { kind: 'ignored' };
  }
  const cancelled = deps.cancelProbe(request.backendId);
  return cancelled
    ? { kind: 'cancelled', backendId: request.backendId }
    : { kind: 'idle', backendId: request.backendId };
}
