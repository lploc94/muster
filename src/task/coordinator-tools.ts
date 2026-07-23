import { createHash } from 'node:crypto';
import type { Question } from '../bridge/ask-bridge';
import type { CredentialContext } from '../bridge/credentials';
import type { TaskBriefOverlay } from './brief';
import { BRIEF_SECTION_MAX, clampSection, isTaskBriefKind } from './brief';
import type { ToolAction } from './capabilities';
import {
  fitsUtf8Bytes,
  PRESENTATION_MARKDOWN_MAX_CHARS,
  TASK_ERROR_MAX_BYTES,
  TASK_RESULT_MAX_BYTES,
  WORKFLOW_FEEDBACK_MAX_BYTES,
} from './content-limits';
import { isAllowedBindingOutput } from './dataflow';
import { TASK_TYPE_ID_RE } from './task-types';
import type {
  TaskPrerequisite,
  TaskExecutionPolicy,
  TaskInputBinding,
  TaskResultOutputKey,
  TaskRole,
} from './types';
import type { VerdictCriterionInput, VerdictInput } from './verdict';
import {
  WORKFLOW_CHILD_BINDINGS_MAX,
  WORKFLOW_ENTRY_CONTRACTS_MAX,
  WORKFLOW_GRAPH_MAX_EDGES,
  WORKFLOW_GRAPH_MAX_NODES,
  WORKFLOW_NODE_LABEL_MAX_LENGTH,
  WORKFLOW_RUN_GOAL_MAX_LENGTH,
  type StartWorkflowEntryInput,
  type WorkflowEntryContractV1,
  type WorkflowPolicyV1,
} from './workflow-types';

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
  prerequisites?: TaskPrerequisite[];
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
  /** Sibling localIds this item requires before it can run. */
  prerequisiteLocalIds?: string[];
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
export const PRESENTATION_MARKDOWN_MAX_LENGTH = PRESENTATION_MARKDOWN_MAX_CHARS;
export const PRESENTATION_REF_PATTERN = '^presentation-[a-f0-9]{32}$';
export const WORKFLOW_REF_PATTERN = '^(workflow-[a-f0-9]{32})@([1-9][0-9]*)$';

const PRESENTATION_KEYS = new Set([
  'presentationRef',
  'title',
  'markdown',
  'kind',
  'summary',
  'changeSummary',
]);
const PRESENTATION_KIND_VALUES = new Set(['plan', 'spec', 'document']);
const PRESENTATION_SUMMARY_MAX_LENGTH = 600;
const PRESENTATION_CHANGE_SUMMARY_MAX_LENGTH = 1000;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PRESENTATION_REF_REGEX = new RegExp(PRESENTATION_REF_PATTERN);
const WORKFLOW_REF_REGEX = new RegExp(WORKFLOW_REF_PATTERN);

