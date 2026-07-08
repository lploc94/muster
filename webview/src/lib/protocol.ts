import { vscode } from './vscode';
import type { NormalizedEvent, Question } from './types';

export type TurnTrigger = 'user' | 'engine' | 'retry';

export type TaskViewStatus =
  | 'waiting_dependencies'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_children'
  | 'blocked'
  | 'needs_recovery'
  | 'idle'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: string;
  lifecycle: string;
  viewStatus: TaskViewStatus;
  updatedAt: string;
  backend: string;
  continuationOf?: string;
}

export interface TranscriptItem {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'reasoning' | 'error';
  content: unknown;
  turnId?: string;
  order?: number;
  state?: string;
}

export interface PendingAsk {
  turnId: string;
  askId: string;
  questions: Question[];
}

export interface SnapshotMessage {
  type: 'snapshot';
  rootTasks: TaskSummary[];
  focusedTaskId?: string;
  subtree?: TaskSummary[];
  transcript?: TranscriptItem[];
  activeTurnId?: string;
  storeRevision: number;
  pendingAsk?: PendingAsk;
}

// Extension host -> webview (protocol v2, TASK-MODEL-PHASE-D-PLAN §4.1)
export type ExtMessage =
  | SnapshotMessage
  | { type: 'taskUpdated'; taskId: string; storeRevision: number; patch: Partial<TaskSummary> }
  | { type: 'turnStart'; taskId: string; turnId: string; trigger: TurnTrigger }
  | { type: 'event'; taskId: string; turnId: string; event: NormalizedEvent }
  | { type: 'turnDone'; taskId: string; turnId: string }
  | { type: 'turnError'; taskId: string; turnId: string; message: string }
  | { type: 'transcriptAppend'; taskId: string; item: TranscriptItem }
  | { type: 'askPending'; taskId: string; turnId: string; askId: string; questions: Question[] }
  | { type: 'askCleared'; taskId: string; turnId: string; askId: string }
  | { type: 'commandError'; taskId?: string; message: string }
  | { type: 'filePicked'; path: string };

export type AskAnswer = { selected: string[]; freeText: string | null };

// Webview -> extension host (protocol v2)
export type OutMessage =
  | { type: 'send'; taskId?: string; text: string; backend?: string; continuationOf?: string }
  | { type: 'focusTask'; taskId: string }
  | { type: 'hydrateSubtree'; taskId: string }
  | { type: 'newTask' }
  | { type: 'cancelTurn'; taskId: string; turnId: string }
  | { type: 'submitAsk'; taskId: string; turnId: string; askId: string; answers: Record<string, AskAnswer> }
  | { type: 'cancelAsk'; taskId: string; turnId: string; askId: string }
  | { type: 'retryTurn'; taskId: string; turnId: string; instruction: string }
  | { type: 'continueTask'; taskId: string; instruction: string }
  | { type: 'resumeQueuedTurn'; taskId: string; turnId: string }
  | { type: 'pickFile' }
  | { type: 'resolveFileDrop'; candidates: string[] }
  | { type: 'openLink'; url: string }
  | { type: 'clearHistory' };

