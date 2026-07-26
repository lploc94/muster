/**
 * M019/S05 T01 — Non-production native first-run acceptance adapter.
 *
 * Dependency-injected observers over production readiness refresh, isolated
 * Test Connection, Doctor, and first-task acceptance paths. Emits only bounded
 * sanitized fields for the native evidence ledger. Production hosts never
 * register the UAT commands that call these observers.
 */

import {
  BACKEND_READINESS_CODES,
  BACKEND_READINESS_IDS,
  BACKEND_READINESS_STATES,
  BACKEND_RECOVERY_ACTIONS,
  type BackendReadinessCode,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
  type BackendReadinessState,
  type BackendRecoveryAction,
} from '../shared/backend-readiness';
import type { BackendProbeStartOutcome } from './backend-probe-route';
import type { RunDiagnosticsCommandResult } from './run-diagnostics-command';

export const NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION = 1 as const;

/** Fixed, content-free UAT prompt used only on the production send path. */
export const NATIVE_FIRST_RUN_UAT_PROMPT = 'muster-uat-first-run' as const;

export const NATIVE_FIRST_RUN_UAT_COMMANDS = {
  refreshReadiness: 'muster.uat.refreshReadiness',
  probeBackend: 'muster.uat.probeBackend',
  runDoctor: 'muster.uat.runDoctor',
  acceptFirstTask: 'muster.uat.acceptFirstTask',
  cleanup: 'muster.uat.nativeFirstRunCleanup',
} as const;

export type NativeFirstRunAttemptedStep =
  | 'activate'
  | 'refresh'
  | 'probe'
  | 'doctor'
  | 'first_send'
  | 'cleanup';

export type NativeFirstRunVerdict = 'PASS' | 'FAIL' | 'ENVIRONMENT_BLOCKED';

export type NativeFirstRunEnvironmentBlockCode =
  | 'host_unavailable'
  | 'provider_missing'
  | 'auth_required'
  | 'incompatible'
  | 'probe_failed'
  | 'doctor_failed'
  | 'unknown';

export type BoundedProviderObservation = {
  providerId: BackendReadinessId;
  state: BackendReadinessState;
  code: BackendReadinessCode;
  recoveryAction: BackendRecoveryAction;
  checkedAt: string;
};

export type NativeFirstRunObservation = {
  schemaVersion: typeof NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION;
  providerId: BackendReadinessId;
  attemptedStep: NativeFirstRunAttemptedStep;
  verdict: NativeFirstRunVerdict;
  evidenceAt: string;
  readiness?: BoundedProviderObservation;
  doctorResult?: 'success' | 'cancelled' | 'refresh_failed' | 'open_failed' | 'reveal_failed';
  firstSend?: {
    accepted: boolean;
    rejectCode?: 'store' | 'validation' | 'conflict' | 'capacity' | 'unknown';
  };
  cleanupCompleted?: boolean;
  environmentBlockCode?: NativeFirstRunEnvironmentBlockCode;
};

const PROVIDER_ID_SET = new Set<string>(BACKEND_READINESS_IDS);
const STATE_SET = new Set<string>(BACKEND_READINESS_STATES);
const CODE_SET = new Set<string>(BACKEND_READINESS_CODES);
const RECOVERY_SET = new Set<string>(BACKEND_RECOVERY_ACTIONS);
const STEP_SET = new Set<string>([
  'activate',
  'refresh',
  'probe',
  'doctor',
  'first_send',
  'cleanup',
]);
const VERDICT_SET = new Set<string>(['PASS', 'FAIL', 'ENVIRONMENT_BLOCKED']);
const BLOCK_SET = new Set<string>([
  'host_unavailable',
  'provider_missing',
  'auth_required',
  'incompatible',
  'probe_failed',
  'doctor_failed',
  'unknown',
]);
const DOCTOR_RESULT_SET = new Set<string>([
  'success',
  'cancelled',
  'refresh_failed',
  'open_failed',
  'reveal_failed',
]);
const REJECT_CODE_SET = new Set<string>([
  'store',
  'validation',
  'conflict',
  'capacity',
  'unknown',
]);

