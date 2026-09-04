import type { MusterTask, TaskCapability, TaskTurn } from './types';

export type CoordinatorAction =
  | 'create_task'
  | 'delegate_task'
  | 'create_tasks'
  | 'delegate_tasks'
  | 'release_tasks'
  | 'list_task_types'
  | 'list_predefined_workflows'
  | 'get_predefined_workflow'
  | 'interrupt_task'
  | 'cancel_task'
  | 'cancel_tasks'
  | 'continue_child'
  | 'set_task_lifecycle'
  | 'wait_for_tasks'
  | 'inspect_workflow_run'
  | 'upsert_presentation'
  | 'answer_child_question'
  | 'define_workflow'
  | 'start_workflow';

export type AnyTaskAction =
  | 'complete_task'
  | 'fail_task'
  | 'ask_parent'
  | 'get_host_context'
  /** M018 S02: stage workflow NEXT disposition (does not seal lifecycle). */
  | 'workflow_next'
  /** M018 S04: stage workflow PREV disposition (does not seal lifecycle). */
  | 'workflow_prev'
  /** M018 S05: stage workflow FAIL disposition (does not seal lifecycle). */
  | 'workflow_fail';

export type ToolAction = CoordinatorAction | AnyTaskAction;

export const PUBLIC_MCP_TOOL_ACTIONS = [
  'create_task',
  'delegate_task',
  'wait_for_tasks',
  'list_task_types',
  'list_predefined_workflows',
  'get_predefined_workflow',
  'inspect_workflow_run',
  'get_host_context',
  'upsert_presentation',
  'define_workflow',
  'start_workflow',
  'workflow_next',
  'workflow_prev',
  'workflow_fail',
] as const satisfies readonly ToolAction[];

export type PublicMcpToolAction = (typeof PUBLIC_MCP_TOOL_ACTIONS)[number];

const PUBLIC_MCP_TOOL_ACTION_SET: ReadonlySet<string> = new Set(PUBLIC_MCP_TOOL_ACTIONS);

export function isPublicMcpToolAction(action: string): action is PublicMcpToolAction {
  return PUBLIC_MCP_TOOL_ACTION_SET.has(action);
}

const CAPABILITY_TO_ACTIONS: Record<TaskCapability, CoordinatorAction[]> = {
  create_child: [
    'list_task_types',
    'list_predefined_workflows',
    'get_predefined_workflow',
  ],
  start_child: [],
  wait_child: [],
  interrupt_child: [],
  cancel_child: [],
  read_subtree: ['inspect_workflow_run'],
};

const ANY_TASK_ACTIONS: AnyTaskAction[] = [
  'get_host_context',
];

export interface CapabilityContext {
  turn?: Pick<TaskTurn, 'status' | 'workflowActivation'>;
  workspaceTrusted?: boolean;
}

export function capabilitiesFor(
  task: Pick<MusterTask, 'role' | 'capabilities' | 'parentId' | 'lifecycle'>,
  context: CapabilityContext = {},
): Set<ToolAction> {
  const granted = new Set<ToolAction>(ANY_TASK_ACTIONS);
  const turn = context.turn;
  const isLiveTurn = turn?.status === 'queued' || turn?.status === 'running' || turn?.status === 'waiting_user';
  const canReadWorkflow = task.role === 'coordinator' &&
    task.parentId == null && task.lifecycle === 'open' && isLiveTurn &&
    turn?.workflowActivation === undefined && context.workspaceTrusted !== false;
  if (task.role === 'coordinator') {
    granted.add('upsert_presentation');
    for (const cap of task.capabilities) {
      for (const action of CAPABILITY_TO_ACTIONS[cap] ?? []) {
        if ((action === 'list_predefined_workflows' || action === 'get_predefined_workflow' || action === 'inspect_workflow_run') && !canReadWorkflow) continue;
        granted.add(action);
      }
    }
  }

  const activation = turn?.workflowActivation;
  const isLiveActivation =
    isLiveTurn &&
    activation?.runStatus === 'running' &&
    (activation.activationStatus === 'queued' || activation.activationStatus === 'running');
  if (isLiveActivation) {
    const outcome = activation.decision?.outcome;
    if (!outcome || outcome.next) granted.add('workflow_next');
    if (
      activation.hasDirectDependencies &&
      (!outcome || (outcome.prev !== undefined && outcome.prev.length > 0))
    ) granted.add('workflow_prev');
    if (!outcome || outcome.fail) granted.add('workflow_fail');
    if (task.role === 'coordinator' && task.capabilities.includes('create_child')) {
      granted.add('create_task');
      granted.add('delegate_task');
      if (task.capabilities.includes('wait_child')) granted.add('wait_for_tasks');
    }
  }

  const canMutateWorkflows =
    isLiveTurn &&
    context.workspaceTrusted !== false &&
    task.lifecycle === 'open' &&
    task.role === 'coordinator' &&
    task.capabilities.includes('create_child') &&
    activation === undefined &&
    (task.parentId === null || task.parentId === undefined);
  if (canMutateWorkflows) {
    granted.add('define_workflow');
    granted.add('start_workflow');
  }
  return granted;
}
