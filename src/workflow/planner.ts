/**
 * Planner entry helpers for auto think/plan on new goals.
 */

import { randomUUID } from 'crypto';
import type { TaskStoreFile } from '../task/types';
import { createWorkflowRun, getWorkflowRunForRoot, transitionWorkflowPhase } from './store';
import { buildPlannerUserMessage, plannerSystemPreamble } from './prompts';
import type { WorkflowPhase } from './contracts';

export function ensurePlannerWorkflowRun(
  draft: TaskStoreFile,
  params: { rootTaskId: string; now: string; phase?: WorkflowPhase },
): { workflowRunId: string; phase: WorkflowPhase } {
  const existing = getWorkflowRunForRoot(draft, params.rootTaskId);
  if (existing) {
    return { workflowRunId: existing.id, phase: existing.phase };
  }
  const id = randomUUID();
  const created = createWorkflowRun(draft, {
    id,
    rootTaskId: params.rootTaskId,
    phase: params.phase ?? 'thinking',
    now: params.now,
  });
  if (!created.ok) {
    // Fall back: try find any
    const again = getWorkflowRunForRoot(draft, params.rootTaskId);
    if (again) return { workflowRunId: again.id, phase: again.phase };
    throw new Error(created.error.message);
  }
  return { workflowRunId: created.value.id, phase: created.value.phase };
}

export function buildAutoPlanMessage(params: {
  goal: string;
  rootTaskId: string;
  workflowRunId: string;
  phase: WorkflowPhase;
}): string {
  const preamble = plannerSystemPreamble({
    goal: params.goal,
    phase: params.phase,
    workflowRunId: params.workflowRunId,
    rootTaskId: params.rootTaskId,
  });
  return `${preamble}\n\n---\n\n${buildPlannerUserMessage(params.goal)}`;
}

/** Advance draft/thinking → planning when the user continues planning. */
export function advanceToPlanning(
  draft: TaskStoreFile,
  workflowRunId: string,
  now: string,
): void {
  const run = draft.workflowRuns?.[workflowRunId];
  if (!run) return;
  if (run.phase === 'draft' || run.phase === 'thinking') {
    transitionWorkflowPhase(draft, { workflowRunId, to: 'planning', now });
  }
}
