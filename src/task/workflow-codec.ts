/**
 * Bounded codecs for the canonical workflow manifest, normalized topology, and
 * deterministic definition/start fingerprints.
 */

import { createHash } from 'node:crypto';
import {
  WORKFLOW_DESCRIPTION_MAX_LENGTH,
  WORKFLOW_ENTRY_CONTRACTS_MAX,
  WORKFLOW_GRAPH_MAX_EDGES,
  WORKFLOW_GRAPH_MAX_NODES,
  WORKFLOW_INSTRUCTIONS_MAX_LENGTH,
  WORKFLOW_NAME_MAX_LENGTH,
  WORKFLOW_OUTCOME_WHEN_MAX_LENGTH,
  WORKFLOW_PACKAGE_HASH_LENGTH,
  WORKFLOW_PACKAGE_PATH_MAX_LENGTH,
  WORKFLOW_SCHEMA,
  WORKFLOW_SCRIPT_ARG_MAX_LENGTH,
  WORKFLOW_SCRIPT_FILE_MAX_LENGTH,
  WORKFLOW_SCRIPT_MAX_ARGS,
  WORKFLOW_TITLE_MAX_LENGTH,
  isValidWorkflowScriptFile,
  type DefineWorkflowInput,
  type ScriptExecutionSpec,
  type StartWorkflowEntryInput,
  type StartWorkflowNodeReuse,
  type WorkflowAgentOutcome,
  type WorkflowDefinition,
  type WorkflowDependencyEdge,
  type WorkflowEntryContract,
  type WorkflowExitOutcome,
  type WorkflowInputContract,
  type WorkflowInstructions,
  type WorkflowNodeOutcome,
  type WorkflowNodeSpec,
  type WorkflowOutputContract,
  type WorkflowPolicy,
  type WorkflowScriptSource,
  type WorkflowTopology,
} from './workflow-types';

const MAX_ID_LEN = 128;
const MAX_CAPABILITIES = 16;
const MAX_ARTIFACT_KIND_LEN = 128;
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TASK_CAPABILITIES = new Set([
  'create_child',
  'start_child',
  'wait_child',
  'interrupt_child',
  'cancel_child',
  'read_subtree',
]);

export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  maxFeedbackRoundsPerRun: 8,
  maxTurnsPerTask: 50,
  maxWorkflowTurnsPerRun: 64,
  runTimeoutMs: 1_800_000,
  maxDepth: 8,
  maxTaskCount: 64,
  maxConcurrency: 20,
  maxInputsPerGate: 64,
  maxArtifactBytes: 262_144,
  maxAggregateBytes: 1_048_576,
  failWorkflow: true,
};

export const WORKFLOW_POLICY_BOUNDS = {
  maxFeedbackRoundsPerRun: { min: 1, max: 32 },
  maxTurnsPerTask: { min: 1, max: 500 },
  maxWorkflowTurnsPerRun: { min: 1, max: 256 },
  runTimeoutMs: { min: 1_000, max: 28_800_000 },
  maxDepth: { min: 1, max: 8 },
  maxTaskCount: { min: 1, max: 64 },
  maxConcurrency: { min: 1, max: 64 },
  maxInputsPerGate: { min: 1, max: 64 },
  maxArtifactBytes: { min: 1, max: 262_144 },
  maxAggregateBytes: { min: 1, max: 1_048_576 },
} as const;

export type TopologyDecodeResult =
  | { ok: true; topology: WorkflowTopology }
  | { ok: false; reason: string };

export type DefinitionDecodeResult =
  | { ok: true; definition: WorkflowDefinition; fingerprint: string }
  | { ok: false; reason: string };

export type WorkflowManifestDecodeResult =
  | {
      ok: true;
      name: string;
      topology: WorkflowTopology;
      entryContracts: WorkflowEntryContract[];
    }
  | { ok: false; reason: string };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isStableId(value: unknown): value is string {
  return isNonEmptyString(value, MAX_ID_LEN) && STABLE_ID_RE.test(value);
}

