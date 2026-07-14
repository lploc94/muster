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
export const PROTOCOL_VERSION = 4;

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

/** Host-owned turn chrome (mirrors src/host/snapshot.ts). */
export type TurnActivityWaitReason =
  | 'dependencies'
  | 'children'
  | 'external'
  | 'held_after_failure'
  | 'live_turn_ahead'
  | string;

export type TurnActivity =
  | {
      state: 'queued';
      turnId: string;
      position?: number;
      waitReason?: TurnActivityWaitReason;
    }
  | { state: 'executing'; turnId: string; phase?: 'starting' | 'streaming' | 'tool' | 'retrying' }
  | { state: 'waiting_you'; turnId: string; requestId?: string }
  | { state: 'failed_turn'; turnId: string; retryable: boolean }
  | { state: 'uncertain'; turnId: string; requiresConfirmation: true }
  | null;

/** Explicit handoff progress phases (mirrors host TaskHandoffPhase). */
export type TaskHandoffPhase =
  | 'requested'
  | 'exporting_context'
  | 'summarizing_source'
  | 'preparing_receiver'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Sanitized source/target labels only — never session ids. */
export interface HandoffProgressBinding {
  backend: string;
  model?: string;
}

/** Bounded failure chrome for a failed/cancelled handoff. */
export interface HandoffProgressFailure {
  code: string;
  message: string;
  at: string;
}

/**
 * Task-scoped handoff chrome projected by the host (D018 / §19).
 * Never includes digests, summary/bootstrap bodies, session ids, or credentials.
 */
export interface HandoffProgress {
  operationId: string;
  phase: TaskHandoffPhase;
  source: HandoffProgressBinding;
  target: HandoffProgressBinding;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  failure?: HandoffProgressFailure;
}

export interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: string;
  lifecycle: TaskLifecycleState | string;
  /** Present when host supports dual-axis status; null when lifecycle is terminal. */
  runtimeActivity?: TaskRuntimeActivity | null;
  viewStatus: TaskViewStatus;
  /** Host-authoritative turn activity for composer/list chrome (required protocol v3+). */
  currentTurnActivity: TurnActivity;
  /** Agent proposed complete/fail while lifecycle remains open. */
  hasOutcomeProposal?: boolean;
  updatedAt: string;
  backend: string;
  /** Optional model id selected for this task (ACP session config option value). */
  model?: string;
  continuationOf?: string;
  /**
   * Optional sanitized handoff progress for model-switch chrome.
   * Omitted when the task has no handoff. Never carries digests, session ids,
   * or summary/bootstrap bodies — those stay off TaskSummary and chat.
   */
  handoffProgress?: HandoffProgress;
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

/** FIFO queued follow-up turns projected by the host for edit/delete and composer feedback. */
export interface QueuedTurnProjection {
  turnId: string;
  sequence: number;
  status: 'queued';
  messageIds: string[];
  createdAt: string;
  /** Host-projected user text so the queue panel works without chat bubbles. */
  previewText?: string;
  /** Prefer concurrent inject when a live turn is available. */
  delivery?: 'turn' | 'live_inject';
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
  /** Authoritative multi-queue projection (R012); optional for older hosts. */
  queuedTurns?: QueuedTurnProjection[];
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
      type: 'askSubmissionResult';
      taskId: string;
      turnId: string;
      askId: string;
      ok: boolean;
      message?: string;
    }
  | {
      type: 'elicitationFormPending';
      promptId: string;
      sessionId?: string;
      toolCallId?: string;
      message: string;
      fields: Array<Record<string, unknown>>;
      required: string[];
      askLike?: boolean;
    }
  | {
      type: 'elicitationUrlPending';
      promptId: string;
      elicitationId: string;
      sessionId?: string;
      url: string;
      message: string;
    }
  | { type: 'elicitationUrlWaiting'; promptId: string; elicitationId: string; message?: string }
  | { type: 'elicitationCleared'; promptId: string }
  | { type: 'elicitationSubmissionResult'; promptId: string; ok: boolean; message?: string }
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
  /** Phase C: durable send accepted after store commit (or re-ACK of receipt). */
  | {
      type: 'sendAccepted';
      clientRequestId: string;
      taskId: string;
      messageId: string;
      turnId?: string;
    }
  /** Phase C: send rejected (capacity, conflict, store failure). */
  | {
      type: 'sendRejected';
      clientRequestId: string;
      taskId?: string;
      reason: string;
      code?: 'conflict' | 'capacity' | 'store' | 'validation' | 'unknown';
    }
  /**
   * Host acknowledgement that a live-input instruction was delivered to the
   * locally owned active backend session. Refusals use `commandError` with a
   * capability- or ownership-specific message instead — never a queued turn.
   */
  | { type: 'liveInputResult'; taskId: string; code: 'delivered'; sessionId: string }
  /** `path` = resolve target for LLM; optional `displayName` = short chip label. */
  | { type: 'filePicked'; path: string; displayName?: string }
  | { type: 'backendsAvailable'; backends: string[] }
  | { type: 'modelsAvailable'; models: Record<string, BackendModels> }
  /**
   * Host-persisted last-used composer backend/model (globalState). Sent on
   * webview mount so the picker survives restarts — webview `setState` alone
   * is not durable enough when the view is recreated.
   */
  | { type: 'composerSelection'; backend: string; model: string | null }
  /**
   * Task Markdown export succeeded. `fileName` is basename only — never an
   * absolute path. Failures use `commandError`; cancel is intentionally silent.
   */
  | {
      type: 'exportResult';
      taskId: string;
      fileName: string;
      sourceRevision: number;
      exportedAt: string;
    };

