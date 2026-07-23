/**
 * Bounded codecs for workflow topology and definition fingerprints.
 * Fail closed on unsupported, incomplete, or corrupt topology.
 * Fingerprints never include prompt text, message bodies, or artifact bodies.
 */

import { createHash } from 'node:crypto';
import {
  WORKFLOW_GRAPH_MAX_EDGES,
  WORKFLOW_GRAPH_MAX_NODES,
  WORKFLOW_INPUT_REF_MAX_LENGTH,
  WORKFLOW_NODE_LABEL_MAX_LENGTH,
  type DefineWorkflowInput,
  type GraphTopologyV1,
  type OneNodeTopologyV1,
  type WorkflowDefinitionV1,
  type WorkflowDependencyEdgeV1,
  type WorkflowEntryContractV1,
  type WorkflowNodeSpecV1,
  type WorkflowPolicyV1,
  type WorkflowTopologyV1,
} from './workflow-types';

const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 256;
const MAX_CAPABILITIES = 16;
const MAX_ARTIFACT_KIND_LEN = 128;
const TASK_CAPABILITIES = new Set([
  'create_child',
  'start_child',
  'wait_child',
  'interrupt_child',
  'cancel_child',
  'read_subtree',
]);

export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicyV1 = {
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
  | { ok: true; topology: WorkflowTopologyV1 }
  | { ok: false; reason: string };

export type DefinitionDecodeResult =
  | { ok: true; definition: WorkflowDefinitionV1; fingerprint: string }
  | { ok: false; reason: string };

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
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
  contracts: readonly Pick<WorkflowEntryContractV1, 'inputRef'>[],
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
  contracts: readonly Pick<WorkflowEntryContractV1, 'entryNodeId' | 'inputRef'>[],
): WorkflowPolicyV1 {
  const groups = new Map<string, Array<{ inputRef: string }>>();
  for (const contract of contracts) {
    const group = groups.get(contract.entryNodeId) ?? [];
    group.push({ inputRef: contract.inputRef });
    groups.set(contract.entryNodeId, group);
  }
  const largestGroup = [...groups.values()].sort((left, right) => right.length - left.length)[0] ?? [];
  let maxArtifactBytes = DEFAULT_WORKFLOW_POLICY.maxArtifactBytes;
  const aggregateLimit = WORKFLOW_POLICY_BOUNDS.maxAggregateBytes.max;
  while (
    maxArtifactBytes > 1 &&
    maximumWorkflowEntryAggregateBytes(largestGroup, maxArtifactBytes) > aggregateLimit
  ) {
    maxArtifactBytes = Math.max(1, Math.floor(maxArtifactBytes / 2));
  }
  const requiredAggregateBytes = maximumWorkflowEntryAggregateBytes(largestGroup, maxArtifactBytes);
  return {
    ...DEFAULT_WORKFLOW_POLICY,
    maxInputsPerGate: Math.max(
      DEFAULT_WORKFLOW_POLICY.maxInputsPerGate,
      largestGroup.length,
    ),
    maxArtifactBytes,
    maxAggregateBytes: Math.max(
      DEFAULT_WORKFLOW_POLICY.maxAggregateBytes,
      requiredAggregateBytes,
    ),
  };
}

function decodeNode(raw: unknown): WorkflowNodeSpecV1 | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (!isNonEmptyString(rec.nodeId, MAX_ID_LEN)) return undefined;
  if (
    rec.label !== undefined &&
    !isNonEmptyString(rec.label, WORKFLOW_NODE_LABEL_MAX_LENGTH)
  ) return undefined;
  if (rec.role !== undefined && rec.role !== 'coordinator' && rec.role !== 'worker') {
    return undefined;
  }
  for (const key of ['taskType', 'backend', 'model'] as const) {
    if (rec[key] !== undefined && !isNonEmptyString(rec[key], MAX_ID_LEN)) return undefined;
  }
  let capabilities: string[] | undefined;
  if (rec.capabilities !== undefined) {
    if (
      !Array.isArray(rec.capabilities) ||
      rec.capabilities.length > MAX_CAPABILITIES ||
      !rec.capabilities.every((value) =>
        isNonEmptyString(value, MAX_ID_LEN) && TASK_CAPABILITIES.has(value))
    ) {
      return undefined;
    }
    capabilities = [...new Set(rec.capabilities as string[])].sort();
    if (capabilities.length !== rec.capabilities.length) return undefined;
  }
  const node: WorkflowNodeSpecV1 = { nodeId: rec.nodeId };
  if (typeof rec.label === 'string') node.label = rec.label;
  if (rec.role === 'coordinator' || rec.role === 'worker') node.role = rec.role;
  if (typeof rec.taskType === 'string') node.taskType = rec.taskType;
  if (typeof rec.backend === 'string') node.backend = rec.backend;
  if (typeof rec.model === 'string') node.model = rec.model;
  if (capabilities !== undefined) node.capabilities = capabilities;
  // Reject unknown keys so foreign payloads cannot smuggle repository identities.
  for (const key of Object.keys(rec)) {
    if (
      key !== 'nodeId' && key !== 'label' && key !== 'role' && key !== 'taskType' &&
      key !== 'backend' && key !== 'model' && key !== 'capabilities'
    ) return undefined;
  }
  return node;
}

