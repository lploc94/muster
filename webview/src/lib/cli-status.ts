import type { TaskRuntimeActivity, TaskSummary } from './protocol';
import { effectiveRuntimeActivity } from './protocol';
import type { TaskStatusTone } from './task-status';

/**
 * Product-facing CLI chip (docs/TASK-MANAGEMENT.md §4.3.2).
 * Independent of task lifecycle.
 *
 * - not_started — process not created yet
 * - running     — process on + generating (busy)
 * - idle        — process on + not generating (incl. ask_user)
 * - stopped     — process exited (see lastExit for why — error is not a phase)
 */
export type CliViewStatus = 'not_started' | 'running' | 'idle' | 'stopped';

/** @deprecated Use CliViewStatus */
export type CliProcessStatus = CliViewStatus;

/**
 * How the last process ended — not a peer of CliViewStatus.
 * Only meaningful when view status is `stopped`.
 */
export type CliLastExit = 'ok' | 'error' | 'cancelled' | 'unknown';

export interface CliStatusPresentation {
  status: CliViewStatus;
  label: string;
  shortLabel: string;
  detail: string;
  hint: string;
  tone: TaskStatusTone;
  /** codicon class without "codicon-" prefix */
  icon: string;
}

export const CLI_STATUS_PRESENTATIONS = {
  not_started: {
    status: 'not_started',
    label: 'CLI not started',
    shortLabel: 'Not started',
    detail: 'No CLI process has been created for this task yet.',
    hint: 'no process yet',
    tone: 'muted',
    icon: 'circle-outline',
  },
  running: {
    status: 'running',
    label: 'CLI running',
    shortLabel: 'Running',
    detail: 'A CLI process is alive and generating (streaming, tools, or reasoning).',
    hint: 'process generating',
    tone: 'attention',
    icon: 'loading',
  },
  idle: {
    status: 'idle',
    label: 'CLI idle',
    shortLabel: 'Idle',
    detail:
      'A CLI process is alive but not generating — waiting for you (ask_user) or the next prompt.',
    hint: 'process waiting',
    tone: 'info',
    icon: 'debug-pause',
  },
  stopped: {
    status: 'stopped',
    label: 'CLI stopped',
    shortLabel: 'Stopped',
    detail: 'The CLI process has exited. Task outcome is separate from process state.',
    hint: 'process exited',
    tone: 'muted',
    icon: 'debug-disconnect',
  },
} as const satisfies Record<CliViewStatus, CliStatusPresentation>;

export const CLI_LAST_EXIT_LABELS: Record<CliLastExit, string> = {
  ok: 'clean exit',
  error: 'exited with error',
  cancelled: 'cancelled',
  unknown: 'exit reason unknown',
};

/**
 * Derive product CLI view from orchestration/runtime signals + live thread flags.
 *
 * Order:
 * 1. waiting_user → idle (process on, not generating)
 * 2. running / thread streaming → running
 * 3. queued only → not_started
 * 4. post-process orchestration / had process → stopped
 * 5. never ran → not_started
 */
export function deriveCliViewStatus(input: {
  lifecycle: string;
  runtimeActivity: TaskRuntimeActivity | null | undefined;
  /** True when the webview has an in-flight stream (generating). */
  threadRunning?: boolean;
  /** True when an ask is pending (process on, waiting for user). */
  askPending?: boolean;
  /** True when the task has had at least one process start. */
  hadProcess?: boolean;
}): CliViewStatus {
  const runtime = input.runtimeActivity ?? null;

  // Process on + waiting for user (ask_user) → idle, not "running".
  if (input.askPending || runtime === 'waiting_user') {
    return 'idle';
  }

  // Process on + generating.
  if (input.threadRunning || runtime === 'running') {
    return 'running';
  }

  // Scheduled but not spawned.
  if (runtime === 'queued') {
    return 'not_started';
  }

  // No live process; work may continue via orchestration.
  if (
    runtime === 'needs_recovery' ||
    runtime === 'waiting_children' ||
    runtime === 'blocked' ||
    runtime === 'awaiting_outcome'
  ) {
    return 'stopped';
  }

  if (input.lifecycle !== 'open') {
    return input.hadProcess === false ? 'not_started' : 'stopped';
  }

  // open + idle orchestration
  if (input.hadProcess === true) {
    return 'stopped';
  }
  if (input.hadProcess === false) {
    return 'not_started';
  }
  return 'not_started';
}

/** @deprecated Use deriveCliViewStatus */
export const deriveCliProcessStatus = deriveCliViewStatus;

/**
 * Best-effort last exit from latest settled turn status (when known).
 * Error is never a CliViewStatus — only lastExit when stopped.
 */
export function deriveCliLastExit(input: {
  cliView: CliViewStatus;
  latestTerminalTurnStatus?: 'succeeded' | 'failed' | 'interrupted' | 'cancelled' | string | null;
}): CliLastExit | null {
  if (input.cliView !== 'stopped') {
    return null;
  }
  switch (input.latestTerminalTurnStatus) {
    case 'succeeded':
      return 'ok';
    case 'failed':
      return 'error';
    case 'interrupted':
    case 'cancelled':
      return 'cancelled';
    default:
      return input.latestTerminalTurnStatus ? 'unknown' : 'unknown';
  }
}

export function cliStatusFromTask(
  task: Pick<TaskSummary, 'lifecycle' | 'runtimeActivity' | 'viewStatus'>,
  opts?: {
    threadRunning?: boolean;
    askPending?: boolean;
    hadProcess?: boolean;
  },
): CliViewStatus {
  return deriveCliViewStatus({
    lifecycle: task.lifecycle,
    runtimeActivity: effectiveRuntimeActivity(task),
    threadRunning: opts?.threadRunning,
    askPending: opts?.askPending,
    hadProcess: opts?.hadProcess,
  });
}

export function getCliStatusPresentation(status: CliViewStatus): CliStatusPresentation {
  return CLI_STATUS_PRESENTATIONS[status];
}

/** @deprecated Alias */
export const cliStatusFromTaskLegacy = cliStatusFromTask;
