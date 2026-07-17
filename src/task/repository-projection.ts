import { deriveViewStatus } from './derived-status';
import type {
  RepositoryCommand,
  RepositoryCommandResult,
  TaskRepository,
} from './repository';
import { isGraphCommand } from './repository';
import type {
  MusterTask,
  TaskStoreFile,
  TaskTurn,
  TaskViewStatus,
} from './types';

/**
 * Read-only in-memory projection used by engine selectors while the writable
 * source is the async SQLite repository. It never writes JSON and it
 * is refreshed only for aggregates touched by a successful named command.
 */
export class RepositoryProjection {
  private constructor(
    private readonly source: TaskRepository,
    private readonly workspaceId: string,
    private readonly file: TaskStoreFile,
  ) {}

  static async load(source: TaskRepository, workspaceId: string): Promise<RepositoryProjection> {
    const projection = new RepositoryProjection(source, workspaceId, {
      schemaVersion: 6,
      revision: await source.getWorkspaceRevision(),
      tasks: {}, turns: {}, messages: {}, toolCalls: {}, reasoning: {},
      operations: {}, cancelRequests: {}, sendReceipts: {}, runtimeClaims: {},
    });
    await projection.refreshAll();
    return projection;
  }

  getFile(): Readonly<TaskStoreFile> {
    return this.file;
  }

  getTask(taskId: string): MusterTask | undefined {
    return this.file.tasks[taskId];
  }