export type AskAnswer = { selected: string[]; freeText: string | null };

// Webview -> extension host (protocol v2)
export type OutMessage =
  | {
      type: 'send';
      taskId?: string;
      /** User-visible text (display-name mentions). */
      text: string;
      /** Agent-facing text when mentions expand to full paths. */
      llmText?: string;
      backend?: string;
      model?: string;
      continuationOf?: string;
      /** Phase C idempotent send key (stable across resend). */
      clientRequestId?: string;
    }
  | { type: 'focusTask'; taskId: string }
  | { type: 'hydrateSubtree'; taskId: string }
  | { type: 'newTask' }
  | { type: 'cancelTurn'; taskId: string; turnId: string }
  | { type: 'submitAsk'; taskId: string; turnId: string; askId: string; answers: Record<string, AskAnswer> }
  | { type: 'cancelAsk'; taskId: string; turnId: string; askId: string }
  | {
      type: 'submitElicitation';
      promptId: string;
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
    }
  | { type: 'submitPermission'; permissionId: string; optionId: string; remember: boolean }
  | { type: 'cancelPermission'; permissionId: string }
  | {
      type: 'retryTurn';
      taskId: string;
      turnId: string;
      instruction: string;
      /** Phase C explicit replay: reuse prior turn inputs (byte-stable prompt). */
      reuseOriginalInputs?: boolean;
    }
  | { type: 'continueTask'; taskId: string; instruction: string }
  /**
   * Deliver an instruction to the currently running, locally owned turn for
   * `taskId` when the backend proves live-input support. Distinct from
   * `continueTask` (which queues a follow-up turn). Host refuses with
   * `commandError` when unsupported / not local owner / no active turn.
   */
  | { type: 'sendLiveInput'; taskId: string; instruction: string }
  /**
   * Edit the bound pending user message of an undispatched queued turn for
   * `taskId` identified by `turnId`. Host refuses with `commandError` when the
   * turn is missing, foreign, already dispatched, or content is invalid.
   * Distinct from `continueTask` (which creates a new queued turn).
   */
  | { type: 'editQueuedTurn'; taskId: string; turnId: string; content: string }
  /**
   * Remove an undispatched queued turn and its bound pending user message(s).
   * Host refuses with `commandError` when the turn is missing, foreign, or
   * already dispatched. Does not cancel an active/running turn.
   */
  | { type: 'deleteQueuedTurn'; taskId: string; turnId: string }
  | { type: 'resumeQueuedTurn'; taskId: string; turnId: string }
  | { type: 'pickFile' }
  | { type: 'browseWorkspaceFiles' }
  | { type: 'resolveFileDrop'; candidates: string[] }
  /**
   * When the webview has file bytes but no filesystem path (Finder → sandboxed
   * webview), host writes a temp copy and replies with `filePicked` absolute path.
   */
  | { type: 'importDroppedFile'; name: string; data: ArrayBuffer }
  | { type: 'openLink'; url: string }
  | { type: 'clearHistory' }
  | { type: 'deleteTask'; taskId: string }
  | { type: 'renameTask'; taskId: string; goal: string }
  /**
   * Export one task as Markdown via the host native Save As dialog.
   * Success replies with `exportResult` (basename only); failures use
   * task-scoped `commandError`; cancel posts nothing.
   */
  | { type: 'exportTask'; taskId: string }
  /**
   * Request a runtime model/backend handoff on an existing idle task.
   * Host validates, chains requestRuntimeHandoff → completeRuntimeHandoff,
   * and projects progress via snapshot/taskUpdated. Refusals use task-scoped
   * `commandError`. Success is observed via updated TaskSummary.backend/model
   * + handoffProgress (no chat turns, no session ids).
   */
  | {
      type: 'requestRuntimeHandoff';
      taskId: string;
      targetBackend: string;
      targetModel?: string;
      /** When true (default on host), skip the optional hidden source-summary turn. */
      skipSummary?: boolean;
    }
  | { type: 'blurTask' }
  | { type: 'requestSettings' }
  | { type: 'updateSetting'; settingId: RetentionSettingId; value: number }
  | { type: 'listBackends' }
  | { type: 'listModels' }
  /**
   * Persist the composer's last-used backend/model on the host (globalState)
   * so the preference survives full restarts and webview recreation.
   */
  | { type: 'setComposerSelection'; backend: string; model?: string | null }
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