/** Closed observation keys — extra keys fail closed (no secret smuggling). */
const OBSERVATION_KEYS = new Set([
  'schemaVersion',
  'providerId',
  'attemptedStep',
  'verdict',
  'evidenceAt',
  'readiness',
  'doctorResult',
  'firstSend',
  'cleanupCompleted',
  'environmentBlockCode',
]);

const READINESS_KEYS = new Set([
  'providerId',
  'state',
  'code',
  'recoveryAction',
  'checkedAt',
]);

const FIRST_SEND_KEYS = new Set(['accepted', 'rejectCode']);

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isNativeFirstRunProviderId(value: unknown): value is BackendReadinessId {
  return typeof value === 'string' && PROVIDER_ID_SET.has(value);
}

export function boundProviderObservation(
  record: BackendReadinessRecord,
): BoundedProviderObservation {
  return {
    providerId: record.backendId,
    state: record.state,
    code: record.code,
    recoveryAction: record.recoveryAction,
    checkedAt: record.checkedAt,
  };
}

function evidenceAt(now: () => Date): string {
  return now().toISOString();
}

function findProviderRecord(
  snapshot: BackendReadinessSnapshot | null | undefined,
  providerId: BackendReadinessId,
): BackendReadinessRecord | undefined {
  return snapshot?.backends.find((b) => b.backendId === providerId);
}

function baseObservation(
  providerId: BackendReadinessId,
  attemptedStep: NativeFirstRunAttemptedStep,
  now: () => Date,
): Pick<
  NativeFirstRunObservation,
  'schemaVersion' | 'providerId' | 'attemptedStep' | 'evidenceAt'
> {
  return {
    schemaVersion: NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION,
    providerId,
    attemptedStep,
    evidenceAt: evidenceAt(now),
  };
}

function withReadiness(
  observation: NativeFirstRunObservation,
  snapshot: BackendReadinessSnapshot | null | undefined,
  providerId: BackendReadinessId,
): NativeFirstRunObservation {
  const record = findProviderRecord(snapshot, providerId);
  if (!record) return observation;
  return { ...observation, readiness: boundProviderObservation(record) };
}

export type NativeReadinessRefreshDeps = {
  /** Production refreshAndPublishBackendReadiness (Doctor/refresh path). */
  refreshAndPublishReadiness: () => Promise<void>;
  getReadinessSnapshot: () => BackendReadinessSnapshot | null;
  now: () => Date;
};

export async function observeNativeReadinessRefresh(
  providerId: BackendReadinessId,
  deps: NativeReadinessRefreshDeps,
): Promise<NativeFirstRunObservation> {
  try {
    await deps.refreshAndPublishReadiness();
  } catch {
    return {
      ...baseObservation(providerId, 'refresh', deps.now),
      verdict: 'ENVIRONMENT_BLOCKED',
      environmentBlockCode: 'host_unavailable',
    };
  }

  const snapshot = deps.getReadinessSnapshot();
  let observation: NativeFirstRunObservation = {
    ...baseObservation(providerId, 'refresh', deps.now),
    verdict: 'PASS',
  };
  observation = withReadiness(observation, snapshot, providerId);
  return observation;
}

export type NativeIsolatedProbeDeps = {
  /**
   * Production routeStartBackendProbe entry. Receives a well-formed
   * startBackendProbe message shape so the same fail-closed route runs.
   */
  routeStart: (message: {
    type: 'startBackendProbe';
    probeId: string;
    backendId: BackendReadinessId;
  }) => Promise<BackendProbeStartOutcome>;
  getReadinessSnapshot: () => BackendReadinessSnapshot | null;
  createProbeId: () => string;
  now: () => Date;
};

