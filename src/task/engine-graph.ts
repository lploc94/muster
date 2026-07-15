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
  clampExecutionPolicy,
  countChildren,
  countRootChildren,
  DEFAULT_RESOURCE_LIMITS,
  taskDepth,
  type ExecutionPolicyBounds,
  type ResourceLimits,
} from './limits';
import { evaluateTaskReadiness } from './readiness';
import { canPromoteTurn } from './scheduler';
import type { TaskStore } from './store';
import {
  createTask,
  cancelPendingTurn,
  holdQueuedFollowUpsOnFailure,
  interruptTurn,
  registerAsk,
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
  };
}

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((t) => t.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
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
const DEFAULT_POLICY: TaskExecutionPolicy = {
  maxTurns: 50,
  maxAutomaticRetries: 2,
  turnTimeoutMs: 300_000,
  taskTimeoutMs: 1_800_000,
};

export interface GraphEngineDeps {
  store: TaskStore;
  makeBackend: (name: string) => Backend;
  credentials: CredentialRegistry;
  askBridge: AskBridge;
  bridgePort: number;
  resourceLimits?: ResourceLimits;
  /** Bounds used to clamp agent-supplied execution policies. Defaults to DEFAULT_EXECUTION_POLICY_BOUNDS. */
  executionPolicyBounds?: ExecutionPolicyBounds;
  /** Independent hard cap on a bridge token's TTL. Defaults to MAX_BRIDGE_TOKEN_TTL_MS. */
  maxBridgeTokenTtlMs?: number;
  clock?: () => string;
  /** Active in-process runs keyed by turnId. Handles expose abort + live-input context. */
  liveRuns: Map<string, { controller: AbortController }>;
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
  return deps.credentials.issue({
    rootId,
    callerTaskId: task.id,
    turnId,
    allowedActions: actions,
    // Independent hard cap: even a large (clamped) turn timeout must not mint a
    // token that outlives MAX_BRIDGE_TOKEN_TTL_MS.
    ttlMs: bridgeTokenTtlMs(task.executionPolicy.turnTimeoutMs, deps.maxBridgeTokenTtlMs),
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
  return {
    options: {
      ...base,
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

  if (
    command.kind !== 'get_task_status' &&
    command.kind !== 'report_progress' &&
    command.kind !== 'get_host_context' &&
    command.kind !== 'list_task_types'
  ) {
    const existing = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
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

      const commit = deps.store.commit((draft) => {
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
          // Never trust the raw agent-supplied policy: clamp every field to bounds.
          executionPolicy: clampExecutionPolicy(
            DEFAULT_POLICY,
            command.spec.executionPolicy,
            deps.executionPolicyBounds,
          ),
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
          },
        };
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, result);
        return { ok: true };
      });

      if (!commit.ok) {
        return { ok: false, error: commit.detail ?? commit.reason };
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

      const commit = deps.store.commit((draft) => {
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
          for (const sib of spec.dependsOn ?? []) {
            const depId = idByLocal.get(sib)!;
            depMap.set(depId, { taskId: depId, requiredOutcome: 'succeeded', onUnsatisfied: 'block' });
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
                onUnsatisfied: 'block',
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
            executionPolicy: clampExecutionPolicy(
              DEFAULT_POLICY,
              spec.executionPolicy,
              deps.executionPolicyBounds,
            ),
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

        const result: OpResult = {
          ok: true,
          data: {
            taskIds: orderedTaskIds,
            turnIds: isDelegate ? orderedTurnIds : [],
          },
        };
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, result);
        return { ok: true };
      });

      if (!commit.ok) {
        return { ok: false, error: commit.detail ?? commit.reason };
      }

      const batchLedger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      const ledgerData = batchLedger?.result.data as
        | { taskIds?: string[]; turnIds?: string[] }
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
      const commit = deps.store.commit((draft) => {
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
          const releaseState = task.releaseState ?? 'draft';
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
          if ((task.releaseState ?? 'draft') === 'released' && task.releaseAttemptId === command.opId) {
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

        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: { taskIds: members, turnIds },
        });
        scheduledTurnIds.push(...turnIds);
        return { ok: true };
      });

      if (!commit.ok) {
        // Prefer structured JSON error when present.
        const detail = commit.detail ?? commit.reason;
        return { ok: false, error: detail };
      }
      for (const turnId of scheduledTurnIds) {
        deps.onScheduleTurn(turnId);
      }
      const ledger = deps.store.getFile().operations?.[opLedgerKey(ctx.turnId, command.opId)];
      return { ok: true, result: ledger?.result.data };
    }

    case 'start_task': {
      // Host recovery may still call engine.startTask; coordinator MCP must not
      // bypass release (capability map also omits start_task for create_child).
      const commit = deps.store.commit((draft) => {
        ensureCoordinationMaps(draft);
        const child = draft.tasks[command.childId];
        if (!child || child.parentId !== ctx.callerTaskId) {
          return { ok: false, reason: 'not an owned direct child' };
        }
        if ((child.releaseState ?? 'draft') === 'draft') {
          return { ok: false, reason: 'task not released; use release_tasks' };
        }
        const turnId = deriveEntityId(ctx.turnId, command.opId, 'turn');
        if (draft.turns[turnId]) {
          const ledger = readLedger(draft, ctx.turnId, command.opId);
          if (ledger) return { ok: true };
          return { ok: false, reason: 'turn id collision' };
        }
        const turnCheck = canCreateTurn(draft, child.id, limits);
        if (!turnCheck.ok) return turnCheck;
        const messageId = randomUUID();
        draft.messages[messageId] = {
          id: messageId,
          taskId: child.id,
          role: 'user',
          content: child.goal,
          state: 'assigned',
          createdAt: now,
          turnId,
        };
        const started = transitionStartTask(child, turnsForTask(draft, child.id), {
          turnId,
          now,
          inputs: [{ kind: 'message', messageId }],
          trigger: 'engine',
        });
        if (!started.ok) return started;
        draft.turns[turnId] = started.next;
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: { turnId },
        });
        return { ok: true };
      });
      if (!commit.ok) return { ok: false, error: commit.detail ?? commit.reason };
      const turnId = deriveEntityId(ctx.turnId, command.opId, 'turn');
      deps.onScheduleTurn(turnId);
      return { ok: true, result: { turnId } };
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
          deps.writeCancelRequest(liveTurn!.id, 'interrupt', ctx.callerTaskId, command.opId);
          const result: OpResult = { ok: true, data: { requested: true } };
          deps.store.commit((draft) => {
            writeLedger(draft, ctx.turnId, command.opId, fingerprint, result);
            return { ok: true };
          });
          return { ok: true, result: result.data };
        }
        if (liveTurn && deps.ownsLease(liveTurn.id)) {
          deps.liveRuns.get(liveTurn.id)?.controller.abort();
        }
        const commit = deps.store.commit((draft) => {
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
        if (!commit.ok) return { ok: false, error: commit.detail ?? commit.reason };
        if (liveTurn) cleanupTurnResources(deps, liveTurn.id);
        return { ok: true, result: { interrupted: true } };
      }

      const coordinatorSeal = {
        kind: 'coordinator' as const,
        taskId: ctx.callerTaskId,
        turnId: ctx.turnId,
        mode: 'cancel_task',
      };
      const ids = [command.childId, ...descendantIds(deps.store.getFile(), command.childId)].reverse();
      for (const taskId of ids) {
        const pendingTurns = turnsForTask(deps.store.getFile(), taskId).filter(
          (t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user',
        );
        const lt = pendingTurns.find(
          (t) => t.status === 'running' || t.status === 'waiting_user',
        );
        if (lt && deps.leaseOwnerAlive(lt.id) && !deps.ownsLease(lt.id)) {
          // Remote owner will seal task + settle turns atomically via processCancelRequests.
          deps.writeCancelRequest(lt.id, 'cancel', ctx.callerTaskId, command.opId, coordinatorSeal);
          continue;
        }
        if (lt && deps.ownsLease(lt.id)) deps.liveRuns.get(lt.id)?.controller.abort();
        deps.store.commit((draft) => {
          const task = draft.tasks[taskId];
          if (!task || isTerminalLifecycle(task.lifecycle)) return { ok: true };
          const currentPending = turnsForTask(draft, taskId).filter(
            (t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user',
          );
          const currentLive = currentPending.find(
            (t) => t.status === 'running' || t.status === 'waiting_user',
          );
          const cancelled = transitionCancelTask(task, {
            liveTurn: currentLive,
            now,
            sealedBy: coordinatorSeal,
          });
          if (!cancelled.ok) return cancelled;
          draft.tasks[taskId] = cancelled.next.task;
          if (cancelled.next.turn) draft.turns[cancelled.next.turn.id] = cancelled.next.turn;
          for (const pending of currentPending) {
            if (pending.id === currentLive?.id) continue;
            const settled = cancelPendingTurn(pending, { now });
            if (!settled.ok) return settled;
            draft.turns[pending.id] = settled.next;
          }
          return { ok: true };
        });
        if (lt) cleanupTurnResources(deps, lt.id);
      }
      deps.store.commit((draft) => {
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: { cancelled: command.childId },
        });
        return { ok: true };
      });
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
        const cascade = deps.store.commit((draft) => {
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
              draft.tasks[taskId] = {
                ...cancelled.next.task,
                reason: command.reason,
              };
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
          return { ok: false, error: cascade.detail ?? cascade.reason };
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
      const commit = deps.store.commit((draft) => {
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
        return { ok: false, error: commit.detail ?? commit.reason };
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
      const staged = deps.store.commit((draft) => {
        const turn = draft.turns[ctx.turnId];
        if (!turn) return { ok: false, reason: 'turn not found' };
        const turnCap = canCreateTurn(draft, ctx.callerTaskId, limits);
        if (!turnCap.ok) return turnCap;
        const result = stageDisposition(turn, { kind: 'wait_tasks', taskIds: command.taskIds }, command.opId, {
          limits: { maxResult: limits.maxResultBytes, maxError: limits.maxErrorBytes },
        });
        if (!result.ok) return result;
        draft.turns[ctx.turnId] = result.next.turn;
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, {
          ok: true,
          data: { staged: true, taskIds: command.taskIds },
        });
        return { ok: true };
      });
      if (!staged.ok) return { ok: false, error: staged.detail ?? staged.reason };
      return { ok: true, result: { staged: true, taskIds: command.taskIds } };
    }

    case 'complete_task': {
      const sizeCheck = checkLimit('result_size', limits, { file: deps.store.getFile(), parentId: null, rootId: ctx.rootId, resultBytes: Buffer.byteLength(command.result, 'utf8') });
      if (!sizeCheck.ok) return { ok: false, error: sizeCheck.reason };
      const staged = deps.store.commit((draft) => {
        const turn = draft.turns[ctx.turnId];
        if (!turn) return { ok: false, reason: 'turn not found' };
        const result = stageDisposition(turn, { kind: 'complete', result: command.result }, command.opId, {
          limits: { maxResult: limits.maxResultBytes, maxError: limits.maxErrorBytes },
        });
        if (!result.ok) return result;
        draft.turns[ctx.turnId] = result.next.turn;
        writeLedger(draft, ctx.turnId, command.opId, fingerprint, { ok: true, data: { staged: true } });
        return { ok: true };
      });
      if (!staged.ok) return { ok: false, error: staged.detail ?? staged.reason };
      return { ok: true, result: { staged: true } };
    }

    case 'fail_task': {
      const sizeCheck = checkLimit('error_size', limits, { file: deps.store.getFile(), parentId: null, rootId: ctx.rootId, errorBytes: Buffer.byteLength(command.error, 'utf8') });
      if (!sizeCheck.ok) return { ok: false, error: sizeCheck.reason };
      const staged = deps.store.commit((draft) => {
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
      if (!staged.ok) return { ok: false, error: staged.detail ?? staged.reason };
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
          releaseState: t.releaseState ?? 'draft',
          goal: t.goal.slice(0, 128),
          parentId: t.parentId,
          attention: t.attention,
          resultSummary: t.taskResult?.summary ?? t.result,
          readiness: {
            code: readiness.code,
            schedulable: readiness.schedulable,
            reasons: readiness.reasons,
          },
        };
      }).filter((n): n is NonNullable<typeof n> => n !== undefined);
      return { ok: true, result: { root: targetId, tasks: nodes.slice(0, 32) } };
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
      return {
        ok: false,
        error:
          'ask_user MCP tool is disabled; use ACP elicitation/create (or native agent ask)',
      };

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
  store: TaskStore,
  turnId: string,
  limits: ResourceLimits,
): boolean {
  const file = store.getFile();
  const check = canPromoteTurn(file, turnId, limits);
  return check.ok;
}

export function processCancelRequests(deps: GraphEngineDeps): void {
  const file = deps.store.getFile();
  const requests = file.cancelRequests ?? {};
  const now = nowIso(deps.clock);

  for (const [turnId, request] of Object.entries(requests)) {
    if (!deps.ownsLease(turnId)) {
      continue;
    }
    deps.liveRuns.get(turnId)?.controller.abort();
    deps.store.commit((draft) => {
      const turn = draft.turns[turnId];
      if (!turn) {
        delete draft.cancelRequests?.[turnId];
        return { ok: true };
      }
      if (request.kind === 'interrupt') {
        const interrupted = interruptTurn(turn, { now });
        if (interrupted.ok) {
          draft.turns[turnId] = interrupted.next;
          holdQueuedFollowUpsOnFailure(draft, turn.taskId);
        }
      } else {
        const task = draft.tasks[turn.taskId];
        if (task) {
          const pendingTurns = turnsForTask(draft, task.id).filter(
            (t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting_user',
          );
          const cancelled = transitionCancelTask(task, {
            liveTurn: turn,
            now,
            sealedBy:
              request.sealedBy ??
              (request.by === 'engine' || request.by === 'user'
                ? { kind: 'user' }
                : {
                    kind: 'coordinator',
                    taskId: request.by,
                    mode: 'cancel_task',
                  }),
          });
          if (cancelled.ok) {
            // parent_seal always applies reason (including undefined to clear stale).
            const isParentSeal =
              request.sealedBy?.kind === 'coordinator' &&
              request.sealedBy.mode === 'parent_seal';
            draft.tasks[task.id] = isParentSeal
              ? { ...cancelled.next.task, reason: request.reason }
              : cancelled.next.task;
            if (cancelled.next.turn) draft.turns[cancelled.next.turn.id] = cancelled.next.turn;
            for (const pending of pendingTurns) {
              if (pending.id === turn.id) continue;
              const settled = cancelPendingTurn(pending, { now });
              if (settled.ok) draft.turns[pending.id] = settled.next;
            }
          }
        }
      }
      delete draft.cancelRequests?.[turnId];
      pruneLedgerForTurn(draft, turnId);
      return { ok: true };
    });
    cleanupTurnResources(deps, turnId);
  }
}

export function projectChildResults(
  taskIds: string[],
  file: TaskStoreFile,
  maxBytes: number,
): string {
  const header = '[child_results]';
  const parts: string[] = [header];
  let used = Buffer.byteLength(header, 'utf8');
  for (const id of taskIds) {
    const task = file.tasks[id];
    if (!task) continue;
    const entry = {
      id: task.id,
      lifecycle: task.lifecycle,
      result: task.result?.slice(0, 512),
      error: task.error?.slice(0, 256),
    };
    const line = JSON.stringify(entry);
    const lineBytes = Buffer.byteLength(line, 'utf8') + (parts.length > 0 ? 1 : 0);
    if (used + lineBytes > maxBytes) break;
    parts.push(line);
    used += lineBytes;
  }
  return parts.join('\n');
}