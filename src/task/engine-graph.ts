import { createHash, randomUUID } from 'crypto';
import type { AskBridge, Answers, AskRef } from '../bridge/ask-bridge';
import type { CredentialRegistry } from '../bridge/credentials';
import { buildTurnMcp, deleteMcpConfigFile } from '../bridge/mcp-config';
import type { Backend } from '../types';
import { canBindTaskToBackend } from './backend-eligibility';
import { capabilitiesFor } from './capabilities';
import type { ToolCommand } from './coordinator-tools';
import { validateBindingsForRelease } from './dataflow';
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
  type CreateTaskInput,
} from './transitions';
import type { DepGraph } from './deps';
import type { MusterTask, OpResult, TaskCapability, TaskExecutionPolicy, TaskStoreFile, TaskTurn } from './types';

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
const DEFAULT_CHILD_CAPS: TaskCapability[] = ['create_child', 'wait_child', 'read_subtree'];
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

  if (command.kind !== 'get_task_status' && command.kind !== 'report_progress') {
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
      const childId = deriveEntityId(ctx.turnId, command.opId, 'task');
      const turnId = deriveEntityId(ctx.turnId, command.opId, 'turn');
      const backend = deps.makeBackend(command.spec.backend);
      if (!canBindTaskToBackend(backend.capabilities)) {
        return { ok: false, error: 'backend does not support MCP' };
      }

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

        const input: CreateTaskInput = {
          id: childId,
          role: command.spec.role ?? 'worker',
          goal: command.spec.goal,
          parentId: ctx.callerTaskId,
          dependencies: command.spec.dependencies ?? [],
          backend: command.spec.backend,
          // Children inherit the parent's workspace directory so delegated
          // sub-tasks run in the same place and never fall back to process.cwd().
          cwd: caller.cwd,
          capabilities: DEFAULT_CHILD_CAPS,
          // Never trust the raw agent-supplied policy: clamp every field to bounds.
          executionPolicy: clampExecutionPolicy(
            DEFAULT_POLICY,
            command.spec.executionPolicy,
            deps.executionPolicyBounds,
          ),
          // create_task stays draft; delegate_task is atomic released create-and-run.
          releaseState: command.kind === 'delegate_task' ? 'released' : 'draft',
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
            content: command.spec.goal,
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
          data: { taskId: childId, turnId: queuedTurnId },
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

    case 'release_tasks': {
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
            draft.tasks[task.id] = cancelled.next.task;
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