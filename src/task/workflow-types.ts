/**
 * Workflow domain types for M018 workflow definitions.
 * Topology and identity live here; repository owns durable claim/write.
 * Never carries database paths, SQL, credentials, prompt text, or artifact bodies.
 */

/** Supported frozen topology kinds. */
export type WorkflowTopologyKind = 'one_node_v1' | 'graph_v1';

export const WORKFLOW_NODE_LABEL_MAX_LENGTH = 120_000;
export const WORKFLOW_RUN_GOAL_MAX_LENGTH = 120_000;
export const WORKFLOW_INPUT_REF_MAX_LENGTH = 128;
export const WORKFLOW_GRAPH_MAX_NODES = 64;
export const WORKFLOW_GRAPH_MAX_EDGES = 128;
export const WORKFLOW_ENTRY_CONTRACTS_MAX = 128;
export const WORKFLOW_CHILD_BINDINGS_MAX = 64;

/** A single ordinary workflow node (entry + only node for one_node_v1). */
export interface WorkflowNodeSpecV1 {
  /** Stable node id within the definition (not a task id). */
  nodeId: string;
  /** Optional human label; never used as identity. */
  label?: string;
  /** Required host role when specified. */
  role?: 'coordinator' | 'worker';
  /** Optional configured task type requirement resolved before run creation. */
  taskType?: string;
  /** Optional exact backend requirement. */
  backend?: string;
  /** Optional exact backend model requirement. */
  model?: string;
  /** Host-issued task capabilities required by this node. */
  capabilities?: readonly string[];
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
  /** Exact v1 artifact kind accepted by the destination binding. */
  expectedArtifactKind?: string;
}

/**
 * Multi-node graph topology (S02+).
 * N >= 2 nodes; each node has at most one outgoing edge; one or more terminal sinks;
 * acyclic; per-consumer inputRefs unique. Entry nodes are those with no incoming edges.
 */
export interface GraphTopologyV1 {
  kind: 'graph_v1';
  nodes: readonly WorkflowNodeSpecV1[];
  edges: readonly WorkflowDependencyEdgeV1[];
}

/** Union of supported frozen topologies. */
export type WorkflowTopologyV1 = OneNodeTopologyV1 | GraphTopologyV1;

/** Explicit caller-input contract for one workflow entry. */
export interface WorkflowEntryContractV1 {
  entryNodeId: string;
  inputRef: string;
  expectedArtifactKind: string;
}

/** Frozen, host-bounded workflow policy. */
export interface WorkflowPolicyV1 {
  maxFeedbackRoundsPerRun: number;
  maxTurnsPerTask: number;
  maxWorkflowTurnsPerRun: number;
  runTimeoutMs: number;
  maxDepth: number;
  maxTaskCount: number;
  maxConcurrency: number;
  maxInputsPerGate: number;
  maxArtifactBytes: number;
  maxAggregateBytes: number;
  failWorkflow: boolean;
}

/** Immutable workflow definition identity + topology. */
export interface WorkflowDefinitionV1 {
  definitionId: string;
  version: number;
  name: string;
  topology: WorkflowTopologyV1;
  entryContracts: readonly WorkflowEntryContractV1[];
  policy: WorkflowPolicyV1;
  scope: { kind: 'workspace' } | { kind: 'root'; ownerRootTaskId: string };
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
  entryContracts: unknown;
  policy: unknown;
  scope?: { kind: 'workspace' } | { kind: 'root'; ownerRootTaskId: string };
  createdAt: string;
}

/** Caller-authored value bound to one exact entry contract at start. */
export interface StartWorkflowEntryInput {
  entryNodeId: string;
  inputRef: string;
  kind: string;
  value: string;
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
  /** Exact caller values for every declared entry contract. */
  entryInputs?: readonly StartWorkflowEntryInput[];
  /** Frozen definition contracts loaded by the repository. */
  entryContracts?: readonly WorkflowEntryContractV1[];
  /** Caller/root authority included in fingerprint and identity derivation. */
  ownerRootTaskId?: string;
  callerTaskId?: string;
  callerTurnId?: string;
  /** Frozen effective policy copied onto the run. */
  policy?: WorkflowPolicyV1;
}