export type ToolCommand =
  | { kind: 'create_task'; opId: string; spec: CreateChildSpec }
  | {
      kind: 'delegate_task';
      opId: string;
      spec: CreateChildSpec;
      /** When true, stage wait on the created child in the same op. */
      waitForCompletion?: boolean;
    }
  | { kind: 'create_tasks'; opId: string; specs: BatchChildSpec[] }
  | {
      kind: 'delegate_tasks';
      opId: string;
      specs: BatchChildSpec[];
      /** Wait only these batch-local children (exact set; order preserved). */
      waitForLocalIds?: string[];
    }
  | {
      kind: 'release_tasks';
      opId: string;
      taskIds: string[];
      includePrerequisites?: boolean;
      /** Wait only this explicit subset of released/owned direct children. */
      waitForTaskIds?: string[];
    }
  | { kind: 'interrupt_task'; opId: string; childId: string }
  | { kind: 'cancel_task'; opId: string; childId: string }
  | { kind: 'cancel_tasks'; opId: string; childIds: string[]; reason?: string }
  | {
      kind: 'continue_child';
      opId: string;
      childId: string;
      instruction: string;
      waitForCompletion?: boolean;
    }
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
  | { kind: 'inspect_workflow_run'; runId: string }
  | { kind: 'get_host_context' }
  | { kind: 'list_task_types' }
  | { kind: 'complete_task'; opId: string; result: string; verdict?: VerdictInput }
  | { kind: 'fail_task'; opId: string; error: string }
  /** M018 S02: stage workflow NEXT with the final assistant message. */
  | {
      kind: 'workflow_next';
      opId: string;
      change: 'updated' | 'unchanged';
      message: string;
    }
  /** M018 S04: stage workflow PREV with the final assistant message. */
  | {
      kind: 'workflow_prev';
      opId: string;
      targets: 'all' | string[];
      message: string;
    }
  /** M018 S05: stage workflow FAIL (optional reason; engine owns run closure). */
  | {
      kind: 'workflow_fail';
      opId: string;
      reason?: string;
    }
  /** M018 S06: stage child-workflow invocation (engine owns child run/continuation). */
  | {
      kind: 'invoke_child_workflow';
      opId: string;
      childDefinitionId: string;
      childDefinitionVersion?: number;
      entryBindings?: readonly {
        childEntryNodeId: string;
        inputRef: string;
        artifactId: string;
        artifactRevision: number;
      }[];
      semanticEntryBindings?: readonly {
        childEntryNodeId: string;
        inputRef: string;
        fromInputRef: string;
      }[];
      childIdempotencyKey?: string;
    }
  | { kind: 'ask_parent'; opId: string; questions: Question[] }
  | {
      kind: 'answer_child_question';
      opId: string;
      questionId: string;
      answers: string[];
    }
  | {
      kind: 'upsert_presentation';
      presentationId: string;
      ownerTaskId: string;
      opId: string;
      revision?: number;
      requireExisting?: true;
      title: string;
      markdown: string;
      presentationKind?: 'plan' | 'spec' | 'document';
      summary?: string;
      changeSummary?: string;
    }
  | {
      kind: 'define_workflow';
      opId: string;
      definitionId: string;
      version?: number;
      name: string;
      topology: unknown;
      entryContracts: readonly WorkflowEntryContractV1[];
      policy?: WorkflowPolicyV1;
    }
  | {
      kind: 'start_workflow';
      opId: string;
      definitionId: string;
      version?: number;
      startIdempotencyKey: string;
      goal?: string;
      backend?: string;
      entryInputs: readonly StartWorkflowEntryInput[];
    };

const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'create_task',
  'delegate_task',
  'create_tasks',
  'delegate_tasks',
  'release_tasks',
  'interrupt_task',
  'cancel_task',
  'cancel_tasks',
  'continue_child',
  'set_task_lifecycle',
  'wait_for_tasks',
  'complete_task',
  'fail_task',
  'workflow_next',
  'workflow_prev',
  'workflow_fail',
  'invoke_child_workflow',
  'ask_parent',
  'answer_child_question',
  'upsert_presentation',
  'define_workflow',
  'start_workflow',
]);

const ENGINE_OPERATION_TOOLS: ReadonlySet<string> = new Set([
  'workflow_next',
  'workflow_prev',
  'workflow_fail',
  'invoke_child_workflow',
  'upsert_presentation',
  'define_workflow',
  'start_workflow',
]);

function toolActionForName(name: string): ToolAction | undefined {
  const actions: ToolAction[] = [
    'create_task',
    'delegate_task',
    'create_tasks',
    'delegate_tasks',
    'release_tasks',
      'interrupt_task',
    'cancel_task',
    'cancel_tasks',
    'continue_child',
    'set_task_lifecycle',
    'wait_for_tasks',
    'inspect_workflow_run',
    'get_host_context',
    'list_task_types',
    'complete_task',
    'fail_task',
    'workflow_next',
    'workflow_prev',
    'workflow_fail',
    'invoke_child_workflow',
      'ask_parent',
    'answer_child_question',
    'upsert_presentation',
    'define_workflow',
    'start_workflow',
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

function stableHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex').slice(0, 32);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function derivedOperationId(
  ctx: CredentialContext,
  slot: string,
  semanticKey = 'default',
): string {
  return `auto-${stableHash(ctx.rootId, ctx.callerTaskId, ctx.turnId, slot, semanticKey)}`;
}

function parseWorkflowReference(value: unknown): { definitionId: string; version: number } | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const match = WORKFLOW_REF_REGEX.exec(value);
  if (!match) return undefined;
  const definitionId = match[1]!;
  const version = Number(match[2]);
  return Number.isSafeInteger(version) ? { definitionId, version } : undefined;
}

