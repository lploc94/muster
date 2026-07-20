/**
 * Bounded codecs for workflow topology and definition fingerprints.
 * Fail closed on unsupported, incomplete, or corrupt topology.
 * Fingerprints never include prompt text, message bodies, or artifact bodies.
 */

import { createHash } from 'node:crypto';
import type {
  DefineWorkflowInput,
  GraphTopologyV1,
  OneNodeTopologyV1,
  WorkflowDefinitionV1,
  WorkflowDependencyEdgeV1,
  WorkflowNodeSpecV1,
  WorkflowTopologyV1,
} from './workflow-types';

const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 256;
const MAX_LABEL_LEN = 256;
const MAX_INPUT_REF_LEN = 128;
const MAX_GRAPH_NODES = 64;
const MAX_GRAPH_EDGES = 128;

export type TopologyDecodeResult =
  | { ok: true; topology: WorkflowTopologyV1 }
  | { ok: false; reason: string };

export type DefinitionDecodeResult =
  | { ok: true; definition: WorkflowDefinitionV1; fingerprint: string }
  | { ok: false; reason: string };

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function decodeNode(raw: unknown): WorkflowNodeSpecV1 | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (!isNonEmptyString(rec.nodeId, MAX_ID_LEN)) return undefined;
  if (rec.label !== undefined && !isNonEmptyString(rec.label, MAX_LABEL_LEN)) return undefined;
  if (rec.role !== undefined && rec.role !== 'coordinator' && rec.role !== 'worker') {
    return undefined;
  }
  const node: WorkflowNodeSpecV1 = { nodeId: rec.nodeId };
  if (typeof rec.label === 'string') node.label = rec.label;
  if (rec.role === 'coordinator' || rec.role === 'worker') node.role = rec.role;
  // Reject unknown keys so foreign payloads cannot smuggle repository identities.
  for (const key of Object.keys(rec)) {
    if (key !== 'nodeId' && key !== 'label' && key !== 'role') return undefined;
  }
  return node;
}

function encodeNodeJson(node: WorkflowNodeSpecV1): Record<string, unknown> {
  const nodeJson: Record<string, unknown> = { nodeId: node.nodeId };
  if (node.label !== undefined) nodeJson.label = node.label;
  if (node.role !== undefined) nodeJson.role = node.role;
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
  if (rec.inputRef.length === 0 || rec.inputRef.length > MAX_INPUT_REF_LEN) return undefined;
  for (const key of Object.keys(rec)) {
    if (key !== 'fromNodeId' && key !== 'toNodeId' && key !== 'inputRef') return undefined;
  }
  return {
    fromNodeId: rec.fromNodeId,
    toNodeId: rec.toNodeId,
    inputRef: rec.inputRef,
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
 * and zero/multiple terminals.
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
  if (!Array.isArray(rec.nodes) || rec.nodes.length < 2 || rec.nodes.length > MAX_GRAPH_NODES) {
    return { ok: false, reason: 'graph_v1 requires 2..64 nodes' };
  }
  if (!Array.isArray(rec.edges) || rec.edges.length > MAX_GRAPH_EDGES) {
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

  // Exactly one terminal (out-degree 0). Non-terminals must have exactly one outgoing route.
  const terminals = [...nodeIds].filter((id) => (outDegree.get(id) ?? 0) === 0);
  if (terminals.length === 0) {
    return { ok: false, reason: 'exactly one terminal required: zero terminals' };
  }
  if (terminals.length > 1) {
    return { ok: false, reason: 'exactly one terminal required: multiple terminals' };
  }
  // Non-terminals (everything else) already have out-degree 1 by fan-out check + not terminal.

  // Every non-entry node must be reachable as a consumer (have ≥1 incoming).
  // With one terminal + out-degree 0|1 + acyclic, unreachable nodes would be extra terminals
  // or cycles; still reject nodes with neither in nor out except the sole terminal.
  for (const id of nodeIds) {
    const out = outDegree.get(id) ?? 0;
    const inn = inDegree.get(id) ?? 0;
    if (out === 0 && inn === 0 && nodeIds.size > 1) {
      // Isolated node is a second terminal already caught; keep fail-closed.
      return { ok: false, reason: 'exactly one terminal required: multiple terminals' };
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

/** Canonical JSON for fingerprinting (stable key order; order-insensitive nodes/edges). */
export function encodeTopologyJson(topology: WorkflowTopologyV1): string {
  if (topology.kind === 'one_node_v1') {
    const node = topology.nodes[0];
    return JSON.stringify({
      kind: topology.kind,
      nodes: [encodeNodeJson(node)],
      entryNodeId: topology.entryNodeId,
    });
  }
  const nodes = [...topology.nodes]
    .map(encodeNodeJson)
    .sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
  const edges = [...topology.edges]
    .map((e) => ({
      fromNodeId: e.fromNodeId,
      toNodeId: e.toNodeId,
      inputRef: e.inputRef,
    }))
    .sort((a, b) => {
      const from = a.fromNodeId.localeCompare(b.fromNodeId);
      if (from !== 0) return from;
      const to = a.toNodeId.localeCompare(b.toNodeId);
      if (to !== 0) return to;
      return a.inputRef.localeCompare(b.inputRef);
    });
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
}): string {
  const payload = JSON.stringify({
    definitionId: input.definitionId,
    version: input.version,
    name: input.name,
    topology: JSON.parse(encodeTopologyJson(input.topology)),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
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
  if (!isNonEmptyString(input.createdAt, 64)) {
    return { ok: false, reason: 'invalid createdAt' };
  }
  const decoded = decodeTopology(input.topology);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason };
  }
  const definition: WorkflowDefinitionV1 = {
    definitionId: input.definitionId,
    version: input.version,
    name: input.name,
    topology: decoded.topology,
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
