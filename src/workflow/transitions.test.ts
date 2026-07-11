import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { TaskStore } from '../task/store';
import type { TaskStoreFile } from '../task/types';
import { WORKFLOW_CONTRACT_VERSION, type PlanArtifact } from './contracts';
import { applyRetention } from '../task/retention';
import {
  approvePlan,
  beginReplan,
  createWorkflowRun,
  markPlanMaterialized,
  projectWorkflowSummary,
  stagePlanForApproval,
  transitionWorkflowPhase,
} from './store';

function emptyDraft(): TaskStoreFile {
  return {
    schemaVersion: 4,
    revision: 0,
    tasks: {},
    turns: {},
    messages: {},
    operations: {},
    cancelRequests: {},
    toolCalls: {},
    reasoning: {},
    workflowRuns: {},
    workflowArtifacts: {},
    usageRecords: {},
  };
}

function samplePlan(revision = 1): PlanArtifact {
  return {
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    id: `plan-r${revision}`,
    kind: 'plan',
    rootTaskId: 'root-1',
    workflowRunId: 'wf-1',
    producedByTaskId: 'root-1',
    producedAt: '2026-07-11T00:00:00.000Z',
    consumer: 'host',
    body: {
      title: 'Plan',
      summary: 'Do the thing',
      goal: 'Ship it',
      revision,
      tasks: [
        {
          proposalId: 'impl',
          goal: 'Implement',
          role: 'worker',
          backend: 'claude',
          dependsOn: [],
          acceptanceCriteria: ['works'],
          verification: ['npm test'],
        },
      ],
      acceptanceCriteria: ['works'],
      verificationStrategy: ['npm test'],
      rollbackNotes: [],
      openQuestions: [],
      constraints: [],
      confidence: 'medium',
      unknowns: [],
      evidence: [],
    },
  };
}

