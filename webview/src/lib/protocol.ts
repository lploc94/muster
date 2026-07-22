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
export const PROTOCOL_VERSION = 9;

/**
 * Require an exact peer protocol version. A different or malformed version
 * is rejected so the caller
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
 * Compact single-axis status used by the current summary contract.
 * Prefer lifecycle + runtimeActivity for UI.
 */
export type TaskViewStatus = TaskLifecycleState | TaskRuntimeActivity;

/** Host-owned turn chrome (mirrors src/host/snapshot.ts). */
export type TurnActivityWaitReason =
  | 'dependencies'
  | 'children'
  | 'external'
  | 'held_after_failure'
  | 'live_turn_ahead';

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

export interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: 'coordinator' | 'worker';
  lifecycle: TaskLifecycleState;
  /** Present when host supports dual-axis status; null when lifecycle is terminal. */
  runtimeActivity: TaskRuntimeActivity | null;
  viewStatus: TaskViewStatus;
  /** Host-authoritative turn activity for composer/list chrome (required protocol v3+). */
  currentTurnActivity: TurnActivity;
  /** Agent proposed complete/fail while lifecycle remains open. */
  hasOutcomeProposal?: boolean;
  runTimeoutMessage?: string;
  updatedAt: string;
  backend: string;
  /** Optional model id selected for this task (ACP session config option value). */
  model?: string;
  continuationOf?: string;
  /** Aggregate direct-child orchestration chrome for coordinators. */
  childOrchestration?: {
    total: number;
    running: number;
    open: number;
    terminal: number;
    awaitingParentSeal: number;
    needsParentInput: number;
    label: string;
  };
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
}

/**
 * Current-only transcript page metadata (protocol v6+). Present iff a task is
 * focused; carries the keyset cursor/hasMore flags and the page's workspace
 * revision so the webview can request older pages (W5).
 */
export interface TranscriptPageState {
  beforeCursor?: string;
  hasMoreBefore: boolean;
  workspaceRevision: number;
}

/** Bounds for loadTranscriptPage request correlation/payload fields (protocol v7). */
export const TRANSCRIPT_PAGE_REQUEST_ID_MAX = 128;
export const TRANSCRIPT_PAGE_TASK_ID_MAX = 512;
export const TRANSCRIPT_PAGE_CURSOR_MAX = 4096;
export const TRANSCRIPT_PAGE_MAX_ITEMS = 100;

/** Bounds for workspacePatchBatch (protocol v9). */
export const WORKSPACE_PATCH_MAX_PATCHES = 10_000;
export const WORKSPACE_PATCH_MAX_ITEMS = 500;
export const WORKSPACE_PATCH_MAX_QUEUED = 500;
export const WORKSPACE_PATCH_ID_MAX = 512;

/** Fixed failure codes for transcriptPageResult (no free-form message). */
export type TranscriptPageErrorCode =
  | 'invalidRequest'
  | 'staleFocus'
  | 'taskNotFound'
  | 'invalidCursor'
  | 'unavailable';

export const TRANSCRIPT_PAGE_ERROR_CODES: readonly TranscriptPageErrorCode[] = [
  'invalidRequest',
  'staleFocus',
  'taskNotFound',
  'invalidCursor',
  'unavailable',
] as const;

/** Host → webview older-page response (protocol v7). */
export type TranscriptPageResultMessage =
  | {
      type: 'transcriptPageResult';
      requestId: string;
      taskId: string;
      ok: true;
      items: TranscriptItem[];
      transcriptPage: TranscriptPageState;
    }
  | {
      type: 'transcriptPageResult';
      requestId: string;
      taskId: string;
      ok: false;
      code: TranscriptPageErrorCode;
    };

export interface SnapshotMessage {
  type: 'snapshot';
  /** Exact wire protocol version stamped by the host. */
  protocolVersion: number;
  rootTasks: TaskSummary[];
  focusedTaskId?: string;
  subtree?: TaskSummary[];
  transcript?: TranscriptItem[];
  /** Present iff focusedTaskId is set (protocol v6, current-only). */
  transcriptPage?: TranscriptPageState;
  activeTurnId?: string;
  /** Authoritative multi-queue projection (R012); optional for older hosts. */
  queuedTurns?: QueuedTurnProjection[];
  storeRevision: number;
  pendingAsk?: PendingAsk;
}

export type RunLimitSetting = '15m' | '30m' | '1h' | '2h' | '4h' | '8h';
export type RuntimeStorageSettingId =
  | 'runLimit'
  | 'maxRetainedTurnsPerTask'
  | 'maxStoredOutputChars';

export type RuntimeStorageSettingValue =
  | {
      kind: 'enum';
      id: 'runLimit';
      label: string;
      description: string;
      value: RunLimitSetting;
      defaultValue: RunLimitSetting;
      options: RunLimitSetting[];
    }
  | {
      kind: 'number';
      id: 'maxRetainedTurnsPerTask' | 'maxStoredOutputChars';
      label: string;
      description: string;
      value: number;
      defaultValue: number;
      minimum: number;
    };

export interface RuntimeStorageSettingsSnapshot {
  settings: RuntimeStorageSettingValue[];
}

export interface SettingsSnapshotMessage {
  type: 'settingsSnapshot';
  snapshot: RuntimeStorageSettingsSnapshot;
}

export type RetentionSettingErrorCode =
  | 'unknownSetting'
  | 'invalidType'
  | 'invalidEnum'
  | 'nonFinite'
  | 'nonInteger'
  | 'belowMinimum'
  | 'updateFailed';

export type SettingsUpdateResult =
  | { ok: true; settingId: RuntimeStorageSettingId; value: number | RunLimitSetting }
  | { ok: false; code: 'unknownSetting'; message: string }
  | { ok: false; settingId: RuntimeStorageSettingId; code: Exclude<RetentionSettingErrorCode, 'unknownSetting'>; message: string };

export interface SettingsUpdateResultMessage {
  type: 'settingsUpdateResult';
  result: SettingsUpdateResult;
}

/** Editable task-type row (mirrors host TaskTypeSettingsRow). */
export interface TaskTypeSettingsRow {
  id: string;
  backend: string;
  model?: string;
  fallbacks?: Array<{ backend: string; model?: string }>;
  role: 'coordinator' | 'worker';
  briefKind: string;
  description?: string;
}

export interface TaskTypesSettingsSnapshot {
  status: 'ok' | 'empty' | 'invalid';
  types: TaskTypeSettingsRow[];
  diagnostics: Array<{ code: string; message: string }>;
  defaults: TaskTypeSettingsRow[];
  constraints: {
    maxTypes: number;
    idPattern: string;
    descriptionMax: number;
    stringMax: number;
    roles: Array<'coordinator' | 'worker'>;
    briefKinds: string[];
  };
}

