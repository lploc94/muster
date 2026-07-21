/**
 * Single readiness evaluator for scheduler + status/UI (orchestration W5).
 * Pure helpers — no engine/store I/O beyond the file snapshot passed in.
 */

import { evaluateDependency } from './deps';
import { effectiveTaskResult } from './dataflow';
import type { MusterTask, EngineProjection, TaskTurn } from './types';

export type ReadinessCode =
  | 'ready'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'draft'
  | 'paused_not_released'
  | 'waiting_dependencies'
  | 'missing_input_binding'
  | 'waiting_resource'
  | 'path_conflict'
  | 'git_mutex'
  | 'held_reload'
  | 'held_after_failure'
  | 'needs_attention'
  | 'waiting_children'
  | 'waiting_external'
  | 'handoff_active'
  | 'terminal'
  | 'not_found';

export interface ReadinessReason {
  code: ReadinessCode;
  message: string;
  detail?: Record<string, unknown>;
}

export interface TaskReadiness {
  taskId: string;
  /** Primary reason (first blocker, or ready/running/terminal). */
  code: ReadinessCode;
  reasons: ReadinessReason[];
  /** True when a queued turn may be promoted (ignores global concurrency — that is canPromoteTurn). */
  schedulable: boolean;
}

const LIVE: ReadonlySet<TaskTurn['status']> = new Set(['running', 'waiting_user']);

function turnsForTask(file: EngineProjection, taskId: string): TaskTurn[] {
  return Object.values(file.turns).filter((t) => t.taskId === taskId);
}

function depBlockReasons(file: EngineProjection, task: MusterTask): ReadinessReason[] {
  const reasons: ReadinessReason[] = [];
  for (const dep of task.dependencies) {
    const producer = file.tasks[dep.taskId];
    const outcome = evaluateDependency(
      dep,
      producer?.lifecycle,
      producer?.taskResult?.verdict?.status,
    );
    if (outcome !== 'satisfied') {
      reasons.push({
        code: 'waiting_dependencies',
        message: `dependency ${dep.taskId} not satisfied (${outcome})`,
        detail: { dependencyTaskId: dep.taskId, outcome },
      });
    }
  }
  return reasons;
}

function missingInputReasons(file: EngineProjection, task: MusterTask): ReadinessReason[] {
  const bindings = task.inputBindings;
  if (!bindings || bindings.length === 0) return [];
  const reasons: ReadinessReason[] = [];
  for (const b of bindings) {
    if (b.required === false) continue;
    const producer = file.tasks[b.fromTaskId];
    if (!producer || !effectiveTaskResult(producer)) {
      reasons.push({
        code: 'missing_input_binding',
        message: `required binding ${b.as} from ${b.fromTaskId} missing summary`,
        detail: { fromTaskId: b.fromTaskId, as: b.as },
      });
    }
  }
  return reasons;
}

/**
 * Evaluate why a task is / is not runnable.
 * Path/git resource conflicts are reserved for W7 (path_conflict / git_mutex).
 */
