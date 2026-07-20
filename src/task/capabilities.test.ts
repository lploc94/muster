import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from './capabilities';

describe('capabilitiesFor', () => {
  it('grants coordinator actions from capabilities', () => {
    const caps = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
      parentId: null,
    });
    expect(caps.has('create_task')).toBe(true);
    expect(caps.has('delegate_task')).toBe(true);
    expect(caps.has('create_tasks')).toBe(true);
    expect(caps.has('delegate_tasks')).toBe(true);
    expect(caps.has('release_tasks')).toBe(true);
    expect(caps.has('list_task_types')).toBe(true);
    expect(caps.has('wait_for_tasks')).toBe(true);
    expect(caps.has('get_task_status')).toBe(true);
    expect(caps.has('ask_parent')).toBe(false);
    expect(caps.has('interrupt_task')).toBe(false);
  });

  it('grants presentation upserts to coordinators by role', () => {
    const caps = capabilitiesFor({ role: 'coordinator', capabilities: [], parentId: null });

    expect(caps.has('upsert_presentation')).toBe(true);
  });

  it('grants only any-task actions to workers', () => {
    const caps = capabilitiesFor({
      role: 'worker',
      capabilities: ['create_child'],
      parentId: 'root',
    });
    expect(caps.has('create_task')).toBe(false);
    expect(caps.has('create_tasks')).toBe(false);
    expect(caps.has('delegate_tasks')).toBe(false);
    expect(caps.has('list_task_types')).toBe(false);
    expect(caps.has('upsert_presentation')).toBe(false);
    expect(caps.has('complete_task')).toBe(true);
    expect(caps.has('ask_parent')).toBe(true);
    expect(caps.has('get_host_context')).toBe(true);
  });

  it('grants get_host_context to coordinators and workers', () => {
    expect(
      capabilitiesFor({ role: 'coordinator', capabilities: [], parentId: null }).has(
        'get_host_context',
      ),
    ).toBe(true);
    expect(
      capabilitiesFor({ role: 'worker', capabilities: [], parentId: 'root' }).has(
        'get_host_context',
      ),
    ).toBe(true);
  });

  it('maps cancel_child to cancel_task and set_task_lifecycle', () => {
    const caps = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['cancel_child'],
      parentId: null,
    });
    expect(caps.has('cancel_task')).toBe(true);
    expect(caps.has('set_task_lifecycle')).toBe(true);
    expect(caps.has('answer_child_question')).toBe(true);
  });

  it('grants define_workflow and start_workflow via create_child to coordinators only', () => {
    const coordinator = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['create_child'],
      parentId: null,
    });
    expect(coordinator.has('define_workflow')).toBe(true);
    expect(coordinator.has('start_workflow')).toBe(true);

    const worker = capabilitiesFor({
      role: 'worker',
      capabilities: ['create_child'],
      parentId: 'root',
    });
    expect(worker.has('define_workflow')).toBe(false);
    expect(worker.has('start_workflow')).toBe(false);
  });

  it('grants workflow_next to any task role (does not require create_child)', () => {
    const worker = capabilitiesFor({
      role: 'worker',
      capabilities: [],
      parentId: 'root',
    });
    expect(worker.has('workflow_next')).toBe(true);
    expect(worker.has('complete_task')).toBe(true);

    const coordinator = capabilitiesFor({
      role: 'coordinator',
      capabilities: [],
      parentId: null,
    });
    expect(coordinator.has('workflow_next')).toBe(true);
  });
});