  getTurnsForTask(taskId: string): TaskTurn[] {
    return Object.values(this.file.turns)
      .filter((turn) => turn.taskId === taskId)
      .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt));
  }

  viewStatusOf(taskId: string): TaskViewStatus | undefined {
    const task = this.file.tasks[taskId];
    if (!task) return undefined;
    const dependencies = new Map(
      task.dependencies
        .map((dependency) => [dependency.taskId, this.file.tasks[dependency.taskId]?.lifecycle] as const)
        .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined),
    );
    return deriveViewStatus(task, this.getTurnsForTask(taskId), dependencies);
  }

  /**
   * Bounded workspace reload. Loads task metadata, the bounded turn-activity
   * projection (every queued/live turn plus the latest terminal turn per task),
   * and the input messages of active turns. Full transcript history
   * (all turns/messages/tool calls/reasoning) is never loaded here — that is the
   * whole point of bounded bootstrap. `toolCalls`/`reasoning` stay empty.
   */
  async refreshAll(): Promise<void> {
    const tasks = [...await this.source.listTasks(this.workspaceId)];
    const liveIds = new Set(tasks.map((task) => task.id));
    for (const id of Object.keys(this.file.tasks)) {
      if (!liveIds.has(id)) this.removeTask(id);
    }
    const taskIds = tasks.map((task) => task.id);
    const [activityTurns, inputMessages] = await Promise.all([
      taskIds.length > 0 ? this.source.listTurnActivityForTasks(taskIds) : Promise.resolve([]),
      taskIds.length > 0 ? this.source.listActiveTurnInputMessages(taskIds) : Promise.resolve([]),
    ]);
    // Replace the whole bounded surface atomically: clear then repopulate so
    // stale terminal turns from a previous reload cannot linger.
    this.file.tasks = Object.fromEntries(tasks.map((task) => [task.id, task]));
    this.file.turns = Object.fromEntries(activityTurns.map((turn) => [turn.id, turn]));
    this.file.messages = Object.fromEntries(inputMessages.map((message) => [message.id, message]));
    this.file.toolCalls = {};
    this.file.reasoning = {};
    const activeTurnIds = Object.values(this.file.turns)
      .filter((turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user')
      .map((turn) => turn.id);
    // Bounded: only coordination for projected active turns (not workspace-wide).
    const [operations, cancelRequests, runtimeClaims] = await Promise.all([
      this.source.listOperationsForTurns(activeTurnIds),
      this.source.listCancelRequestsForTurns(activeTurnIds),
      this.source.listRuntimeClaimsForTurns(activeTurnIds),
    ]);
    this.file.operations = Object.fromEntries(operations.map(({ ledgerKey, entry }) => [ledgerKey, entry]));
    this.file.cancelRequests = Object.fromEntries(cancelRequests.map(({ turnId, request }) => [turnId, request]));
    this.file.runtimeClaims = Object.fromEntries(runtimeClaims.map((claim) => [claim.turnId, claim]));
    this.file.revision = await this.source.getWorkspaceRevision();
  }

  /**
   * Bounded per-task refresh after a write. Reloads task metadata, the bounded
   * turn-activity subset for that task, the input messages of its active turns,
   * and coordination rows (ops/cancel/claims) for surviving active turns only.
   * A long task never re-hydrates its full history after append/settle:
   * terminal turns beyond the latest one, and non-active-turn transcript rows,
   * are intentionally not projected. `toolCalls`/`reasoning` stay empty.
   */
  async refreshTask(taskId: string, knownTask?: MusterTask): Promise<void> {
    const task = knownTask ?? await this.source.getTask(taskId);
    if (!task) {
      this.removeTask(taskId);
      return;
    }
    const [turns, messages] = await Promise.all([
      this.source.listTurnActivityForTasks([taskId]),
      this.source.listActiveTurnInputMessages([taskId]),
    ]);
    this.removeTaskRows(taskId);
    this.file.tasks[taskId] = task;
    for (const turn of turns) this.file.turns[turn.id] = turn;
    for (const message of messages) this.file.messages[message.id] = message;
    // removeTaskRows drops cancel/claims for every prior projected turn of this
    // task. Reload coordination only for still-active turns so ordinary writes
    // (appendTranscriptBatch, replaceLiveTurn) cannot erase a live claim/cancel.
    await this.reloadActiveCoordination(
      turns
        .filter((turn) =>
          turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user',
        )
        .map((turn) => turn.id),
    );
  }

  /**
   * Batched multi-task refresh for external feed reconciliation. Uses one
   * listTurnActivityForTasks + one listActiveTurnInputMessages for the whole set
   * (no per-task N+1), then reloads coordination for surviving active turns.
   */
  async refreshTasks(taskIds: readonly string[]): Promise<void> {
    const uniqueIds = [...new Set(taskIds)].sort();
    if (uniqueIds.length === 0) {
      this.file.revision = await this.source.getWorkspaceRevision();
      return;
    }
    const [tasks, turns, messages] = await Promise.all([
      this.source.listTasksByIds(uniqueIds),
      this.source.listTurnActivityForTasks(uniqueIds),
      this.source.listActiveTurnInputMessages(uniqueIds),
    ]);
    for (const taskId of uniqueIds) this.removeTaskRows(taskId);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const taskId of uniqueIds) {
      const task = byId.get(taskId);
      if (!task) {
        delete this.file.tasks[taskId];
        continue;
      }
      this.file.tasks[taskId] = task;
    }
    for (const turn of turns) this.file.turns[turn.id] = turn;
    for (const message of messages) this.file.messages[message.id] = message;
    const activeTurnIds = turns
      .filter((turn) =>
        turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user',
      )
      .map((turn) => turn.id);
    await this.reloadActiveCoordination(activeTurnIds);
    this.file.revision = await this.source.getWorkspaceRevision();
  }

  /** Merge focused transcript entities hydrated by id (external reconcile only). */
  mergeFocusedTranscriptEntities(args: {
    taskId: string;
    messages?: readonly import('./types').TaskMessage[];
    toolCalls?: readonly import('./types').PersistedToolCall[];
    reasoning?: readonly import('./types').PersistedReasoning[];
  }): void {
    const { taskId } = args;
    for (const message of args.messages ?? []) {
      if (message.taskId === taskId) this.file.messages[message.id] = message;
    }
    if (!this.file.toolCalls) this.file.toolCalls = {};
    for (const tool of args.toolCalls ?? []) {
      if (tool.taskId === taskId) this.file.toolCalls[tool.id] = tool;
    }
    if (!this.file.reasoning) this.file.reasoning = {};
    for (const segment of args.reasoning ?? []) {
      if (segment.taskId === taskId) this.file.reasoning[segment.id] = segment;
    }
  }

  /**
   * Bounded reload of ops/cancel/claims for the given active turn ids only.
   * Constant call count (3 batched queries) — never N+1 per-turn RPCs.
   */
  private async reloadActiveCoordination(activeTurnIds: readonly string[]): Promise<void> {
    if (activeTurnIds.length === 0) return;
    const [operations, cancelEntries, claims] = await Promise.all([
      this.source.listOperationsForTurns(activeTurnIds),
      this.source.listCancelRequestsForTurns(activeTurnIds),
      this.source.listRuntimeClaimsForTurns(activeTurnIds),
    ]);
    for (const { ledgerKey, entry } of operations) {
      this.file.operations![ledgerKey] = entry;
    }
    for (const entry of cancelEntries) {
      this.file.cancelRequests![entry.turnId] = entry.request;
    }
    for (const claim of claims) {
      this.file.runtimeClaims![claim.turnId] = claim;
    }
  }

  async afterExecute(command: RepositoryCommand, result: RepositoryCommandResult): Promise<void> {
    if (!result.changed) return;
    if (command.kind === 'claimRuntime' || command.kind === 'heartbeatRuntime' || command.kind === 'releaseRuntime') {
      const claim = await this.source.getRuntimeClaim(command.turnId);
      if (claim) this.file.runtimeClaims![command.turnId] = claim;
      else delete this.file.runtimeClaims![command.turnId];
      await this.refreshRevision();
      return;
    }
    if (command.kind === 'clearHistory' || command.kind === 'deleteTask' || command.kind === 'deleteTaskSubtreeIfIdle') {
      await this.refreshAll();
      return;
    }
    const ids = this.affectedTaskIds(command);
    await Promise.all([...ids].map((id) => this.refreshTask(id)));
    // Apply coordination rows after aggregate refresh: refreshTask removes the
    // previous turn-bound coordination projection before loading current rows.
    this.applyCoordination(command);
    await this.refreshRevision();
  }

  private async refreshRevision(): Promise<void> {
    this.file.revision = await this.source.getWorkspaceRevision();
  }

  private affectedTaskIds(command: RepositoryCommand): Set<string> {
    const ids = new Set<string>();
    if ('taskId' in command && typeof command.taskId === 'string') ids.add(command.taskId);
    if ('task' in command && command.task && typeof command.task === 'object' && 'id' in command.task) ids.add(command.task.id);
    if ('tasks' in command && Array.isArray(command.tasks)) for (const task of command.tasks) ids.add(task.id);
    if ('turn' in command && command.turn && typeof command.turn === 'object' && 'taskId' in command.turn) ids.add(command.turn.taskId);
    if ('turns' in command && Array.isArray(command.turns)) for (const turn of command.turns) ids.add(turn.taskId);
    if ('message' in command && command.message && typeof command.message === 'object' && 'taskId' in command.message) ids.add(command.message.taskId);
    if ('messages' in command && Array.isArray(command.messages)) for (const message of command.messages) ids.add(message.taskId);
    if ('mutations' in command && Array.isArray(command.mutations)) for (const mutation of command.mutations) ids.add(mutation.taskId);
    if ('rootTaskId' in command && typeof command.rootTaskId === 'string') ids.add(command.rootTaskId);
    if (isGraphCommand(command)) {
      for (const id of command.deleteTaskIds ?? []) ids.add(id);
      for (const id of command.deleteTurnIds ?? []) {
        const taskId = this.file.turns[id]?.taskId;
        if (taskId) ids.add(taskId);
      }
      for (const id of command.deleteMessageIds ?? []) {
        const taskId = this.file.messages[id]?.taskId;
        if (taskId) ids.add(taskId);
      }
    }
    if ('turnId' in command && typeof command.turnId === 'string') {
      const taskId = this.file.turns[command.turnId]?.taskId;
      if (taskId) ids.add(taskId);
    }
    return ids;
  }

  private applyCoordination(command: RepositoryCommand): void {
    switch (command.kind) {
      case 'createChildTask':
      case 'delegateChildTask':
      case 'createChildTaskBatch':
      case 'delegateChildTaskBatch':
      case 'releaseChildTasks':
      case 'continueChildTask':
      case 'cancelChildTasks':
      case 'interruptChildTask':
      case 'cancelChildTask':
      case 'setChildTaskLifecycle':
      case 'waitForChildTasks':
      case 'completeGraphTask':
      case 'failGraphTask':
      case 'askParent':
      case 'answerChildQuestion':
      case 'consumeCancelRequest':
        if (command.operation) {
          this.file.operations![command.operation.ledgerKey] = command.operation.entry;
        }
        for (const key of command.deleteOperationKeys ?? []) delete this.file.operations![key];
        for (const entry of command.cancelRequests ?? []) {
          this.file.cancelRequests![entry.turnId] = entry.request;
        }
        for (const turnId of command.deleteCancelRequestTurnIds ?? []) {
          delete this.file.cancelRequests![turnId];
        }
        for (const turnId of command.deleteRuntimeClaimTurnIds ?? []) {
          delete this.file.runtimeClaims![turnId];
        }
        break;
      case 'putOperation':
      case 'claimOperation':
        this.file.operations![command.ledgerKey] = command.entry;
        break;
      case 'deleteOperationsForTurn':
        for (const key of Object.keys(this.file.operations!)) if (key.startsWith(`${command.turnId}:`)) delete this.file.operations![key];
        break;
      case 'putCancelRequest':
        this.file.cancelRequests![command.turnId] = command.request;
        break;
      case 'deleteCancelRequest':
        delete this.file.cancelRequests![command.turnId];
        break;
      case 'putSendReceipt':
        this.file.sendReceipts![command.receipt.clientRequestId] = command.receipt;
        break;
      case 'deleteSendReceipt':
        delete this.file.sendReceipts![command.clientRequestId];
        break;
      default:
        break;
    }
  }

  private removeTask(taskId: string): void {
    delete this.file.tasks[taskId];
    this.removeTaskRows(taskId);
  }

  private removeTaskRows(taskId: string): void {
    const turnIds = new Set(Object.values(this.file.turns).filter((turn) => turn.taskId === taskId).map((turn) => turn.id));
    for (const [id, turn] of Object.entries(this.file.turns)) if (turn.taskId === taskId) delete this.file.turns[id];
    for (const [id, message] of Object.entries(this.file.messages)) if (message.taskId === taskId) delete this.file.messages[id];
    for (const [id, tool] of Object.entries(this.file.toolCalls ?? {})) if (tool.taskId === taskId) delete this.file.toolCalls![id];
    for (const [id, segment] of Object.entries(this.file.reasoning ?? {})) if (segment.taskId === taskId) delete this.file.reasoning![id];
    for (const turnId of turnIds) {
      delete this.file.cancelRequests![turnId];
      delete this.file.runtimeClaims![turnId];
    }
  }
}

