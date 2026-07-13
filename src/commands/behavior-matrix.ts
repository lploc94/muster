import {
  NATIVE_COMMAND_SPECS,
  type CommandEffectClass,
  type NativeCommandId,
  type WorkflowPhase,
} from '../workflow/contracts';
import type { CommandPresenterHint } from './types';

/**
 * Product/verification metadata for the native command registry. Dispatch and
 * phase enforcement remain in CommandService + TaskEngine; this fixture makes
 * it impossible for discovery surfaces to pretend a known stub is runnable.
 */
export type CommandAvailability = 'implemented' | 'disabled';

export interface CommandBehavior {
  id: NativeCommandId;
  aliases: readonly string[];
  availability: CommandAvailability;
  effectClass: CommandEffectClass;
  requiresTask: boolean;
  requiredPhases?: readonly WorkflowPhase[];
  requiresArgs: boolean;
  instantSafe: boolean;
  presenter: CommandPresenterHint;
  summary: string;
  successMessage: string;
  rejectionMessage: string;
  disabledReason?: string;
}

const DISABLED: Partial<Record<NativeCommandId, string>> = {
  fork: 'Continuation for terminal tasks is not implemented yet.',
  retry: 'Slash retry is not implemented yet; use the task recovery controls.',
};

const COMMANDS_REQUIRING_ARGS = new Set<NativeCommandId>([
  'debug',
  'focus',
  'backend',
  'model',
]);

const PRESENTER_BY_COMMAND: Record<NativeCommandId, CommandPresenterHint> = {
  think: 'plan_card',
  plan: 'plan_card',
  approve: 'approval',
  replan: 'plan_card',
  implement: 'message',
  test: 'message',
  review: 'message',
  debug: 'message',
  verify: 'message',
  finish: 'message',
  new: 'plan_card',
  tasks: 'task_list',
  status: 'status',
  focus: 'message',
  fork: 'error',
  cancel: 'message',
  retry: 'error',
  backend: 'message',
  model: 'message',
  mcp: 'message',
  help: 'help',
  context: 'context',
  compact: 'message',
  export: 'export',
  archive: 'message',
};

const SUCCESS_BY_COMMAND: Record<NativeCommandId, string> = {
  think: 'Creates a decision brief artifact and moves the workflow to thinking.',
  plan: 'Creates a plan artifact, proposed task graph, and waits for approval.',
  approve: 'Approves the pending plan and materializes ready child tasks.',
  replan: 'Moves the workflow back to planning while retaining old artifacts.',
  implement: 'Moves the workflow into implementation handoff.',
  test: 'Creates a test report artifact and queues a test turn.',
  review: 'Creates a review report artifact and queues a review turn.',
  debug: 'Creates a debug report artifact and queues a debug turn.',
  verify: 'Creates a verification report artifact and queues a verifier turn.',
  finish: 'Creates an outcome proposal without sealing lifecycle.',
  new: 'Creates a draft or workflow root task.',
  tasks: 'Lists non-archived tasks.',
  status: 'Shows task and workflow status.',
  focus: 'Focuses an existing task.',
  fork: 'Unavailable until terminal continuation is implemented.',
  cancel: 'Cancels the focused task after confirmation.',
  retry: 'Unavailable until slash retry is implemented.',
  backend: 'Sets the backend while the workflow is still pre-execution.',
  model: 'Sets or resets the model while the workflow is still pre-execution.',
  mcp: 'Shows MCP bridge configuration.',
  help: 'Lists native commands.',
  context: 'Shows workflow context, usage, artifacts, and open questions.',
  compact: 'Compacts transcript content while retaining workflow evidence.',
  export: 'Exports deterministic workflow content.',
  archive: 'Archives the workflow without changing lifecycle.',
};

export const COMMAND_BEHAVIOR: readonly CommandBehavior[] = NATIVE_COMMAND_SPECS.map((spec) => ({
  id: spec.id,
  aliases: spec.aliases,
  availability: DISABLED[spec.id] ? 'disabled' : 'implemented',
  effectClass: spec.effectClass,
  requiresTask: spec.requiresTask,
  ...(spec.requiredPhases ? { requiredPhases: spec.requiredPhases } : {}),
  requiresArgs: COMMANDS_REQUIRING_ARGS.has(spec.id),
  instantSafe: spec.effectClass === 'read' && !COMMANDS_REQUIRING_ARGS.has(spec.id),
  presenter: PRESENTER_BY_COMMAND[spec.id],
  summary: spec.summary,
  successMessage: SUCCESS_BY_COMMAND[spec.id],
  rejectionMessage: spec.requiresTask
    ? `/${spec.id} requires a focused task`
    : `/${spec.id} rejected invalid arguments or phase`,
  ...(DISABLED[spec.id] ? { disabledReason: DISABLED[spec.id] } : {}),
}));

export function behaviorForCommand(id: NativeCommandId): CommandBehavior {
  const behavior = COMMAND_BEHAVIOR.find((entry) => entry.id === id);
  if (!behavior) throw new Error(`missing command behavior for ${id}`);
  return behavior;
}
