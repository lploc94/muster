import { describe, expect, it } from 'vitest';
import { phaseAwareActions, resolveWorkflowPhase } from './capabilities';
import type { TaskStoreFile } from '../task/types';

const coordinator = {
  id: 'root-1',
  parentId: null as string | null,
  role: 'coordinator' as const,
  capabilities: [
    'create_child',
    'start_child',
    'wait_child',
    'interrupt_child',
    'cancel_child',
    'read_subtree',
  ] as const,
};

describe('phaseAwareActions', () => {
  it('denies start/complete/fail before approval', () => {
    for (const phase of ['draft', 'thinking', 'planning', 'awaiting_plan_approval'] as const) {
      const actions = phaseAwareActions(coordinator, phase);
      expect(actions.has('start_task')).toBe(false);
      expect(actions.has('complete_task')).toBe(false);
      expect(actions.has('fail_task')).toBe(false);
      expect(actions.has('submit_plan_artifact')).toBe(true);
      expect(actions.has('submit_decision_brief')).toBe(true);
      expect(actions.has('create_task')).toBe(true);
      expect(actions.has('delegate_task')).toBe(false);
    }
  });

  it('allows start after approval', () => {
    const actions = phaseAwareActions(coordinator, 'approved');
    expect(actions.has('start_task')).toBe(true);
    expect(actions.has('complete_task')).toBe(true);
  });
});

describe('resolveWorkflowPhase', () => {
  it('defaults to draft when no workflow run', () => {
    const file: TaskStoreFile = {
      schemaVersion: 4,
      revision: 0,
      tasks: {
        'root-1': {
          id: 'root-1',
          role: 'coordinator',
          lifecycle: 'open',
          goal: 'x',
          parentId: null,
          dependencies: [],
          backend: 'claude',
          capabilities: [],
          executionPolicy: {
            maxTurns: 1,
            maxAutomaticRetries: 0,
            turnTimeoutMs: 1,
            taskTimeoutMs: 1,
          },
          revision: 1,
          createdAt: 't',
          updatedAt: 't',
        },
      },
      turns: {},
      messages: {},
    };
    expect(resolveWorkflowPhase(file, 'root-1')).toBe('draft');
  });

  it('reads phase from root workflow run', () => {
    const file: TaskStoreFile = {
      schemaVersion: 4,
      revision: 0,
      tasks: {
        'root-1': {
          id: 'root-1',
          role: 'coordinator',
          lifecycle: 'open',
          goal: 'x',
          parentId: null,
          dependencies: [],
          backend: 'claude',
          capabilities: [],
          executionPolicy: {
            maxTurns: 1,
            maxAutomaticRetries: 0,
            turnTimeoutMs: 1,
            taskTimeoutMs: 1,
          },
          revision: 1,
          createdAt: 't',
          updatedAt: 't',
        },
        child: {
          id: 'child',
          role: 'worker',
          lifecycle: 'open',
          goal: 'y',
          parentId: 'root-1',
          dependencies: [],
          backend: 'claude',
          capabilities: [],
          executionPolicy: {
            maxTurns: 1,
            maxAutomaticRetries: 0,
            turnTimeoutMs: 1,
            taskTimeoutMs: 1,
          },
          revision: 1,
          createdAt: 't',
          updatedAt: 't',
        },
      },
      turns: {},
      messages: {},
      workflowRuns: {
        wf: {
          id: 'wf',
          rootTaskId: 'root-1',
          phase: 'awaiting_plan_approval',
          planRevision: 1,
          createdAt: 't',
          updatedAt: 't',
        },
      },
    };
    expect(resolveWorkflowPhase(file, 'child')).toBe('awaiting_plan_approval');
  });
});
