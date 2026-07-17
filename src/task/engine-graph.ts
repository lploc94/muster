import { createHash, randomUUID } from 'crypto';
import type { AskBridge, Answers, AskRef } from '../bridge/ask-bridge';
import type { CredentialRegistry } from '../bridge/credentials';
import { buildTurnMcp, deleteMcpConfigFile } from '../bridge/mcp-config';
import { isKnownBackendId } from '../backends/index';
import type { Backend } from '../types';
import { canBindTaskToBackend } from './backend-eligibility';
import { mergeBriefFromCreate } from './brief';
import { capabilitiesFor } from './capabilities';
import { BATCH_EXPAND_MAX, type BatchChildSpec, type ToolCommand } from './coordinator-tools';
import { validateBindingsForRelease } from './dataflow';
import { normalizeVerdict } from './verdict';
import {
  buildHostContext,
  minimalHostSnapshot,
  type HostEnvironmentSnapshot,
} from './host-context';
import {
  parseTaskTypeRegistry,
  resolveCreateChildSpec,
  summarizeTaskTypes,
  TASK_TYPE_DIAGNOSTIC_MAX,
  TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX,
  type TaskTypeRegistryResult,
} from './task-types';
import {
  bridgeTokenTtlMs,
  canCreateTurn,
  checkLimit,
  countChildren,
  countRootChildren,
  DEFAULT_RESOURCE_LIMITS,
  taskDepth,
  type ExecutionPolicyBounds,
  type ResourceLimits,
} from './limits';
import { TASK_RESULT_MAX_BYTES, TRUNCATED_CONTENT_MARKER } from './content-limits';
import {
  DEFAULT_RUN_LIMIT_MS,
  remainingRunTimeMs,
  resolveTaskExecutionPolicy,
  type TaskExecutionHardBounds,
} from './execution-policy';

export const CREDENTIAL_DEADLINE_BUFFER_MS = 5 * 60_000;
export const ACP_DEADLINE_BUFFER_MS = 90_000;
import { evaluateTaskReadiness } from './readiness';
import { canPromoteTurn } from './scheduler';
import type { GraphCommandKind, RepositoryCommand, TaskRepository } from './repository';
import type { TaskReadPort } from './store-port';
import {
  createTask,
  cancelPendingTurn,
  continueTask as transitionContinueTask,
  holdQueuedFollowUpsOnFailure,
  interruptTurn,
  registerAsk,
  reopenTask,
  mergeWaitDisposition,
  stageDisposition,
  startTask as transitionStartTask,
  submitAnswer,
  cancelTask as transitionCancelTask,
  isTerminalLifecycle,
  mayParentSealDirect,
  setTaskLifecycle as transitionSetTaskLifecycle,
  type CreateTaskInput,
} from './transitions';
import type { DepGraph } from './deps';
import type {
  MusterTask,
  OpResult,
  TaskCapability,
  TaskDependency,
  TaskExecutionPolicy,
  TaskInputBinding,
  TaskStoreFile,
  TaskTurn,
} from './types';

export function deriveEntityId(callerTurnId: string, opId: string, suffix: string): string {
  const hash = createHash('sha256').update(`${callerTurnId}:${opId}:${suffix}`).digest('hex').slice(0, 16);
  return `${suffix}-${hash}`;
}

export function opLedgerKey(turnId: string, opId: string): string {
  return `${turnId}:${opId}`;
}

