import type { RepositoryCommand, RepositoryCommandResult } from '../task/repository';
import type { TaskMessage, EngineProjection, PersistedToolCall, PersistedReasoning } from '../task/types';
import {
  collectAncestorIds,
  projectQueuedTurns,
  projectTaskSummary,
  type QueuedTurnProjection,
  type TaskSummary,
  type TranscriptItem,
} from './snapshot';

/** Host-side wire patch kinds (mirrors webview protocol v9). */
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

export type WorkspacePatchBatch = {
  type: 'workspacePatchBatch';
  revision: number;
  patches: WorkspacePatch[];
};

export interface ProjectWorkspacePatchesArgs {
  command: RepositoryCommand;
  result: RepositoryCommandResult;
  before: EngineProjection;
  after: EngineProjection;
  focusedTaskId?: string;
  knownTranscriptIds: ReadonlySet<string>;
}

function messageToTranscriptItem(message: TaskMessage): TranscriptItem | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  return {
    id: message.id,
    kind: message.role,
    content: message.content,
    ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
    ...(message.order !== undefined ? { order: message.order } : {}),
    ...(message.state !== undefined ? { state: message.state } : {}),
  };
}

function toolToTranscriptItem(tool: PersistedToolCall): TranscriptItem {
  return {
    id: tool.id,
    kind: 'tool',
    turnId: tool.turnId,
    order: tool.order,
    content: {
      toolCallId: tool.toolCallId,
      name: tool.name,
      ...(tool.kind ? { toolKind: tool.kind } : {}),
      status: tool.status,
      ...(tool.input !== undefined ? { input: tool.input } : {}),
      ...(tool.output !== undefined ? { output: tool.output } : {}),
      ...(tool.error !== undefined ? { error: tool.error } : {}),
    },
  };
}

function reasoningToTranscriptItem(segment: PersistedReasoning): TranscriptItem {
  return {
    id: segment.id,
    kind: 'reasoning',
    turnId: segment.turnId,
    content: segment.content,
  };
}

function collectAffectedTaskIds(
  command: RepositoryCommand,
  before: EngineProjection,
  after: EngineProjection,
): Set<string> {
  const ids = new Set<string>();
  if ('taskId' in command && typeof command.taskId === 'string') ids.add(command.taskId);
  if ('task' in command && command.task && typeof command.task === 'object' && 'id' in command.task) {
    ids.add((command.task as { id: string }).id);
  }
  if ('tasks' in command && Array.isArray(command.tasks)) {
    for (const task of command.tasks) ids.add(task.id);
  }
  if ('turn' in command && command.turn && typeof command.turn === 'object' && 'taskId' in command.turn) {
    ids.add((command.turn as { taskId: string }).taskId);
  }
  if ('turns' in command && Array.isArray(command.turns)) {
    for (const turn of command.turns) ids.add(turn.taskId);
  }
  if ('message' in command && command.message && typeof command.message === 'object' && 'taskId' in command.message) {
    ids.add((command.message as { taskId: string }).taskId);
  }
  if ('messages' in command && Array.isArray(command.messages)) {
    for (const message of command.messages) ids.add(message.taskId);
  }
  if ('mutations' in command && Array.isArray(command.mutations)) {
    for (const mutation of command.mutations) ids.add(mutation.taskId);
  }
  if ('rootTaskId' in command && typeof command.rootTaskId === 'string') ids.add(command.rootTaskId);
  if ('deletedTaskIds' in command && Array.isArray(command.deletedTaskIds)) {
    for (const id of command.deletedTaskIds) ids.add(id);
  }
  // Graph commands use deleteTaskIds (not deletedTaskIds).
  if ('deleteTaskIds' in command && Array.isArray(command.deleteTaskIds)) {
    for (const id of command.deleteTaskIds) ids.add(id);
  }
  if ('turnId' in command && typeof command.turnId === 'string') {
    const taskId = after.turns[command.turnId]?.taskId ?? before.turns[command.turnId]?.taskId;
    if (taskId) ids.add(taskId);
  }
  if ('messageId' in command && typeof command.messageId === 'string') {
    const taskId =
      after.messages[command.messageId]?.taskId ?? before.messages[command.messageId]?.taskId;
    if (taskId) ids.add(taskId);
  }
  if ('deleteTurnIds' in command && Array.isArray(command.deleteTurnIds)) {
    for (const turnId of command.deleteTurnIds) {
      const taskId = after.turns[turnId]?.taskId ?? before.turns[turnId]?.taskId;
      if (taskId) ids.add(taskId);
    }
  }
  if ('deleteMessageIds' in command && Array.isArray(command.deleteMessageIds)) {
    for (const messageId of command.deleteMessageIds) {
      const taskId =
        after.messages[messageId]?.taskId ?? before.messages[messageId]?.taskId;
      if (taskId) ids.add(taskId);
    }
  }

  // Detect removals between before/after for clearHistory / delete subtree / graph.
  if (
    command.kind === 'clearHistory' ||
    command.kind === 'deleteTask' ||
    command.kind === 'deleteTaskSubtreeIfIdle' ||
    ('deleteTaskIds' in command && Array.isArray(command.deleteTaskIds) && command.deleteTaskIds.length > 0)
  ) {
    for (const id of Object.keys(before.tasks)) {
      if (!after.tasks[id]) ids.add(id);
    }
  }

  // Expand ancestors so childOrchestration stays fresh.
  const expanded = new Set(ids);
  for (const id of ids) {
    for (const ancestor of collectAncestorIds(after, id)) expanded.add(ancestor);
    for (const ancestor of collectAncestorIds(before, id)) expanded.add(ancestor);
  }
  return expanded;
}

