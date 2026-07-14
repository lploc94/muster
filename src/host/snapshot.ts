import type { Question } from '../bridge/ask-bridge';
import { deriveRuntimeActivity, deriveViewStatus } from '../task/derived-status';
import { dependenciesBlockTask } from '../task/scheduler';
import { sanitizeHandoffFailureMessage } from '../task/store';
import type { TaskStore } from '../task/store';
import type {
  MusterTask,
  TaskHandoffPhase,
  TaskHandoffState,
  TaskLifecycleState,
  TaskMessageState,
  TaskRole,
  TaskRuntimeActivity,
  TaskStoreFile,
  TaskTurn,
  TaskViewStatus,
} from '../task/types';

/** Host-owned turn chrome (product surface). Not process/CLI vocabulary. */
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

/**
 * Sanitized, task-scoped handoff chrome for the webview.
 * Never includes digests, summary/bootstrap bodies, session ids, or credentials.
 */
export interface HandoffProgressBinding {
  backend: string;
  model?: string;
}

export interface HandoffProgressFailure {
  code: string;
  message: string;
  at: string;
}

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
  role: TaskRole;
  /** User-facing work outcome (open / succeeded / failed / cancelled / skipped). */
  lifecycle: TaskLifecycleState;
  /**
   * Host-derived deps/wait activity while lifecycle is open; null when terminal.
   * Prefer currentTurnActivity for turn chrome.
   */
  runtimeActivity: TaskRuntimeActivity | null;
  /**
   * Compact single-axis status for older consumers: terminal lifecycle or
   * runtime activity. Prefer lifecycle + currentTurnActivity.
   */
  viewStatus: TaskViewStatus;
  /** Host-authoritative turn activity for composer/list chrome (required protocol v3+). */
  currentTurnActivity: TurnActivity;
  /** Agent proposed complete/fail; root stays open until user continues or accepts. */
  hasOutcomeProposal?: boolean;
  updatedAt: string;
  backend: string;
  /** Optional model id selected for this task (ACP session config option value). */
  model?: string;
  continuationOf?: string;
  /**
   * Optional sanitized handoff progress for model-switch chrome (D018 / §19).
   * Omitted when the task has no handoff. Never carries digests, session ids,
   * or summary/bootstrap bodies — those stay off TaskSummary and chat.
   */
  handoffProgress?: HandoffProgress;
}

export interface ToolTranscriptContent {
  toolCallId: string;
  name: string;
  toolKind?: 'mcp' | 'builtin' | 'other';
  status: 'running' | 'success' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
}

export type TranscriptItem =
  | {
      id: string;
      kind: 'user' | 'assistant';
      content: string;
      turnId?: string;
      order?: number;
      state?: TaskMessageState;
    }
  | { id: string; kind: 'tool'; turnId: string; order: number; content: ToolTranscriptContent }
  | { id: string; kind: 'reasoning'; turnId: string; content: string };

/**
 * Authoritative queued follow-up turn projection for S03 edit/delete and S04
 * composer feedback. Ordered by FIFO sequence (then createdAt, then id).
 * Each entry binds a distinct turn identity to its message inputs.
 */
export interface QueuedTurnProjection {
  turnId: string;
  sequence: number;
  status: 'queued';
  messageIds: string[];
  createdAt: string;
  /**
   * Host-projected user text so the S04 queue panel does not depend on chat transcript
   * (queued follow-ups stay out of chat).
   */
  previewText?: string;
}

export interface TaskSnapshot {
  rootTasks: TaskSummary[];
  focusedTaskId?: string;
  subtree?: TaskSummary[];
  transcript?: TranscriptItem[];
  /**
   * Currently live (running/waiting_user) turn, or the sole queued turn when
   * nothing is live, or the latest retryable turn under needs_recovery.
   * Never prefers a later queued follow-up over a live turn (R012 multi-queue).
   */
  activeTurnId?: string;
  /** FIFO queued follow-ups for the focused task (excludes the live turn). */
  queuedTurns?: QueuedTurnProjection[];
  storeRevision: number;
  pendingAsk?: { turnId: string; askId: string; questions: Question[] };
}

export interface PendingAskOverlay {
  taskId: string;
  turnId: string;
  askId: string;
  questions: Question[];
}

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((turn) => turn.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
}

function depLifecyclesForTask(file: TaskStoreFile, task: MusterTask): Map<string, TaskLifecycleState> {
  const map = new Map<string, TaskLifecycleState>();
  for (const dep of task.dependencies) {
    const depTask = file.tasks[dep.taskId];
    if (depTask) {
      map.set(dep.taskId, depTask.lifecycle);
    }
  }
  return map;
}

function maxIso(...values: (string | undefined)[]): string {
  const present = values.filter((value): value is string => typeof value === 'string');
  if (present.length === 0) {
    return '';
  }
  return present.reduce((latest, value) => (value.localeCompare(latest) > 0 ? value : latest));
}

