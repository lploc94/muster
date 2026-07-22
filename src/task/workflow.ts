/**
 * Workflow domain boundary for M018.
 * Owns topology validation, define/start result shaping, and identity derivation;
 * repository owns CAS writes.
 */

import { createHash } from 'node:crypto';
import {
  decodeDefineWorkflowInput,
  DEFAULT_WORKFLOW_POLICY,
  encodeTopologyJson,
  formatWorkflowEntryAggregate,
  fingerprintWorkflowDefinition,
  maximumWorkflowEntryAggregateBytes,
} from './workflow-codec';
import type {
  DefineWorkflowInput,
  DefineWorkflowResult,
  GraphTopologyV1,
  StartWorkflowIdentities,
  StartWorkflowInput,
  StartWorkflowResult,
  WorkflowDefinitionV1,
  WorkflowDependencyEdgeV1,
  WorkflowEntryContractV1,
  WorkflowPolicyV1,
  WorkflowTopologyV1,
} from './workflow-types';

export {
  DEFAULT_WORKFLOW_POLICY,
  decodeDefineWorkflowInput,
  decodeGraphTopology,
  decodeOneNodeTopology,
  decodeStoredTopologyJson,
  decodeTopology,
  encodeTopologyJson,
  formatWorkflowEntryAggregate,
  fingerprintWorkflowDefinition,
  maximumWorkflowEntryAggregateBytes,
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
  WorkflowEntryContractV1,
  WorkflowNodeSpecV1,
  WorkflowPolicyV1,
  WorkflowTopologyV1,
} from './workflow-types';

/** Operations ledger key for an immutable definition claim. */
export function defineWorkflowLedgerKey(
  definitionId: string,
  version: number,
  ownerRootTaskId?: string,
): string {
  return ownerRootTaskId
    ? `define_workflow:${ownerRootTaskId}:${definitionId}:${version}`
    : `define_workflow:workspace:${definitionId}:${version}`;
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

/** Fail branch of DefineWorkflowResult (helpers always return ok:false). */
type DefineWorkflowFailure = Extract<DefineWorkflowResult, { ok: false }>;

/** Shape a conflict (same key, different fingerprint). */
export function defineWorkflowConflict(
  definitionId: string,
  version: number,
): DefineWorkflowFailure {
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
): DefineWorkflowFailure {
  return { ok: false, conflict: true, reason };
}

/** Helper for tests/fixtures: build a minimal valid one-node definition. */
export function makeOneNodeDefinition(overrides?: {
  definitionId?: string;
  version?: number;
  name?: string;
  nodeId?: string;
  createdAt?: string;
  entryContracts?: readonly WorkflowEntryContractV1[];
  policy?: WorkflowPolicyV1;
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
    entryContracts: overrides?.entryContracts ?? [],
    policy: overrides?.policy ?? DEFAULT_WORKFLOW_POLICY,
    scope: { kind: 'workspace' },
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
  entryContracts?: readonly WorkflowEntryContractV1[];
  policy?: WorkflowPolicyV1;
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
    entryContracts: overrides?.entryContracts ?? [],
    policy: overrides?.policy ?? DEFAULT_WORKFLOW_POLICY,
    scope: { kind: 'workspace' },
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
export function startWorkflowLedgerKey(
  startIdempotencyKey: string,
  scope?: {
    ownerRootTaskId: string;
    callerTaskId: string;
    definitionId: string;
    version: number;
  },
): string {
  return scope
    ? `start_workflow:${scope.ownerRootTaskId}:${scope.callerTaskId}:${scope.definitionId}:${scope.version}:${startIdempotencyKey}`
    : `start_workflow:workspace:${startIdempotencyKey}`;
}

/** Stable short id derived from start material (never a raw user path/SQL). */
export function stableId(prefix: string, material: string): string {
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
  entryInputRefs?: readonly { entryNodeId: string; inputRef: string }[];
  identityScope?: string;
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
      input.identityScope ?? 'workspace',
      input.definitionId,
      String(input.version),
      input.startIdempotencyKey,
      input.entryNodeId,
    ].join('\0');
    const entryTaskId = stableId('wft', `${base}\0task`);
    const activationTurnId = stableId('wftn', `${base}\0turn`);
    const entryMessageId = stableId('wfm', `${base}\0message`);
    const entryGateId = stableId('wfg', `${base}\0gate`);
    const inputRefs = input.entryInputRefs?.filter((item) => item.entryNodeId === input.entryNodeId) ?? [];
    const entryArtifacts = (inputRefs.length > 0 ? inputRefs : [{ entryNodeId: input.entryNodeId, inputRef: 'engine_start' }])
      .map((item) => ({
        entryNodeId: input.entryNodeId,
        inputRef: item.inputRef,
        artifactId: stableId('wfa', `${base}\0artifact\0${item.inputRef}`),
      }));
    const activationId = stableId('wfact', `${base}\0entry_start`);
    return {
      runId: stableId('wfr', base),
      entryTaskId,
      activationTurnId,
      entryMessageId,
      entryGateId,
      startArtifactId: entryArtifacts[0]!.artifactId,
      nodeGates: [{ nodeId: input.entryNodeId, gateId: entryGateId }],
      entries: [
        {
          nodeId: input.entryNodeId,
          taskId: entryTaskId,
          gateId: entryGateId,
          activationTurnId,
          messageId: entryMessageId,
          activationId,
        },
      ],
      entryArtifacts,
    };
  }

  // Multi-node: run id shared across nodes; gates/tasks keyed by node id.
  const runBase = [
    input.identityScope ?? 'workspace',
    input.definitionId,
    String(input.version),
    input.startIdempotencyKey,
  ].join('\0');
  const runId = stableId('wfr', runBase);
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
      activationId: stableId('wfact', `${runBase}\0entry_start\0${nodeId}`),
    };
  });
  const entryArtifacts = entriesSorted.flatMap((entryNodeId) => {
    const refs = input.entryInputRefs?.filter((item) => item.entryNodeId === entryNodeId) ?? [];
    return (refs.length > 0 ? refs : [{ entryNodeId, inputRef: 'engine_start' }]).map((item) => ({
      entryNodeId,
      inputRef: item.inputRef,
      artifactId: stableId('wfa', `${runBase}\0artifact\0${entryNodeId}\0${item.inputRef}`),
    }));
  });
  const primary =
    entries.find((e) => e.nodeId === input.entryNodeId) ?? entries[0]!;
  return {
    runId,
    entryTaskId: primary.taskId,
    activationTurnId: primary.activationTurnId,
    entryMessageId: primary.messageId,
    entryGateId: primary.gateId,
    startArtifactId: entryArtifacts[0]!.artifactId,
    nodeGates,
    entries,
    entryArtifacts,
  };
}

