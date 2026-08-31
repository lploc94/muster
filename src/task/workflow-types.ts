/**
 * Workflow domain types for M018 workflow definitions.
 * Topology and identity live here; repository owns durable claim/write.
 * Never carries database paths, SQL, credentials, prompt text, or artifact bodies.
 */

/** The single normalized topology kind owned by the workflow engine. */
export type WorkflowTopologyKind = 'workflow';

export const WORKFLOW_SCHEMA = 'muster.workflow/v2';
export const WORKFLOW_NAME_MAX_LENGTH = 200;
export const WORKFLOW_DESCRIPTION_MAX_LENGTH = 4_096;
export const WORKFLOW_TITLE_MAX_LENGTH = 200;
export const WORKFLOW_INSTRUCTIONS_MAX_LENGTH = 120_000;
export const WORKFLOW_OUTCOME_WHEN_MAX_LENGTH = 4_096;
export const WORKFLOW_RUN_GOAL_MAX_LENGTH = 120_000;
export const WORKFLOW_INPUT_REF_MAX_LENGTH = 128;
export const WORKFLOW_GRAPH_MAX_NODES = 64;
export const WORKFLOW_GRAPH_MAX_EDGES = 128;
export const WORKFLOW_ENTRY_CONTRACTS_MAX = 128;
export const WORKFLOW_CHILD_BINDINGS_MAX = 64;
export const WORKFLOW_SCRIPT_FILE_MAX_LENGTH = 1_024;
export const WORKFLOW_SCRIPT_MAX_ARGS = 64;
export const WORKFLOW_SCRIPT_ARG_MAX_LENGTH = 4_096;
export const WORKFLOW_PACKAGE_PATH_MAX_LENGTH = 1_024;
export const WORKFLOW_PACKAGE_HASH_LENGTH = 64;

export type ScriptInterpreter = 'node' | 'python' | 'python3';

export type WorkflowPackageKind = 'file' | 'bundle';
export type WorkflowCatalogRootKind = 'canonical' | 'legacy' | 'custom';

/** Host-authored provenance for a predefined workflow package. */
export interface WorkflowPackageSource {
  kind: 'predefined';
  scope: 'workspace' | 'global';
  packageKind: WorkflowPackageKind;
  catalogRootKind: WorkflowCatalogRootKind;
  /** Relative to the selected catalog root; `.` for a flat workflow file. */
  packagePath: string;
  /** Relative to packagePath; flat workflows use the Markdown basename. */
  entryFile: string;
  workflowRef: string;
  packageSha256: string;
}

/** Package provenance plus the exact script bytes approved at definition time. */
export interface WorkflowScriptSource extends WorkflowPackageSource {
  scriptSha256: string;
}

/** Conservative, platform-independent validation before the runtime realpath check. */
export function isValidWorkflowScriptFile(
  file: unknown,
  interpreter: ScriptInterpreter,
): file is string {
  if (
    typeof file !== 'string' ||
    file.length === 0 ||
    file.length > WORKFLOW_SCRIPT_FILE_MAX_LENGTH ||
    /[\x00-\x1f\x7f]/.test(file)
  ) return false;
  const portable = file.replace(/\\/g, '/');
  if (
    portable.startsWith('/') ||
    /^[A-Za-z]:/.test(portable) ||
    portable.split('/').some((segment) => segment === '' || segment === '..')
  ) return false;
  const lower = portable.toLowerCase();
  return interpreter === 'node'
    ? lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')
      || lower.endsWith('.ts') || lower.endsWith('.cts') || lower.endsWith('.mts')
    : lower.endsWith('.py');
}

/** Frozen local-process execution contract for one deterministic workflow node. */
export interface ScriptExecutionSpec {
  kind: 'script';
  interpreter: ScriptInterpreter;
  /** Package-relative path, or workspace-relative for an ad-hoc definition. */
  file: string;
  /** Exact argv values after the script path; never parsed as a shell string. */
  args: readonly string[];
  /** Present only when the node was compiled from a predefined package. */
  source?: WorkflowScriptSource;
}

export type WorkflowInstructions =
  | {
      kind: 'inline';
      content: string;
      sha256: string;
    }
  | {
      kind: 'file';
      file: string;
      /** Populated when the saved package loader freezes the referenced asset. */
      content?: string;
      sha256?: string;
    };

export interface WorkflowAgentNextRoute {
  when: string;
}

export interface WorkflowAgentPrevRoute {
  when: string;
  targets: readonly string[];
  feedback: 'required';
}

export interface WorkflowAgentFailRoute {
  when: string;
}

