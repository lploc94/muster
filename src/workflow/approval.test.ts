import { describe, expect, it } from 'vitest';
import type { TaskStoreFile } from '../task/types';
import { WORKFLOW_CONTRACT_VERSION } from './contracts';
import { createWorkflowRun, stagePlanForApproval } from './store';
import { approveAndMaterialize, readyChildIds } from './approval';
import type { PlanArtifact } from './contracts';

const POLICY = {
  maxTurns: 20,
  maxAutomaticRetries: 1,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 600_000,
};

function draftWithRoot(): TaskStoreFile {
  return {
    schemaVersion: 4,
    revision: 0,
    tasks: {
      'root-1': {
        id: 'root-1',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'Ship X',
        parentId: null,
        dependencies: [],
        backend: 'claude',
        capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
        executionPolicy: POLICY,
        revision: 1,
        createdAt: 't0',
        updatedAt: 't0',
      },
    },
    turns: {},
    messages: {},
    workflowRuns: {},
    workflowArtifacts: {},
    usageRecords: {},
  };
}

function plan(): PlanArtifact {
  return {
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    id: 'plan-1',
    kind: 'plan',
    rootTaskId: 'root-1',
    workflowRunId: 'wf-1',
    producedByTaskId: 'root-1',
    producedAt: 't1',
    consumer: 'host',
    body: {
      title: 'Ship X',
      summary: 'impl then test',
      goal: 'Ship X',
      revision: 1,
      tasks: [
        {
          proposalId: 'impl',
          goal: 'Implement',
          role: 'worker',
          backend: 'claude',
          dependsOn: [],
          acceptanceCriteria: ['code'],
          verification: ['npm test'],
        },
        {
          proposalId: 'test',
          goal: 'Test',
          role: 'worker',
          backend: 'claude',
          dependsOn: ['impl'],
          acceptanceCriteria: ['pass'],
          verification: ['npm test'],
        },
      ],
      acceptanceCriteria: ['done'],
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

describe('approveAndMaterialize', () => {
  it('creates children once and respects dependency readiness', () => {
    const draft = draftWithRoot();
    createWorkflowRun(draft, {
      id: 'wf-1',
      rootTaskId: 'root-1',
      phase: 'planning',
      now: 't0',
    });
    stagePlanForApproval(draft, {
      workflowRunId: 'wf-1',
      plan: plan(),
      now: 't1',
    });

    const first = approveAndMaterialize(draft, {
      workflowRunId: 'wf-1',
      planArtifactId: 'plan-1',
      materializeOpId: 'op-1',
      now: 't2',
      defaultPolicy: POLICY,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.createdTaskIds).toHaveLength(2);
    expect(first.alreadyMaterialized).toBe(false);
    expect(draft.workflowRuns?.['wf-1']?.approval?.materialized).toBe(true);

    const ready = readyChildIds(draft, first.createdTaskIds);
    expect(ready).toHaveLength(1);
    expect(draft.tasks[ready[0]]?.goal).toBe('Implement');

    const second = approveAndMaterialize(draft, {
      workflowRunId: 'wf-1',
      planArtifactId: 'plan-1',
      materializeOpId: 'op-1',
      now: 't3',
      defaultPolicy: POLICY,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyMaterialized).toBe(true);
    expect(Object.keys(draft.tasks).filter((id) => id !== 'root-1')).toHaveLength(2);
  });

  it('rejects duplicate approval with different opId', () => {
    const draft = draftWithRoot();
    createWorkflowRun(draft, {
      id: 'wf-1',
      rootTaskId: 'root-1',
      phase: 'planning',
      now: 't0',
    });
    stagePlanForApproval(draft, {
      workflowRunId: 'wf-1',
      plan: plan(),
      now: 't1',
    });
    approveAndMaterialize(draft, {
      workflowRunId: 'wf-1',
      planArtifactId: 'plan-1',
      materializeOpId: 'op-1',
      now: 't2',
      defaultPolicy: POLICY,
    });
    const dup = approveAndMaterialize(draft, {
      workflowRunId: 'wf-1',
      planArtifactId: 'plan-1',
      materializeOpId: 'op-2',
      now: 't3',
      defaultPolicy: POLICY,
    });
    expect(dup.ok).toBe(false);
  });
});