/** Context delivered after a successful durable commit + projection refresh. */
export interface RepositoryCommitContext {
  command: RepositoryCommand;
  result: RepositoryCommandResult;
  projection: RepositoryProjection;
  previousRevision: number;
  /** Snapshot of the projection file before this command's afterExecute refresh. */
  beforeFile: Readonly<TaskStoreFile>;
}

export interface WithRepositoryProjectionOptions {
  /**
   * Invoked only when result.changed is true, after afterExecute completes.
   * Host uses this to publish one workspacePatchBatch per commit.
   */
  onAfterCommit?: (ctx: RepositoryCommitContext) => void | Promise<void>;
}

/**
 * Shallow map snapshot of the bounded projection used for before/after patch
 * projection. Avoids full deep-clone of every nested entity on each write.
 * Safe because afterExecute replaces map entries rather than mutating them in place.
 */
export function snapshotProjectionBefore(
  file: Readonly<TaskStoreFile>,
): TaskStoreFile {
  return {
    schemaVersion: file.schemaVersion,
    revision: file.revision,
    tasks: { ...file.tasks },
    turns: { ...file.turns },
    messages: { ...file.messages },
    toolCalls: { ...(file.toolCalls ?? {}) },
    reasoning: { ...(file.reasoning ?? {}) },
    operations: { ...(file.operations ?? {}) },
    cancelRequests: { ...(file.cancelRequests ?? {}) },
    sendReceipts: { ...(file.sendReceipts ?? {}) },
    runtimeClaims: { ...(file.runtimeClaims ?? {}) },
  };
}

