import type { PendingAskOverlay, TaskSnapshot } from './snapshot';
import { buildSnapshot } from './snapshot';
import type { TaskRepository } from '../task/repository';
import type { TaskStoreFile } from '../task/types';

/**
 * The compatibility projector expected a TaskStoreFile, but opening the chat
 * must not read the migration envelope (which contains every transcript row in
 * the workspace). This projection contains task metadata and turn metadata for
 * list/tree summaries, plus transcript rows for the focused task only.
 */
export interface RepositorySnapshotProjection {
  snapshot: TaskSnapshot;
  /** Bounded observation used by the existing JSON change/reprojection bridge. */
  observation: TaskStoreFile;
}

function rootIdForTask(
  tasks: ReadonlyMap<string, { id: string; parentId: string | null }>,
  taskId: string,
): string | undefined {
  let current = tasks.get(taskId);
  if (!current) return undefined;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = tasks.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

async function activityTurns(
  repository: TaskRepository,
  taskIds: readonly string[],
): Promise<readonly import('../task/types').TaskTurn[]> {
  if (repository.listTurnActivityForTasks) {
    return repository.listTurnActivityForTasks(taskIds);
  }
  if (repository.listTurnsForTasks) {
    // Compatibility fallback for third-party adapters predating the bounded
    // activity query. SQLite/JSON shipped adapters implement the bounded path.
    return repository.listTurnsForTasks(taskIds);
  }
  const groups = await Promise.all(taskIds.map((taskId) => repository.listTurns(taskId)));
  return groups.flat();
}

/** Build a chat snapshot from named repository queries, never from the migration envelope. */
export async function buildRepositorySnapshot(
  repository: TaskRepository,
  workspaceId: string,
  focusedTaskId: string | undefined,
  activePendingAsks: ReadonlyMap<string, PendingAskOverlay>,
): Promise<RepositorySnapshotProjection> {
  const tasks = await repository.listTasks(workspaceId);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const summaryTurns = await activityTurns(repository, tasks.map((task) => task.id));

  const focusedTask = focusedTaskId ? taskMap.get(focusedTaskId) : undefined;
  const owningRootId = focusedTask
    ? rootIdForTask(taskMap, focusedTask.id) ?? focusedTask.id
    : undefined;
  const focusedTaskIds = focusedTask
    ? (await repository.listSubtree(owningRootId!)).map((task) => task.id)
    : [];
  // A focused transcript needs its complete turn/input map; tree summaries only
  // need the bounded activity projection above. This is the key distinction that
  // prevents opening a workspace from materializing every historical turn.
  const focusedTurns = focusedTask ? await repository.listTurns(focusedTask.id) : [];
  const turnsById = new Map(summaryTurns.map((turn) => [turn.id, turn]));
  for (const turn of focusedTurns) turnsById.set(turn.id, turn);
  const turns = [...turnsById.values()];
  const focusedMessages = focusedTask
    ? await repository.listMessages(focusedTask.id)
    : [];
  const focusedTools = focusedTask
    ? await repository.listToolCalls(focusedTask.id)
    : [];
  const focusedReasoning = focusedTask
    ? await repository.listReasoning(focusedTask.id)
    : [];
  const revision = repository.getWorkspaceRevision
    ? await repository.getWorkspaceRevision()
    : 0;

  const observation: TaskStoreFile = {
    schemaVersion: 6,
    revision,
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
    turns: Object.fromEntries(turns.map((turn) => [turn.id, turn])),
    // Transcript payload is deliberately focused-task scoped. The remaining
    // maps exist only for the legacy projector's shape and stay empty.
    messages: Object.fromEntries(focusedMessages.map((message) => [message.id, message])),
    operations: {},
    cancelRequests: {},
    toolCalls: Object.fromEntries(focusedTools.map((tool) => [tool.id, tool])),
    reasoning: Object.fromEntries(focusedReasoning.map((reasoning) => [reasoning.id, reasoning])),
    sendReceipts: {},
  };

  // Keep the owning-root query explicit in the projection contract. The
  // projector derives it from parentId; this assertion catches adapters that
  // accidentally return a task outside the requested subtree.
  if (focusedTask && focusedTaskIds.length > 0 && !focusedTaskIds.includes(focusedTask.id)) {
    throw new Error('repository subtree projection does not contain focused task');
  }

  return {
    snapshot: buildSnapshot({ getFile: () => observation }, focusedTaskId, activePendingAsks),
    observation,
  };
}