function encodeNodeJson(node: WorkflowNodeSpecV1): Record<string, unknown> {
  const nodeJson: Record<string, unknown> = { nodeId: node.nodeId };
  if (node.label !== undefined) nodeJson.label = node.label;
  if (node.role !== undefined) nodeJson.role = node.role;
  if (node.taskType !== undefined) nodeJson.taskType = node.taskType;
  if (node.backend !== undefined) nodeJson.backend = node.backend;
  if (node.model !== undefined) nodeJson.model = node.model;
  if (node.capabilities !== undefined) nodeJson.capabilities = [...node.capabilities];
  return nodeJson;
}

/**
 * Validate and normalize S01 one-node topology.
 * Rejects multi-node graphs, missing entry, mismatched entry, empty ids, foreign keys.
 */
export function decodeOneNodeTopology(
  raw: unknown,
): { ok: true; topology: OneNodeTopologyV1 } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'topology must be an object' };
  }
  const rec = raw as Record<string, unknown>;
  if (rec.kind !== 'one_node_v1') {
    return { ok: false, reason: 'unsupported topology kind' };
  }
  if (!Array.isArray(rec.nodes) || rec.nodes.length !== 1) {
    return { ok: false, reason: 'one_node_v1 requires exactly one node' };
  }
  const node = decodeNode(rec.nodes[0]);
  if (!node) {
    return { ok: false, reason: 'invalid node specification' };
  }
  if (!isNonEmptyString(rec.entryNodeId, MAX_ID_LEN)) {
    return { ok: false, reason: 'entryNodeId required' };
  }
  if (rec.entryNodeId !== node.nodeId) {
    return { ok: false, reason: 'entryNodeId must match the sole node' };
  }
  // Reject unknown topology keys (edges/gates/routes arrive on graph_v1).
  for (const key of Object.keys(rec)) {
    if (key !== 'kind' && key !== 'nodes' && key !== 'entryNodeId') {
      return { ok: false, reason: `unsupported topology field: ${key}` };
    }
  }
  const topology: OneNodeTopologyV1 = {
    kind: 'one_node_v1',
    nodes: [node],
    entryNodeId: rec.entryNodeId,
  };
  return { ok: true, topology };
}

function decodeEdge(raw: unknown): WorkflowDependencyEdgeV1 | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (!isNonEmptyString(rec.fromNodeId, MAX_ID_LEN)) return undefined;
  if (!isNonEmptyString(rec.toNodeId, MAX_ID_LEN)) return undefined;
  // Empty inputRef is a missing route-to-gate; non-string is invalid.
  if (typeof rec.inputRef !== 'string') return undefined;
  if (
    rec.inputRef.length === 0 ||
    rec.inputRef.length > WORKFLOW_INPUT_REF_MAX_LENGTH
  ) return undefined;
  if (
    rec.expectedArtifactKind !== undefined &&
    !isNonEmptyString(rec.expectedArtifactKind, MAX_ARTIFACT_KIND_LEN)
  ) return undefined;
  for (const key of Object.keys(rec)) {
    if (
      key !== 'fromNodeId' && key !== 'toNodeId' && key !== 'inputRef' &&
      key !== 'expectedArtifactKind'
    ) return undefined;
  }
  return {
    fromNodeId: rec.fromNodeId,
    toNodeId: rec.toNodeId,
    inputRef: rec.inputRef,
    ...(typeof rec.expectedArtifactKind === 'string'
      ? { expectedArtifactKind: rec.expectedArtifactKind }
      : {}),
  };
}

