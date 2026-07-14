import type { MusterTask, TaskCapability } from './types';

export type CoordinatorAction =
  | 'create_task'
  | 'delegate_task'
  | 'start_task'
  | 'interrupt_task'
  | 'cancel_task'
  | 'wait_for_tasks'
  | 'get_task_status'
  | 'upsert_presentation';

export type AnyTaskAction = 'complete_task' | 'fail_task' | 'report_progress' | 'ask_user';

/** Typed planner artifact submission (host validates; never infers from markdown). */
export type WorkflowArtifactAction = 'submit_decision_brief' | 'submit_plan_artifact';

export type ToolAction = CoordinatorAction | AnyTaskAction | WorkflowArtifactAction;

const CAPABILITY_TO_ACTIONS: Record<TaskCapability, CoordinatorAction[]> = {
  create_child: ['create_task', 'delegate_task'],
  start_child: ['start_task'],
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