export interface WorkflowAgentOutcome {
  kind: 'agent';
  requireExplicitDisposition: boolean;
  next?: WorkflowAgentNextRoute;
  prev?: readonly WorkflowAgentPrevRoute[];
  fail?: WorkflowAgentFailRoute;
}

export interface WorkflowExitNextRoute {
  when: { exitCode: 0 };
}

export interface WorkflowExitPrevRoute {
  when: { exitCode: 'nonzero' };
  targets: readonly string[];
  feedback: 'stdout';
}

export interface WorkflowExitFailRoute {
  when: { exitCode: 'nonzero' };
}

export interface WorkflowExitOutcome {
  kind: 'exit';
  next: WorkflowExitNextRoute;
  prev?: WorkflowExitPrevRoute;
  fail?: WorkflowExitFailRoute;
}

export type WorkflowNodeOutcome = WorkflowAgentOutcome | WorkflowExitOutcome;

/** One normalized workflow node. Author fields and host-frozen routing share one model. */
export interface WorkflowNodeSpec {
  /** Stable node id within the definition (not a task id). */
  nodeId: string;
  /** Optional short display metadata; never executable task content. */
  title?: string;
  /** Optional frozen executable task content. */
  instructions?: WorkflowInstructions;
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
  /** Absent for an agent node. */
  execution?: ScriptExecutionSpec;
  outcome?: WorkflowNodeOutcome;
}

/**
 * Forward dependency edge: producer → consumer gate fill by destination inputRef.
 * inputRefs are unique among edges into the same toNodeId (per-consumer).
 */
export interface WorkflowDependencyEdge {
  fromNodeId: string;
  toNodeId: string;
  /** Destination gate input ref frozen on the definition. */
  inputRef: string;
  /** Exact transport artifact kind accepted by the destination binding. */
  expectedArtifactKind?: string;
}

export interface WorkflowInputContract {
  name: string;
  semanticKind: string;
  entryNodeId: string;
  inputRef: string;
}

export interface WorkflowOutputContract {
  name: string;
  semanticKind: string;
  terminalNodeId: string;
}

/** The one normalized topology used for one-node and multi-node workflows alike. */
export interface WorkflowTopology {
  kind: 'workflow';
  description?: string;
  inputs: readonly WorkflowInputContract[];
  outputs: readonly WorkflowOutputContract[];
  nodes: readonly WorkflowNodeSpec[];
  edges: readonly WorkflowDependencyEdge[];
}

/** Explicit caller-input contract for one workflow entry. */
export interface WorkflowEntryContract {
  entryNodeId: string;
  inputRef: string;
  expectedArtifactKind: string;
}

