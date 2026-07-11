/**
 * Persisted workflow records (schema ≥ 4).
 * Orthogonal to TaskLifecycleState — see docs/AGENTIC-WORKFLOW-KNOWLEDGE.md.
 */

import type { ArtifactKind, ConfidenceLevel, WorkflowPhase } from './contracts';

export type { WorkflowPhase };

export type PlanApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface PlanApprovalRecord {
  status: PlanApprovalStatus;
  planArtifactId: string;
  planRevision: number;
  /** ISO timestamp when status last changed. */
  updatedAt: string;
  /** Set when user approves. */
  approvedAt?: string;
  approvedBy?: 'user';
  /** Idempotency key for materialize/start after approval. */
  materializeOpId?: string;
  /** True once children have been materialized for this approval. */
  materialized?: boolean;
  rejectReason?: string;
}

export interface WorkflowRun {
  id: string;
  rootTaskId: string;
  phase: WorkflowPhase;
  /** Latest plan revision number (0 = none yet). */
  planRevision: number;
  currentPlanArtifactId?: string;
  currentDecisionBriefId?: string;
  approval?: PlanApprovalRecord;
  /** Soft-hide in default task lists without changing lifecycle. */
  archived?: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Persisted artifact envelope. Body is the typed body only (not nested envelope);
 * envelope metadata is on this record for indexing.
 */
export interface WorkflowArtifactRecord {
  id: string;
  contractVersion: number;
  kind: ArtifactKind;
  rootTaskId: string;
  workflowRunId: string;
  planRevision?: number;
  producedByTaskId: string;
  producedByTurnId?: string;
  producedAt: string;
  consumer: string;
  body: unknown;
}

/** Normalized usage — no raw provider payloads. */
export interface UsageRecord {
  id: string;
  taskId: string;
  turnId?: string;
  workflowRunId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  recordedAt: string;
  source: 'provider' | 'normalized' | 'host';
}

/** Safe summary projected to UI (no full artifact bodies). */
export interface WorkflowSummary {
  workflowRunId: string;
  rootTaskId: string;
  phase: WorkflowPhase;
  planRevision: number;
  approvalStatus?: PlanApprovalStatus;
  currentPlanTitle?: string;
  currentPlanSummary?: string;
  artifactCounts: Partial<Record<ArtifactKind, number>>;
  archived?: boolean;
  updatedAt: string;
  confidence?: ConfidenceLevel;
}
