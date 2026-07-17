import type {
  TaskRepository,
  WorkspaceChangeFeedResult,
  WorkspaceChangeMetadata,
} from '../task/repository';
import type { RepositoryProjection } from '../task/repository-projection';
import { snapshotProjectionBefore } from '../task/repository-projection';
import type {
  PersistedReasoning,
  PersistedToolCall,
  TaskMessage,
  TaskStoreFile,
} from '../task/types';
import {
  projectQueuedTurns,
  projectTaskSummary,
  type TranscriptItem,
} from './snapshot';
import {
  buildWorkspacePatchBatch,
  type WorkspacePatch,
  type WorkspacePatchBatch,
} from './workspace-patch';

export type ExternalReconcileResult =
  | { kind: 'batches'; batches: WorkspacePatchBatch[]; appliedRevision: number }
  | { kind: 'gap'; currentRevision: number; retainedFromRevision: number }
  | { kind: 'recovery'; reason: 'corrupt' | 'invariant' | 'unrepresentable' };

export type ExternalReconcileArgs = {
  repository: TaskRepository;
  projection: RepositoryProjection;
  afterRevision: number;
  /** Optional focus for bounded transcript hydration. */
  focusedTaskId?: string;
  knownTranscriptIds: ReadonlySet<string>;
  /**
   * Page size for feed reads. Revisions are never split across pages.
   */
  feedPageLimit?: number;
};

const COORDINATION_ENTITY_KINDS = new Set([
  'operation',
  'cancel_request',
  'send_receipt',
  'runtime_claim',
  'workspace',
  'workspace_location',
]);

const FORCE_RECOVERY_CHANGE_KINDS = new Set([
  'clear_history',
  'retention',
  'delete_subtree',
]);

/**
 * Consume the bounded change feed and produce contiguous workspacePatchBatch
 * envelopes without full transcript hydration.
 *
 * Multi-revision groups: intermediate revisions get empty batches (revision
 * advance only); the final revision carries the reconciled current state.
 */
export async function reconcileExternalWorkspaceChanges(
  args: ExternalReconcileArgs,
): Promise<ExternalReconcileResult> {
  const {
    repository,
    projection,
    afterRevision,
    focusedTaskId,
    knownTranscriptIds,
    feedPageLimit = 256,
  } = args;

  let cursor = afterRevision;
  const collected: Array<{ revision: number; changes: WorkspaceChangeMetadata[] }> = [];
  let lastCurrent = afterRevision;
  let lastRetained = 1;

  // Drain feed pages until up-to-date or gap. Page by revision, never by row offset.
  for (;;) {
    let feed: WorkspaceChangeFeedResult;
    try {
      feed = await repository.getWorkspaceChangesSince(cursor, feedPageLimit);
    } catch {
      return { kind: 'recovery', reason: 'corrupt' };
    }
    lastCurrent = feed.currentRevision;
    lastRetained = feed.retainedFromRevision;
    if (feed.kind === 'gap') {
      return {
        kind: 'gap',
        currentRevision: feed.currentRevision,
        retainedFromRevision: feed.retainedFromRevision,
      };
    }
    if (feed.revisions.length === 0) break;
    for (const entry of feed.revisions) collected.push(entry);
    cursor = feed.revisions[feed.revisions.length - 1]!.revision;
    if (!feed.hasMore || cursor >= feed.currentRevision) break;
  }

  if (collected.length === 0) {
    return {
      kind: 'batches',
      batches: [],
      appliedRevision: lastCurrent,
    };
  }

  const allChanges = collected.flatMap((entry) => entry.changes);
  for (const change of allChanges) {
    if (FORCE_RECOVERY_CHANGE_KINDS.has(change.changeKind)) {
      return { kind: 'recovery', reason: 'unrepresentable' };
    }
  }

  const finalRevision = collected[collected.length - 1]!.revision;
  const before = snapshotProjectionBefore(projection.getFile());

  const affectedTaskIds = new Set<string>();
  const focusedMessageIds: string[] = [];
  const focusedToolIds: string[] = [];
  const focusedReasoningIds: string[] = [];
  let needsFullTaskRefresh = false;

  for (const change of allChanges) {
    if (change.entityKind === 'task') {
      affectedTaskIds.add(change.entityId);
      if (change.changeKind === 'delete') needsFullTaskRefresh = true;
    } else if (change.taskId) {
      affectedTaskIds.add(change.taskId);
    }
    if (focusedTaskId && change.taskId === focusedTaskId) {
      if (change.entityKind === 'message') focusedMessageIds.push(change.entityId);
      if (change.entityKind === 'tool_call') focusedToolIds.push(change.entityId);
      if (change.entityKind === 'reasoning') focusedReasoningIds.push(change.entityId);
    }
    // Coordination-only rows without taskId still need a revision advance; empty
    // final batch is fine when no task surface changed.
    if (
      !change.taskId &&
      change.entityKind !== 'task' &&
      !COORDINATION_ENTITY_KINDS.has(change.entityKind)
    ) {
      return { kind: 'recovery', reason: 'unrepresentable' };
    }
  }

  try {
    if (needsFullTaskRefresh || affectedTaskIds.size === 0) {
      // Deletion or pure coordination: bounded full task metadata refresh is safe.
      // refreshAll never hydrates full transcripts.
      await projection.refreshAll();
    } else {
      await projection.refreshTasks([...affectedTaskIds].sort());
    }

    if (focusedTaskId) {
      const [messages, tools, reasoning] = await Promise.all([
        repository.listMessagesByIds(unique(focusedMessageIds)),
        repository.listToolCallsByIds(unique(focusedToolIds)),
        repository.listReasoningByIds(unique(focusedReasoningIds)),
      ]);
      projection.mergeFocusedTranscriptEntities({
        taskId: focusedTaskId,
        messages,
        toolCalls: tools,
        reasoning,
      });
    }

    // Stamp projection revision to the final feed revision (source of truth).
    const liveRevision = await repository.getWorkspaceRevision();
    if (liveRevision < finalRevision) {
      return { kind: 'recovery', reason: 'invariant' };
    }
    // refreshAll/refreshTasks already set revision from DB; ensure not behind final.
    if (projection.getFile().revision < finalRevision) {
      await projection.refreshAll();
    }
  } catch {
    return { kind: 'recovery', reason: 'corrupt' };
  }

  const after = projection.getFile();
  if (after.revision < finalRevision) {
    return { kind: 'recovery', reason: 'invariant' };
  }

  const patches = projectExternalWorkspacePatches({
    before,
    after,
    affectedTaskIds,
    focusedTaskId,
    knownTranscriptIds,
    focusedMessageIds: unique(focusedMessageIds),
    focusedToolIds: unique(focusedToolIds),
    focusedReasoningIds: unique(focusedReasoningIds),
  });

  const batches: WorkspacePatchBatch[] = [];
  // Intermediate revisions: empty batches keep the reducer contiguous without
  // inventing historical row versions we no longer have.
  for (let i = 0; i < collected.length - 1; i += 1) {
    batches.push(buildWorkspacePatchBatch(collected[i]!.revision, []));
  }
  batches.push(buildWorkspacePatchBatch(finalRevision, patches));

  return {
    kind: 'batches',
    batches,
    appliedRevision: Math.max(finalRevision, after.revision, lastCurrent),
  };
}

