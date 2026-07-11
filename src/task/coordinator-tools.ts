import type { Question } from '../bridge/ask-bridge';
import type { CredentialContext } from '../bridge/credentials';
import type { ToolAction } from './capabilities';
import type { TaskDependency, TaskExecutionPolicy, TaskRole } from './types';

export interface CreateChildSpec {
  goal: string;
  backend: string;
  role?: TaskRole;
  dependencies?: TaskDependency[];
  executionPolicy?: Partial<TaskExecutionPolicy>;
}

export type ToolCommand =
  | { kind: 'create_task'; opId: string; spec: CreateChildSpec }
  | { kind: 'delegate_task'; opId: string; spec: CreateChildSpec }
  | { kind: 'start_task'; opId: string; childId: string }
  | { kind: 'interrupt_task'; opId: string; childId: string }
  | { kind: 'cancel_task'; opId: string; childId: string }
  | { kind: 'wait_for_tasks'; opId: string; taskIds: string[] }
  | { kind: 'get_task_status'; taskId?: string }
  | { kind: 'complete_task'; opId: string; result: string }
  | { kind: 'fail_task'; opId: string; error: string }
  | { kind: 'report_progress'; opId: string; note: string }
  | { kind: 'ask_user'; opId: string; questions: Question[] }
  | { kind: 'submit_decision_brief'; opId: string; artifact: unknown }
  | { kind: 'submit_plan_artifact'; opId: string; artifact: unknown };

const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'create_task',
  'delegate_task',
  'start_task',
  'interrupt_task',
  'cancel_task',
  'wait_for_tasks',
  'complete_task',
  'fail_task',
  'report_progress',
  'ask_user',
  'submit_decision_brief',
  'submit_plan_artifact',
]);