function onlyKeys(record: RecordValue, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(record).every((key) => set.has(key));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isSafeRelativePath(value: string, allowDot = false): boolean {
  if (value === '.' && allowDot) return true;
  const portable = value.replace(/\\/g, '/');
  return !portable.startsWith('/') &&
    !/^[A-Za-z]:/.test(portable) &&
    !/[\x00-\x1f\x7f]/.test(portable) &&
    !portable.split('/').some((part) => part === '' || part === '..');
}

function decodeWorkflowScriptSource(raw: unknown): WorkflowScriptSource | undefined {
  if (!isRecord(raw)) return undefined;
  if (!onlyKeys(raw, [
    'kind', 'scope', 'packageKind', 'catalogRootKind', 'packagePath',
    'entryFile', 'workflowRef', 'packageSha256', 'scriptSha256',
  ])) return undefined;
  if (
    raw.kind !== 'predefined' ||
    (raw.scope !== 'workspace' && raw.scope !== 'global') ||
    (raw.packageKind !== 'file' && raw.packageKind !== 'bundle') ||
    (raw.catalogRootKind !== 'canonical' && raw.catalogRootKind !== 'legacy' && raw.catalogRootKind !== 'custom') ||
    !isNonEmptyString(raw.packagePath, WORKFLOW_PACKAGE_PATH_MAX_LENGTH) ||
    !isNonEmptyString(raw.entryFile, WORKFLOW_SCRIPT_FILE_MAX_LENGTH) ||
    !isNonEmptyString(raw.workflowRef, 64) ||
    !isNonEmptyString(raw.packageSha256, WORKFLOW_PACKAGE_HASH_LENGTH) ||
    !isNonEmptyString(raw.scriptSha256, WORKFLOW_PACKAGE_HASH_LENGTH)
  ) return undefined;
  if (
    !isSafeRelativePath(raw.packagePath, true) ||
    !isSafeRelativePath(raw.entryFile) ||
    (raw.packageKind === 'file' ? raw.packagePath !== '.' : raw.packagePath === '.') ||
    !/^pwf_[a-f0-9]{32}$/.test(raw.workflowRef) ||
    !/^[a-f0-9]{64}$/.test(raw.packageSha256) ||
    !/^[a-f0-9]{64}$/.test(raw.scriptSha256)
  ) return undefined;
  return {
    kind: 'predefined',
    scope: raw.scope,
    packageKind: raw.packageKind,
    catalogRootKind: raw.catalogRootKind,
    packagePath: raw.packagePath,
    entryFile: raw.entryFile,
    workflowRef: raw.workflowRef,
    packageSha256: raw.packageSha256,
    scriptSha256: raw.scriptSha256,
  };
}

function decodeNormalizedInstructions(raw: unknown): WorkflowInstructions | undefined {
  if (!isRecord(raw) || raw.kind !== 'inline' && raw.kind !== 'file') return undefined;
  if (raw.kind === 'inline') {
    if (
      !onlyKeys(raw, ['kind', 'content', 'sha256']) ||
      !isNonEmptyString(raw.content, WORKFLOW_INSTRUCTIONS_MAX_LENGTH) ||
      raw.sha256 !== sha256(raw.content)
    ) return undefined;
    return { kind: 'inline', content: raw.content, sha256: raw.sha256 };
  }
  if (!onlyKeys(raw, ['kind', 'file', 'content', 'sha256'])) return undefined;
  if (
    !isNonEmptyString(raw.file, WORKFLOW_SCRIPT_FILE_MAX_LENGTH) ||
    !isSafeRelativePath(raw.file)
  ) return undefined;
  if ((raw.content === undefined) !== (raw.sha256 === undefined)) return undefined;
  if (raw.content !== undefined) {
    if (
      !isNonEmptyString(raw.content, WORKFLOW_INSTRUCTIONS_MAX_LENGTH) ||
      raw.sha256 !== sha256(raw.content)
    ) return undefined;
    return { kind: 'file', file: raw.file, content: raw.content, sha256: raw.sha256 as string };
  }
  return { kind: 'file', file: raw.file };
}

function decodeManifestInstructions(
  raw: unknown,
  source: 'inline' | 'saved',
): { ok: true; instructions?: WorkflowInstructions } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw) || !onlyKeys(raw, ['inline', 'file'])) {
    return { ok: false, reason: 'invalid instructions' };
  }
  const hasInline = Object.prototype.hasOwnProperty.call(raw, 'inline');
  const hasFile = Object.prototype.hasOwnProperty.call(raw, 'file');
  if (hasInline === hasFile) return { ok: false, reason: 'instructions require exactly one of inline or file' };
  if (hasInline) {
    if (!isNonEmptyString(raw.inline, WORKFLOW_INSTRUCTIONS_MAX_LENGTH)) {
      return { ok: false, reason: 'invalid instructions inline content' };
    }
    return {
      ok: true,
      instructions: { kind: 'inline', content: raw.inline, sha256: sha256(raw.inline) },
    };
  }
  if (
    source !== 'saved' ||
    !isNonEmptyString(raw.file, WORKFLOW_SCRIPT_FILE_MAX_LENGTH) ||
    !isSafeRelativePath(raw.file)
  ) {
    return { ok: false, reason: 'file instructions require a saved package' };
  }
  return { ok: true, instructions: { kind: 'file', file: raw.file } };
}

function decodeScriptExecution(raw: unknown): ScriptExecutionSpec | undefined {
  if (!isRecord(raw) || raw.kind !== 'script') return undefined;
  if (!onlyKeys(raw, ['kind', 'interpreter', 'file', 'args', 'source'])) return undefined;
  if (raw.interpreter !== 'node' && raw.interpreter !== 'python' && raw.interpreter !== 'python3') {
    return undefined;
  }
  if (!isValidWorkflowScriptFile(raw.file, raw.interpreter)) return undefined;
  if (
    !Array.isArray(raw.args) ||
    raw.args.length > WORKFLOW_SCRIPT_MAX_ARGS ||
    !raw.args.every((arg) =>
      typeof arg === 'string' &&
      arg.length <= WORKFLOW_SCRIPT_ARG_MAX_LENGTH &&
      !arg.includes('\0'))
  ) return undefined;
  let source: WorkflowScriptSource | undefined;
  if (raw.source !== undefined) {
    source = decodeWorkflowScriptSource(raw.source);
    if (!source) return undefined;
  }
  return {
    kind: 'script',
    interpreter: raw.interpreter,
    file: raw.file,
    args: [...raw.args] as string[],
    ...(source ? { source } : {}),
  };
}

function decodeManifestScript(raw: unknown): ScriptExecutionSpec | undefined {
  if (!isRecord(raw) || !onlyKeys(raw, ['interpreter', 'file', 'args'])) return undefined;
  if (raw.interpreter !== 'node' && raw.interpreter !== 'python' && raw.interpreter !== 'python3') {
    return undefined;
  }
  const args = raw.args === undefined ? [] : raw.args;
  if (
    !isValidWorkflowScriptFile(raw.file, raw.interpreter) ||
    !Array.isArray(args) ||
    args.length > WORKFLOW_SCRIPT_MAX_ARGS ||
    !args.every((arg) =>
      typeof arg === 'string' &&
      arg.length <= WORKFLOW_SCRIPT_ARG_MAX_LENGTH &&
      !arg.includes('\0'))
  ) return undefined;
  return {
    kind: 'script',
    interpreter: raw.interpreter,
    file: raw.file,
    args: [...args] as string[],
  };
}

type ValueDecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function decodeAgentOutcome(raw: Record<string, unknown>): ValueDecodeResult<WorkflowAgentOutcome> {
  if (!onlyKeys(raw, ['kind', 'requireExplicitDisposition', 'next', 'prev', 'fail'])) {
    return { ok: false, reason: 'invalid agent outcome field' };
  }
  if (typeof raw.requireExplicitDisposition !== 'boolean') {
    return { ok: false, reason: 'agent outcome requireExplicitDisposition must be boolean' };
  }

  let next: WorkflowAgentOutcome['next'];
  if (raw.next !== undefined) {
    if (
      !isRecord(raw.next) || !onlyKeys(raw.next, ['when']) ||
      !isNonEmptyString(raw.next.when, WORKFLOW_OUTCOME_WHEN_MAX_LENGTH)
    ) return { ok: false, reason: 'invalid agent NEXT outcome route' };
    next = { when: raw.next.when };
  }

  let prev: WorkflowAgentOutcome['prev'];
  if (raw.prev !== undefined) {
    if (!Array.isArray(raw.prev) || raw.prev.length === 0 || raw.prev.length > WORKFLOW_GRAPH_MAX_EDGES) {
      return { ok: false, reason: 'agent PREV routes require a nonempty bounded array' };
    }
    const routes: Array<NonNullable<WorkflowAgentOutcome['prev']>[number]> = [];
    for (const value of raw.prev) {
      if (!isRecord(value) || !onlyKeys(value, ['when', 'targets', 'feedback'])) {
        return { ok: false, reason: 'invalid agent PREV outcome field' };
      }
      if (!isNonEmptyString(value.when, WORKFLOW_OUTCOME_WHEN_MAX_LENGTH)) {
        return { ok: false, reason: 'invalid agent PREV outcome condition' };
      }
      if (
        !Array.isArray(value.targets) || value.targets.length === 0 ||
        value.targets.length > WORKFLOW_GRAPH_MAX_EDGES ||
        !value.targets.every(isStableId)
      ) return { ok: false, reason: 'agent PREV targets require nonempty bounded inputRef names' };
      if (new Set(value.targets).size !== value.targets.length) {
        return { ok: false, reason: 'duplicate agent PREV target' };
      }
      if (value.feedback !== 'required') {
        return { ok: false, reason: 'agent PREV feedback must be required' };
      }
      routes.push({ when: value.when, targets: [...value.targets] as string[], feedback: 'required' as const });
    }
    prev = routes;
  }

  let fail: WorkflowAgentOutcome['fail'];
  if (raw.fail !== undefined) {
    if (
      !isRecord(raw.fail) || !onlyKeys(raw.fail, ['when']) ||
      !isNonEmptyString(raw.fail.when, WORKFLOW_OUTCOME_WHEN_MAX_LENGTH)
    ) return { ok: false, reason: 'invalid agent FAIL outcome route' };
    fail = { when: raw.fail.when };
  }

  if (!next && !prev && !fail) {
    return { ok: false, reason: 'agent outcome requires at least one route' };
  }
  if (!raw.requireExplicitDisposition && !next) {
    return { ok: false, reason: 'agent outcome with requireExplicitDisposition false requires a NEXT route' };
  }
  return {
    ok: true,
    value: {
      kind: 'agent',
      requireExplicitDisposition: raw.requireExplicitDisposition,
      ...(next ? { next } : {}),
      ...(prev ? { prev } : {}),
      ...(fail ? { fail } : {}),
    },
  };
}

function isExitZeroWhen(raw: unknown): boolean {
  return isRecord(raw) && onlyKeys(raw, ['exitCode']) && raw.exitCode === 0;
}

function isExitNonzeroWhen(raw: unknown): boolean {
  return isRecord(raw) && onlyKeys(raw, ['exitCode']) && raw.exitCode === 'nonzero';
}

function decodeExitOutcome(raw: Record<string, unknown>): ValueDecodeResult<WorkflowExitOutcome> {
  if (!onlyKeys(raw, ['kind', 'next', 'prev', 'fail'])) {
    return { ok: false, reason: 'invalid exit outcome field' };
  }
  if (
    !isRecord(raw.next) || !onlyKeys(raw.next, ['when']) ||
    !isExitZeroWhen(raw.next.when)
  ) return { ok: false, reason: 'exit outcome NEXT route must match exitCode zero' };
  const hasPrev = raw.prev !== undefined;
  const hasFail = raw.fail !== undefined;
  if (hasPrev === hasFail) {
    return { ok: false, reason: 'exit outcome requires exactly one nonzero PREV or FAIL route for complete coverage' };
  }
  if (hasPrev) {
    if (!isRecord(raw.prev) || !onlyKeys(raw.prev, ['when', 'targets', 'feedback'])) {
      return { ok: false, reason: 'invalid exit PREV outcome field' };
    }
    if (!isExitNonzeroWhen(raw.prev.when)) {
      return { ok: false, reason: 'exit PREV outcome must match exitCode nonzero' };
    }
    if (
      !Array.isArray(raw.prev.targets) || raw.prev.targets.length === 0 ||
      raw.prev.targets.length > WORKFLOW_GRAPH_MAX_EDGES ||
      !raw.prev.targets.every(isStableId)
    ) return { ok: false, reason: 'exit PREV targets require nonempty bounded inputRef names' };
    if (new Set(raw.prev.targets).size !== raw.prev.targets.length) {
      return { ok: false, reason: 'duplicate exit PREV target' };
    }
    if (raw.prev.feedback !== 'stdout') {
      return { ok: false, reason: 'exit PREV feedback must be stdout' };
    }
    return {
      ok: true,
      value: {
        kind: 'exit',
        next: { when: { exitCode: 0 } },
        prev: {
          when: { exitCode: 'nonzero' },
          targets: [...raw.prev.targets] as string[],
          feedback: 'stdout',
        },
      },
    };
  }
  if (
    !isRecord(raw.fail) || !onlyKeys(raw.fail, ['when']) ||
    !isExitNonzeroWhen(raw.fail.when)
  ) return { ok: false, reason: 'exit FAIL outcome must match exitCode nonzero' };
  return {
    ok: true,
    value: {
      kind: 'exit',
      next: { when: { exitCode: 0 } },
      fail: { when: { exitCode: 'nonzero' } },
    },
  };
}

function decodeOutcome(raw: unknown): ValueDecodeResult<WorkflowNodeOutcome> {
  if (!isRecord(raw)) return { ok: false, reason: 'node outcome must be an object' };
  return raw.kind === 'agent'
    ? decodeAgentOutcome(raw)
    : raw.kind === 'exit'
      ? decodeExitOutcome(raw)
      : { ok: false, reason: 'unsupported node outcome kind' };
}