/** Basename-only export file names — never path segments or drive prefixes. */
function isExportResultFileName(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const name = v.trim();
  if (name.length === 0) return false;
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  return true;
}

/** Host export timestamps are ISO-8601 (`Date.toISOString()`). */
function isExportResultTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim() === '') return false;
  const ms = Date.parse(v);
  return !Number.isNaN(ms);
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

function isTurnActivity(v: unknown): v is TurnActivity {
  if (v === null) return true;
  if (!isRecord(v) || !isString(v.state) || !isString(v.turnId)) return false;
  switch (v.state) {
    case 'queued':
      return (
        (v.position === undefined || isNumber(v.position)) &&
        (v.waitReason === undefined || isString(v.waitReason))
      );
    case 'executing':
      return (
        v.phase === undefined ||
        v.phase === 'starting' ||
        v.phase === 'streaming' ||
        v.phase === 'tool' ||
        v.phase === 'retrying'
      );
    case 'waiting_you':
      return v.requestId === undefined || isString(v.requestId);
    case 'failed_turn':
      return typeof v.retryable === 'boolean';
    case 'uncertain':
      return v.requiresConfirmation === true;
    default:
      return false;
  }
}

const TASK_HANDOFF_PHASES = new Set<TaskHandoffPhase>([
  'requested',
  'exporting_context',
  'summarizing_source',
  'preparing_receiver',
  'transferring',
  'completed',
  'failed',
  'cancelled',
]);

function isTaskHandoffPhase(v: unknown): v is TaskHandoffPhase {
  return isString(v) && TASK_HANDOFF_PHASES.has(v as TaskHandoffPhase);
}

function isHandoffProgressBinding(v: unknown): v is HandoffProgressBinding {
  if (!isRecord(v) || !isString(v.backend)) return false;
  // Labels only — reject session ids or other secret-bearing keys at the wire guard.
  if (!hasOnlyKeys(v, ['backend', 'model'])) return false;
  return v.model === undefined || isString(v.model);
}

function isHandoffProgressFailure(v: unknown): v is HandoffProgressFailure {
  if (!isRecord(v)) return false;
  if (!hasOnlyKeys(v, ['code', 'message', 'at'])) return false;
  return isString(v.code) && isString(v.message) && isString(v.at);
}