function isMetadataMembershipCommand(kind: RepositoryCommand['kind']): boolean {
  return (
    kind === 'createTask' ||
    kind === 'createRootAndInitialTurn' ||
    kind === 'renameTask' ||
    kind === 'upsertTask' ||
    kind === 'applyTaskLifecycle' ||
    kind === 'cascadeTaskLifecycle' ||
    kind === 'requestRuntimeHandoff' ||
    kind === 'clearHistory' ||
    kind === 'deleteTask' ||
    kind === 'deleteTaskSubtreeIfIdle' ||
    kind === 'createChildTask' ||
    kind === 'delegateChildTask' ||
    kind === 'createChildTaskBatch' ||
    kind === 'delegateChildTaskBatch' ||
    kind === 'releaseChildTasks' ||
    kind === 'setChildTaskLifecycle' ||
    kind === 'completeGraphTask' ||
    kind === 'failGraphTask' ||
    kind === 'applyDependencyTerminal' ||
    kind === 'applyDependencyTerminals' ||
    kind === 'applyVerdictRemediation'
  );
}

/**
 * When a queued turn promotes to live, project its bound user messages into
 * chat from the post-commit projection (active-turn inputs only — no full list).
 */
function extractPromotedTurnTranscript(
  command: RepositoryCommand,
  after: EngineProjection,
  focusedTaskId: string | undefined,
): { taskId: string; items: TranscriptItem[] } | null {
  if (!focusedTaskId) return null;
  if (command.kind !== 'prepareDispatch' && command.kind !== 'replaceLiveTurn') return null;
  const turn = command.kind === 'prepareDispatch' ? command.turn : command.turn;
  if (turn.taskId !== focusedTaskId) return null;
  if (turn.status !== 'running' && turn.status !== 'waiting_user') return null;
  const items: TranscriptItem[] = [];
  for (const input of turn.inputs) {
    if (input.kind !== 'message') continue;
    const message = after.messages[input.messageId];
    if (!message) continue;
    const item = messageToTranscriptItem(message);
    if (item) items.push({ ...item, turnId: turn.id });
  }
  return items.length > 0 ? { taskId: focusedTaskId, items } : null;
}