/** Post a typed message to the extension host. */
export function post(message: OutMessage): void {
  vscode.postMessage(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isTaskSummary(v: unknown): v is TaskSummary {
  if (!isRecord(v)) return false;
  return (
    isString(v.id) &&
    (v.parentId === null || isString(v.parentId)) &&
    isString(v.goal) &&
    isString(v.role) &&
    isString(v.lifecycle) &&
    isString(v.viewStatus) &&
    isString(v.updatedAt) &&
    isString(v.backend)
  );
}

function isTranscriptItem(v: unknown): v is TranscriptItem {
  if (!isRecord(v) || !isString(v.id)) return false;
  switch (v.kind) {
    case 'user':
    case 'assistant':
      return isString(v.content);
    case 'reasoning':
      // Turn-scoped, string content, no order.
      return isString(v.turnId) && isString(v.content);
    case 'tool': {
      // Requires turnId + numeric order + structured tool content.
      if (!isString(v.turnId) || !isNumber(v.order) || !isRecord(v.content)) return false;
      const c = v.content;
      return isString(c.toolCallId) && isString(c.name) && isString(c.status);
    }
    case 'error':
      // Locally-synthesized only; the host never sends error transcript items.
      return true;
    default:
      return false;
  }
}

/** Discriminated runtime guard for a NormalizedEvent arriving from the host. */
export function isNormalizedEvent(v: unknown): v is NormalizedEvent {
  if (!isRecord(v) || !isString(v.type)) return false;
  switch (v.type) {
    case 'sessionStarted':
      return v.sessionId === undefined || isString(v.sessionId);
    case 'assistantDelta':
    case 'reasoningDelta':
      return isString(v.content) && isString(v.messageId);
    case 'toolStarted':
      return isString(v.toolCallId) && isString(v.name);
    case 'toolUpdated':
      return isString(v.toolCallId);
    case 'toolCompleted':
      return isString(v.toolCallId) && (v.outcome === 'success' || v.outcome === 'error');
    case 'usage':
      return isRecord(v.usage);
    case 'turnCompleted':
      return true;
    case 'error':
      return isString(v.message);
    case 'raw':
      return isString(v.line);
    default:
      return false;
  }
}

function isQuestion(v: unknown): v is Question {
  if (!isRecord(v)) return false;
  return isString(v.prompt);
}

const TURN_SCOPED_TYPES = new Set([
  'turnStart',
  'event',
  'turnDone',
  'turnError',
  'askPending',
  'askCleared',
]);

/** Minimal runtime guard for messages arriving from the extension host. */
export function isExtMessage(data: unknown): data is ExtMessage {
  if (!isRecord(data) || !isString(data.type)) return false;

  const t = data.type;

  if (TURN_SCOPED_TYPES.has(t)) {
    if (!isString(data.taskId) || !isString(data.turnId)) return false;
  }

  switch (t) {
    case 'snapshot':
      return (
        Array.isArray(data.rootTasks) &&
        data.rootTasks.every(isTaskSummary) &&
        isNumber(data.storeRevision) &&
        (data.focusedTaskId === undefined || isString(data.focusedTaskId)) &&
        (data.subtree === undefined || (Array.isArray(data.subtree) && data.subtree.every(isTaskSummary))) &&
        (data.transcript === undefined || (Array.isArray(data.transcript) && data.transcript.every(isTranscriptItem))) &&
        (data.activeTurnId === undefined || isString(data.activeTurnId)) &&
        (data.pendingAsk === undefined ||
          (isRecord(data.pendingAsk) &&
            isString(data.pendingAsk.turnId) &&
            isString(data.pendingAsk.askId) &&
            Array.isArray(data.pendingAsk.questions) &&
            data.pendingAsk.questions.every(isQuestion)))
      );

    case 'taskUpdated':
      return isString(data.taskId) && isNumber(data.storeRevision) && isRecord(data.patch);

    case 'turnStart':
      return isString(data.trigger);

    case 'event':
      return isNormalizedEvent(data.event);

    case 'turnDone':
      return true;

    case 'turnError':
      return isString(data.message);

    case 'transcriptAppend':
      return isString(data.taskId) && isTranscriptItem(data.item);

    case 'askPending':
      return isString(data.askId) && Array.isArray(data.questions) && data.questions.every(isQuestion);

    case 'askCleared':
      return isString(data.askId);

    case 'commandError':
      return isString(data.message) && (data.taskId === undefined || isString(data.taskId));

    case 'filePicked':
      return isString(data.path);

    default:
      return false;
  }
}

export function isTerminalStatus(status: TaskViewStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

export function statusLabel(status: TaskViewStatus): string {
  return status.replace(/_/g, ' ');
}