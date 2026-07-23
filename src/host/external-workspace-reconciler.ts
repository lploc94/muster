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
  EngineProjection,
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
   * Optional projection snapshot from before a local commit. When another host
   * committed immediately before that local transaction, the write-through
   * projection may already carry the final revision while still missing the
   * peer aggregate. This preserves the real before-state for patch generation.
   */
  beforeProjection?: Readonly<EngineProjection>;
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
  // Host-local durable surfaces: revision advance only; not projected as UI patches.
  'send_outbox',
  'presentation',
]);

const FORCE_RECOVERY_CHANGE_KINDS = new Set([
  'clear_history',
  'retention',
  'delete_subtree',
  'delete_cascade',
]);

const MAX_RECONCILE_STABILITY_ATTEMPTS = 8;
const MAX_RECONCILE_REVISIONS = 1_024;
const MAX_RECONCILE_METADATA_ROWS = 16_384;

/**
 * Repair the write-through projection when a local commit observes more than
 * one new revision. That can only mean at least one peer commit serialized
 * immediately before it; advancing the local cursor without draining that
 * range would permanently skip the peer aggregates.
 */
export async function reconcileInterleavedLocalCommit(
  args: ExternalReconcileArgs & { previousRevision: number },
): Promise<ExternalReconcileResult | undefined> {
  if (args.projection.getFile().revision <= args.previousRevision + 1) {
    return undefined;
  }
  return reconcileExternalWorkspaceChanges(args);
}

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
    beforeProjection,
    feedPageLimit = 256,
  } = args;

  const before = beforeProjection ?? snapshotProjectionBefore(projection.getFile());
  let cursor = afterRevision;
  const collected: Array<{ revision: number; changes: WorkspaceChangeMetadata[] }> = [];
  let analyzedRevision = afterRevision;
  let metadataRows = 0;
  const affectedTaskIds = new Set<string>();
  const focusedMessageIds = new Set<string>();
  const focusedToolIds = new Set<string>();
  const focusedReasoningIds = new Set<string>();
  const focusedRemovedTranscriptIds = new Set<string>();
  let needsFullTaskRefresh = false;
  let stable = false;

  for (let attempt = 0; attempt < MAX_RECONCILE_STABILITY_ATTEMPTS; attempt += 1) {
    // Drain from the last exact revision. Every feed call is one read snapshot;
    // if a writer commits while hydration runs, the end fence below expands the
    // feed and retries instead of silently stamping a partial projection current.
    for (;;) {
      let feed: WorkspaceChangeFeedResult;
      try {
        feed = await repository.getWorkspaceChangesSince(cursor, feedPageLimit);
      } catch {
        return { kind: 'recovery', reason: 'corrupt' };
      }
      if (feed.kind === 'gap') {
        return {
          kind: 'gap',
          currentRevision: feed.currentRevision,
          retainedFromRevision: feed.retainedFromRevision,
        };
      }
      if (feed.currentRevision < cursor) {
        return { kind: 'recovery', reason: 'invariant' };
      }
      if (feed.revisions.length === 0) break;
      for (const entry of feed.revisions) {
        collected.push(entry);
        metadataRows += entry.changes.length;
      }
      if (
        collected.length > MAX_RECONCILE_REVISIONS ||
        metadataRows > MAX_RECONCILE_METADATA_ROWS
      ) {
        return { kind: 'recovery', reason: 'unrepresentable' };
      }
      cursor = feed.revisions[feed.revisions.length - 1]!.revision;
      if (!feed.hasMore || cursor >= feed.currentRevision) break;
    }

    const newEntries = collected.filter((entry) => entry.revision > analyzedRevision);
    for (const entry of newEntries) {
      for (const change of entry.changes) {
        if (FORCE_RECOVERY_CHANGE_KINDS.has(change.changeKind)) {
          return { kind: 'recovery', reason: 'unrepresentable' };
        }
        if (change.entityKind === 'task') {
          affectedTaskIds.add(change.entityId);
          if (change.changeKind === 'delete') needsFullTaskRefresh = true;
        } else if (change.taskId) {
          affectedTaskIds.add(change.taskId);
        }
        if (focusedTaskId && change.taskId === focusedTaskId) {
          if (change.entityKind === 'message') focusedMessageIds.add(change.entityId);
          if (change.entityKind === 'tool_call') focusedToolIds.add(change.entityId);
          if (change.entityKind === 'reasoning') focusedReasoningIds.add(change.entityId);
          if (
            change.entityKind === 'message' ||
            change.entityKind === 'tool_call' ||
            change.entityKind === 'reasoning'
          ) {
            if (change.changeKind === 'delete') {
              if (knownTranscriptIds.has(change.entityId)) {
                focusedRemovedTranscriptIds.add(change.entityId);
              }
            } else {
              // A later upsert in the same drained range wins over an earlier
              // delete; the final entity is hydrated and patched below.
              focusedRemovedTranscriptIds.delete(change.entityId);
            }
          }
        }
        if (
          !change.taskId &&
          change.entityKind !== 'task' &&
          !COORDINATION_ENTITY_KINDS.has(change.entityKind)
        ) {
          return { kind: 'recovery', reason: 'unrepresentable' };
        }
      }
      analyzedRevision = entry.revision;
    }

    try {
      if (needsFullTaskRefresh) {
        // Cascading task deletion is the one metadata path that needs the whole
        // bounded task/activity surface to discover descendants that disappeared.
        await projection.refreshAll();
      } else if (affectedTaskIds.size > 0) {
        await projection.refreshTasks([...affectedTaskIds].sort());
      }

      if (focusedTaskId && affectedTaskIds.has(focusedTaskId)) {
        // A queued follow-up becoming running changes only its turn row. The
        // active-input projection already contains its user message, so include
        // all bounded focused active inputs as visibility candidates.
        for (const message of Object.values(projection.getFile().messages)) {
          if (message.taskId === focusedTaskId) focusedMessageIds.add(message.id);
        }
      }

      if (focusedTaskId) {
        const [messages, tools, reasoning] = await Promise.all([
          repository.listMessagesByIds([...focusedMessageIds]),
          repository.listToolCallsByIds([...focusedToolIds]),
          repository.listReasoningByIds([...focusedReasoningIds]),
        ]);
        projection.mergeFocusedTranscriptEntities({
          taskId: focusedTaskId,
          messages,
          toolCalls: tools,
          reasoning,
        });
      }

      const endRevision = await repository.getWorkspaceRevision();
      if (endRevision < cursor) {
        return { kind: 'recovery', reason: 'invariant' };
      }
      if (endRevision > cursor) {
        continue;
      }
      projection.markWorkspaceRevision(cursor);
      stable = true;
      break;
    } catch {
      return { kind: 'recovery', reason: 'corrupt' };
    }
  }

  if (!stable) {
    // Do not leave a subset projection stamped at a later revision after a hot
    // writer exhausted the fence retries. Best-effort bounded full metadata
    // refresh; the caller still sends an authoritative bounded snapshot.
    try {
      await projection.refreshAll();
    } catch {
      // Recovery path reports only the stable reason, never row/content errors.
    }
    return { kind: 'recovery', reason: 'invariant' };
  }

  if (collected.length === 0) {
    return { kind: 'batches', batches: [], appliedRevision: cursor };
  }

  const finalRevision = collected[collected.length - 1]!.revision;
  const after = projection.getFile();
  if (after.revision !== finalRevision) {
    return { kind: 'recovery', reason: 'invariant' };
  }

  const patches = projectExternalWorkspacePatches({
    before,
    after,
    affectedTaskIds,
    focusedTaskId,
    knownTranscriptIds,
    focusedMessageIds: [...focusedMessageIds],
    focusedToolIds: [...focusedToolIds],
    focusedReasoningIds: [...focusedReasoningIds],
    focusedRemovedTranscriptIds: [...focusedRemovedTranscriptIds],
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
    appliedRevision: finalRevision,
  };
}