/**
 * Reserved activation identities for a multi-node consumer (or any node) after start.
 * Material is runId + nodeId so contribution-time derivation does not need the start key.
 * Entry nodes already used runBase at start; non-entry consumers use this formula only.
 */
export function deriveNodeActivationIdentities(
  runId: string,
  nodeId: string,
): { taskId: string; activationTurnId: string; messageId: string } {
  return {
    taskId: stableId('wft', `${runId}\0task\0${nodeId}`),
    activationTurnId: stableId('wftn', `${runId}\0turn\0${nodeId}`),
    messageId: stableId('wfm', `${runId}\0message\0${nodeId}`),
  };
}

/** Producer artifact identity for NEXT contributions (one logical artifact per producer node). */
export function deriveProducerArtifactId(runId: string, producerNodeId: string): string {
  return stableId('wfa', `${runId}\0artifact\0${producerNodeId}`);
}

/**
 * Durable workflow-run-scoped contribution fence id for a forward NEXT.
 * Keyed by frozen (runId, gateId, inputRef, producerNodeId) so redelivery after
 * source-turn operations-ledger prune is a true no-op (D050 / R027).
 */
export function deriveNextContributionMessageId(
  runId: string,
  gateId: string,
  inputRef: string,
  producerNodeId: string,
): string {
  return stableId(
    'wfrm',
    `${runId}\0contribution\0${gateId}\0${inputRef}\0${producerNodeId}`,
  );
}

/**
 * Deterministic producer artifact revision for a contribution.
 * Fixed per contribution (not priorMax+1) so redelivery reuses the same row.
 * change is accepted for future multi-revision policy but does not affect S03.
 */
export function deriveProducerArtifactRevision(
  _change: 'updated' | 'unchanged',
): number {
  return 1;
}

/**
 * M018 S04 PREV identities (D044 / D048 / D051).
 * Deterministic, run-scoped only — never prompt/result bodies, SQL, paths, or credentials.
 * body_json fences carry these identities only.
 */