function decodeNormalizedNode(raw: unknown): WorkflowNodeSpec | undefined {
  if (!isRecord(raw) || !isStableId(raw.nodeId)) return undefined;
  if (!onlyKeys(raw, [
    'nodeId', 'title', 'instructions', 'role', 'taskType', 'backend', 'model',
    'capabilities', 'execution', 'outcome',
  ])) return undefined;
  if (raw.title !== undefined && !isNonEmptyString(raw.title, WORKFLOW_TITLE_MAX_LENGTH)) return undefined;
  for (const key of ['taskType', 'backend', 'model'] as const) {
    if (raw[key] !== undefined && !isNonEmptyString(raw[key], MAX_ID_LEN)) return undefined;
  }
  if (raw.role !== undefined && raw.role !== 'coordinator' && raw.role !== 'worker') return undefined;
  const instructions = raw.instructions === undefined
    ? undefined
    : decodeNormalizedInstructions(raw.instructions);
  if (raw.instructions !== undefined && !instructions) return undefined;
  let capabilities: string[] | undefined;
  if (raw.capabilities !== undefined) {
    if (
      !Array.isArray(raw.capabilities) || raw.capabilities.length > MAX_CAPABILITIES ||
      !raw.capabilities.every((value) => isNonEmptyString(value, MAX_ID_LEN) && TASK_CAPABILITIES.has(value)) ||
      new Set(raw.capabilities).size !== raw.capabilities.length
    ) return undefined;
    capabilities = [...raw.capabilities] as string[];
  }
  const execution = raw.execution === undefined ? undefined : decodeScriptExecution(raw.execution);
  if (raw.execution !== undefined && !execution) return undefined;
  const decodedOutcome = raw.outcome === undefined ? undefined : decodeOutcome(raw.outcome);
  if (decodedOutcome && !decodedOutcome.ok) return undefined;
  const outcome = decodedOutcome?.value;
  if (execution) {
    if (
      raw.backend !== 'script' || raw.model !== undefined || raw.taskType !== undefined ||
      raw.role === 'coordinator' || (capabilities?.length ?? 0) > 0 || outcome?.kind !== 'exit'
    ) return undefined;
  } else {
    if (raw.backend === 'script' || outcome?.kind === 'exit') return undefined;
  }
  return {
    nodeId: raw.nodeId,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(instructions ? { instructions } : {}),
    ...(raw.role === 'coordinator' || raw.role === 'worker' ? { role: raw.role } : {}),
    ...(typeof raw.taskType === 'string' ? { taskType: raw.taskType } : {}),
    ...(typeof raw.backend === 'string' ? { backend: raw.backend } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(execution ? { execution } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

function decodeNormalizedEdge(raw: unknown): WorkflowDependencyEdge | undefined {
  if (!isRecord(raw) || !onlyKeys(raw, ['fromNodeId', 'toNodeId', 'inputRef', 'expectedArtifactKind'])) {
    return undefined;
  }
  if (
    !isStableId(raw.fromNodeId) || !isStableId(raw.toNodeId) ||
    !isStableId(raw.inputRef)
  ) return undefined;
  if (
    raw.expectedArtifactKind !== undefined &&
    !isNonEmptyString(raw.expectedArtifactKind, MAX_ARTIFACT_KIND_LEN)
  ) return undefined;
  return {
    fromNodeId: raw.fromNodeId,
    toNodeId: raw.toNodeId,
    inputRef: raw.inputRef,
    ...(typeof raw.expectedArtifactKind === 'string'
      ? { expectedArtifactKind: raw.expectedArtifactKind }
      : {}),
  };
}

function decodeNormalizedInput(raw: unknown): WorkflowInputContract | undefined {
  if (!isRecord(raw) || !onlyKeys(raw, ['name', 'semanticKind', 'entryNodeId', 'inputRef'])) return undefined;
  if (
    !isStableId(raw.name) ||
    !isNonEmptyString(raw.semanticKind, MAX_ARTIFACT_KIND_LEN) ||
    !isStableId(raw.entryNodeId) ||
    !isStableId(raw.inputRef)
  ) return undefined;
  return {
    name: raw.name,
    semanticKind: raw.semanticKind,
    entryNodeId: raw.entryNodeId,
    inputRef: raw.inputRef,
  };
}

function decodeNormalizedOutput(raw: unknown): WorkflowOutputContract | undefined {
  if (!isRecord(raw) || !onlyKeys(raw, ['name', 'semanticKind', 'terminalNodeId'])) return undefined;
  if (
    !isStableId(raw.name) ||
    !isNonEmptyString(raw.semanticKind, MAX_ARTIFACT_KIND_LEN) ||
    !isStableId(raw.terminalNodeId)
  ) return undefined;
  return {
    name: raw.name,
    semanticKind: raw.semanticKind,
    terminalNodeId: raw.terminalNodeId,
  };
}

function hasCycle(nodeIds: readonly string[], edges: readonly WorkflowDependencyEdge[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const edge of edges) outgoing.get(edge.fromNodeId)?.push(edge.toNodeId);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodeIds.some(visit);
}

function validateTopologySemantics(topology: WorkflowTopology): string | undefined {
  if (topology.nodes.length < 1 || topology.nodes.length > WORKFLOW_GRAPH_MAX_NODES) {
    return 'workflow requires 1..64 nodes';
  }
  if (topology.edges.length > WORKFLOW_GRAPH_MAX_EDGES) return 'workflow edges exceed bounds';
  if (topology.inputs.length > WORKFLOW_ENTRY_CONTRACTS_MAX) return 'workflow inputs exceed bounds';

  const nodeIds = topology.nodes.map((node) => node.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) return 'duplicate node';
  const nodeIdSet = new Set(nodeIds);
  const inDegree = new Map(nodeIds.map((id) => [id, 0]));
  const outDegree = new Map(nodeIds.map((id) => [id, 0]));
  const consumerSlots = new Set<string>();
  const inboundRefs = new Map<string, Set<string>>(nodeIds.map((id) => [id, new Set<string>()]));
  for (const edge of topology.edges) {
    if (!nodeIdSet.has(edge.fromNodeId) || !nodeIdSet.has(edge.toNodeId)) {
      return 'edge references unknown node';
    }
    if (edge.fromNodeId === edge.toNodeId) return 'cycle not allowed';
    const slot = `${edge.toNodeId}\0${edge.inputRef}`;
    if (consumerSlots.has(slot)) return 'duplicate inputRef on consumer';
    consumerSlots.add(slot);
    inboundRefs.get(edge.toNodeId)!.add(edge.inputRef);
    outDegree.set(edge.fromNodeId, outDegree.get(edge.fromNodeId)! + 1);
    inDegree.set(edge.toNodeId, inDegree.get(edge.toNodeId)! + 1);
  }
  for (const [nodeId, degree] of outDegree) {
    if (degree > 1) return `fan-out not allowed: node ${nodeId}`;
  }
  if (hasCycle(nodeIds, topology.edges)) return 'cycle not allowed';
  if (nodeIds.length > 1) {
    for (const nodeId of nodeIds) {
      if (inDegree.get(nodeId) === 0 && outDegree.get(nodeId) === 0) return 'isolated node';
    }
  }

  const entryIds = new Set(nodeIds.filter((id) => inDegree.get(id) === 0));
  const terminalIds = nodeIds.filter((id) => outDegree.get(id) === 0);
  const inputNames = new Set<string>();
  const publicSlots = new Set<string>();
  const publicInputCounts = new Map<string, number>();
  for (const input of topology.inputs) {
    if (inputNames.has(input.name)) return 'duplicate workflow input name';
    inputNames.add(input.name);
    if (!entryIds.has(input.entryNodeId)) return 'workflow input must bind an entry node';
    const slot = `${input.entryNodeId}\0${input.inputRef}`;
    if (publicSlots.has(slot)) return 'duplicate workflow input binding';
    publicSlots.add(slot);
    const count = (publicInputCounts.get(input.entryNodeId) ?? 0) + 1;
    if (count > WORKFLOW_POLICY_BOUNDS.maxInputsPerGate.max) {
      return `workflow entry input gate exceeds ${WORKFLOW_POLICY_BOUNDS.maxInputsPerGate.max} inputs`;
    }
    publicInputCounts.set(input.entryNodeId, count);
  }

  const outputNames = new Set<string>();
  const outputTerminals = new Set<string>();
  for (const output of topology.outputs) {
    if (outputNames.has(output.name)) return 'duplicate workflow output name';
    outputNames.add(output.name);
    if (!terminalIds.includes(output.terminalNodeId)) return 'workflow output must reference a terminal node';
    if (outputTerminals.has(output.terminalNodeId)) return 'every terminal must be exported exactly once';
    outputTerminals.add(output.terminalNodeId);
  }
  if (outputTerminals.size !== terminalIds.length) return 'unexported terminal: every terminal must be exported';

  for (const node of topology.nodes) {
    const outcome = node.outcome;
    if (!outcome) continue;
    const inbound = inboundRefs.get(node.nodeId)!;
    const targets = outcome.kind === 'agent'
      ? outcome.prev?.flatMap((route) => route.targets) ?? []
      : outcome.prev?.targets ?? [];
    if (targets.length > 0 && inbound.size === 0) return 'entry nodes cannot declare PREV';
    for (const target of targets) {
      if (!inbound.has(target)) return 'PREV target must be a unique inbound inputRef';
    }
  }
  return undefined;
}

export function decodeTopology(raw: unknown): TopologyDecodeResult {
  if (!isRecord(raw) || raw.kind !== 'workflow') {
    return { ok: false, reason: 'unsupported topology kind' };
  }
  if (!onlyKeys(raw, ['kind', 'description', 'inputs', 'outputs', 'nodes', 'edges'])) {
    return { ok: false, reason: 'unsupported topology field' };
  }
  if (
    raw.description !== undefined &&
    !isNonEmptyString(raw.description, WORKFLOW_DESCRIPTION_MAX_LENGTH)
  ) return { ok: false, reason: 'invalid workflow description' };
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !Array.isArray(raw.inputs) || !Array.isArray(raw.outputs)) {
    return { ok: false, reason: 'workflow topology arrays are required' };
  }
  if (raw.nodes.length < 1 || raw.nodes.length > WORKFLOW_GRAPH_MAX_NODES) {
    return { ok: false, reason: 'workflow nodes exceed bounds' };
  }
  if (raw.edges.length > WORKFLOW_GRAPH_MAX_EDGES) {
    return { ok: false, reason: 'workflow edges exceed bounds' };
  }
  if (raw.inputs.length > WORKFLOW_ENTRY_CONTRACTS_MAX) {
    return { ok: false, reason: 'workflow inputs exceed bounds' };
  }
  if (raw.outputs.length < 1 || raw.outputs.length > WORKFLOW_GRAPH_MAX_NODES) {
    return { ok: false, reason: 'workflow outputs exceed bounds' };
  }
  const nodes = raw.nodes.map(decodeNormalizedNode);
  if (nodes.some((node) => !node)) return { ok: false, reason: 'invalid node specification' };
  const edges = raw.edges.map(decodeNormalizedEdge);
  if (edges.some((edge) => !edge)) return { ok: false, reason: 'invalid edge specification' };
  const inputs = raw.inputs.map(decodeNormalizedInput);
  if (inputs.some((input) => !input)) return { ok: false, reason: 'invalid workflow input' };
  const outputs = raw.outputs.map(decodeNormalizedOutput);
  if (outputs.some((output) => !output)) return { ok: false, reason: 'invalid workflow output' };
  const topology: WorkflowTopology = {
    kind: 'workflow',
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    inputs: inputs as WorkflowInputContract[],
    outputs: outputs as WorkflowOutputContract[],
    nodes: nodes as WorkflowNodeSpec[],
    edges: edges as WorkflowDependencyEdge[],
  };
  const semanticError = validateTopologySemantics(topology);
  return semanticError ? { ok: false, reason: semanticError } : { ok: true, topology };
}

function decodeManifestNode(
  raw: unknown,
  source: 'inline' | 'saved',
): { ok: true; node: WorkflowNodeSpec } | { ok: false; reason: string } {
  if (!isRecord(raw) || !onlyKeys(raw, [
    'nodeKey', 'taskType', 'script', 'title', 'instructions', 'outcome',
  ])) return { ok: false, reason: 'invalid node field' };
  if (!isStableId(raw.nodeKey)) return { ok: false, reason: 'invalid nodeKey' };
  if (raw.title !== undefined && !isNonEmptyString(raw.title, WORKFLOW_TITLE_MAX_LENGTH)) {
    return { ok: false, reason: 'invalid node title' };
  }
  const instructions = decodeManifestInstructions(raw.instructions, source);
  if (!instructions.ok) return instructions;
  const hasTaskType = Object.prototype.hasOwnProperty.call(raw, 'taskType');
  const hasScript = Object.prototype.hasOwnProperty.call(raw, 'script');
  if (hasTaskType === hasScript) return { ok: false, reason: 'node requires exactly one of taskType or script' };
  const decodedOutcome = raw.outcome === undefined ? undefined : decodeOutcome(raw.outcome);
  if (decodedOutcome && !decodedOutcome.ok) return decodedOutcome;
  const outcome = decodedOutcome?.value;
  if (hasTaskType) {
    if (!isStableId(raw.taskType) || outcome?.kind === 'exit') {
      return { ok: false, reason: 'agent node requires taskType and optional agent outcome' };
    }
    return {
      ok: true,
      node: {
        nodeId: raw.nodeKey,
        taskType: raw.taskType,
        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
        ...(instructions.instructions ? { instructions: instructions.instructions } : {}),
        ...(outcome ? { outcome } : {}),
      },
    };
  }
  const execution = decodeManifestScript(raw.script);
  if (!execution || outcome?.kind !== 'exit') {
    return { ok: false, reason: 'execute node requires script and complete exit outcome' };
  }
  return {
    ok: true,
    node: {
      nodeId: raw.nodeKey,
      backend: 'script',
      execution,
      outcome,
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(instructions.instructions ? { instructions: instructions.instructions } : {}),
    },
  };
}

export function decodeWorkflowManifest(
  raw: unknown,
  source: 'inline' | 'saved',
): WorkflowManifestDecodeResult {
  if (!isRecord(raw) || !onlyKeys(raw, [
    'schema', 'name', 'description', 'inputs', 'outputs', 'nodes', 'edges',
  ])) return { ok: false, reason: 'unknown workflow manifest field' };
  if (raw.schema !== WORKFLOW_SCHEMA) return { ok: false, reason: 'unsupported workflow schema' };
  if (!isNonEmptyString(raw.name, WORKFLOW_NAME_MAX_LENGTH)) return { ok: false, reason: 'invalid name' };
  if (
    raw.description !== undefined &&
    !isNonEmptyString(raw.description, WORKFLOW_DESCRIPTION_MAX_LENGTH)
  ) return { ok: false, reason: 'invalid description' };
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !Array.isArray(raw.inputs) || !Array.isArray(raw.outputs)) {
    return { ok: false, reason: 'manifest inputs, outputs, nodes, and edges are required arrays' };
  }
  if (raw.nodes.length < 1 || raw.nodes.length > WORKFLOW_GRAPH_MAX_NODES) {
    return { ok: false, reason: 'workflow requires 1..64 nodes' };
  }
  if (
    raw.edges.length > WORKFLOW_GRAPH_MAX_EDGES ||
    raw.inputs.length > WORKFLOW_ENTRY_CONTRACTS_MAX ||
    raw.outputs.length < 1 ||
    raw.outputs.length > WORKFLOW_GRAPH_MAX_NODES
  ) {
    return { ok: false, reason: 'workflow graph exceeds bounds' };
  }
  const nodes: WorkflowNodeSpec[] = [];
  for (const value of raw.nodes) {
    const decoded = decodeManifestNode(value, source);
    if (!decoded.ok) return decoded;
    nodes.push(decoded.node);
  }
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  if (nodeIds.size !== nodes.length) return { ok: false, reason: 'duplicate node' };

  const edges: WorkflowDependencyEdge[] = [];
  for (const value of raw.edges) {
    if (!isRecord(value) || !onlyKeys(value, ['from', 'to', 'inputRef'])) {
      return { ok: false, reason: 'invalid edge field' };
    }
    if (
      !isStableId(value.from) || !isStableId(value.to) ||
      !isStableId(value.inputRef)
    ) return { ok: false, reason: 'invalid edge specification' };
    edges.push({
      fromNodeId: value.from,
      toNodeId: value.to,
      inputRef: value.inputRef,
      expectedArtifactKind: 'next_result',
    });
  }

  const inputs: WorkflowInputContract[] = [];
  for (const value of raw.inputs) {
    if (!isRecord(value) || !onlyKeys(value, ['name', 'kind', 'to', 'inputRef'])) {
      return { ok: false, reason: 'invalid workflow input field' };
    }
    if (
      !isStableId(value.name) || !isNonEmptyString(value.kind, MAX_ARTIFACT_KIND_LEN) ||
      !isStableId(value.to) || !isStableId(value.inputRef)
    ) return { ok: false, reason: 'invalid workflow input' };
    inputs.push({
      name: value.name,
      semanticKind: value.kind,
      entryNodeId: value.to,
      inputRef: value.inputRef,
    });
  }

  const outputs: WorkflowOutputContract[] = [];
  for (const value of raw.outputs) {
    if (!isRecord(value) || !onlyKeys(value, ['name', 'kind', 'from'])) {
      return { ok: false, reason: 'invalid workflow output field' };
    }
    if (
      !isStableId(value.name) || !isNonEmptyString(value.kind, MAX_ARTIFACT_KIND_LEN) ||
      !isStableId(value.from)
    ) return { ok: false, reason: 'invalid workflow output' };
    outputs.push({
      name: value.name,
      semanticKind: value.kind,
      terminalNodeId: value.from,
    });
  }

  const topology: WorkflowTopology = {
    kind: 'workflow',
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    inputs,
    outputs,
    nodes,
    edges,
  };
  const semanticError = validateTopologySemantics(topology);
  if (semanticError) return { ok: false, reason: semanticError };
  return {
    ok: true,
    name: raw.name,
    topology,
    entryContracts: inputs.map((input) => ({
      entryNodeId: input.entryNodeId,
      inputRef: input.inputRef,
      expectedArtifactKind: 'workflow_input',
    })),
  };
}

function encodeInstructions(instructions: WorkflowInstructions): RecordValue {
  return instructions.kind === 'inline'
    ? { kind: 'inline', content: instructions.content, sha256: instructions.sha256 }
    : {
        kind: 'file',
        file: instructions.file,
        ...(instructions.content !== undefined ? { content: instructions.content } : {}),
        ...(instructions.sha256 !== undefined ? { sha256: instructions.sha256 } : {}),
      };
}

function encodeOutcome(outcome: WorkflowNodeOutcome): RecordValue {
  if (outcome.kind === 'agent') {
    return {
      kind: 'agent',
      requireExplicitDisposition: outcome.requireExplicitDisposition,
      ...(outcome.next ? { next: { when: outcome.next.when } } : {}),
      ...(outcome.prev ? {
        prev: outcome.prev.map((route) => ({
          when: route.when,
          targets: [...route.targets],
          feedback: 'required',
        })),
      } : {}),
      ...(outcome.fail ? { fail: { when: outcome.fail.when } } : {}),
    };
  }
  return {
    kind: 'exit',
    next: { when: { exitCode: 0 } },
    ...(outcome.prev ? {
      prev: {
        when: { exitCode: 'nonzero' },
        targets: [...outcome.prev.targets],
        feedback: 'stdout',
      },
    } : {}),
    ...(outcome.fail ? { fail: { when: { exitCode: 'nonzero' } } } : {}),
  };
}

function encodeNodeJson(node: WorkflowNodeSpec): RecordValue {
  return {
    nodeId: node.nodeId,
    ...(node.title !== undefined ? { title: node.title } : {}),
    ...(node.instructions !== undefined ? { instructions: encodeInstructions(node.instructions) } : {}),
    ...(node.role !== undefined ? { role: node.role } : {}),
    ...(node.taskType !== undefined ? { taskType: node.taskType } : {}),
    ...(node.backend !== undefined ? { backend: node.backend } : {}),
    ...(node.model !== undefined ? { model: node.model } : {}),
    ...(node.capabilities !== undefined ? { capabilities: [...node.capabilities] } : {}),
    ...(node.execution !== undefined ? {
      execution: {
        kind: 'script',
        interpreter: node.execution.interpreter,
        file: node.execution.file,
        args: [...node.execution.args],
        ...(node.execution.source ? { source: node.execution.source } : {}),
      },
    } : {}),
    ...(node.outcome !== undefined ? { outcome: encodeOutcome(node.outcome) } : {}),
  };
}

export function encodeTopologyJson(topology: WorkflowTopology): string {
  return JSON.stringify({
    kind: 'workflow',
    ...(topology.description !== undefined ? { description: topology.description } : {}),
    inputs: topology.inputs.map((input) => ({
      name: input.name,
      semanticKind: input.semanticKind,
      entryNodeId: input.entryNodeId,
      inputRef: input.inputRef,
    })),
    outputs: topology.outputs.map((output) => ({
      name: output.name,
      semanticKind: output.semanticKind,
      terminalNodeId: output.terminalNodeId,
    })),
    nodes: topology.nodes.map(encodeNodeJson),
    edges: topology.edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      inputRef: edge.inputRef,
      expectedArtifactKind: edge.expectedArtifactKind ?? 'next_result',
    })),
  });
}