export type TaskTypesSettingsUpdateResult =
  | { ok: true }
  | {
      ok: false;
      code: 'invalid_task_type_config' | 'updateFailed';
      message: string;
      diagnostics?: Array<{ code: string; message: string }>;
    };

export interface TaskTypesSettingsSnapshotMessage {
  type: 'taskTypesSettingsSnapshot';
  snapshot: TaskTypesSettingsSnapshot;
}

export interface TaskTypesSettingsUpdateResultMessage {
  type: 'taskTypesSettingsUpdateResult';
  result: TaskTypesSettingsUpdateResult;
}


/** Security-sensitive permission mode (mirrors host PermissionMode). */
export type PermissionModeSetting = 'ask' | 'allow' | 'readonly';

export type PermissionModeRisk = 'recommended' | 'least-safe' | 'restricted';

export interface PermissionModeOptionView {
  mode: PermissionModeSetting;
  label: string;
  description: string;
  risk: PermissionModeRisk;
}

/** Host snapshot for the Settings Permissions topic. Distinct from runtime prompts. */
export interface PermissionSettingsSnapshot {
  mode: PermissionModeSetting;
  defaultMode: PermissionModeSetting;
  options: readonly PermissionModeOptionView[];
  description: string;
}

export type PermissionSettingsErrorCode = 'invalidPayload' | 'unknownMode' | 'updateFailed';

export type PermissionSettingsUpdateResult =
  | { ok: true; mode: PermissionModeSetting }
  | { ok: false; code: PermissionSettingsErrorCode; message: string };

export interface PermissionSettingsSnapshotMessage {
  type: 'permissionSettingsSnapshot';
  snapshot: PermissionSettingsSnapshot;
}

export interface PermissionSettingsUpdateResultMessage {
  type: 'permissionSettingsUpdateResult';
  result: PermissionSettingsUpdateResult;
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

/**
 * Atomic workspace revision envelope (protocol v9).
 * One SQLite transaction maps to one envelope with a single effective revision.
 * Empty `patches: []` still advances the revision for invisible commits.
 */
export type WorkspacePatch =
  | { type: 'taskUpserted'; task: TaskSummary }
  | { type: 'turnActivityChanged'; task: TaskSummary }
  | {
      type: 'transcriptItemsAppended';
      taskId: string;
      items: TranscriptItem[];
    }
  | {
      type: 'transcriptItemPatched';
      taskId: string;
      item: TranscriptItem;
    }
  | {
      type: 'transcriptItemsRemoved';
      taskId: string;
      itemIds: string[];
    }
  | {
      type: 'queuedTurnsChanged';
      taskId: string;
      queuedTurns: QueuedTurnProjection[];
    }
  | { type: 'taskRemoved'; taskId: string };

export type WorkspacePatchBatchMessage = {
  type: 'workspacePatchBatch';
  revision: number;
  patches: WorkspacePatch[];
};

// Extension host -> webview (protocol v2, TASK-MODEL-PHASE-D-PLAN §4.1)
export type ExtMessage =
  | SnapshotMessage
  | SettingsSnapshotMessage
  | SettingsUpdateResultMessage
  | TaskTypesSettingsSnapshotMessage
  | TaskTypesSettingsUpdateResultMessage
  | PermissionSettingsSnapshotMessage
  | PermissionSettingsUpdateResultMessage
  | WorkspacePatchBatchMessage
  | { type: 'turnStart'; taskId: string; turnId: string; trigger: TurnTrigger }
  | { type: 'event'; taskId: string; turnId: string; event: NormalizedEvent }
  | { type: 'turnDone'; taskId: string; turnId: string }
  | { type: 'turnError'; taskId: string; turnId: string; message: string }
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
  /** `path` = resolve target for LLM; optional `displayName` = short chip label. */
  | { type: 'filePicked'; path: string; displayName?: string }
  | { type: 'backendsAvailable'; backends: string[] }
  /**
   * A backend's advertised skills + its per-backend invocation prefix (`/` or `$`).
   * `prefix` is always present (static map) even when `skills` is empty (cold cache).
   */
  | { type: 'skillsAvailable'; backend: string; prefix: string; skills: string[] }
  | { type: 'modelsAvailable'; models: Record<string, BackendModels> }
  /**
   * Host-persisted last-used composer backend/model (VS Code Settings). Sent on
   * webview mount so the picker survives restarts — webview `setState` must not
   * store backend/model.
   */
  | { type: 'composerSelection'; backend: string; model: string | null }
  /**
   * Durable SQLite send-outbox snapshot for reload restore. Webview keeps these
   * in memory only; setState must never hold message text.
   */
  | {
      type: 'sendOutboxSnapshot';
      entries: Array<{
        clientRequestId: string;
        status: 'pending' | 'rejected';
        taskId?: string;
        text: string;
        llmText?: string;
        mentionBindings?: Array<[string, string]>;
        skills?: string[];
        backend?: string;
        model?: string;
        continuationOf?: string;
        createdAt: number;
      }>;
    }
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
    }
  /**
   * Older transcript page response (protocol v7). Success carries ≤100 items +
   * page metadata; failures use fixed codes only (no free-form message/stack).
   */
  | TranscriptPageResultMessage
  /**
   * Host response to `requestFileMentionSuggestions`.
   * Success returns relative suggestion items only (never absolute paths, cwd,
   * or file contents). Failures use bounded codes with no free-form message.
   */
  | FileMentionSuggestionsMessage;

/** Kind of a single autocomplete suggestion item. */
export type FileMentionSuggestionKind = 'file' | 'directory';

/** Bounded ascent from authoritative task/draft cwd (0 current, 1 parent, 2 grandparent). */
export type FileMentionParentDepth = 0 | 1 | 2;

/** Relative-only suggestion returned by the host for @ autocomplete. */
export interface FileMentionSuggestionItem {
  id: string;
  kind: FileMentionSuggestionKind;
  label: string;
  /** Relative path inserted into the composer mention (never absolute). */
  insertionPath: string;
}

export type FileMentionSuggestionsErrorCode =
  | 'invalidRequest'
  | 'unavailable'
  | 'listingFailed';

/**
 * Host → webview suggestion payload.
 * Success may omit `ok` (implicit true) or set `ok: true`.
 * Failure requires `ok: false` and a bounded `code`.
 */
