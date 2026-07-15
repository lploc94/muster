import type { Question } from '../bridge/ask-bridge';
import type { CredentialContext } from '../bridge/credentials';
import type { TaskBriefOverlay } from './brief';
import { BRIEF_SECTION_MAX, clampSection, isTaskBriefKind } from './brief';
import type { ToolAction } from './capabilities';
import { isAllowedBindingOutput } from './dataflow';
import { TASK_TYPE_ID_RE } from './task-types';
import type {
  TaskDependency,
  TaskExecutionPolicy,
  TaskInputBinding,
  TaskResultOutputKey,
  TaskRole,
} from './types';

export interface CreateChildSpec {
  goal: string;
  /** Required routing key into muster.taskTypes (resolved at create/delegate). */
  taskType: string;
  /**
   * Optional user override for backend (only when user named it).
   * Resolved against the task type preset before persist.
   */
  backend?: string;
  /**
   * Optional ACP model id for this child (session config / set_model value).
   * When omitted, uses type preset model (if backend unchanged) or agent default.
   */
  model?: string;
  role?: TaskRole;
  dependencies?: TaskDependency[];
  executionPolicy?: Partial<TaskExecutionPolicy>;
  /** Optional longer description → brief.context when synthesizing. */
  description?: string;
  /** Partial brief overlay (merged with synthesize-from-goal at create). */
  brief?: TaskBriefOverlay;
  inputBindings?: TaskInputBinding[];
  claimsGit?: boolean;
  /** Convenience: merge into brief.writePaths when brief omits them. */
  writePaths?: string[];
  readPaths?: string[];
}

/**
 * Batch-binding shape: like {@link TaskInputBinding} but the producer may be a
 * sibling in the same batch (`fromLocalId`) or a pre-existing real task
 * (`fromTaskId`). Exactly one of the two is provided. The host maps `fromLocalId`
 * to the sibling's derived task id at expand time.
 */
export interface BatchInputBinding {
  fromLocalId?: string;
  fromTaskId?: string;
  output: TaskResultOutputKey;
  as: string;
  required?: boolean;
}

/**
 * One item of a batch create/delegate. Reuses the singular {@link CreateChildSpec}
 * fields plus a batch-local id, intra-batch ordering edges, and batch bindings.
 */
export interface BatchChildSpec extends Omit<CreateChildSpec, 'inputBindings'> {
  /** Unique-within-batch handle (pattern reuses TASK_TYPE_ID_RE). */
  localId: string;
  /** Sibling localIds this item waits for (→ succeeded/block dependency). */
  dependsOn?: string[];
  /** Batch bindings (sibling localId or pre-existing task id). */
  inputBindings?: BatchInputBinding[];
}

/**
 * Max children expanded by one batch create/delegate. Must stay ≤
 * DEFAULT_RESOURCE_LIMITS.maxChildrenPerTask (32) — the whole batch is rejected
 * before any write when it would exceed this cap.
 */
export const BATCH_EXPAND_MAX = 16;

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
  | { kind: 'create_tasks'; opId: string; specs: BatchChildSpec[] }
  | { kind: 'delegate_tasks'; opId: string; specs: BatchChildSpec[] }
  | {
      kind: 'release_tasks';
      opId: string;
      taskIds: string[];
      includeDependencies?: boolean;
    }
  | { kind: 'start_task'; opId: string; childId: string }
  | { kind: 'interrupt_task'; opId: string; childId: string }
  | { kind: 'cancel_task'; opId: string; childId: string }
  | {
      kind: 'set_task_lifecycle';
      opId: string;
      taskId: string;
      lifecycle: 'succeeded' | 'failed' | 'cancelled' | 'skipped';
      result?: string;
      error?: string;
      reason?: string;
    }
  | { kind: 'wait_for_tasks'; opId: string; taskIds: string[] }
  | { kind: 'get_task_status'; taskId?: string }
  | { kind: 'get_host_context' }
  | { kind: 'list_task_types' }
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
  'create_tasks',
  'delegate_tasks',
  'release_tasks',
  'start_task',
  'interrupt_task',
  'cancel_task',
  'set_task_lifecycle',
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
    'create_tasks',
    'delegate_tasks',
    'release_tasks',
    'start_task',
    'interrupt_task',
    'cancel_task',
    'set_task_lifecycle',
    'wait_for_tasks',
    'get_task_status',
    'get_host_context',
    'list_task_types',
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

const BRIEF_OVERLAY_KEYS = new Set([
  'kind',
  'title',
  'objective',
  'context',
  'nonGoals',
  'constraints',
  'acceptanceCriteria',
  'definitionOfDone',
  'readPaths',
  'writePaths',
  'verification',
]);

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined;
    out.push(entry);
  }
  return out;
}