/** One open feedback round per requester PREV settlement. */
export function deriveFeedbackRoundId(
  runId: string,
  requesterNodeId: string,
  requesterTurnId: string,
): string {
  return stableId(
    'wfrd',
    `${runId}\0feedback_round\0${requesterNodeId}\0${requesterTurnId}`,
  );
}

/** Durable feedback_request fence id for one target in a round. */
export function deriveFeedbackRequestMessageId(
  runId: string,
  roundId: string,
  targetNodeId: string,
): string {
  return stableId(
    'wfrm',
    `${runId}\0feedback_request\0${roundId}\0${targetNodeId}`,
  );
}

export function deriveFeedbackTargetId(
  runId: string,
  roundId: string,
  targetNodeId: string,
): string {
  return stableId('wftg', `${runId}\0feedback_target\0${roundId}\0${targetNodeId}`);
}

export function deriveFeedbackRequestActivationId(
  runId: string,
  roundId: string,
  targetNodeId: string,
): string {
  return stableId('wfact', `${runId}\0feedback_request\0${roundId}\0${targetNodeId}`);
}

/** Durable feedback_response fence id for one target response. */
export function deriveFeedbackResponseMessageId(
  runId: string,
  roundId: string,
  targetNodeId: string,
): string {
  return stableId(
    'wfrm',
    `${runId}\0feedback_response\0${roundId}\0${targetNodeId}`,
  );
}

/** Queued feedback turn id on a target task FIFO (R012 append, never preemptive). */
export function deriveFeedbackTargetTurnId(
  runId: string,
  roundId: string,
  targetNodeId: string,
): string {
  return stableId(
    'wftn',
    `${runId}\0feedback_turn\0${roundId}\0${targetNodeId}`,
  );
}

/** System message id bound to the target feedback turn. */
export function deriveFeedbackTargetMessageId(
  runId: string,
  roundId: string,
  targetNodeId: string,
): string {
  return stableId(
    'wfm',
    `${runId}\0feedback_message\0${roundId}\0${targetNodeId}`,
  );
}

/** Reserved resume turn id for the ALL-join aggregate when the round becomes satisfied. */
export function deriveFeedbackResumeTurnId(runId: string, roundId: string): string {
  return stableId('wftn', `${runId}\0feedback_resume\0${roundId}`);
}

/** Aggregate resume message id on the requester task. */
export function deriveFeedbackResumeMessageId(runId: string, roundId: string): string {
  return stableId('wfm', `${runId}\0feedback_resume_message\0${roundId}`);
}

export function deriveFeedbackResumeActivationId(runId: string, roundId: string): string {
  return stableId('wfact', `${runId}\0feedback_resume\0${roundId}`);
}


/**
 * M018 S05 fail-fast closure identities / reason codes / host-clamped budgets (D052).
 * Deterministic, run-scoped only — never prompt/result bodies, SQL, paths, or credentials.
 * Budgets are derived from existing rows against these host clamps (no schema column).
 */

/** Bounded reason codes for durable TaskAttention + closure diagnostics. */
export const WORKFLOW_FAIL_REASON_CODES = [
  'agent_fail',
  'invalid_route',
  'run_timeout',
  'aggregate_too_large',
  'feedback_budget_exhausted',
  'turn_budget_exhausted',
  'required_target_cancelled',
  'required_target_unavailable',
] as const;

export type WorkflowFailReasonCode = (typeof WORKFLOW_FAIL_REASON_CODES)[number];

/** Terminal workflow_runs.status produced by a reason code. */
export type WorkflowRunTerminalStatus = 'failed' | 'cancelled';

/**
 * Host-clamped budget bounds for a workflow run.
 * Defaults are used when a run has no explicit policy override.
 */
export const WORKFLOW_RUN_BUDGET_BOUNDS = {
  minFeedbackRoundsPerRun: 1,
  maxFeedbackRoundsPerRun: 32,
  defaultMaxFeedbackRoundsPerRun: 8,
  minWorkflowTurnsPerRun: 1,
  maxWorkflowTurnsPerRun: 256,
  defaultMaxWorkflowTurnsPerRun: 64,
  /** Optional agent-supplied reason text on workflow_fail (UTF-8 bytes). */
  maxFailReasonBytes: 512,
} as const;