export function fingerprintWorkflowDefinition(input: {
  definitionId: string;
  version: number;
  name: string;
  topology: WorkflowTopology;
  entryContracts: readonly WorkflowEntryContract[];
  policy: WorkflowPolicy;
  scope: WorkflowDefinition['scope'];
}): string {
  return sha256(JSON.stringify({
    definitionId: input.definitionId,
    version: input.version,
    name: input.name,
    topology: JSON.parse(encodeTopologyJson(input.topology)),
    entryContracts: input.entryContracts.map((contract) => ({
      entryNodeId: contract.entryNodeId,
      inputRef: contract.inputRef,
      expectedArtifactKind: contract.expectedArtifactKind,
    })),
    policy: input.policy,
    scope: input.scope,
  }));
}

const WORKFLOW_ENTRY_AGGREGATE_PREFIX = '[workflow-entry]';

export function formatWorkflowEntryAggregate(
  inputs: readonly { inputRef: string; value: string }[],
): string {
  if (inputs.length === 0) return `${WORKFLOW_ENTRY_AGGREGATE_PREFIX} engine_start`;
  return [
    WORKFLOW_ENTRY_AGGREGATE_PREFIX,
    ...inputs.flatMap((input) => [
      `inputRef=${JSON.stringify(input.inputRef)} utf8Bytes=${Buffer.byteLength(input.value, 'utf8')}`,
      input.value,
    ]),
  ].join('\n');
}