function hasCycle(nodeIds: readonly string[], edges: readonly WorkflowDependencyEdgeV1[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const e of edges) {
    outgoing.get(e.fromNodeId)?.push(e.toNodeId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of nodeIds) {
    if (dfs(id)) return true;
  }
  return false;
}

/**
 * Validate and normalize multi-node graph_v1 topology.
 * Fail closed on fan-out, cycles, duplicate per-consumer inputRef, missing route-to-gate,
 * and zero terminals. Multiple terminal sinks are valid and return their reports as
 * one aggregate result to the caller.
 */
export function decodeGraphTopology(
  raw: unknown,
): { ok: true; topology: GraphTopologyV1 } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'topology must be an object' };
  }
  const rec = raw as Record<string, unknown>;
  if (rec.kind !== 'graph_v1') {
    return { ok: false, reason: 'unsupported topology kind' };
  }
  for (const key of Object.keys(rec)) {
    if (key !== 'kind' && key !== 'nodes' && key !== 'edges') {
      return { ok: false, reason: `unsupported topology field: ${key}` };
    }
  }
  if (
    !Array.isArray(rec.nodes) ||
    rec.nodes.length < 2 ||
    rec.nodes.length > WORKFLOW_GRAPH_MAX_NODES
  ) {
    return { ok: false, reason: 'graph_v1 requires 2..64 nodes' };
  }
  if (!Array.isArray(rec.edges) || rec.edges.length > WORKFLOW_GRAPH_MAX_EDGES) {
    return { ok: false, reason: 'graph_v1 edges must be an array' };
  }

  const nodes: WorkflowNodeSpecV1[] = [];
  const nodeIds = new Set<string>();
  for (const rawNode of rec.nodes) {
    const node = decodeNode(rawNode);
    if (!node) return { ok: false, reason: 'invalid node specification' };
    if (nodeIds.has(node.nodeId)) {
      return { ok: false, reason: 'duplicate nodeId' };
    }
    nodeIds.add(node.nodeId);
    nodes.push(node);
  }

  const edges: WorkflowDependencyEdgeV1[] = [];
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    outDegree.set(id, 0);
    inDegree.set(id, 0);
  }
  // Per-consumer inputRef uniqueness: key = `${toNodeId}\0${inputRef}`
  const consumerInputRefs = new Set<string>();

  for (const rawEdge of rec.edges) {
    // Distinguish empty inputRef (missing route-to-gate) from other edge malformation.
    if (rawEdge && typeof rawEdge === 'object' && !Array.isArray(rawEdge)) {
      const er = rawEdge as Record<string, unknown>;
      if (er.inputRef === '') {
        return { ok: false, reason: 'missing route-to-gate: empty inputRef' };
      }
    }
    const edge = decodeEdge(rawEdge);
    if (!edge) {
      return { ok: false, reason: 'invalid edge specification' };
    }
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      return { ok: false, reason: 'edge references unknown node' };
    }
    if (edge.fromNodeId === edge.toNodeId) {
      return { ok: false, reason: 'cycle not allowed: self-loop' };
    }
    const refKey = `${edge.toNodeId}\0${edge.inputRef}`;
    if (consumerInputRefs.has(refKey)) {
      return { ok: false, reason: 'duplicate inputRef on consumer' };
    }
    consumerInputRefs.add(refKey);
    outDegree.set(edge.fromNodeId, (outDegree.get(edge.fromNodeId) ?? 0) + 1);
    inDegree.set(edge.toNodeId, (inDegree.get(edge.toNodeId) ?? 0) + 1);
    edges.push(edge);
  }

  // Fan-out: at most one outgoing route per node.
  for (const [nodeId, degree] of outDegree) {
    if (degree > 1) {
      return { ok: false, reason: `fan-out not allowed: node ${nodeId}` };
    }
  }

  // Cycles before terminal-count so pure loops report cycle (not zero-terminals).
  if (hasCycle([...nodeIds], edges)) {
    return { ok: false, reason: 'cycle not allowed' };
  }

  // At least one terminal sink (out-degree 0). Non-terminals have exactly one outgoing route.
  const terminals = [...nodeIds].filter((id) => (outDegree.get(id) ?? 0) === 0);
  if (terminals.length === 0) {
    return { ok: false, reason: 'at least one terminal required: zero terminals' };
  }
  // Non-terminals (everything else) already have out-degree 1 by fan-out check + not terminal.

  // Every non-entry node must be reachable as a consumer (have ≥1 incoming).
  // Reject isolated nodes even though multiple independent entry/sink paths are valid.
  for (const id of nodeIds) {
    const out = outDegree.get(id) ?? 0;
    const inn = inDegree.get(id) ?? 0;
    if (out === 0 && inn === 0 && nodeIds.size > 1) {
      return { ok: false, reason: 'isolated node is not a valid workflow path' };
    }
  }

  const topology: GraphTopologyV1 = {
    kind: 'graph_v1',
    nodes,
    edges,
  };
  return { ok: true, topology };
}