function mapProbeEnvironmentBlock(
  record: BackendReadinessRecord | undefined,
  outcome: BackendProbeStartOutcome,
): NativeFirstRunEnvironmentBlockCode {
  if (outcome.kind === 'refused') {
    if (record?.state === 'missing' || record?.code === 'executable_missing') {
      return 'provider_missing';
    }
    if (record?.state === 'auth_required' || record?.code === 'auth_required') {
      return 'auth_required';
    }
    if (record?.state === 'incompatible' || record?.code === 'version_incompatible') {
      return 'incompatible';
    }
    return 'provider_missing';
  }
  if (outcome.kind === 'completed') {
    const code = outcome.result?.code;
    const resultState =
      typeof (outcome.result as { outcome?: string } | undefined)?.outcome === 'string'
        ? (outcome.result as { outcome: string }).outcome
        : undefined;
    if (code === 'auth_required' || resultState === 'auth_required') return 'auth_required';
    if (code === 'version_incompatible' || resultState === 'incompatible') return 'incompatible';
    if (code === 'executable_missing') return 'provider_missing';
    if (
      code === 'acp_initialize_failed' ||
      code === 'session_probe_failed' ||
      code === 'model_catalog_unavailable' ||
      code === 'timeout' ||
      code === 'process_exited' ||
      code === 'cancelled' ||
      code === 'internal_error'
    ) {
      return 'probe_failed';
    }
  }
  return 'probe_failed';
}

function isProbeReadyOutcome(outcome: BackendProbeStartOutcome): boolean {
  if (outcome.kind !== 'completed') return false;
  const result = outcome.result as { outcome?: string; code?: string } | undefined;
  return result?.outcome === 'ready' || result?.code === 'none';
}

export async function observeNativeIsolatedProbe(
  providerId: BackendReadinessId,
  deps: NativeIsolatedProbeDeps,
): Promise<NativeFirstRunObservation> {
  let outcome: BackendProbeStartOutcome;
  try {
    outcome = await deps.routeStart({
      type: 'startBackendProbe',
      probeId: deps.createProbeId(),
      backendId: providerId,
    });
  } catch {
    return {
      ...baseObservation(providerId, 'probe', deps.now),
      verdict: 'ENVIRONMENT_BLOCKED',
      environmentBlockCode: 'host_unavailable',
    };
  }

  const snapshot = deps.getReadinessSnapshot();
  const record = findProviderRecord(snapshot, providerId);
  let observation: NativeFirstRunObservation = {
    ...baseObservation(providerId, 'probe', deps.now),
    verdict: 'PASS',
  };
  observation = withReadiness(observation, snapshot, providerId);

  if (outcome.kind === 'ignored') {
    return {
      ...observation,
      verdict: 'ENVIRONMENT_BLOCKED',
      environmentBlockCode: 'host_unavailable',
    };
  }

  if (outcome.kind === 'refused' || outcome.kind === 'joined') {
    // joined without terminal ready is not a native PASS claim.
    if (outcome.kind === 'joined') {
      // If snapshot already ready from a concurrent probe, allow PASS.
      if (record?.state === 'ready') return observation;
      return {
        ...observation,
        verdict: 'ENVIRONMENT_BLOCKED',
        environmentBlockCode: 'probe_failed',
      };
    }
    return {
      ...observation,
      verdict: 'ENVIRONMENT_BLOCKED',
      environmentBlockCode: mapProbeEnvironmentBlock(record, outcome),
    };
  }

  // completed
  if (isProbeReadyOutcome(outcome) && (record?.state === 'ready' || !record)) {
    // Prefer snapshot readiness; if missing, still PASS when result is ready.
    if (!record && outcome.kind === 'completed') {
      const result = outcome.result as {
        code?: BackendReadinessCode;
        recoveryAction?: BackendRecoveryAction;
        checkedAt?: string;
      };
      return {
        ...observation,
        readiness: {
          providerId,
          state: 'ready',
          code: result.code === 'none' ? 'none' : (result.code ?? 'none'),
          recoveryAction: result.recoveryAction ?? 'none',
          checkedAt: result.checkedAt ?? observation.evidenceAt,
        },
      };
    }
    if (record?.state === 'ready') return observation;
  }

  // Non-ready terminal probe results are environment blocks for native proof
  // (provider not usable for first-run acceptance), not product FAILs.
  return {
    ...observation,
    verdict: 'ENVIRONMENT_BLOCKED',
    environmentBlockCode: mapProbeEnvironmentBlock(record, outcome),
  };
}

export type NativeDoctorDeps = {
  /** Production handleRunDiagnosticsCommand (or equivalent wiring). */
  runDoctor: () => Promise<RunDiagnosticsCommandResult>;
  getReadinessSnapshot: () => BackendReadinessSnapshot | null;
  now: () => Date;
};

