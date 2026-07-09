import { vscode } from './vscode';
import type { NormalizedEvent, Question } from './types';

/**
 * Wire protocol version for the host<->webview message channel ("protocol v2").
 * Single source of truth: the webview imports this constant; the host keeps a
 * duplicated copy in src/extension.ts because it cannot import this module (the
 * module graph has browser-only side effects via acquireVsCodeApi). The version
 * is stamped on the bootstrap `snapshot` message so either side can detect drift
 * once, instead of silently dropping mismatched messages. Bump this on any
 * breaking change to the ExtMessage/OutMessage shapes below (and mirror it in
 * src/extension.ts).
 */
export const PROTOCOL_VERSION = 2;

/**
 * Decide whether a peer's advertised protocol version is compatible with ours.
 * Same integer => compatible. A different version OR an absent/non-numeric one
 * (an old peer that predates version stamping) => incompatible, so the caller
 * can surface a visible "reload the window" diagnostic instead of silently
 * proceeding against a drifted peer. Pure and side-effect free (unit-tested).
 */
export function isProtocolCompatible(theirVersion: unknown): boolean {
  return theirVersion === PROTOCOL_VERSION;
}

export type TurnTrigger = 'user' | 'engine' | 'retry';

/** Persisted work outcome — primary task badge. */
export type TaskLifecycleState = 'open' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

/** Derived CLI/deps/wait activity while open — secondary chrome. */
export type TaskRuntimeActivity =
  | 'waiting_dependencies'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_children'
  | 'blocked'
  | 'needs_recovery'
  | 'idle'
  | 'awaiting_outcome';

/**
 * Compact single-axis status (host still sends for compatibility).
 * Prefer lifecycle + runtimeActivity for UI.
 */
export type TaskViewStatus = TaskLifecycleState | TaskRuntimeActivity;

export interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: string;
  lifecycle: TaskLifecycleState | string;
  /** Present when host supports dual-axis status; null when lifecycle is terminal. */
  runtimeActivity?: TaskRuntimeActivity | null;
  viewStatus: TaskViewStatus;
  /** Backend session bound to this task for resume across process restarts. */
  committedSessionId?: string;
  /** Agent proposed complete/fail while lifecycle remains open. */
  hasOutcomeProposal?: boolean;
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

/** Coarse risk class for a tool-permission request (mirrors the host). */
export type PermissionClass = 'read' | 'write' | 'unknown';

/** An option offered by the agent on a permission request. */
export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: string;
}

export interface PendingPermission {
  sessionId: string;
  permissionId: string;
  title: string;
  kind: string;
  classification: PermissionClass;
  options: PermissionOptionView[];
}

export interface SnapshotMessage {
  type: 'snapshot';
  /**
   * Wire protocol version stamped by the host on this bootstrap message; see
   * PROTOCOL_VERSION. Optional so an older host that predates version stamping
   * still type-checks — its absence is treated as an (incompatible) mismatch.
   */
  protocolVersion?: number;
  rootTasks: TaskSummary[];
  focusedTaskId?: string;
  subtree?: TaskSummary[];
  transcript?: TranscriptItem[];
  activeTurnId?: string;
  storeRevision: number;
  pendingAsk?: PendingAsk;
}

export type RetentionSettingId = 'maxTurnsPerTask' | 'maxStoredOutputChars';

export interface RetentionSettingValue {
  id: RetentionSettingId;
  label: string;
  description: string;
  value: number;
  defaultValue: number;
  minimum: number;
}

export interface RetentionSettingSnapshot {
  settings: RetentionSettingValue[];
}

export interface SettingsSnapshotMessage {
  type: 'settingsSnapshot';
  snapshot: RetentionSettingSnapshot;
}

export type RetentionSettingErrorCode =
  | 'unknownSetting'
  | 'invalidType'
  | 'nonFinite'
  | 'nonInteger'
  | 'belowMinimum'
  | 'updateFailed';

export type SettingsUpdateResult =
  | { ok: true; settingId: RetentionSettingId; value: number }
  | { ok: false; code: 'unknownSetting'; message: string }
  | { ok: false; settingId: RetentionSettingId; code: Exclude<RetentionSettingErrorCode, 'unknownSetting'>; message: string };

export interface SettingsUpdateResultMessage {
  type: 'settingsUpdateResult';
  result: SettingsUpdateResult;
}

