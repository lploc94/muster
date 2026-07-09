import type { TaskViewStatus } from './protocol';

export type TaskStatusTone = 'neutral' | 'info' | 'attention' | 'success' | 'warning' | 'danger' | 'muted';

export interface TaskStatusPresentation {
  status: TaskViewStatus;
  label: string;
  tone: TaskStatusTone;
  listCopy: string;
  workspaceHeadline: string;
  workspaceDetail: string;
  composerGuidance: string;
}

export const TASK_VIEW_STATUSES = [
  'waiting_dependencies',
  'queued',
  'running',
  'waiting_user',
  'waiting_children',
  'blocked',
  'needs_recovery',
  'idle',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const satisfies readonly TaskViewStatus[];

export const TASK_STATUS_PRESENTATIONS = {
  waiting_dependencies: {
    status: 'waiting_dependencies',
    label: 'Waiting on dependencies',
    tone: 'muted',
    listCopy: 'Waiting for upstream tasks',
    workspaceHeadline: 'Waiting on dependencies',
    workspaceDetail: 'This task cannot start until its prerequisite tasks finish successfully.',
    composerGuidance: 'You can review the plan, but sending is paused until dependencies clear.',
  },
  queued: {
    status: 'queued',
    label: 'Queued',
    tone: 'info',
    listCopy: 'Ready and queued',
    workspaceHeadline: 'Queued for execution',
    workspaceDetail: 'The task is ready and waiting for the runtime to pick it up.',
    composerGuidance: 'Hold new instructions unless you want to adjust the queued work before it starts.',
  },
  running: {
    status: 'running',
    label: 'Running',
    tone: 'attention',
    listCopy: 'Agent is working',
    workspaceHeadline: 'Task is running',
    workspaceDetail: 'The assigned agent is actively processing this task and may stream updates here.',
    composerGuidance: 'Composer is disabled while the active turn is running; wait or cancel before sending more.',
  },
  waiting_user: {
    status: 'waiting_user',
    label: 'Waiting for you',
    tone: 'attention',
    listCopy: 'Needs your answer',
    workspaceHeadline: 'Input required',
    workspaceDetail: 'The agent paused for a question or decision before it can continue.',
    composerGuidance: 'Answer the pending prompt to unblock the task.',
  },
  waiting_children: {
    status: 'waiting_children',
    label: 'Waiting on child tasks',
    tone: 'info',
    listCopy: 'Child tasks in progress',
    workspaceHeadline: 'Waiting on child tasks',
    workspaceDetail: 'This task is paused while delegated child work finishes.',
    composerGuidance: 'Review child task progress before adding new parent-level instructions.',
  },
  blocked: {
    status: 'blocked',
    label: 'Blocked',
    tone: 'warning',
    listCopy: 'Blocked by a dependency or decision',
    workspaceHeadline: 'Task is blocked',
    workspaceDetail: 'The runtime cannot make progress until the blocking condition is resolved.',
    composerGuidance: 'Use the visible blocker details to decide whether to revise, continue, or recover.',
  },
  needs_recovery: {
    status: 'needs_recovery',
    label: 'Needs recovery',
    tone: 'danger',
    listCopy: 'Recovery required',
    workspaceHeadline: 'Recovery needed',
    workspaceDetail: 'The last run failed in a way that needs explicit recovery before normal work resumes.',
    composerGuidance: 'Review the failure, then retry or continue with recovery instructions.',
  },
  idle: {
    status: 'idle',
    label: 'Idle',
    tone: 'neutral',
    listCopy: 'Ready for instructions',
    workspaceHeadline: 'Ready for work',
    workspaceDetail: 'No turn is currently running for this task.',
    composerGuidance: 'Send an instruction to start or continue work on this task.',
  },
  succeeded: {
    status: 'succeeded',
    label: 'Succeeded',
    tone: 'success',
    listCopy: 'Finished successfully',
    workspaceHeadline: 'Task succeeded',
    workspaceDetail: 'The task reached a successful terminal state.',
    composerGuidance: 'This task is closed; use Continue as new task for follow-up work.',
  },
  failed: {
    status: 'failed',
    label: 'Failed',
    tone: 'danger',
    listCopy: 'Finished with failure',
    workspaceHeadline: 'Task failed',
    workspaceDetail: 'The task reached a failed terminal state and may need review or a new task.',
    composerGuidance: 'This task is closed; use Continue as new task for follow-up work.',
  },
  cancelled: {
    status: 'cancelled',
    label: 'Cancelled',
    tone: 'muted',
    listCopy: 'Stopped before finishing',
    workspaceHeadline: 'Task cancelled',
    workspaceDetail: 'The task was stopped before it could finish.',
    composerGuidance: 'This task is closed; use Continue as new task for follow-up work.',
  },
  skipped: {
    status: 'skipped',
    label: 'Skipped',
    tone: 'muted',
    listCopy: 'Intentionally skipped',
    workspaceHeadline: 'Task skipped',
    workspaceDetail: 'The task was intentionally bypassed and will not run in this flow.',
    composerGuidance: 'This task is closed; use Continue as new task for follow-up work.',
  },
} as const satisfies Record<TaskViewStatus, TaskStatusPresentation>;

const TASK_STATUS_SET = new Set<string>(TASK_VIEW_STATUSES);

export function isTaskViewStatus(status: unknown): status is TaskViewStatus {
  return typeof status === 'string' && TASK_STATUS_SET.has(status);
}

export function isTaskStatusTerminal(status: TaskViewStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

export function getTaskStatusPresentation(status: TaskViewStatus | string | null | undefined): TaskStatusPresentation {
  if (isTaskViewStatus(status)) {
    return TASK_STATUS_PRESENTATIONS[status];
  }

  const displayedStatus = typeof status === 'string' && status.trim() !== '' ? status : 'missing';

  return {
    status: 'idle',
    label: 'Unknown status',
    tone: 'muted',
    listCopy: 'Unknown task state',
    workspaceHeadline: 'Unknown task state',
    workspaceDetail: `The host reported an unsupported task status (${displayedStatus}); the UI is showing a safe idle fallback.`,
    composerGuidance: 'Refresh the webview or inspect host logs before sending new instructions.',
  };
}

export function taskStatusLabel(status: TaskViewStatus | string | null | undefined): string {
  return getTaskStatusPresentation(status).label;
}