/** Per-entry activation identities created when an entry gate is satisfied at start. */
export interface StartEntryActivation {
  nodeId: string;
  taskId: string;
  gateId: string;
  activationTurnId: string;
  messageId: string;
  activationId: string;
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
  /** One engine/caller artifact identity per exact entry input. */
  entryArtifacts: readonly {
    entryNodeId: string;
    inputRef: string;
    artifactId: string;
  }[];
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
  entryArtifacts: readonly {
    entryNodeId: string;
    inputRef: string;
    artifactId: string;
  }[];
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


/** M018 S06: agent-supplied exact child entry and artifact revision binding. */
export interface InvokeChildEntryBinding {
  childEntryNodeId: string;
  inputRef: string;
  artifactId: string;
  artifactRevision: number;
}

/** M018 S06: public child-route command payload (no SQL/paths/bodies). */
export interface InvokeChildWorkflowInput {
  childDefinitionId: string;
  childDefinitionVersion: number;
  entryBindings: readonly InvokeChildEntryBinding[];
  childIdempotencyKey?: string;
}

/** Bounded workflow gate state (no topology, prompts, artifact bodies, or paths). */
export interface WorkflowGateStatusProjection {
  gateId: string;
  status: string;
  /** Distinct filled inputRefs. */
  satisfied: number;
  /** Binding count (required inputs). */
  required: number;
}

export interface WorkflowRunPolicyProjection {
  maxFeedbackRounds: number;
  maxTurnsPerTask: number;
  maxWorkflowTurns: number;
  maxChildren: number;
  maxDepth: number;
  maxConcurrency: number;
  maxAggregateBytes: number;
}

export interface WorkflowActivationStatusProjection {
  activationId: string;
  kind: string;
  status: string;
  primaryTurnId: string;
  executionTurnId: string;
  sourceGateId?: string;
  feedbackRoundId?: string;
  feedbackTargetNodeId?: string;
  continuationId?: string;
  returnGateId?: string;
}

export interface WorkflowFeedbackRoundProjection {
  roundId: string;
  status: string;
  joinMode: string;
  role: 'requester' | 'target';
  required: number;
  responded: number;
}

export interface WorkflowContinuationStatusProjection {
  continuationId: string;
  status: string;
  kind: string;
  childRunId?: string;
  outcome?: string;
  reasonCode?: string;
}

export interface WorkflowIntegrityDiagnosticProjection {
  code: string;
}

/**
 * Bounded workflow orchestration state for a task bound to a workflow node.
 * Relational read: nodes → runs → gates/activations/rounds/continuations.
 * Strictly excludes topology, prompts, artifact bodies, secrets, and absolute paths.
 */
export interface WorkflowTaskStatusProjection {
  runId: string;
  definitionId: string;
  definitionVersion: number;
  runStatus: string;
  policy: WorkflowRunPolicyProjection;
  startedAt?: string;
  deadlineAt?: string;
  terminalReason?: string;
  /** Run origin: top_level | child (not a filesystem path). */
  origin: string;
  /** Parent workflow run id when origin is child. */
  parentRunId?: string;
  nodeId: string;
  gates: readonly WorkflowGateStatusProjection[];
  activeGate?: WorkflowGateStatusProjection;
  activation?: WorkflowActivationStatusProjection;
  feedbackRounds: readonly WorkflowFeedbackRoundProjection[];
  continuations: readonly WorkflowContinuationStatusProjection[];
  diagnostics: readonly WorkflowIntegrityDiagnosticProjection[];
}

export interface WorkflowRunNodeInspectionProjection {
  nodeId: string;
  status: string;
}

export interface WorkflowRunActivationInspectionProjection
  extends WorkflowActivationStatusProjection {
  nodeId: string;
}

export interface WorkflowRunFeedbackRoundInspectionProjection {
  roundId: string;
  requesterNodeId: string;
  status: string;
  joinMode: string;
  required: number;
  responded: number;
}

export interface WorkflowArtifactReferenceProjection {
  runId: string;
  artifactId: string;
  artifactRevision: number;
}

export interface WorkflowNextResultProjection {
  change: 'updated' | 'unchanged';
  result?: string;
}

/** Authorized terminal state delivered to a resumed start_workflow caller. */
export interface WorkflowRunCompletionProjection {
  runId: string;
  runStatus: 'running' | 'succeeded' | 'failed' | 'cancelled';
  terminalReason?: string;
  terminalResult?: WorkflowArtifactReferenceProjection;
  workflowNext?: WorkflowNextResultProjection;
}

/**
 * Bounded run-level diagnostic projection for inspect_workflow_run.
 * Strictly excludes task trees, topology, prompts, artifact bodies, secrets,
 * and absolute paths.
 */
export interface WorkflowRunInspectionProjection {
  runId: string;
  definitionId: string;
  definitionVersion: number;
  runStatus: string;
  policy: WorkflowRunPolicyProjection;
  startedAt?: string;
  deadlineAt?: string;
  terminalReason?: string;
  origin: string;
  parentRunId?: string;
  nodes: readonly WorkflowRunNodeInspectionProjection[];
  gates: readonly WorkflowGateStatusProjection[];
  activations: readonly WorkflowRunActivationInspectionProjection[];
  feedbackRounds: readonly WorkflowRunFeedbackRoundInspectionProjection[];
  continuations: readonly WorkflowContinuationStatusProjection[];
  terminalResult?: WorkflowArtifactReferenceProjection;
  diagnostics: readonly WorkflowIntegrityDiagnosticProjection[];
}