export function fingerprintCommand(command: ToolCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

/**
 * Stage wait_tasks on the caller turn for an exact child id set (compound delegate/release).
 * Rejects conflicting prior disposition. Idempotent when same opId already staged wait.
 */
function stageCompoundWait(
  draft: TaskStoreFile,
  ctx: { turnId: string; callerTaskId: string },
  _opId: string,
  waitTaskIds: string[],
  _limits: ResourceLimits,
):
  | { ok: true; addedTaskIds: string[]; alreadyStaged: boolean; waitTaskIds: string[] }
  | { ok: false; reason: string } {
  if (waitTaskIds.length === 0) {
    return { ok: false, reason: 'wait set must be non-empty' };
  }
  for (const id of waitTaskIds) {
    const child = draft.tasks[id];
    if (!child || child.parentId !== ctx.callerTaskId) {
      return { ok: false, reason: `wait target not owned direct child: ${id}` };
    }
  }
  const turn = draft.turns[ctx.turnId];
  if (!turn) return { ok: false, reason: 'turn not found' };
  const result = mergeWaitDisposition(turn, waitTaskIds);
  if (!result.ok) return result;
  draft.turns[ctx.turnId] = result.next.turn;
  return {
    ok: true,
    addedTaskIds: result.next.addedTaskIds,
    alreadyStaged: result.next.alreadyStaged,
    waitTaskIds: result.next.waitTaskIds,
  };
}

function depGraphFromFile(file: TaskStoreFile): DepGraph {
  return {
    rootOf: (taskId) => {
      const task = file.tasks[taskId];
      if (!task) return undefined;
      let current = task;
      while (current.parentId) {
        const parent = file.tasks[current.parentId];
        if (!parent) break;
        current = parent;
      }
      return current.id;
    },
    dependsOn: (taskId) => file.tasks[taskId]?.dependencies.map((d) => d.taskId) ?? [],
    briefKindOf: (taskId) => file.tasks[taskId]?.brief?.kind,
  };
}

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((t) => t.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Clear pending ask_parent on a cancelled task and matching parent inbound.
 * Required on every cancel path (local graph, deferred processCancelRequests, host cancelTask).
 */
export function clearPendingParentQuestionOnCancel(
  draft: TaskStoreFile,
  task: MusterTask,
  now: string,
): MusterTask {
  if (!task.pendingParentQuestion) return task;
  const qId = task.pendingParentQuestion.questionId;
  const nextTask: MusterTask = {
    ...task,
    pendingParentQuestion: undefined,
    attention:
      task.attention?.code === 'awaiting_parent_answer' ? undefined : task.attention,
  };
  // Clear routed inbound on every task that received this questionId (direct parent
  // and any open-ancestor deliverParent from ask_parent routing).
  for (const holder of Object.values(draft.tasks)) {
    if (!holder.pendingChildQuestions?.[qId]) continue;
    if (holder.id === task.id) continue;
    const nextInbound = { ...(holder.pendingChildQuestions ?? {}) };
    delete nextInbound[qId];
    const remainingIds = Object.keys(nextInbound).sort();
    let nextAttention = holder.attention;
    if (holder.attention?.code === 'child_question') {
      if (remainingIds.length === 0) {
        nextAttention = undefined;
      } else {
        // Recompute from a deterministic remaining inbound (cancel may have been the surfaced Q).
        const keepId = remainingIds[0]!;
        const keep = nextInbound[keepId]!;
        const keepChild = draft.tasks[keep.fromChildId];
        const keepSource =
          keepChild?.pendingParentQuestion?.questionId === keepId
            ? keepChild.pendingParentQuestion.sourceTurnId
            : undefined;
        nextAttention = {
          code: 'child_question',
          message: `child ${keep.fromChildId} needs input`,
          at: now,
          ...(keepSource ? { sourceTurnId: keepSource } : {}),
        };
      }
    }
    draft.tasks[holder.id] = {
      ...holder,
      pendingChildQuestions: remainingIds.length > 0 ? nextInbound : undefined,
      attention: nextAttention,
      revision: holder.revision + 1,
      updatedAt: now,
    };
  }
  return nextTask;
}

function childIdsOf(file: TaskStoreFile, parentId: string): string[] {
  return Object.values(file.tasks)
    .filter((t) => t.parentId === parentId)
    .map((t) => t.id);
}

function findRootId(file: TaskStoreFile, taskId: string): string {
  const task = file.tasks[taskId];
  if (!task) return taskId;
  let current = task;
  while (current.parentId) {
    const parent = file.tasks[current.parentId];
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function isDescendantOf(file: TaskStoreFile, ancestorId: string, taskId: string): boolean {
  let current = file.tasks[taskId];
  while (current) {
    if (current.id === ancestorId) return true;
    if (!current.parentId) return false;
    current = file.tasks[current.parentId];
  }
  return false;
}

function descendantIds(file: TaskStoreFile, rootId: string): string[] {
  const result: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const childId of childIdsOf(file, id)) {
      result.push(childId);
      stack.push(childId);
    }
  }
  return result.sort();
}

// start_child intentionally omitted — start_task is host/recovery only (W3).
const DEFAULT_WORKER_CAPS: TaskCapability[] = ['create_child', 'wait_child', 'read_subtree'];
/** Coordinator children get parent-seal reachability (cancel_child + interrupt). */
const DEFAULT_COORDINATOR_CHILD_CAPS: TaskCapability[] = [
  'create_child',
  'wait_child',
  'read_subtree',
  'cancel_child',
  'interrupt_child',
];
export interface GraphEngineDeps {
  store: TaskReadPort;
  /** Writable domain boundary; graph mutations never call store.commit(). */
  repository: TaskRepository;
  workspaceId: string;
  makeBackend: (name: string) => Backend;
  credentials: CredentialRegistry;
  askBridge: AskBridge;
  bridgePort: number;
  resourceLimits?: ResourceLimits;
  getRunLimitMs?: () => number;
  /** Bounds used to clamp agent-supplied execution policies. Defaults to DEFAULT_EXECUTION_POLICY_BOUNDS. */
  executionPolicyBounds?: ExecutionPolicyBounds;
  /** Independent hard cap on a bridge token's TTL. Defaults to MAX_BRIDGE_TOKEN_TTL_MS. */
  maxBridgeTokenTtlMs?: number;
  clock?: () => string;
  /** Active in-process runs keyed by turnId. Handles expose abort controllers. */
  liveRuns: Map<string, { controller: AbortController }>;
  /**
   * Durable stream barrier supplied by TaskEngine. Graph transitions that
   * mutate a locally-live turn must cross it before their own transaction.
   */
  flushPendingTranscript?: (
    turnId: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  pendingAskPromises: Map<string, { promise: Promise<Answers>; fingerprint: string }>;
  onScheduleTurn: (turnId: string) => void;
  /** W5: rescan queued released turns after lifecycle/resource changes. */
  onRescanSchedulableTurns?: (affectedTaskIds?: readonly string[]) => void;
  /** W9: workspace trust predicate for create-and-run paths. */
  isWorkspaceTrusted?: () => boolean;
  /** W3: sync host env cache for get_host_context (same as first-turn inject). */
  getHostEnvironment?: () => HostEnvironmentSnapshot | undefined;
  workspaceFolder?: string;
  /**
   * Task-types W2: live cwd-aware registry (VS Code muster.taskTypes).
   * Missing hook → treated as empty at create/list sites.
   */
  getTaskTypeRegistry?: (cwd?: string) => TaskTypeRegistryResult;
  leaseOwnerAlive: (turnId: string) => boolean;
  ownsLease: (turnId: string) => boolean;
  /** Stable owner id used by the cancel consumer's claim fence. */
  runtimeOwnerId?: string;
  writeCancelRequest: (
    turnId: string,
    kind: 'interrupt' | 'cancel',
    by: string,
    opId: string,
    sealedBy?: import('./types').TaskSealedBy,
  ) => void;
  onTurnSettled?: (turnId: string) => void;
}

function nowIso(clock?: () => string): string {
  return clock?.() ?? new Date().toISOString();
}

function ensureCoordinationMaps(draft: TaskStoreFile): void {
  draft.operations = draft.operations ?? {};
  draft.cancelRequests = draft.cancelRequests ?? {};
}

function readLedger(
  draft: TaskStoreFile,
  turnId: string,
  opId: string,
): { fingerprint: string; result: OpResult } | undefined {
  return draft.operations?.[opLedgerKey(turnId, opId)];
}

function writeLedger(
  draft: TaskStoreFile,
  turnId: string,
  opId: string,
  fingerprint: string,
  result: OpResult,
): void {
  ensureCoordinationMaps(draft);
  draft.operations![opLedgerKey(turnId, opId)] = { fingerprint, result };
}

type GraphApplyResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; reason: string };

function equalGraphValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Run a graph transition against an isolated projection and publish only the
 * rows that changed through the named repository command.  This keeps the
 * existing transition helpers synchronous/pure while making the durable write
 * atomic for both JSON compatibility and SQLite production adapters.
 */
async function executeGraphCommand(
  deps: GraphEngineDeps,
  kind: GraphCommandKind,
  mutate: (draft: TaskStoreFile) => GraphApplyResult,
  fences: {
    expectedTasks?: readonly { id: string; revision: number }[];
    expectedTurns?: readonly { id: string; status: import('./types').TurnStatus; runtimeEpoch?: number }[];
    expectedRuntimeClaims?: readonly { turnId: string; ownerId: string }[];
    expectedCancelRequests?: readonly { turnId: string; kind: import('./types').CancelRequest['kind']; opId: string }[];
    deleteSessionClaimTurnIds?: readonly string[];
    deleteResourceClaimTurnIds?: readonly string[];
    /**
     * Task ids whose FULL turn history must be present in the draft for correct
     * turn-cap counting / sequence numbering. The bounded runtime projection
     * only retains the latest terminal turn per task, so any handler that
     * enforces maxTurns on an existing task (continue/answer/ask on a task with
     * history) must hydrate it here. Rows are loaded ephemerally into both
     * `before` and `draft`, so identical rows never produce spurious writes and
     * nothing is cached back into the global projection.
     */
    hydrateFullTurnsForTaskIds?: readonly string[];
  } = {},
): Promise<{ ok: true; result?: GraphApplyResult } | { ok: false; error: string }> {
  const before = structuredClone(deps.store.getFile()) as TaskStoreFile;
  for (const taskId of fences.hydrateFullTurnsForTaskIds ?? []) {
    const fullTurns = await deps.repository.listTurns(taskId);
    for (const turn of fullTurns) before.turns[turn.id] = turn;
  }
  const draft = structuredClone(before) as TaskStoreFile;
  const applied = mutate(draft);
  if (!applied.ok) return { ok: false, error: applied.reason };

  const changedTasks = Object.values(draft.tasks).filter((task) => !equalGraphValue(task, before.tasks[task.id]));
  const changedTurns = Object.values(draft.turns).filter((turn) => !equalGraphValue(turn, before.turns[turn.id]));
  const changedMessages = Object.values(draft.messages).filter((message) => !equalGraphValue(message, before.messages[message.id]));
  const deletedTaskIds = Object.keys(before.tasks).filter((id) => !draft.tasks[id]);
  const deletedTurnIds = Object.keys(before.turns).filter((id) => !draft.turns[id]);
  const deletedMessageIds = Object.keys(before.messages).filter((id) => !draft.messages[id]);
  const changedCancelRequests = Object.entries(draft.cancelRequests ?? {})
    .filter(([id, request]) => !equalGraphValue(request, before.cancelRequests?.[id]))
    .map(([turnId, request]) => ({ turnId, request }));
  const deletedCancelRequestTurnIds = Object.keys(before.cancelRequests ?? {})
    .filter((id) => !draft.cancelRequests?.[id]);
  const deletedRuntimeClaimTurnIds = Object.keys(before.runtimeClaims ?? {})
    .filter((id) => !draft.runtimeClaims?.[id]);
  const changedOperations = Object.entries(draft.operations ?? {})
    .filter(([key, entry]) => !equalGraphValue(entry, before.operations?.[key]));
  const deletedOperationKeys = Object.keys(before.operations ?? {})
    .filter((key) => !draft.operations?.[key]);

  // A graph operation writes at most one ledger entry. More than one indicates
  // a transition bug; fail closed rather than silently dropping a result.
  if (changedOperations.length > 1) {
    return { ok: false, error: 'graph mutation produced an unsupported operation delta' };
  }
  const operation = changedOperations[0]
    ? { ledgerKey: changedOperations[0][0], entry: changedOperations[0][1], createdAt: nowIso(deps.clock) }
    : undefined;
  const expectedTasks = fences.expectedTasks ?? changedTasks
    .filter((task) => before.tasks[task.id] !== undefined)
    .map((task) => ({ id: task.id, revision: before.tasks[task.id]!.revision }));
  const expectedTurns = fences.expectedTurns ?? changedTurns
    .filter((turn) => before.turns[turn.id] !== undefined)
    .map((turn) => ({ id: turn.id, status: before.turns[turn.id]!.status, runtimeEpoch: before.turns[turn.id]!.runtimeEpoch }));
  const command: RepositoryCommand = {
    kind,
    workspaceId: deps.workspaceId,
    expectedTasks,
    ...(expectedTurns.length > 0 ? { expectedTurns } : {}),
    insertTaskIds: changedTasks.filter((task) => before.tasks[task.id] === undefined).map((task) => task.id),
    tasks: changedTasks,
    insertTurnIds: changedTurns.filter((turn) => before.turns[turn.id] === undefined).map((turn) => turn.id),
    turns: changedTurns,
    insertMessageIds: changedMessages.filter((message) => before.messages[message.id] === undefined).map((message) => message.id),
    messages: changedMessages,
    ...(deletedTaskIds.length > 0 ? { deleteTaskIds: deletedTaskIds } : {}),
    ...(deletedTurnIds.length > 0 ? { deleteTurnIds: deletedTurnIds } : {}),
    ...(deletedMessageIds.length > 0 ? { deleteMessageIds: deletedMessageIds } : {}),
    ...(operation ? { operation } : {}),
    ...(deletedOperationKeys.length > 0 ? { deleteOperationKeys: deletedOperationKeys } : {}),
    ...(changedCancelRequests.length > 0 ? { cancelRequests: changedCancelRequests } : {}),
    ...(deletedCancelRequestTurnIds.length > 0 ? { deleteCancelRequestTurnIds: deletedCancelRequestTurnIds } : {}),
    ...(deletedRuntimeClaimTurnIds.length > 0 ? { deleteRuntimeClaimTurnIds: deletedRuntimeClaimTurnIds } : {}),
    ...(fences.expectedRuntimeClaims && fences.expectedRuntimeClaims.length > 0
      ? { expectedRuntimeClaims: fences.expectedRuntimeClaims }
      : {}),
    ...(fences.expectedCancelRequests && fences.expectedCancelRequests.length > 0
      ? { expectedCancelRequests: fences.expectedCancelRequests }
      : {}),
    ...(fences.deleteSessionClaimTurnIds && fences.deleteSessionClaimTurnIds.length > 0
      ? { deleteSessionClaimTurnIds: fences.deleteSessionClaimTurnIds }
      : {}),
    ...(fences.deleteResourceClaimTurnIds && fences.deleteResourceClaimTurnIds.length > 0
      ? { deleteResourceClaimTurnIds: fences.deleteResourceClaimTurnIds }
      : {}),
  };

  // A graph tool can settle/cancel a sibling, consume a remote cancel request,
  // or stage an idle disposition on its own live turn (ask_parent). Persist the
  // last coalescing window before that durable transition and before any later
  // physical abort. Remote-owned turns have no local buffer in this process.
  const localLiveTurnIds = new Set<string>();
  for (const turn of changedTurns) {
    const prior = before.turns[turn.id];
    if (
      prior &&
      (prior.status === 'running' || prior.status === 'waiting_user') &&
      deps.liveRuns.has(turn.id)
    ) {
      localLiveTurnIds.add(turn.id);
    }
  }
  for (const turnId of deletedTurnIds) {
    const prior = before.turns[turnId];
    if (
      prior &&
      (prior.status === 'running' || prior.status === 'waiting_user') &&
      deps.liveRuns.has(turnId)
    ) {
      localLiveTurnIds.add(turnId);
    }
  }
  for (const turnId of localLiveTurnIds) {
    const flushed = await deps.flushPendingTranscript?.(turnId);
    if (flushed && !flushed.ok) {
      return { ok: false, error: `transcript persistence failed: ${flushed.message}` };
    }
  }

  const persisted = await deps.repository.execute(command);
  if (persisted.conflict) return { ok: false, error: persisted.reason ?? 'opId conflict: different arguments' };
  if (persisted.changed === false && persisted.reason) return { ok: false, error: persisted.reason };
  return { ok: true, result: applied };
}

export function pruneLedgerForTurn(draft: TaskStoreFile, turnId: string): void {
  if (!draft.operations) return;
  for (const key of Object.keys(draft.operations)) {
    if (key.startsWith(`${turnId}:`)) {
      delete draft.operations[key];
    }
  }
  if (draft.cancelRequests) {
    delete draft.cancelRequests[turnId];
  }
}

export function issueTurnCredential(
  deps: GraphEngineDeps,
  turnId: string,
): string | undefined {
  const file = deps.store.getFile();
  const turn = file.turns[turnId];
  const task = turn ? file.tasks[turn.taskId] : undefined;
  if (!turn || !task) return undefined;
  const rootId = findRootId(file, task.id);
  const actions = capabilitiesFor(task);
  const deadlineMs = turn.runDeadlineAt ? Date.parse(turn.runDeadlineAt) : Number.NaN;
  const remainingMs = Number.isFinite(deadlineMs)
    ? Math.max(1, deadlineMs - Date.now())
    : turn.effectiveRunLimitMs ??
      task.executionPolicy.runTimeoutOverrideMs ??
      DEFAULT_RUN_LIMIT_MS;
  return deps.credentials.issue({
    rootId,
    callerTaskId: task.id,
    turnId,
    allowedActions: actions,
    // Independent hard cap: even a large (clamped) turn timeout must not mint a
    // token that outlives MAX_BRIDGE_TOKEN_TTL_MS.
    ttlMs: bridgeTokenTtlMs(
      remainingMs + CREDENTIAL_DEADLINE_BUFFER_MS,
      deps.maxBridgeTokenTtlMs,
    ),
  });
}

export function buildRunOptionsForTurn(
  deps: GraphEngineDeps,
  turnId: string,
  base: { prompt: string; resumeId?: string; signal?: AbortSignal; cwd?: string; model?: string },
): { options: import('../types').RunOptions; mcpConfigPath?: string } {
  const file = deps.store.getFile();
  const turn = file.turns[turnId];
  const task = turn ? file.tasks[turn.taskId] : undefined;
  if (!turn || !task) {
    return { options: base };
  }
  const backend = deps.makeBackend(task.backend);
  const token = issueTurnCredential(deps, turnId) ?? '';
  const turnMcp = buildTurnMcp(backend, { port: deps.bridgePort }, token);
  const remainingMs = remainingRunTimeMs(turn);
  return {
    options: {
      ...base,
      ...(remainingMs !== undefined
        ? {
            setupTimeoutMs: Math.max(1, remainingMs),
            promptTimeoutMs:
              Math.max(1, remainingMs) + ACP_DEADLINE_BUFFER_MS,
          }
        : {}),
      ...(turnMcp.mcpServers ? { mcpServers: turnMcp.mcpServers } : {}),
      ...(turnMcp.mcpConfigPath ? { mcpConfigPath: turnMcp.mcpConfigPath } : {}),
    },
    mcpConfigPath: turnMcp.mcpConfigPath,
  };
}

export function cleanupTurnResources(
  deps: GraphEngineDeps,
  turnId: string,
  mcpConfigPath?: string,
): void {
  deps.credentials.revoke(turnId);
  deps.askBridge.cancelForTurn(turnId, 'turn settled');
  deleteMcpConfigFile(mcpConfigPath);
  deps.pendingAskPromises.delete(opLedgerKey(turnId, 'ask'));
}

function actionForCommand(command: ToolCommand): string {
  return command.kind;
}

/**
 * Topologically order batch localIds so every prerequisite precedes its
 * dependents. `prereqs` maps a localId to the set of sibling localIds it waits
 * for (dependsOn ∪ intra-batch inputBinding producers). Returns `undefined` when
 * the intra-batch DAG contains a cycle (whole batch is then rejected).
 */
function topoSortLocalIds(
  localIds: readonly string[],
  prereqs: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | undefined {
  const order: string[] = [];
  // 0 = unvisited, 1 = on stack (visiting), 2 = done
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 2) return true;
    if (s === 1) return false; // back-edge → cycle
    state.set(id, 1);
    for (const p of prereqs.get(id) ?? []) {
      if (!visit(p)) return false;
    }
    state.set(id, 2);
    order.push(id);
    return true;
  };
  for (const id of localIds) {
    if (!visit(id)) return undefined;
  }
  return order;
}

export async function executeToolCommand(
  deps: GraphEngineDeps,
  ctx: { callerTaskId: string; turnId: string; rootId: string; allowedActions?: ReadonlySet<string> },
  command: ToolCommand,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const limits = deps.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
  const now = nowIso(deps.clock);
  const fingerprint = fingerprintCommand(command);

  if (ctx.allowedActions && !ctx.allowedActions.has(actionForCommand(command))) {
    return { ok: false, error: `action not permitted: ${actionForCommand(command)}` };
  }
  // Compound wait fields require wait_for_tasks / wait_child in addition to create_child tools.
  const wantsCompoundWait =
    (command.kind === 'delegate_task' && command.waitForCompletion === true) ||
    (command.kind === 'delegate_tasks' &&
      command.waitForLocalIds !== undefined &&
      command.waitForLocalIds.length > 0) ||
    (command.kind === 'release_tasks' &&
      command.waitForTaskIds !== undefined &&
      command.waitForTaskIds.length > 0) ||
    (command.kind === 'continue_child' && command.waitForCompletion === true);
  if (wantsCompoundWait && ctx.allowedActions && !ctx.allowedActions.has('wait_for_tasks')) {
    return {
      ok: false,
      error: 'action not permitted: wait_for_tasks (required for compound wait fields)',
    };
  }

  if (
    command.kind !== 'get_task_status' &&
    command.kind !== 'report_progress' &&
    command.kind !== 'get_host_context' &&
    command.kind !== 'list_task_types'
  ) {
    const key = opLedgerKey(ctx.turnId, command.opId);
    const existing = deps.store.getFile().operations?.[key] ?? await deps.repository.getOperation(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { ok: false, error: 'opId conflict: different arguments' };
      }
      return { ok: true, result: existing.result.data };
    }
  }

  switch (command.kind) {
    case 'create_task':
    case 'delegate_task': {
      if (
        command.kind === 'delegate_task' &&
        deps.isWorkspaceTrusted &&
        !deps.isWorkspaceTrusted()
      ) {
        return {
          ok: false,
          error: JSON.stringify({
            code: 'workspace_untrusted',
            message: 'workspace is not trusted; cannot run or release tasks',
            retryable: true,
          }),
        };
      }

      // Resolve task type before any store mutation (fail-closed).
      const callerForCwd = deps.store.getFile().tasks[ctx.callerTaskId];
      const registryCwd =
        (callerForCwd?.cwd && callerForCwd.cwd.length > 0 ? callerForCwd.cwd : undefined) ??
        deps.workspaceFolder;
      const registryResult: TaskTypeRegistryResult = deps.getTaskTypeRegistry
        ? deps.getTaskTypeRegistry(registryCwd)
        : parseTaskTypeRegistry(undefined);
      const resolved = resolveCreateChildSpec(
        {
          taskType: command.spec.taskType,
          backend: command.spec.backend,
          model: command.spec.model,
          role: command.spec.role,
          briefKind: command.spec.brief?.kind,
        },
        registryResult,
      );
      if (!resolved.ok) {
        return {
          ok: false,
          error: JSON.stringify({
            code: resolved.code,
            message: resolved.message,
          }),
        };
      }

      if (!isKnownBackendId(resolved.resolved.backend)) {
        return {
          ok: false,
          error: JSON.stringify({
            code: 'backend_unsupported',
            message: `unsupported backend: ${resolved.resolved.backend}`,
          }),
        };
      }

      let backend: Backend;
      try {
        backend = deps.makeBackend(resolved.resolved.backend);
      } catch {
        return {
          ok: false,
          error: JSON.stringify({
            code: 'backend_unsupported',
            message: `unsupported backend: ${resolved.resolved.backend}`,
          }),
        };
      }
      if (!canBindTaskToBackend(backend.capabilities)) {
        return {
          ok: false,
          error: JSON.stringify({
            code: 'backend_not_mcp',
            message: 'backend does not support MCP',
          }),
        };
      }

      const childId = deriveEntityId(ctx.turnId, command.opId, 'task');
      const turnId = deriveEntityId(ctx.turnId, command.opId, 'turn');
      const resolvedRole = resolved.resolved.role;
      const resolvedBackend = resolved.resolved.backend;
      const resolvedModel = resolved.resolved.model;
      const resolvedTaskType = resolved.resolved.taskType;
      const resolvedBriefKind = resolved.resolved.briefKind;

      const commit = await executeGraphCommand(
        deps,
        command.kind === 'delegate_task' ? 'delegateChildTask' : 'createChildTask',
        (draft) => {
        ensureCoordinationMaps(draft);
        const caller = draft.tasks[ctx.callerTaskId];
        if (!caller || caller.lifecycle !== 'open') {
          return { ok: false, reason: 'caller task not open' };
        }
        if (draft.tasks[childId]) {
          const ledger = readLedger(draft, ctx.turnId, command.opId);
          if (ledger) {
            return { ok: true };
          }
          return { ok: false, reason: 'child id collision' };
        }

        const rootId = findRootId(draft, ctx.callerTaskId);
        const parentDepth = taskDepth(draft, ctx.callerTaskId);
        if (parentDepth + 1 >= limits.maxDepth) {
          return { ok: false, reason: 'max depth exceeded' };
        }
        const childCheck = checkLimit('children_per_task', limits, {
          file: draft,
          parentId: ctx.callerTaskId,
          rootId,
          childCountForParent: countChildren(draft, ctx.callerTaskId),
        });
        if (!childCheck.ok) return childCheck;
        const rootCheck = checkLimit('children_per_root', limits, {
          file: draft,
          parentId: ctx.callerTaskId,
          rootId,
          childCountForRoot: countRootChildren(draft, rootId),
        });
        if (!rootCheck.ok) return rootCheck;

        const bindingCheck = validateBindingsForRelease(command.spec.inputBindings);
        if (!bindingCheck.ok) {
          return { ok: false, reason: bindingCheck.reason };
        }
        const brief = mergeBriefFromCreate({
          goal: command.spec.goal,
          description: command.spec.description,
          brief: command.spec.brief,
          writePaths: command.spec.writePaths,
          readPaths: command.spec.readPaths,
          defaultKind: resolvedBriefKind,
        });
        const input: CreateTaskInput = {
          id: childId,
          role: resolvedRole,
          goal: brief.objective || command.spec.goal,
          description: command.spec.description,
          parentId: ctx.callerTaskId,
          dependencies: command.spec.dependencies ?? [],
          backend: resolvedBackend,
          // Optional ACP model id; omit → agent default for that backend.
          model: resolvedModel,
          taskType: resolvedTaskType,
          // Children inherit the parent's workspace directory so delegated
          // sub-tasks run in the same place and never fall back to process.cwd().
          cwd: caller.cwd,
          capabilities:
            resolvedRole === 'coordinator'
              ? DEFAULT_COORDINATOR_CHILD_CAPS
              : DEFAULT_WORKER_CAPS,
          // Canonical resolver only — optional injected bounds map into hard bounds.
          executionPolicy: resolveTaskExecutionPolicy(command.spec.executionPolicy, {
            userRunLimitMs: deps.getRunLimitMs?.() ?? DEFAULT_RUN_LIMIT_MS,
            ...(deps.executionPolicyBounds
              ? {
                  bounds: {
                    maxTurns: deps.executionPolicyBounds.maxTurns,
                    maxAutomaticRetries: deps.executionPolicyBounds.maxAutomaticRetries,
                    minRunLimitMs: deps.executionPolicyBounds.minTurnTimeoutMs,
                    maxRunLimitMs: deps.executionPolicyBounds.maxTurnTimeoutMs,
                  } satisfies TaskExecutionHardBounds,
                }
              : {}),
          }),
          // create_task stays draft; delegate_task is atomic released create-and-run.
          releaseState: command.kind === 'delegate_task' ? 'released' : 'draft',
          brief,
          ...(command.spec.inputBindings ? { inputBindings: command.spec.inputBindings } : {}),
          ...(command.spec.claimsGit !== undefined ? { claimsGit: command.spec.claimsGit } : {}),
        };
        const graph = depGraphFromFile(draft);
        const created = createTask(input, { rootId, graph, now });
        if (!created.ok) return created;
        draft.tasks[childId] =
          command.kind === 'delegate_task'
            ? {
                ...created.next,
                releasedAt: now,
                releaseAttemptId: command.opId,
              }
            : created.next;

        let queuedTurnId: string | undefined;
        if (command.kind === 'delegate_task') {
          const messageId = randomUUID();
          draft.messages[messageId] = {
            id: messageId,
            taskId: childId,
            role: 'user',
            content: brief.objective || command.spec.goal,
            state: 'assigned',
            createdAt: now,
            turnId,
          };
          const turnCheck = canCreateTurn(draft, childId, limits);
          if (!turnCheck.ok) return turnCheck;
          const started = transitionStartTask(draft.tasks[childId]!, [], {
            turnId,
            now,
            inputs: [{ kind: 'message', messageId }],
            trigger: 'engine',
          });
          if (!started.ok) return started;
          draft.turns[turnId] = started.next;
          queuedTurnId = turnId;
        }

        let waitMetadata:
          | { addedTaskIds: string[]; alreadyStaged: boolean; waitTaskIds: string[] }
          | undefined;
        if (command.kind === 'delegate_task' && command.waitForCompletion === true) {
          const waitStaged = stageCompoundWait(draft, ctx, command.opId, [childId], limits);
          if (!waitStaged.ok) return waitStaged;
          waitMetadata = waitStaged;
        }

        // Child creation is also an ownership/limit fence. Bump the caller
        // revision in the same graph transaction so concurrent coordinators
        // cannot both pass the child-count check from one stale snapshot.
        draft.tasks[ctx.callerTaskId] = {
          ...draft.tasks[ctx.callerTaskId]!,
          revision: draft.tasks[ctx.callerTaskId]!.revision + 1,
          updatedAt: now,
        };

        const childPolicy = draft.tasks[childId]!.executionPolicy;
        const result: OpResult = {
          ok: true,
          data: {
            taskId: childId,
            turnId: queuedTurnId,
            taskType: resolvedTaskType,
            resolved: {
              backend: resolvedBackend,
              ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
              role: resolvedRole,
              briefKind: brief.kind,
            },
            executionPolicy: {
              maxTurns: childPolicy.maxTurns,
              maxAutomaticRetries: childPolicy.maxAutomaticRetries,
              ...(childPolicy.runTimeoutOverrideMs !== undefined
                ? { runTimeoutOverrideMs: childPolicy.runTimeoutOverrideMs }
                : {}),
              hostRunLimitMs: deps.getRunLimitMs?.() ?? DEFAULT_RUN_LIMIT_MS,
            },
            ...(waitMetadata
              ? {
                  waitStaged: true,
                  staged: true,
                  alreadyStaged: waitMetadata.alreadyStaged,
                  waitTaskIds: waitMetadata.waitTaskIds,
                  nextAction: 'end_current_turn',
                  doNotPoll: true,
                }
              : {}),
          },
        };
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, result);
        return { ok: true };
        },
      );

      if (!commit.ok) {
        return { ok: false, error: commit.error };
      }

      if (command.kind === 'delegate_task') {
        const turnId = deriveEntityId(ctx.turnId, command.opId, 'turn');
        deps.onScheduleTurn(turnId);
      }

      const ledger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      return { ok: true, result: ledger?.result.data };
    }

    case 'create_tasks':
    case 'delegate_tasks': {
      const isDelegate = command.kind === 'delegate_tasks';

      // Reject an over-cap batch before any resolution or write (dispatch also caps).
      if (command.specs.length === 0 || command.specs.length > BATCH_EXPAND_MAX) {
        return {
          ok: false,
          error: JSON.stringify({
            code: 'batch_too_large',
            message: `batch exceeds max of ${BATCH_EXPAND_MAX} tasks`,
          }),
        };
      }

      // Derive stable ids for every item up front so intra-batch references resolve.
      const idByLocal = new Map<string, string>();
      const turnIdByLocal = new Map<string, string>();
      for (const spec of command.specs) {
        idByLocal.set(spec.localId, deriveEntityId(ctx.turnId, command.opId, `task:${spec.localId}`));
        turnIdByLocal.set(spec.localId, deriveEntityId(ctx.turnId, command.opId, `turn:${spec.localId}`));
      }

      interface ResolvedBatchItem {
        spec: BatchChildSpec;
        childId: string;
        turnId: string;
        role: import('./types').TaskRole;
        backend: string;
        model?: string;
        taskType: string;
        briefKind: import('./types').TaskBriefKind;
      }

      // Build intra-batch prerequisite edges (dependsOn ∪ intra-batch binding producers)
      // and topo-sort so producers are inserted before consumers. Reject cycles.
      const localIds = command.specs.map((s) => s.localId);
      const prereqs = new Map<string, Set<string>>();
      for (const spec of command.specs) {
        const set = new Set<string>();
        for (const dep of spec.dependsOn ?? []) set.add(dep);
        for (const binding of spec.inputBindings ?? []) {
          if (binding.fromLocalId !== undefined) set.add(binding.fromLocalId);
        }
        prereqs.set(spec.localId, set);
      }
      const order = topoSortLocalIds(localIds, prereqs);
      if (!order) {
        return {
          ok: false,
          error: JSON.stringify({
            code: 'batch_cycle',
            message: 'intra-batch dependency cycle detected',
          }),
        };
      }

      // Deterministic output ordering (spec order), independent of topo insertion order.
      const orderedTaskIds = command.specs.map((s) => idByLocal.get(s.localId)!);
      const orderedTurnIds = command.specs.map((s) => turnIdByLocal.get(s.localId)!);

      const commit = await executeGraphCommand(
        deps,
        isDelegate ? 'delegateChildTaskBatch' : 'createChildTaskBatch',
        (draft) => {
        ensureCoordinationMaps(draft);
        // Idempotent replay: a cached ledger for this (turn, opId) short-circuits
        // before any caller/config check or write. Compare the fingerprint so a reused
        // opId with different arguments conflicts instead of silently succeeding with
        // the wrong result (the batch's ids are argument-derived, so a coarse existence
        // check could otherwise return another op's tasks and schedule phantom turns).
        const priorLedger = readLedger(draft, ctx.turnId, command.opId);
        if (priorLedger) {
          if (priorLedger.fingerprint !== fingerprint) {
            return { ok: false, reason: 'opId conflict: different arguments' };
          }
          return { ok: true };
        }
        const caller = draft.tasks[ctx.callerTaskId];
        if (!caller || caller.lifecycle !== 'open') {
          return { ok: false, reason: 'caller task not open' };
        }

        // Delegate runs/releases work — requires a trusted workspace. Checked here (not
        // pre-commit) so the fresh ledger above is the authoritative replay/conflict
        // decision before any time-varying validation can reject a legitimate replay.
        if (isDelegate && deps.isWorkspaceTrusted && !deps.isWorkspaceTrusted()) {
          return {
            ok: false,
            reason: JSON.stringify({
              code: 'workspace_untrusted',
              message: 'workspace is not trusted; cannot run or release tasks',
              retryable: true,
            }),
          };
        }

        // Resolve task type + backend eligibility for every item against the fresh,
        // under-lock draft (fail-closed). After the ledger short-circuit, so a replay
        // never re-validates and a stale outer (in-memory) check cannot fail it. The
        // structured error is carried in `reason`, surfaced verbatim via commit.detail.
        const registryCwd =
          (caller.cwd && caller.cwd.length > 0 ? caller.cwd : undefined) ?? deps.workspaceFolder;
        const registryResult: TaskTypeRegistryResult = deps.getTaskTypeRegistry
          ? deps.getTaskTypeRegistry(registryCwd)
          : parseTaskTypeRegistry(undefined);
        const resolvedByLocal = new Map<string, ResolvedBatchItem>();
        for (const spec of command.specs) {
          const resolved = resolveCreateChildSpec(
            {
              taskType: spec.taskType,
              backend: spec.backend,
              model: spec.model,
              role: spec.role,
              briefKind: spec.brief?.kind,
            },
            registryResult,
          );
          if (!resolved.ok) {
            return {
              ok: false,
              reason: JSON.stringify({
                code: resolved.code,
                message: resolved.message,
                localId: spec.localId,
              }),
            };
          }
          if (!isKnownBackendId(resolved.resolved.backend)) {
            return {
              ok: false,
              reason: JSON.stringify({
                code: 'backend_unsupported',
                message: `unsupported backend: ${resolved.resolved.backend}`,
                localId: spec.localId,
              }),
            };
          }
          let backend: Backend;
          try {
            backend = deps.makeBackend(resolved.resolved.backend);
          } catch {
            return {
              ok: false,
              reason: JSON.stringify({
                code: 'backend_unsupported',
                message: `unsupported backend: ${resolved.resolved.backend}`,
                localId: spec.localId,
              }),
            };
          }
          if (!canBindTaskToBackend(backend.capabilities)) {
            return {
              ok: false,
              reason: JSON.stringify({
                code: 'backend_not_mcp',
                message: 'backend does not support MCP',
                localId: spec.localId,
              }),
            };
          }
          resolvedByLocal.set(spec.localId, {
            spec,
            childId: idByLocal.get(spec.localId)!,
            turnId: turnIdByLocal.get(spec.localId)!,
            role: resolved.resolved.role,
            backend: resolved.resolved.backend,
            model: resolved.resolved.model,
            taskType: resolved.resolved.taskType,
            briefKind: resolved.resolved.briefKind,
          });
        }

        for (const item of resolvedByLocal.values()) {
          if (draft.tasks[item.childId]) {
            return { ok: false, reason: 'batch child id collision' };
          }
        }

        const rootId = findRootId(draft, ctx.callerTaskId);
        const parentDepth = taskDepth(draft, ctx.callerTaskId);
        const n = command.specs.length;
        if (parentDepth + 1 >= limits.maxDepth) {
          return { ok: false, reason: 'max depth exceeded' };
        }
        if (countChildren(draft, ctx.callerTaskId) + n > limits.maxChildrenPerTask) {
          return { ok: false, reason: 'max children per task exceeded' };
        }
        if (countRootChildren(draft, rootId) + n > limits.maxChildrenPerRoot) {
          return { ok: false, reason: 'max children per root exceeded' };
        }

        // Insert in topo order so depGraphFromFile(draft) sees prerequisite siblings.
        for (const localId of order) {
          const item = resolvedByLocal.get(localId)!;
          const spec = item.spec;

          // Resolved dependencies: sibling dependsOn (succeeded/block) + pre-existing
          // dependencies + auto-derived succeeded/block per intra-batch binding (dedup by id).
          // Caller-supplied dependencies on pre-existing tasks go in first; the
          // intra-batch guarantees below then override unconditionally, so a weaker
          // explicit dep on a sibling id cannot subvert the required succeeded/block
          // wait that dependsOn / an intra-batch inputBinding must enforce.
          const depMap = new Map<string, TaskDependency>();
          for (const dep of spec.dependencies ?? []) {
            depMap.set(dep.taskId, dep);
          }
          // Batch dependsOn: fail (not silent block) so sink-only waits resolve on upstream fail.
          for (const sib of spec.dependsOn ?? []) {
            const depId = idByLocal.get(sib)!;
            depMap.set(depId, { taskId: depId, requiredOutcome: 'succeeded', onUnsatisfied: 'fail' });
          }

          const bindings: TaskInputBinding[] = [];
          for (const binding of spec.inputBindings ?? []) {
            const fromTaskId =
              binding.fromLocalId !== undefined
                ? idByLocal.get(binding.fromLocalId)!
                : binding.fromTaskId!;
            bindings.push({
              fromTaskId,
              output: binding.output,
              as: binding.as,
              ...(binding.required !== undefined ? { required: binding.required } : {}),
            });
            // An intra-batch binding producer must be waited for (succeeded/block),
            // overriding any weaker explicit dep the caller set on that sibling.
            if (binding.fromLocalId !== undefined) {
              depMap.set(fromTaskId, {
                taskId: fromTaskId,
                requiredOutcome: 'succeeded',
                onUnsatisfied: 'fail',
              });
            }
          }
          const dependencies = [...depMap.values()];

          const bindingCheck = validateBindingsForRelease(bindings.length > 0 ? bindings : undefined);
          if (!bindingCheck.ok) {
            return { ok: false, reason: bindingCheck.reason };
          }
          const brief = mergeBriefFromCreate({
            goal: spec.goal,
            description: spec.description,
            brief: spec.brief,
            writePaths: spec.writePaths,
            readPaths: spec.readPaths,
            defaultKind: item.briefKind,
          });
          const input: CreateTaskInput = {
            id: item.childId,
            role: item.role,
            goal: brief.objective || spec.goal,
            description: spec.description,
            parentId: ctx.callerTaskId,
            dependencies,
            backend: item.backend,
            model: item.model,
            taskType: item.taskType,
            cwd: caller.cwd,
            capabilities:
              item.role === 'coordinator'
                ? DEFAULT_COORDINATOR_CHILD_CAPS
                : DEFAULT_WORKER_CAPS,
            executionPolicy: resolveTaskExecutionPolicy(spec.executionPolicy, {
              userRunLimitMs: deps.getRunLimitMs?.() ?? DEFAULT_RUN_LIMIT_MS,
              ...(deps.executionPolicyBounds
                ? {
                    bounds: {
                      maxTurns: deps.executionPolicyBounds.maxTurns,
                      maxAutomaticRetries: deps.executionPolicyBounds.maxAutomaticRetries,
                      minRunLimitMs: deps.executionPolicyBounds.minTurnTimeoutMs,
                      maxRunLimitMs: deps.executionPolicyBounds.maxTurnTimeoutMs,
                    } satisfies TaskExecutionHardBounds,
                  }
                : {}),
            }),
            releaseState: isDelegate ? 'released' : 'draft',
            brief,
            ...(bindings.length > 0 ? { inputBindings: bindings } : {}),
            ...(spec.claimsGit !== undefined ? { claimsGit: spec.claimsGit } : {}),
          };
          // Live graph: sees already-inserted siblings in this same batch.
          const graph = depGraphFromFile(draft);
          const created = createTask(input, { rootId, graph, now });
          if (!created.ok) return created;
          draft.tasks[item.childId] = isDelegate
            ? { ...created.next, releasedAt: now, releaseAttemptId: command.opId }
            : created.next;

          if (isDelegate) {
            const messageId = randomUUID();
            draft.messages[messageId] = {
              id: messageId,
              taskId: item.childId,
              role: 'user',
              content: brief.objective || spec.goal,
              state: 'assigned',
              createdAt: now,
              turnId: item.turnId,
            };
            const turnCheck = canCreateTurn(draft, item.childId, limits);
            if (!turnCheck.ok) return turnCheck;
            const started = transitionStartTask(draft.tasks[item.childId]!, [], {
              turnId: item.turnId,
              now,
              inputs: [{ kind: 'message', messageId }],
              trigger: 'engine',
            });
            if (!started.ok) return started;
            draft.turns[item.turnId] = started.next;
          }
        }

        let waitTaskIds: string[] | undefined;
        let waitMetadata:
          | { addedTaskIds: string[]; alreadyStaged: boolean; waitTaskIds: string[] }
          | undefined;
        if (isDelegate && command.kind === 'delegate_tasks' && command.waitForLocalIds) {
          waitTaskIds = command.waitForLocalIds.map((localId) => idByLocal.get(localId)!);
          const waitStaged = stageCompoundWait(draft, ctx, command.opId, waitTaskIds, limits);
          if (!waitStaged.ok) return waitStaged;
          waitMetadata = waitStaged;
        }

        // Serialize ownership and per-parent/root limits with the caller task
        // revision; this is part of the same mutation as every child row.
        draft.tasks[ctx.callerTaskId] = {
          ...draft.tasks[ctx.callerTaskId]!,
          revision: draft.tasks[ctx.callerTaskId]!.revision + 1,
          updatedAt: now,
        };

        const hostRunLimitMs = deps.getRunLimitMs?.() ?? DEFAULT_RUN_LIMIT_MS;
        const result: OpResult = {
          ok: true,
          data: {
            taskIds: orderedTaskIds,
            turnIds: isDelegate ? orderedTurnIds : [],
            executionPolicies: orderedTaskIds.map((id) => {
              const policy = draft.tasks[id]!.executionPolicy;
              return {
                taskId: id,
                maxTurns: policy.maxTurns,
                maxAutomaticRetries: policy.maxAutomaticRetries,
                ...(policy.runTimeoutOverrideMs !== undefined
                  ? { runTimeoutOverrideMs: policy.runTimeoutOverrideMs }
                  : {}),
                hostRunLimitMs,
              };
            }),
            ...(waitMetadata
              ? {
                  waitStaged: true,
                  staged: true,
                  alreadyStaged: waitMetadata.alreadyStaged,
                  waitTaskIds: waitMetadata.waitTaskIds,
                  nextAction: 'end_current_turn',
                  doNotPoll: true,
                }
              : {}),
          },
        };
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, result);
        return { ok: true };
        },
      );

      if (!commit.ok) {
        return { ok: false, error: commit.error };
      }

      const batchLedger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      const ledgerData = batchLedger?.result.data as
        | { taskIds?: string[]; turnIds?: string[]; waitStaged?: boolean; waitTaskIds?: string[] }
        | undefined;
      if (isDelegate) {
        // Schedule from the ledger's turnIds — authoritative on both a fresh create and
        // an idempotent replay. Using this command's derived ids would try to schedule
        // phantom turns when a same-opId request short-circuits on an existing ledger.
        for (const turnId of ledgerData?.turnIds ?? []) {
          deps.onScheduleTurn(turnId);
        }
      }
      return { ok: true, result: ledgerData };
    }

    case 'release_tasks': {
      if (deps.isWorkspaceTrusted && !deps.isWorkspaceTrusted()) {
        return {
          ok: false,
          error: JSON.stringify({
            code: 'workspace_untrusted',
            message: 'workspace is not trusted; cannot run or release tasks',
            retryable: true,
          }),
        };
      }
      const scheduledTurnIds: string[] = [];
      const commit = await executeGraphCommand(deps, 'releaseChildTasks', (draft) => {
        ensureCoordinationMaps(draft);
        const caller = draft.tasks[ctx.callerTaskId];
        if (!caller || caller.lifecycle !== 'open') {
          return { ok: false, reason: 'caller task not open' };
        }

        // Resolve release set (explicit ids + optional dependency closure).
        const resolved = new Set<string>();
        const stack = [...command.taskIds];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (resolved.has(id)) continue;
          resolved.add(id);
          if (command.includeDependencies) {
            const task = draft.tasks[id];
            if (task) {
              for (const dep of task.dependencies) {
                stack.push(dep.taskId);
              }
            }
          }
        }

        type TaskError = { taskId: string; code: string; message: string };
        const taskErrors: TaskError[] = [];
        const members = [...resolved];

        for (const taskId of members) {
          const task = draft.tasks[taskId];
          if (!task) {
            taskErrors.push({ taskId, code: 'not_found', message: 'task not found' });
            continue;
          }
          if (task.parentId !== ctx.callerTaskId) {
            taskErrors.push({
              taskId,
              code: 'not_owned',
              message: 'not an owned direct child of the caller',
            });
            continue;
          }
          if (task.lifecycle !== 'open') {
            taskErrors.push({
              taskId,
              code: 'not_open',
              message: `task lifecycle is ${task.lifecycle}`,
            });
            continue;
          }
          const releaseState = task.releaseState;
          if (releaseState === 'released') {
            // Idempotent only when same releaseAttemptId.
            if (task.releaseAttemptId !== command.opId) {
              taskErrors.push({
                taskId,
                code: 'already_released',
                message: 'task already released under a different attempt',
              });
            }
            continue;
          }
          if (!task.brief) {
            taskErrors.push({
              taskId,
              code: 'missing_brief',
              message: 'task has no brief',
            });
            continue;
          }
          const bindingCheck = validateBindingsForRelease(task.inputBindings);
          if (!bindingCheck.ok) {
            taskErrors.push({
              taskId,
              code: 'invalid_bindings',
              message: bindingCheck.reason,
            });
            continue;
          }
          const backend = deps.makeBackend(task.backend);
          if (!canBindTaskToBackend(backend.capabilities)) {
            taskErrors.push({
              taskId,
              code: 'backend_ineligible',
              message: 'backend does not support MCP',
            });
            continue;
          }
        }

        if (taskErrors.length > 0) {
          return {
            ok: false,
            reason: JSON.stringify({
              code: 'release_validation_failed',
              message: 'release_tasks validation failed; no tasks released',
              taskErrors,
              retryable: false,
            }),
          };
        }

        const turnIds: string[] = [];
        for (const taskId of members) {
          const task = draft.tasks[taskId]!;
          if (task.releaseState === 'released' && task.releaseAttemptId === command.opId) {
            // Already released under this attempt — leave existing first-turn.
            const existing = turnsForTask(draft, taskId).find((t) => t.sequence === 1);
            if (existing) turnIds.push(existing.id);
            continue;
          }

          draft.tasks[taskId] = {
            ...task,
            releaseState: 'released',
            releasedAt: now,
            releaseAttemptId: command.opId,
            revision: task.revision + 1,
            updatedAt: now,
          };

          const existingTurns = turnsForTask(draft, taskId);
          if (existingTurns.length === 0) {
            const turnId = deriveEntityId(ctx.turnId, `${command.opId}:${taskId}`, 'turn');
            const turnCheck = canCreateTurn(draft, taskId, limits);
            if (!turnCheck.ok) {
              return { ok: false, reason: turnCheck.reason };
            }
            const messageId = randomUUID();
            draft.messages[messageId] = {
              id: messageId,
              taskId,
              role: 'user',
              content: task.goal,
              state: 'assigned',
              createdAt: now,
              turnId,
            };
            const started = transitionStartTask(draft.tasks[taskId]!, [], {
              turnId,
              now,
              inputs: [{ kind: 'message', messageId }],
              trigger: 'engine',
            });
            if (!started.ok) return started;
            draft.turns[turnId] = started.next;
            turnIds.push(turnId);
          } else {
            const first = existingTurns.find((t) => t.sequence === 1) ?? existingTurns[0]!;
            turnIds.push(first.id);
          }
        }

        let waitTaskIds: string[] | undefined;
        let waitMetadata:
          | { addedTaskIds: string[]; alreadyStaged: boolean; waitTaskIds: string[] }
          | undefined;
        if (command.waitForTaskIds && command.waitForTaskIds.length > 0) {
          // Exact subset: each id must be in the release set OR already an owned released child.
          for (const waitId of command.waitForTaskIds) {
            const task = draft.tasks[waitId];
            if (!task || task.parentId !== ctx.callerTaskId) {
              return {
                ok: false,
                reason: JSON.stringify({
                  code: 'wait_not_owned',
                  message: `waitForTaskIds target not owned direct child: ${waitId}`,
                }),
              };
            }
            const inRelease = resolved.has(waitId);
            const alreadyReleased = task.releaseState === 'released';
            if (!inRelease && !alreadyReleased) {
              return {
                ok: false,
                reason: JSON.stringify({
                  code: 'wait_not_released',
                  message: `waitForTaskIds target not in release set and not already released: ${waitId}`,
                }),
              };
            }
          }
          waitTaskIds = [...command.waitForTaskIds];
          const waitStaged = stageCompoundWait(draft, ctx, command.opId, waitTaskIds, limits);
          if (!waitStaged.ok) return waitStaged;
          waitMetadata = waitStaged;
        }

        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: {
            taskIds: members,
            turnIds,
            ...(waitMetadata
              ? {
                  waitStaged: true,
                  staged: true,
                  alreadyStaged: waitMetadata.alreadyStaged,
                  waitTaskIds: waitMetadata.waitTaskIds,
                  nextAction: 'end_current_turn',
                  doNotPoll: true,
                }
              : {}),
          },
        });
        scheduledTurnIds.push(...turnIds);
        return { ok: true };
      });

      if (!commit.ok) {
        // Prefer structured JSON error when present.
        return { ok: false, error: commit.error };
      }
      for (const turnId of scheduledTurnIds) {
        deps.onScheduleTurn(turnId);
      }
      const ledger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      return { ok: true, result: ledger?.result.data };
    }

    case 'continue_child': {
      if (deps.isWorkspaceTrusted && !deps.isWorkspaceTrusted()) {
        return {
          ok: false,
          error: JSON.stringify({
            code: 'workspace_untrusted',
            message: 'workspace is not trusted; cannot continue child',
            retryable: true,
          }),
        };
      }
      const scheduleIds: string[] = [];
      const commit = await executeGraphCommand(deps, 'continueChildTask', (draft) => {
        ensureCoordinationMaps(draft);
        const prior = readLedger(draft, ctx.turnId, command.opId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            return { ok: false, reason: 'opId conflict: different arguments' };
          }
          return { ok: true };
        }
        const child = draft.tasks[command.childId];
        if (!child || child.parentId !== ctx.callerTaskId) {
          return { ok: false, reason: 'not an owned direct child' };
        }
        const live = turnsForTask(draft, child.id).find(
          (t) => t.status === 'running' || t.status === 'waiting_user',
        );
        if (live) {
          return { ok: false, reason: 'child has a live turn; continue_child rejects live children' };
        }
        if (
          child.pendingParentQuestion &&
          child.pendingParentQuestion.answers === undefined &&
          !child.pendingParentQuestion.continuationTurnId
        ) {
          return {
            ok: false,
            reason: 'child is awaiting parent answer; only answer_child_question or cancel may advance',
          };
        }
        let working = child;
        if (isTerminalLifecycle(child.lifecycle)) {
          const reopened = reopenTask(child, { now });
          if (!reopened.ok) return reopened;
          working = reopened.next;
          draft.tasks[child.id] = working;
        } else if (child.lifecycle !== 'open') {
          return { ok: false, reason: `child lifecycle is ${child.lifecycle}` };
        }
        const contTurnId = deriveEntityId(ctx.turnId, command.opId, 'turn');
        const turnCap = canCreateTurn(draft, child.id, limits);
        if (!turnCap.ok) return turnCap;
        const messageId = randomUUID();
        draft.messages[messageId] = {
          id: messageId,
          taskId: child.id,
          role: 'user',
          content: command.instruction,
          state: 'assigned',
          createdAt: now,
          turnId: contTurnId,
        };
        const existingTurns = turnsForTask(draft, child.id);
        const cont =
          existingTurns.length === 0
            ? transitionStartTask(working, existingTurns, {
                turnId: contTurnId,
                now,
                inputs: [{ kind: 'message', messageId }],
                trigger: 'engine',
              })
            : transitionContinueTask(working, existingTurns, {
                turnId: contTurnId,
                now,
                inputs: [{ kind: 'message', messageId }],
                trigger: 'engine',
              });
        if (!cont.ok) return cont;
        draft.turns[contTurnId] = cont.next;
        scheduleIds.push(contTurnId);
        let waitMetadata:
          | { addedTaskIds: string[]; alreadyStaged: boolean; waitTaskIds: string[] }
          | undefined;
        if (command.waitForCompletion === true) {
          const waitStaged = stageCompoundWait(draft, ctx, command.opId, [child.id], limits);
          if (!waitStaged.ok) return waitStaged;
          waitMetadata = waitStaged;
        }
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: {
            childId: child.id,
            turnId: contTurnId,
            ...(waitMetadata
              ? {
                  waitStaged: true,
                  staged: true,
                  alreadyStaged: waitMetadata.alreadyStaged,
                  waitTaskIds: waitMetadata.waitTaskIds,
                  nextAction: 'end_current_turn',
                  doNotPoll: true,
                }
              : {}),
          },
        });
        return { ok: true };
      }, { hydrateFullTurnsForTaskIds: [command.childId] });
      if (!commit.ok) {
        return { ok: false, error: commit.error };
      }
      for (const id of scheduleIds) {
        deps.onScheduleTurn(id);
      }
      const ledger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      return { ok: true, result: ledger?.result.data };
    }

    case 'cancel_tasks': {
      // All-or-nothing ownership validation. The complete descendant set,
      // remote cancel requests, terminal state and parent ledger are published
      // by one repository transaction.
      const file = deps.store.getFile();
      for (const childId of command.childIds) {
        const child = file.tasks[childId];
        if (!child || child.parentId !== ctx.callerTaskId) {
          return {
            ok: false,
            error: JSON.stringify({
              code: 'not_owned',
              message: `not an owned direct child: ${childId}`,
            }),
          };
        }
      }
      const cancelled = [...command.childIds];
      const localLiveIds: string[] = [];
      const mutation = await executeGraphCommand(deps, 'cancelChildTasks', (draft) => {
        const coordinatorSeal = {
          kind: 'coordinator' as const,
          taskId: ctx.callerTaskId,
          turnId: ctx.turnId,
          mode: 'cancel_task',
        };
        const ids = [...new Set(command.childIds.flatMap((id) => [id, ...descendantIds(draft, id)]))].reverse();
        for (const taskId of ids) {
          const task = draft.tasks[taskId];
          if (!task || isTerminalLifecycle(task.lifecycle)) continue;
          const currentPending = turnsForTask(draft, taskId).filter(
            (turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user',
          );
          const currentLive = currentPending.find(
            (turn) => turn.status === 'running' || turn.status === 'waiting_user',
          );
          const remoteOwned = !!currentLive && deps.leaseOwnerAlive(currentLive.id) && !deps.ownsLease(currentLive.id);
          if (currentLive && remoteOwned) {
            draft.cancelRequests = draft.cancelRequests ?? {};
            draft.cancelRequests[currentLive.id] = {
              kind: 'cancel', by: ctx.callerTaskId, opId: command.opId, at: now,
              sealedBy: coordinatorSeal,
            };
            continue;
          }
          if (currentLive) localLiveIds.push(currentLive.id);
          const next = transitionCancelTask(task, { liveTurn: currentLive, now, sealedBy: coordinatorSeal });
          if (!next.ok) return next;
          draft.tasks[taskId] = clearPendingParentQuestionOnCancel(draft, next.next.task, now);
          if (next.next.turn) draft.turns[next.next.turn.id] = next.next.turn;
          for (const pending of currentPending) {
            if (pending.id === currentLive?.id) continue;
            const settled = cancelPendingTurn(pending, { now });
            if (!settled.ok) return settled;
            draft.turns[pending.id] = settled.next;
          }
        }
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: { cancelled },
        });
        return { ok: true };
      });
      if (!mutation.ok) return { ok: false, error: mutation.error };
      for (const turnId of localLiveIds) {
        deps.liveRuns.get(turnId)?.controller.abort();
        cleanupTurnResources(deps, turnId);
      }
      deps.onRescanSchedulableTurns?.();
      return { ok: true, result: { cancelled } };
    }

    case 'interrupt_task':
    case 'cancel_task': {
      const child = deps.store.getFile().tasks[command.childId];
      if (!child || child.parentId !== ctx.callerTaskId) {
        return { ok: false, error: 'not an owned direct child' };
      }
      const liveTurn = turnsForTask(deps.store.getFile(), command.childId).find(
        (t) => t.status === 'running' || t.status === 'waiting_user',
      );
      const remoteLeased =
        liveTurn &&
        deps.leaseOwnerAlive(liveTurn.id) &&
        !deps.ownsLease(liveTurn.id);

      // interrupt only: remote early-return (no subtree). cancel always cascades.
      if (command.kind === 'interrupt_task') {
        if (remoteLeased) {
          const result: OpResult = { ok: true, data: { requested: true } };
          const requested = await executeGraphCommand(deps, 'interruptChildTask', (draft) => {
            draft.cancelRequests = draft.cancelRequests ?? {};
            draft.cancelRequests[liveTurn!.id] = {
              kind: 'interrupt', by: ctx.callerTaskId, opId: command.opId, at: now,
            };
            writeLedger(draft, ctx.turnId, command.opId, fingerprint, result);
            return { ok: true };
          });
          if (!requested.ok) return { ok: false, error: requested.error };
          return { ok: true, result: result.data };
        }
        const interrupted = await executeGraphCommand(deps, 'interruptChildTask', (draft) => {
          const turn = liveTurn ? draft.turns[liveTurn.id] : undefined;
          if (turn) {
            const interrupted = interruptTurn(turn, { now });
            if (!interrupted.ok) return interrupted;
            draft.turns[turn.id] = interrupted.next;
            holdQueuedFollowUpsOnFailure(draft, turn.taskId);
          }
          writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
            ok: true,
            data: { interrupted: true },
          });
          return { ok: true };
        });
        if (!interrupted.ok) return { ok: false, error: interrupted.error };
        if (liveTurn) {
          deps.liveRuns.get(liveTurn.id)?.controller.abort();
          cleanupTurnResources(deps, liveTurn.id);
        }
        return { ok: true, result: { interrupted: true } };
      }

      const coordinatorSeal = {
        kind: 'coordinator' as const,
        taskId: ctx.callerTaskId,
        turnId: ctx.turnId,
        mode: 'cancel_task',
      };
      const localLiveIds: string[] = [];
      const mutation = await executeGraphCommand(deps, 'cancelChildTask', (draft) => {
        const ids = [command.childId, ...descendantIds(draft, command.childId)].reverse();
        for (const taskId of ids) {
          const task = draft.tasks[taskId];
          if (!task || isTerminalLifecycle(task.lifecycle)) continue;
          const currentPending = turnsForTask(draft, taskId).filter(
            (turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user',
          );
          const currentLive = currentPending.find(
            (turn) => turn.status === 'running' || turn.status === 'waiting_user',
          );
          if (currentLive && deps.leaseOwnerAlive(currentLive.id) && !deps.ownsLease(currentLive.id)) {
            // Remote owner will seal task + settle turns atomically via the
            // cancel consumer. The request itself is part of this transaction.
            draft.cancelRequests = draft.cancelRequests ?? {};
            draft.cancelRequests[currentLive.id] = {
              kind: 'cancel', by: ctx.callerTaskId, opId: command.opId, at: now,
              sealedBy: coordinatorSeal,
            };
            continue;
          }
          if (currentLive) localLiveIds.push(currentLive.id);
          const cancelled = transitionCancelTask(task, {
            liveTurn: currentLive,
            now,
            sealedBy: coordinatorSeal,
          });
          if (!cancelled.ok) return cancelled;
          draft.tasks[taskId] = clearPendingParentQuestionOnCancel(
            draft,
            cancelled.next.task,
            now,
          );
          if (cancelled.next.turn) draft.turns[cancelled.next.turn.id] = cancelled.next.turn;
          for (const pending of currentPending) {
            if (pending.id === currentLive?.id) continue;
            const settled = cancelPendingTurn(pending, { now });
            if (!settled.ok) return settled;
            draft.turns[pending.id] = settled.next;
          }
        }
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: { cancelled: command.childId },
        });
        return { ok: true };
      });
      if (!mutation.ok) return { ok: false, error: mutation.error };
      for (const turnId of localLiveIds) {
        deps.liveRuns.get(turnId)?.controller.abort();
        cleanupTurnResources(deps, turnId);
      }
      // Full rescan: dependents outside the cancelled subtree may now be ready.
      deps.onRescanSchedulableTurns?.();
      return { ok: true, result: { cancelled: command.childId } };
    }

    case 'set_task_lifecycle': {
      const file = deps.store.getFile();
      const target = file.tasks[command.taskId];
      if (!target || target.parentId !== ctx.callerTaskId) {
        return { ok: false, error: 'not an owned direct child' };
      }
      if (command.taskId === ctx.callerTaskId) {
        return { ok: false, error: 'cannot seal self' };
      }
      const rootId = findRootId(file, ctx.callerTaskId);
      const rootPolicy = file.tasks[rootId]?.childOrchestrationSeal;
      if (!mayParentSealDirect(target, rootPolicy)) {
        return {
          ok: false,
          error: 'parent seal rejected: root childOrchestrationSeal is propose_only',
        };
      }

      const coordinatorSeal = {
        kind: 'coordinator' as const,
        taskId: ctx.callerTaskId,
        turnId: ctx.turnId,
        mode: 'parent_seal',
      };

      if (command.lifecycle === 'cancelled' || command.lifecycle === 'skipped') {
        // Match cancel_task: remote-owned live → cancel request only (defer seal).
        // Compatibility re-checked inside commit on the direct target.
        const ids = [command.taskId, ...descendantIds(file, command.taskId)].reverse();
        const liveToCleanup: string[] = [];
        let noop = false;
        const cascade = await executeGraphCommand(deps, 'setChildTaskLifecycle', (draft) => {
          const direct = draft.tasks[command.taskId];
          if (!direct) return { ok: false, reason: 'task not found' };
          const probe = transitionSetTaskLifecycle(direct, command.lifecycle, {
            now,
            reason: command.reason,
            sealedBy: coordinatorSeal,
          });
          if (!probe.ok) return probe;
          if (probe.next === direct) {
            noop = true;
            writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
              ok: true,
              data: { lifecycle: command.lifecycle, taskId: command.taskId, noop: true },
            });
            return { ok: true };
          }

          for (const taskId of ids) {
            const task = draft.tasks[taskId];
            if (!task || isTerminalLifecycle(task.lifecycle)) continue;
            const currentPending = turnsForTask(draft, taskId).filter(
              (t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user',
            );
            const currentLive = currentPending.find(
              (t) => t.status === 'running' || t.status === 'waiting_user',
            );
            const remoteOwned =
              !!currentLive &&
              deps.leaseOwnerAlive(currentLive.id) &&
              !deps.ownsLease(currentLive.id);
            if (command.lifecycle === 'cancelled' && currentLive && remoteOwned) {
              // Defer seal to processCancelRequests (cancel_task pattern).
              // Always include reason (may be undefined) so parent_seal clears stale reasons.
              draft.cancelRequests = draft.cancelRequests ?? {};
              draft.cancelRequests[currentLive.id] = {
                kind: 'cancel',
                by: ctx.callerTaskId,
                opId: command.opId,
                at: now,
                sealedBy: coordinatorSeal,
                reason: command.reason,
              };
              continue;
            }
            if (command.lifecycle === 'cancelled') {
              const cancelled = transitionCancelTask(task, {
                liveTurn: currentLive,
                now,
                sealedBy: coordinatorSeal,
              });
              if (!cancelled.ok) return cancelled;
              draft.tasks[taskId] = clearPendingParentQuestionOnCancel(
                draft,
                { ...cancelled.next.task, reason: command.reason },
                now,
              );
              if (cancelled.next.turn) draft.turns[cancelled.next.turn.id] = cancelled.next.turn;
              for (const pending of currentPending) {
                if (pending.id === currentLive?.id) continue;
                const settled = cancelPendingTurn(pending, { now });
                if (!settled.ok) return settled;
                draft.turns[pending.id] = settled.next;
              }
              if (currentLive) liveToCleanup.push(currentLive.id);
            } else {
              // skipped: always seal task locally (host skip pattern); remote live only interrupted.
              const sealed = transitionSetTaskLifecycle(task, 'skipped', {
                now,
                reason: command.reason,
                sealedBy: coordinatorSeal,
              });
              if (!sealed.ok) return sealed;
              draft.tasks[taskId] = sealed.next;
              if (currentLive && remoteOwned) {
                draft.cancelRequests = draft.cancelRequests ?? {};
                draft.cancelRequests[currentLive.id] = {
                  kind: 'interrupt',
                  by: ctx.callerTaskId,
                  opId: command.opId,
                  at: now,
                  sealedBy: coordinatorSeal,
                };
              }
              for (const pending of currentPending) {
                if (currentLive && remoteOwned && pending.id === currentLive.id) continue;
                if (pending.status === 'queued') {
                  const settled = cancelPendingTurn(pending, { now });
                  if (!settled.ok) return settled;
                  draft.turns[pending.id] = settled.next;
                } else {
                  const interrupted = interruptTurn(pending, { now });
                  if (!interrupted.ok) return interrupted;
                  draft.turns[pending.id] = interrupted.next;
                }
              }
              if (currentLive && !remoteOwned) liveToCleanup.push(currentLive.id);
            }
          }
          writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
            ok: true,
            data: { lifecycle: command.lifecycle, taskId: command.taskId },
          });
          return { ok: true };
        });
        if (!cascade.ok) {
          return { ok: false, error: cascade.error };
        }
        if (!noop) {
          for (const turnId of liveToCleanup) {
            deps.liveRuns.get(turnId)?.controller.abort();
            cleanupTurnResources(deps, turnId);
          }
          deps.onRescanSchedulableTurns?.();
        }
        return {
          ok: true,
          result: {
            lifecycle: command.lifecycle,
            taskId: command.taskId,
            ...(noop ? { noop: true } : {}),
          },
        };
      }

      // succeeded | failed — seal target only (no grandchild cascade)
      let sealChanged = false;
      let liveIdToCleanup: string | undefined;
      const commit = await executeGraphCommand(deps, 'setChildTaskLifecycle', (draft) => {
        const task = draft.tasks[command.taskId];
        if (!task) return { ok: false, reason: 'task not found' };
        const sealed = transitionSetTaskLifecycle(task, command.lifecycle, {
          now,
          result: command.result,
          error: command.error,
          sealedBy: coordinatorSeal,
        });
        if (!sealed.ok) return sealed;
        sealChanged = sealed.next !== task;
        draft.tasks[command.taskId] = sealed.next;
        if (sealChanged) {
          const currentPending = turnsForTask(draft, command.taskId).filter(
            (t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user',
          );
          const live = currentPending.find(
            (t) => t.status === 'running' || t.status === 'waiting_user',
          );
          const remoteOwned =
            !!live && deps.leaseOwnerAlive(live.id) && !deps.ownsLease(live.id);
          if (live && remoteOwned) {
            draft.cancelRequests = draft.cancelRequests ?? {};
            draft.cancelRequests[live.id] = {
              kind: 'interrupt',
              by: ctx.callerTaskId,
              opId: command.opId,
              at: now,
              sealedBy: coordinatorSeal,
            };
          } else if (live) {
            liveIdToCleanup = live.id;
          }
          for (const p of currentPending) {
            if (live && remoteOwned && p.id === live.id) continue;
            if (p.status === 'queued') {
              const cancelled = cancelPendingTurn(p, { now });
              if (cancelled.ok) draft.turns[p.id] = cancelled.next;
            } else {
              const interrupted = interruptTurn(p, { now });
              if (interrupted.ok) draft.turns[p.id] = interrupted.next;
            }
          }
        }
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: {
            lifecycle: command.lifecycle,
            taskId: command.taskId,
            ...(sealChanged ? {} : { noop: true }),
          },
        });
        return { ok: true };
      });
      if (!commit.ok) {
        return { ok: false, error: commit.error };
      }
      if (sealChanged && liveIdToCleanup) {
        deps.liveRuns.get(liveIdToCleanup)?.controller.abort();
        cleanupTurnResources(deps, liveIdToCleanup);
      }
      if (sealChanged) deps.onRescanSchedulableTurns?.();
      return {
        ok: true,
        result: {
          lifecycle: command.lifecycle,
          taskId: command.taskId,
          ...(sealChanged ? {} : { noop: true }),
        },
      };
    }

    case 'wait_for_tasks': {
      const owned = command.taskIds.every((id) => draftChildOwned(deps.store.getFile(), ctx.callerTaskId, id));
      if (!owned) return { ok: false, error: 'taskIds must be owned direct children' };
      const staged = await executeGraphCommand(deps, 'waitForChildTasks', (draft) => {
        const turn = draft.turns[ctx.turnId];
        if (!turn) return { ok: false, reason: 'turn not found' };
        const result = mergeWaitDisposition(turn, command.taskIds);
        if (!result.ok) return result;
        draft.turns[ctx.turnId] = result.next.turn;
        const data = {
          staged: true,
          alreadyStaged: result.next.alreadyStaged,
          waitTaskIds: result.next.waitTaskIds,
          nextAction: 'end_current_turn',
          doNotPoll: true,
        };
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data,
        });
        return { ok: true };
      });
      if (!staged.ok) return { ok: false, error: staged.error };
      const ledger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      return { ok: true, result: ledger?.result.data };
    }

    case 'complete_task': {
      // Normalize the (untrusted) worker verdict here where the engine clock lives, so
      // `verdict.at` is deterministic per staging and the command fingerprint (parsed
      // upstream, timeless) stays stable across idempotent retries. Absent → no verdict.
      const verdict = normalizeVerdict(command.verdict, { at: now, source: 'worker' });
      const staged = await executeGraphCommand(deps, 'completeGraphTask', (draft) => {
        const turn = draft.turns[ctx.turnId];
        if (!turn) return { ok: false, reason: 'turn not found' };
        const result = stageDisposition(
          turn,
          { kind: 'complete', result: command.result, ...(verdict ? { verdict } : {}) },
          command.opId,
          {
            limits: { maxResult: limits.maxResultBytes, maxError: limits.maxErrorBytes },
          },
        );
        if (!result.ok) return result;
        draft.turns[ctx.turnId] = result.next.turn;
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, { ok: true, data: { staged: true } });
        return { ok: true };
      });
      if (!staged.ok) return { ok: false, error: staged.error };
      return { ok: true, result: { staged: true } };
    }

    case 'fail_task': {
      const staged = await executeGraphCommand(deps, 'failGraphTask', (draft) => {
        const turn = draft.turns[ctx.turnId];
        if (!turn) return { ok: false, reason: 'turn not found' };
        const result = stageDisposition(turn, { kind: 'fail', error: command.error }, command.opId, {
          limits: { maxResult: limits.maxResultBytes, maxError: limits.maxErrorBytes },
        });
        if (!result.ok) return result;
        draft.turns[ctx.turnId] = result.next.turn;
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, { ok: true, data: { staged: true } });
        return { ok: true };
      });
      if (!staged.ok) return { ok: false, error: staged.error };
      return { ok: true, result: { staged: true } };
    }

    case 'report_progress':
      return { ok: true, result: { noted: command.note.slice(0, 512) } };

    case 'get_task_status': {
      const targetId = command.taskId ?? ctx.callerTaskId;
      const file = deps.store.getFile();
      const task = file.tasks[targetId];
      if (!task) return { ok: false, error: 'task not found' };
      if (targetId !== ctx.callerTaskId && !isDescendantOf(file, ctx.callerTaskId, targetId)) {
        return { ok: false, error: 'unauthorized subtree' };
      }
      const nodes = [targetId, ...descendantIds(file, targetId)].map((id) => {
        const t = file.tasks[id];
        if (!t) return undefined;
        const readiness = evaluateTaskReadiness(file, id);
        return {
          id: t.id,
          lifecycle: t.lifecycle,
          releaseState: t.releaseState,
          goal: t.goal.slice(0, 128),
          parentId: t.parentId,
          attention: t.attention,
          resultSummary: t.taskResult?.summary,
          readiness: {
            code: readiness.code,
            schedulable: readiness.schedulable,
            reasons: readiness.reasons,
          },
        };
      }).filter((n): n is NonNullable<typeof n> => n !== undefined);
      const callerTurn = file.turns[ctx.turnId];
      const callerWait = callerTurn?.disposition?.kind === 'wait_tasks'
        ? callerTurn.disposition
        : undefined;
      return {
        ok: true,
        result: {
          root: targetId,
          tasks: nodes.slice(0, 32),
          ...(callerWait
            ? {
                callerWaitStaged: true,
                waitTaskIds: callerWait.taskIds,
                nextAction: 'end_current_turn',
                doNotPoll: true,
              }
            : {}),
        },
      };
    }

    case 'get_host_context': {
      // Read-only: no opId, no ledger. Same builder as first-turn host inject.
      const file = deps.store.getFile();
      const task = file.tasks[ctx.callerTaskId];
      if (!task) return { ok: false, error: 'task not found' };
      const trusted = deps.isWorkspaceTrusted?.() ?? true;
      const cached = deps.getHostEnvironment?.();
      const cwd =
        (task.cwd && task.cwd.length > 0 ? task.cwd : undefined) ??
        cached?.cwd ??
        deps.workspaceFolder ??
        process.cwd();
      const snapshot: HostEnvironmentSnapshot = cached
        ? { ...cached, cwd, trusted }
        : minimalHostSnapshot(cwd, trusted);
      const tools = [...capabilitiesFor(task)].sort();
      const registryResult: TaskTypeRegistryResult = deps.getTaskTypeRegistry
        ? deps.getTaskTypeRegistry(cwd)
        : parseTaskTypeRegistry(undefined);
      // Snapshot present (even empty backends) ⇒ scanned; missing cache ⇒ unknown.
      const scanned = cached !== undefined;
      const available = new Set(snapshot.availableBackends ?? []);
      const { taskTypes, diagnostics } = summarizeTaskTypes(registryResult, (backend) => {
        if (!scanned) return 'unknown';
        return available.has(backend) ? 'available' : 'unavailable';
      });
      const host = buildHostContext({
        snapshot,
        self: {
          taskId: task.id,
          role: task.role,
          backend: task.backend,
          ...(task.model !== undefined ? { model: task.model } : {}),
          ...(task.parentId ? { parentTaskId: task.parentId } : {}),
          ...(task.goal ? { goal: task.goal } : {}),
        },
        tools,
        taskCwd: task.cwd,
        // Coordinators always get taskTypes array (empty = configure guidance).
        // suppressBackendCatalog omitted → keep diagnostic backends/models.
        ...(task.role === 'coordinator' ? { taskTypes } : {}),
      });
      return {
        ok: true,
        result: {
          ...host,
          taskTypes,
          ...(diagnostics.length > 0 ? { taskTypeDiagnostics: diagnostics } : {}),
        },
      };
    }

    case 'list_task_types': {
      // Read-only: no opId, no ledger. Live registry for coordinator create_child.
      const file = deps.store.getFile();
      const task = file.tasks[ctx.callerTaskId];
      if (!task) return { ok: false, error: 'task not found' };
      const cwd =
        (task.cwd && task.cwd.length > 0 ? task.cwd : undefined) ??
        deps.getHostEnvironment?.()?.cwd ??
        deps.workspaceFolder ??
        process.cwd();
      const registryResult: TaskTypeRegistryResult = deps.getTaskTypeRegistry
        ? deps.getTaskTypeRegistry(cwd)
        : parseTaskTypeRegistry(undefined);
      const hostEnv = deps.getHostEnvironment?.();
      const scanned = hostEnv !== undefined;
      const available = new Set(hostEnv?.availableBackends ?? []);
      const summarized = summarizeTaskTypes(registryResult, (backend) => {
        if (!scanned) return 'unknown';
        return available.has(backend) ? 'available' : 'unavailable';
      });
      const diagnostics = [...summarized.diagnostics];
      for (const row of summarized.taskTypes) {
        if (row.availability !== 'unavailable') continue;
        if (diagnostics.length >= TASK_TYPE_DIAGNOSTIC_MAX) break;
        let message = `backend "${row.backend}" for type "${row.id}" not detected on PATH`;
        if (message.length > TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX) {
          message = `${message.slice(0, TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX - 1)}…`;
        }
        diagnostics.push({ code: 'backend_unavailable', message });
      }
      return {
        ok: true,
        result: { taskTypes: summarized.taskTypes, diagnostics },
      };
    }

    case 'upsert_presentation':
      // Presentation execution is composed by the host router (T04). The pure task
      // graph must remain VS Code-independent and fail closed if called directly.
      return { ok: false, error: 'panel_open_failed' };

    case 'ask_user':
      // Temporarily ignored: structured user questions go through ACP RFD
      // elicitation (and vendor extensions like Grok x.ai/ask_user_question).
      // Non-root must use ask_parent.
      return {
        ok: false,
        error:
          'ask_user MCP tool is disabled; use ACP elicitation/create (or ask_parent for children)',
      };

    case 'ask_parent': {
      const caller = deps.store.getFile().tasks[ctx.callerTaskId];
      if (!caller?.parentId) {
        return { ok: false, error: 'ask_parent is only valid on non-root tasks' };
      }
      if (!command.questions || command.questions.length === 0) {
        return { ok: false, error: 'questions required' };
      }
      const questionId = deriveEntityId(ctx.turnId, command.opId, 'q');
      // The parent-Q turn lands on the parent or the nearest open ancestor
      // coordinator; hydrate the whole ancestor chain so canCreateTurn counts
      // that task's full (possibly terminal) history, not the bounded subset.
      const askParentChain: string[] = [];
      {
        const seen = new Set<string>();
        let walk: string | null | undefined = caller.parentId;
        const tasks = deps.store.getFile().tasks;
        while (walk && !seen.has(walk)) {
          seen.add(walk);
          askParentChain.push(walk);
          walk = tasks[walk]?.parentId;
        }
      }
      const commit = await executeGraphCommand(deps, 'askParent', (draft) => {
        ensureCoordinationMaps(draft);
        const child = draft.tasks[ctx.callerTaskId];
        const parentId = child?.parentId;
        if (!child || !parentId) {
          return { ok: false, reason: 'caller has no parent' };
        }
        const parent = draft.tasks[parentId];
        if (!parent) {
          return { ok: false, reason: 'parent not found' };
        }
        const prior = readLedger(draft, ctx.turnId, command.opId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            return { ok: false, reason: 'opId conflict: different arguments' };
          }
          return { ok: true };
        }
        if (child.pendingParentQuestion && !child.pendingParentQuestion.answers) {
          return { ok: false, reason: 'already awaiting parent answer' };
        }
        const questions = command.questions.map((q) => ({
          prompt: q.prompt,
          ...(q.options ? { options: q.options } : {}),
          ...(q.allowFreeText !== undefined ? { allowFreeText: q.allowFreeText } : {}),
        }));
        // Release live slot: stage idle disposition so settle does not seal lifecycle;
        // host aborts process after tool returns (caller still in live turn).
        const liveTurn = draft.turns[ctx.turnId];
        if (liveTurn && (liveTurn.status === 'running' || liveTurn.status === 'waiting_user')) {
          draft.turns[ctx.turnId] = {
            ...liveTurn,
            disposition: liveTurn.disposition ?? { kind: 'idle' },
          };
        }
        draft.tasks[ctx.callerTaskId] = {
          ...child,
          pendingParentQuestion: {
            questionId,
            questions,
            askedAt: now,
            sourceTurnId: ctx.turnId,
          },
          attention: {
            code: 'awaiting_parent_answer',
            message: 'waiting for parent answers',
            at: now,
            sourceTurnId: ctx.turnId,
          },
          revision: child.revision + 1,
          updatedAt: now,
        };
        const inbound = { ...(parent.pendingChildQuestions ?? {}) };
        inbound[questionId] = {
          fromChildId: ctx.callerTaskId,
          questions,
          askedAt: now,
        };
        // Terminal parent: still record; host/UI can surface (plan ISSUE-3).
        let parentPatch: MusterTask = {
          ...parent,
          pendingChildQuestions: inbound,
          attention:
            parent.lifecycle === 'open'
              ? {
                  code: 'child_question',
                  message: `child ${ctx.callerTaskId} needs input`,
                  at: now,
                  sourceTurnId: ctx.turnId,
                }
              : parent.attention,
          revision: parent.revision + 1,
          updatedAt: now,
        };
        // Deliver question to an open parent (or nearest open ancestor coordinator).
        let deliverParentId = parentId;
        let deliverParent = parentPatch;
        if (deliverParent.lifecycle !== 'open') {
          let walk = deliverParent.parentId;
          const seen = new Set<string>();
          while (walk && !seen.has(walk)) {
            seen.add(walk);
            const anc = draft.tasks[walk];
            if (!anc) break;
            if (anc.lifecycle === 'open' && anc.role === 'coordinator') {
              deliverParentId = walk;
              deliverParent = {
                ...anc,
                pendingChildQuestions: {
                  ...(anc.pendingChildQuestions ?? {}),
                  [questionId]: {
                    fromChildId: ctx.callerTaskId,
                    questions,
                    askedAt: now,
                  },
                },
                attention: {
                  code: 'child_question',
                  message: `child ${ctx.callerTaskId} needs input`,
                  at: now,
                  sourceTurnId: ctx.turnId,
                },
                revision: anc.revision + 1,
                updatedAt: now,
              };
              break;
            }
            walk = anc.parentId;
          }
        }
        // Queue deterministic turn with Q payload (FIFO behind live/queued work).
        if (deliverParent.lifecycle === 'open') {
          const qTurnId = deriveEntityId(ctx.turnId, command.opId, 'parent-q');
          const turnCap = canCreateTurn(draft, deliverParentId, limits);
          if (turnCap.ok && !draft.turns[qTurnId]) {
            const messageId = randomUUID();
            const qLines = questions.map((q, i) => `Q${i + 1}: ${q.prompt}`).join('\n');
            draft.messages[messageId] = {
              id: messageId,
              taskId: deliverParentId,
              role: 'user',
              content:
                `Child ${ctx.callerTaskId} asks (questionId=${questionId}). ` +
                `Call answer_child_question with this questionId.\n${qLines}`,
              state: 'assigned',
              createdAt: now,
              turnId: qTurnId,
            };
            const cont = transitionContinueTask(
              deliverParent,
              turnsForTask(draft, deliverParentId),
              {
                turnId: qTurnId,
                now,
                inputs: [{ kind: 'message', messageId }],
                trigger: 'engine',
              },
            );
            if (cont.ok) {
              draft.turns[qTurnId] = cont.next;
            }
          }
        }
        draft.tasks[parentId] = parentPatch;
        if (deliverParentId !== parentId) {
          draft.tasks[deliverParentId] = deliverParent;
        }
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: { questionId, parentTaskId: parentId },
        });
        return { ok: true };
      }, { hydrateFullTurnsForTaskIds: askParentChain });
      if (!commit.ok) {
        return { ok: false, error: commit.error };
      }
      // Abort child live process to free concurrency (scheduler-safe).
      const childLive = turnsForTask(deps.store.getFile(), ctx.callerTaskId).find(
        (t) => t.status === 'running' || t.status === 'waiting_user',
      );
      if (childLive && deps.ownsLease(childLive.id)) {
        deps.liveRuns.get(childLive.id)?.controller.abort();
      }
      const parentQTurnId = deriveEntityId(ctx.turnId, command.opId, 'parent-q');
      if (deps.store.getFile().turns[parentQTurnId]?.status === 'queued') {
        deps.onScheduleTurn(parentQTurnId);
      }
      deps.onRescanSchedulableTurns?.();
      const ledger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      return { ok: true, result: ledger?.result.data };
    }

    case 'answer_child_question': {
      const scheduleIds: string[] = [];
      // The continuation turn lands on the child that asked; hydrate its full
      // turn history so canCreateTurn counts real slots, not the bounded subset.
      const answerChildId =
        deps.store.getFile().tasks[ctx.callerTaskId]?.pendingChildQuestions?.[command.questionId]
          ?.fromChildId;
      const commit = await executeGraphCommand(deps, 'answerChildQuestion', (draft) => {
        ensureCoordinationMaps(draft);
        const parent = draft.tasks[ctx.callerTaskId];
        if (!parent || parent.lifecycle !== 'open') {
          return { ok: false, reason: 'caller task not open' };
        }
        const prior = readLedger(draft, ctx.turnId, command.opId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            return { ok: false, reason: 'opId conflict: different arguments' };
          }
          return { ok: true };
        }
        const inbound = parent.pendingChildQuestions?.[command.questionId];
        if (!inbound) {
          return { ok: false, reason: 'unknown questionId' };
        }
        const child = draft.tasks[inbound.fromChildId];
        // Direct child OR ancestor answering a routed grandchild question.
        if (!child) {
          return { ok: false, reason: 'child not found' };
        }
        let owned = child.parentId === ctx.callerTaskId;
        if (!owned) {
          let walk = child.parentId;
          const seen = new Set<string>();
          while (walk && !seen.has(walk)) {
            seen.add(walk);
            if (walk === ctx.callerTaskId) {
              owned = true;
              break;
            }
            walk = draft.tasks[walk]?.parentId ?? null;
          }
        }
        if (!owned) {
          return { ok: false, reason: 'child not in caller subtree' };
        }
        const pending = child.pendingParentQuestion;
        if (!pending || pending.questionId !== command.questionId) {
          return { ok: false, reason: 'child has no matching pending question' };
        }
        if (pending.continuationTurnId && draft.turns[pending.continuationTurnId]) {
          // Idempotent: continuation already created.
          writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
            ok: true,
            data: { questionId: command.questionId, continuationTurnId: pending.continuationTurnId },
          });
          return { ok: true };
        }
        const continuationTurnId = deriveEntityId(ctx.turnId, command.opId, 'turn');
        const turnCap = canCreateTurn(draft, child.id, limits);
        if (!turnCap.ok) return turnCap;
        const messageId = randomUUID();
        const qText = pending.questions.map((q, i) => `Q${i + 1}: ${q.prompt}`).join('\n');
        const aText = command.answers.map((a, i) => `A${i + 1}: ${a}`).join('\n');
        draft.messages[messageId] = {
          id: messageId,
          taskId: child.id,
          role: 'user',
          content: `Parent answers for question ${command.questionId}:\n${qText}\n${aText}\nContinue the task and stage complete_task or fail_task.`,
          state: 'assigned',
          createdAt: now,
          turnId: continuationTurnId,
        };
        const contResult = transitionContinueTask(child, turnsForTask(draft, child.id), {
          turnId: continuationTurnId,
          now,
          inputs: [{ kind: 'message', messageId }],
          trigger: 'engine',
        });
        if (!contResult.ok) return contResult;
        draft.turns[continuationTurnId] = contResult.next;
        scheduleIds.push(continuationTurnId);

        draft.tasks[child.id] = {
          ...child,
          pendingParentQuestion: {
            ...pending,
            answers: command.answers,
            answeredAt: now,
            continuationTurnId,
          },
          attention: undefined,
          revision: child.revision + 1,
          updatedAt: now,
        };
        const nextInbound = { ...(parent.pendingChildQuestions ?? {}) };
        delete nextInbound[command.questionId];
        // Re-arm parent wait if attention-suspended with same membership.
        let wait = parent.wait;
        if (
          wait?.kind === 'children' &&
          wait.phase === 'suspended_attention' &&
          wait.attentionContinuationTurnId
        ) {
          wait = {
            ...wait,
            phase: 'active',
            attentionContinuationTurnId: undefined,
          };
        }
        draft.tasks[ctx.callerTaskId] = {
          ...parent,
          pendingChildQuestions: Object.keys(nextInbound).length > 0 ? nextInbound : undefined,
          attention:
            Object.keys(nextInbound).length > 0
              ? parent.attention
              : parent.attention?.code === 'child_question'
                ? undefined
                : parent.attention,
          wait,
          revision: parent.revision + 1,
          updatedAt: now,
        };
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: { questionId: command.questionId, continuationTurnId },
        });
        return { ok: true };
      }, answerChildId ? { hydrateFullTurnsForTaskIds: [answerChildId] } : {});
      if (!commit.ok) {
        return { ok: false, error: commit.error };
      }
      for (const id of scheduleIds) {
        deps.onScheduleTurn(id);
      }
      deps.onRescanSchedulableTurns?.();
      const ledger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      return { ok: true, result: ledger?.result.data };
    }

    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