export function projectExternalWorkspacePatches(args: {
  before: Readonly<EngineProjection>;
  after: Readonly<EngineProjection>;
  affectedTaskIds: ReadonlySet<string>;
  focusedTaskId?: string;
  knownTranscriptIds: ReadonlySet<string>;
  focusedMessageIds: readonly string[];
  focusedToolIds: readonly string[];
  focusedReasoningIds: readonly string[];
  focusedRemovedTranscriptIds: readonly string[];
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
    focusedRemovedTranscriptIds,
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

  if (
    focusedTaskId &&
    after.tasks[focusedTaskId] &&
    focusedRemovedTranscriptIds.length > 0
  ) {
    patches.push({
      type: 'transcriptItemsRemoved',
      taskId: focusedTaskId,
      itemIds: [...new Set(focusedRemovedTranscriptIds)].sort(),
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
      const turnId = resolveMessageTurnId(after, message);
      // Queue-only follow-ups stay out of the chat transcript until promote.
      if (message.role === 'user' && isQueuedOnlyFollowUp(after, message, turnId)) continue;
      pushItem(messageToItem(message, turnId));
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

/**
 * User messages normally bind through turn_inputs and intentionally carry no
 * message.turnId. Resolve the same last-turn-wins mapping as buildTranscript;
 * otherwise an external enqueue would flash a queued follow-up into chat.
 */
function resolveMessageTurnId(file: EngineProjection, message: TaskMessage): string | undefined {
  if (message.turnId) return message.turnId;
  if (message.role !== 'user') return undefined;
  let resolved: string | undefined;
  const turns = Object.values(file.turns)
    .filter((turn) => turn.taskId === message.taskId)
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  for (const turn of turns) {
    if (turn.inputs.some((input) => input.kind === 'message' && input.messageId === message.id)) {
      resolved = turn.id;
    }
  }
  return resolved;
}

function isQueuedOnlyFollowUp(
  file: EngineProjection,
  message: TaskMessage,
  turnId: string | undefined,
): boolean {
  if (!turnId) return false;
  const turn = file.turns[turnId];
  if (!turn || turn.status !== 'queued' || turn.trigger !== 'user') return false;
  const taskTurns = Object.values(file.turns).filter((t) => t.taskId === message.taskId);
  // Opening prompt (sole user-triggered turn) still appears in chat.
  return !(
    taskTurns.length === 1 &&
    turn.inputs.some((input) => input.kind === 'message' && input.messageId === message.id)
  );
}

function messageToItem(
  message: TaskMessage,
  resolvedTurnId = message.turnId,
): TranscriptItem | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  return {
    id: message.id,
    kind: message.role,
    content: message.content,
    ...(resolvedTurnId !== undefined ? { turnId: resolvedTurnId } : {}),
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
    order: segment.order,
    content: segment.content,
  };
}