/** Decode any supported topology kind. */
export function decodeTopology(raw: unknown): TopologyDecodeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'topology must be an object' };
  }
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === 'one_node_v1') return decodeOneNodeTopology(raw);
  if (kind === 'graph_v1') return decodeGraphTopology(raw);
  return { ok: false, reason: 'unsupported topology kind' };
}

/** Canonical JSON for fingerprinting (stable key order; array order is semantic). */
export function encodeTopologyJson(topology: WorkflowTopologyV1): string {
  if (topology.kind === 'one_node_v1') {
    const node = topology.nodes[0];
    return JSON.stringify({
      kind: topology.kind,
      nodes: [encodeNodeJson(node)],
      entryNodeId: topology.entryNodeId,
    });
  }
  const nodes = topology.nodes.map(encodeNodeJson);
  const edges = topology.edges.map((e) => ({
      fromNodeId: e.fromNodeId,
      toNodeId: e.toNodeId,
      inputRef: e.inputRef,
      expectedArtifactKind: e.expectedArtifactKind ?? 'next_result',
    }));
  return JSON.stringify({
    kind: topology.kind,
    nodes,
    edges,
  });
}

/**
 * Definition fingerprint over identity + topology only.
 * Does not include createdAt (replay compares content, not wall-clock).
 */
export function fingerprintWorkflowDefinition(input: {
  definitionId: string;
  version: number;
  name: string;
  topology: WorkflowTopologyV1;
  entryContracts: readonly WorkflowEntryContractV1[];
  policy: WorkflowPolicyV1;
  scope: WorkflowDefinitionV1['scope'];
}): string {
  const payload = JSON.stringify({
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
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function decodeEntryContracts(
  raw: unknown,
  topology: WorkflowTopologyV1,
  policy: WorkflowPolicyV1,
): { ok: true; contracts: WorkflowEntryContractV1[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'entryContracts must be an array' };
  if (raw.length > policy.maxInputsPerGate * topology.nodes.length) {
    return { ok: false, reason: 'entryContracts exceed policy bounds' };
  }
  const incoming = topology.kind === 'graph_v1'
    ? new Set(topology.edges.map((edge) => edge.toNodeId))
    : new Set<string>();
  const entryIds = new Set(
    topology.kind === 'one_node_v1'
      ? [topology.entryNodeId]
      : topology.nodes.map((node) => node.nodeId).filter((nodeId) => !incoming.has(nodeId)),
  );
  const perEntryCount = new Map<string, number>();
  const seen = new Set<string>();
  const contracts: WorkflowEntryContractV1[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'invalid entry contract' };
    }
    const rec = value as Record<string, unknown>;
    if (Object.keys(rec).some((key) => !['entryNodeId', 'inputRef', 'expectedArtifactKind'].includes(key))) {
      return { ok: false, reason: 'invalid entry contract' };
    }
    if (
      !isNonEmptyString(rec.entryNodeId, MAX_ID_LEN) || !entryIds.has(rec.entryNodeId) ||
      !isNonEmptyString(rec.inputRef, WORKFLOW_INPUT_REF_MAX_LENGTH) ||
      !isNonEmptyString(rec.expectedArtifactKind, MAX_ARTIFACT_KIND_LEN)
    ) {
      return { ok: false, reason: 'invalid entry contract' };
    }
    const key = `${rec.entryNodeId}\0${rec.inputRef}`;
    if (seen.has(key)) return { ok: false, reason: 'duplicate entry contract' };
    seen.add(key);
    const count = (perEntryCount.get(rec.entryNodeId) ?? 0) + 1;
    if (count > policy.maxInputsPerGate) {
      return { ok: false, reason: 'entry contract input count exceeds policy' };
    }
    perEntryCount.set(rec.entryNodeId, count);
    contracts.push({
      entryNodeId: rec.entryNodeId,
      inputRef: rec.inputRef,
      expectedArtifactKind: rec.expectedArtifactKind,
    });
  }
  for (const entryNodeId of entryIds) {
    const requiredAggregateBytes = maximumWorkflowEntryAggregateBytes(
      contracts.filter((contract) => contract.entryNodeId === entryNodeId),
      policy.maxArtifactBytes,
    );
    if (requiredAggregateBytes > policy.maxAggregateBytes) {
      return {
        ok: false,
        reason: `entry contract aggregate exceeds policy: maxAggregateBytes must be at least ${requiredAggregateBytes} for entry ${JSON.stringify(entryNodeId)} when maxArtifactBytes is ${policy.maxArtifactBytes}`,
      };
    }
  }
  return { ok: true, contracts };
}

function decodePolicy(raw: unknown): { ok: true; policy: WorkflowPolicyV1 } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'policy must be an object' };
  }
  const rec = raw as Record<string, unknown>;
  const numericKeys = Object.keys(WORKFLOW_POLICY_BOUNDS) as Array<keyof typeof WORKFLOW_POLICY_BOUNDS>;
  const allowed = new Set<string>([...numericKeys, 'failWorkflow']);
  if (Object.keys(rec).some((key) => !allowed.has(key))) {
    return { ok: false, reason: 'invalid policy field' };
  }
  const policy = {} as WorkflowPolicyV1;
  for (const key of numericKeys) {
    const value = rec[key];
    const bounds = WORKFLOW_POLICY_BOUNDS[key];
    if (!Number.isSafeInteger(value) || (value as number) < bounds.min || (value as number) > bounds.max) {
      return {
        ok: false,
        reason: `invalid policy ${key}: expected an integer from ${bounds.min} to ${bounds.max}`,
      };
    }
    (policy as unknown as Record<string, number>)[key] = value as number;
  }
  if (typeof rec.failWorkflow !== 'boolean') {
    return { ok: false, reason: 'invalid policy failWorkflow' };
  }
  policy.failWorkflow = rec.failWorkflow;
  if (policy.maxConcurrency > policy.maxTaskCount) {
    return { ok: false, reason: 'policy concurrency exceeds task count' };
  }
  if (policy.maxArtifactBytes > policy.maxAggregateBytes) {
    return { ok: false, reason: 'policy artifact bound exceeds aggregate bound' };
  }
  return { ok: true, policy };
}