function extractCommandTranscriptItems(command: RepositoryCommand): {
  taskId: string;
  items: TranscriptItem[];
} | null {
  switch (command.kind) {
    case 'appendTranscriptBatch': {
      const items: TranscriptItem[] = [];
      for (const message of command.messages ?? []) {
        const item = messageToTranscriptItem(message);
        if (item) items.push(item);
      }
      for (const tool of command.toolCalls ?? []) items.push(toolToTranscriptItem(tool));
      for (const segment of command.reasoning ?? []) items.push(reasoningToTranscriptItem(segment));
      return items.length > 0 ? { taskId: command.taskId, items } : null;
    }
    case 'createRootAndInitialTurn': {
      const item = messageToTranscriptItem(command.message);
      return item ? { taskId: command.task.id, items: [item] } : null;
    }
    case 'enqueueMessageTurn': {
      const item = messageToTranscriptItem(command.message);
      return item ? { taskId: command.task.id, items: [item] } : null;
    }
    case 'upsertMessage':
    case 'appendMessage': {
      const item = messageToTranscriptItem(command.message);
      return item ? { taskId: command.message.taskId, items: [item] } : null;
    }
    case 'editQueuedMessage':
      // Queue-only; no transcript mutation.
      return null;
    case 'drainPendingSends': {
      const items: TranscriptItem[] = [];
      for (const message of command.messages ?? []) {
        const item = messageToTranscriptItem(message);
        if (item) items.push(item);
      }
      return items.length > 0 ? { taskId: command.task.id, items } : null;
    }
    case 'prepareDispatch': {
      const items: TranscriptItem[] = [];
      for (const message of command.messages) {
        const item = messageToTranscriptItem(message);
        if (item) items.push(item);
      }
      return items.length > 0 ? { taskId: command.task.id, items } : null;
    }
    case 'settleTurnAndApplyEffects': {
      const items: TranscriptItem[] = [];
      for (const message of command.messages) {
        const item = messageToTranscriptItem(message);
        if (item) items.push(item);
      }
      return items.length > 0 ? { taskId: command.task.id, items } : null;
    }
    default:
      return null;
  }
}

/**
 * Whether a user message from this command should enter chat immediately.
 * Opening prompt: yes. FIFO queued follow-up: no (queue panel only until promote).
 */
function shouldPublishUserTranscript(
  command: RepositoryCommand,
  after: EngineProjection,
): boolean {
  if (command.kind === 'createRootAndInitialTurn') return true;
  if (command.kind === 'enqueueMessageTurn') {
    const turn = after.turns[command.turn.id] ?? command.turn;
    if (turn.status !== 'queued') return true;
    const taskTurns = Object.values(after.turns).filter((t) => t.taskId === command.task.id);
    // Opening queued turn: sole turn, user trigger, has message input.
    return (
      taskTurns.length === 1 &&
      turn.trigger === 'user' &&
      turn.inputs.some((input) => input.kind === 'message')
    );
  }
  return true;
}

/**
 * Extract transcript entities explicitly removed by one named command. The
 * current focused ownership set keeps this bounded to rows the webview can
 * actually hold, including older pages loaded after the latest snapshot.
 *
 * Cascading turn deletion and retention are intentionally not guessed here:
 * their command payloads do not enumerate every cascaded/truncated entity and
 * the caller must use bounded snapshot recovery for those operations.
 */
function extractRemovedTranscriptIds(
  command: RepositoryCommand,
  result: RepositoryCommandResult,
  knownTranscriptIds: ReadonlySet<string>,
): string[] {
  const candidates = new Set<string>();
  if (command.kind === 'deleteMessage') candidates.add(command.messageId);
  for (const messageId of result.deletedMessageIds ?? []) candidates.add(messageId);
  if ('deleteMessageIds' in command && Array.isArray(command.deleteMessageIds)) {
    for (const messageId of command.deleteMessageIds) candidates.add(messageId);
  }
  return [...candidates].filter((id) => knownTranscriptIds.has(id)).sort();
}

/**
 * Local destructive commands whose full transcript effect is not represented
 * by stable IDs in the command/result must still use an authoritative bounded
 * snapshot. Explicit message deletion uses transcriptItemsRemoved instead.
 */
export function localCommitNeedsTranscriptRecovery(args: {
  command: RepositoryCommand;
  result: RepositoryCommandResult;
  focusedTaskId?: string;
  knownTranscriptIds: ReadonlySet<string>;
}): boolean {
  const { command, result, focusedTaskId, knownTranscriptIds } = args;
  if (!result.changed || !focusedTaskId || knownTranscriptIds.size === 0) return false;
  if (
    (command.kind === 'applyRetention' || command.kind === 'applyRetentionPolicy') &&
    command.taskId === focusedTaskId
  ) {
    return true;
  }
  if (command.kind === 'deleteTurn') return true;
  return (
    'deleteTurnIds' in command &&
    Array.isArray(command.deleteTurnIds) &&
    command.deleteTurnIds.length > 0
  );
}