function parseBriefOverlay(value: unknown): TaskBriefOverlay | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((k) => !BRIEF_OVERLAY_KEYS.has(k))) return undefined;
  const overlay: TaskBriefOverlay = {};
  if (value.kind !== undefined) {
    if (typeof value.kind !== 'string' || !isTaskBriefKind(value.kind)) return undefined;
    overlay.kind = value.kind;
  }
  for (const key of ['title', 'objective', 'context'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string') return undefined;
      overlay[key] = value[key] as string;
    }
  }
  for (const key of [
    'nonGoals',
    'constraints',
    'acceptanceCriteria',
    'definitionOfDone',
    'readPaths',
    'writePaths',
  ] as const) {
    if (value[key] !== undefined) {
      const list = parseStringArray(value[key]);
      if (!list) return undefined;
      overlay[key] = list;
    }
  }
  if (value.verification !== undefined) {
    if (!isRecord(value.verification)) return undefined;
    const vKeys = new Set(['commands', 'manualChecks']);
    if (Object.keys(value.verification).some((k) => !vKeys.has(k))) return undefined;
    const verification: { commands?: string[]; manualChecks?: string[] } = {};
    if (value.verification.commands !== undefined) {
      const list = parseStringArray(value.verification.commands);
      if (!list) return undefined;
      verification.commands = list;
    }
    if (value.verification.manualChecks !== undefined) {
      const list = parseStringArray(value.verification.manualChecks);
      if (!list) return undefined;
      verification.manualChecks = list;
    }
    overlay.verification = verification;
  }
  return overlay;
}

function parseInputBindings(value: unknown): TaskInputBinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TaskInputBinding[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const fromTaskId = typeof entry.fromTaskId === 'string' ? entry.fromTaskId : '';
    const as = typeof entry.as === 'string' ? entry.as : '';
    const output = typeof entry.output === 'string' ? entry.output : '';
    if (!fromTaskId || !as || !output) return undefined;
    if (!isAllowedBindingOutput(output)) return undefined;
    const binding: TaskInputBinding = { fromTaskId, output, as };
    if (entry.required !== undefined) {
      if (typeof entry.required !== 'boolean') return undefined;
      binding.required = entry.required;
    }
    const allowed = new Set(['fromTaskId', 'output', 'as', 'required']);
    if (Object.keys(entry).some((k) => !allowed.has(k))) return undefined;
    out.push(binding);
  }
  return out;
}

function parseCreateSpec(args: Record<string, unknown>): CreateChildSpec | undefined {
  const goal = requireString(args, 'goal');
  const taskType = requireString(args, 'taskType');
  if (!goal || !taskType) {
    return undefined;
  }
  const spec: CreateChildSpec = { goal, taskType };
  // Present-but-invalid optional routing fields fail closed (not silently omitted).
  if ('backend' in args) {
    if (typeof args.backend !== 'string' || args.backend.length === 0 || args.backend.length > 200) {
      return undefined;
    }
    spec.backend = args.backend;
  }
  if ('model' in args) {
    if (typeof args.model !== 'string' || args.model.length === 0 || args.model.length > 200) {
      return undefined;
    }
    spec.model = args.model;
  }
  if ('role' in args) {
    if (args.role !== 'coordinator' && args.role !== 'worker') return undefined;
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
  if (args.description !== undefined) {
    if (typeof args.description !== 'string') return undefined;
    if (args.description.length > 0) {
      spec.description = clampSection(args.description, BRIEF_SECTION_MAX);
    }
  }
  if (args.brief !== undefined) {
    const brief = parseBriefOverlay(args.brief);
    if (!brief) return undefined;
    spec.brief = brief;
  }
  if (args.inputBindings !== undefined) {
    const bindings = parseInputBindings(args.inputBindings);
    if (!bindings) return undefined;
    spec.inputBindings = bindings;
  }
  if (args.claimsGit !== undefined) {
    if (typeof args.claimsGit !== 'boolean') return undefined;
    spec.claimsGit = args.claimsGit;
  }
  if (args.writePaths !== undefined) {
    const list = parseStringArray(args.writePaths);
    if (!list) return undefined;
    spec.writePaths = list;
  }
  if (args.readPaths !== undefined) {
    const list = parseStringArray(args.readPaths);
    if (!list) return undefined;
    spec.readPaths = list;
  }
  return spec;
}

function parseBatchInputBindings(value: unknown): BatchInputBinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: BatchInputBinding[] = [];
  const allowed = new Set(['fromLocalId', 'fromTaskId', 'output', 'as', 'required']);
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (Object.keys(entry).some((k) => !allowed.has(k))) return undefined;
    const output = typeof entry.output === 'string' ? entry.output : '';
    const as = typeof entry.as === 'string' ? entry.as : '';
    if (!as || !output || !isAllowedBindingOutput(output)) return undefined;
    const hasLocal = typeof entry.fromLocalId === 'string' && entry.fromLocalId.length > 0;
    const hasTask = typeof entry.fromTaskId === 'string' && entry.fromTaskId.length > 0;
    // Exactly one producer reference (sibling localId XOR pre-existing task id).
    if (hasLocal === hasTask) return undefined;
    const binding: BatchInputBinding = { output, as };
    if (hasLocal) binding.fromLocalId = entry.fromLocalId as string;
    if (hasTask) binding.fromTaskId = entry.fromTaskId as string;
    if (entry.required !== undefined) {
      if (typeof entry.required !== 'boolean') return undefined;
      binding.required = entry.required;
    }
    out.push(binding);
  }
  return out;
}

