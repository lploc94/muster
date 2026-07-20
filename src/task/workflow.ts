/**
 * Workflow domain boundary for M018.
 * Owns topology validation, define/start result shaping, and identity derivation;
 * repository owns CAS writes.
 */

import { createHash } from 'node:crypto';
import {
  decodeDefineWorkflowInput,
  encodeTopologyJson,
  fingerprintWorkflowDefinition,
} from './workflow-codec';
import type {
  DefineWorkflowInput,
  DefineWorkflowResult,
  GraphTopologyV1,
  StartWorkflowIdentities,
  StartWorkflowInput,
  StartWorkflowResult,
  WorkflowDefinitionV1,
  WorkflowTopologyV1,
} from './workflow-types';

export {
  decodeDefineWorkflowInput,
  decodeGraphTopology,
  decodeOneNodeTopology,
  decodeStoredTopologyJson,
  decodeTopology,
  encodeTopologyJson,
  fingerprintWorkflowDefinition,
} from './workflow-codec';
export type {
  DefineWorkflowInput,
  DefineWorkflowResult,
  GraphTopologyV1,
  OneNodeTopologyV1,
  StartWorkflowIdentities,
  StartWorkflowInput,
  StartWorkflowResult,
  WorkflowDefinitionV1,
  WorkflowDependencyEdgeV1,
  WorkflowNodeSpecV1,
  WorkflowTopologyV1,
} from './workflow-types';

/** Operations ledger key for an immutable definition claim. */
export function defineWorkflowLedgerKey(definitionId: string, version: number): string {
  return `define_workflow:${definitionId}:${version}`;
}

/**
 * Validate define input without persistence.
 * Used by repository and unit tests to fail closed before any SQL.
 */
export function validateDefineWorkflow(
  input: DefineWorkflowInput,
):
  | { ok: true; definition: WorkflowDefinitionV1; fingerprint: string; topologyJson: string }
  | { ok: false; reason: string } {
  const decoded = decodeDefineWorkflowInput(input);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason };
  }
  return {
    ok: true,
    definition: decoded.definition,
    fingerprint: decoded.fingerprint,
    topologyJson: encodeTopologyJson(decoded.definition.topology),
  };
}

/** Shape a successful first-write define result. */
export function defineWorkflowCreated(
  definition: WorkflowDefinitionV1,
  fingerprint: string,
): DefineWorkflowResult {
  return {
    ok: true,
    changed: true,
    definitionId: definition.definitionId,
    version: definition.version,
    fingerprint,
  };
}

/** Shape a same-fingerprint replay result. */
export function defineWorkflowReplay(
  definition: WorkflowDefinitionV1,
  fingerprint: string,
): DefineWorkflowResult {
  return {
    ok: true,
    changed: false,
    definitionId: definition.definitionId,
    version: definition.version,
    fingerprint,
    replay: true,
  };
}

/** Shape a conflict (same key, different fingerprint). */
export function defineWorkflowConflict(
  definitionId: string,
  version: number,
): DefineWorkflowResult {
  return {
    ok: false,
    conflict: true,
    reason: 'definition fingerprint conflict',
    definitionId,
    version,
  };
}

/** Shape a validation failure without partial rows. */
export function defineWorkflowInvalid(
  reason: 'invalid topology' | 'invalid identity',
): DefineWorkflowResult {
  return { ok: false, conflict: true, reason };
}

/** Helper for tests/fixtures: build a minimal valid one-node definition. */
export function makeOneNodeDefinition(overrides?: {
  definitionId?: string;
  version?: number;
  name?: string;
  nodeId?: string;
  createdAt?: string;
}): WorkflowDefinitionV1 {
  const nodeId = overrides?.nodeId ?? 'entry';
  return {
    definitionId: overrides?.definitionId ?? 'wf-one',
    version: overrides?.version ?? 1,
    name: overrides?.name ?? 'one-node',
    topology: {
      kind: 'one_node_v1',
      nodes: [{ nodeId }],
      entryNodeId: nodeId,
    },
    createdAt: overrides?.createdAt ?? '2026-07-19T00:00:00.000Z',
  };
}