export type WorkflowRunBudgetLimits = {
  maxFeedbackRoundsPerRun: number;
  maxWorkflowTurnsPerRun: number;
};

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Clamp optional host/policy budget inputs into safe WORKFLOW_RUN_BUDGET_BOUNDS. */
export function clampWorkflowRunBudgets(input?: {
  maxFeedbackRoundsPerRun?: number;
  maxWorkflowTurnsPerRun?: number;
}): WorkflowRunBudgetLimits {
  return {
    maxFeedbackRoundsPerRun: clampInt(
      input?.maxFeedbackRoundsPerRun,
      WORKFLOW_RUN_BUDGET_BOUNDS.minFeedbackRoundsPerRun,
      WORKFLOW_RUN_BUDGET_BOUNDS.maxFeedbackRoundsPerRun,
      WORKFLOW_RUN_BUDGET_BOUNDS.defaultMaxFeedbackRoundsPerRun,
    ),
    maxWorkflowTurnsPerRun: clampInt(
      input?.maxWorkflowTurnsPerRun,
      WORKFLOW_RUN_BUDGET_BOUNDS.minWorkflowTurnsPerRun,
      WORKFLOW_RUN_BUDGET_BOUNDS.maxWorkflowTurnsPerRun,
      WORKFLOW_RUN_BUDGET_BOUNDS.defaultMaxWorkflowTurnsPerRun,
    ),
  };
}

/**
 * Durable closure fence id for a run terminal transition.
 * One fence per (runId, terminalStatus) so double-close is a no-op.
 */
export function deriveRunClosureFenceId(
  runId: string,
  terminalStatus: WorkflowRunTerminalStatus,
): string {
  return stableId('wfc', `${runId}\0run_closure\0${terminalStatus}`);
}

/** Map terminal run status to the durable TaskAttention code. */
export function workflowRunAttentionCode(
  terminalStatus: WorkflowRunTerminalStatus,
): 'workflow_run_failed' | 'workflow_run_cancelled' {
  return terminalStatus === 'cancelled' ? 'workflow_run_cancelled' : 'workflow_run_failed';
}

/** Map a bounded fail reason code to the terminal workflow_runs.status. */
export function workflowRunTerminalStatusForReason(
  reasonCode: WorkflowFailReasonCode,
): WorkflowRunTerminalStatus {
  return reasonCode === 'required_target_cancelled' ? 'cancelled' : 'failed';
}

/**
 * Bound optional agent-supplied FAIL reason text (no prompts/artifacts/paths/SQL).
 * Empty/whitespace becomes undefined; over-limit is truncated by UTF-8 bytes.
 */
export function boundWorkflowFailReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return undefined;
  const max = WORKFLOW_RUN_BUDGET_BOUNDS.maxFailReasonBytes;
  const buf = Buffer.from(trimmed, 'utf8');
  if (buf.byteLength <= max) return trimmed;
  // Truncate on byte boundary without splitting a multi-byte codepoint.
  let end = max;
  while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}


/** Single outbound edge for a producer node (graph_v1 forbids fan-out). */

/**
 * M018 S06 child-workflow invocation / return identities (surface scaffolding only).
 * Deterministic, run-scoped only — never prompt/result bodies, SQL, paths, or credentials.
 * Repository commit of child runs/continuations is T02.
 */

/** Durable child_invocation fence id (caller turn stages once per child start key). */
export function deriveChildInvocationFenceId(
  callerRunId: string,
  childDefinitionId: string,
  childDefinitionVersion: number,
  childIdempotencyKey: string,
): string {
  return stableId(
    'wfrm',
    `${callerRunId}\0child_invocation\0${childDefinitionId}\0${childDefinitionVersion}\0${childIdempotencyKey}`,
  );
}

/** Durable child_return fence id (one resolution per child run). */
export function deriveChildReturnFenceId(childRunId: string): string {
  return stableId('wfrm', `${childRunId}\0child_return`);
}

/** Pending continuation id for a caller waiting on a child run. */
export function deriveChildContinuationId(callerRunId: string, childRunId: string): string {
  return stableId('wfcn', `${callerRunId}\0continuation\0${childRunId}`);
}

/** Caller return-gate id (one-result gate closed by child terminal NEXT). */
export function deriveCallerReturnGateId(callerRunId: string, childRunId: string): string {
  return stableId('wfg', `${callerRunId}\0return_gate\0${childRunId}`);
}

/** Caller resume turn id queued when the child returns. */
export function deriveCallerResumeTurnId(callerRunId: string, childRunId: string): string {
  return stableId('wftn', `${callerRunId}\0child_return_turn\0${childRunId}`);
}

/** Aggregate return message id on the caller task. */
export function deriveCallerReturnMessageId(callerRunId: string, childRunId: string): string {
  return stableId('wfm', `${callerRunId}\0child_return_message\0${childRunId}`);
}