function toolActionForName(name: string): ToolAction | undefined {
  const actions: ToolAction[] = [
    'create_task',
    'delegate_task',
    'start_task',
    'interrupt_task',
    'cancel_task',
    'wait_for_tasks',
    'get_task_status',
    'complete_task',
    'fail_task',
    'report_progress',
    'ask_user',
    'submit_decision_brief',
    'submit_plan_artifact',
  ];
  return actions.find((a) => a === name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseDependency(value: unknown): TaskDependency | undefined {
  if (!isRecord(value)) return undefined;
  const taskId = requireString(value, 'taskId');
  const requiredOutcome = value.requiredOutcome;
  const onUnsatisfied = value.onUnsatisfied;
  if (
    !taskId ||
    (requiredOutcome !== 'succeeded' && requiredOutcome !== 'settled') ||
    (onUnsatisfied !== 'block' && onUnsatisfied !== 'fail' && onUnsatisfied !== 'skip')
  ) {
    return undefined;
  }
  return { taskId, requiredOutcome, onUnsatisfied };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseExecutionPolicy(value: Record<string, unknown>): Partial<TaskExecutionPolicy> | undefined {
  const policy: Partial<TaskExecutionPolicy> = {};
  if ('maxTurns' in value) {
    const maxTurns = positiveInt(value.maxTurns);
    if (maxTurns === undefined) return undefined;
    policy.maxTurns = maxTurns;
  }
  if ('maxAutomaticRetries' in value) {
    const maxAutomaticRetries = nonNegativeInt(value.maxAutomaticRetries);
    if (maxAutomaticRetries === undefined) return undefined;
    policy.maxAutomaticRetries = maxAutomaticRetries;
  }
  if ('turnTimeoutMs' in value) {
    const turnTimeoutMs = positiveInt(value.turnTimeoutMs);
    if (turnTimeoutMs === undefined) return undefined;
    policy.turnTimeoutMs = turnTimeoutMs;
  }
  if ('taskTimeoutMs' in value) {
    const taskTimeoutMs = positiveInt(value.taskTimeoutMs);
    if (taskTimeoutMs === undefined) return undefined;
    policy.taskTimeoutMs = taskTimeoutMs;
  }
  return policy;
}

function parseQuestions(value: unknown): Question[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: Question[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.prompt !== 'string' || entry.prompt.length === 0) {
      return undefined;
    }
    const q: Question = { prompt: entry.prompt };
    if (entry.options !== undefined) {
      if (!Array.isArray(entry.options) || !entry.options.every((o) => typeof o === 'string')) {
        return undefined;
      }
      q.options = entry.options as string[];
    }
    if (entry.allowFreeText !== undefined && typeof entry.allowFreeText !== 'boolean') {
      return undefined;
    }
    if (typeof entry.allowFreeText === 'boolean') q.allowFreeText = entry.allowFreeText;
    out.push(q);
  }
  return out;
}

function parseCreateSpec(args: Record<string, unknown>): CreateChildSpec | undefined {
  const goal = requireString(args, 'goal');
  const backend = requireString(args, 'backend');
  if (!goal || !backend) {
    return undefined;
  }
  const spec: CreateChildSpec = { goal, backend };
  if (typeof args.role === 'string' && (args.role === 'coordinator' || args.role === 'worker')) {
    spec.role = args.role;
  }
  if (args.dependencies !== undefined) {
    if (!Array.isArray(args.dependencies)) return undefined;
    const deps: TaskDependency[] = [];
    for (const entry of args.dependencies) {
      const dep = parseDependency(entry);
      if (!dep) return undefined;
      deps.push(dep);
    }
    spec.dependencies = deps;
  }
  if (args.executionPolicy !== undefined) {
    if (!isRecord(args.executionPolicy)) return undefined;
    const allowed = new Set(['maxTurns', 'maxAutomaticRetries', 'turnTimeoutMs', 'taskTimeoutMs']);
    if (Object.keys(args.executionPolicy).some((k) => !allowed.has(k))) return undefined;
    const policy = parseExecutionPolicy(args.executionPolicy);
    if (policy === undefined) return undefined;
    spec.executionPolicy = policy;
  }
  return spec;
}

export function dispatch(
  tool: string,
  args: unknown,
  ctx: CredentialContext,
): { ok: true; command: ToolCommand } | { ok: false; toolError: string } {
  const action = toolActionForName(tool);
  if (!action) {
    return { ok: false, toolError: `unknown tool: ${tool}` };
  }
  if (!ctx.allowedActions.has(action)) {
    return { ok: false, toolError: `action not permitted: ${tool}` };
  }
  if (!isRecord(args)) {
    return { ok: false, toolError: 'arguments must be an object' };
  }

  if (MUTATING_TOOLS.has(tool)) {
    const opId = requireString(args, 'opId');
    if (!opId) {
      return { ok: false, toolError: 'opId is required' };
    }

    switch (tool) {
      case 'create_task': {
        const spec = parseCreateSpec(args);
        if (!spec) {
          return { ok: false, toolError: 'invalid create_task arguments' };
        }
        return { ok: true, command: { kind: 'create_task', opId, spec } };
      }
      case 'delegate_task': {
        const spec = parseCreateSpec(args);
        if (!spec) {
          return { ok: false, toolError: 'invalid delegate_task arguments' };
        }
        return { ok: true, command: { kind: 'delegate_task', opId, spec } };
      }
      case 'start_task': {
        const childId = requireString(args, 'childId') ?? requireString(args, 'taskId');
        if (!childId) {
          return { ok: false, toolError: 'childId is required' };
        }
        return { ok: true, command: { kind: 'start_task', opId, childId } };
      }
      case 'interrupt_task': {
        const childId = requireString(args, 'childId') ?? requireString(args, 'taskId');
        if (!childId) {
          return { ok: false, toolError: 'childId is required' };
        }
        return { ok: true, command: { kind: 'interrupt_task', opId, childId } };
      }
      case 'cancel_task': {
        const childId = requireString(args, 'childId') ?? requireString(args, 'taskId');
        if (!childId) {
          return { ok: false, toolError: 'childId is required' };
        }
        return { ok: true, command: { kind: 'cancel_task', opId, childId } };
      }
      case 'wait_for_tasks': {
        const raw = args.taskIds;
        if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => typeof id === 'string')) {
          return { ok: false, toolError: 'taskIds must be a non-empty string array' };
        }
        return { ok: true, command: { kind: 'wait_for_tasks', opId, taskIds: raw as string[] } };
      }
      case 'complete_task': {
        const result = requireString(args, 'result');
        if (!result) {
          return { ok: false, toolError: 'result is required' };
        }
        return { ok: true, command: { kind: 'complete_task', opId, result } };
      }
      case 'fail_task': {
        const error = requireString(args, 'error');
        if (!error) {
          return { ok: false, toolError: 'error is required' };
        }
        return { ok: true, command: { kind: 'fail_task', opId, error } };
      }
      case 'report_progress': {
        const note = requireString(args, 'note');
        if (!note) {
          return { ok: false, toolError: 'note is required' };
        }
        return { ok: true, command: { kind: 'report_progress', opId, note } };
      }
      case 'ask_user': {
        const questions = parseQuestions(args.questions);
        if (!questions) {
          return { ok: false, toolError: 'invalid questions array' };
        }
        return {
          ok: true,
          command: { kind: 'ask_user', opId, questions },
        };
      }
      case 'submit_decision_brief': {
        if (!('artifact' in args)) {
          return { ok: false, toolError: 'artifact is required' };
        }
        return {
          ok: true,
          command: { kind: 'submit_decision_brief', opId, artifact: args.artifact },
        };
      }
      case 'submit_plan_artifact': {
        if (!('artifact' in args)) {
          return { ok: false, toolError: 'artifact is required' };
        }
        return {
          ok: true,
          command: { kind: 'submit_plan_artifact', opId, artifact: args.artifact },
        };
      }
      default:
        return { ok: false, toolError: `unsupported mutating tool: ${tool}` };
    }
  }

  if (tool === 'get_task_status') {
    const taskId = typeof args.taskId === 'string' ? args.taskId : undefined;
    return { ok: true, command: { kind: 'get_task_status', taskId } };
  }

  return { ok: false, toolError: `unsupported tool: ${tool}` };
}