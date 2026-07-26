/**
 * Pure backend readiness presentation reducer + first-run journey derivation
 * (M019 S03).
 *
 * I/O-free: no Svelte, DOM, or post(). Agents → Backends, the first-run
 * journey, and (later) Doctor all render the same host snapshot through these
 * helpers so the readiness vocabulary cannot fork.
 */
import {
  isPassivelySelectable,
  isTrustworthyFirstRunEligible,
  type BackendReadinessId,
  type BackendReadinessRecord,
  type BackendReadinessSnapshot,
  type BackendReadinessState,
} from '../../../src/shared/backend-readiness';
import { BACKENDS } from './backends';
import {
  canStartBackendProbe,
  probeRecoveryLabel,
  probeStageLabel,
  readinessDiagnosticGuidance,
  type ActiveBackendProbe,
} from './backend-eligibility';

export interface BackendRowView {
  backendId: BackendReadinessId;
  label: string;
  state: BackendReadinessState;
  statusLabel: string;
  versionEvidence: string;
  diagnosticText: string;
  recoveryLabel: string;
  checkedAtLabel: string;
  canTest: boolean;
  isTesting: boolean;
  canCancel: boolean;
  stageLabel: string;
  accessibleName: string;
}

export type BackendsSectionStateKind = 'loading' | 'settled';

export interface BackendsSectionState {
  kind: BackendsSectionStateKind;
  rows: BackendRowView[];
  readyCount: number;
  passiveCount: number;
  summaryText: string;
}

export type FirstRunStepId = 'install' | 'refresh' | 'test' | 'first-task';

export type FirstRunStepState = 'done' | 'active' | 'todo';

export interface FirstRunStep {
  id: FirstRunStepId;
  label: string;
  state: FirstRunStepState;
}

export interface FirstRunJourney {
  visible: boolean;
  activeStepId: FirstRunStepId;
  steps: FirstRunStep[];
  headline: string;
  detail: string;
}

const STEP_LABELS: Record<FirstRunStepId, string> = {
  install: 'Install a supported agent CLI',
  refresh: 'Refresh backend inventory',
  test: 'Test Connection',
  'first-task': 'Start your first task',
};

const STEP_ORDER: FirstRunStepId[] = ['install', 'refresh', 'test', 'first-task'];

function backendLabel(id: string): string {
  return BACKENDS.find((b) => b.id === id)?.label ?? id;
}

function statusLabelFor(state: BackendReadinessState): string {
  switch (state) {
    case 'checking':
      return 'Checking';
    case 'missing':
      return 'Not installed';
    case 'installed_unverified':
      return 'Installed, unverified';
    case 'testing':
      return 'Testing';
    case 'ready':
      return 'Ready';
    case 'auth_required':
      return 'Sign in required';
    case 'incompatible':
      return 'Incompatible';
    case 'failed':
      return 'Failed';
    default:
      return state;
  }
}

function formatCheckedAtLabel(checkedAt: string): string {
  if (typeof checkedAt !== 'string' || checkedAt.length === 0) return '';
  const ms = Date.parse(checkedAt);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function buildAccessibleName(parts: {
  label: string;
  statusLabel: string;
  diagnosticText: string;
}): string {
  const chunks = [parts.label, parts.statusLabel];
  if (parts.diagnosticText) chunks.push(parts.diagnosticText);
  return chunks.join('. ');
}

/**
 * Build one presentation row per settled readiness record.
 * Returns [] when the snapshot is absent or still checking — callers use
 * `resolveBackendsSectionState` to distinguish loading from settled-empty.
 */
export function buildBackendRowViews(input: {
  snapshot: BackendReadinessSnapshot | null | undefined;
  activeProbe: ActiveBackendProbe | null;
}): BackendRowView[] {
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.phase !== 'settled') return [];

  return snapshot.backends.map((record) => {
    const label = backendLabel(record.backendId);
    const statusLabel = statusLabelFor(record.state);
    const diagnosticText = readinessDiagnosticGuidance(record);
    const recoveryLabel = probeRecoveryLabel(record.recoveryAction);
    const activeForBackend =
      input.activeProbe && input.activeProbe.backendId === record.backendId
        ? input.activeProbe
        : null;
    const isTesting = record.state === 'testing' || activeForBackend != null;
    const canCancel = activeForBackend != null;
    const canTest = isTesting ? false : canStartBackendProbe(record);
    const stageLabel = isTesting
      ? probeStageLabel(activeForBackend?.stage ?? null)
      : '';
    const versionEvidence =
      typeof record.versionEvidence === 'string' ? record.versionEvidence : '';
    const checkedAtLabel = formatCheckedAtLabel(record.checkedAt);
    const accessibleName = buildAccessibleName({
      label,
      statusLabel,
      diagnosticText,
    });

    return {
      backendId: record.backendId,
      label,
      state: record.state,
      statusLabel,
      versionEvidence,
      diagnosticText,
      recoveryLabel,
      checkedAtLabel,
      canTest,
      isTesting,
      canCancel,
      stageLabel,
      accessibleName,
    };
  });
}