export async function observeNativeDoctor(
  providerId: BackendReadinessId,
  deps: NativeDoctorDeps,
): Promise<NativeFirstRunObservation> {
  let result: RunDiagnosticsCommandResult;
  try {
    result = await deps.runDoctor();
  } catch {
    return {
      ...baseObservation(providerId, 'doctor', deps.now),
      verdict: 'ENVIRONMENT_BLOCKED',
      environmentBlockCode: 'doctor_failed',
      doctorResult: 'refresh_failed',
    };
  }

  const snapshot = deps.getReadinessSnapshot();
  let observation: NativeFirstRunObservation = {
    ...baseObservation(providerId, 'doctor', deps.now),
    verdict: 'PASS',
  };
  observation = withReadiness(observation, snapshot, providerId);

  if (result.kind === 'success') {
    return { ...observation, doctorResult: 'success' };
  }
  if (result.kind === 'cancelled') {
    return {
      ...observation,
      verdict: 'ENVIRONMENT_BLOCKED',
      environmentBlockCode: 'doctor_failed',
      doctorResult: 'cancelled',
    };
  }
  return {
    ...observation,
    verdict: 'ENVIRONMENT_BLOCKED',
    environmentBlockCode: 'doctor_failed',
    doctorResult: result.code,
  };
}

export type NativeFirstTaskAcceptResult =
  | { kind: 'accepted'; taskIdLength: number; messageIdLength: number }
  | {
      kind: 'rejected';
      code: 'store' | 'validation' | 'conflict' | 'capacity' | 'unknown';
    }
  | { kind: 'error'; code: 'host_unavailable' };

export type NativeFirstTaskAcceptanceDeps = {
  /**
   * Production send path for a clean-workspace first task. Must not return
   * prompt text, task ids, or store bodies — only lengths / reject codes.
   */
  acceptFirstTask: (input: {
    backendId: BackendReadinessId;
    clientRequestId: string;
  }) => Promise<NativeFirstTaskAcceptResult>;
  getReadinessSnapshot: () => BackendReadinessSnapshot | null;
  createClientRequestId: () => string;
  now: () => Date;
};

export async function observeNativeFirstTaskAcceptance(
  providerId: BackendReadinessId,
  deps: NativeFirstTaskAcceptanceDeps,
): Promise<NativeFirstRunObservation> {
  let result: NativeFirstTaskAcceptResult;
  try {
    result = await deps.acceptFirstTask({
      backendId: providerId,
      clientRequestId: deps.createClientRequestId(),
    });
  } catch {
    return {
      ...baseObservation(providerId, 'first_send', deps.now),
      verdict: 'ENVIRONMENT_BLOCKED',
      environmentBlockCode: 'host_unavailable',
    };
  }

  const snapshot = deps.getReadinessSnapshot();
  let observation: NativeFirstRunObservation = {
    ...baseObservation(providerId, 'first_send', deps.now),
    verdict: 'PASS',
  };
  observation = withReadiness(observation, snapshot, providerId);

  if (result.kind === 'accepted') {
    return {
      ...observation,
      firstSend: { accepted: true },
    };
  }

  if (result.kind === 'error') {
    return {
      ...observation,
      verdict: 'ENVIRONMENT_BLOCKED',
      environmentBlockCode: 'host_unavailable',
      firstSend: { accepted: false },
    };
  }

  // rejected — product gate failure when we expected acceptance
  return {
    ...observation,
    verdict: 'FAIL',
    firstSend: {
      accepted: false,
      rejectCode: result.code,
    },
  };
}

export type NativeCleanupDeps = {
  cancelProbe: (backendId: BackendReadinessId) => boolean;
  disposeAllProbes: () => void;
  deleteCreatedTask?: (taskId: string) => Promise<void>;
  createdTaskId?: string;
  now: () => Date;
};

export async function observeNativeCleanup(
  providerId: BackendReadinessId,
  deps: NativeCleanupDeps,
): Promise<NativeFirstRunObservation> {
  try {
    deps.cancelProbe(providerId);
  } catch {
    // best-effort
  }
  try {
    deps.disposeAllProbes();
  } catch {
    // best-effort
  }
  if (deps.createdTaskId && deps.deleteCreatedTask) {
    try {
      await deps.deleteCreatedTask(deps.createdTaskId);
    } catch {
      // best-effort — still report cleanup attempted
    }
  }

  return {
    ...baseObservation(providerId, 'cleanup', deps.now),
    verdict: 'PASS',
    cleanupCompleted: true,
  };
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && ISO_8601.test(value);
}

