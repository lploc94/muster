/**
 * Workflow projection helpers over TaskStoreFile (schema ≥ 4).
 */

import type { ArtifactKind, ConfidenceLevel } from './contracts';
import type {
  WorkflowArtifactRecord,
  WorkflowRun,
  WorkflowSummary,
} from './types';
import type { TaskStoreFile } from '../task/types';
import { getWorkflowRun, getWorkflowRunForRoot, listArtifactsForRun } from './transitions';

export {
  getWorkflowRun,
  getWorkflowRunForRoot,
  listArtifactsForRun,
  createWorkflowRun,
  transitionWorkflowPhase,
  attachArtifact,
  stagePlanForApproval,
  approvePlan,
  markPlanMaterialized,
  rejectPlan,
  beginReplan,
  archiveWorkflowRun,
  unarchiveWorkflowRun,
  recordUsage,
} from './transitions';

export function projectWorkflowSummary(
  file: TaskStoreFile,
  workflowRunId: string,
): WorkflowSummary | undefined {
  const run = getWorkflowRun(file, workflowRunId);
  if (!run) return undefined;
  return projectRunSummary(file, run);
}

export function projectWorkflowSummaryForRoot(
  file: TaskStoreFile,
  rootTaskId: string,
): WorkflowSummary | undefined {
  const run = getWorkflowRunForRoot(file, rootTaskId);
  if (!run) {
    // Also surface archived runs if no active one
    const archived = Object.values(file.workflowRuns ?? {}).find(
      (r) => r.rootTaskId === rootTaskId,
    );
    if (!archived) return undefined;
    return projectRunSummary(file, archived);
  }
  return projectRunSummary(file, run);
}

function projectRunSummary(file: TaskStoreFile, run: WorkflowRun): WorkflowSummary {
  const artifacts = listArtifactsForRun(file, run.id);
  const counts: Partial<Record<ArtifactKind, number>> = {};
  for (const a of artifacts) {
    counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  }

  let currentPlanTitle: string | undefined;
  let currentPlanSummary: string | undefined;
  let confidence: ConfidenceLevel | undefined;

  if (run.currentPlanArtifactId) {
    const plan = file.workflowArtifacts?.[run.currentPlanArtifactId];
    if (plan && plan.kind === 'plan' && isRecord(plan.body)) {
      if (typeof plan.body.title === 'string') currentPlanTitle = plan.body.title;
      if (typeof plan.body.summary === 'string') currentPlanSummary = plan.body.summary;
      if (
        plan.body.confidence === 'low' ||
        plan.body.confidence === 'medium' ||
        plan.body.confidence === 'high'
      ) {
        confidence = plan.body.confidence;
      }
    }
  }

  return {
    workflowRunId: run.id,
    rootTaskId: run.rootTaskId,
    phase: run.phase,
    planRevision: run.planRevision,
    approvalStatus: run.approval?.status,
    currentPlanTitle,
    currentPlanSummary,
    artifactCounts: counts,
    archived: run.archived,
    updatedAt: run.updatedAt,
    confidence,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Artifacts that retention must never drop when pruning transcript text. */
export const RETAINED_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'decision_brief',
  'plan',
  'verification_report',
  'test_report',
  'review_report',
  'debug_report',
  'outcome_proposal',
  'compact_audit',
]);

export function isRetainedArtifact(record: WorkflowArtifactRecord): boolean {
  return RETAINED_ARTIFACT_KINDS.has(record.kind);
}