/** Child run start key material (optional agent key or derived from caller turn). */
export function deriveChildStartIdempotencyKey(input: {
  callerRunId: string;
  callerTurnId: string;
  childDefinitionId: string;
  childDefinitionVersion: number;
  childIdempotencyKey?: string;
}): string {
  if (input.childIdempotencyKey && input.childIdempotencyKey.length > 0) {
    return stableId(
      'wfsk',
      `${input.callerRunId}\0${input.childDefinitionId}\0${input.childDefinitionVersion}\0${input.childIdempotencyKey}`,
    );
  }
  return stableId(
    'wfsk',
    `${input.callerRunId}\0${input.callerTurnId}\0${input.childDefinitionId}\0${input.childDefinitionVersion}`,
  );
}

/** Surface validation for invoke_child entry bindings (ids only; settle validates ownership). */
export function validateInvokeChildEntryBindings(
  entryBindings: readonly {
    childEntryNodeId: string;
    inputRef: string;
    artifactId: string;
    artifactRevision: number;
  }[],
): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(entryBindings) || entryBindings.length === 0) {
    return { ok: false, reason: 'entryBindings must be non-empty' };
  }
  const seen = new Set<string>();
  for (const b of entryBindings) {
    if (!b || typeof b.childEntryNodeId !== 'string' || b.childEntryNodeId.length === 0) {
      return { ok: false, reason: 'entryBinding childEntryNodeId required' };
    }
    if (!b || typeof b.inputRef !== 'string' || b.inputRef.length === 0) {
      return { ok: false, reason: 'entryBinding inputRef required' };
    }
    if (typeof b.artifactId !== 'string' || b.artifactId.length === 0) {
      return { ok: false, reason: 'entryBinding artifactId required' };
    }
    if (!Number.isInteger(b.artifactRevision) || b.artifactRevision < 1) {
      return { ok: false, reason: 'entryBinding artifactRevision must be positive' };
    }
    const bindingKey = `${b.childEntryNodeId}\0${b.inputRef}`;
    if (seen.has(bindingKey)) {
      return {
        ok: false,
        reason: `duplicate entryBinding: ${b.childEntryNodeId}/${b.inputRef}`,
      };
    }
    seen.add(bindingKey);
  }
  return { ok: true };
}


export function outgoingEdge(
  topology: WorkflowTopologyV1,
  fromNodeId: string,
): WorkflowDependencyEdgeV1 | undefined {
  if (topology.kind !== 'graph_v1') return undefined;
  return topology.edges.find((edge) => edge.fromNodeId === fromNodeId);
}

/** Destination inputRefs for a consumer in definition edge order (not arrival order). */
export function consumerInputRefsInDefinitionOrder(
  topology: WorkflowTopologyV1,
  consumerNodeId: string,
): string[] {
  if (topology.kind !== 'graph_v1') return [];
  return topology.edges
    .filter((edge) => edge.toNodeId === consumerNodeId)
    .map((edge) => edge.inputRef);
}

