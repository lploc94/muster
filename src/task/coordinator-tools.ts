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

export const PRESENTATION_ID_MAX_LENGTH = 128;
export const PRESENTATION_TITLE_MAX_LENGTH = 200;
export const PRESENTATION_MARKDOWN_MAX_LENGTH = 100_000;

const PRESENTATION_KEYS = new Set([
  'presentationId',
  'ownerTaskId',
  'opId',
  'revision',
  'title',
  'markdown',
]);
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type ToolCommand =
  | { kind: 'create_task'; opId: string; spec: CreateChildSpec }
  | { kind: 'delegate_task'; opId: string; spec: CreateChildSpec }
  | {
      kind: 'release_tasks';
      opId: string;
      taskIds: string[];
      includeDependencies?: boolean;
    }
  | { kind: 'start_task'; opId: string; childId: string }
  | { kind: 'interrupt_task'; opId: string; childId: string }
  | { kind: 'cancel_task'; opId: string; childId: string }
  | { kind: 'wait_for_tasks'; opId: string; taskIds: string[] }
  | { kind: 'get_task_status'; taskId?: string }
  | { kind: 'complete_task'; opId: string; result: string }
  | { kind: 'fail_task'; opId: string; error: string }
  | { kind: 'report_progress'; opId: string; note: string }
  | { kind: 'ask_user'; opId: string; questions: Question[] }
  | {
      kind: 'upsert_presentation';
      presentationId: string;
      ownerTaskId: string;
      opId: string;
      revision: number;
      title: string;
      markdown: string;
    };

const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'create_task',
  'delegate_task',
  'release_tasks',
  'start_task',
  'interrupt_task',
  'cancel_task',
  'wait_for_tasks',
  'complete_task',
  'fail_task',
  'report_progress',
  'ask_user',
  'upsert_presentation',
]);

function toolActionForName(name: string): ToolAction | undefined {
  const actions: ToolAction[] = [
    'create_task',
    'delegate_task',
    'release_tasks',
    'start_task',
    'interrupt_task',
    'cancel_task',
    'wait_for_tasks',
    'get_task_status',
    'complete_task',
    'fail_task',
    'report_progress',
    'ask_user',
    'upsert_presentation',
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

function isStablePresentationId(value: string | undefined): value is string {
  return value !== undefined && value.length <= PRESENTATION_ID_MAX_LENGTH && STABLE_ID_PATTERN.test(value);
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPresentationPayloadTooLarge(args: Record<string, unknown>): boolean {
  return (
    (typeof args.presentationId === 'string' && args.presentationId.length > PRESENTATION_ID_MAX_LENGTH) ||
    (typeof args.ownerTaskId === 'string' && args.ownerTaskId.length > PRESENTATION_ID_MAX_LENGTH) ||
    (typeof args.opId === 'string' && args.opId.length > PRESENTATION_ID_MAX_LENGTH) ||
    (typeof args.title === 'string' && args.title.length > PRESENTATION_TITLE_MAX_LENGTH) ||
    (typeof args.markdown === 'string' && args.markdown.length > PRESENTATION_MARKDOWN_MAX_LENGTH)
  );
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
    return {
      ok: false,
      toolError: tool === 'upsert_presentation' ? 'unauthorized' : `action not permitted: ${tool}`,
    };
  }
  if (!isRecord(args)) {
    return {
      ok: false,
      toolError: tool === 'upsert_presentation' ? 'invalid_arguments' : 'arguments must be an object',
    };
  }

  if (MUTATING_TOOLS.has(tool)) {
    const opId = requireString(args, 'opId');
    if (!opId) {
      return {
        ok: false,
        toolError: tool === 'upsert_presentation' ? 'invalid_arguments' : 'opId is required',
      };
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
      case 'release_tasks': {
        const raw = args.taskIds;
        if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => typeof id === 'string' && id.length > 0)) {
          return { ok: false, toolError: 'taskIds must be a non-empty string array' };
        }
        const includeDependencies =
          args.includeDependencies === undefined ? false : args.includeDependencies === true;
        if (args.includeDependencies !== undefined && typeof args.includeDependencies !== 'boolean') {
          return { ok: false, toolError: 'includeDependencies must be a boolean' };
        }
        return {
          ok: true,
          command: {
            kind: 'release_tasks',
            opId,
            taskIds: raw as string[],
            includeDependencies,
          },
        };
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
      case 'upsert_presentation': {
        if (isPresentationPayloadTooLarge(args)) {
          return { ok: false, toolError: 'payload_too_large' };
        }
        const presentationId = requireString(args, 'presentationId');
        const ownerTaskId = requireString(args, 'ownerTaskId');
        const title = requireString(args, 'title');
        const markdown = requireString(args, 'markdown');
        if (
          Object.keys(args).some((key) => !PRESENTATION_KEYS.has(key)) ||
          !isStablePresentationId(presentationId) ||
          !isStablePresentationId(ownerTaskId) ||
          !isStablePresentationId(opId) ||
          !isPositiveSafeInt(args.revision) ||
          !title ||
          !markdown
        ) {
          return { ok: false, toolError: 'invalid_arguments' };
        }
        if (ownerTaskId !== ctx.callerTaskId) {
          return { ok: false, toolError: 'owner_mismatch' };
        }
        return {
          ok: true,
          command: {
            kind: 'upsert_presentation',
            presentationId,
            ownerTaskId,
            opId,
            revision: args.revision,
            title,
            markdown,
          },
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