function parseBoundedReadiness(value: unknown): BoundedProviderObservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!READINESS_KEYS.has(key)) return null;
  }
  if (!isNativeFirstRunProviderId(raw.providerId)) return null;
  if (typeof raw.state !== 'string' || !STATE_SET.has(raw.state)) return null;
  if (typeof raw.code !== 'string' || !CODE_SET.has(raw.code)) return null;
  if (typeof raw.recoveryAction !== 'string' || !RECOVERY_SET.has(raw.recoveryAction)) {
    return null;
  }
  if (!isIso(raw.checkedAt)) return null;
  return {
    providerId: raw.providerId,
    state: raw.state as BackendReadinessState,
    code: raw.code as BackendReadinessCode,
    recoveryAction: raw.recoveryAction as BackendRecoveryAction,
    checkedAt: raw.checkedAt,
  };
}

/**
 * Fail-closed parser for durable native first-run observations.
 * Rejects unknown keys (prompt/stderr/path/store smuggling) and open enums.
 */
export function parseNativeFirstRunObservation(
  value: unknown,
): NativeFirstRunObservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!OBSERVATION_KEYS.has(key)) return null;
  }
  if (raw.schemaVersion !== NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION) return null;
  if (!isNativeFirstRunProviderId(raw.providerId)) return null;
  if (typeof raw.attemptedStep !== 'string' || !STEP_SET.has(raw.attemptedStep)) {
    return null;
  }
  if (typeof raw.verdict !== 'string' || !VERDICT_SET.has(raw.verdict)) return null;
  if (!isIso(raw.evidenceAt)) return null;

  const observation: NativeFirstRunObservation = {
    schemaVersion: NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION,
    providerId: raw.providerId,
    attemptedStep: raw.attemptedStep as NativeFirstRunAttemptedStep,
    verdict: raw.verdict as NativeFirstRunVerdict,
    evidenceAt: raw.evidenceAt,
  };

  if (raw.readiness !== undefined) {
    const readiness = parseBoundedReadiness(raw.readiness);
    if (!readiness) return null;
    if (readiness.providerId !== observation.providerId) return null;
    observation.readiness = readiness;
  }

  if (raw.doctorResult !== undefined) {
    if (typeof raw.doctorResult !== 'string' || !DOCTOR_RESULT_SET.has(raw.doctorResult)) {
      return null;
    }
    observation.doctorResult = raw.doctorResult as NonNullable<
      NativeFirstRunObservation['doctorResult']
    >;
  }

  if (raw.firstSend !== undefined) {
    if (
      typeof raw.firstSend !== 'object' ||
      raw.firstSend === null ||
      Array.isArray(raw.firstSend)
    ) {
      return null;
    }
    const fs = raw.firstSend as Record<string, unknown>;
    for (const key of Object.keys(fs)) {
      if (!FIRST_SEND_KEYS.has(key)) return null;
    }
    if (typeof fs.accepted !== 'boolean') return null;
    if (fs.rejectCode !== undefined) {
      if (typeof fs.rejectCode !== 'string' || !REJECT_CODE_SET.has(fs.rejectCode)) {
        return null;
      }
      observation.firstSend = {
        accepted: fs.accepted,
        rejectCode: fs.rejectCode as NonNullable<
          NativeFirstRunObservation['firstSend']
        >['rejectCode'],
      };
    } else {
      observation.firstSend = { accepted: fs.accepted };
    }
  }

  if (raw.cleanupCompleted !== undefined) {
    if (typeof raw.cleanupCompleted !== 'boolean') return null;
    observation.cleanupCompleted = raw.cleanupCompleted;
  }

  if (raw.environmentBlockCode !== undefined) {
    if (
      typeof raw.environmentBlockCode !== 'string' ||
      !BLOCK_SET.has(raw.environmentBlockCode)
    ) {
      return null;
    }
    observation.environmentBlockCode =
      raw.environmentBlockCode as NativeFirstRunEnvironmentBlockCode;
  }

  return observation;
}
