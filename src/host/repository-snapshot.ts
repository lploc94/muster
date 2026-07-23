import type { PendingAskOverlay, TaskSnapshot, TranscriptItem, TranscriptPageState } from './snapshot';
import { buildSnapshot } from './snapshot';
import type { RepositoryTranscriptItem, TaskRepository } from '../task/repository';
import type { EngineProjection } from '../task/types';

/** Bounded page size for the focused-task bootstrap transcript (W4). */
export const BOOTSTRAP_TRANSCRIPT_LIMIT = 100;

/**
 * Opening chat must not read every transcript row in the workspace. This
 * projection contains task metadata and bounded turn metadata for list/tree
 * summaries, plus a bounded transcript PAGE (latest 100 items) for the focused
 * task. It never materializes full turn/message/tool/reasoning history.
 */
export interface RepositorySnapshotProjection {
  snapshot: TaskSnapshot;
  /** Bounded observation used by the current snapshot projector. */
  observation: EngineProjection;
}

/** Map a repository transcript row to the host wire transcript item. */
export function toHostTranscriptItem(item: RepositoryTranscriptItem): TranscriptItem {
  if (item.kind === 'tool') {
    const content = item.content as Record<string, unknown>;
    return {
      id: item.id,
      kind: 'tool',
      turnId: item.turnId,
      order: item.order,
      content: {
        toolCallId: String(content.toolCallId ?? ''),
        name: String(content.name ?? ''),
        ...(typeof content.toolKind === 'string'
          ? { toolKind: content.toolKind as 'mcp' | 'builtin' | 'other' }
          : {}),
        status: (content.status as 'running' | 'success' | 'error') ?? 'running',
        ...(content.input !== undefined ? { input: content.input } : {}),
        ...(content.output !== undefined ? { output: content.output } : {}),
        ...(typeof content.error === 'string' ? { error: content.error } : {}),
      },
    };
  }
  if (item.kind === 'reasoning') {
    return { id: item.id, kind: 'reasoning', turnId: item.turnId, order: item.order, content: item.content };
  }
  return {
    id: item.id,
    kind: item.kind,
    content: item.content,
    ...(item.turnId !== undefined ? { turnId: item.turnId } : {}),
    ...(item.order !== undefined ? { order: item.order } : {}),
    ...(item.state !== undefined ? { state: item.state } : {}),
  };
}

/**
 * Build a chat snapshot from bounded repository queries. The focused transcript
 * is a single keyset page (latest 100 items) from getTranscriptPage; tree/root
 * summaries come from listTurnActivityForTasks; queued previews come from the
 * focused task's active-turn input messages. Full transcript APIs are never called.
 *
 * Stale/deleted focus is normalized to a valid no-focus snapshot (protocol v6).
 */
export async function buildRepositorySnapshot(
  repository: TaskRepository,
  workspaceId: string,
  focusedTaskId: string | undefined,
  activePendingAsks: ReadonlyMap<string, PendingAskOverlay>,
): Promise<RepositorySnapshotProjection> {
  const readStableSnapshot = async (): Promise<RepositorySnapshotProjection> => {
    // Separate repository queries are not an implicit SQLite read transaction.
    // Verify the revision at both ends so an external writer cannot produce a
    // snapshot stamped N with task metadata from N-1. Local writes are also
    // excluded by runConsistentRead when the projection wrapper is present.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const startRevision = await repository.getWorkspaceRevision();
      const projection = await buildRepositorySnapshotAttempt(
        repository,
        workspaceId,
        focusedTaskId,
        activePendingAsks,
      );
      const endRevision = await repository.getWorkspaceRevision();
      if (
        startRevision === endRevision &&
        projection.snapshot.storeRevision === endRevision
      ) {
        return projection;
      }
    }
    throw new Error('workspace changed while building bounded snapshot');
  };

  return repository.runConsistentRead
    ? repository.runConsistentRead(readStableSnapshot)
    : readStableSnapshot();
}

async function buildRepositorySnapshotAttempt(
  repository: TaskRepository,
  workspaceId: string,
  focusedTaskId: string | undefined,
  activePendingAsks: ReadonlyMap<string, PendingAskOverlay>,
): Promise<RepositorySnapshotProjection> {
  const tasks = await repository.listTasks(workspaceId);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const taskIds = tasks.map((task) => task.id);

  // Effective focus: only when the task still exists. Missing/deleted/stale ids
  // produce a valid no-focus v6 snapshot (no focusedTaskId/transcript/page).
  const effectiveFocusId =
    focusedTaskId && taskMap.has(focusedTaskId) ? focusedTaskId : undefined;
  const focusedTask = effectiveFocusId ? taskMap.get(effectiveFocusId) : undefined;

  // Bounded turn activity for tree/current summaries (all tasks). Active input
  // messages only for the focused task — no-focus needs no queue previews.
  const [summaryTurns, activeInputMessages] = await Promise.all([
    taskIds.length > 0
      ? repository.listTurnActivityForTasks(taskIds)
      : Promise.resolve([]),
    focusedTask
      ? repository.listActiveTurnInputMessages([focusedTask.id])
      : Promise.resolve([]),
  ]);

  // Focused transcript is a single bounded keyset page. Revision travels with
  // the page result so we do not query revision separately when focused.
  const page = focusedTask
    ? await repository.getTranscriptPage(focusedTask.id, undefined, BOOTSTRAP_TRANSCRIPT_LIMIT)
    : undefined;
  const revision = page ? page.workspaceRevision : await repository.getWorkspaceRevision();

  const observation: EngineProjection = {
    schemaVersion: 6,
    revision,
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
    turns: Object.fromEntries(summaryTurns.map((turn) => [turn.id, turn])),
    // Only the focused task's active-turn inputs — powers queue previews.
    messages: Object.fromEntries(activeInputMessages.map((message) => [message.id, message])),
    operations: {},
    cancelRequests: {},
    toolCalls: {},
    reasoning: {},
    sendReceipts: {},
  };

  const transcript = page ? page.items.map(toHostTranscriptItem) : undefined;
  const transcriptPage: TranscriptPageState | undefined = page
    ? {
        hasMoreBefore: page.hasMoreBefore,
        workspaceRevision: page.workspaceRevision,
        ...(page.hasMoreBefore && page.beforeCursor !== undefined
          ? { beforeCursor: page.beforeCursor }
          : {}),
      }
    : undefined;

  // Focused ⇒ both transcript + transcriptPage required; no-focus ⇒ neither.
  return {
    snapshot: buildSnapshot(
      { getFile: () => observation },
      effectiveFocusId,
      activePendingAsks,
      focusedTask && transcript !== undefined && transcriptPage !== undefined
        ? { transcript, transcriptPage }
        : undefined,
    ),
    observation,
  };
}