describe('workflow transitions', () => {
  it('creates a run and stages a plan for approval', () => {
    const draft = emptyDraft();
    const created = createWorkflowRun(draft, {
      id: 'wf-1',
      rootTaskId: 'root-1',
      phase: 'planning',
      now: '2026-07-11T00:00:00.000Z',
    });
    expect(created.ok).toBe(true);

    const staged = stagePlanForApproval(draft, {
      workflowRunId: 'wf-1',
      plan: samplePlan(1),
      now: '2026-07-11T00:01:00.000Z',
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value.run.phase).toBe('awaiting_plan_approval');
    expect(staged.value.run.approval?.status).toBe('pending');
    expect(draft.workflowArtifacts?.['plan-r1']).toBeDefined();
  });

  it('approves once and is idempotent for the same materializeOpId', () => {
    const draft = emptyDraft();
    createWorkflowRun(draft, {
      id: 'wf-1',
      rootTaskId: 'root-1',
      phase: 'planning',
      now: 't0',
    });
    stagePlanForApproval(draft, {
      workflowRunId: 'wf-1',
      plan: samplePlan(1),
      now: 't1',
    });

    const first = approvePlan(draft, {
      workflowRunId: 'wf-1',
      planArtifactId: 'plan-r1',
      materializeOpId: 'op-approve-1',
      now: 't2',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.phase).toBe('approved');
    expect(first.value.approval?.status).toBe('approved');

    const again = approvePlan(draft, {
      workflowRunId: 'wf-1',
      planArtifactId: 'plan-r1',
      materializeOpId: 'op-approve-1',
      now: 't3',
    });
    expect(again.ok).toBe(true);

    const otherOp = approvePlan(draft, {
      workflowRunId: 'wf-1',
      planArtifactId: 'plan-r1',
      materializeOpId: 'op-approve-2',
      now: 't4',
    });
    expect(otherOp.ok).toBe(false);
    if (!otherOp.ok) expect(otherOp.error.code).toBe('DUPLICATE_APPROVAL');
  });

  it('marks materialization only once', () => {
    const draft = emptyDraft();
    createWorkflowRun(draft, {
      id: 'wf-1',
      rootTaskId: 'root-1',
      phase: 'planning',
      now: 't0',
    });
    stagePlanForApproval(draft, {
      workflowRunId: 'wf-1',
      plan: samplePlan(1),
      now: 't1',
    });
    approvePlan(draft, {
      workflowRunId: 'wf-1',
      planArtifactId: 'plan-r1',
      materializeOpId: 'op-1',
      now: 't2',
    });

    const m1 = markPlanMaterialized(draft, {
      workflowRunId: 'wf-1',
      materializeOpId: 'op-1',
      now: 't3',
    });
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;
    expect(m1.value.approval?.materialized).toBe(true);

    const m2 = markPlanMaterialized(draft, {
      workflowRunId: 'wf-1',
      materializeOpId: 'op-1',
      now: 't4',
    });
    expect(m2.ok).toBe(true);
  });

  it('replans without deleting prior plan artifacts', () => {
    const draft = emptyDraft();
    createWorkflowRun(draft, {
      id: 'wf-1',
      rootTaskId: 'root-1',
      phase: 'planning',
      now: 't0',
    });
    stagePlanForApproval(draft, {
      workflowRunId: 'wf-1',
      plan: samplePlan(1),
      now: 't1',
    });
    const replan = beginReplan(draft, { workflowRunId: 'wf-1', now: 't2' });
    expect(replan.ok).toBe(true);
    if (!replan.ok) return;
    expect(replan.value.phase).toBe('planning');
    expect(draft.workflowArtifacts?.['plan-r1']).toBeDefined();
  });

  it('denies illegal phase jumps', () => {
    const draft = emptyDraft();
    createWorkflowRun(draft, {
      id: 'wf-1',
      rootTaskId: 'root-1',
      phase: 'draft',
      now: 't0',
    });
    const bad = transitionWorkflowPhase(draft, {
      workflowRunId: 'wf-1',
      to: 'implementing',
      now: 't1',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('TRANSITION_DENIED');
  });
});

describe('workflow persistence / retention', () => {
  it('survives store commit and reload at awaiting_plan_approval', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-wf-'));
    const filePath = path.join(dir, 'tasks.json');
    const store = TaskStore.load({ filePath });

    store.commit((draft) => {
      draft.tasks['root-1'] = {
        id: 'root-1',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'Ship',
        parentId: null,
        dependencies: [],
        backend: 'claude',
        capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 1,
          turnTimeoutMs: 60_000,
          taskTimeoutMs: 600_000,
        },
        revision: 1,
        createdAt: 't0',
        updatedAt: 't0',
      };
      createWorkflowRun(draft, {
        id: 'wf-1',
        rootTaskId: 'root-1',
        phase: 'planning',
        now: 't0',
      });
      stagePlanForApproval(draft, {
        workflowRunId: 'wf-1',
        plan: samplePlan(1),
        now: 't1',
      });
      return { ok: true };
    });

    const reloaded = TaskStore.load({ filePath });
    const file = reloaded.getFile();
    expect(file.schemaVersion).toBe(4);
    expect(file.workflowRuns?.['wf-1']?.phase).toBe('awaiting_plan_approval');
    expect(file.workflowRuns?.['wf-1']?.approval?.status).toBe('pending');
    // Reload must not auto-start / auto-approve
    expect(file.workflowRuns?.['wf-1']?.approval?.materialized).toBeFalsy();

    const summary = projectWorkflowSummary(file as TaskStoreFile, 'wf-1');
    expect(summary?.phase).toBe('awaiting_plan_approval');
    expect(summary?.currentPlanTitle).toBe('Plan');
  });

  it('retention does not drop plan artifacts', () => {
    const draft = emptyDraft();
    createWorkflowRun(draft, {
      id: 'wf-1',
      rootTaskId: 'root-1',
      phase: 'planning',
      now: 't0',
    });
    stagePlanForApproval(draft, {
      workflowRunId: 'wf-1',
      plan: samplePlan(1),
      now: 't1',
    });
    draft.tasks['root-1'] = {
      id: 'root-1',
      role: 'coordinator',
      lifecycle: 'succeeded',
      goal: 'Ship',
      parentId: null,
      dependencies: [],
      backend: 'claude',
      capabilities: [],
      executionPolicy: {
        maxTurns: 20,
        maxAutomaticRetries: 0,
        turnTimeoutMs: 1,
        taskTimeoutMs: 1,
      },
      revision: 1,
      createdAt: 't0',
      updatedAt: 't0',
      finishedAt: 't9',
    };

    const retained = applyRetention(draft, { maxTurnsPerTask: 1, maxStoredOutputChars: 100 });
    expect(retained.workflowArtifacts?.['plan-r1']).toBeDefined();
    expect(retained.workflowRuns?.['wf-1']).toBeDefined();
  });
});
