import type {
  TaskLifecycleState,
  TaskRuntimeActivity,
  TaskSummary,
  TaskViewStatus,
} from './protocol';
import { effectiveRuntimeActivity, isHardTerminalLifecycle, isSoftTerminalLifecycle } from './protocol';

export type TaskStatusTone = 'neutral' | 'info' | 'attention' | 'success' | 'warning' | 'danger' | 'muted';

export interface StatusAxisPresentation {
  key: string;
  label: string;
  tone: TaskStatusTone;
  listCopy: string;
  workspaceHeadline: string;
  workspaceDetail: string;
  composerGuidance: string;
}

/** Combined presentation for list/workspace chrome. */
export interface TaskStatusPresentation {
  /** @deprecated Prefer lifecycle + runtime; kept for callers that pass a single axis. */
  status: TaskViewStatus;
  label: string;
  tone: TaskStatusTone;
  listCopy: string;
  workspaceHeadline: string;
  workspaceDetail: string;
  composerGuidance: string;
  lifecycle: StatusAxisPresentation;
  runtime: StatusAxisPresentation | null;
}

export const TASK_LIFECYCLE_STATES = [
  'open',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const satisfies readonly TaskLifecycleState[];

export const TASK_RUNTIME_ACTIVITIES = [
  'waiting_dependencies',
  'queued',
  'running',
  'waiting_user',
  'waiting_children',
  'blocked',
  'needs_recovery',
  'idle',
  'awaiting_outcome',
] as const satisfies readonly TaskRuntimeActivity[];

/** Compact axis values the host may still send as viewStatus. */
export const TASK_VIEW_STATUSES = [
  ...TASK_RUNTIME_ACTIVITIES,
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const satisfies readonly TaskViewStatus[];

export const LIFECYCLE_PRESENTATIONS = {
  open: {
    key: 'open',
    label: 'Open',
    tone: 'neutral',
    listCopy: 'Work in progress',
    workspaceHeadline: 'Task is open',
    workspaceDetail: 'This task has not been sealed as done, failed, cancelled, or skipped.',
    composerGuidance: 'Send instructions while the task is open and the runtime is idle.',
  },
  succeeded: {
    key: 'succeeded',
    label: 'Succeeded',
    tone: 'success',
    listCopy: 'Marked complete',
    workspaceHeadline: 'Task succeeded',
    workspaceDetail: 'An authorized actor sealed this task as successfully completed.',
    composerGuidance: 'This task is closed; use Continue as new task for follow-up work.',
  },
  failed: {
    key: 'failed',
    label: 'Failed',
    tone: 'danger',
    listCopy: 'Marked failed (soft)',
    workspaceHeadline: 'Task failed',
    workspaceDetail:
      'This attempt was sealed as unsuccessful. Send a message to reopen the same task, or start a new one.',
    composerGuidance: 'Send a message to reopen this task and continue, or create a new task.',
  },
  cancelled: {
    key: 'cancelled',
    label: 'Cancelled',
    tone: 'muted',
    listCopy: 'Cancelled',
    workspaceHeadline: 'Task cancelled',
    workspaceDetail: 'The task was cancelled before it finished (including cascaded cancels).',
    composerGuidance: 'This task is closed; use Continue as new task for related work.',
  },
  skipped: {
    key: 'skipped',
    label: 'Skipped',
    tone: 'muted',
    listCopy: 'Won’t perform',
    workspaceHeadline: 'Task skipped',
    workspaceDetail: 'This task was created but deliberately marked as will not be performed.',
    composerGuidance: 'This task is closed; create a new task if you want to do this work later.',
  },
} as const satisfies Record<TaskLifecycleState, StatusAxisPresentation>;

export const RUNTIME_PRESENTATIONS = {
  waiting_dependencies: {
    key: 'waiting_dependencies',
    label: 'Waiting on dependencies',
    tone: 'muted',
    listCopy: 'Waiting for upstream tasks',
    workspaceHeadline: 'Waiting on dependencies',
    workspaceDetail: 'Runtime cannot start until prerequisite tasks settle.',
    composerGuidance: 'You can review the plan; progress is blocked on dependencies.',
  },
  queued: {
    key: 'queued',
    label: 'Queued',
    tone: 'info',
    listCopy: 'Turn queued',
    workspaceHeadline: 'Queued for execution',
    workspaceDetail: 'A turn is ready and waiting for the scheduler.',
    composerGuidance: 'A turn is queued; hold new instructions unless adjusting before start.',
  },
  running: {
    key: 'running',
    label: 'Running',
    tone: 'attention',
    listCopy: 'CLI turn active',
    workspaceHeadline: 'Turn is running',
    workspaceDetail: 'A CLI process is active for this task (runtime only — not task outcome).',
    composerGuidance: 'Composer is disabled while a turn is running; wait or cancel the turn.',
  },
  waiting_user: {
    key: 'waiting_user',
    label: 'Waiting for you',
    tone: 'attention',
    listCopy: 'Needs your answer',
    workspaceHeadline: 'Input required',
    workspaceDetail: 'The live turn paused for ask_user (or similar) before it can continue.',
    composerGuidance: 'Answer the pending prompt to unblock the turn.',
  },
  waiting_children: {
    key: 'waiting_children',
    label: 'Waiting on child tasks',
    tone: 'info',
    listCopy: 'Child tasks in progress',
    workspaceHeadline: 'Waiting on child tasks',
    workspaceDetail: 'Parent is open while an explicit child wait barrier settles.',
    composerGuidance: 'Review child progress; messages wait for the next continuation turn.',
  },
  blocked: {
    key: 'blocked',
    label: 'Blocked',
    tone: 'warning',
    listCopy: 'Blocked externally',
    workspaceHeadline: 'Task is blocked',
    workspaceDetail: 'An external wait is blocking progress.',
    composerGuidance: 'Resolve the blocker before expecting further runtime progress.',
  },
  needs_recovery: {
    key: 'needs_recovery',
    label: 'Needs recovery',
    tone: 'danger',
    listCopy: 'Turn recovery needed',
    workspaceHeadline: 'Turn recovery needed',
    workspaceDetail:
      'The last CLI turn failed or was interrupted. The task remains open until you recover or continue.',
    composerGuidance: 'Retry or continue with recovery instructions — this is not a sealed task failure.',
  },
  idle: {
    key: 'idle',
    label: 'Idle',
    tone: 'info',
    listCopy: 'No active turn',
    workspaceHeadline: 'Runtime idle',
    workspaceDetail: 'No turn is running; the open task is ready for the next instruction.',
    composerGuidance: 'Send an instruction to start or continue work on this open task.',
  },
  awaiting_outcome: {
    key: 'awaiting_outcome',
    label: 'Review outcome',
    tone: 'attention',
    listCopy: 'Outcome proposal pending',
    workspaceHeadline: 'Outcome needs a decision',
    workspaceDetail:
      'An agent proposed complete/fail. Accept or reject (or let an authorized coordinator seal under delegate mode).',
    composerGuidance: 'Accept or reject the outcome proposal before treating the task as sealed.',
  },
} as const satisfies Record<TaskRuntimeActivity, StatusAxisPresentation>;

/** @deprecated Prefer LIFECYCLE_PRESENTATIONS + RUNTIME_PRESENTATIONS. */
export const TASK_STATUS_PRESENTATIONS = {
  ...RUNTIME_PRESENTATIONS,
  succeeded: LIFECYCLE_PRESENTATIONS.succeeded,
  failed: LIFECYCLE_PRESENTATIONS.failed,
  cancelled: LIFECYCLE_PRESENTATIONS.cancelled,
  skipped: LIFECYCLE_PRESENTATIONS.skipped,
} as const;

const LIFECYCLE_SET = new Set<string>(TASK_LIFECYCLE_STATES);
const RUNTIME_SET = new Set<string>(TASK_RUNTIME_ACTIVITIES);
const VIEW_STATUS_SET = new Set<string>(TASK_VIEW_STATUSES);

export function isTaskLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === 'string' && LIFECYCLE_SET.has(value);
}

export function isTaskRuntimeActivity(value: unknown): value is TaskRuntimeActivity {
  return typeof value === 'string' && RUNTIME_SET.has(value);
}

export function isTaskViewStatus(status: unknown): status is TaskViewStatus {
  return typeof status === 'string' && VIEW_STATUS_SET.has(status);
}

/** Hard terminal only (not soft failed). */
export function isTaskStatusTerminal(status: TaskViewStatus | string): boolean {
  return isHardTerminalLifecycle(status);
}

export function isHardTerminal(lifecycle: string): boolean {
  return isHardTerminalLifecycle(lifecycle);
}

export function isSoftTerminal(lifecycle: string): boolean {
  return isSoftTerminalLifecycle(lifecycle);
}

function unknownPresentation(displayed: string): StatusAxisPresentation {
  return {
    key: 'unknown',
    label: 'Unknown status',
    tone: 'muted',
    listCopy: 'Unknown task state',
    workspaceHeadline: 'Unknown task state',
    workspaceDetail: `The host reported an unsupported status (${displayed}); showing a safe fallback.`,
    composerGuidance: 'Refresh the webview or inspect host logs before sending new instructions.',
  };
}

export function getLifecyclePresentation(
  lifecycle: TaskLifecycleState | string | null | undefined,
): StatusAxisPresentation {
  if (isTaskLifecycleState(lifecycle)) {
    return LIFECYCLE_PRESENTATIONS[lifecycle];
  }
  const displayed = typeof lifecycle === 'string' && lifecycle.trim() !== '' ? lifecycle : 'missing';
  return unknownPresentation(displayed);
}

export function getRuntimePresentation(
  activity: TaskRuntimeActivity | string | null | undefined,
): StatusAxisPresentation | null {
  if (activity == null) return null;
  if (isTaskRuntimeActivity(activity)) {
    return RUNTIME_PRESENTATIONS[activity];
  }
  return unknownPresentation(String(activity));
}

/**
 * Resolve presentation for a task summary (preferred) or a legacy single status string.
 */
export function getTaskPresentation(
  taskOrStatus:
    | Pick<TaskSummary, 'lifecycle' | 'runtimeActivity' | 'viewStatus'>
    | TaskViewStatus
    | string
    | null
    | undefined,
): TaskStatusPresentation {
  if (taskOrStatus == null || typeof taskOrStatus === 'string') {
    return getTaskStatusPresentation(taskOrStatus);
  }

  const lifecycleKey = isTaskLifecycleState(taskOrStatus.lifecycle)
    ? taskOrStatus.lifecycle
    : 'open';
  const lifecycle = getLifecyclePresentation(lifecycleKey);
  const runtimeKey = effectiveRuntimeActivity(taskOrStatus);
  const runtime = getRuntimePresentation(runtimeKey);

  // Primary label: lifecycle when not open; when open, prefer runtime for activity chrome
  // but keep lifecycle "Open" as secondary list tone.
  if (lifecycleKey === 'open' && runtime) {
    return {
      status: runtimeKey ?? 'idle',
      label: runtime.label,
      tone: runtime.tone,
      listCopy: `${lifecycle.label} · ${runtime.listCopy}`,
      workspaceHeadline: runtime.workspaceHeadline,
      workspaceDetail: `${lifecycle.workspaceDetail} ${runtime.workspaceDetail}`,
      composerGuidance: runtime.composerGuidance,
      lifecycle,
      runtime,
    };
  }

  // Soft failed: keep failed lifecycle primary, optional soft-reopen guidance.
  if (lifecycleKey === 'failed') {
    return {
      status: 'failed',
      label: lifecycle.label,
      tone: lifecycle.tone,
      listCopy: lifecycle.listCopy,
      workspaceHeadline: lifecycle.workspaceHeadline,
      workspaceDetail: lifecycle.workspaceDetail,
      composerGuidance: lifecycle.composerGuidance,
      lifecycle,
      runtime: null,
    };
  }

  return {
    status: isTaskViewStatus(lifecycleKey) ? lifecycleKey : 'idle',
    label: lifecycle.label,
    tone: lifecycle.tone,
    listCopy: lifecycle.listCopy,
    workspaceHeadline: lifecycle.workspaceHeadline,
    workspaceDetail: lifecycle.workspaceDetail,
    composerGuidance: lifecycle.composerGuidance,
    lifecycle,
    runtime: null,
  };
}

/**
 * Legacy single-axis lookup (viewStatus or raw string).
 * Prefer getTaskPresentation(task) when a TaskSummary is available.
 */
export function getTaskStatusPresentation(
  status: TaskViewStatus | string | null | undefined,
): TaskStatusPresentation {
  if (isTaskLifecycleState(status) && status !== 'open') {
    const lifecycle = LIFECYCLE_PRESENTATIONS[status];
    return {
      status,
      label: lifecycle.label,
      tone: lifecycle.tone,
      listCopy: lifecycle.listCopy,
      workspaceHeadline: lifecycle.workspaceHeadline,
      workspaceDetail: lifecycle.workspaceDetail,
      composerGuidance: lifecycle.composerGuidance,
      lifecycle,
      runtime: null,
    };
  }

  if (isTaskRuntimeActivity(status) || status === 'open') {
    const activity: TaskRuntimeActivity = status === 'open' ? 'idle' : status;
    const runtime = RUNTIME_PRESENTATIONS[activity];
    const lifecycle = LIFECYCLE_PRESENTATIONS.open;
    return {
      status: activity,
      label: runtime.label,
      tone: runtime.tone,
      listCopy: `${lifecycle.label} · ${runtime.listCopy}`,
      workspaceHeadline: runtime.workspaceHeadline,
      workspaceDetail: `${lifecycle.workspaceDetail} ${runtime.workspaceDetail}`,
      composerGuidance: runtime.composerGuidance,
      lifecycle,
      runtime,
    };
  }

  const displayed = typeof status === 'string' && status.trim() !== '' ? status : 'missing';
  const unknown = unknownPresentation(displayed);
  return {
    status: 'idle',
    label: unknown.label,
    tone: unknown.tone,
    listCopy: unknown.listCopy,
    workspaceHeadline: unknown.workspaceHeadline,
    workspaceDetail: unknown.workspaceDetail,
    composerGuidance: unknown.composerGuidance,
    lifecycle: LIFECYCLE_PRESENTATIONS.open,
    runtime: null,
  };
}

export function taskStatusLabel(status: TaskViewStatus | string | null | undefined): string {
  return getTaskStatusPresentation(status).label;
}

/** Runtime activities that block free-form composer send (turn busy or gated). */
export function runtimeBlocksComposer(activity: TaskRuntimeActivity | null | undefined): boolean {
  if (!activity) return false;
  // awaiting_outcome: agent proposed complete but task stays open — user may still
  // send a message (clears proposal and continues session). Do not block.
  return (
    activity === 'running' ||
    activity === 'queued' ||
    activity === 'waiting_dependencies' ||
    activity === 'waiting_children' ||
    activity === 'waiting_user' ||
    activity === 'needs_recovery'
  );
}
