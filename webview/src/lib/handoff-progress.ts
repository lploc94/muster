/**
 * Pure helpers for task-scoped model-switch handoff chrome.
 *
 * Progress is rendered only from sanitized TaskSummary.handoffProgress
 * (phase + backend/model labels + bounded failure). Never digests, session ids,
 * or summary/bootstrap bodies — those stay off webview projection and chat.
 */
import { backendModelLabel } from './backends';
import {
  type HandoffProgress,
  type HandoffProgressBinding,
  type TaskHandoffPhase,
  type TaskSummary,
} from './protocol';

const IN_FLIGHT_PHASES: ReadonlySet<TaskHandoffPhase> = new Set([
  'requested',
  'exporting_context',
  'summarizing_source',
  'preparing_receiver',
  'transferring',
]);

const TERMINAL_PHASES: ReadonlySet<TaskHandoffPhase> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const PHASE_LABELS: Record<TaskHandoffPhase, string> = {
  requested: 'Switch requested',
  exporting_context: 'Exporting conversation…',
  summarizing_source: 'Summarizing source…',
  preparing_receiver: 'Preparing receiver…',
  transferring: 'Transferring…',
  completed: 'Switch complete',
  failed: 'Switch failed',
  cancelled: 'Switch cancelled',
};

/** True while a handoff is still running (blocks a second switch request). */
export function isHandoffInFlight(phase: TaskHandoffPhase | null | undefined): boolean {
  return !!phase && IN_FLIGHT_PHASES.has(phase);
}

/** True for completed / failed / cancelled handoff phases. */
export function isHandoffTerminal(phase: TaskHandoffPhase | null | undefined): boolean {
  return !!phase && TERMINAL_PHASES.has(phase);
}

export function isHandoffProgressInFlight(
  progress: HandoffProgress | null | undefined,
): boolean {
  return isHandoffInFlight(progress?.phase);
}

/**
 * Local UI lifecycle for the model-picker handoff status.
 *
 * The host deliberately persists terminal handoff metadata. A terminal record
 * is therefore state, not a fresh notification: rendering it on mount or on
 * every snapshot would replay an old "Switch complete" status after chat/reload.
 * We only toast a terminal operation when this mounted composer observed the
 * same operation in flight first.
 */
export interface HandoffChromeVisibilityState {
  taskId: string | null;
  observedInFlightOperationId: string | null;
  terminalToastOperationId: string | null;
  dismissedTerminalOperationId: string | null;
}

export function initialHandoffChromeVisibilityState(): HandoffChromeVisibilityState {
  return {
    taskId: null,
    observedInFlightOperationId: null,
    terminalToastOperationId: null,
    dismissedTerminalOperationId: null,
  };
}

function sameChromeVisibilityState(
  left: HandoffChromeVisibilityState,
  right: HandoffChromeVisibilityState,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.observedInFlightOperationId === right.observedInFlightOperationId &&
    left.terminalToastOperationId === right.terminalToastOperationId &&
    left.dismissedTerminalOperationId === right.dismissedTerminalOperationId
  );
}

/** Advance one-operation UI visibility without replaying persisted terminals. */
export function reduceHandoffChromeVisibility(
  state: HandoffChromeVisibilityState,
  taskId: string | null | undefined,
  progress: HandoffProgress | null | undefined,
): HandoffChromeVisibilityState {
  const nextTaskId = taskId ?? null;
  const taskChanged = state.taskId !== nextTaskId;
  const base: HandoffChromeVisibilityState = taskChanged
    ? {
        taskId: nextTaskId,
        observedInFlightOperationId: null,
        terminalToastOperationId: null,
        dismissedTerminalOperationId: null,
      }
    : state;

  let next = base;
  if (progress && isHandoffInFlight(progress.phase)) {
    next = {
      ...base,
      observedInFlightOperationId: progress.operationId,
      terminalToastOperationId: null,
    };
  } else if (
    progress &&
    isHandoffTerminal(progress.phase) &&
    base.observedInFlightOperationId === progress.operationId &&
    base.dismissedTerminalOperationId !== progress.operationId
  ) {
    next = { ...base, terminalToastOperationId: progress.operationId };
  } else if (base.terminalToastOperationId !== null) {
    next = { ...base, terminalToastOperationId: null };
  }

  return sameChromeVisibilityState(state, next) ? state : next;
}

export function dismissHandoffTerminalToast(
  state: HandoffChromeVisibilityState,
  operationId: string,
): HandoffChromeVisibilityState {
  if (state.terminalToastOperationId !== operationId) return state;
  return {
    ...state,
    terminalToastOperationId: null,
    dismissedTerminalOperationId: operationId,
  };
}

export function shouldShowHandoffChrome(
  state: HandoffChromeVisibilityState,
  taskId: string | null | undefined,
  progress: HandoffProgress | null | undefined,
): boolean {
  if (!progress || state.taskId !== (taskId ?? null)) return false;
  if (isHandoffInFlight(progress.phase)) return true;
  return (
    isHandoffTerminal(progress.phase) &&
    state.terminalToastOperationId === progress.operationId
  );
}

/** Human label for a handoff phase (chrome only). */
export function handoffPhaseLabel(phase: TaskHandoffPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** Backend + optional model label; never session ids. */
export function formatHandoffBinding(binding: HandoffProgressBinding): string {
  return backendModelLabel(binding.backend, binding.model);
}

/**
 * Compact chrome line: phase + source → target.
 * Failed phase appends the bounded failure.message only (not failure.code).
 * Never includes operationId, digests, or session ids.
 */
export function formatHandoffProgressLabel(progress: HandoffProgress): string {
  const phase = handoffPhaseLabel(progress.phase);
  const from = formatHandoffBinding(progress.source);
  const to = formatHandoffBinding(progress.target);
  const base = `${phase}: ${from} → ${to}`;
  if (progress.phase === 'failed' && progress.failure?.message?.trim()) {
    return `${base} — ${progress.failure.message.trim()}`;
  }
  return base;
}

/**
 * Whether the webview may post requestRuntimeHandoff for this task.
 * Product rule: the CLI+model picker is never blocked by runtime activity or
 * handoff chrome — start uses the picker to choose; later changes request handoff.
 * Host still refuses same-binding / live-turn / active-handoff / missing-task
 * with commandError (engine gates), not by greying out the picker.
 */
export function canRequestRuntimeHandoff(task: TaskSummary | null | undefined): boolean {
  if (!task) return false;
  // Soft/hard terminals are not model-switch targets; reopen/send first.
  return task.lifecycle === 'open';
}