export type FileMentionSuggestionsMessage =
  | {
      type: 'fileMentionSuggestions';
      ok?: true;
      requestId: string;
      parentDepth: FileMentionParentDepth;
      relativeQuery: string;
      items: FileMentionSuggestionItem[];
    }
  | {
      type: 'fileMentionSuggestions';
      ok: false;
      requestId: string;
      code: FileMentionSuggestionsErrorCode;
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
      /** Structured skill chips; injected into a NEW task's first turn only. */
      skills?: string[];
      /** Display mention → resolved path pairs needed to restore rejected drafts. */
      mentionBindings?: Array<[string, string]>;
      /** Durable idempotent send key (stable across resend). */
      clientRequestId: string;
    }
  | { type: 'focusTask'; taskId: string }
  | { type: 'hydrateSubtree'; taskId: string }
  /**
   * Request one bounded older transcript page for the focused task (introduced in v7).
   * Host replies with `transcriptPageResult` (typed success or fixed error code).
   * No loadHistory/historyChunk aliases.
   */
  | {
      type: 'loadTranscriptPage';
      requestId: string;
      taskId: string;
      beforeCursor: string;
    }
  /**
   * Request a bounded workspace snapshot after a revision gap/invariant failure
   * (protocol v9). Host replies with a normal `snapshot`. Single-flight on the
   * webview; not used for protocol mismatch (that still requires Reload Window).
   */
  | {
      type: 'requestWorkspaceRecovery';
      taskId?: string;
      currentRevision: number;
      observedRevision: number;
    }
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
   * Interrupt & send: reserve a FIFO follow-up turn and interrupt the local
   * active turn for `taskId` (wire name retained; concurrent inject removed).
   * Host maps this only to `TaskEngine.interruptAndSend`. Refusals use
   * `commandError` (not local owner / no active turn / validation).
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
   * Request @ autocomplete suggestions for depth 0–2 relative to the
   * authoritative task/draft cwd. Webview never supplies a filesystem path.
   */
  | {
      type: 'requestFileMentionSuggestions';
      requestId: string;
      taskId?: string;
      parentDepth: FileMentionParentDepth;
      relativeQuery: string;
    }
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
   * and atomically returns the new binding via snapshot/workspacePatchBatch. Refusals use
   * task-scoped `commandError`; no synthetic chat turn is created.
   */
  | {
      type: 'requestRuntimeHandoff';
      taskId: string;
      targetBackend: string;
      targetModel?: string;
    }
  | { type: 'blurTask' }
  | { type: 'requestSettings' }
  | { type: 'updateSetting'; settingId: RuntimeStorageSettingId; value: number | RunLimitSetting }
  | { type: 'requestTaskTypesSettings' }
  | { type: 'updateTaskTypes'; types: TaskTypeSettingsRow[] }
  | { type: 'requestPermissionSettings' }
  | { type: 'updatePermissionSettings'; mode: PermissionModeSetting }
  | { type: 'listBackends' }
  | { type: 'listModels' }
  /** Ask the host for a backend's advertised skills + invocation prefix. */
  | { type: 'listSkills'; backend: string }
  /** Webview → host debug line for Output channel "Muster Debug". */
  | { type: 'debugLog'; event: string; details?: Record<string, unknown> }
  /**
   * Persist the composer's last-used backend/model in VS Code Settings
   * so the preference survives full restarts and webview recreation.
   */
  | { type: 'setComposerSelection'; backend: string; model?: string | null }
  /** Prefill-applied: delete durable rejected outbox entry in SQLite. */
  | { type: 'ackSendOutbox'; clientRequestId: string }
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