/** Start fingerprint (no prompt/message/artifact bodies). */
export function fingerprintStartWorkflow(input: {
  definitionId: string;
  version: number;
  startIdempotencyKey: string;
  entryNodeId: string;
  goal: string;
  backend: string;
  ownerRootTaskId?: string;
  callerTaskId?: string;
  callerTurnId?: string;
  entryInputs?: readonly { entryNodeId: string; inputRef: string; kind: string; value: string }[];
  policy?: WorkflowPolicyV1;
}): string {
  const payload = JSON.stringify({
    definitionId: input.definitionId,
    version: input.version,
    startIdempotencyKey: input.startIdempotencyKey,
    entryNodeId: input.entryNodeId,
    goal: input.goal,
    backend: input.backend,
    ownerRootTaskId: input.ownerRootTaskId,
    callerTaskId: input.callerTaskId,
    callerTurnId: input.callerTurnId,
    entryInputs: (input.entryInputs ?? []).map((entryInput) => ({
      entryNodeId: entryInput.entryNodeId,
      inputRef: entryInput.inputRef,
      kind: entryInput.kind,
      valueSha256: createHash('sha256').update(entryInput.value, 'utf8').digest('hex'),
    })),
    policy: input.policy,
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
      entryInputs: readonly NonNullable<StartWorkflowInput['entryInputs']>[number][];
      entryContracts: readonly WorkflowEntryContractV1[];
      policy: WorkflowPolicyV1;
      ownerRootTaskId?: string;
      callerTaskId?: string;
      callerTurnId?: string;
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
  if (
    !isNonEmptyBounded(input.createdAt, 64) ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  ) {
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
  const authorityValues = [input.ownerRootTaskId, input.callerTaskId, input.callerTurnId];
  if (authorityValues.some((value) => value !== undefined) && authorityValues.some((value) => value === undefined)) {
    return { ok: false, reason: 'invalid caller authority' };
  }
  const goal = input.goal ?? input.definitionId;
  const backend = input.backend ?? 'grok';
  const policy = input.policy ?? DEFAULT_WORKFLOW_POLICY;
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
  const contracts = input.entryContracts ?? [];
  const entryInputs = input.entryInputs ?? [];
  const contractByKey = new Map<string, WorkflowEntryContractV1>(
    contracts.map((contract) => [`${contract.entryNodeId}\0${contract.inputRef}`, contract] as const),
  );
  const inputByKey = new Map<string, (typeof entryInputs)[number]>();
  for (const entryInput of entryInputs) {
    if (
      !isNonEmptyBounded(entryInput.entryNodeId, 128) ||
      !isNonEmptyBounded(entryInput.inputRef, 128) ||
      !isNonEmptyBounded(entryInput.kind, 128) ||
      typeof entryInput.value !== 'string'
    ) {
      return { ok: false, reason: 'invalid entry input' };
    }
    const key = `${entryInput.entryNodeId}\0${entryInput.inputRef}`;
    if (inputByKey.has(key)) return { ok: false, reason: 'duplicate entry input' };
    const contract = contractByKey.get(key);
    if (!contract || contract.expectedArtifactKind !== entryInput.kind) {
      return { ok: false, reason: 'entry input contract mismatch' };
    }
    if (Buffer.byteLength(entryInput.value, 'utf8') > policy.maxArtifactBytes) {
      return { ok: false, reason: 'entry artifact too large' };
    }
    inputByKey.set(key, entryInput);
  }
  if (inputByKey.size !== contractByKey.size) {
    return { ok: false, reason: 'incomplete entry inputs' };
  }
  for (const key of contractByKey.keys()) {
    if (!inputByKey.has(key)) return { ok: false, reason: 'incomplete entry inputs' };
  }
  if (contracts.length > 0 && input.callerTaskId === undefined) {
    return { ok: false, reason: 'caller authority required for entry inputs' };
  }
  const orderedEntryInputs = contracts.map((contract) =>
    inputByKey.get(`${contract.entryNodeId}\0${contract.inputRef}`)!,
  );
  let identities: StartWorkflowIdentities;
  try {
    identities = deriveStartIdentities({
      definitionId: input.definitionId,
      version: input.version,
      startIdempotencyKey: input.startIdempotencyKey,
      entryNodeId: input.entryNodeId,
      entryNodeIds,
      allNodeIds,
      entryInputRefs: contracts,
      identityScope: input.ownerRootTaskId && input.callerTaskId
        ? `${input.ownerRootTaskId}\0${input.callerTaskId}`
        : 'workspace',
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
    ...(input.ownerRootTaskId !== undefined ? { ownerRootTaskId: input.ownerRootTaskId } : {}),
    ...(input.callerTaskId !== undefined ? { callerTaskId: input.callerTaskId } : {}),
    ...(input.callerTurnId !== undefined ? { callerTurnId: input.callerTurnId } : {}),
    entryInputs: orderedEntryInputs,
    policy,
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
    entryInputs: orderedEntryInputs,
    entryContracts: contracts,
    policy,
    ...(input.ownerRootTaskId !== undefined ? { ownerRootTaskId: input.ownerRootTaskId } : {}),
    ...(input.callerTaskId !== undefined ? { callerTaskId: input.callerTaskId } : {}),
    ...(input.callerTurnId !== undefined ? { callerTurnId: input.callerTurnId } : {}),
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
    entryArtifacts: identities.entryArtifacts,
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

/** Fail branch of StartWorkflowResult (helpers always return ok:false). */
type StartWorkflowFailure = Extract<StartWorkflowResult, { ok: false }>;

/** Shape a start conflict (same key, different fingerprint). */
export function startWorkflowConflict(
  definitionId?: string,
  version?: number,
): StartWorkflowFailure {
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
): StartWorkflowFailure {
  return {
    ok: false,
    conflict: true,
    reason,
    definitionId,
    version,
  };
}