/** Helper for tests/fixtures: two producers → one consumer fan-in graph_v1. */
export function makeGraphFanInDefinition(overrides?: {
  definitionId?: string;
  version?: number;
  name?: string;
  createdAt?: string;
  producer1?: string;
  producer2?: string;
  consumer?: string;
  inputRef1?: string;
  inputRef2?: string;
}): WorkflowDefinitionV1 {
  const p1 = overrides?.producer1 ?? 'p1';
  const p2 = overrides?.producer2 ?? 'p2';
  const consumer = overrides?.consumer ?? 'consumer';
  const topology: GraphTopologyV1 = {
    kind: 'graph_v1',
    nodes: [{ nodeId: p1 }, { nodeId: p2 }, { nodeId: consumer }],
    edges: [
      { fromNodeId: p1, toNodeId: consumer, inputRef: overrides?.inputRef1 ?? 'from_p1' },
      { fromNodeId: p2, toNodeId: consumer, inputRef: overrides?.inputRef2 ?? 'from_p2' },
    ],
  };
  return {
    definitionId: overrides?.definitionId ?? 'wf-fan',
    version: overrides?.version ?? 1,
    name: overrides?.name ?? 'fan-in',
    topology,
    createdAt: overrides?.createdAt ?? '2026-07-19T00:00:00.000Z',
  };
}

/** Entry node ids: one_node entry, or graph nodes with no incoming edges. */
export function entryNodeIds(topology: WorkflowTopologyV1): string[] {
  if (topology.kind === 'one_node_v1') {
    return [topology.entryNodeId];
  }
  const incoming = new Set(topology.edges.map((e) => e.toNodeId));
  return topology.nodes.map((n) => n.nodeId).filter((id) => !incoming.has(id));
}

/** Sole terminal node id (out-degree 0). Throws if topology is invalid (should not after decode). */
export function terminalNodeId(topology: WorkflowTopologyV1): string {
  if (topology.kind === 'one_node_v1') {
    return topology.entryNodeId;
  }
  const outgoing = new Set(topology.edges.map((e) => e.fromNodeId));
  const terminals = topology.nodes.map((n) => n.nodeId).filter((id) => !outgoing.has(id));
  if (terminals.length !== 1) {
    throw new Error(`expected exactly one terminal, found ${terminals.length}`);
  }
  return terminals[0]!;
}

/** Fingerprint helper re-export for callers that already hold a definition. */
export function fingerprintDefinition(definition: WorkflowDefinitionV1): string {
  return fingerprintWorkflowDefinition(definition);
}

const MAX_START_KEY_LEN = 256;
const MAX_GOAL_LEN = 512;
const MAX_BACKEND_LEN = 64;

function isNonEmptyBounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Operations ledger key for an idempotent start claim. */
export function startWorkflowLedgerKey(startIdempotencyKey: string): string {
  return `start_workflow:${startIdempotencyKey}`;
}