/** Always visible in host Output → Muster Debug (not only DevTools). */
export function postDebug(event: string, details: Record<string, unknown> = {}): void {
  try {
    vscode.postMessage({ type: 'debugLog', event, details });
  } catch {
    // best-effort
  }
  try {
    console.info(`[muster]${event}`, details);
  } catch {
    // best-effort
  }
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

const SEND_OUTBOX_ENTRY_KEYS = [
  'clientRequestId', 'status', 'taskId', 'text', 'llmText', 'mentionBindings',
  'skills', 'backend', 'model', 'continuationOf', 'createdAt',
] as const;

function isBoundedOutboxString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function isSendOutboxSnapshotEntry(value: unknown): boolean {
  if (!isRecord(value) || Array.isArray(value) || !hasOnlyKeys(value, SEND_OUTBOX_ENTRY_KEYS)) {
    return false;
  }
  if (
    !isBoundedOutboxString(value.clientRequestId, 256) ||
    (value.status !== 'pending' && value.status !== 'rejected') ||
    !isBoundedOutboxString(value.text, 100_000) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0
  ) {
    return false;
  }
  for (const [key, max] of [
    ['taskId', 256],
    ['llmText', 100_000],
    ['backend', 32],
    ['model', 512],
    ['continuationOf', 256],
  ] as const) {
    if (value[key] !== undefined && !isBoundedOutboxString(value[key], max)) return false;
  }
  if (value.skills !== undefined) {
    const seenSkills = new Set<string>();
    if (
      !Array.isArray(value.skills) ||
      value.skills.length > 8 ||
      !value.skills.every((skill) =>
        typeof skill === 'string' &&
        skill.length > 0 &&
        skill.length <= 128 &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(skill) &&
        !seenSkills.has(skill) &&
        Boolean(seenSkills.add(skill))
      )
    ) {
      return false;
    }
  }
  if (value.mentionBindings !== undefined) {
    const seenLabels = new Set<string>();
    if (
      !Array.isArray(value.mentionBindings) ||
      value.mentionBindings.length > 64 ||
      !value.mentionBindings.every((binding) =>
        Array.isArray(binding) &&
        binding.length === 2 &&
        isBoundedOutboxString(binding[0], 512) &&
        !/[\r\n]/.test(binding[0]) &&
        isBoundedOutboxString(binding[1], 4096) &&
        !/[\r\n]/.test(binding[1]) &&
        !seenLabels.has(binding[0]) &&
        Boolean(seenLabels.add(binding[0]))
      )
    ) {
      return false;
    }
  }
  return true;
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

function isRuntimeStorageSettingId(v: unknown): v is RuntimeStorageSettingId {
  return v === 'runLimit' || v === 'maxRetainedTurnsPerTask' || v === 'maxStoredOutputChars';
}

const RETENTION_SETTING_CONTRACT = {
  runLimit: { kind: 'enum', defaultValue: '2h', options: ['15m', '30m', '1h', '2h', '4h', '8h'] },
  maxRetainedTurnsPerTask: { kind: 'number', defaultValue: 200, minimum: 1 },
  maxStoredOutputChars: { kind: 'number', defaultValue: 200000, minimum: 1024 },
} as const;

function isRuntimeStorageSettingValue(v: unknown): v is RuntimeStorageSettingValue {
  if (!isRecord(v) || !isRuntimeStorageSettingId(v.id)) return false;
  const contract = RETENTION_SETTING_CONTRACT[v.id];
  if (!isString(v.label) || !isString(v.description) || v.kind !== contract.kind) return false;
  if (contract.kind === 'enum') {
    return isString(v.value) && (contract.options as readonly string[]).includes(v.value) &&
      v.defaultValue === contract.defaultValue && Array.isArray(v.options) &&
      v.options.length === contract.options.length &&
      v.options.every((option, index) => option === contract.options[index]);
  }
  return isInteger(v.value) && v.value >= contract.minimum &&
    v.defaultValue === contract.defaultValue && v.minimum === contract.minimum;
}

function isRuntimeStorageSettingsSnapshot(v: unknown): v is RuntimeStorageSettingsSnapshot {
  if (!isRecord(v) || !Array.isArray(v.settings)) return false;
  if (v.settings.length !== Object.keys(RETENTION_SETTING_CONTRACT).length) return false;
  const seen = new Set<RuntimeStorageSettingId>();
  for (const setting of v.settings) {
    if (!isRuntimeStorageSettingValue(setting) || seen.has(setting.id)) return false;
    seen.add(setting.id);
  }
  return Object.keys(RETENTION_SETTING_CONTRACT).every((id) => seen.has(id as RuntimeStorageSettingId));
}

function isRetentionSettingErrorCode(v: unknown): v is RetentionSettingErrorCode {
  return (
    v === 'unknownSetting' ||
    v === 'invalidType' ||
    v === 'invalidEnum' ||
    v === 'nonFinite' ||
    v === 'nonInteger' ||
    v === 'belowMinimum' ||
    v === 'updateFailed'
  );
}

function isTaskTypeSettingsRow(v: unknown): v is TaskTypeSettingsRow {
  if (!isRecord(v) || !isString(v.id) || !isString(v.backend)) return false;
  if (v.role !== 'coordinator' && v.role !== 'worker') return false;
  if (!isString(v.briefKind)) return false;
  if (v.model !== undefined && !isString(v.model)) return false;
  if (
    v.fallbacks !== undefined
    && (!Array.isArray(v.fallbacks) || v.fallbacks.length > 8 || !v.fallbacks.every((binding) =>
      isRecord(binding)
      && isString(binding.backend)
      && (binding.model === undefined || isString(binding.model))))
  ) return false;
  if (v.description !== undefined && !isString(v.description)) return false;
  return true;
}

function isTaskTypesSettingsSnapshot(v: unknown): v is TaskTypesSettingsSnapshot {
  if (!isRecord(v)) return false;
  if (v.status !== 'ok' && v.status !== 'empty' && v.status !== 'invalid') return false;
  if (!Array.isArray(v.types) || !v.types.every(isTaskTypeSettingsRow)) return false;
  if (!Array.isArray(v.defaults) || !v.defaults.every(isTaskTypeSettingsRow)) return false;
  if (!Array.isArray(v.diagnostics)) return false;
  for (const d of v.diagnostics) {
    if (!isRecord(d) || !isString(d.code) || !isString(d.message)) return false;
  }
  if (!isRecord(v.constraints)) return false;
  const c = v.constraints;
  if (!isInteger(c.maxTypes) || c.maxTypes < 1) return false;
  if (!isInteger(c.descriptionMax) || c.descriptionMax < 1) return false;
  if (!isInteger(c.stringMax) || c.stringMax < 1) return false;
  if (!isString(c.idPattern) || c.idPattern.length === 0) return false;
  try {
    // Reject invalid regex syntax so the editor never throws on Save.
    // eslint-disable-next-line no-new
    new RegExp(c.idPattern);
  } catch {
    return false;
  }
  if (!Array.isArray(c.roles) || c.roles.length === 0) return false;
  if (!c.roles.every((role) => role === 'coordinator' || role === 'worker')) return false;
  if (!Array.isArray(c.briefKinds) || c.briefKinds.length === 0) return false;
  if (!c.briefKinds.every((kind) => typeof kind === 'string' && kind.length > 0)) return false;
  return true;
}

function isTaskTypesSettingsUpdateResult(v: unknown): v is TaskTypesSettingsUpdateResult {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return false;
  if (v.ok === true) return hasOnlyKeys(v, ['ok']);
  if (v.code !== 'invalid_task_type_config' && v.code !== 'updateFailed') return false;
  if (!isString(v.message)) return false;
  if (v.diagnostics !== undefined) {
    if (!Array.isArray(v.diagnostics)) return false;
    for (const d of v.diagnostics) {
      if (!isRecord(d) || !isString(d.code) || !isString(d.message)) return false;
    }
  }
  return true;
}


const PERMISSION_MODE_SETTINGS = new Set<PermissionModeSetting>(['ask', 'allow', 'readonly']);
const PERMISSION_MODE_RISKS = new Set<PermissionModeRisk>(['recommended', 'least-safe', 'restricted']);
const PERMISSION_SETTINGS_ERROR_CODES = new Set<PermissionSettingsErrorCode>([
  'invalidPayload',
  'unknownMode',
  'updateFailed',
]);

/** Keep permission Settings copy bounded so oversized host payloads fail closed. */
const PERMISSION_SETTINGS_DESCRIPTION_MAX = 512;
const PERMISSION_SETTINGS_OPTION_DESCRIPTION_MAX = 256;
const PERMISSION_SETTINGS_LABEL_MAX = 64;
const PERMISSION_SETTINGS_ERROR_MESSAGE_MAX = 256;

function isPermissionModeSetting(v: unknown): v is PermissionModeSetting {
  return isString(v) && PERMISSION_MODE_SETTINGS.has(v as PermissionModeSetting);
}

function isPermissionModeRisk(v: unknown): v is PermissionModeRisk {
  return isString(v) && PERMISSION_MODE_RISKS.has(v as PermissionModeRisk);
}

function isBoundedPermissionCopy(v: unknown, max: number): v is string {
  return isString(v) && v.length > 0 && v.length <= max;
}

function isPermissionModeOptionView(v: unknown): v is PermissionModeOptionView {
  if (!isRecord(v) || !hasOnlyKeys(v, ['mode', 'label', 'description', 'risk'])) return false;
  return (
    isPermissionModeSetting(v.mode) &&
    isBoundedPermissionCopy(v.label, PERMISSION_SETTINGS_LABEL_MAX) &&
    isBoundedPermissionCopy(v.description, PERMISSION_SETTINGS_OPTION_DESCRIPTION_MAX) &&
    isPermissionModeRisk(v.risk)
  );
}

function isPermissionSettingsSnapshot(v: unknown): v is PermissionSettingsSnapshot {
  if (!isRecord(v) || !hasOnlyKeys(v, ['mode', 'defaultMode', 'options', 'description'])) return false;
  if (!isPermissionModeSetting(v.mode) || !isPermissionModeSetting(v.defaultMode)) return false;
  if (!isBoundedPermissionCopy(v.description, PERMISSION_SETTINGS_DESCRIPTION_MAX)) return false;
  if (!Array.isArray(v.options) || v.options.length !== 3) return false;
  const seen = new Set<PermissionModeSetting>();
  for (const option of v.options) {
    if (!isPermissionModeOptionView(option) || seen.has(option.mode)) return false;
    seen.add(option.mode);
  }
  return (
    seen.has('ask') &&
    seen.has('allow') &&
    seen.has('readonly')
  );
}

function isPermissionSettingsUpdateResult(v: unknown): v is PermissionSettingsUpdateResult {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return false;
  if (v.ok === true) {
    return hasOnlyKeys(v, ['ok', 'mode']) && isPermissionModeSetting(v.mode);
  }
  return (
    hasOnlyKeys(v, ['ok', 'code', 'message']) &&
    isString(v.code) &&
    PERMISSION_SETTINGS_ERROR_CODES.has(v.code as PermissionSettingsErrorCode) &&
    isBoundedPermissionCopy(v.message, PERMISSION_SETTINGS_ERROR_MESSAGE_MAX)
  );
}

function isSettingsUpdateResult(v: unknown): v is SettingsUpdateResult {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return false;
  if (v.ok) {
    if (!isRuntimeStorageSettingId(v.settingId)) return false;
    const contract = RETENTION_SETTING_CONTRACT[v.settingId];
    return contract.kind === 'enum'
      ? isString(v.value) && (contract.options as readonly string[]).includes(v.value)
      : isInteger(v.value) && v.value >= contract.minimum;
  }
  if (!isRetentionSettingErrorCode(v.code) || !isString(v.message)) return false;
  if (v.code === 'unknownSetting') {
    return v.settingId === undefined;
  }
  return isRuntimeStorageSettingId(v.settingId);
}

function isTurnActivity(v: unknown): v is TurnActivity {
  if (v === null) return true;
  if (!isRecord(v) || !isString(v.state) || !isString(v.turnId)) return false;
  if (!isBoundedId(v.turnId, WORKSPACE_PATCH_ID_MAX)) return false;
  switch (v.state) {
    case 'queued':
      return (
        hasOnlyKeys(v, ['state', 'turnId', 'position', 'waitReason']) &&
        (v.position === undefined || (isNonNegativeSafeInteger(v.position) && v.position > 0)) &&
        (v.waitReason === undefined ||
          v.waitReason === 'dependencies' ||
          v.waitReason === 'children' ||
          v.waitReason === 'external' ||
          v.waitReason === 'held_after_failure' ||
          v.waitReason === 'live_turn_ahead')
      );
    case 'executing':
      return (
        hasOnlyKeys(v, ['state', 'turnId', 'phase']) &&
        (v.phase === undefined ||
          v.phase === 'starting' ||
          v.phase === 'streaming' ||
          v.phase === 'tool' ||
          v.phase === 'retrying')
      );
    case 'waiting_you':
      return (
        hasOnlyKeys(v, ['state', 'turnId', 'requestId']) &&
        (v.requestId === undefined || isBoundedId(v.requestId, WORKSPACE_PATCH_ID_MAX))
      );
    case 'failed_turn':
      return hasOnlyKeys(v, ['state', 'turnId', 'retryable']) && typeof v.retryable === 'boolean';
    case 'uncertain':
      return hasOnlyKeys(v, ['state', 'turnId', 'requiresConfirmation']) && v.requiresConfirmation === true;
    default:
      return false;
  }
}

function isTaskSummary(v: unknown): v is TaskSummary {
  if (!isRecord(v)) return false;
  if (
    !hasOnlyKeys(v, [
      'id',
      'parentId',
      'goal',
      'role',
      'lifecycle',
      'runtimeActivity',
      'viewStatus',
      'currentTurnActivity',
      'hasOutcomeProposal',
      'runTimeoutMessage',
      'updatedAt',
      'backend',
      'model',
      'continuationOf',
      'childOrchestration',
    ])
  ) {
    return false;
  }
  const lifecycle =
    v.lifecycle === 'open' ||
    v.lifecycle === 'succeeded' ||
    v.lifecycle === 'failed' ||
    v.lifecycle === 'cancelled' ||
    v.lifecycle === 'skipped';
  const runtimeActivity =
    v.runtimeActivity === null ||
    v.runtimeActivity === 'waiting_dependencies' ||
    v.runtimeActivity === 'queued' ||
    v.runtimeActivity === 'running' ||
    v.runtimeActivity === 'waiting_user' ||
    v.runtimeActivity === 'waiting_children' ||
    v.runtimeActivity === 'blocked' ||
    v.runtimeActivity === 'needs_recovery' ||
    v.runtimeActivity === 'idle' ||
    v.runtimeActivity === 'awaiting_outcome';
  const viewStatus =
    v.viewStatus === 'open' ||
    v.viewStatus === 'succeeded' ||
    v.viewStatus === 'failed' ||
    v.viewStatus === 'cancelled' ||
    v.viewStatus === 'skipped' ||
    v.viewStatus === 'waiting_dependencies' ||
    v.viewStatus === 'queued' ||
    v.viewStatus === 'running' ||
    v.viewStatus === 'waiting_user' ||
    v.viewStatus === 'waiting_children' ||
    v.viewStatus === 'blocked' ||
    v.viewStatus === 'needs_recovery' ||
    v.viewStatus === 'idle' ||
    v.viewStatus === 'awaiting_outcome';
  return (
    isBoundedId(v.id, WORKSPACE_PATCH_ID_MAX) &&
    (v.parentId === null || isBoundedId(v.parentId, WORKSPACE_PATCH_ID_MAX)) &&
    isString(v.goal) &&
    (v.role === 'coordinator' || v.role === 'worker') &&
    lifecycle &&
    runtimeActivity &&
    viewStatus &&
    isTurnActivity(v.currentTurnActivity) &&
    isString(v.updatedAt) &&
    isString(v.backend) &&
    (v.model === undefined || isString(v.model)) &&
    (v.continuationOf === undefined || isString(v.continuationOf)) &&
    (v.hasOutcomeProposal === undefined || typeof v.hasOutcomeProposal === 'boolean') &&
    (v.runTimeoutMessage === undefined || isString(v.runTimeoutMessage)) &&
    (v.childOrchestration === undefined ||
      (isRecord(v.childOrchestration) &&
        hasOnlyKeys(v.childOrchestration, [
          'total',
          'running',
          'open',
          'terminal',
          'awaitingParentSeal',
          'needsParentInput',
          'label',
        ]) &&
        isNonNegativeSafeInteger(v.childOrchestration.total) &&
        isNonNegativeSafeInteger(v.childOrchestration.running) &&
        isNonNegativeSafeInteger(v.childOrchestration.open) &&
        isNonNegativeSafeInteger(v.childOrchestration.terminal) &&
        isNonNegativeSafeInteger(v.childOrchestration.awaitingParentSeal) &&
        isNonNegativeSafeInteger(v.childOrchestration.needsParentInput) &&
        isString(v.childOrchestration.label)))
  );
}

function isTranscriptItem(v: unknown): v is TranscriptItem {
  if (!isRecord(v) || !isBoundedId(v.id, WORKSPACE_PATCH_ID_MAX)) return false;
  switch (v.kind) {
    case 'user':
    case 'assistant': {
      // Exact allowed keys; content is string; optional turnId/order/state typed.
      if (!hasOnlyKeys(v, ['id', 'kind', 'content', 'turnId', 'order', 'state'])) return false;
      if (!isString(v.content)) return false;
      if (v.turnId !== undefined && !isBoundedId(v.turnId, WORKSPACE_PATCH_ID_MAX)) return false;
      if (v.order !== undefined && !isNonNegativeSafeInteger(v.order)) return false;
      if (
        v.state !== undefined &&
        v.state !== 'pending' &&
        v.state !== 'assigned' &&
        v.state !== 'complete' &&
        v.state !== 'partial'
      ) {
        return false;
      }
      return true;
    }
    case 'reasoning': {
      // Exact keys; non-empty turnId; string content. Host never sends order/state.
      if (!hasOnlyKeys(v, ['id', 'kind', 'turnId', 'content'])) return false;
      return isBoundedId(v.turnId, WORKSPACE_PATCH_ID_MAX) && isString(v.content);
    }
    case 'tool': {
      // Exact top-level keys; structured tool content with fixed status/toolKind.
      if (!hasOnlyKeys(v, ['id', 'kind', 'turnId', 'order', 'content'])) return false;
      if (
        !isBoundedId(v.turnId, WORKSPACE_PATCH_ID_MAX) ||
        !isNonNegativeSafeInteger(v.order) ||
        !isRecord(v.content)
      ) return false;
      const c = v.content;
      if (
        !hasOnlyKeys(c, [
          'toolCallId',
          'name',
          'toolKind',
          'status',
          'input',
          'output',
          'error',
        ])
      ) {
        return false;
      }
      if (!isBoundedId(c.toolCallId, WORKSPACE_PATCH_ID_MAX) || !isString(c.name)) return false;
      if (c.status !== 'running' && c.status !== 'success' && c.status !== 'error') return false;
      if (
        c.toolKind !== undefined &&
        c.toolKind !== 'mcp' &&
        c.toolKind !== 'builtin' &&
        c.toolKind !== 'other'
      ) {
        return false;
      }
      if (c.error !== undefined && !isString(c.error)) return false;
      // input/output remain unknown payloads when present.
      return true;
    }
    case 'error':
      // Locally-synthesized only; host isExtMessage must reject error items.
      return false;
    default:
      return false;
  }
}

function isTranscriptPageState(v: unknown): v is TranscriptPageState {
  if (!isRecord(v)) return false;
  // Exact keys: hasMoreBefore + workspaceRevision + optional beforeCursor.
  if (!hasOnlyKeys(v, ['hasMoreBefore', 'workspaceRevision', 'beforeCursor'])) return false;
  if (typeof v.hasMoreBefore !== 'boolean') return false;
  // workspaceRevision: finite, non-negative safe integer.
  if (
    typeof v.workspaceRevision !== 'number' ||
    !Number.isFinite(v.workspaceRevision) ||
    !Number.isSafeInteger(v.workspaceRevision) ||
    v.workspaceRevision < 0
  ) {
    return false;
  }
  // beforeCursor is present only when there is an older page to fetch.
  if (v.hasMoreBefore) {
    if (!isString(v.beforeCursor) || v.beforeCursor.length === 0 || v.beforeCursor.length > TRANSCRIPT_PAGE_CURSOR_MAX) {
      return false;
    }
  } else if (v.beforeCursor !== undefined) {
    return false;
  }
  return true;
}

function isBoundedId(v: unknown, max: number): v is string {
  return isString(v) && v.length > 0 && v.length <= max && !v.includes('\0');
}

function isTranscriptPageErrorCode(v: unknown): v is TranscriptPageErrorCode {
  return (
    v === 'invalidRequest' ||
    v === 'staleFocus' ||
    v === 'taskNotFound' ||
    v === 'invalidCursor' ||
    v === 'unavailable'
  );
}

function isTranscriptPageResultMessage(data: Record<string, unknown>): boolean {
  if (data.type !== 'transcriptPageResult') return false;
  if (!isBoundedId(data.requestId, TRANSCRIPT_PAGE_REQUEST_ID_MAX)) return false;
  if (!isBoundedId(data.taskId, TRANSCRIPT_PAGE_TASK_ID_MAX)) return false;
  if (data.ok === true) {
    if (
      !hasOnlyKeys(data, ['type', 'requestId', 'taskId', 'ok', 'items', 'transcriptPage'])
    ) {
      return false;
    }
    if (!Array.isArray(data.items) || data.items.length > TRANSCRIPT_PAGE_MAX_ITEMS) return false;
    if (!data.items.every(isTranscriptItem)) return false;
    return isTranscriptPageState(data.transcriptPage);
  }
  if (data.ok === false) {
    if (!hasOnlyKeys(data, ['type', 'requestId', 'taskId', 'ok', 'code'])) return false;
    return isTranscriptPageErrorCode(data.code);
  }
  return false;
}

function isQueuedTurnProjection(v: unknown): v is QueuedTurnProjection {
  if (!isRecord(v)) return false;
  if (!hasOnlyKeys(v, ['turnId', 'sequence', 'status', 'messageIds', 'createdAt', 'previewText'])) {
    return false;
  }
  if (!Array.isArray(v.messageIds) || v.messageIds.length > WORKSPACE_PATCH_MAX_ITEMS) return false;
  const seenMessageIds = new Set<string>();
  for (const messageId of v.messageIds) {
    if (!isWorkspacePatchIdentity(messageId) || seenMessageIds.has(messageId)) return false;
    seenMessageIds.add(messageId);
  }
  return (
    isWorkspacePatchIdentity(v.turnId) &&
    isNonNegativeSafeInteger(v.sequence) &&
    v.sequence > 0 &&
    v.status === 'queued' &&
    isString(v.createdAt) &&
    (v.previewText === undefined || isString(v.previewText))
  );
}

function isNonNegativeSafeInteger(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    Number.isSafeInteger(v) &&
    v >= 0
  );
}

function isWorkspacePatchIdentity(v: unknown): v is string {
  return isBoundedId(v, WORKSPACE_PATCH_ID_MAX);
}

function isWorkspacePatch(v: unknown): v is WorkspacePatch {
  if (!isRecord(v) || !isString(v.type)) return false;
  switch (v.type) {
    case 'taskUpserted':
      return hasOnlyKeys(v, ['type', 'task']) && isTaskSummary(v.task) && isWorkspacePatchIdentity(v.task.id);
    case 'turnActivityChanged':
      return hasOnlyKeys(v, ['type', 'task']) && isTaskSummary(v.task) && isWorkspacePatchIdentity(v.task.id);
    case 'transcriptItemsAppended': {
      if (!hasOnlyKeys(v, ['type', 'taskId', 'items'])) return false;
      if (!isWorkspacePatchIdentity(v.taskId)) return false;
      if (!Array.isArray(v.items) || v.items.length === 0 || v.items.length > WORKSPACE_PATCH_MAX_ITEMS) {
        return false;
      }
      if (!v.items.every(isTranscriptItem)) return false;
      const seen = new Set<string>();
      for (const item of v.items) {
        if (!isWorkspacePatchIdentity(item.id) || seen.has(item.id)) return false;
        seen.add(item.id);
      }
      return true;
    }
    case 'transcriptItemPatched':
      return (
        hasOnlyKeys(v, ['type', 'taskId', 'item']) &&
        isWorkspacePatchIdentity(v.taskId) &&
        isTranscriptItem(v.item) &&
        isWorkspacePatchIdentity(v.item.id)
      );
    case 'transcriptItemsRemoved': {
      if (!hasOnlyKeys(v, ['type', 'taskId', 'itemIds'])) return false;
      if (!isWorkspacePatchIdentity(v.taskId)) return false;
      if (!Array.isArray(v.itemIds) || v.itemIds.length === 0 || v.itemIds.length > WORKSPACE_PATCH_MAX_ITEMS) {
        return false;
      }
      const seen = new Set<string>();
      for (const itemId of v.itemIds) {
        if (!isWorkspacePatchIdentity(itemId) || seen.has(itemId)) return false;
        seen.add(itemId);
      }
      return true;
    }
    case 'queuedTurnsChanged': {
      if (!hasOnlyKeys(v, ['type', 'taskId', 'queuedTurns'])) return false;
      if (!isWorkspacePatchIdentity(v.taskId)) return false;
      if (!Array.isArray(v.queuedTurns) || v.queuedTurns.length > WORKSPACE_PATCH_MAX_QUEUED) return false;
      if (!v.queuedTurns.every(isQueuedTurnProjection)) return false;
      const seen = new Set<string>();
      for (const turn of v.queuedTurns) {
        if (!isWorkspacePatchIdentity(turn.turnId) || seen.has(turn.turnId)) return false;
        seen.add(turn.turnId);
      }
      return true;
    }
    case 'taskRemoved':
      return hasOnlyKeys(v, ['type', 'taskId']) && isWorkspacePatchIdentity(v.taskId);
    default:
      return false;
  }
}

function isWorkspacePatchBatchMessage(data: Record<string, unknown>): boolean {
  if (data.type !== 'workspacePatchBatch') return false;
  if (!hasOnlyKeys(data, ['type', 'revision', 'patches'])) return false;
  if (!isNonNegativeSafeInteger(data.revision)) return false;
  if (!Array.isArray(data.patches) || data.patches.length > WORKSPACE_PATCH_MAX_PATCHES) return false;
  if (!data.patches.every(isWorkspacePatch)) return false;

  // Reject duplicate stable identities within the same atomic batch.
  const taskIds = new Set<string>();
  const transcriptKeys = new Set<string>();
  const queueTaskIds = new Set<string>();
  let totalTranscriptItems = 0;
  let totalQueuedTurns = 0;
  for (const patch of data.patches as WorkspacePatch[]) {
    switch (patch.type) {
      case 'taskUpserted':
      case 'turnActivityChanged': {
        if (taskIds.has(patch.task.id)) return false;
        taskIds.add(patch.task.id);
        break;
      }
      case 'taskRemoved': {
        if (taskIds.has(patch.taskId)) return false;
        taskIds.add(patch.taskId);
        break;
      }
      case 'transcriptItemsAppended': {
        totalTranscriptItems += patch.items.length;
        if (totalTranscriptItems > WORKSPACE_PATCH_MAX_ITEMS) return false;
        for (const item of patch.items) {
          const key = `${patch.taskId}\0${item.id}`;
          if (transcriptKeys.has(key)) return false;
          transcriptKeys.add(key);
        }
        break;
      }
      case 'transcriptItemPatched': {
        totalTranscriptItems += 1;
        if (totalTranscriptItems > WORKSPACE_PATCH_MAX_ITEMS) return false;
        const key = `${patch.taskId}\0${patch.item.id}`;
        if (transcriptKeys.has(key)) return false;
        transcriptKeys.add(key);
        break;
      }
      case 'transcriptItemsRemoved': {
        totalTranscriptItems += patch.itemIds.length;
        if (totalTranscriptItems > WORKSPACE_PATCH_MAX_ITEMS) return false;
        for (const itemId of patch.itemIds) {
          const key = `${patch.taskId}\0${itemId}`;
          if (transcriptKeys.has(key)) return false;
          transcriptKeys.add(key);
        }
        break;
      }
      case 'queuedTurnsChanged': {
        totalQueuedTurns += patch.queuedTurns.length;
        if (totalQueuedTurns > WORKSPACE_PATCH_MAX_QUEUED) return false;
        if (queueTaskIds.has(patch.taskId)) return false;
        queueTaskIds.add(patch.taskId);
        break;
      }
    }
  }
  return true;
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
    case 'snapshot': {
      if (
        !(
          hasOnlyKeys(data, [
            'type',
            'protocolVersion',
            'rootTasks',
            'focusedTaskId',
            'subtree',
            'transcript',
            'transcriptPage',
            'activeTurnId',
            'queuedTurns',
            'pendingAsk',
            'storeRevision',
          ]) &&
          isNumber(data.protocolVersion) &&
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
        )
      ) {
        return false;
      }
      // Protocol v6 current-only contract: a focused snapshot always carries a
      // transcript array AND transcriptPage metadata; a no-focus snapshot has
      // neither. No optional-fallback tolerance for the old (pre-v6) shape.
      if (isString(data.focusedTaskId)) {
        return (
          Array.isArray(data.transcript) &&
          data.transcript.every(isTranscriptItem) &&
          isTranscriptPageState(data.transcriptPage)
        );
      }
      return data.transcript === undefined && data.transcriptPage === undefined;
    }

    case 'settingsSnapshot':
      return hasOnlyKeys(data, ['type', 'snapshot']) && isRuntimeStorageSettingsSnapshot(data.snapshot);

    case 'settingsUpdateResult':
      return hasOnlyKeys(data, ['type', 'result']) && isSettingsUpdateResult(data.result);

    case 'taskTypesSettingsSnapshot':
      return hasOnlyKeys(data, ['type', 'snapshot']) && isTaskTypesSettingsSnapshot(data.snapshot);

    case 'taskTypesSettingsUpdateResult':
      return hasOnlyKeys(data, ['type', 'result']) && isTaskTypesSettingsUpdateResult(data.result);

    case 'permissionSettingsSnapshot':
      return hasOnlyKeys(data, ['type', 'snapshot']) && isPermissionSettingsSnapshot(data.snapshot);

    case 'permissionSettingsUpdateResult':
      return hasOnlyKeys(data, ['type', 'result']) && isPermissionSettingsUpdateResult(data.result);

    case 'workspacePatchBatch':
      return isWorkspacePatchBatchMessage(data);

    case 'turnStart':
      return isString(data.trigger);

    case 'event':
      return isNormalizedEvent(data.event);

    case 'turnDone':
      return true;

    case 'turnError':
      return isString(data.message);

    case 'transcriptPageResult':
      return isTranscriptPageResultMessage(data);

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


    case 'filePicked':
      return isString(data.path) && (data.displayName === undefined || isString(data.displayName));

    case 'backendsAvailable':
      return Array.isArray(data.backends) && data.backends.every(isString);

    case 'skillsAvailable':
      return (
        isString(data.backend) &&
        isString(data.prefix) &&
        Array.isArray(data.skills) &&
        data.skills.every(isString)
      );

    case 'modelsAvailable':
      return typeof data.models === 'object' && data.models !== null;

    case 'composerSelection':
      return (
        hasOnlyKeys(data, ['type', 'backend', 'model']) &&
        isString(data.backend) &&
        (data.model === null || isString(data.model))
      );

    case 'sendOutboxSnapshot':
      return (
        hasOnlyKeys(data, ['type', 'entries']) &&
        Array.isArray(data.entries) &&
        data.entries.length <= 32 &&
        data.entries.every(isSendOutboxSnapshotEntry) &&
        new Set(data.entries.map((entry) => (entry as { clientRequestId: string }).clientRequestId)).size ===
          data.entries.length
      );

    case 'exportResult':
      return (
        hasOnlyKeys(data, ['type', 'taskId', 'fileName', 'sourceRevision', 'exportedAt']) &&
        isString(data.taskId) &&
        isExportResultFileName(data.fileName) &&
        isInteger(data.sourceRevision) &&
        isExportResultTimestamp(data.exportedAt)
      );

    case 'fileMentionSuggestions':
      return isFileMentionSuggestionsMessage(data);

    default:
      return false;
  }
}

