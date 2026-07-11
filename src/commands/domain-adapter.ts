/**
 * TaskEngine-backed CommandDomainPort (VS Code-free).
 */

import type { TaskEngine } from '../task/engine';
import type { TaskStore } from '../task/store';
import { projectTaskSummary } from '../host/snapshot';
import { helpEntries } from './registry';
import type { CommandDomainPort, CommandRequest, CommandResult } from './types';
import type { WorkflowPhase } from '../workflow/contracts';
import { workflowError } from '../workflow/contracts';

export interface DomainAdapterOptions {
  engine: TaskEngine;
  store: TaskStore;
  getFocusedTaskId: () => string | undefined;
  setFocusedTaskId: (id: string | undefined) => void;
  defaultBackend?: string;
  cwd?: string;
}

export function createEngineDomainPort(options: DomainAdapterOptions): CommandDomainPort {
  const {
    engine,
    store,
    getFocusedTaskId,
    setFocusedTaskId,
    defaultBackend = 'claude',
    cwd,
  } = options;

  return {
    getFocusedTaskId,
    getWorkflowPhase(rootTaskId: string): WorkflowPhase | undefined {
      return engine.getWorkflowPhase(rootTaskId);
    },
    listTasks() {
      const file = store.getFile();
      return Object.values(file.tasks)
        .filter((t) => {
          const run = file.workflowRuns
            ? Object.values(file.workflowRuns).find((r) => r.rootTaskId === t.id)
            : undefined;
          return !run?.archived;
        })
        .map((t) => ({
          id: t.id,
          goal: t.goal,
          lifecycle: t.lifecycle,
          parentId: t.parentId,
        }));
    },
    createDraft(params) {
      const result = engine.startNewTask({
        goal: '(draft)',
        backend: params?.backend ?? defaultBackend,
        cwd,
        workflowMode: 'draft',
      });
      if (!result.ok) {
        throw new Error(result.reason);
      }
      setFocusedTaskId(result.value.taskId);
      return { taskId: result.value.taskId };
    },
    createRootWithGoal(params) {
      const result = engine.startNewTask({
        goal: params.goal,
        backend: params.backend,
        model: params.model,
        message: params.message,
        cwd,
        workflowMode: 'auto_plan',
      });
      if (!result.ok) {
        throw new Error(result.reason);
      }
      setFocusedTaskId(result.value.taskId);
      return { taskId: result.value.taskId, turnId: result.value.turnId };
    },
    focusTask(taskId) {
      if (!store.getTask(taskId)) {
        return { ok: false, reason: `task not found: ${taskId}` };
      }
      setFocusedTaskId(taskId);
      return { ok: true };
    },
    cancelTask(taskId) {
      const result = engine.cancelTask(taskId);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    getStatus(taskId) {
      const file = store.getFile();
      const summary = projectTaskSummary(file, taskId);
      return summary ?? { id: taskId, error: 'not found' };
    },
    approvePlan(params) {
      const result = engine.approvePlan(params);
      if (!result.ok) {
        return {
          ok: false,
          commandId: 'approve',
          error: workflowError('APPROVAL_REQUIRED', result.reason),
          presenter: 'error',
        };
      }
      return {
        ok: true,
        commandId: 'approve',
        effectClass: 'mutate_execution',
        presenter: 'approval',
        message: result.value.alreadyMaterialized
          ? 'Plan already approved (idempotent)'
          : `Approved; started ${result.value.startedTurnIds.length} child turn(s)`,
        data: result.value,
      };
    },
    replan(params) {
      const result = engine.replan(params);
      if (!result.ok) {
        return {
          ok: false,
          commandId: 'replan',
          error: workflowError('TRANSITION_DENIED', result.reason),
          presenter: 'error',
        };
      }
      return {
        ok: true,
        commandId: 'replan',
        effectClass: 'mutate_plan',
        presenter: 'plan_card',
        message: 'Replanning — submit a new plan revision',
        data: result.value,
      };
    },
    runWorkflowCommand(request: CommandRequest): CommandResult {
      return engine.runWorkflowCommand(request, { cwd });
    },
    getHelpEntries: () => helpEntries(),
  };
}