function isHandoffProgress(v: unknown): v is HandoffProgress {
  if (!isRecord(v)) return false;
  if (
    !hasOnlyKeys(v, [
      'operationId',
      'phase',
      'source',
      'target',
      'createdAt',
      'updatedAt',
      'startedAt',
      'finishedAt',
      'failure',
    ])
  ) {
    return false;
  }
  return (
    isString(v.operationId) &&
    isTaskHandoffPhase(v.phase) &&
    isHandoffProgressBinding(v.source) &&
    isHandoffProgressBinding(v.target) &&
    isString(v.createdAt) &&
    isString(v.updatedAt) &&
    (v.startedAt === undefined || isString(v.startedAt)) &&
    (v.finishedAt === undefined || isString(v.finishedAt)) &&
    (v.failure === undefined || isHandoffProgressFailure(v.failure))
  );
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
    isTurnActivity(v.currentTurnActivity) &&
    isString(v.updatedAt) &&
    isString(v.backend) &&
    (v.model === undefined || isString(v.model)) &&
    (v.continuationOf === undefined || isString(v.continuationOf)) &&
    (v.hasOutcomeProposal === undefined || typeof v.hasOutcomeProposal === 'boolean') &&
    (v.runtimeActivity === undefined ||
      v.runtimeActivity === null ||
      isString(v.runtimeActivity)) &&
    (v.handoffProgress === undefined || isHandoffProgress(v.handoffProgress))
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

function isQueuedTurnProjection(v: unknown): v is QueuedTurnProjection {
  if (!isRecord(v)) return false;
  return (
    isString(v.turnId) &&
    isNumber(v.sequence) &&
    v.status === 'queued' &&
    Array.isArray(v.messageIds) &&
    v.messageIds.every(isString) &&
    isString(v.createdAt) &&
    (v.previewText === undefined || isString(v.previewText)) &&
    (v.delivery === undefined || v.delivery === 'turn' || v.delivery === 'live_inject')
  );
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
  'askSubmissionResult',
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
        (data.queuedTurns === undefined ||
          (Array.isArray(data.queuedTurns) && data.queuedTurns.every(isQueuedTurnProjection))) &&
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

    case 'askSubmissionResult':
      return (
        isString(data.askId) &&
        typeof data.ok === 'boolean' &&
        (data.message === undefined || isString(data.message))
      );

    case 'elicitationFormPending':
      return (
        isString(data.promptId) &&
        isString(data.message) &&
        Array.isArray(data.fields) &&
        Array.isArray(data.required)
      );

    case 'elicitationUrlPending':
      return (
        isString(data.promptId) &&
        isString(data.elicitationId) &&
        isString(data.url) &&
        isString(data.message)
      );

    case 'elicitationUrlWaiting':
      return isString(data.promptId) && isString(data.elicitationId);

    case 'elicitationCleared':
      return isString(data.promptId);

    case 'elicitationSubmissionResult':
      return (
        isString(data.promptId) &&
        typeof data.ok === 'boolean' &&
        (data.message === undefined || isString(data.message))
      );

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

    case 'sendAccepted':
      return (
        isString(data.clientRequestId) &&
        isString(data.taskId) &&
        isString(data.messageId) &&
        (data.turnId === undefined || isString(data.turnId))
      );

    case 'sendRejected':
      return (
        isString(data.clientRequestId) &&
        isString(data.reason) &&
        (data.taskId === undefined || isString(data.taskId)) &&
        (data.code === undefined ||
          data.code === 'conflict' ||
          data.code === 'capacity' ||
          data.code === 'store' ||
          data.code === 'validation' ||
          data.code === 'unknown')
      );

    case 'liveInputResult':
      return (
        hasOnlyKeys(data, ['type', 'taskId', 'code', 'sessionId']) &&
        isString(data.taskId) &&
        data.code === 'delivered' &&
        isString(data.sessionId)
      );

    case 'filePicked':
      return isString(data.path) && (data.displayName === undefined || isString(data.displayName));

    case 'backendsAvailable':
      return Array.isArray(data.backends) && data.backends.every(isString);

    case 'modelsAvailable':
      return typeof data.models === 'object' && data.models !== null;

    case 'composerSelection':
      return (
        hasOnlyKeys(data, ['type', 'backend', 'model']) &&
        isString(data.backend) &&
        (data.model === null || isString(data.model))
      );

    case 'exportResult':
      return (
        hasOnlyKeys(data, ['type', 'taskId', 'fileName', 'sourceRevision', 'exportedAt']) &&
        isString(data.taskId) &&
        isExportResultFileName(data.fileName) &&
        isInteger(data.sourceRevision) &&
        isExportResultTimestamp(data.exportedAt)
      );

    default:
      return false;
  }
}

/**
 * User-visible acknowledgement for a successful host `liveInputResult`.
 * Session id is required so callers never invent a silent/empty success banner.
 */
export function formatLiveInputDeliveredMessage(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('sessionId is required for live-input delivered acknowledgements');
  }
  return 'Live input delivered to the active session.';
}

/**
 * User-visible acknowledgement for a successful host `exportResult`.
 * `fileName` must be a basename only (no path separators or drive prefixes) so
 * the notice never surfaces absolute destinations. `sourceRevision` is the
 * store revision the Markdown was projected from.
 */
export function formatExportResultMessage(fileName: string, sourceRevision: number): string {
  if (typeof fileName !== 'string' || fileName.trim().length === 0) {
    throw new Error('fileName is required for export success notices');
  }
  const name = fileName.trim();
  // Defense-in-depth: never format path-like values into the task-scoped notice.
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) {
    throw new Error('fileName must be a basename only for export success notices');
  }
  if (typeof sourceRevision !== 'number' || !Number.isFinite(sourceRevision)) {
    throw new Error('sourceRevision must be a finite number for export success notices');
  }
  return `Export saved as ${name} (source revision ${sourceRevision}).`;
}

/**
 * Task-scoped banner visibility shared by commandError refusals and live-input
 * success notices. Global (absent/null taskId) banners always show; otherwise
 * only the currently focused task sees the feedback.
 */
export function isTaskScopedBannerVisible(
  taskId: string | null | undefined,
  focusedTaskId: string | null,
): boolean {
  if (taskId == null || taskId === '') return true;
  return focusedTaskId != null && taskId === focusedTaskId;
}

/** Any sealed lifecycle (including soft failed). Prefer hard/soft helpers for UX. */
export function isTerminalStatus(status: TaskViewStatus | string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

/** Hard terminal: sealed success/cancel/skip (user may reopen same id). */
export function isHardTerminalLifecycle(lifecycle: string): boolean {
  return lifecycle === 'succeeded' || lifecycle === 'cancelled' || lifecycle === 'skipped';
}

/** Soft terminal: sealed fail (user may reopen same id, same as hard). */
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