/** Stable short id derived from start material (never a raw user path/SQL). */
function stableId(prefix: string, material: string): string {
  const digest = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

/**
 * Derive immutable run/task/turn/gate/message/artifact ids from the start key.
 * Same key + definition always yields the same activation identities.
 * One-node keeps the S01 material that includes the single entryNodeId.
 * Multi-node derives a shared runId and per-node gate / per-entry activation ids.
 */
export function deriveStartIdentities(input: {
  definitionId: string;
  version: number;
  startIdempotencyKey: string;
  entryNodeId: string;
  entryNodeIds?: readonly string[];
  allNodeIds?: readonly string[];
}): StartWorkflowIdentities {
  const entriesSorted = [...(input.entryNodeIds ?? [input.entryNodeId])].sort();
  const allNodesSorted = [...(input.allNodeIds ?? [input.entryNodeId])].sort();
  if (entriesSorted.length === 0 || allNodesSorted.length === 0) {
    throw new Error('start identities require at least one node');
  }
  if (!entriesSorted.includes(input.entryNodeId)) {
    throw new Error('primary entryNodeId must be among entryNodeIds');
  }

  // S01 one-node: preserve exact prior derivation material (includes entryNodeId).
  const isOneNode =
    entriesSorted.length === 1 &&
    allNodesSorted.length === 1 &&
    entriesSorted[0] === input.entryNodeId;

  if (isOneNode) {
    const base = [
      input.definitionId,
      String(input.version),
      input.startIdempotencyKey,
      input.entryNodeId,
    ].join('\0');
    const entryTaskId = stableId('wft', `${base}\0task`);
    const activationTurnId = stableId('wftn', `${base}\0turn`);
    const entryMessageId = stableId('wfm', `${base}\0message`);
    const entryGateId = stableId('wfg', `${base}\0gate`);
    return {
      runId: stableId('wfr', base),
      entryTaskId,
      activationTurnId,
      entryMessageId,
      entryGateId,
      startArtifactId: stableId('wfa', `${base}\0artifact`),
      nodeGates: [{ nodeId: input.entryNodeId, gateId: entryGateId }],
      entries: [
        {
          nodeId: input.entryNodeId,
          taskId: entryTaskId,
          gateId: entryGateId,
          activationTurnId,
          messageId: entryMessageId,
        },
      ],
    };
  }

  // Multi-node: run id shared across nodes; gates/tasks keyed by node id.
  const runBase = [
    input.definitionId,
    String(input.version),
    input.startIdempotencyKey,
  ].join('\0');
  const runId = stableId('wfr', runBase);
  const startArtifactId = stableId('wfa', `${runBase}\0artifact`);
  const nodeGates = allNodesSorted.map((nodeId) => ({
    nodeId,
    gateId: stableId('wfg', `${runBase}\0gate\0${nodeId}`),
  }));
  const gateByNode = new Map(nodeGates.map((g) => [g.nodeId, g.gateId]));
  const entries = entriesSorted.map((nodeId) => {
    const gateId = gateByNode.get(nodeId)!;
    return {
      nodeId,
      taskId: stableId('wft', `${runBase}\0task\0${nodeId}`),
      gateId,
      activationTurnId: stableId('wftn', `${runBase}\0turn\0${nodeId}`),
      messageId: stableId('wfm', `${runBase}\0message\0${nodeId}`),
    };
  });
  const primary =
    entries.find((e) => e.nodeId === input.entryNodeId) ?? entries[0]!;
  return {
    runId,
    entryTaskId: primary.taskId,
    activationTurnId: primary.activationTurnId,
    entryMessageId: primary.messageId,
    entryGateId: primary.gateId,
    startArtifactId,
    nodeGates,
    entries,
  };
}

/** Start fingerprint (no prompt/message/artifact bodies). */
export function fingerprintStartWorkflow(input: {
  definitionId: string;
  version: number;
  startIdempotencyKey: string;
  entryNodeId: string;
  goal: string;
  backend: string;
}): string {
  const payload = JSON.stringify({
    definitionId: input.definitionId,
    version: input.version,
    startIdempotencyKey: input.startIdempotencyKey,
    entryNodeId: input.entryNodeId,
    goal: input.goal,
    backend: input.backend,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Validate start input without persistence.
 * entryNodeId must be provided by the repository after loading the definition.
 */
export function validateStartWorkflow(
  input: StartWorkflowInput,
):
  | {
      ok: true;
      definitionId: string;
      version: number;
      startIdempotencyKey: string;
      entryNodeId: string;
      createdAt: string;
      goal: string;
      backend: string;
      identities: StartWorkflowIdentities;
      fingerprint: string;
    }
  | { ok: false; reason: string } {
  if (!isNonEmptyBounded(input.definitionId, 128)) {
    return { ok: false, reason: 'invalid definitionId' };
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    return { ok: false, reason: 'invalid version' };
  }
  if (!isNonEmptyBounded(input.startIdempotencyKey, MAX_START_KEY_LEN)) {
    return { ok: false, reason: 'invalid startIdempotencyKey' };
  }
  if (!isNonEmptyBounded(input.createdAt, 64)) {
    return { ok: false, reason: 'invalid createdAt' };
  }
  if (!isNonEmptyBounded(input.entryNodeId, 128)) {
    return { ok: false, reason: 'invalid entryNodeId' };
  }
  if (input.goal !== undefined && !isNonEmptyBounded(input.goal, MAX_GOAL_LEN)) {
    return { ok: false, reason: 'invalid goal' };
  }
  if (input.backend !== undefined && !isNonEmptyBounded(input.backend, MAX_BACKEND_LEN)) {
    return { ok: false, reason: 'invalid backend' };
  }
  const goal = input.goal ?? input.definitionId;
  const backend = input.backend ?? 'grok';
  const entryNodeIds = input.entryNodeIds ?? [input.entryNodeId];
  const allNodeIds = input.allNodeIds ?? [input.entryNodeId];
  if (!entryNodeIds.includes(input.entryNodeId)) {
    return { ok: false, reason: 'invalid entryNodeId' };
  }
  if (entryNodeIds.some((id) => !isNonEmptyBounded(id, 128))) {
    return { ok: false, reason: 'invalid entryNodeIds' };
  }
  if (allNodeIds.some((id) => !isNonEmptyBounded(id, 128))) {
    return { ok: false, reason: 'invalid allNodeIds' };
  }
  for (const id of entryNodeIds) {
    if (!allNodeIds.includes(id)) {
      return { ok: false, reason: 'entry node missing from allNodeIds' };
    }
  }
  let identities: StartWorkflowIdentities;
  try {
    identities = deriveStartIdentities({
      definitionId: input.definitionId,
      version: input.version,
      startIdempotencyKey: input.startIdempotencyKey,
      entryNodeId: input.entryNodeId,
      entryNodeIds,
      allNodeIds,
    });
  } catch {
    return { ok: false, reason: 'invalid start identities' };
  }
  const fingerprint = fingerprintStartWorkflow({
    definitionId: input.definitionId,
    version: input.version,
    startIdempotencyKey: input.startIdempotencyKey,
    entryNodeId: input.entryNodeId,
    goal,
    backend,
  });
  return {
    ok: true,
    definitionId: input.definitionId,
    version: input.version,
    startIdempotencyKey: input.startIdempotencyKey,
    entryNodeId: input.entryNodeId,
    createdAt: input.createdAt,
    goal,
    backend,
    identities,
    fingerprint,
  };
}

/** Shape a successful first-write start result. */
export function startWorkflowCreated(
  validated: Extract<ReturnType<typeof validateStartWorkflow>, { ok: true }>,
): StartWorkflowResult {
  const { identities } = validated;
  return {
    ok: true,
    changed: true,
    definitionId: validated.definitionId,
    version: validated.version,
    entryNodeId: validated.entryNodeId,
    runId: identities.runId,
    entryTaskId: identities.entryTaskId,
    entryGateId: identities.entryGateId,
    entryGateStatus: 'satisfied',
    activationTurnId: identities.activationTurnId,
    entryMessageId: identities.entryMessageId,
    startArtifactId: identities.startArtifactId,
    fingerprint: validated.fingerprint,
    nodeGates: identities.nodeGates,
    entries: identities.entries,
  };
}

/** Shape a same-fingerprint start replay. */
export function startWorkflowReplay(
  validated: Extract<ReturnType<typeof validateStartWorkflow>, { ok: true }>,
): StartWorkflowResult {
  const created = startWorkflowCreated(validated);
  if (!created.ok) return created;
  return {
    ...created,
    changed: false,
    replay: true,
  };
}

/** Shape a start conflict (same key, different fingerprint). */
export function startWorkflowConflict(
  definitionId?: string,
  version?: number,
): StartWorkflowResult {
  return {
    ok: false,
    conflict: true,
    reason: 'start fingerprint conflict',
    definitionId,
    version,
  };
}

/** Shape a start validation / missing-definition failure. */
export function startWorkflowInvalid(
  reason: 'definition not found' | 'invalid start' | 'invalid identity',
  definitionId?: string,
  version?: number,
): StartWorkflowResult {
  return {
    ok: false,
    conflict: true,
    reason,
    definitionId,
    version,
  };
}