export function evaluateTaskReadiness(file: EngineProjection, taskId: string): TaskReadiness {
  const task = file.tasks[taskId];
  if (!task) {
    return {
      taskId,
      code: 'not_found',
      reasons: [{ code: 'not_found', message: 'task not found' }],
      schedulable: false,
    };
  }

  const reasons: ReadinessReason[] = [];
  const turns = turnsForTask(file, taskId);
  const live = turns.find((t) => LIVE.has(t.status));
  const queued = turns
    .filter((t) => t.status === 'queued')
    .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt));

  if (task.lifecycle !== 'open') {
    return {
      taskId,
      code: 'terminal',
      reasons: [
        {
          code: 'terminal',
          message: `lifecycle is ${task.lifecycle}`,
          detail: { lifecycle: task.lifecycle },
        },
      ],
      schedulable: false,
    };
  }

  if (live?.status === 'running') {
    return {
      taskId,
      code: 'running',
      reasons: [{ code: 'running', message: 'turn is running', detail: { turnId: live.id } }],
      schedulable: false,
    };
  }
  if (live?.status === 'waiting_user') {
    return {
      taskId,
      code: 'waiting_user',
      reasons: [
        { code: 'waiting_user', message: 'turn is waiting on user', detail: { turnId: live.id } },
      ],
      schedulable: false,
    };
  }

  if (task.releaseState === 'draft') {
    reasons.push({
      code: 'draft',
      message: 'task is draft (not released)',
    });
  }

  // Surface attention for status; only missing_input blocks promote.
  if (task.attention) {
    reasons.push({
      code: 'needs_attention',
      message: task.attention.message,
      detail: { attentionCode: task.attention.code },
    });
  }

  reasons.push(...depBlockReasons(file, task));
  const inputReasons = missingInputReasons(file, task);
  reasons.push(...inputReasons);

  if (task.wait?.kind === 'children') {
    reasons.push({
      code: 'waiting_children',
      message: 'waiting on child tasks',
      detail: { taskIds: task.wait.taskIds },
    });
  }
  if (task.wait?.kind === 'external') {
    reasons.push({
      code: 'waiting_external',
      message: task.wait.message ?? 'waiting on external blocker',
      detail: { key: task.wait.key },
    });
  }

  const hasPromotableQueued = queued.some((t) => t.holdAutoPromote !== true);
  // Held follow-ups must not block a later non-held safe auto-retry (scheduler FIFO).
  if (queued.length > 0 && !hasPromotableQueued) {
    reasons.push({
      code: 'held_after_failure',
      message: 'all queued turns held after previous failure',
      detail: { turnIds: queued.map((t) => t.id) },
    });
  }

  // Only schedulable when released, has non-held queued turn, and no hard blockers.
  const hardBlock =
    task.releaseState === 'draft' ||
    inputReasons.length > 0 ||
    reasons.some((r) =>
      (
        [
          'waiting_dependencies',
          'waiting_children',
          'waiting_external',
          'handoff_active',
          'held_after_failure',
          'held_reload',
          'path_conflict',
          'git_mutex',
        ] as ReadinessCode[]
      ).includes(r.code),
    );
  const schedulable = task.releaseState === 'released' && hasPromotableQueued && !hardBlock;

  if (schedulable) {
    return {
      taskId,
      code: hasPromotableQueued ? 'queued' : 'ready',
      reasons: [
        {
          code: hasPromotableQueued ? 'queued' : 'ready',
          message: hasPromotableQueued ? 'queued turn ready to promote' : 'ready',
        },
      ],
      schedulable: true,
    };
  }

  if (reasons.length === 0) {
    reasons.push({
      code: task.releaseState === 'draft' ? 'draft' : 'ready',
      message: task.releaseState === 'draft' ? 'draft' : 'no queued turn',
    });
  }

  return {
    taskId,
    code: reasons[0]!.code,
    reasons,
    schedulable: false,
  };
}

/** Map readiness primary code into canPromoteTurn-style reason string. */
export function readinessToPromoteReason(readiness: TaskReadiness): string | undefined {
  if (readiness.schedulable) return undefined;
  switch (readiness.code) {
    case 'draft':
    case 'paused_not_released':
      return 'task not released';
    case 'waiting_dependencies':
      return 'dependencies not satisfied';
    case 'missing_input_binding':
      return 'missing required input binding';
    case 'waiting_children':
      return 'waiting on child tasks';
    case 'waiting_external':
      return 'waiting on external blocker';
    case 'handoff_active':
      return 'runtime handoff in progress';
    case 'held_after_failure':
      return 'held after previous turn failure';
    case 'held_reload':
      return 'held after reload';
    case 'needs_attention':
      return 'needs attention';
    case 'path_conflict':
      return 'path conflict';
    case 'git_mutex':
      return 'git mutex';
    case 'waiting_resource':
      return 'waiting on resource';
    case 'terminal':
      return 'task is terminal';
    case 'running':
      return 'task already has an active turn';
    case 'waiting_user':
      return 'task already has an active turn';
    case 'not_found':
      return 'task not found';
    default:
      return readiness.reasons[0]?.message ?? readiness.code;
  }
}
