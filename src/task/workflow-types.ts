/**
 * Workflow domain types for M018 S01 one-node definitions.
 * Topology and identity live here; repository owns durable claim/write.
 * Never carries database paths, SQL, credentials, prompt text, or artifact bodies.
 */

/** S01 supports only the frozen one-node topology shape. */
export type WorkflowTopologyKind = 'one_node_v1';

/** A single ordinary workflow node (entry + only node for S01). */
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
 * No edges, gates, or routes in S01 — those arrive in later slices.
 */
export interface OneNodeTopologyV1 {
  kind: WorkflowTopologyKind;
  nodes: readonly [WorkflowNodeSpecV1];
  entryNodeId: string;
}

/** Immutable workflow definition identity + topology. */
export interface WorkflowDefinitionV1 {
  definitionId: string;
  version: number;
  name: string;
  topology: OneNodeTopologyV1;
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
  /** Entry node id from the frozen definition (validated against stored topology). */
  entryNodeId: string;
  /** Optional task goal; defaults to definition name at the repository boundary. */
  goal?: string;
  /** Optional backend id for the entry task; defaults at the repository boundary. */
  backend?: string;
}

/** Engine-derived durable identities for a one-node start (no SQL/paths/bodies). */
export interface StartWorkflowIdentities {
  runId: string;
  entryTaskId: string;
  activationTurnId: string;
  entryMessageId: string;
  entryGateId: string;
  startArtifactId: string;
}

/** Bounded result of startWorkflowRun. */
export type StartWorkflowResult =
  | {
      ok: true;
      changed: true;
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
    }
  | {
      ok: true;
      changed: false;
      replay: true;
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
    }
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
