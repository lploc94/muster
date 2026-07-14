/**
 * Pure helpers for task-scoped model-switch handoff chrome.
 *
 * Progress is rendered only from sanitized TaskSummary.handoffProgress
 * (phase + backend/model labels + bounded failure). Never digests, session ids,
 * or summary/bootstrap bodies — those stay off webview projection and chat.
 */
import { backendModelLabel } from './backends';
import {
  effectiveRuntimeActivity,
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
 * Host still refuses same-binding / live-turn / missing-task with commandError.
 */
export function canRequestRuntimeHandoff(task: TaskSummary | null | undefined): boolean {
  if (!task) return false;
  if (task.lifecycle !== 'open') return false;
  if (isHandoffProgressInFlight(task.handoffProgress)) return false;
  const runtime = effectiveRuntimeActivity(task);
  // Allow when runtime is idle, awaiting_outcome, or unset (legacy projections).
  if (runtime == null || runtime === 'idle' || runtime === 'awaiting_outcome') {
    return true;
  }
  return false;
}