export function maximumWorkflowEntryAggregateBytes(
  contracts: readonly Pick<WorkflowEntryContract, 'inputRef'>[],
  maxArtifactBytes: number,
): number {
  if (contracts.length === 0) {
    return Buffer.byteLength(`${WORKFLOW_ENTRY_AGGREGATE_PREFIX} engine_start`, 'utf8');
  }
  return contracts.reduce(
    (total, contract) => total
      + 1
      + Buffer.byteLength(
        `inputRef=${JSON.stringify(contract.inputRef)} utf8Bytes=${maxArtifactBytes}`,
        'utf8',
      )
      + 1
      + maxArtifactBytes,
    Buffer.byteLength(WORKFLOW_ENTRY_AGGREGATE_PREFIX, 'utf8'),
  );
}

export function deriveDefaultWorkflowPolicy(
  contracts: readonly Pick<WorkflowEntryContract, 'entryNodeId' | 'inputRef'>[],
): WorkflowPolicy {
  const groups = new Map<string, Array<{ inputRef: string }>>();
  for (const contract of contracts) {
    const group = groups.get(contract.entryNodeId) ?? [];
    group.push({ inputRef: contract.inputRef });
    groups.set(contract.entryNodeId, group);
  }
  const largestGroup = [...groups.values()].sort((left, right) => right.length - left.length)[0] ?? [];
  let maxArtifactBytes = DEFAULT_WORKFLOW_POLICY.maxArtifactBytes;
  while (
    maxArtifactBytes > 1 &&
    maximumWorkflowEntryAggregateBytes(largestGroup, maxArtifactBytes) > WORKFLOW_POLICY_BOUNDS.maxAggregateBytes.max
  ) {
    maxArtifactBytes = Math.max(1, Math.floor(maxArtifactBytes / 2));
  }
  const requiredAggregateBytes = maximumWorkflowEntryAggregateBytes(largestGroup, maxArtifactBytes);
  return {
    ...DEFAULT_WORKFLOW_POLICY,
    maxInputsPerGate: Math.max(DEFAULT_WORKFLOW_POLICY.maxInputsPerGate, largestGroup.length),
    maxArtifactBytes,
    maxAggregateBytes: Math.max(DEFAULT_WORKFLOW_POLICY.maxAggregateBytes, requiredAggregateBytes),
  };
}

