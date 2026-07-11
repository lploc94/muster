/**
 * Phase-aware Muster Bridge action gating.
 * Intersects task role capabilities with workflow phase policy.
 */

import {
  PLANNER_DENIED_BRIDGE_ACTIONS,
  bridgeActionsForPhase,
  isPreApprovalPhase,
  type BridgeActionName,
  type WorkflowPhase,
} from './contracts';
import { capabilitiesFor, type ToolAction } from '../task/capabilities';
import type { MusterTask } from '../task/types';
import type { TaskStoreFile } from '../task/types';
import { getWorkflowRunForRoot } from './store';

export type ExtendedToolAction = ToolAction | 'submit_decision_brief' | 'submit_plan_artifact';

const ARTIFACT_ACTIONS: ExtendedToolAction[] = [
  'submit_decision_brief',
  'submit_plan_artifact',
];

/**
 * Resolve workflow phase for a caller task (walks to root).
 * Missing workflow run → treat as draft (safest: no execution tools).
 */
export function resolveWorkflowPhase(
  file: Pick<TaskStoreFile, 'tasks' | 'workflowRuns'>,
  taskId: string,
): WorkflowPhase {
  let current = file.tasks[taskId];
  if (!current) return 'draft';
  while (current.parentId) {
    const parent = file.tasks[current.parentId];
    if (!parent) break;
    current = parent;
  }
  const run = getWorkflowRunForRoot(file, current.id);
  return run?.phase ?? 'draft';
}

/**
 * Actions granted for a turn: role capabilities ∩ phase policy + artifact tools when planning.
 */
export function phaseAwareActions(
  task: Pick<MusterTask, 'role' | 'capabilities' | 'id' | 'parentId'>,
  phase: WorkflowPhase,
): Set<ExtendedToolAction> {
  const roleActions = capabilitiesFor(task) as Set<ExtendedToolAction>;
  const phaseActions = bridgeActionsForPhase(phase);

  // Map BridgeActionName → ExtendedToolAction (same string names)
  const allowed = new Set<ExtendedToolAction>();
  for (const action of roleActions) {
    if (phaseActions.has(action as BridgeActionName)) {
      allowed.add(action);
    }
  }

  // Artifact submit tools: available in pre-approval and when phase policy includes them
  for (const a of ARTIFACT_ACTIONS) {
    if (phaseActions.has(a as BridgeActionName)) {
      allowed.add(a);
    }
  }

  // Hard deny list during pre-approval regardless of role
  if (isPreApprovalPhase(phase)) {
    for (const denied of PLANNER_DENIED_BRIDGE_ACTIONS) {
      allowed.delete(denied as ExtendedToolAction);
    }
  }

  return allowed;
}

export function actionsForTaskInStore(
  file: TaskStoreFile,
  task: Pick<MusterTask, 'role' | 'capabilities' | 'id' | 'parentId'>,
): Set<ExtendedToolAction> {
  const phase = resolveWorkflowPhase(file, task.id);
  return phaseAwareActions(task, phase);
}

/** Structured denial for bridge dispatch. */
export function denyReasonForAction(
  action: string,
  phase: WorkflowPhase,
): { code: 'PHASE_NOT_APPROVED' | 'CAPABILITY_DENIED'; message: string } | undefined {
  if (
    isPreApprovalPhase(phase) &&
    (PLANNER_DENIED_BRIDGE_ACTIONS as readonly string[]).includes(action)
  ) {
    return {
      code: 'PHASE_NOT_APPROVED',
      message: `action '${action}' is not allowed in phase '${phase}' (plan approval required)`,
    };
  }
  const phaseActions = bridgeActionsForPhase(phase);
  if (!phaseActions.has(action as BridgeActionName) && !(ARTIFACT_ACTIONS as string[]).includes(action)) {
    return {
      code: 'CAPABILITY_DENIED',
      message: `action '${action}' is not available in phase '${phase}'`,
    };
  }
  return undefined;
}
