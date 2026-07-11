/**
 * /context — normalized usage, decisions, open questions, evidence provenance.
 */

import type { TaskStoreFile } from '../task/types';
import { getWorkflowRunForRoot, listArtifactsForRun, projectWorkflowSummaryForRoot } from './store';
import type { WorkflowSummary } from './types';

export interface ContextReport {
  rootTaskId: string;
  workflow?: WorkflowSummary;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    records: number;
  };
  decisions: Array<{ id: string; summary: string }>;
  openQuestions: string[];
  evidence: Array<{ id: string; kind: string; summary?: string }>;
  runtime: {
    taskCount: number;
    openTasks: number;
    terminalTasks: number;
  };
}

export function buildContextReport(file: TaskStoreFile, rootTaskId: string): ContextReport {
  const workflow = projectWorkflowSummaryForRoot(file, rootTaskId);
  const run = getWorkflowRunForRoot(file, rootTaskId);
  const artifacts = run ? listArtifactsForRun(file, run.id) : [];

  let inputTokens = 0;
  let outputTokens = 0;
  let records = 0;
  for (const u of Object.values(file.usageRecords ?? {})) {
    if (u.taskId === rootTaskId || u.workflowRunId === run?.id) {
      inputTokens += u.inputTokens ?? 0;
      outputTokens += u.outputTokens ?? 0;
      records += 1;
    }
  }

  const decisions: ContextReport['decisions'] = [];
  const openQuestions: string[] = [];
  const evidence: ContextReport['evidence'] = [];

  for (const a of artifacts) {
    if (a.kind === 'decision_brief' && isRecord(a.body)) {
      decisions.push({
        id: a.id,
        summary: typeof a.body.recommendedApproach === 'string' ? a.body.recommendedApproach : a.id,
      });
      if (Array.isArray(a.body.openQuestions)) {
        openQuestions.push(...a.body.openQuestions.filter((q): q is string => typeof q === 'string'));
      }
    }
    if (a.kind === 'plan' && isRecord(a.body) && Array.isArray(a.body.openQuestions)) {
      openQuestions.push(...a.body.openQuestions.filter((q): q is string => typeof q === 'string'));
    }
    if (isRecord(a.body) && Array.isArray(a.body.evidence)) {
      for (const e of a.body.evidence) {
        if (isRecord(e) && typeof e.id === 'string') {
          evidence.push({
            id: e.id,
            kind: typeof e.kind === 'string' ? e.kind : 'other',
            summary: typeof e.summary === 'string' ? e.summary : undefined,
          });
        }
      }
    }
  }

  const subtree = Object.values(file.tasks).filter(
    (t) => t.id === rootTaskId || t.parentId === rootTaskId,
  );
  const openTasks = subtree.filter((t) => t.lifecycle === 'open').length;

  return {
    rootTaskId,
    workflow,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      records,
    },
    decisions,
    openQuestions,
    evidence,
    runtime: {
      taskCount: subtree.length,
      openTasks,
      terminalTasks: subtree.length - openTasks,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