/** Frozen, host-bounded workflow policy. */
export interface WorkflowPolicy {
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
export interface WorkflowDefinition {
  definitionId: string;
  version: number;
  name: string;
  topology: WorkflowTopology;
  entryContracts: readonly WorkflowEntryContract[];
  policy: WorkflowPolicy;
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

/** Caller-authored literal value bound to one exact entry contract at start. */
export interface StartWorkflowEntryLiteralInput {
  entryNodeId: string;
  inputRef: string;
  kind: string;
  value: string;
}

/** Caller-authorized reference to one named output of a prior workflow run. */
export interface StartWorkflowEntryRunReferenceInput {
  entryNodeId: string;
  inputRef: string;
  fromRun: string;
  output: string;
}

/** Exactly one literal value or prior-run result reference for an entry contract. */
export type StartWorkflowEntryInput =
  | StartWorkflowEntryLiteralInput
  | StartWorkflowEntryRunReferenceInput;

/** Public canonical start input retained by name until trusted host resolution. */
export type WorkflowStartInput =
  | {
      name: string;
      value: string;
    }
  | {
      name: string;
      fromRun: string;
      output: string;
    };

/**
 * Caller-authorized reuse of one exact completed prior execution for one graph node.
 *
 * Source and destination are separate identities on purpose: the artifact was produced
 * by `sourceNodeId` in `sourceRunId` (possibly under a different definition, so that id
 * need not exist in this run's topology), and is bound to `destinationNodeId` here.
 * `sourceTaskId` pins the exact execution, because one node id maps to a different task
 * in every run, so "latest matching row" is a guess rather than a caller authorization.
 */
export interface StartWorkflowNodeReuse {
  /** Node in this run's frozen topology that receives the reused artifact. */
  destinationNodeId: string;
  /** Prior run that produced the artifact. */
  sourceRunId: string;
  /** Node in the prior run's topology that produced the artifact. */
  sourceNodeId: string;
  /** Exact completed task execution whose artifact is bound. */
  sourceTaskId: string;
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
  /** Prior-run references for graph nodes reused by this start. */
  reuse?: readonly StartWorkflowNodeReuse[];
  /** Frozen definition contracts loaded by the repository. */
  entryContracts?: readonly WorkflowEntryContract[];
  /** Caller/root authority included in fingerprint and identity derivation. */
  ownerRootTaskId?: string;
  callerTaskId?: string;
  callerTurnId?: string;
  /** Frozen effective policy copied onto the run. */
  policy?: WorkflowPolicy;
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
        | 'entry input reference unresolved'
        | 'terminal node cannot be reused'
        | 'node reuse reference unresolved'
        | 'reuse artifact kind mismatch'
        | 'reuse aggregate exceeds policy'
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

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type WorkflowNodeStatus =
  | 'pending' | 'active' | 'reused' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export type WorkflowGateStatus = 'open' | 'satisfied' | 'consumed' | 'failed' | 'cancelled';

/** Bounded workflow gate state (no topology, prompts, artifact bodies, or paths). */
export interface WorkflowGateStatusProjection {
  gateId: string;
  consumerNodeId: string;
  status: WorkflowGateStatus;
  /** Distinct filled inputRefs. */
  satisfied: number;
  /** Binding count (required inputs). */
  required: number;
  inputs: readonly WorkflowGateInputStatusProjection[];
}

export type WorkflowGateInputState =
  | 'supplied_live'
  | 'supplied_reused'
  | 'pending'
  | 'blocking';

export interface WorkflowGateInputStatusProjection {
  inputRef: string;
  producerNodeId: string;
  state: WorkflowGateInputState;
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

/** Host-only bounded workflow graph node state. Never exposed through agent tools. */
export interface WorkflowGraphNodeProjection {
  nodeId: string;
  workflowNodeStatus: WorkflowNodeStatus;
  executionActivity:
    | 'none'
    | 'queued'
    | 'executing'
    | 'waiting_feedback'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'skipped';
  displayState:
    | 'queued'
    | 'executing'
    | 'waiting'
    | 'completed'
    | 'reused'
    | 'blocked'
    | 'not_started'
    | 'failed'
    | 'cancelled'
    | 'skipped';
  progressBucket:
    | 'queued'
    | 'executing'
    | 'waiting'
    | 'completed'
    | 'blocked'
    | 'not_started'
    | 'failed'
    | 'cancelled'
    | 'skipped';
  reason?: 'waiting_for_inputs' | 'run_closed_before_activation' | 'awaiting_workflow_route';
}

/** Host-only durable definition edge for an instantiated workflow run. */
export interface WorkflowGraphEdgeProjection {
  fromNodeId: string;
  toNodeId: string;
  inputRef: string;
  contributionState: WorkflowGateInputState;
}

export interface WorkflowGraphProgressProjection {
  total: number;
  completed: number;
  queued: number;
  executing: number;
  waiting: number;
  blocked: number;
  notStarted: number;
  failed: number;
  cancelled: number;
  skipped: number;
  frontierNodeIds: readonly string[];
  activeNodeIds: readonly string[];
}

/** Direct nested workflow run visible from a host graph read. */
export interface WorkflowGraphChildRunProjection {
  runId: string;
  status: WorkflowRunStatus;
}

export interface WorkflowGraphFeedbackRoundProjection {
  roundId: string;
  requesterNodeId: string;
  status: 'open' | 'satisfied';
  joinMode: 'all';
  required: number;
  responded: number;
}

/** Reuse density derived from the bounded run graph. */
export interface WorkflowGraphReuseProjection {
  nodeCount: number;
  edgeCount: number;
}

/**
 * Host-only bounded workflow graph for the run containing a task.
 * Unlike agent-facing workflow status projections, this intentionally exposes
 * durable node topology but never prompts, artifact bodies, secrets, or paths.
 */
export interface WorkflowGraphProjection {
  runId: string;
  runStatus: WorkflowRunStatus;
  nodes: readonly WorkflowGraphNodeProjection[];
  edges: readonly WorkflowGraphEdgeProjection[];
  gates: readonly WorkflowGateStatusProjection[];
  activeGate?: WorkflowGateStatusProjection;
  progress: WorkflowGraphProgressProjection;
  feedbackRounds: readonly WorkflowGraphFeedbackRoundProjection[];
  childRuns: readonly WorkflowGraphChildRunProjection[];
  reuse: WorkflowGraphReuseProjection;
  diagnostics: readonly WorkflowIntegrityDiagnosticProjection[];
}

export interface WorkflowRunNodeInspectionProjection {
  nodeId: string;
  status: string;
  /** Opaque exact execution reference accepted as start_workflow reuse.fromTask. */
  taskId?: string;
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
  runStatus: WorkflowRunStatus;
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
