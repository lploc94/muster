import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from './capabilities';

describe('capabilitiesFor', () => {
  it('grants only workflow-authoring and run-inspection tools from coordinator capabilities', () => {
    const caps = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
      parentId: null,
      lifecycle: 'open',
    }, {
      turn: { status: 'running' },
      workspaceTrusted: true,
    });
    expect(caps.has('list_task_types')).toBe(true);
    expect(caps.has('define_workflow')).toBe(true);
    expect(caps.has('start_workflow')).toBe(true);
    expect(caps.has('inspect_workflow_run')).toBe(true);
    expect(caps.has('create_task')).toBe(false);
    expect(caps.has('delegate_task')).toBe(false);
    expect(caps.has('wait_for_tasks')).toBe(false);
    expect(caps.has('interrupt_task')).toBe(false);
  });

  it('grants presentation upserts to coordinators by role', () => {
    const caps = capabilitiesFor({
      role: 'coordinator', capabilities: [], parentId: null, lifecycle: 'open',
    });

    expect(caps.has('upsert_presentation')).toBe(true);
  });

  it('grants only any-task actions to workers', () => {
    const caps = capabilitiesFor({
      role: 'worker',
      capabilities: ['create_child'],
      parentId: 'root',
      lifecycle: 'open',
    });
    expect(caps.has('create_task')).toBe(false);
    expect(caps.has('create_tasks')).toBe(false);
    expect(caps.has('delegate_tasks')).toBe(false);
    expect(caps.has('list_task_types')).toBe(false);
    expect(caps.has('upsert_presentation')).toBe(false);
    expect(caps.has('complete_task')).toBe(false);
    expect(caps.has('ask_parent')).toBe(false);
    expect(caps.has('get_host_context')).toBe(true);
    expect(caps.has('inspect_workflow_run')).toBe(false);
  });

  it('grants get_host_context to coordinators and workers', () => {
    expect(
      capabilitiesFor({
        role: 'coordinator', capabilities: [], parentId: null, lifecycle: 'open',
      }).has(
        'get_host_context',
      ),
    ).toBe(true);
    expect(
      capabilitiesFor({
        role: 'worker', capabilities: [], parentId: 'root', lifecycle: 'open',
      }).has(
        'get_host_context',
      ),
    ).toBe(true);
  });

  it('does not project legacy delegate-task controls from internal capabilities', () => {
    const caps = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['cancel_child'],
      parentId: null,
      lifecycle: 'open',
    });
    expect(caps.has('cancel_task')).toBe(false);
    expect(caps.has('set_task_lifecycle')).toBe(false);
    expect(caps.has('answer_child_question')).toBe(false);
  });

  it('grants workflow authoring only to a live trusted open root coordinator', () => {
    const coordinator = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['create_child'],
      parentId: null,
      lifecycle: 'open',
    }, {
      turn: { status: 'running' },
      workspaceTrusted: true,
    });
    expect(coordinator.has('define_workflow')).toBe(true);
    expect(coordinator.has('start_workflow')).toBe(true);

    const worker = capabilitiesFor({
      role: 'worker',
      capabilities: ['create_child'],
      parentId: 'root',
      lifecycle: 'open',
    }, {
      turn: { status: 'running' },
    });
    expect(worker.has('define_workflow')).toBe(false);
    expect(worker.has('start_workflow')).toBe(false);

    for (const denied of [
      capabilitiesFor({
        role: 'coordinator', capabilities: ['create_child'], parentId: 'root', lifecycle: 'open',
      }, { turn: { status: 'running' }, workspaceTrusted: true }),
      capabilitiesFor({
        role: 'coordinator', capabilities: ['create_child'], parentId: null, lifecycle: 'failed',
      }, { turn: { status: 'running' }, workspaceTrusted: true }),
      capabilitiesFor({
        role: 'coordinator', capabilities: ['create_child'], parentId: null, lifecycle: 'open',
      }, { turn: { status: 'running' }, workspaceTrusted: false }),
      capabilitiesFor({
        role: 'coordinator', capabilities: ['create_child'], parentId: null, lifecycle: 'open',
      }),
    ]) {
      expect(denied.has('define_workflow')).toBe(false);
      expect(denied.has('start_workflow')).toBe(false);
    }
  });

  it('does not grant workflow mutations without a live workflow activation', () => {
    const worker = capabilitiesFor({
      role: 'worker',
      capabilities: [],
      parentId: 'root',
      lifecycle: 'open',
    });
    expect(worker.has('workflow_next')).toBe(false);
    expect(worker.has('workflow_prev')).toBe(false);
    expect(worker.has('workflow_fail')).toBe(false);
    expect([...worker]).not.toContain('invoke_child_workflow');
    expect(worker.has('complete_task')).toBe(false);
  });

  it('derives workflow actions from the live activation route', () => {
    const worker = capabilitiesFor({
      role: 'worker',
      capabilities: [],
      parentId: 'root',
      lifecycle: 'open',
    }, {
      turn: {
        status: 'running',
        workflowActivation: {
          runId: 'run',
          activationId: 'activation',
          nodeId: 'consumer',
          kind: 'dependency_gate',
          runStatus: 'running',
          activationStatus: 'running',
          isTerminalNode: false,
          hasDirectDependencies: true,
          hasOpenFeedbackRound: false,
          hasPendingContinuation: false,
          hasInheritedFeedbackResponse: false,
        },
      },
    });
    expect(worker.has('workflow_next')).toBe(true);
    expect(worker.has('workflow_prev')).toBe(true);
    expect(worker.has('workflow_fail')).toBe(true);
    expect([...worker]).not.toContain('invoke_child_workflow');
    expect(worker.has('complete_task')).toBe(false);
    expect(worker.has('fail_task')).toBe(false);
    expect(worker.has('wait_for_tasks')).toBe(false);
    expect(worker.has('ask_parent')).toBe(false);
  });

  it('projects only dispositions declared by the frozen agent outcome', () => {
    const task = {
      role: 'worker' as const,
      capabilities: [],
      parentId: 'root',
      lifecycle: 'open' as const,
    };
    const activation = {
      runId: 'run',
      activationId: 'activation',
      nodeId: 'consumer',
      kind: 'dependency_gate' as const,
      runStatus: 'running' as const,
      activationStatus: 'running' as const,
      isTerminalNode: false,
      hasDirectDependencies: true,
      hasOpenFeedbackRound: false,
      hasPendingContinuation: false,
      hasInheritedFeedbackResponse: false,
      decision: {
        attempt: 1 as const,
        outcome: {
          kind: 'agent' as const,
          requireExplicitDisposition: true,
          next: { when: 'ready' },
          fail: { when: 'cannot continue' },
        },
      },
    };

    const nextOrFail = capabilitiesFor(task, {
      turn: { status: 'running', workflowActivation: activation } as any,
    });
    expect(nextOrFail.has('workflow_next')).toBe(true);
    expect(nextOrFail.has('workflow_prev')).toBe(false);
    expect(nextOrFail.has('workflow_fail')).toBe(true);

    const prevOnly = capabilitiesFor(task, {
      turn: {
        status: 'running',
        workflowActivation: {
          ...activation,
          decision: {
            attempt: 2,
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: true,
              prev: [{ when: 'revise', targets: ['source'], feedback: 'required' }],
            },
          },
        },
      } as any,
    });
    expect(prevOnly.has('workflow_next')).toBe(false);
    expect(prevOnly.has('workflow_prev')).toBe(true);
    expect(prevOnly.has('workflow_fail')).toBe(false);
  });

  it('keeps ordinary delegation but removes authoring from workflow coordinators', () => {
    const coordinator = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child'],
      parentId: 'root',
      lifecycle: 'open',
    }, {
      turn: {
        status: 'running',
        workflowActivation: {
          runId: 'run',
          activationId: 'activation',
          nodeId: 'consumer',
          kind: 'dependency_gate',
          runStatus: 'running',
          activationStatus: 'running',
          isTerminalNode: false,
          hasDirectDependencies: true,
          hasOpenFeedbackRound: false,
          hasPendingContinuation: false,
          hasInheritedFeedbackResponse: false,
        },
      },
    });

    expect(coordinator.has('list_task_types')).toBe(true);
    expect(coordinator.has('define_workflow')).toBe(false);
    expect(coordinator.has('start_workflow')).toBe(false);
    expect(coordinator.has('create_task')).toBe(true);
    expect(coordinator.has('delegate_task')).toBe(true);
    expect(coordinator.has('continue_child')).toBe(false);
    expect(coordinator.has('wait_for_tasks')).toBe(true);
    expect(coordinator.has('complete_task')).toBe(false);
    expect(coordinator.has('workflow_next')).toBe(true);
    expect([...coordinator]).not.toContain('invoke_child_workflow');
  });

  it('never projects the retired nested-workflow action', () => {
    const coordinator = {
      role: 'coordinator' as const,
      capabilities: ['create_child' as const],
      parentId: null,
      lifecycle: 'open' as const,
    };
    expect([...capabilitiesFor(coordinator, {
      turn: { status: 'running' },
      workspaceTrusted: true,
    })]).not.toContain('invoke_child_workflow');

    expect([...capabilitiesFor(coordinator, {
      turn: {
        status: 'running',
        workflowActivation: {
          runId: 'run',
          activationId: 'activation',
          nodeId: 'terminal',
          kind: 'dependency_gate',
          runStatus: 'running',
          activationStatus: 'running',
          isTerminalNode: true,
          hasDirectDependencies: true,
          hasOpenFeedbackRound: false,
          hasPendingContinuation: false,
          hasInheritedFeedbackResponse: false,
        },
      },
      workspaceTrusted: true,
    })]).not.toContain('invoke_child_workflow');
  });
});
