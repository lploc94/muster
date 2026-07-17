import type { Question } from '../bridge/ask-bridge';
import { deriveRuntimeActivity, deriveViewStatus } from '../task/derived-status';
import { dependenciesBlockTask } from '../task/scheduler';
import {
  ASSISTANT_ORDERING_FALLBACK,
  KIND_RANK,
  REASONING_ORDERING,
  UNBOUND_TURN_SEQUENCE,
  USER_ORDERING_FALLBACK,
  compareTranscriptKeys,
  type TranscriptSortKey,
} from '../task/transcript-order';
import type {
  MusterTask,
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
  /** Sanitized explanation for the latest configured run-limit termination. */
  runTimeoutMessage?: string;
  updatedAt: string;
  backend: string;
  /** Optional model id selected for this task (ACP session config option value). */
  model?: string;
  continuationOf?: string;
  /**
   * Aggregate direct-child orchestration chrome for coordinators (P2).
   * Omitted when there are no children.
   */
  childOrchestration?: {
    total: number;
    running: number;
    open: number;
    terminal: number;
    repairPending: number;
    needsParentInput: number;
    label: string;
  };
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

export interface TaskSnapshotReader {
  getFile(): Readonly<TaskStoreFile>;
}

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((turn) => turn.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * A newly-created task briefly has one queued turn before the scheduler starts it.
 * Present that opening prompt as chat immediately; the queue panel is reserved for
 * follow-ups waiting behind an existing turn.
 */
function isOpeningQueuedTurn(turn: TaskTurn, taskTurns: readonly TaskTurn[]): boolean {
  return (
    turn.status === 'queued' &&
    taskTurns.length === 1 &&
    turn.trigger === 'user' &&
    turn.inputs.some((input) => input.kind === 'message')
  );
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

function projectChildOrchestration(
  file: TaskStoreFile,
  parentId: string,
): TaskSummary['childOrchestration'] | undefined {
  const children = Object.values(file.tasks).filter((t) => t.parentId === parentId);
  if (children.length === 0) return undefined;
  let running = 0;
  let open = 0;
  let terminal = 0;
  let repairPending = 0;
  let needsParentInput = 0;
  for (const child of children) {
    if (
      child.lifecycle === 'succeeded' ||
      child.lifecycle === 'failed' ||
      child.lifecycle === 'cancelled' ||
      child.lifecycle === 'skipped'
    ) {
      terminal += 1;
    } else {
      open += 1;
      const live = turnsForTask(file, child.id).some(
        (t) => t.status === 'running' || t.status === 'waiting_user',
      );
      if (live) running += 1;
    }
    if (child.attention?.code === 'disposition_repair_pending') repairPending += 1;
    if (
      child.pendingParentQuestion &&
      child.pendingParentQuestion.answers === undefined &&
      !child.pendingParentQuestion.continuationTurnId
    ) {
      needsParentInput += 1;
    }
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (open - running > 0) parts.push(`${open - running} open`);
  if (terminal > 0) parts.push(`${terminal} done`);
  if (repairPending > 0) parts.push(`${repairPending} disposition retry`);
  if (needsParentInput > 0) parts.push(`${needsParentInput} need input`);
  return {
    total: children.length,
    running,
    open,
    terminal,
    repairPending,
    needsParentInput,
    label: parts.length > 0 ? parts.join(' · ') : `${children.length} children`,
  };
}

export function projectTaskSummary(file: TaskStoreFile, taskId: string): TaskSummary | undefined {
  const task = file.tasks[taskId];
  if (!task) {
    return undefined;
  }
  const turns = turnsForTask(file, taskId);
  const deps = depLifecyclesForTask(file, task);
  const childOrchestration =
    task.role === 'coordinator' ? projectChildOrchestration(file, taskId) : undefined;
  // Only the latest settled/live turn may present a run-timeout reason. Historical
  // timeouts must not mislabel a later ordinary failure after retry.
  const latestTurn = [...turns].sort((a, b) => b.sequence - a.sequence)[0];
  const timedOut =
    latestTurn?.termination?.kind === 'run_timeout' ? latestTurn : undefined;
  const timeoutLabel = timedOut?.termination
    ? timedOut.termination.limitMs >= 60 * 60_000 && timedOut.termination.limitMs % (60 * 60_000) === 0
      ? `${timedOut.termination.limitMs / (60 * 60_000)}-hour`
      : `${Math.max(1, Math.round(timedOut.termination.limitMs / 60_000))}-minute`
    : undefined;
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
    ...(timeoutLabel !== undefined
      ? { runTimeoutMessage: `Agent run reached the configured ${timeoutLabel} limit.` }
      : {}),
    updatedAt: projectActivityTime(file, taskId),
    backend: task.backend,
    model: task.model,
    continuationOf: task.continuationOf,
    ...(childOrchestration ? { childOrchestration } : {}),
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
    key: TranscriptSortKey;
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
    // FIFO follow-ups stay in the queue panel only until their turn starts. The
    // opening prompt is the exception: scheduler latency should not make the first
    // chat bubble flash in the queue panel before appearing in the transcript.
    if (message.role === 'user' && turnId) {
      const boundTurn = file.turns[turnId];
      if (boundTurn?.status === 'queued' && !isOpeningQueuedTurn(boundTurn, turns)) {
        continue;
      }
    }
    const seq = turnId !== undefined && seqOf.has(turnId) ? seqOf.get(turnId)! : UNBOUND_TURN_SEQUENCE;
    // Canonical contract (src/task/transcript-order.ts): user prompts rank ahead
    // of reasoning ahead of the assistant/tool stream within a turn. Explicit
    // message.order (if present) is respected for ordered segments.
    const kindRank = KIND_RANK[message.role];
    const ordering =
      message.role === 'assistant'
        ? (message.order ?? ASSISTANT_ORDERING_FALLBACK)
        : (message.order ?? USER_ORDERING_FALLBACK);
    entries.push({
      item: {
        id: message.id,
        kind: message.role,
        content: message.content,
        turnId,
        order: message.order,
        state: message.state,
      },
      key: { turnSequence: seq, kindRank, ordering, createdAt: message.createdAt, entityId: message.id },
    });
  }

  for (const tc of Object.values(file.toolCalls ?? {})) {
    if (tc.taskId !== taskId) {
      continue;
    }
    const seq = seqOf.has(tc.turnId) ? seqOf.get(tc.turnId)! : UNBOUND_TURN_SEQUENCE;
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
      key: { turnSequence: seq, kindRank: KIND_RANK.tool, ordering: tc.order, createdAt: tc.createdAt, entityId: tc.id },
    });
  }

  for (const r of Object.values(file.reasoning ?? {})) {
    if (r.taskId !== taskId) {
      continue;
    }
    const seq = seqOf.has(r.turnId) ? seqOf.get(r.turnId)! : UNBOUND_TURN_SEQUENCE;
    entries.push({
      item: { id: r.id, kind: 'reasoning', turnId: r.turnId, content: r.content },
      key: { turnSequence: seq, kindRank: KIND_RANK.reasoning, ordering: REASONING_ORDERING, createdAt: r.createdAt, entityId: r.id },
    });
  }

  entries.sort((a, b) => compareTranscriptKeys(a.key, b.key));
  return entries.map((entry) => entry.item);
}

function messageIdsForTurn(turn: TaskTurn): string[] {
  return turn.inputs
    .filter((input): input is { kind: 'message'; messageId: string } => input.kind === 'message')
    .map((input) => input.messageId);
}

/** Stable host labels for engine-queued turns without user message text (W5). */
export const QUEUED_PREVIEW_WAIT_CONTINUATION = 'Continuation after wait';
export const QUEUED_PREVIEW_RECOVERY = 'Recovery turn';

/**
 * Preview for a queued turn. Prefer user message text; if inputs are only
 * child_results / recovery (or empty), return a stable host label so the UI
 * never shows "(empty queued message)".
 */
export function previewTextForQueuedTurn(file: TaskStoreFile, turn: TaskTurn): string {
  const parts: string[] = [];
  for (const messageId of messageIdsForTurn(turn)) {
    const message = file.messages[messageId];
    if (!message || message.role !== 'user') continue;
    const text = message.content.trim();
    if (text) parts.push(text);
  }
  if (parts.length > 0) return parts.join('\n');

  const hasRecovery = turn.inputs.some((i) => i.kind === 'recovery');
  if (hasRecovery) return QUEUED_PREVIEW_RECOVERY;

  const hasChildResults = turn.inputs.some((i) => i.kind === 'child_results');
  if (hasChildResults) return QUEUED_PREVIEW_WAIT_CONTINUATION;

  // Engine-queued with no user text (edge): still non-empty for UX.
  if (turn.trigger === 'engine' || turn.trigger === 'retry') {
    return QUEUED_PREVIEW_WAIT_CONTINUATION;
  }
  return '';
}

export function projectQueuedTurns(file: TaskStoreFile, taskId: string): QueuedTurnProjection[] {
  const taskTurns = turnsForTask(file, taskId);
  return taskTurns
    .filter((turn) => turn.status === 'queued' && !isOpeningQueuedTurn(turn, taskTurns))
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
  store: TaskSnapshotReader,
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

  // Project the full owning-root tree so parent/sibling navigation remains
  // available while focused on a descendant (transcript stays focus-scoped).
  const owningRootId = findOwningRoot(file, focusedTaskId) ?? focusedTaskId;
  const subtreeIds = collectSubtreeIds(file, owningRootId);
  snapshot.subtree = subtreeIds
    .map((taskId) => projectTaskSummary(file, taskId))
    .filter((summary): summary is TaskSummary => summary !== undefined);
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

/** Walk parentId to the root coordinator; cycle-safe. */
export function findOwningRoot(file: TaskStoreFile, taskId: string): string | undefined {
  if (!file.tasks[taskId]) {
    return undefined;
  }
  const visited = new Set<string>();
  let current = taskId;
  while (true) {
    if (visited.has(current)) {
      return current;
    }
    visited.add(current);
    const task = file.tasks[current];
    if (!task || task.parentId === null) {
      return current;
    }
    if (!file.tasks[task.parentId]) {
      return current;
    }
    current = task.parentId;
  }
}

/** Ancestor chain from task toward root (excludes taskId; root last). */
export function collectAncestorIds(file: TaskStoreFile, taskId: string): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let current = file.tasks[taskId]?.parentId;
  while (current && !visited.has(current)) {
    visited.add(current);
    ancestors.push(current);
    current = file.tasks[current]?.parentId ?? null;
  }
  return ancestors;
}

/**
 * DFS preorder under rootTaskId. Siblings ordered by createdAt asc, then id.
 */
export function collectSubtreeIds(file: TaskStoreFile, rootTaskId: string): string[] {
  if (!file.tasks[rootTaskId]) {
    return [];
  }
  const ids: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    ids.push(id);
    const children = Object.values(file.tasks)
      .filter((task) => task.parentId === id)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    for (const child of children) {
      visit(child.id);
    }
  };
  visit(rootTaskId);
  return ids;
}

/** True when focused owning-root membership (set of ids) changed between files. */
export function owningRootMembershipChanged(
  before: TaskStoreFile,
  after: TaskStoreFile,
  focusedTaskId: string,
): boolean {
  const rootBefore = findOwningRoot(before, focusedTaskId);
  const rootAfter = findOwningRoot(after, focusedTaskId);
  if (!rootAfter) {
    return true;
  }
  if (rootBefore !== rootAfter) {
    return true;
  }
  const beforeIds = new Set(collectSubtreeIds(before, rootBefore ?? focusedTaskId));
  const afterIds = collectSubtreeIds(after, rootAfter);
  if (beforeIds.size !== afterIds.length) {
    return true;
  }
  for (const id of afterIds) {
    if (!beforeIds.has(id)) {
      return true;
    }
  }
  return false;
}