function decodePolicy(raw: unknown): { ok: true; policy: WorkflowPolicy } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'policy must be an object' };
  const numericKeys = Object.keys(WORKFLOW_POLICY_BOUNDS) as Array<keyof typeof WORKFLOW_POLICY_BOUNDS>;
  if (!onlyKeys(raw, [...numericKeys, 'failWorkflow'])) {
    return { ok: false, reason: 'invalid policy field' };
  }
  const policy = {} as WorkflowPolicy;
  for (const key of numericKeys) {
    const value = raw[key];
    const bounds = WORKFLOW_POLICY_BOUNDS[key];
    if (!Number.isSafeInteger(value) || (value as number) < bounds.min || (value as number) > bounds.max) {
      return { ok: false, reason: `invalid policy ${key}: expected an integer from ${bounds.min} to ${bounds.max}` };
    }
    (policy as unknown as Record<string, number>)[key] = value as number;
  }
  if (typeof raw.failWorkflow !== 'boolean') return { ok: false, reason: 'invalid policy failWorkflow' };
  policy.failWorkflow = raw.failWorkflow;
  if (policy.maxConcurrency > policy.maxTaskCount) return { ok: false, reason: 'policy concurrency exceeds task count' };
  if (policy.maxArtifactBytes > policy.maxAggregateBytes) return { ok: false, reason: 'policy artifact bound exceeds aggregate bound' };
  return { ok: true, policy };
}