const FILE_MENTION_SUGGESTION_ERROR_CODES = new Set<FileMentionSuggestionsErrorCode>([
  'invalidRequest',
  'unavailable',
  'listingFailed',
]);

/** Relative mention paths for autocomplete — absolute/drive/UNC rejected; up to two leading `../` allowed. */
function isRelativeFileMentionPath(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const value = v.trim();
  if (value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (value.startsWith('//') || value.startsWith('\\\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const normalized = value.replace(/\\/g, '/');
  let rest = normalized;
  let parentDepth = 0;
  while (parentDepth < 3) {
    if (rest.startsWith('../')) {
      parentDepth += 1;
      rest = rest.slice(3);
      continue;
    }
    break;
  }
  if (parentDepth > 2) return false;
  // Bare ../ or ../../ is not a file/directory insertion path.
  if (rest.length === 0) return false;
  if (rest === '.' || rest === '..' || rest.startsWith('./') || rest.startsWith('../')) return false;
  const segments = rest.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

function isFileMentionSuggestionItem(v: unknown): v is FileMentionSuggestionItem {
  if (!isRecord(v)) return false;
  if (!hasOnlyKeys(v, ['id', 'kind', 'label', 'insertionPath'])) return false;
  if (!isString(v.id) || v.id.trim().length === 0) return false;
  if (v.kind !== 'file' && v.kind !== 'directory') return false;
  if (!isString(v.label) || v.label.trim().length === 0) return false;
  if (v.label.includes('/') || v.label.includes('\\')) return false;
  return isRelativeFileMentionPath(v.insertionPath);
}

function isFileMentionSuggestionsMessage(data: Record<string, unknown>): boolean {
  if (!isString(data.requestId) || data.requestId.trim().length === 0) return false;

  if (data.ok === false) {
    return (
      hasOnlyKeys(data, ['type', 'ok', 'requestId', 'code']) &&
      isString(data.code) &&
      FILE_MENTION_SUGGESTION_ERROR_CODES.has(data.code as FileMentionSuggestionsErrorCode)
    );
  }

  // Success: ok may be omitted or true.
  if (data.ok !== undefined && data.ok !== true) return false;
  const allowed =
    data.ok === true
      ? (['type', 'ok', 'requestId', 'parentDepth', 'relativeQuery', 'items'] as const)
      : (['type', 'requestId', 'parentDepth', 'relativeQuery', 'items'] as const);
  if (!hasOnlyKeys(data, allowed)) return false;
  if (data.parentDepth !== 0 && data.parentDepth !== 1 && data.parentDepth !== 2) return false;
  if (!isString(data.relativeQuery)) return false;
  // relativeQuery may be empty (bare @) but must not carry control chars.
  for (let i = 0; i < data.relativeQuery.length; i += 1) {
    const code = data.relativeQuery.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (!Array.isArray(data.items)) return false;
  return data.items.every(isFileMentionSuggestionItem);
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
 * Task-scoped banner visibility for commandError refusals and command notices.
 * Global (absent/null taskId) banners always show; otherwise only the currently
 * focused task sees the feedback.
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
