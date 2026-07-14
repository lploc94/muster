/**
 * @deprecated Phase A (task-chat-turn-hide-cli): product chrome no longer uses CLI process
 * vocabulary. Prefer `turn-activity.ts`. Host-owned `currentTurnActivity` lands in Phase B.
 * Kept only for transitional unit tests; do not import from UI components.
 */

import type { TaskRuntimeActivity, TaskSummary } from './protocol';
import { effectiveRuntimeActivity } from './protocol';
import type { TaskStatusTone } from './task-status';

/** @deprecated Use TurnActivityState from turn-activity.ts */
export type CliViewStatus = 'not_started' | 'running' | 'idle' | 'stopped';

/** @deprecated Use CliViewStatus */
export type CliProcessStatus = CliViewStatus;

/** @deprecated */
export type CliLastExit = 'ok' | 'error' | 'cancelled' | 'unknown';

/** @deprecated */
export interface CliStatusPresentation {
  status: CliViewStatus;
  label: string;
  shortLabel: string;
  detail: string;
  hint: string;
  tone: TaskStatusTone;
  icon: string;
}

/** @deprecated Product UI must not use CLI labels. */
export const CLI_STATUS_PRESENTATIONS = {
  not_started: {
    status: 'not_started',
    label: 'Not started',
    shortLabel: 'Not started',
    detail: 'No turn has started for this task yet.',
    hint: 'no turn yet',
    tone: 'muted',
    icon: 'circle-outline',
  },
  running: {
    status: 'running',
    label: 'Working',
    shortLabel: 'Working',
    detail: 'A turn is executing (streaming, tools, or reasoning).',
    hint: 'turn generating',
    tone: 'attention',
    icon: 'loading',
  },
  idle: {
    status: 'idle',
    label: 'Waiting for you',
    shortLabel: 'Waiting',
    detail: 'A turn is waiting for your answer (ask_user) or the next prompt.',
    hint: 'turn waiting',
    tone: 'info',
    icon: 'debug-pause',
  },
  stopped: {
    status: 'stopped',
    label: 'Idle',
    shortLabel: 'Idle',
    detail: 'No live turn. Task outcome is separate from turn state.',
    hint: 'no live turn',
    tone: 'muted',
    icon: 'debug-disconnect',
  },
} as const satisfies Record<CliViewStatus, CliStatusPresentation>;

/** @deprecated */
export const CLI_LAST_EXIT_LABELS: Record<CliLastExit, string> = {
  ok: 'clean exit',
  error: 'exited with error',
  cancelled: 'cancelled',
  unknown: 'exit reason unknown',
};

/** @deprecated Prefer deriveTurnActivityState */
export function deriveCliViewStatus(input: {
  lifecycle: string;
  runtimeActivity: TaskRuntimeActivity | null | undefined;
  threadRunning?: boolean;
  askPending?: boolean;
  hadProcess?: boolean;
}): CliViewStatus {
  const runtime = input.runtimeActivity ?? null;

  if (input.askPending || runtime === 'waiting_user') {
    return 'idle';
  }

  if (input.threadRunning || runtime === 'running') {
    return 'running';
  }

  if (runtime === 'queued') {
    return 'not_started';
  }

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

  if (input.hadProcess === true) {
    return 'stopped';
  }
  if (input.hadProcess === false) {
    return 'not_started';
  }
  return 'not_started';
}

/** @deprecated */
export const deriveCliProcessStatus = deriveCliViewStatus;

/** @deprecated */
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

/** @deprecated */
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

/** @deprecated */
export function getCliStatusPresentation(status: CliViewStatus): CliStatusPresentation {
  return CLI_STATUS_PRESENTATIONS[status];
}

/** @deprecated */
export const cliStatusFromTaskLegacy = cliStatusFromTask;
