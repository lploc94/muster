/**
 * Workflow domain types for M018 workflow definitions.
 * Topology and identity live here; repository owns durable claim/write.
 * Never carries database paths, SQL, credentials, prompt text, or artifact bodies.
 */

/** Supported frozen topology kinds. */
export type WorkflowTopologyKind = 'one_node_v1' | 'graph_v1';

/** A single ordinary workflow node (entry + only node for one_node_v1). */
export interface WorkflowNodeSpecV1 {
  /** Stable node id within the definition (not a task id). */
  nodeId: string;
  /** Optional human label; never used as identity. */
  label?: string;
  /** Optional role hint for later slices; S01 ignores routing. */
  role?: 'coordinator' | 'worker';
}

/**
 * Canonical one-node topology. Exactly one node; entryNodeId must equal that node.
 * No edges — multi-node routes live on graph_v1.
 */
export interface OneNodeTopologyV1 {
  kind: 'one_node_v1';
  nodes: readonly [WorkflowNodeSpecV1];
  entryNodeId: string;
}

/**
 * Forward dependency edge: producer → consumer gate fill by destination inputRef.
 * inputRefs are unique among edges into the same toNodeId (per-consumer).
 */
export interface WorkflowDependencyEdgeV1 {
  fromNodeId: string;
  toNodeId: string;
  /** Destination gate input ref frozen on the definition. */
  inputRef: string;
}

/**
 * Multi-node graph topology (S02+).
 * N >= 2 nodes; each non-terminal has exactly one outgoing edge; exactly one terminal;
 * acyclic; per-consumer inputRefs unique. Entry nodes are those with no incoming edges.
 */
export interface GraphTopologyV1 {
  kind: 'graph_v1';
  nodes: readonly WorkflowNodeSpecV1[];
  edges: readonly WorkflowDependencyEdgeV1[];
}

/** Union of supported frozen topologies. */
export type WorkflowTopologyV1 = OneNodeTopologyV1 | GraphTopologyV1;

/** Immutable workflow definition identity + topology. */
export interface WorkflowDefinitionV1 {
  definitionId: string;
  version: number;
  name: string;
  topology: WorkflowTopologyV1;
  createdAt: string;
}

/** Bounded result of defineWorkflowVersion (no SQL/paths/bodies). */
export type DefineWorkflowResult =
  | {
      ok: true;
      changed: true;
      definitionId: string;
      version: number;
      fingerprint: string;
    }
  | {
      ok: true;
      changed: false;
      definitionId: string;
      version: number;
      fingerprint: string;
      /** Same key + same fingerprint replay. */
      replay: true;
    }
  | {
      ok: false;
      conflict: true;
      reason: 'definition fingerprint conflict' | 'invalid topology' | 'invalid identity';
      definitionId?: string;
      version?: number;
    };

/** Input accepted by the domain validate/define path (before persistence). */
export interface DefineWorkflowInput {
  definitionId: string;
  version: number;
  name: string;
  topology: unknown;
  createdAt: string;
}

/**
 * Input for startWorkflowRun. Agents never supply writable run/task/turn/gate IDs;
 * those are derived deterministically from the start idempotency key + definition.
 */
export interface StartWorkflowInput {
  definitionId: string;
  version: number;
  startIdempotencyKey: string;
  createdAt: string;
  /**
   * Primary entry node id (first entry from the frozen definition).
   * Used for S01-compatible fingerprinting; multi-entry graphs also pass entryNodeIds.
   */
  entryNodeId: string;
  /**
   * All entry node ids (nodes with no incoming edges). Defaults to [entryNodeId].
   * Order is not significant; derivation sorts for stable multi-entry identities.
   */
  entryNodeIds?: readonly string[];
  /**
   * All topology node ids (entry + non-entry). Defaults to [entryNodeId].
   * Used to allocate one dependency gate per task/node at start.
   */
  allNodeIds?: readonly string[];
  /** Optional task goal; defaults to definition name at the repository boundary. */
  goal?: string;
  /** Optional backend id for the entry task; defaults at the repository boundary. */
  backend?: string;
}

/** Per-entry activation identities created when an entry gate is satisfied at start. */
export interface StartEntryActivation {
  nodeId: string;
  taskId: string;
  gateId: string;
  activationTurnId: string;
  messageId: string;
}

/** Per-node dependency gate identity (entry and non-entry). */
export interface StartNodeGate {
  nodeId: string;
  gateId: string;
}

/**
 * Engine-derived durable identities for start (no SQL/paths/bodies).
 * Primary entry* fields mirror the first sorted entry for S01 back-compat;
 * entries/nodeGates cover multi-node fan-in graphs.
 */
export interface StartWorkflowIdentities {
  runId: string;
  entryTaskId: string;
  activationTurnId: string;
  entryMessageId: string;
  entryGateId: string;
  startArtifactId: string;
  /** One gate per topology node (entry + consumer). */
  nodeGates: readonly StartNodeGate[];
  /** Entry activations only (engine_start satisfied + queued turn). */
  entries: readonly StartEntryActivation[];
}

/** Shared success fields for start (created or replay). */
export interface StartWorkflowSuccessFields {
  definitionId: string;
  version: number;
  entryNodeId: string;
  runId: string;
  entryTaskId: string;
  entryGateId: string;
  entryGateStatus: 'satisfied';
  activationTurnId: string;
  entryMessageId: string;
  startArtifactId: string;
  fingerprint: string;
  nodeGates: readonly StartNodeGate[];
  entries: readonly StartEntryActivation[];
}

/** Bounded result of startWorkflowRun. */
export type StartWorkflowResult =
  | ({
      ok: true;
      changed: true;
    } & StartWorkflowSuccessFields)
  | ({
      ok: true;
      changed: false;
      replay: true;
    } & StartWorkflowSuccessFields)
  | {
      ok: false;
      conflict: true;
      reason:
        | 'definition not found'
        | 'invalid start'
        | 'start fingerprint conflict'
        | 'invalid identity';
      definitionId?: string;
      version?: number;
    };
