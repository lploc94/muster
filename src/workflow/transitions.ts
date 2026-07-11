/**
 * Atomic workflow phase / plan / approval mutations against a TaskStoreFile draft.
 */

import {
  canTransitionPhase,
  workflowError,
  type PlanArtifact,
  type WorkflowError,
  type WorkflowPhase,
} from './contracts';
import type {
  PlanApprovalRecord,
  UsageRecord,
  WorkflowArtifactRecord,
  WorkflowRun,
} from './types';
import type { TaskStoreFile } from '../task/types';

export type WorkflowMutationResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: WorkflowError };

function ensureMaps(draft: TaskStoreFile): void {
  draft.workflowRuns = draft.workflowRuns ?? {};
  draft.workflowArtifacts = draft.workflowArtifacts ?? {};
  draft.usageRecords = draft.usageRecords ?? {};
}

export function getWorkflowRunForRoot(
  file: Pick<TaskStoreFile, 'workflowRuns'>,
  rootTaskId: string,
): WorkflowRun | undefined {
  const runs = file.workflowRuns ?? {};
  return Object.values(runs).find((r) => r.rootTaskId === rootTaskId && !r.archived);
}

export function getWorkflowRun(
  file: Pick<TaskStoreFile, 'workflowRuns'>,
  workflowRunId: string,
): WorkflowRun | undefined {
  return file.workflowRuns?.[workflowRunId];
}

export function createWorkflowRun(
  draft: TaskStoreFile,
  params: {
    id: string;
    rootTaskId: string;
    phase?: WorkflowPhase;
    now: string;
  },
): WorkflowMutationResult<WorkflowRun> {
  ensureMaps(draft);
  if (draft.workflowRuns![params.id]) {
    return {
      ok: false,
      error: workflowError('ARTIFACT_INVALID', `workflow run ${params.id} already exists`),
    };
  }
  const existing = getWorkflowRunForRoot(draft, params.rootTaskId);
  if (existing && !existing.archived) {
    return {
      ok: false,
      error: workflowError(
        'ARTIFACT_INVALID',
        `root ${params.rootTaskId} already has workflow run ${existing.id}`,
      ),
    };
  }
  const run: WorkflowRun = {
    id: params.id,
    rootTaskId: params.rootTaskId,
    phase: params.phase ?? 'draft',
    planRevision: 0,
    createdAt: params.now,
    updatedAt: params.now,
  };
  draft.workflowRuns![params.id] = run;
  return { ok: true, value: run };
}

export function transitionWorkflowPhase(
  draft: TaskStoreFile,
  params: { workflowRunId: string; to: WorkflowPhase; now: string },
): WorkflowMutationResult<WorkflowRun> {
  ensureMaps(draft);
  const run = draft.workflowRuns![params.workflowRunId];
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run not found') };
  }
  if (!canTransitionPhase(run.phase, params.to)) {
    return {
      ok: false,
      error: workflowError('TRANSITION_DENIED', `cannot transition ${run.phase} → ${params.to}`, {
        from: run.phase,
        to: params.to,
      }),
    };
  }
  run.phase = params.to;
  run.updatedAt = params.now;
  return { ok: true, value: run };
}

export function attachArtifact(
  draft: TaskStoreFile,
  record: WorkflowArtifactRecord,
): WorkflowMutationResult<WorkflowArtifactRecord> {
  ensureMaps(draft);
  if (draft.workflowArtifacts![record.id]) {
    // Idempotent re-attach of identical body
    const prev = draft.workflowArtifacts![record.id];
    if (JSON.stringify(prev) === JSON.stringify(record)) {
      return { ok: true, value: prev };
    }
    return {
      ok: false,
      error: workflowError('ARTIFACT_INVALID', `artifact ${record.id} already exists with different body`),
    };
  }
  const run = draft.workflowRuns![record.workflowRunId];
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run not found for artifact') };
  }
  draft.workflowArtifacts![record.id] = record;
  if (record.kind === 'decision_brief') {
    run.currentDecisionBriefId = record.id;
  }
  if (record.kind === 'plan') {
    run.currentPlanArtifactId = record.id;
    if (typeof record.planRevision === 'number') {
      run.planRevision = Math.max(run.planRevision, record.planRevision);
    }
  }
  run.updatedAt = record.producedAt;
  return { ok: true, value: record };
}