function draftChildOwned(file: TaskStoreFile, parentId: string, childId: string): boolean {
  const child = file.tasks[childId];
  return child?.parentId === parentId;
}

export function tryPromoteTurn(
  store: TaskReadPort,
  turnId: string,
  limits: ResourceLimits,
): boolean {
  const file = store.getFile();
  const check = canPromoteTurn(file, turnId, limits);
  return check.ok;
}

export async function processCancelRequests(deps: GraphEngineDeps): Promise<void> {
  const requests = Object.entries(deps.store.getFile().cancelRequests ?? {});
  const now = nowIso(deps.clock);

  for (const [turnId, request] of requests) {
    const claim = deps.store.getFile().runtimeClaims?.[turnId];
    const ownerId = deps.runtimeOwnerId ?? claim?.ownerId;
    // Only the current runtime owner may consume a request. The owner fence is
    // re-checked inside the same IMMEDIATE transaction as settlement/deletion.
    if (!ownerId || !deps.ownsLease(turnId) || claim?.ownerId !== ownerId) continue;
    const localTurn = deps.store.getFile().turns[turnId];
    const expectedTasks = localTurn
      ? [{ id: localTurn.taskId, revision: deps.store.getFile().tasks[localTurn.taskId]?.revision ?? 0 }]
      : [];
    const expectedTurns = localTurn
      ? [{ id: turnId, status: localTurn.status, runtimeEpoch: localTurn.runtimeEpoch }]
      : [];
    const consumed = await executeGraphCommand(
      deps,
      'consumeCancelRequest',
      (draft) => {
        const currentRequest = draft.cancelRequests?.[turnId];
        const currentClaim = draft.runtimeClaims?.[turnId];
        if (!currentRequest || !currentClaim || currentClaim.ownerId !== ownerId) return { ok: true };
        const turn = draft.turns[turnId];
        if (turn) {
          if (currentRequest.kind === 'interrupt') {
            const interrupted = interruptTurn(turn, { now });
            if (interrupted.ok) {
              draft.turns[turnId] = interrupted.next;
              holdQueuedFollowUpsOnFailure(draft, turn.taskId);
            }
          } else {
            const task = draft.tasks[turn.taskId];
            if (task) {
              const pendingTurns = turnsForTask(draft, task.id).filter(
                (candidate) => candidate.status === 'queued' || candidate.status === 'running' || candidate.status === 'waiting_user',
              );
              const cancelled = transitionCancelTask(task, {
                liveTurn: turn,
                now,
                sealedBy:
                  currentRequest.sealedBy ??
                  (currentRequest.by === 'engine' || currentRequest.by === 'user'
                    ? { kind: 'user' }
                    : { kind: 'coordinator', taskId: currentRequest.by, mode: 'cancel_task' }),
              });
              if (cancelled.ok) {
                const isParentSeal = currentRequest.sealedBy?.kind === 'coordinator' && currentRequest.sealedBy.mode === 'parent_seal';
                const sealedTask = isParentSeal
                  ? { ...cancelled.next.task, reason: currentRequest.reason }
                  : cancelled.next.task;
                draft.tasks[task.id] = clearPendingParentQuestionOnCancel(draft, sealedTask, now);
                if (cancelled.next.turn) draft.turns[cancelled.next.turn.id] = cancelled.next.turn;
                for (const pending of pendingTurns) {
                  if (pending.id === turn.id) continue;
                  const settled = cancelPendingTurn(pending, { now });
                  if (settled.ok) draft.turns[pending.id] = settled.next;
                }
              }
            }
          }
        }
        delete draft.cancelRequests![turnId];
        pruneLedgerForTurn(draft, turnId);
        delete draft.runtimeClaims![turnId];
        return { ok: true };
      },
      {
        expectedTasks,
        expectedTurns,
        expectedRuntimeClaims: [{ turnId, ownerId }],
        expectedCancelRequests: [{ turnId, kind: request.kind, opId: request.opId }],
        deleteSessionClaimTurnIds: [turnId],
        deleteResourceClaimTurnIds: [turnId],
      },
    );
    if (!consumed.ok) continue;
    // Abort only after the durable consumer transaction wins its owner/request
    // fences; a remote replacement can therefore never be killed by a stale host.
    deps.liveRuns.get(turnId)?.controller.abort();
    cleanupTurnResources(deps, turnId);
  }
}

