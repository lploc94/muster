/**
 * /compact — prune transcript text while retaining plan/decision/evidence.
 */

import { randomUUID } from 'crypto';
import { applyRetention, DEFAULT_RETENTION_CONFIG, type RetentionConfig } from '../task/retention';
import type { TaskStoreFile } from '../task/types';
import { WORKFLOW_CONTRACT_VERSION } from './contracts';
import { attachArtifact, getWorkflowRunForRoot } from './store';

export interface CompactResult {
  beforeMessageCount: number;
  afterMessageCount: number;
  retainedArtifactIds: string[];
  auditArtifactId: string;
}

export function compactWorkflowTranscript(
  draft: TaskStoreFile,
  params: {
    rootTaskId: string;
    now: string;
    retention?: RetentionConfig;
  },
): CompactResult {
  const beforeMessageCount = Object.keys(draft.messages).length;
  const run = getWorkflowRunForRoot(draft, params.rootTaskId);
  const retainedArtifactIds = Object.values(draft.workflowArtifacts ?? {})
    .filter((a) => a.rootTaskId === params.rootTaskId)
    .map((a) => a.id);

  // Snapshot workflow maps
  const workflowRuns = draft.workflowRuns;
  const workflowArtifacts = draft.workflowArtifacts;
  const usageRecords = draft.usageRecords;

  const retained = applyRetention(draft, params.retention ?? {
    ...DEFAULT_RETENTION_CONFIG,
    maxTurnsPerTask: Math.min(DEFAULT_RETENTION_CONFIG.maxTurnsPerTask, 50),
    maxStoredOutputChars: Math.min(DEFAULT_RETENTION_CONFIG.maxStoredOutputChars, 40_000),
  });

  // Copy retention results into draft
  draft.turns = retained.turns;
  draft.messages = retained.messages;
  draft.toolCalls = retained.toolCalls;
  draft.reasoning = retained.reasoning;
  draft.workflowRuns = workflowRuns;
  draft.workflowArtifacts = workflowArtifacts;
  draft.usageRecords = usageRecords;

  const auditId = randomUUID();
  if (run) {
    attachArtifact(draft, {
      id: auditId,
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      kind: 'compact_audit',
      rootTaskId: params.rootTaskId,
      workflowRunId: run.id,
      producedByTaskId: params.rootTaskId,
      producedAt: params.now,
      consumer: 'host',
      body: {
        retainedArtifactIds,
        beforeMessageCount,
        afterMessageCount: Object.keys(draft.messages).length,
        note: 'Transcript compacted; plan/decision/verification artifacts retained',
      },
    });
  }

  return {
    beforeMessageCount,
    afterMessageCount: Object.keys(draft.messages).length,
    retainedArtifactIds,
    auditArtifactId: auditId,
  };
}