/** A backend's selectable models, reported by the host for the model picker. */
export interface BackendModelOption {
  value: string;
  name: string;
}
export interface BackendModels {
  current?: string;
  options: BackendModelOption[];
}

// Extension host -> webview (protocol v2, TASK-MODEL-PHASE-D-PLAN §4.1)
export type ExtMessage =
  | SnapshotMessage
  | SettingsSnapshotMessage
  | SettingsUpdateResultMessage
  | { type: 'taskUpdated'; taskId: string; storeRevision: number; patch: Partial<TaskSummary> }
  | { type: 'turnStart'; taskId: string; turnId: string; trigger: TurnTrigger }
  | { type: 'event'; taskId: string; turnId: string; event: NormalizedEvent }
  | { type: 'turnDone'; taskId: string; turnId: string }
  | { type: 'turnError'; taskId: string; turnId: string; message: string }
  | { type: 'transcriptAppend'; taskId: string; item: TranscriptItem }
  | { type: 'askPending'; taskId: string; turnId: string; askId: string; questions: Question[] }
  | { type: 'askCleared'; taskId: string; turnId: string; askId: string }
  | {
      type: 'permissionPending';
      sessionId: string;
      permissionId: string;
      title: string;
      kind: string;
      classification: PermissionClass;
      options: PermissionOptionView[];
    }
  | { type: 'permissionCleared'; permissionId: string }
  | { type: 'commandError'; taskId?: string; message: string }
  | { type: 'filePicked'; path: string }
  | { type: 'backendsAvailable'; backends: string[] }
  | { type: 'modelsAvailable'; models: Record<string, BackendModels> };

export type AskAnswer = { selected: string[]; freeText: string | null };

// Webview -> extension host (protocol v2)
export type OutMessage =
  | { type: 'send'; taskId?: string; text: string; backend?: string; model?: string; continuationOf?: string }
  | { type: 'focusTask'; taskId: string }
  | { type: 'hydrateSubtree'; taskId: string }
  | { type: 'newTask' }
  | { type: 'cancelTurn'; taskId: string; turnId: string }
  | { type: 'submitAsk'; taskId: string; turnId: string; askId: string; answers: Record<string, AskAnswer> }
  | { type: 'cancelAsk'; taskId: string; turnId: string; askId: string }
  | { type: 'submitPermission'; permissionId: string; optionId: string; remember: boolean }
  | { type: 'cancelPermission'; permissionId: string }
  | { type: 'retryTurn'; taskId: string; turnId: string; instruction: string }
  | { type: 'continueTask'; taskId: string; instruction: string }
  | { type: 'resumeQueuedTurn'; taskId: string; turnId: string }
  | { type: 'pickFile' }
  | { type: 'browseWorkspaceFiles' }
  | { type: 'resolveFileDrop'; candidates: string[] }
  | { type: 'openLink'; url: string }
  | { type: 'clearHistory' }
  | { type: 'deleteTask'; taskId: string }
  | { type: 'renameTask'; taskId: string; goal: string }
  | { type: 'blurTask' }
  | { type: 'requestSettings' }
  | { type: 'updateSetting'; settingId: RetentionSettingId; value: number }
  | { type: 'listBackends' }
  | { type: 'listModels' }
  /** User sets task lifecycle (not CLI-driven). */
  | {
      type: 'setTaskLifecycle';
      taskId: string;
      lifecycle: 'open' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
      result?: string;
      error?: string;
    };

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

function hasOnlyKeys(v: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(v).every((key) => allowed.has(key));
}

function isInteger(v: unknown): v is number {
  return isNumber(v) && Number.isInteger(v);
}

function isRetentionSettingId(v: unknown): v is RetentionSettingId {
  return v === 'maxTurnsPerTask' || v === 'maxStoredOutputChars';
}

const RETENTION_SETTING_CONTRACT: Record<RetentionSettingId, { defaultValue: number; minimum: number }> = {
  maxTurnsPerTask: { defaultValue: 200, minimum: 1 },
  maxStoredOutputChars: { defaultValue: 200000, minimum: 1024 },
};

function isRetentionSettingValue(v: unknown): v is RetentionSettingValue {
  if (!isRecord(v) || !isRetentionSettingId(v.id)) return false;
  const contract = RETENTION_SETTING_CONTRACT[v.id];
  return (
    isString(v.label) &&
    isString(v.description) &&
    isInteger(v.value) &&
    v.value >= contract.minimum &&
    v.defaultValue === contract.defaultValue &&
    v.minimum === contract.minimum
  );
}

