import type { TaskRuntimeActivity, TaskSummary, TurnActivity } from './protocol';
import { effectiveRuntimeActivity } from './protocol';
import type { TaskStatusTone } from './task-status';

/**
 * Client presentation of host TurnActivity (or client fallback when host omits it).
 */
export type TurnActivityState =
  | 'queued'
  | 'executing'
  | 'waiting_you'
  | 'failed_turn'
  | 'uncertain'
  | 'null';

export interface TurnActivityPresentation {
  state: TurnActivityState;
  label: string;
  hint: string;
  detail: string;
  tone: TaskStatusTone;
  icon: string;
  /** When false, composer shows no activity strip (ready / between turns). */
  showStrip: boolean;
}

const PRESENTATIONS: Record<
  Exclude<TurnActivityState, 'null'>,
  Omit<TurnActivityPresentation, 'state' | 'showStrip'>
> = {
  executing: {
    label: 'Working',
    hint: 'turn in progress',
    detail: 'A turn is executing for this task.',
    tone: 'attention',
    icon: 'loading',
  },
  waiting_you: {
    label: 'Waiting for you',
    hint: 'answer required',
    detail: 'The turn is waiting for your answer.',
    tone: 'info',
    icon: 'debug-pause',
  },
  queued: {
    label: 'Queued',
    hint: 'waiting to start',
    detail: 'A turn is queued and will start when ready.',
    tone: 'muted',
    icon: 'clock',
  },
  failed_turn: {
    label: 'Could not finish',
    hint: 'turn needs attention',
    detail: 'The last turn could not finish. The task stays open.',
    tone: 'danger',
    icon: 'warning',
  },
  uncertain: {
    label: 'Status unclear',
    hint: 'continue or run again',
    detail: 'Status is unclear — continue or run again?',
    tone: 'warning',
    icon: 'question',
  },
};

const WAIT_REASON_LABELS: Record<string, string> = {
  dependencies: 'Waiting on dependencies',
  children: 'Waiting on child tasks',
  external: 'Waiting on external blocker',
  held_after_failure: 'Paused after previous turn',
  live_turn_ahead: 'Queued behind live turn',
};

/** Map open-task runtime (+ live stream flags) to turn activity chrome (client fallback). */
export function deriveTurnActivityState(input: {
  lifecycle: string;
  runtimeActivity: TaskRuntimeActivity | null | undefined;
  threadRunning?: boolean;
  askPending?: boolean;
}): TurnActivityState {
  const runtime = input.runtimeActivity ?? null;

  if (input.askPending || runtime === 'waiting_user') {
    return 'waiting_you';
  }
  if (input.threadRunning || runtime === 'running') {
    return 'executing';
  }
  if (runtime === 'queued') {
    return 'queued';
  }
  if (runtime === 'needs_recovery') {
    return 'failed_turn';
  }
  return 'null';
}

export function turnActivityStateFromHost(activity: TurnActivity | undefined): TurnActivityState | undefined {
  if (activity === undefined) return undefined;
  if (activity === null) return 'null';
  switch (activity.state) {
    case 'executing':
      return 'executing';
    case 'waiting_you':
      return 'waiting_you';
    case 'queued':
      return 'queued';
    case 'failed_turn':
      return 'failed_turn';
    case 'uncertain':
      return 'uncertain';
    default:
      return 'null';
  }
}

/**
 * Host-authoritative `currentTurnActivity` (protocol v3). Optional local
 * askPending may only promote chrome to waiting_you while a card is open.
 */
export function turnActivityFromTask(
  task: Pick<TaskSummary, 'lifecycle' | 'runtimeActivity' | 'viewStatus'> & {
    currentTurnActivity?: TurnActivity;
  },
  opts?: { threadRunning?: boolean; askPending?: boolean },
): TurnActivityState {
  if ('currentTurnActivity' in task && task.currentTurnActivity !== undefined) {
    const fromHost = turnActivityStateFromHost(task.currentTurnActivity) ?? 'null';
    if (opts?.askPending && fromHost !== 'waiting_you') {
      return 'waiting_you';
    }
    return fromHost;
  }
  // Draft / pre-host path only.
  return deriveTurnActivityState({
    lifecycle: task.lifecycle,
    runtimeActivity: effectiveRuntimeActivity(task),
    threadRunning: opts?.threadRunning,
    askPending: opts?.askPending,
  });
}

export function getTurnActivityPresentation(
  state: TurnActivityState,
  opts?: { waitReason?: string; hostActivity?: TurnActivity },
): TurnActivityPresentation {
  if (state === 'null') {
    return {
      state: 'null',
      label: '',
      hint: '',
      detail: '',
      tone: 'muted',
      icon: 'circle-outline',
      showStrip: false,
    };
  }
  const base = { state, showStrip: true, ...PRESENTATIONS[state] };
  if (state === 'queued') {
    const reason =
      opts?.waitReason ??
      (opts?.hostActivity && opts.hostActivity.state === 'queued' ? opts.hostActivity.waitReason : undefined);
    if (reason && WAIT_REASON_LABELS[reason]) {
      return {
        ...base,
        label: WAIT_REASON_LABELS[reason],
        hint: reason.replace(/_/g, ' '),
        detail: WAIT_REASON_LABELS[reason],
      };
    }
  }
  return base;
}