export function stagePlanForApproval(
  draft: TaskStoreFile,
  params: {
    workflowRunId: string;
    plan: PlanArtifact;
    now: string;
  },
): WorkflowMutationResult<{ run: WorkflowRun; artifact: WorkflowArtifactRecord }> {
  ensureMaps(draft);
  const run = draft.workflowRuns![params.workflowRunId];
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run not found') };
  }
  if (run.rootTaskId !== params.plan.rootTaskId) {
    return {
      ok: false,
      error: workflowError('PLAN_INVALID', 'plan rootTaskId does not match workflow run'),
    };
  }
  if (params.plan.workflowRunId !== params.workflowRunId) {
    return {
      ok: false,
      error: workflowError('PLAN_INVALID', 'plan workflowRunId mismatch'),
    };
  }

  const artifact: WorkflowArtifactRecord = {
    id: params.plan.id,
    contractVersion: params.plan.contractVersion,
    kind: 'plan',
    rootTaskId: params.plan.rootTaskId,
    workflowRunId: params.plan.workflowRunId,
    planRevision: params.plan.body.revision,
    producedByTaskId: params.plan.producedByTaskId,
    producedByTurnId: params.plan.producedByTurnId,
    producedAt: params.plan.producedAt,
    consumer: params.plan.consumer,
    body: params.plan.body,
  };

  const attached = attachArtifact(draft, artifact);
  if (!attached.ok) return attached;

  const phaseResult = transitionWorkflowPhase(draft, {
    workflowRunId: params.workflowRunId,
    to: 'awaiting_plan_approval',
    now: params.now,
  });
  if (!phaseResult.ok) return phaseResult;

  const approval: PlanApprovalRecord = {
    status: 'pending',
    planArtifactId: params.plan.id,
    planRevision: params.plan.body.revision,
    updatedAt: params.now,
    materialized: false,
  };
  run.approval = approval;
  run.currentPlanArtifactId = params.plan.id;
  run.planRevision = params.plan.body.revision;
  run.updatedAt = params.now;

  return { ok: true, value: { run, artifact } };
}

export function approvePlan(
  draft: TaskStoreFile,
  params: {
    workflowRunId: string;
    /** Expected plan artifact id — must match pending approval. */
    planArtifactId: string;
    materializeOpId: string;
    now: string;
  },
): WorkflowMutationResult<WorkflowRun> {
  ensureMaps(draft);
  const run = draft.workflowRuns![params.workflowRunId];
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run not found') };
  }
  if (run.phase !== 'awaiting_plan_approval' || !run.approval || run.approval.status !== 'pending') {
    // Idempotent: already approved with same op
    if (
      run.approval?.status === 'approved' &&
      run.approval.materializeOpId === params.materializeOpId &&
      run.approval.planArtifactId === params.planArtifactId
    ) {
      return { ok: true, value: run };
    }
    if (run.approval?.status === 'approved' && run.approval.planArtifactId === params.planArtifactId) {
      return {
        ok: false,
        error: workflowError('DUPLICATE_APPROVAL', 'plan already approved', {
          materializeOpId: run.approval.materializeOpId,
        }),
      };
    }
    return {
      ok: false,
      error: workflowError('APPROVAL_REQUIRED', 'no pending plan approval', {
        phase: run.phase,
        approval: run.approval?.status,
      }),
    };
  }
  if (run.approval.planArtifactId !== params.planArtifactId) {
    return {
      ok: false,
      error: workflowError('PLAN_INVALID', 'planArtifactId does not match pending approval'),
    };
  }

  run.approval = {
    ...run.approval,
    status: 'approved',
    approvedAt: params.now,
    approvedBy: 'user',
    materializeOpId: params.materializeOpId,
    updatedAt: params.now,
    materialized: run.approval.materialized ?? false,
  };

  const phaseResult = transitionWorkflowPhase(draft, {
    workflowRunId: params.workflowRunId,
    to: 'approved',
    now: params.now,
  });
  if (!phaseResult.ok) return phaseResult;
  return { ok: true, value: run };
}

