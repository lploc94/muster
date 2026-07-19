/**
 * Bounded codecs for workflow topology and definition fingerprints.
 * Fail closed on unsupported, incomplete, or corrupt topology.
 * Fingerprints never include prompt text, message bodies, or artifact bodies.
 */

import { createHash } from 'node:crypto';
import type {
  DefineWorkflowInput,
  OneNodeTopologyV1,
  WorkflowDefinitionV1,
  WorkflowNodeSpecV1,
} from './workflow-types';

const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 256;
const MAX_LABEL_LEN = 256;

export type TopologyDecodeResult =
  | { ok: true; topology: OneNodeTopologyV1 }
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

/**
 * Validate and normalize S01 one-node topology.
 * Rejects multi-node graphs, missing entry, mismatched entry, empty ids, foreign keys.
 */
export function decodeOneNodeTopology(raw: unknown): TopologyDecodeResult {
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
  // Reject unknown topology keys (edges/gates/routes arrive in later slices).
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

/** Canonical JSON for fingerprinting (stable key order). */
export function encodeTopologyJson(topology: OneNodeTopologyV1): string {
  const node = topology.nodes[0];
  const nodeJson: Record<string, unknown> = { nodeId: node.nodeId };
  if (node.label !== undefined) nodeJson.label = node.label;
  if (node.role !== undefined) nodeJson.role = node.role;
  return JSON.stringify({
    kind: topology.kind,
    nodes: [nodeJson],
    entryNodeId: topology.entryNodeId,
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
  topology: OneNodeTopologyV1;
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
  const decoded = decodeOneNodeTopology(input.topology);
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
  return decodeOneNodeTopology(raw);
}
