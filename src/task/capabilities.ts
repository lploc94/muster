import type { MusterTask, TaskCapability } from './types';

export type CoordinatorAction =
  | 'create_task'
  | 'delegate_task'
  | 'release_tasks'
  | 'start_task'
  | 'interrupt_task'
  | 'cancel_task'
  | 'wait_for_tasks'
  | 'get_task_status'
  | 'upsert_presentation';

export type AnyTaskAction = 'complete_task' | 'fail_task' | 'report_progress' | 'ask_user';

export type ToolAction = CoordinatorAction | AnyTaskAction;

const CAPABILITY_TO_ACTIONS: Record<TaskCapability, CoordinatorAction[]> = {
  // create_child owns draft create + atomic release + create-and-run delegate.
  create_child: ['create_task', 'delegate_task', 'release_tasks'],
  // start_task is host/recovery only — not granted via coordinator MCP credentials.
  start_child: [],
  wait_child: ['wait_for_tasks'],
  interrupt_child: ['interrupt_task'],
  cancel_child: ['cancel_task'],
  read_subtree: ['get_task_status'],
};

const ANY_TASK_ACTIONS: AnyTaskAction[] = [
  'complete_task',
  'fail_task',
  'report_progress',
  'ask_user',
];

export function capabilitiesFor(
  task: Pick<MusterTask, 'role' | 'capabilities'>,
): Set<ToolAction> {
  const granted = new Set<ToolAction>(ANY_TASK_ACTIONS);
  if (task.role === 'coordinator') {
    granted.add('upsert_presentation');
    for (const cap of task.capabilities) {
      for (const action of CAPABILITY_TO_ACTIONS[cap] ?? []) {
        granted.add(action);
      }
    }
  }
  return granted;
}