/** Validate define input and produce a durable definition + fingerprint. */
export function decodeDefineWorkflowInput(input: DefineWorkflowInput): DefinitionDecodeResult {
  if (!isNonEmptyString(input.definitionId, MAX_ID_LEN)) {
    return { ok: false, reason: 'invalid definitionId' };
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    return { ok: false, reason: 'invalid version' };
  }
  if (!isNonEmptyString(input.name, MAX_NAME_LEN)) {
    return { ok: false, reason: 'invalid name' };
  }
  if (
    !isNonEmptyString(input.createdAt, 64) ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  ) {
    return { ok: false, reason: 'invalid createdAt' };
  }
  const decoded = decodeTopology(input.topology);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason };
  }
  const decodedPolicy = decodePolicy(input.policy);
  if (!decodedPolicy.ok) return decodedPolicy;
  if (decoded.topology.nodes.length > decodedPolicy.policy.maxTaskCount) {
    return { ok: false, reason: 'topology exceeds policy task count' };
  }
  const decodedContracts = decodeEntryContracts(
    input.entryContracts,
    decoded.topology,
    decodedPolicy.policy,
  );
  if (!decodedContracts.ok) return decodedContracts;
  const scope = input.scope ?? { kind: 'workspace' as const };
  if (
    (scope.kind !== 'workspace' && scope.kind !== 'root') ||
    (scope.kind === 'root' && !isNonEmptyString(scope.ownerRootTaskId, MAX_ID_LEN))
  ) {
    return { ok: false, reason: 'invalid scope' };
  }
  const definition: WorkflowDefinitionV1 = {
    definitionId: input.definitionId,
    version: input.version,
    name: input.name,
    topology: decoded.topology,
    entryContracts: decodedContracts.contracts,
    policy: decodedPolicy.policy,
    scope,
    createdAt: input.createdAt,
  };
  const fingerprint = fingerprintWorkflowDefinition(definition);
  return { ok: true, definition, fingerprint };
}

/** Parse topology_json from a stored row; fail closed on corruption. */
export function decodeStoredTopologyJson(topologyJson: string): TopologyDecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(topologyJson);
  } catch {
    return { ok: false, reason: 'corrupt topology_json' };
  }
  return decodeTopology(raw);
}