function decodeEntryContracts(
  raw: unknown,
  topology: WorkflowTopology,
  policy: WorkflowPolicy,
): { ok: true; contracts: WorkflowEntryContract[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'entryContracts must be an array' };
  const expected = topology.inputs.map((input) => ({
    entryNodeId: input.entryNodeId,
    inputRef: input.inputRef,
    expectedArtifactKind: 'workflow_input',
  }));
  if (raw.length !== expected.length) return { ok: false, reason: 'entryContracts do not match workflow inputs' };
  const contracts: WorkflowEntryContract[] = [];
  const contractCounts = new Map<string, number>();
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (!isRecord(value) || !onlyKeys(value, ['entryNodeId', 'inputRef', 'expectedArtifactKind'])) {
      return { ok: false, reason: 'invalid entry contract' };
    }
    const match = expected[index]!;
    if (
      value.entryNodeId !== match.entryNodeId ||
      value.inputRef !== match.inputRef ||
      value.expectedArtifactKind !== match.expectedArtifactKind
    ) return { ok: false, reason: 'entryContracts do not match workflow inputs' };
    contracts.push(match);
    const count = (contractCounts.get(match.entryNodeId) ?? 0) + 1;
    if (count > policy.maxInputsPerGate) {
      return {
        ok: false,
        reason: `entry contract count exceeds policy maxInputsPerGate for ${JSON.stringify(match.entryNodeId)}`,
      };
    }
    contractCounts.set(match.entryNodeId, count);
  }
  const entryIds = new Set(topology.nodes.map((node) => node.nodeId));
  for (const entryNodeId of entryIds) {
    const required = maximumWorkflowEntryAggregateBytes(
      contracts.filter((contract) => contract.entryNodeId === entryNodeId),
      policy.maxArtifactBytes,
    );
    if (required > policy.maxAggregateBytes) {
      return {
        ok: false,
        reason: `entry contract aggregate exceeds policy: maxAggregateBytes must be at least ${required} for entry ${JSON.stringify(entryNodeId)} when maxArtifactBytes is ${policy.maxArtifactBytes}`,
      };
    }
  }
  return { ok: true, contracts };
}

export function decodeDefineWorkflowInput(input: DefineWorkflowInput): DefinitionDecodeResult {
  if (!isStableId(input.definitionId)) return { ok: false, reason: 'invalid definitionId' };
  if (!Number.isInteger(input.version) || input.version < 1) return { ok: false, reason: 'invalid version' };
  if (!isNonEmptyString(input.name, WORKFLOW_NAME_MAX_LENGTH)) return { ok: false, reason: 'invalid name' };
  if (
    !isNonEmptyString(input.createdAt, 64) ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  ) return { ok: false, reason: 'invalid createdAt' };
  const decodedTopology = decodeTopology(input.topology);
  if (!decodedTopology.ok) return decodedTopology;
  const decodedPolicy = decodePolicy(input.policy);
  if (!decodedPolicy.ok) return decodedPolicy;
  if (decodedTopology.topology.nodes.length > decodedPolicy.policy.maxTaskCount) {
    return { ok: false, reason: 'topology exceeds policy task count' };
  }
  const decodedContracts = decodeEntryContracts(input.entryContracts, decodedTopology.topology, decodedPolicy.policy);
  if (!decodedContracts.ok) return decodedContracts;
  const scope = input.scope ?? { kind: 'workspace' as const };
  if (
    (scope.kind !== 'workspace' && scope.kind !== 'root') ||
    (scope.kind === 'root' && !isStableId(scope.ownerRootTaskId))
  ) return { ok: false, reason: 'invalid scope' };
  const definition: WorkflowDefinition = {
    definitionId: input.definitionId,
    version: input.version,
    name: input.name,
    topology: decodedTopology.topology,
    entryContracts: decodedContracts.contracts,
    policy: decodedPolicy.policy,
    scope,
    createdAt: input.createdAt,
  };
  return { ok: true, definition, fingerprint: fingerprintWorkflowDefinition(definition) };
}

export function decodeStoredTopologyJson(topologyJson: string): TopologyDecodeResult {
  try {
    return decodeTopology(JSON.parse(topologyJson));
  } catch {
    return { ok: false, reason: 'corrupt topology_json' };
  }
}

export function fingerprintStartEntryInputs(
  entryInputs: readonly StartWorkflowEntryInput[],
): readonly (
  | {
      type: 'literal';
      entryNodeId: string;
      inputRef: string;
      kind: string;
      valueSha256: string;
    }
  | {
      type: 'prior_run_result';
      entryNodeId: string;
      inputRef: string;
      fromRun: string;
      output: string;
    }
)[] {
  return entryInputs.map((entryInput) => (
    'value' in entryInput
      ? {
          type: 'literal',
          entryNodeId: entryInput.entryNodeId,
          inputRef: entryInput.inputRef,
          kind: entryInput.kind,
          valueSha256: sha256(entryInput.value),
        }
      : {
          type: 'prior_run_result',
          entryNodeId: entryInput.entryNodeId,
          inputRef: entryInput.inputRef,
          fromRun: entryInput.fromRun,
          output: entryInput.output,
        }
  ));
}

export function fingerprintStartNodeReuse(
  reuse: readonly StartWorkflowNodeReuse[],
): readonly {
  destinationNodeId: string;
  sourceRunId: string;
  sourceNodeId: string;
  sourceTaskId: string;
}[] {
  return [...reuse]
    .map(({ destinationNodeId, sourceRunId, sourceNodeId, sourceTaskId }) => ({
      destinationNodeId,
      sourceRunId,
      sourceNodeId,
      sourceTaskId,
    }))
    .sort((left, right) => left.destinationNodeId.localeCompare(right.destinationNodeId));
}
