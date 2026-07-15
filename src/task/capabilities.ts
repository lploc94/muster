import type { MusterTask, TaskCapability } from './types';

export type CoordinatorAction =
  | 'create_task'
  | 'delegate_task'
  | 'create_tasks'
  | 'delegate_tasks'
  | 'release_tasks'
  | 'list_task_types'
  | 'start_task'
  | 'interrupt_task'
  | 'cancel_task'
  | 'cancel_tasks'
  | 'continue_child'
  | 'set_task_lifecycle'
  | 'wait_for_tasks'
  | 'get_task_status'
  | 'upsert_presentation'
  | 'answer_child_question';

export type AnyTaskAction =
  | 'complete_task'
  | 'fail_task'
  | 'report_progress'
  | 'ask_user'
  | 'ask_parent'
  | 'get_host_context';

export type ToolAction = CoordinatorAction | AnyTaskAction;

const CAPABILITY_TO_ACTIONS: Record<TaskCapability, CoordinatorAction[]> = {
  // create_child owns draft create + atomic release + create-and-run delegate + type list.
  // Batch variants (create_tasks/delegate_tasks) share the same capability: workers stay
  // blocked via the role gate below, so they cannot call the batch tools either.
  create_child: [
    'create_task',
    'delegate_task',
    'create_tasks',
    'delegate_tasks',
    'release_tasks',
    'list_task_types',
    // Follow-up instruction on a direct child (reopen/queue new turn).
    'continue_child',
  ],
  // start_task is host/recovery only — not granted via coordinator MCP credentials.
  start_child: [],
  wait_child: ['wait_for_tasks'],
  interrupt_child: ['interrupt_task'],
  cancel_child: [
    'cancel_task',
    'cancel_tasks',
    'set_task_lifecycle',
    'answer_child_question',
  ],
  read_subtree: ['get_task_status'],
};

const ANY_TASK_ACTIONS: AnyTaskAction[] = [
  'complete_task',
  'fail_task',
  'report_progress',
  'get_host_context',
];

export function capabilitiesFor(
  task: Pick<MusterTask, 'role' | 'capabilities' | 'parentId'>,
): Set<ToolAction> {
  const granted = new Set<ToolAction>(ANY_TASK_ACTIONS);
  // Root may ask the user; non-root uses ask_parent by default.
  if (task.parentId === null || task.parentId === undefined) {
    granted.add('ask_user');
  } else {
    granted.add('ask_parent');
  }
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