export function projectExternalWorkspacePatches(args: {
  before: TaskStoreFile;
  after: TaskStoreFile;
  affectedTaskIds: ReadonlySet<string>;
  focusedTaskId?: string;
  knownTranscriptIds: ReadonlySet<string>;
  focusedMessageIds: readonly string[];
  focusedToolIds: readonly string[];
  focusedReasoningIds: readonly string[];
}): WorkspacePatch[] {
  const {
    before,
    after,
    affectedTaskIds,
    focusedTaskId,
    knownTranscriptIds,
    focusedMessageIds,
    focusedToolIds,
    focusedReasoningIds,
  } = args;

  const patches: WorkspacePatch[] = [];
  const taskIds = new Set<string>([
    ...affectedTaskIds,
    ...Object.keys(before.tasks),
    ...Object.keys(after.tasks),
  ]);

  for (const taskId of [...taskIds].sort()) {
    if (!affectedTaskIds.has(taskId) && before.tasks[taskId] && after.tasks[taskId]) {
      continue;
    }
    const existed = Boolean(before.tasks[taskId]);
    const exists = Boolean(after.tasks[taskId]);
    if (existed && !exists) {
      patches.push({ type: 'taskRemoved', taskId });
      continue;
    }
    if (!exists) continue;
    const summary = projectTaskSummary(after, taskId);
    if (!summary) continue;
    if (!existed) {
      patches.push({ type: 'taskUpserted', task: summary });
    } else {
      patches.push({ type: 'turnActivityChanged', task: summary });
    }
  }

  if (focusedTaskId && after.tasks[focusedTaskId] && affectedTaskIds.has(focusedTaskId)) {
    patches.push({
      type: 'queuedTurnsChanged',
      taskId: focusedTaskId,
      queuedTurns: projectQueuedTurns(after, focusedTaskId),
    });
  }

  if (focusedTaskId) {
    const appends: TranscriptItem[] = [];
    const itemPatches: TranscriptItem[] = [];
    const pushItem = (item: TranscriptItem | null) => {
      if (!item) return;
      if (knownTranscriptIds.has(item.id)) itemPatches.push(item);
      else appends.push(item);
    };

    for (const id of focusedMessageIds) {
      const message = after.messages[id];
      if (!message || message.taskId !== focusedTaskId) continue;
      // Queue-only follow-ups stay out of the chat transcript until promote.
      if (message.role === 'user' && isQueuedOnlyFollowUp(after, message)) continue;
      pushItem(messageToItem(message));
    }
    for (const id of focusedToolIds) {
      const tool = after.toolCalls?.[id];
      if (!tool || tool.taskId !== focusedTaskId) continue;
      pushItem(toolToItem(tool));
    }
    for (const id of focusedReasoningIds) {
      const segment = after.reasoning?.[id];
      if (!segment || segment.taskId !== focusedTaskId) continue;
      pushItem(reasoningToItem(segment));
    }

    if (appends.length > 0) {
      patches.push({
        type: 'transcriptItemsAppended',
        taskId: focusedTaskId,
        items: appends,
      });
    }
    for (const item of itemPatches) {
      patches.push({
        type: 'transcriptItemPatched',
        taskId: focusedTaskId,
        item,
      });
    }
  }

  return patches;
}

function isQueuedOnlyFollowUp(file: TaskStoreFile, message: TaskMessage): boolean {
  if (!message.turnId) return false;
  const turn = file.turns[message.turnId];
  if (!turn || turn.status !== 'queued' || turn.trigger !== 'user') return false;
  const taskTurns = Object.values(file.turns).filter((t) => t.taskId === message.taskId);
  // Opening prompt (sole user-triggered turn) still appears in chat.
  return !(
    taskTurns.length === 1 &&
    turn.inputs.some((input) => input.kind === 'message' && input.messageId === message.id)
  );
}

function messageToItem(message: TaskMessage): TranscriptItem | null {
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

function toolToItem(tool: PersistedToolCall): TranscriptItem {
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

function reasoningToItem(segment: PersistedReasoning): TranscriptItem {
  return {
    id: segment.id,
    kind: 'reasoning',
    turnId: segment.turnId,
    content: segment.content,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