function parseBatchChildSpec(entry: unknown): BatchChildSpec | undefined {
  if (!isRecord(entry)) return undefined;
  const localId = typeof entry.localId === 'string' ? entry.localId : '';
  if (!localId || !TASK_TYPE_ID_RE.test(localId)) return undefined;

  let dependsOn: string[] | undefined;
  if (entry.dependsOn !== undefined) {
    if (!Array.isArray(entry.dependsOn)) return undefined;
    const list: string[] = [];
    for (const dep of entry.dependsOn) {
      if (typeof dep !== 'string' || dep.length === 0) return undefined;
      list.push(dep);
    }
    dependsOn = list;
  }

  let inputBindings: BatchInputBinding[] | undefined;
  if (entry.inputBindings !== undefined) {
    inputBindings = parseBatchInputBindings(entry.inputBindings);
    if (!inputBindings) return undefined;
  }

  // Reuse the singular create parser for the shared fields. Strip batch-only keys
  // (inputBindings has a different shape here) before delegating.
  const baseArgs: Record<string, unknown> = { ...entry };
  delete baseArgs.localId;
  delete baseArgs.dependsOn;
  delete baseArgs.inputBindings;
  const base = parseCreateSpec(baseArgs);
  if (!base) return undefined;
  const { inputBindings: _dropped, ...baseRest } = base;
  const spec: BatchChildSpec = { ...baseRest, localId };
  if (dependsOn) spec.dependsOn = dependsOn;
  if (inputBindings) spec.inputBindings = inputBindings;
  return spec;
}

function parseBatchSpecs(value: unknown): BatchChildSpec[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > BATCH_EXPAND_MAX) {
    return undefined;
  }
  const specs: BatchChildSpec[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const spec = parseBatchChildSpec(entry);
    if (!spec) return undefined;
    if (seen.has(spec.localId)) return undefined; // duplicate localId
    seen.add(spec.localId);
    specs.push(spec);
  }
  // Intra-batch references must point at known siblings (and never self).
  for (const spec of specs) {
    for (const dep of spec.dependsOn ?? []) {
      if (dep === spec.localId || !seen.has(dep)) return undefined;
    }
    for (const binding of spec.inputBindings ?? []) {
      if (binding.fromLocalId === undefined) continue;
      if (binding.fromLocalId === spec.localId || !seen.has(binding.fromLocalId)) {
        return undefined;
      }
    }
  }
  return specs;
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
      case 'create_tasks':
      case 'delegate_tasks': {
        const specs = parseBatchSpecs(args.tasks);
        if (!specs) {
          return { ok: false, toolError: `invalid ${tool} arguments` };
        }
        const kind = tool === 'create_tasks' ? ('create_tasks' as const) : ('delegate_tasks' as const);
        return { ok: true, command: { kind, opId, specs } };
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
      case 'set_task_lifecycle': {
        const taskId = requireString(args, 'taskId') ?? requireString(args, 'childId');
        if (!taskId) {
          return { ok: false, toolError: 'taskId is required' };
        }
        const lifecycle = args.lifecycle;
        if (
          lifecycle !== 'succeeded' &&
          lifecycle !== 'failed' &&
          lifecycle !== 'cancelled' &&
          lifecycle !== 'skipped'
        ) {
          return { ok: false, toolError: 'lifecycle must be succeeded|failed|cancelled|skipped' };
        }
        if (lifecycle === 'succeeded') {
          const result = requireString(args, 'result');
          if (!result) {
            return { ok: false, toolError: 'result is required for succeeded' };
          }
          return {
            ok: true,
            command: { kind: 'set_task_lifecycle', opId, taskId, lifecycle, result },
          };
        }
        if (lifecycle === 'failed') {
          const error = requireString(args, 'error');
          if (!error) {
            return { ok: false, toolError: 'error is required for failed' };
          }
          return {
            ok: true,
            command: { kind: 'set_task_lifecycle', opId, taskId, lifecycle, error },
          };
        }
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        return {
          ok: true,
          command: {
            kind: 'set_task_lifecycle',
            opId,
            taskId,
            lifecycle,
            ...(reason !== undefined ? { reason } : {}),
          },
        };
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

  if (tool === 'get_host_context') {
    // Read-only: no opId; empty args only.
    if (Object.keys(args).length > 0) {
      return { ok: false, toolError: 'get_host_context takes no arguments' };
    }
    return { ok: true, command: { kind: 'get_host_context' } };
  }

  if (tool === 'list_task_types') {
    // Read-only: no opId; empty args only (live registry in engine).
    if (Object.keys(args).length > 0) {
      return { ok: false, toolError: 'list_task_types takes no arguments' };
    }
    return { ok: true, command: { kind: 'list_task_types' } };
  }

  return { ok: false, toolError: `unsupported tool: ${tool}` };
}