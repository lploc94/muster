import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from './capabilities';

describe('capabilitiesFor', () => {
  it('grants coordinator actions from capabilities', () => {
    const caps = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
    });
    expect(caps.has('create_task')).toBe(true);
    expect(caps.has('delegate_task')).toBe(true);
    expect(caps.has('create_tasks')).toBe(true);
    expect(caps.has('delegate_tasks')).toBe(true);
    expect(caps.has('release_tasks')).toBe(true);
    expect(caps.has('list_task_types')).toBe(true);
    expect(caps.has('wait_for_tasks')).toBe(true);
    expect(caps.has('get_task_status')).toBe(true);
    expect(caps.has('ask_user')).toBe(true);
    expect(caps.has('interrupt_task')).toBe(false);
    // start_task is host/recovery only — not granted via start_child or create_child.
    expect(caps.has('start_task')).toBe(false);
  });

  it('does not grant start_task even when start_child capability is present', () => {
    const caps = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['start_child'],
    });
    expect(caps.has('start_task')).toBe(false);
  });

  it('grants presentation upserts to coordinators by role', () => {
    const caps = capabilitiesFor({ role: 'coordinator', capabilities: [] });

    expect(caps.has('upsert_presentation')).toBe(true);
  });

  it('grants only any-task actions to workers', () => {
    const caps = capabilitiesFor({ role: 'worker', capabilities: ['create_child'] });
    expect(caps.has('create_task')).toBe(false);
    expect(caps.has('create_tasks')).toBe(false);
    expect(caps.has('delegate_tasks')).toBe(false);
    expect(caps.has('list_task_types')).toBe(false);
    expect(caps.has('upsert_presentation')).toBe(false);
    expect(caps.has('complete_task')).toBe(true);
    expect(caps.has('ask_user')).toBe(true);
    expect(caps.has('get_host_context')).toBe(true);
  });

  it('grants get_host_context to coordinators and workers', () => {
    expect(
      capabilitiesFor({ role: 'coordinator', capabilities: [] }).has('get_host_context'),
    ).toBe(true);
    expect(capabilitiesFor({ role: 'worker', capabilities: [] }).has('get_host_context')).toBe(
      true,
    );
  });

  it('maps cancel_child to cancel_task and set_task_lifecycle', () => {
    const caps = capabilitiesFor({
      role: 'coordinator',
      capabilities: ['cancel_child'],
    });
    expect(caps.has('cancel_task')).toBe(true);
    expect(caps.has('set_task_lifecycle')).toBe(true);
  });
});