function countReady(records: BackendReadinessRecord[]): number {
  return records.filter(isTrustworthyFirstRunEligible).length;
}

function countPassive(records: BackendReadinessRecord[]): number {
  return records.filter(isPassivelySelectable).length;
}

function settledSummaryText(readyCount: number, passiveCount: number, total: number): string {
  if (readyCount > 0) {
    return `${readyCount} of ${total} backends ready.`;
  }
  if (passiveCount > 0) {
    return `${passiveCount} installed backend${passiveCount === 1 ? '' : 's'} awaiting Test Connection.`;
  }
  return 'No supported agent CLIs detected. Install one, then refresh.';
}

/**
 * Section-level presentation state for Agents → Backends.
 * Preserves D056 loading vs settled distinction — never coerces loading to
 * an empty settled provider list.
 */
export function resolveBackendsSectionState(
  snapshot: BackendReadinessSnapshot | null | undefined,
  activeProbe: ActiveBackendProbe | null = null,
): BackendsSectionState {
  if (!snapshot || snapshot.phase !== 'settled') {
    return {
      kind: 'loading',
      rows: [],
      readyCount: 0,
      passiveCount: 0,
      summaryText: 'Checking installed agent CLIs…',
    };
  }

  const rows = buildBackendRowViews({ snapshot, activeProbe });
  const readyCount = countReady(snapshot.backends);
  const passiveCount = countPassive(snapshot.backends);
  return {
    kind: 'settled',
    rows,
    readyCount,
    passiveCount,
    summaryText: settledSummaryText(readyCount, passiveCount, snapshot.backends.length),
  };
}

function buildSteps(activeStepId: FirstRunStepId): FirstRunStep[] {
  const activeIndex = STEP_ORDER.indexOf(activeStepId);
  return STEP_ORDER.map((id, index) => {
    let state: FirstRunStepState;
    if (index < activeIndex) state = 'done';
    else if (index === activeIndex) state = 'active';
    else state = 'todo';
    return { id, label: STEP_LABELS[id], state };
  });
}

function hiddenJourney(activeStepId: FirstRunStepId = 'install'): FirstRunJourney {
  return {
    visible: false,
    activeStepId,
    steps: buildSteps(activeStepId),
    headline: '',
    detail: '',
  };
}

/**
 * Derived first-run journey from host readiness + task history.
 * Never backed by a durable onboarding-complete flag (CONTEXT decision).
 *
 * - hidden while snapshot is loading (avoid flashing guidance before evidence)
 * - hidden when taskCount > 0 (existing users are not re-onboarded)
 * - install: settled with zero passively selectable backends
 * - test: at least one passive backend, none trustworthy-ready
 *   (refresh is marked done because a settled snapshot is refresh evidence)
 * - first-task: at least one isTrustworthyFirstRunEligible record
 */
export function resolveFirstRunJourney(input: {
  snapshot: BackendReadinessSnapshot | null | undefined;
  taskCount: number;
}): FirstRunJourney {
  if (input.taskCount > 0) {
    return hiddenJourney('first-task');
  }

  const snapshot = input.snapshot;
  if (!snapshot || snapshot.phase !== 'settled') {
    return hiddenJourney('install');
  }

  const records = snapshot.backends;
  const readyRecords = records.filter(isTrustworthyFirstRunEligible);
  const passiveRecords = records.filter(isPassivelySelectable);

  if (readyRecords.length > 0) {
    const names = readyRecords.map((r) => backendLabel(r.backendId));
    const nameList =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return {
      visible: true,
      activeStepId: 'first-task',
      steps: buildSteps('first-task'),
      headline: 'Ready for your first task',
      detail: `${nameList} is ready. Write a prompt below to create your first task.`,
    };
  }

  if (passiveRecords.length > 0) {
    const names = passiveRecords.map((r) => backendLabel(r.backendId));
    const nameList =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return {
      visible: true,
      activeStepId: 'test',
      steps: buildSteps('test'),
      headline: 'Test an installed backend',
      detail: `${nameList} is installed but not yet verified. Open backend setup and run Test Connection before your first task.`,
    };
  }

  return {
    visible: true,
    activeStepId: 'install',
    steps: buildSteps('install'),
    headline: 'Install a supported agent CLI',
    detail:
      'No supported agent CLIs were detected. Install Claude, Grok, Kiro, Codex, or Open Code, then refresh backends.',
  };
}