export function projectChildResults(
  taskIds: string[],
  file: TaskStoreFile,
  maxBytes: number = TASK_RESULT_MAX_BYTES,
): string {
  const header = '[child_results]';
  const parts: string[] = [header];
  let used = Buffer.byteLength(header, 'utf8');
  for (const id of taskIds) {
    const task = file.tasks[id];
    if (!task) continue;
    const pendingQ =
      task.pendingParentQuestion && !task.pendingParentQuestion.answers
        ? {
            questionId: task.pendingParentQuestion.questionId,
            questions: task.pendingParentQuestion.questions.slice(0, 8).map((q) => ({
              prompt: q.prompt.slice(0, 400),
            })),
          }
        : undefined;
    const entry = {
      id: task.id,
      lifecycle: task.lifecycle,
      result: task.taskResult?.summary.slice(0, 512),
      error: task.error?.slice(0, 256),
      attention: task.attention?.code,
      ...(pendingQ ? { pendingParentQuestion: pendingQ } : {}),
    };
    const line = JSON.stringify(entry);
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    const marker = TRUNCATED_CONTENT_MARKER.trimStart();
    const markerBytes = Buffer.byteLength(marker, 'utf8') + 1;
    if (used + lineBytes > maxBytes) {
      if (used + markerBytes <= maxBytes) {
        parts.push(marker);
      }
      break;
    }
    parts.push(line);
    used += lineBytes;
  }
  return parts.join('\n');
}