function parseSemanticWorkflowDefinition(args: Record<string, unknown>): {
  name: string;
  topology: unknown;
  entryContracts: WorkflowEntryContractV1[];
} | undefined {
  const allowed = new Set(['name', 'nodes', 'edges', 'inputs']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const name = requireString(args, 'name');
  if (!name) return undefined;
  if (
    !Array.isArray(args.nodes) ||
    args.nodes.length === 0 ||
    args.nodes.length > WORKFLOW_GRAPH_MAX_NODES
  ) {
    return undefined;
  }

  const nodes: Array<{ nodeId: string; taskType: string; label?: string }> = [];
  const nodeIds = new Set<string>();
  for (const raw of args.nodes) {
    if (!isRecord(raw)) return undefined;
    if (Object.keys(raw).some((key) => !['nodeKey', 'taskType', 'label'].includes(key))) {
      return undefined;
    }
    const nodeId = requireString(raw, 'nodeKey');
    const taskType = requireString(raw, 'taskType');
    if (!nodeId || !isStablePresentationId(nodeId) || !taskType || nodeIds.has(nodeId)) {
      return undefined;
    }
    if (
      raw.label !== undefined &&
      (
        typeof raw.label !== 'string' ||
        raw.label.length === 0 ||
        raw.label.length > WORKFLOW_NODE_LABEL_MAX_LENGTH
      )
    ) {
      return undefined;
    }
    nodeIds.add(nodeId);
    nodes.push({
      nodeId,
      taskType,
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    });
  }

  const edges: Array<{
    fromNodeId: string;
    toNodeId: string;
    inputRef: string;
    expectedArtifactKind: 'next_result';
  }> = [];
  if (args.edges !== undefined) {
    if (!Array.isArray(args.edges) || args.edges.length > WORKFLOW_GRAPH_MAX_EDGES) {
      return undefined;
    }
    for (const raw of args.edges) {
      if (!isRecord(raw)) return undefined;
      if (Object.keys(raw).some((key) => !['from', 'to', 'as'].includes(key))) return undefined;
      const fromNodeId = requireString(raw, 'from');
      const toNodeId = requireString(raw, 'to');
      const inputRef = requireString(raw, 'as');
      if (
        !fromNodeId || !toNodeId || !inputRef ||
        !nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)
      ) return undefined;
      edges.push({ fromNodeId, toNodeId, inputRef, expectedArtifactKind: 'next_result' });
    }
  }
  if ((nodes.length === 1 && edges.length > 0) || (nodes.length > 1 && edges.length === 0)) {
    return undefined;
  }

  const entryContracts: WorkflowEntryContractV1[] = [];
  if (args.inputs !== undefined) {
    if (
      !Array.isArray(args.inputs) ||
      args.inputs.length > WORKFLOW_ENTRY_CONTRACTS_MAX
    ) return undefined;
    const seen = new Set<string>();
    for (const raw of args.inputs) {
      if (!isRecord(raw)) return undefined;
      if (Object.keys(raw).some((key) => !['to', 'name'].includes(key))) return undefined;
      const entryNodeId = requireString(raw, 'to');
      const inputRef = requireString(raw, 'name');
      if (!entryNodeId || !nodeIds.has(entryNodeId) || !inputRef) return undefined;
      const key = `${entryNodeId}\0${inputRef}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      entryContracts.push({
        entryNodeId,
        inputRef,
        expectedArtifactKind: 'workflow_input',
      });
    }
  }

  const topology = nodes.length === 1
    ? { kind: 'one_node_v1', entryNodeId: nodes[0]!.nodeId, nodes }
    : { kind: 'graph_v1', nodes, edges };
  return { name, topology, entryContracts };
}

function parseSemanticWorkflowInputs(value: unknown): StartWorkflowEntryInput[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WORKFLOW_ENTRY_CONTRACTS_MAX) return undefined;
  const inputs: StartWorkflowEntryInput[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    if (Object.keys(raw).some((key) => !['node', 'input', 'value'].includes(key))) return undefined;
    const entryNodeId = requireString(raw, 'node');
    const inputRef = requireString(raw, 'input');
    if (!entryNodeId || !inputRef || typeof raw.value !== 'string') return undefined;
    const key = `${entryNodeId}\0${inputRef}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    inputs.push({ entryNodeId, inputRef, kind: 'workflow_input', value: raw.value });
  }
  return inputs;
}

function parsePrerequisite(value: unknown): TaskPrerequisite | undefined {
  if (!isRecord(value)) return undefined;
  const producerTaskId = requireString(value, 'producerTaskId');
  const requiredLifecycle = value.requiredLifecycle;
  const onUnmet = value.onUnmet;
  if (
    !producerTaskId ||
    (requiredLifecycle !== 'succeeded' && requiredLifecycle !== 'terminal') ||
    (onUnmet !== 'block' && onUnmet !== 'fail' && onUnmet !== 'skip')
  ) {
    return undefined;
  }
  const prerequisite: TaskPrerequisite = { producerTaskId, requiredLifecycle, onUnmet };
  // Opt-in verify gate. Present-but-invalid fails closed (rejects the create).
  if (value.requiredVerdict !== undefined) {
    if (value.requiredVerdict !== 'pass') return undefined;
    prerequisite.requiredVerdict = 'pass';
  }
  return prerequisite;
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

function isPresentationPayloadTooLarge(args: Record<string, unknown>): boolean {
  return (
    (typeof args.presentationRef === 'string' && args.presentationRef.length > PRESENTATION_ID_MAX_LENGTH) ||
    (typeof args.title === 'string' && args.title.length > PRESENTATION_TITLE_MAX_LENGTH) ||
    (typeof args.markdown === 'string' && args.markdown.length > PRESENTATION_MARKDOWN_MAX_LENGTH) ||
    (typeof args.summary === 'string' && args.summary.length > PRESENTATION_SUMMARY_MAX_LENGTH) ||
    (typeof args.changeSummary === 'string' &&
      args.changeSummary.length > PRESENTATION_CHANGE_SUMMARY_MAX_LENGTH)
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
  if ('runTimeoutOverrideMs' in value) {
    const runTimeoutOverrideMs = positiveInt(value.runTimeoutOverrideMs);
    if (runTimeoutOverrideMs === undefined) return undefined;
    policy.runTimeoutOverrideMs = runTimeoutOverrideMs;
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
  'skills',
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
  if (value.skills !== undefined) {
    const list = parseStringArray(value.skills);
    if (!list) return undefined;
    overlay.skills = list;
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

/**
 * Structurally extract a worker-supplied verdict payload (verify-gate-loop Phase A).
 * Timeless + never-rejecting: carries raw `status`/`rationale`/`criteria` strings for
 * later fail-closed normalization (malformed status → inconclusive at normalize time).
 * A non-record arg yields `undefined` (treated as no verdict).
 */
function parseVerdictInput(value: unknown): VerdictInput | undefined {
  if (!isRecord(value)) return undefined;
  const out: VerdictInput = {};
  if (typeof value.status === 'string') out.status = value.status;
  if (typeof value.rationale === 'string') out.rationale = value.rationale;
  if (Array.isArray(value.criteria)) {
    const criteria: VerdictCriterionInput[] = [];
    for (const entry of value.criteria) {
      if (!isRecord(entry)) continue;
      const criterion: VerdictCriterionInput = {};
      if (typeof entry.label === 'string') criterion.label = entry.label;
      if (typeof entry.status === 'string') criterion.status = entry.status;
      if (typeof entry.detail === 'string') criterion.detail = entry.detail;
      criteria.push(criterion);
    }
    out.criteria = criteria;
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
  if (args.prerequisites !== undefined) {
    if (!Array.isArray(args.prerequisites)) return undefined;
    const prerequisites: TaskPrerequisite[] = [];
    for (const entry of args.prerequisites) {
      const prerequisite = parsePrerequisite(entry);
      if (!prerequisite) return undefined;
      prerequisites.push(prerequisite);
    }
    spec.prerequisites = prerequisites;
  }
  if (args.executionPolicy !== undefined) {
    if (!isRecord(args.executionPolicy)) return undefined;
    const allowed = new Set(['maxTurns', 'maxAutomaticRetries', 'runTimeoutOverrideMs']);
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

  let prerequisiteLocalIds: string[] | undefined;
  if (entry.prerequisiteLocalIds !== undefined) {
    if (!Array.isArray(entry.prerequisiteLocalIds)) return undefined;
    const list: string[] = [];
    for (const localId of entry.prerequisiteLocalIds) {
      if (typeof localId !== 'string' || localId.length === 0) return undefined;
      list.push(localId);
    }
    prerequisiteLocalIds = list;
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
  delete baseArgs.prerequisiteLocalIds;
  delete baseArgs.inputBindings;
  const base = parseCreateSpec(baseArgs);
  if (!base) return undefined;
  const { inputBindings: _dropped, ...baseRest } = base;
  const spec: BatchChildSpec = { ...baseRest, localId };
  if (prerequisiteLocalIds) spec.prerequisiteLocalIds = prerequisiteLocalIds;
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
    for (const prerequisiteLocalId of spec.prerequisiteLocalIds ?? []) {
      if (prerequisiteLocalId === spec.localId || !seen.has(prerequisiteLocalId)) return undefined;
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
    const suppliedOpId = requireString(args, 'opId');
    if (Object.prototype.hasOwnProperty.call(args, 'opId') && !suppliedOpId) {
      return {
        ok: false,
        toolError: tool === 'upsert_presentation' ? 'invalid_arguments' : 'opId must be a non-empty string',
      };
    }
    const semanticKey = tool === 'define_workflow' ||
      tool === 'start_workflow' ||
      tool === 'invoke_child_workflow' ||
      tool === 'upsert_presentation'
      ? stableHash(canonicalJson(args))
      : requireString(args, 'definitionId') ?? 'default';
    const slot = tool === 'workflow_next' || tool === 'workflow_prev' || tool === 'workflow_fail'
      ? 'workflow_disposition'
      : tool;
    const opId = suppliedOpId ?? (
      ENGINE_OPERATION_TOOLS.has(tool)
        ? derivedOperationId(ctx, slot, semanticKey)
        : undefined
    );
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
        if (args.waitForCompletion !== undefined && typeof args.waitForCompletion !== 'boolean') {
          return { ok: false, toolError: 'waitForCompletion must be a boolean' };
        }
        return {
          ok: true,
          command: {
            kind: 'delegate_task',
            opId,
            spec,
            ...(args.waitForCompletion === true ? { waitForCompletion: true } : {}),
          },
        };
      }
      case 'create_tasks':
      case 'delegate_tasks': {
        const specs = parseBatchSpecs(args.tasks);
        if (!specs) {
          return { ok: false, toolError: `invalid ${tool} arguments` };
        }
        if (tool === 'create_tasks') {
          return { ok: true, command: { kind: 'create_tasks', opId, specs } };
        }
        let waitForLocalIds: string[] | undefined;
        if (args.waitForLocalIds !== undefined) {
          if (
            !Array.isArray(args.waitForLocalIds) ||
            args.waitForLocalIds.length === 0 ||
            !args.waitForLocalIds.every((id) => typeof id === 'string' && id.length > 0)
          ) {
            return { ok: false, toolError: 'waitForLocalIds must be a non-empty string array' };
          }
          const localSet = new Set(specs.map((s) => s.localId));
          for (const id of args.waitForLocalIds) {
            if (!localSet.has(id)) {
              return { ok: false, toolError: `waitForLocalIds unknown localId: ${id}` };
            }
          }
          waitForLocalIds = args.waitForLocalIds as string[];
        }
        return {
          ok: true,
          command: {
            kind: 'delegate_tasks',
            opId,
            specs,
            ...(waitForLocalIds !== undefined ? { waitForLocalIds } : {}),
          },
        };
      }
      case 'release_tasks': {
        const raw = args.taskIds;
        if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => typeof id === 'string' && id.length > 0)) {
          return { ok: false, toolError: 'taskIds must be a non-empty string array' };
        }
        const includePrerequisites =
          args.includePrerequisites === undefined ? false : args.includePrerequisites === true;
        if (args.includePrerequisites !== undefined && typeof args.includePrerequisites !== 'boolean') {
          return { ok: false, toolError: 'includePrerequisites must be a boolean' };
        }
        let waitForTaskIds: string[] | undefined;
        if (args.waitForTaskIds !== undefined) {
          if (
            !Array.isArray(args.waitForTaskIds) ||
            args.waitForTaskIds.length === 0 ||
            !args.waitForTaskIds.every((id) => typeof id === 'string' && id.length > 0)
          ) {
            return { ok: false, toolError: 'waitForTaskIds must be a non-empty string array' };
          }
          waitForTaskIds = args.waitForTaskIds as string[];
        }
        return {
          ok: true,
          command: {
            kind: 'release_tasks',
            opId,
            taskIds: raw as string[],
            includePrerequisites,
            ...(waitForTaskIds !== undefined ? { waitForTaskIds } : {}),
          },
        };
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
      case 'cancel_tasks': {
        const raw = args.childIds;
        if (
          !Array.isArray(raw) ||
          raw.length === 0 ||
          !raw.every((id) => typeof id === 'string' && id.length > 0)
        ) {
          return { ok: false, toolError: 'childIds must be a non-empty string array' };
        }
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        return {
          ok: true,
          command: {
            kind: 'cancel_tasks',
            opId,
            childIds: raw as string[],
            ...(reason !== undefined ? { reason } : {}),
          },
        };
      }
      case 'continue_child': {
        const childId = requireString(args, 'childId') ?? requireString(args, 'taskId');
        const instruction = requireString(args, 'instruction');
        if (!childId) {
          return { ok: false, toolError: 'childId is required' };
        }
        if (!instruction) {
          return { ok: false, toolError: 'instruction is required' };
        }
        if (args.waitForCompletion !== undefined && typeof args.waitForCompletion !== 'boolean') {
          return { ok: false, toolError: 'waitForCompletion must be a boolean' };
        }
        return {
          ok: true,
          command: {
            kind: 'continue_child',
            opId,
            childId,
            instruction,
            ...(args.waitForCompletion === true ? { waitForCompletion: true } : {}),
          },
        };
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
        if (!fitsUtf8Bytes(result, TASK_RESULT_MAX_BYTES)) {
          return { ok: false, toolError: `result exceeds ${TASK_RESULT_MAX_BYTES} UTF-8 bytes` };
        }
        // Optional structured verdict. A bad verdict never rejects the call — it is
        // normalized fail-closed (malformed status → inconclusive) at seal time.
        const verdict = parseVerdictInput(args.verdict);
        return {
          ok: true,
          command: {
            kind: 'complete_task',
            opId,
            result,
            ...(verdict !== undefined ? { verdict } : {}),
          },
        };
      }
      case 'fail_task': {
        const error = requireString(args, 'error');
        if (!error) {
          return { ok: false, toolError: 'error is required' };
        }
        if (!fitsUtf8Bytes(error, TASK_ERROR_MAX_BYTES)) {
          return { ok: false, toolError: `error exceeds ${TASK_ERROR_MAX_BYTES} UTF-8 bytes` };
        }
        return { ok: true, command: { kind: 'fail_task', opId, error } };
      }
      case 'workflow_next': {
        const change = requireString(args, 'change') ?? 'updated';
        if (change !== 'updated' && change !== 'unchanged') {
          return { ok: false, toolError: 'change must be "updated" or "unchanged"' };
        }
        const message = requireString(args, 'message');
        if (!message) return { ok: false, toolError: 'message is required' };
        if (!fitsUtf8Bytes(message, TASK_RESULT_MAX_BYTES)) {
          return { ok: false, toolError: `message exceeds ${TASK_RESULT_MAX_BYTES} UTF-8 bytes` };
        }
        return {
          ok: true,
          command: {
            kind: 'workflow_next',
            opId,
            change,
            message,
          },
        };
      }
      case 'workflow_prev': {
        // targets: 'all' | non-empty string[] of inputRefs. Empty arrays rejected at parse time.
        const rawTargets = args.targets;
        let targets: 'all' | string[];
        if (rawTargets === undefined || rawTargets === 'all') {
          targets = 'all';
        } else if (Array.isArray(rawTargets)) {
          if (
            rawTargets.length === 0 ||
            !rawTargets.every((t) => typeof t === 'string' && t.length > 0)
          ) {
            return {
              ok: false,
              toolError: 'targets must be "all" or a non-empty string array of inputRefs',
            };
          }
          targets = rawTargets as string[];
        } else {
          return {
            ok: false,
            toolError: 'targets must be "all" or a non-empty string array of inputRefs',
          };
        }
        const message = requireString(args, 'message');
        if (!message) return { ok: false, toolError: 'message is required' };
        if (!fitsUtf8Bytes(message, WORKFLOW_FEEDBACK_MAX_BYTES)) {
          return {
            ok: false,
            toolError: `message exceeds ${WORKFLOW_FEEDBACK_MAX_BYTES} UTF-8 bytes`,
          };
        }
        return {
          ok: true,
          command: {
            kind: 'workflow_prev',
            opId,
            targets,
            message,
          },
        };
      }
      case 'workflow_fail': {
        // Optional reason; empty string rejected at parse time. Closure is repository-owned (T02).
        let reason: string | undefined;
        if (Object.prototype.hasOwnProperty.call(args, 'reason')) {
          if (typeof args.reason !== 'string' || args.reason.length === 0) {
            return { ok: false, toolError: 'reason must be a non-empty string when provided' };
          }
          if (!fitsUtf8Bytes(args.reason, TASK_ERROR_MAX_BYTES)) {
            return {
              ok: false,
              toolError: `reason exceeds ${TASK_ERROR_MAX_BYTES} UTF-8 bytes`,
            };
          }
          reason = args.reason;
        }
        return {
          ok: true,
          command: {
            kind: 'workflow_fail',
            opId,
            ...(reason !== undefined ? { reason } : {}),
          },
        };
      }
      case 'invoke_child_workflow': {
        const semanticReference = parseWorkflowReference(args.workflow);
        if (
          !semanticReference ||
          Object.keys(args).some((key) => !['workflow', 'bindings'].includes(key))
        ) return { ok: false, toolError: 'invalid invoke_child_workflow arguments' };
        const childDefinitionId = semanticReference.definitionId;
        const childDefinitionVersion = semanticReference.version;

        if (Array.isArray(args.bindings)) {
          if (
            args.bindings.length === 0 ||
            args.bindings.length > WORKFLOW_CHILD_BINDINGS_MAX
          ) {
            return { ok: false, toolError: 'bindings must be a non-empty array' };
          }
          const semanticEntryBindings: Array<{
            childEntryNodeId: string;
            inputRef: string;
            fromInputRef: string;
          }> = [];
          const seenRefs = new Set<string>();
          for (const entry of args.bindings) {
            if (!isRecord(entry)) return { ok: false, toolError: 'bindings entries must be objects' };
            if (Object.keys(entry).some((key) => !['toNode', 'input', 'fromInput'].includes(key))) {
              return { ok: false, toolError: 'invalid child workflow binding' };
            }
            const childEntryNodeId = requireString(entry, 'toNode');
            const inputRef = requireString(entry, 'input');
            const fromInputRef = requireString(entry, 'fromInput');
            if (!childEntryNodeId || !inputRef || !fromInputRef) {
              return { ok: false, toolError: 'invalid child workflow binding' };
            }
            const bindingKey = `${childEntryNodeId}\0${inputRef}`;
            if (seenRefs.has(bindingKey)) {
              return { ok: false, toolError: `duplicate child workflow binding: ${childEntryNodeId}/${inputRef}` };
            }
            seenRefs.add(bindingKey);
            semanticEntryBindings.push({ childEntryNodeId, inputRef, fromInputRef });
          }
          return {
            ok: true,
            command: {
              kind: 'invoke_child_workflow',
              opId,
              childDefinitionId,
              ...(childDefinitionVersion !== undefined ? { childDefinitionVersion } : {}),
              semanticEntryBindings,
              childIdempotencyKey: `turn-${stableHash(ctx.turnId, opId)}`,
            },
          };
        }
        return { ok: false, toolError: 'bindings must be a non-empty array' };
      }
      case 'ask_parent': {
        const questions = parseQuestions(args.questions);
        if (!questions) {
          return { ok: false, toolError: 'questions must be a non-empty array' };
        }
        return { ok: true, command: { kind: 'ask_parent', opId, questions } };
      }
      case 'answer_child_question': {
        const questionId = requireString(args, 'questionId');
        if (!questionId) {
          return { ok: false, toolError: 'questionId is required' };
        }
        const rawAnswers = args.answers;
        if (
          !Array.isArray(rawAnswers) ||
          rawAnswers.length === 0 ||
          !rawAnswers.every((a) => typeof a === 'string')
        ) {
          return { ok: false, toolError: 'answers must be a non-empty string array' };
        }
        return {
          ok: true,
          command: {
            kind: 'answer_child_question',
            opId,
            questionId,
            answers: rawAnswers as string[],
          },
        };
      }
      case 'upsert_presentation': {
        if (isPresentationPayloadTooLarge(args)) {
          return { ok: false, toolError: 'payload_too_large' };
        }
        const presentationRef = requireString(args, 'presentationRef');
        const ownerTaskId = ctx.callerTaskId;
        const title = requireString(args, 'title');
        const markdown = requireString(args, 'markdown');
        const presentationId = presentationRef ?? (
          title && markdown
            ? `presentation-${stableHash(ctx.rootId, ctx.callerTaskId, canonicalJson({
                title,
                markdown,
                kind: args.kind,
                summary: args.summary,
              }))}`
            : undefined
        );
        if (
          Object.keys(args).some((key) => !PRESENTATION_KEYS.has(key)) ||
          (Object.prototype.hasOwnProperty.call(args, 'presentationRef') && !presentationRef) ||
          (presentationRef !== undefined && !PRESENTATION_REF_REGEX.test(presentationRef)) ||
          !isStablePresentationId(presentationId) ||
          !isStablePresentationId(ownerTaskId) ||
          !isStablePresentationId(opId) ||
          !title ||
          !markdown
        ) {
          return { ok: false, toolError: 'invalid_arguments' };
        }
        let presentationKind: 'plan' | 'spec' | 'document' | undefined;
        if (args.kind !== undefined) {
          if (typeof args.kind !== 'string' || !PRESENTATION_KIND_VALUES.has(args.kind)) {
            return { ok: false, toolError: 'invalid_arguments' };
          }
          presentationKind = args.kind as 'plan' | 'spec' | 'document';
        }
        let summary: string | undefined;
        if (args.summary !== undefined) {
          if (typeof args.summary !== 'string' || args.summary.length === 0) {
            return { ok: false, toolError: 'invalid_arguments' };
          }
          summary = args.summary;
        }
        let changeSummary: string | undefined;
        if (args.changeSummary !== undefined) {
          if (typeof args.changeSummary !== 'string' || args.changeSummary.length === 0) {
            return { ok: false, toolError: 'invalid_arguments' };
          }
          changeSummary = args.changeSummary;
        }
        return {
          ok: true,
          command: {
            kind: 'upsert_presentation',
            presentationId,
            ownerTaskId,
            opId,
            ...(presentationRef !== undefined ? { requireExisting: true as const } : {}),
            title,
            markdown,
            ...(presentationKind !== undefined ? { presentationKind } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(changeSummary !== undefined ? { changeSummary } : {}),
          },
        };
      }
      case 'define_workflow': {
        const semantic = parseSemanticWorkflowDefinition(args);
        if (semantic) {
          const definitionId = `workflow-${stableHash(ctx.rootId, canonicalJson(semantic))}`;
          return {
            ok: true,
            command: {
              kind: 'define_workflow',
              opId,
              definitionId,
              name: semantic.name,
              topology: semantic.topology,
              entryContracts: semantic.entryContracts,
            },
          };
        }
        return { ok: false, toolError: 'invalid define_workflow arguments' };
      }
      case 'start_workflow': {
        const semanticReference = parseWorkflowReference(args.workflow);
        if (semanticReference) {
          const entryInputs = parseSemanticWorkflowInputs(args.inputs);
          if (!entryInputs) return { ok: false, toolError: 'invalid start_workflow inputs' };
          if (
            'goal' in args &&
            (
              typeof args.goal !== 'string' ||
              args.goal.length === 0 ||
              args.goal.length > WORKFLOW_RUN_GOAL_MAX_LENGTH
            )
          ) {
            return { ok: false, toolError: 'invalid start_workflow goal' };
          }
          if (
            Object.keys(args).some((key) => !['workflow', 'goal', 'inputs'].includes(key))
          ) {
            return { ok: false, toolError: 'invalid start_workflow arguments' };
          }
          const startIdempotencyKey = `turn-${stableHash(ctx.turnId, opId)}`;
          return {
            ok: true,
            command: {
              kind: 'start_workflow',
              opId,
              definitionId: semanticReference.definitionId,
              ...(semanticReference.version !== undefined ? { version: semanticReference.version } : {}),
              startIdempotencyKey,
              ...(typeof args.goal === 'string' ? { goal: args.goal } : {}),
              entryInputs,
            },
          };
        }
        return { ok: false, toolError: 'invalid start_workflow arguments' };
      }
      default:
        return { ok: false, toolError: `unsupported mutating tool: ${tool}` };
    }
  }

  if (tool === 'inspect_workflow_run') {
    if (Object.keys(args).some((key) => key !== 'runId' && key !== 'runRef')) {
      return { ok: false, toolError: 'inspect_workflow_run accepts only runRef' };
    }
    const runId = requireString(args, 'runRef') ?? requireString(args, 'runId');
    if (!runId) {
      return { ok: false, toolError: 'runRef is required' };
    }
    return { ok: true, command: { kind: 'inspect_workflow_run', runId } };
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