/**
 * Project one successful durable commit into a deterministic workspace patch list.
 * Does not query the repository. Transcript patches are derived from the command
 * payload and known-id set only (no full transcript hydration).
 */
export function projectWorkspacePatches(args: ProjectWorkspacePatchesArgs): WorkspacePatch[] {
  const { command, before, after, focusedTaskId, knownTranscriptIds } = args;
  if (!args.result.changed) return [];

  // Pure coordination heartbeats still bump revision; emit empty batch at caller.
  if (
    command.kind === 'claimRuntime' ||
    command.kind === 'heartbeatRuntime' ||
    command.kind === 'releaseRuntime' ||
    command.kind === 'putSendReceipt' ||
    command.kind === 'deleteSendReceipt' ||
    command.kind === 'putOperation' ||
    command.kind === 'claimOperation' ||
    command.kind === 'deleteOperationsForTurn'
  ) {
    return [];
  }

  const affected = collectAffectedTaskIds(command, before, after);
  const removals: WorkspacePatch[] = [];
  const upserts: WorkspacePatch[] = [];
  const activities: WorkspacePatch[] = [];
  const queues: WorkspacePatch[] = [];
  const transcriptAppends: TranscriptItem[] = [];
  const transcriptPatches: TranscriptItem[] = [];
  const transcriptRemovals =
    focusedTaskId && after.tasks[focusedTaskId]
      ? extractRemovedTranscriptIds(command, args.result, knownTranscriptIds)
      : [];
  let transcriptTaskId: string | undefined;

  const metadata = isMetadataMembershipCommand(command.kind);

  for (const taskId of [...affected].sort()) {
    const existed = Boolean(before.tasks[taskId]);
    const exists = Boolean(after.tasks[taskId]);
    if (existed && !exists) {
      removals.push({ type: 'taskRemoved', taskId });
      continue;
    }
    if (!exists) continue;
    const summary = projectTaskSummary(after, taskId);
    if (!summary) continue;
    if (metadata || !existed) {
      upserts.push({ type: 'taskUpserted', task: summary });
    } else {
      activities.push({ type: 'turnActivityChanged', task: summary });
    }
  }

  // Queue projection for focused task when it was affected.
  if (focusedTaskId && affected.has(focusedTaskId) && after.tasks[focusedTaskId]) {
    queues.push({
      type: 'queuedTurnsChanged',
      taskId: focusedTaskId,
      queuedTurns: projectQueuedTurns(after, focusedTaskId),
    });
  }

  const extracted = extractCommandTranscriptItems(command);
  const promoted = extractPromotedTurnTranscript(command, after, focusedTaskId);
  const combined =
    extracted && promoted && extracted.taskId === promoted.taskId
      ? {
          taskId: extracted.taskId,
          items: [...extracted.items, ...promoted.items],
        }
      : extracted ?? promoted;

  if (
    combined &&
    focusedTaskId &&
    combined.taskId === focusedTaskId &&
    shouldPublishUserTranscript(command, after)
  ) {
    transcriptTaskId = combined.taskId;
    const seen = new Set<string>();
    for (const item of combined.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (knownTranscriptIds.has(item.id)) {
        transcriptPatches.push(item);
      } else {
        transcriptAppends.push(item);
      }
    }
  }

  const patches: WorkspacePatch[] = [];
  patches.push(...removals);
  patches.push(...upserts);
  patches.push(...activities);
  patches.push(...queues);
  if (focusedTaskId && transcriptRemovals.length > 0) {
    patches.push({
      type: 'transcriptItemsRemoved',
      taskId: focusedTaskId,
      itemIds: transcriptRemovals,
    });
  }
  if (transcriptTaskId && transcriptAppends.length > 0) {
    patches.push({
      type: 'transcriptItemsAppended',
      taskId: transcriptTaskId,
      items: transcriptAppends,
    });
  }
  if (transcriptTaskId) {
    for (const item of transcriptPatches) {
      patches.push({
        type: 'transcriptItemPatched',
        taskId: transcriptTaskId,
        item,
      });
    }
  }
  return patches;
}

export function buildWorkspacePatchBatch(
  revision: number,
  patches: WorkspacePatch[],
): WorkspacePatchBatch {
  return {
    type: 'workspacePatchBatch',
    revision,
    patches,
  };
}