export function markPlanMaterialized(
  draft: TaskStoreFile,
  params: { workflowRunId: string; materializeOpId: string; now: string },
): WorkflowMutationResult<WorkflowRun> {
  ensureMaps(draft);
  const run = draft.workflowRuns![params.workflowRunId];
  if (!run?.approval || run.approval.status !== 'approved') {
    return {
      ok: false,
      error: workflowError('APPROVAL_REQUIRED', 'approved plan required to materialize'),
    };
  }
  if (run.approval.materializeOpId !== params.materializeOpId) {
    return {
      ok: false,
      error: workflowError('DUPLICATE_APPROVAL', 'materializeOpId mismatch'),
    };
  }
  if (run.approval.materialized) {
    return { ok: true, value: run };
  }
  run.approval.materialized = true;
  run.approval.updatedAt = params.now;
  run.updatedAt = params.now;
  return { ok: true, value: run };
}

export function rejectPlan(
  draft: TaskStoreFile,
  params: {
    workflowRunId: string;
    reason?: string;
    now: string;
    /** Phase after reject — usually planning. */
    nextPhase?: WorkflowPhase;
  },
): WorkflowMutationResult<WorkflowRun> {
  ensureMaps(draft);
  const run = draft.workflowRuns![params.workflowRunId];
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run not found') };
  }
  if (run.approval) {
    run.approval = {
      ...run.approval,
      status: 'rejected',
      rejectReason: params.reason,
      updatedAt: params.now,
    };
  }
  const next = params.nextPhase ?? 'planning';
  const phaseResult = transitionWorkflowPhase(draft, {
    workflowRunId: params.workflowRunId,
    to: next,
    now: params.now,
  });
  if (!phaseResult.ok) return phaseResult;
  return { ok: true, value: run };
}

export function beginReplan(
  draft: TaskStoreFile,
  params: { workflowRunId: string; now: string },
): WorkflowMutationResult<WorkflowRun> {
  ensureMaps(draft);
  const run = draft.workflowRuns![params.workflowRunId];
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run not found') };
  }
  // Clear pending approval but keep artifacts
  if (run.approval?.status === 'pending') {
    run.approval = {
      ...run.approval,
      status: 'rejected',
      rejectReason: 'replan',
      updatedAt: params.now,
    };
  }
  const phaseResult = transitionWorkflowPhase(draft, {
    workflowRunId: params.workflowRunId,
    to: 'planning',
    now: params.now,
  });
  if (!phaseResult.ok) return phaseResult;
  return { ok: true, value: run };
}

export function archiveWorkflowRun(
  draft: TaskStoreFile,
  params: { workflowRunId: string; now: string },
): WorkflowMutationResult<WorkflowRun> {
  ensureMaps(draft);
  const run = draft.workflowRuns![params.workflowRunId];
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run not found') };
  }
  run.archived = true;
  run.archivedAt = params.now;
  run.updatedAt = params.now;
  return { ok: true, value: run };
}

export function unarchiveWorkflowRun(
  draft: TaskStoreFile,
  params: { workflowRunId: string; now: string },
): WorkflowMutationResult<WorkflowRun> {
  ensureMaps(draft);
  const run = draft.workflowRuns![params.workflowRunId];
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run not found') };
  }
  run.archived = false;
  run.archivedAt = undefined;
  run.updatedAt = params.now;
  return { ok: true, value: run };
}

export function recordUsage(
  draft: TaskStoreFile,
  record: UsageRecord,
): WorkflowMutationResult<UsageRecord> {
  ensureMaps(draft);
  if (draft.usageRecords![record.id]) {
    const prev = draft.usageRecords![record.id];
    if (JSON.stringify(prev) === JSON.stringify(record)) {
      return { ok: true, value: prev };
    }
    return {
      ok: false,
      error: workflowError('ARTIFACT_INVALID', `usage record ${record.id} already exists`),
    };
  }
  draft.usageRecords![record.id] = record;
  return { ok: true, value: record };
}

export function listArtifactsForRun(
  file: Pick<TaskStoreFile, 'workflowArtifacts'>,
  workflowRunId: string,
): WorkflowArtifactRecord[] {
  return Object.values(file.workflowArtifacts ?? {}).filter(
    (a) => a.workflowRunId === workflowRunId,
  );
}