function isRetentionSettingSnapshot(v: unknown): v is RetentionSettingSnapshot {
  if (!isRecord(v) || !Array.isArray(v.settings)) return false;
  if (v.settings.length !== Object.keys(RETENTION_SETTING_CONTRACT).length) return false;
  const seen = new Set<RetentionSettingId>();
  for (const setting of v.settings) {
    if (!isRetentionSettingValue(setting) || seen.has(setting.id)) return false;
    seen.add(setting.id);
  }
  return Object.keys(RETENTION_SETTING_CONTRACT).every((id) => seen.has(id as RetentionSettingId));
}

function isRetentionSettingErrorCode(v: unknown): v is RetentionSettingErrorCode {
  return (
    v === 'unknownSetting' ||
    v === 'invalidType' ||
    v === 'nonFinite' ||
    v === 'nonInteger' ||
    v === 'belowMinimum' ||
    v === 'updateFailed'
  );
}

function isSettingsUpdateResult(v: unknown): v is SettingsUpdateResult {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return false;
  if (v.ok) {
    if (!isRetentionSettingId(v.settingId) || !isInteger(v.value)) return false;
    return v.value >= RETENTION_SETTING_CONTRACT[v.settingId].minimum;
  }
  if (!isRetentionSettingErrorCode(v.code) || !isString(v.message)) return false;
  if (v.code === 'unknownSetting') {
    return v.settingId === undefined;
  }
  return isRetentionSettingId(v.settingId);
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

function isPermissionOption(v: unknown): v is PermissionOptionView {
  if (!isRecord(v)) return false;
  return isString(v.optionId) && isString(v.name) && isString(v.kind);
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
        (data.protocolVersion === undefined || isNumber(data.protocolVersion)) &&
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

    case 'settingsSnapshot':
      return hasOnlyKeys(data, ['type', 'snapshot']) && isRetentionSettingSnapshot(data.snapshot);

    case 'settingsUpdateResult':
      return hasOnlyKeys(data, ['type', 'result']) && isSettingsUpdateResult(data.result);

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

    case 'permissionPending':
      return (
        isString(data.sessionId) &&
        isString(data.permissionId) &&
        isString(data.title) &&
        isString(data.kind) &&
        isString(data.classification) &&
        Array.isArray(data.options) &&
        data.options.every(isPermissionOption)
      );

    case 'permissionCleared':
      return isString(data.permissionId);

    case 'commandError':
      return isString(data.message) && (data.taskId === undefined || isString(data.taskId));

    case 'filePicked':
      return isString(data.path);

    case 'backendsAvailable':
      return Array.isArray(data.backends) && data.backends.every(isString);

    case 'modelsAvailable':
      return typeof data.models === 'object' && data.models !== null;

    default:
      return false;
  }
}

/** Any sealed lifecycle (including soft failed). Prefer hard/soft helpers for UX. */
export function isTerminalStatus(status: TaskViewStatus | string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

/** Hard terminal: thread read-only; follow-up is a new task. */
export function isHardTerminalLifecycle(lifecycle: string): boolean {
  return lifecycle === 'succeeded' || lifecycle === 'cancelled' || lifecycle === 'skipped';
}

/** Soft terminal: same task may reopen on send. */
export function isSoftTerminalLifecycle(lifecycle: string): boolean {
  return lifecycle === 'failed';
}

export function isOpenLifecycle(lifecycle: string): boolean {
  return lifecycle === 'open';
}

export function statusLabel(status: TaskViewStatus | string): string {
  const s = status.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Effective runtime activity from summary (host field or fall back from viewStatus). */
export function effectiveRuntimeActivity(
  task: Pick<TaskSummary, 'lifecycle' | 'runtimeActivity' | 'viewStatus'>,
): TaskRuntimeActivity | null {
  if (task.lifecycle !== 'open') {
    return null;
  }
  if (task.runtimeActivity !== undefined) {
    return task.runtimeActivity;
  }
  // Older hosts: viewStatus holds runtime when open.
  const vs = task.viewStatus;
  if (
    vs === 'waiting_dependencies' ||
    vs === 'queued' ||
    vs === 'running' ||
    vs === 'waiting_user' ||
    vs === 'waiting_children' ||
    vs === 'blocked' ||
    vs === 'needs_recovery' ||
    vs === 'idle' ||
    vs === 'awaiting_outcome'
  ) {
    return vs;
  }
  return 'idle';
}