/** Wrap repository writes so the synchronous projection becomes visible before
 * a durable command resolves to its engine caller. */
export function withRepositoryProjection(
  source: TaskRepository,
  projection: RepositoryProjection,
  options?: WithRepositoryProjectionOptions,
): TaskRepository {
  // SQLite serializes transactions, but callers can enqueue several execute()
  // calls before the first projection refresh runs. Without a host-side tail,
  // commit A can refresh after commit B and both callbacks publish revision B,
  // creating an immediate reducer gap. Keep the whole local write lifecycle —
  // durable execute, bounded refresh, and post-commit publish — in commit order.
  let executeTail: Promise<void> = Promise.resolve();

  const runInWriteOrder = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = executeTail.then(operation, operation);
    executeTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const executeSerially = (
    target: TaskRepository,
    command: RepositoryCommand,
  ): Promise<RepositoryCommandResult> => {
    const run = async (): Promise<RepositoryCommandResult> => {
      const previousRevision = projection.getFile().revision;
      const beforeFile = snapshotProjectionBefore(projection.getFile());
      const result = await target.execute(command);
      await projection.afterExecute(command, result);
      if (result.changed && options?.onAfterCommit) {
        await options.onAfterCommit({
          command,
          result,
          projection,
          previousRevision,
          beforeFile,
        });
      }
      return result;
    };

    return runInWriteOrder(run);
  };

  return new Proxy(source, {
    get(target, property, receiver) {
      if (property === 'execute') {
        return (command: RepositoryCommand): Promise<RepositoryCommandResult> =>
          executeSerially(target, command);
      }
      if (property === 'runConsistentRead') {
        return <T>(read: () => Promise<T>): Promise<T> => runInWriteOrder(read);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