export function projectActivityTime(file: TaskStoreFile, taskId: string): string {
  const task = file.tasks[taskId];
  if (!task) {
    return '';
  }
  let latest = task.updatedAt;
  for (const turn of turnsForTask(file, taskId)) {
    latest = maxIso(latest, turn.createdAt, turn.startedAt, turn.finishedAt);
  }
  for (const message of Object.values(file.messages)) {
    if (message.taskId === taskId) {
      latest = maxIso(latest, message.createdAt);
    }
  }
  for (const tc of Object.values(file.toolCalls ?? {})) {
    if (tc.taskId === taskId) {
      latest = maxIso(latest, tc.createdAt, tc.updatedAt);
    }
  }
  for (const r of Object.values(file.reasoning ?? {})) {
    if (r.taskId === taskId) {
      latest = maxIso(latest, r.createdAt, r.updatedAt);
    }
  }
  return latest;
}

function queuedTurnsFifo(turns: readonly TaskTurn[]): TaskTurn[] {
  return turns
    .filter((turn) => turn.status === 'queued')
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

function waitReasonForQueuedTurn(file: TaskStoreFile, task: MusterTask, turn: TaskTurn): TurnActivityWaitReason | undefined {
  if (dependenciesBlockTask(file, task.id)) {
    return 'dependencies';
  }
  if (task.wait?.kind === 'children') {
    return 'children';
  }
  if (task.wait?.kind === 'external') {
    return 'external';
  }
  if (turn.holdAutoPromote) {
    return 'held_after_failure';
  }
  return undefined;
}

function isPureUserStop(turn: TaskTurn): boolean {
  if (turn.status !== 'interrupted') return false;
  if (turn.interruptConfidence === 'forced') return false;
  // Confirmed cancel / user Stop: transcript shows cancel; no sticky failed chrome.
  if (turn.interruptConfidence === 'confirmed') return true;
  return turn.isCancellation === true && !turn.error;
}

/**
 * Host projection precedence for currentTurnActivity (first match wins):
 * 1. Live turn (running / waiting_user)
 * 2. Earliest queued turn (+ waitReason when blocked)
 * 3. Latest failed needing attention; pure user Stop → null
 * 4. else null
 */
export function projectCurrentTurnActivity(file: TaskStoreFile, taskId: string): TurnActivity {
  const task = file.tasks[taskId];
  if (!task || task.lifecycle !== 'open') {
    return null;
  }
  const turns = turnsForTask(file, taskId);
  const live = turns.filter((turn) => turn.status === 'running' || turn.status === 'waiting_user');
  if (live.length > 0) {
    const liveTurn = live.reduce((latest, turn) => (turn.sequence > latest.sequence ? turn : latest));
    if (liveTurn.status === 'waiting_user') {
      return { state: 'waiting_you', turnId: liveTurn.id };
    }
    const phase = liveTurn.retryOf ? 'retrying' : undefined;
    return phase
      ? { state: 'executing', turnId: liveTurn.id, phase }
      : { state: 'executing', turnId: liveTurn.id };
  }

  const queued = queuedTurnsFifo(turns);
  if (queued.length > 0) {
    const earliest = queued[0]!;
    const waitReason = waitReasonForQueuedTurn(file, task, earliest);
    return {
      state: 'queued',
      turnId: earliest.id,
      position: 1,
      ...(waitReason ? { waitReason } : {}),
    };
  }

  // Inspect latest settled turn overall so a later success clears prior failure chrome.
  const settled = turns
    .filter(
      (turn) =>
        turn.status === 'succeeded' ||
        turn.status === 'failed' ||
        turn.status === 'interrupted' ||
        turn.status === 'cancelled',
    )
    .sort((a, b) => b.sequence - a.sequence || b.createdAt.localeCompare(a.createdAt));
  const latest = settled[0];
  if (!latest) {
    return null;
  }
  if (latest.status === 'succeeded' || latest.status === 'cancelled') {
    return null;
  }
  if (isPureUserStop(latest)) {
    return null;
  }
  if (latest.failureClass === 'uncertain') {
    return { state: 'uncertain', turnId: latest.id, requiresConfirmation: true };
  }
  if (latest.status === 'failed') {
    return { state: 'failed_turn', turnId: latest.id, retryable: true };
  }
  // Ambiguous / forced interrupt without confirmed user Stop: soft failed_turn.
  return { state: 'failed_turn', turnId: latest.id, retryable: true };
}

function projectHandoffBinding(binding: {
  backend: string;
  model?: string;
}): HandoffProgressBinding {
  return binding.model
    ? { backend: binding.backend, model: binding.model }
    : { backend: binding.backend };
}

/**
 * Project durable TaskHandoff state into omission-safe chrome progress.
 * Labels + phase + timestamps + bounded failure only — never digests, bodies,
 * or session identifiers (MEM156 / D018).
 */
export function projectHandoffProgress(
  handoff: TaskHandoffState | undefined,
): HandoffProgress | undefined {
  if (!handoff) {
    return undefined;
  }
  const progress: HandoffProgress = {
    operationId: handoff.operationId,
    phase: handoff.phase,
    source: projectHandoffBinding(handoff.source),
    target: projectHandoffBinding(handoff.target),
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
  };
  if (handoff.startedAt) {
    progress.startedAt = handoff.startedAt;
  }
  if (handoff.finishedAt) {
    progress.finishedAt = handoff.finishedAt;
  }
  if (handoff.failure) {
    progress.failure = {
      code: handoff.failure.code,
      // Re-sanitize at the projection boundary so raw/legacy failure text cannot leak.
      message: sanitizeHandoffFailureMessage(handoff.failure.message),
      at: handoff.failure.at,
    };
  }
  return progress;
}

export function projectTaskSummary(file: TaskStoreFile, taskId: string): TaskSummary | undefined {
  const task = file.tasks[taskId];
  if (!task) {
    return undefined;
  }
  const turns = turnsForTask(file, taskId);
  const deps = depLifecyclesForTask(file, task);
  const handoffProgress = projectHandoffProgress(task.handoff);
  return {
    id: task.id,
    parentId: task.parentId,
    goal: task.goal,
    role: task.role,
    lifecycle: task.lifecycle,
    runtimeActivity: deriveRuntimeActivity(task, turns, deps),
    viewStatus: deriveViewStatus(task, turns, deps),
    currentTurnActivity: projectCurrentTurnActivity(file, taskId),
    hasOutcomeProposal: task.outcomeProposal != null,
    updatedAt: projectActivityTime(file, taskId),
    backend: task.backend,
    model: task.model,
    continuationOf: task.continuationOf,
    ...(handoffProgress ? { handoffProgress } : {}),
  };
}

export function buildTranscript(file: TaskStoreFile, taskId: string): TranscriptItem[] {
  const turns = turnsForTask(file, taskId);
  const seqOf = new Map<string, number>();
  for (const turn of turns) {
    seqOf.set(turn.id, turn.sequence);
  }
  // User messages link to a turn via turn.inputs (they carry no turnId themselves).
  const msgTurn = new Map<string, string>();
  for (const turn of turns) {
    for (const input of turn.inputs) {
      if (input.kind === 'message') {
        msgTurn.set(input.messageId, turn.id);
      }
    }
  }

  interface Entry {
    item: TranscriptItem;
    seq: number;
    order: number;
    createdAt: string;
    id: string;
  }
  const entries: Entry[] = [];

  for (const message of Object.values(file.messages)) {
    if (message.taskId !== taskId) {
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }
    const turnId = message.role === 'assistant' ? message.turnId : (message.turnId ?? msgTurn.get(message.id));
    // FIFO follow-ups stay in the queue panel only until their turn starts.
    // Do not project user messages bound to still-queued turns into chat.
    if (message.role === 'user' && turnId) {
      const boundTurn = file.turns[turnId];
      if (boundTurn?.status === 'queued') {
        continue;
      }
    }
    const seq = turnId !== undefined && seqOf.has(turnId) ? seqOf.get(turnId)! : -1;
    // Opening user prompts use order -2 (before reasoning -1 / assistant >=0).
    // Explicit message.order (if present) is respected for ordered segments.
    const order =
      message.role === 'assistant'
        ? (message.order ?? 0)
        : message.order !== undefined
          ? message.order
          : -2;
    entries.push({
      item: {
        id: message.id,
        kind: message.role,
        content: message.content,
        turnId,
        order: message.order,
        state: message.state,
      },
      seq,
      order,
      createdAt: message.createdAt,
      id: message.id,
    });
  }

  for (const tc of Object.values(file.toolCalls ?? {})) {
    if (tc.taskId !== taskId) {
      continue;
    }
    const seq = seqOf.has(tc.turnId) ? seqOf.get(tc.turnId)! : -1;
    entries.push({
      item: {
        id: tc.id,
        kind: 'tool',
        turnId: tc.turnId,
        order: tc.order,
        content: {
          toolCallId: tc.toolCallId,
          name: tc.name,
          toolKind: tc.kind,
          status: tc.status,
          input: tc.input,
          output: tc.output,
          error: tc.error,
        },
      },
      seq,
      order: tc.order,
      createdAt: tc.createdAt,
      id: tc.id,
    });
  }

  for (const r of Object.values(file.reasoning ?? {})) {
    if (r.taskId !== taskId) {
      continue;
    }
    const seq = seqOf.has(r.turnId) ? seqOf.get(r.turnId)! : -1;
    entries.push({
      item: { id: r.id, kind: 'reasoning', turnId: r.turnId, content: r.content },
      seq,
      order: -1,
      createdAt: r.createdAt,
      id: r.id,
    });
  }

  entries.sort(
    (a, b) =>
      a.seq - b.seq ||
      a.order - b.order ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  return entries.map((entry) => entry.item);
}

function messageIdsForTurn(turn: TaskTurn): string[] {
  return turn.inputs
    .filter((input): input is { kind: 'message'; messageId: string } => input.kind === 'message')
    .map((input) => input.messageId);
}

/**
 * FIFO queued follow-up turns for a task. Excludes live/settled turns so S03/S04
 * can key edit/delete and composer feedback off dedicated turn identity.
 */
function previewTextForQueuedTurn(file: TaskStoreFile, turn: TaskTurn): string {
  const parts: string[] = [];
  for (const messageId of messageIdsForTurn(turn)) {
    const message = file.messages[messageId];
    if (!message || message.role !== 'user') continue;
    const text = message.content.trim();
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

export function projectQueuedTurns(file: TaskStoreFile, taskId: string): QueuedTurnProjection[] {
  return turnsForTask(file, taskId)
    .filter((turn) => turn.status === 'queued')
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .map((turn) => {
      const previewText = previewTextForQueuedTurn(file, turn);
      return {
        turnId: turn.id,
        sequence: turn.sequence,
        status: 'queued' as const,
        messageIds: messageIdsForTurn(turn),
        createdAt: turn.createdAt,
        ...(previewText ? { previewText } : {}),
      };
    });
}

/**
 * Active turn for host/webview controls:
 * 1. Live running/waiting_user turn (never a later queued follow-up)
 * 2. Else earliest queued turn by sequence (resume target when nothing is live)
 * 3. Else latest failed/interrupted under needs_recovery
 */
export function activeTurnIdForTask(file: TaskStoreFile, taskId: string): string | undefined {
  const turns = turnsForTask(file, taskId);
  const live = turns.filter((turn) => turn.status === 'running' || turn.status === 'waiting_user');
  if (live.length > 0) {
    // Prefer highest sequence if multiple live (should be rare; scheduler enforces one).
    return live.reduce((latest, turn) => (turn.sequence > latest.sequence ? turn : latest)).id;
  }
  const queued = turns
    .filter((turn) => turn.status === 'queued')
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  if (queued.length > 0) {
    return queued[0]!.id;
  }
  const task = file.tasks[taskId];
  if (!task) {
    return undefined;
  }
  const viewStatus = deriveViewStatus(task, turns, depLifecyclesForTask(file, task));
  if (viewStatus !== 'needs_recovery') {
    return undefined;
  }
  const retryable = turns.filter((turn) => turn.status === 'failed' || turn.status === 'interrupted');
  if (retryable.length === 0) {
    return undefined;
  }
  return retryable.reduce((latest, turn) => (turn.sequence > latest.sequence ? turn : latest)).id;
}

export function buildSnapshot(
  store: TaskStore,
  focusedTaskId?: string,
  activePendingAsks?: ReadonlyMap<string, PendingAskOverlay>,
): TaskSnapshot {
  const file = store.getFile();
  const rootTasks = Object.values(file.tasks)
    .filter((task) => task.parentId === null)
    .map((task) => projectTaskSummary(file, task.id))
    .filter((summary): summary is TaskSummary => summary !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));

  const snapshot: TaskSnapshot = {
    rootTasks,
    focusedTaskId,
    storeRevision: file.revision,
  };

  if (!focusedTaskId) {
    return snapshot;
  }

  const subtreeIds = collectSubtreeIds(file, focusedTaskId);
  snapshot.subtree = subtreeIds
    .map((taskId) => projectTaskSummary(file, taskId))
    .filter((summary): summary is TaskSummary => summary !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  snapshot.transcript = buildTranscript(file, focusedTaskId);
  snapshot.activeTurnId = activeTurnIdForTask(file, focusedTaskId);
  snapshot.queuedTurns = projectQueuedTurns(file, focusedTaskId);

  const pending = activePendingAsks?.get(focusedTaskId);
  if (pending) {
    snapshot.pendingAsk = {
      turnId: pending.turnId,
      askId: pending.askId,
      questions: pending.questions,
    };
  }

  return snapshot;
}

function collectSubtreeIds(file: TaskStoreFile, rootTaskId: string): string[] {
  const ids = [rootTaskId];
  const queue = [rootTaskId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const children = Object.values(file.tasks)
      .filter((task) => task.parentId === current)
      .map((task) => task.id)
      .sort();
    for (const childId of children) {
      ids.push(childId);
      queue.push(childId);
    }
  }
  return ids;
}