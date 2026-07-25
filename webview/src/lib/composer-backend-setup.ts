/**
 * Pure helpers for draft Composer backend-setup deep link (M019/S03 T04).
 *
 * After relocating Test Connection to Agents → Backends, the draft Composer
 * keeps readiness guidance and an "Open backend setup" deep link. Visibility
 * is derived from the same eligibility/readiness records as before — never
 * from a durable onboarding flag.
 */
import type { BackendReadinessId } from '../../../src/shared/backend-readiness';
import type { BackendReadinessRecord } from '../../../src/shared/backend-readiness';
import type { DraftComposerEligibility } from './backend-eligibility';

export const OPEN_BACKEND_SETUP_LABEL = 'Open backend setup' as const;
export const OPEN_BACKEND_SETUP_EVENT = 'muster:open-backend-setup' as const;

export type ComposerBackendSetupSurface = {
  /** Whether the draft Composer should show the readiness/setup guidance strip. */
  visible: boolean;
  /** Whether to render the Open backend setup deep-link control. */
  showOpenSetup: boolean;
  /** Bounded guidance text already derived by resolveDraftComposerEligibility. */
  setupGuidance: string;
  /** True when the display backend exists but is not probe-proven ready. */
  needsSetup: boolean;
};

/**
 * Resolve whether the draft Composer should surface setup guidance and the
 * Open backend setup deep link (replacing the relocated Test Connection strip).
 */
export function resolveComposerBackendSetupSurface(input: {
  mode: 'draft' | 'task';
  eligibility: DraftComposerEligibility;
}): ComposerBackendSetupSurface {
  if (input.mode !== 'draft') {
    return {
      visible: false,
      showOpenSetup: false,
      setupGuidance: '',
      needsSetup: false,
    };
  }

  const { eligibility } = input;
  const displayId = eligibility.displayBackend;
  const displayRecord = displayId
    ? eligibility.records.find((r) => r.backendId === displayId) ?? null
    : null;

  const needsSetup = needsBackendSetup(displayRecord, eligibility);
  const setupGuidance = eligibility.setupGuidance;
  const blocked = !eligibility.canComposeNewTask;
  const visible =
    blocked || setupGuidance.length > 0 || needsSetup || eligibility.kind === 'loading';

  return {
    visible,
    showOpenSetup: visible && eligibility.kind !== 'loading',
    setupGuidance:
      setupGuidance ||
      (needsSetup && displayRecord
        ? setupGuidanceForRecord(displayRecord)
        : blocked
          ? setupGuidance
          : ''),
    needsSetup,
  };
}

function needsBackendSetup(
  record: BackendReadinessRecord | null,
  eligibility: DraftComposerEligibility,
): boolean {
  if (eligibility.kind === 'loading') return false;
  if (eligibility.kind === 'empty') return true;
  if (!record) return !eligibility.canComposeNewTask;
  return record.state !== 'ready';
}

function setupGuidanceForRecord(record: BackendReadinessRecord): string {
  switch (record.state) {
    case 'installed_unverified':
    case 'testing':
      return 'This backend is installed but not yet verified. Open backend setup and run Test Connection before your first task.';
    case 'auth_required':
      return 'This backend needs you to sign in. Open backend setup to finish Test Connection.';
    case 'failed':
    case 'incompatible':
      return 'This backend is not ready. Open backend setup to review diagnostics and retry Test Connection.';
    case 'missing':
      return 'No supported agent CLI is ready. Open backend setup to install and verify a backend.';
    default:
      return 'Open backend setup to review backend readiness.';
  }
}

/** Stable action payload for opening Agents → Backends from the Composer. */
export function resolveOpenBackendSetupAction(): {
  topicId: 'agents';
  focusBackends: true;
} {
  return { topicId: 'agents', focusBackends: true };
}

export type { BackendReadinessId };
