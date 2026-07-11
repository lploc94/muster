/**
 * Muster-native agentic workflow contracts.
 *
 * Source of truth for phases, artifacts, command taxonomy, provenance, and
 * structured errors. Host code validates deterministic fields; model prompts
 * only guide production of these shapes. Never store raw chain-of-thought.
 *
 * @see docs/AGENTIC-WORKFLOW-KNOWLEDGE.md
 */

// ─── Version ────────────────────────────────────────────────────────────────

/** Contract schema version for artifact envelopes. */
export const WORKFLOW_CONTRACT_VERSION = 1 as const;

// ─── Phases ─────────────────────────────────────────────────────────────────

/**
 * Workflow phase on a root-owned WorkflowRun.
 * Independent of TaskLifecycleState (open/succeeded/failed/…).
 */
export type WorkflowPhase =
  | 'draft'
  | 'thinking'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'approved'
  | 'implementing'
  | 'testing'
  | 'reviewing'
  | 'debugging'
  | 'verifying'
  | 'finishing'
  | 'completed'
  | 'abandoned';

export const WORKFLOW_PHASES: readonly WorkflowPhase[] = [
  'draft',
  'thinking',
  'planning',
  'awaiting_plan_approval',
  'approved',
  'implementing',
  'testing',
  'reviewing',
  'debugging',
  'verifying',
  'finishing',
  'completed',
  'abandoned',
] as const;

/** Legal directed transitions. Host rejects anything not listed. */
export const WORKFLOW_PHASE_TRANSITIONS: Readonly<
  Record<WorkflowPhase, readonly WorkflowPhase[]>
> = {
  draft: ['thinking', 'planning', 'abandoned'],
  thinking: ['planning', 'awaiting_plan_approval', 'abandoned'],
  planning: ['awaiting_plan_approval', 'thinking', 'abandoned'],
  awaiting_plan_approval: ['approved', 'planning', 'thinking', 'abandoned'],
  approved: ['implementing', 'planning', 'abandoned'],
  implementing: ['testing', 'reviewing', 'debugging', 'verifying', 'planning', 'finishing', 'abandoned'],
  testing: ['reviewing', 'debugging', 'implementing', 'verifying', 'planning', 'abandoned'],
  reviewing: ['debugging', 'implementing', 'verifying', 'testing', 'planning', 'finishing', 'abandoned'],
  debugging: ['implementing', 'planning', 'testing', 'reviewing', 'abandoned'],
  verifying: ['finishing', 'debugging', 'implementing', 'planning', 'abandoned'],
  finishing: ['completed', 'debugging', 'planning', 'abandoned'],
  completed: [],
  abandoned: [],
};

export function canTransitionPhase(from: WorkflowPhase, to: WorkflowPhase): boolean {
  if (from === to) return true;
  return (WORKFLOW_PHASE_TRANSITIONS[from] ?? []).includes(to);
}

// ─── Command taxonomy ───────────────────────────────────────────────────────

export type WorkflowCommandId =
  | 'think'
  | 'plan'
  | 'approve'
  | 'replan'
  | 'implement'
  | 'test'
  | 'review'
  | 'debug'
  | 'verify'
  | 'finish';

export type TaskSessionCommandId =
  | 'new'
  | 'tasks'
  | 'status'
  | 'focus'
  | 'fork'
  | 'cancel'
  | 'retry'
  | 'backend'
  | 'model'
  | 'mcp'
  | 'help';

export type UtilityCommandId = 'context' | 'compact' | 'export' | 'archive';

export type NativeCommandId = WorkflowCommandId | TaskSessionCommandId | UtilityCommandId;

export type CommandEffectClass =
  | 'read'
  | 'mutate_focus'
  | 'mutate_plan'
  | 'mutate_execution'
  | 'mutate_lifecycle'
  | 'mutate_store'
  | 'export';

export interface CommandSpecMeta {
  id: NativeCommandId;
  aliases: readonly string[];
  effectClass: CommandEffectClass;
  /** Minimum phase required on the focused root workflow (if any). */
  requiredPhases?: readonly WorkflowPhase[];
  /** Whether a focused task is required. */
  requiresTask: boolean;
  summary: string;
}

export const NATIVE_COMMAND_SPECS: readonly CommandSpecMeta[] = [
  { id: 'think', aliases: [], effectClass: 'mutate_plan', requiresTask: true, summary: 'Produce a decision brief for the focused root.' },
  { id: 'plan', aliases: [], effectClass: 'mutate_plan', requiresTask: true, summary: 'Produce or revise a structured plan artifact.' },
  {
    id: 'approve',
    aliases: [],
    effectClass: 'mutate_execution',
    requiresTask: true,
    requiredPhases: ['awaiting_plan_approval'],
    summary: 'Approve the pending plan and start validated work.',
  },
  {
    id: 'replan',
    aliases: [],
    effectClass: 'mutate_plan',
    requiresTask: true,
    requiredPhases: [
      'awaiting_plan_approval',
      'approved',
      'implementing',
      'testing',
      'reviewing',
      'debugging',
      'verifying',
    ],
    summary: 'Revise the plan without losing prior evidence.',
  },
  {
    id: 'implement',
    aliases: [],
    effectClass: 'mutate_execution',
    requiresTask: true,
    requiredPhases: ['approved', 'implementing', 'debugging'],
    summary: 'Run or resume implementation children.',
  },
  {
    id: 'test',
    aliases: [],
    effectClass: 'mutate_execution',
    requiresTask: true,
    requiredPhases: ['implementing', 'testing', 'reviewing', 'debugging', 'verifying'],
    summary: 'Run independent test evidence collection.',
  },
  {
    id: 'review',
    aliases: [],
    effectClass: 'mutate_execution',
    requiresTask: true,
    requiredPhases: ['implementing', 'testing', 'reviewing', 'debugging', 'verifying'],
    summary: 'Run independent review evidence collection.',
  },
  {
    id: 'debug',
    aliases: [],
    effectClass: 'mutate_execution',
    requiresTask: true,
    requiredPhases: ['implementing', 'testing', 'reviewing', 'debugging', 'verifying', 'finishing'],
    summary: 'Record debug analysis and next steps.',
  },
  {
    id: 'verify',
    aliases: [],
    effectClass: 'mutate_execution',
    requiresTask: true,
    requiredPhases: ['implementing', 'testing', 'reviewing', 'debugging', 'verifying'],
    summary: 'Synthesize verification evidence for declared checks.',
  },
  {
    id: 'finish',
    aliases: [],
    effectClass: 'mutate_lifecycle',
    requiresTask: true,
    requiredPhases: ['verifying', 'finishing', 'reviewing', 'testing', 'implementing'],
    summary: 'Stage an outcome proposal for authorized sealing.',
  },
  { id: 'new', aliases: [], effectClass: 'mutate_focus', requiresTask: false, summary: 'Create a draft chat or root task with a goal.' },
  { id: 'tasks', aliases: ['list'], effectClass: 'read', requiresTask: false, summary: 'List tasks in the workspace store.' },
  { id: 'status', aliases: [], effectClass: 'read', requiresTask: true, summary: 'Show status of the focused task/workflow.' },
  { id: 'focus', aliases: [], effectClass: 'mutate_focus', requiresTask: false, summary: 'Focus a task by id.' },
  { id: 'fork', aliases: [], effectClass: 'mutate_store', requiresTask: true, summary: 'Fork a continuation from the focused task.' },
  { id: 'cancel', aliases: [], effectClass: 'mutate_lifecycle', requiresTask: true, summary: 'Cancel the focused task (cascades).' },
  { id: 'retry', aliases: [], effectClass: 'mutate_execution', requiresTask: true, summary: 'Retry a recoverable failed/interrupted turn.' },
  { id: 'backend', aliases: [], effectClass: 'mutate_store', requiresTask: true, summary: 'Select backend for a draft/root planner task.' },
  { id: 'model', aliases: [], effectClass: 'mutate_store', requiresTask: true, summary: 'Select model for the focused task.' },
  { id: 'mcp', aliases: [], effectClass: 'read', requiresTask: false, summary: 'Show MCP / bridge configuration summary.' },
  { id: 'help', aliases: ['?'], effectClass: 'read', requiresTask: false, summary: 'List native commands and usage.' },
  { id: 'context', aliases: [], effectClass: 'read', requiresTask: true, summary: 'Report normalized context/usage/evidence provenance.' },
  { id: 'compact', aliases: [], effectClass: 'mutate_store', requiresTask: true, summary: 'Compact transcript while retaining plan/evidence.' },
  { id: 'export', aliases: [], effectClass: 'export', requiresTask: true, summary: 'Export deterministic Markdown/JSON of the workflow.' },
  { id: 'archive', aliases: [], effectClass: 'mutate_store', requiresTask: true, summary: 'Archive (hide) a task without changing lifecycle.' },
];

// ─── Structured errors ──────────────────────────────────────────────────────

export type WorkflowErrorCode =
  | 'PHASE_NOT_APPROVED'
  | 'CAPABILITY_DENIED'
  | 'PLAN_INVALID'
  | 'EVIDENCE_MISSING'
  | 'COMMAND_UNKNOWN'
  | 'COMMAND_PHASE'
  | 'COMMAND_ARGS'
  | 'ARTIFACT_INVALID'
  | 'TRANSITION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'DUPLICATE_APPROVAL'
  | 'NOT_FOUND';

export interface WorkflowError {
  code: WorkflowErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function workflowError(
  code: WorkflowErrorCode,
  message: string,
  details?: Record<string, unknown>,
): WorkflowError {
  return details ? { code, message, details } : { code, message };
}

// ─── Provenance & confidence ────────────────────────────────────────────────

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface ProvenanceRef {
  /** Stable artifact or evidence id. */
  artifactId: string;
  /** Optional human label. */
  label?: string;
  /** Producer task id when known. */
  producedByTaskId?: string;
  /** Producer turn id when known. */
  producedByTurnId?: string;
}

export interface EvidenceRef {
  id: string;
  kind: 'command' | 'test' | 'review' | 'file' | 'log' | 'user' | 'other';
  summary: string;
  /** Bounded redacted excerpt — never credentials or full tool payloads. */
  excerpt?: string;
  path?: string;
  producedAt?: string;
}

// ─── Artifact kinds ─────────────────────────────────────────────────────────

export type ArtifactKind =
  | 'decision_brief'
  | 'plan'
  | 'task_handoff'
  | 'test_report'
  | 'review_report'
  | 'verification_report'
  | 'debug_report'
  | 'outcome_proposal'
  | 'context_report'
  | 'compact_audit'
  | 'export_bundle';

export interface ArtifactEnvelope<TKind extends ArtifactKind, TBody> {
  contractVersion: typeof WORKFLOW_CONTRACT_VERSION;
  id: string;
  kind: TKind;
  rootTaskId: string;
  /** Workflow run id owning this artifact. */
  workflowRunId: string;
  /** Plan revision this artifact is relative to (when applicable). */
  planRevision?: number;
  producedByTaskId: string;
  producedByTurnId?: string;
  producedAt: string;
  /** Consumer role hint (validator / UI / child task). */
  consumer: 'host' | 'user' | 'planner' | 'executor' | 'reviewer' | 'tester' | 'debugger';
  body: TBody;
}

// ─── Decision brief ─────────────────────────────────────────────────────────

export interface DecisionBriefBody {
  goal: string;
  problemSummary: string;
  constraints: string[];
  openQuestions: string[];
  assumptions: string[];
  risks: string[];
  recommendedApproach: string;
  alternatives: Array<{ option: string; tradeoff: string }>;
  confidence: ConfidenceLevel;
  /** Explicit unknown fields the planner could not resolve. */
  unknowns: string[];
  evidence: EvidenceRef[];
}

export type DecisionBrief = ArtifactEnvelope<'decision_brief', DecisionBriefBody>;

// ─── Plan artifact ──────────────────────────────────────────────────────────

export type ProposedTaskRole = 'coordinator' | 'worker';

export interface ProposedTaskNode {
  /** Stable id within the plan (not yet a store task id unless materializing). */
  proposalId: string;
  goal: string;
  role: ProposedTaskRole;
  backend: string;
  /** proposalIds this node depends on. */
  dependsOn: string[];
  acceptanceCriteria: string[];
  /** Declared verification steps for this node. */
  verification: string[];
  capabilities?: string[];
  model?: string;
  notes?: string;
}

export interface PlanArtifactBody {
  title: string;
  summary: string;
  goal: string;
  revision: number;
  /** Prior revision this revises, if any. */
  revisesRevision?: number;
  tasks: ProposedTaskNode[];
  acceptanceCriteria: string[];
  verificationStrategy: string[];
  rollbackNotes: string[];
  openQuestions: string[];
  constraints: string[];
  decisionBriefId?: string;
  confidence: ConfidenceLevel;
  unknowns: string[];
  evidence: EvidenceRef[];
}

export type PlanArtifact = ArtifactEnvelope<'plan', PlanArtifactBody>;

// ─── Task handoff ───────────────────────────────────────────────────────────

export interface TaskHandoffBody {
  childProposalId?: string;
  childTaskId?: string;
  goal: string;
  constraints: string[];
  allowedActions: string[];
  outputContract: string;
  evidenceRefs: ProvenanceRef[];
  acceptanceCriteria: string[];
  notes?: string;
}

export type TaskHandoff = ArtifactEnvelope<'task_handoff', TaskHandoffBody>;

// ─── Reports ────────────────────────────────────────────────────────────────

export interface TestReportBody {
  scope: string;
  commands: string[];
  passed: boolean;
  summary: string;
  failures: Array<{ name: string; detail: string }>;
  evidence: EvidenceRef[];
  confidence: ConfidenceLevel;
  unknowns: string[];
  residualRisks: string[];
}

export type TestReport = ArtifactEnvelope<'test_report', TestReportBody>;

export interface ReviewFinding {
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
  path?: string;
  evidence?: EvidenceRef[];
}

export interface ReviewReportBody {
  scope: string;
  summary: string;
  findings: ReviewFinding[];
  recommendation: 'approve' | 'request_changes' | 'block';
  evidence: EvidenceRef[];
  confidence: ConfidenceLevel;
  unknowns: string[];
  residualRisks: string[];
}

export type ReviewReport = ArtifactEnvelope<'review_report', ReviewReportBody>;

export interface VerificationReportBody {
  checks: Array<{
    name: string;
    command?: string;
    passed: boolean;
    detail: string;
  }>;
  overallPassed: boolean;
  summary: string;
  evidence: EvidenceRef[];
  confidence: ConfidenceLevel;
  unknowns: string[];
  residualRisks: string[];
}

export type VerificationReport = ArtifactEnvelope<'verification_report', VerificationReportBody>;

export interface DebugReportBody {
  symptom: string;
  attempts: Array<{ action: string; result: string }>;
  rootCause?: string;
  confidence: ConfidenceLevel;
  nextStep: string;
  evidence: EvidenceRef[];
  unknowns: string[];
  retryable: boolean;
}

export type DebugReport = ArtifactEnvelope<'debug_report', DebugReportBody>;

/**
 * Workflow-scoped outcome proposal (staging only).
 * Distinct from task-lifecycle OutcomeProposal in src/task/types.ts — sealing
 * still goes through authorized lifecycle transitions.
 */
export interface WorkflowOutcomeProposalBody {
  kind: 'complete' | 'fail';
  summary: string;
  result?: string;
  error?: string;
  evidenceRefs: ProvenanceRef[];
  residualRisks: string[];
  confidence: ConfidenceLevel;
}

export type WorkflowOutcomeProposal = ArtifactEnvelope<'outcome_proposal', WorkflowOutcomeProposalBody>;

// ─── Role / capability matrix (workflow) ────────────────────────────────────

export type WorkflowRole =
  | 'planner'
  | 'executor'
  | 'tester'
  | 'reviewer'
  | 'debugger'
  | 'verifier'
  | 'coordinator';

/**
 * Muster Bridge actions allowed per workflow phase for planner-like turns.
 * Host still intersects with task role capabilities.
 */
export type BridgeActionName =
  | 'create_task'
  | 'delegate_task'
  | 'start_task'
  | 'interrupt_task'
  | 'cancel_task'
  | 'wait_for_tasks'
  | 'get_task_status'
  | 'complete_task'
  | 'fail_task'
  | 'report_progress'
  | 'ask_user'
  | 'submit_decision_brief'
  | 'submit_plan_artifact';

/** Actions always denied during pre-approval planning turns. */
export const PLANNER_DENIED_BRIDGE_ACTIONS: readonly BridgeActionName[] = [
  'start_task',
  'complete_task',
  'fail_task',
  'interrupt_task',
  'cancel_task',
] as const;

/** Phases considered pre-approval (no execution scheduling). */
export const PRE_APPROVAL_PHASES: readonly WorkflowPhase[] = [
  'draft',
  'thinking',
  'planning',
  'awaiting_plan_approval',
] as const;

export function isPreApprovalPhase(phase: WorkflowPhase): boolean {
  return (PRE_APPROVAL_PHASES as readonly string[]).includes(phase);
}

export function bridgeActionsForPhase(phase: WorkflowPhase): Set<BridgeActionName> {
  const base: BridgeActionName[] = [
    'get_task_status',
    'report_progress',
    'ask_user',
  ];
  if (isPreApprovalPhase(phase)) {
    return new Set<BridgeActionName>([
      ...base,
      // create only — never delegate (delegate auto-starts a turn)
      'create_task',
      'submit_decision_brief',
      'submit_plan_artifact',
    ]);
  }
  // Post-approval: full coordinator set minus artifact submit (optional still allowed)
  return new Set<BridgeActionName>([
    'create_task',
    'delegate_task',
    'start_task',
    'interrupt_task',
    'cancel_task',
    'wait_for_tasks',
    'get_task_status',
    'complete_task',
    'fail_task',
    'report_progress',
    'ask_user',
    'submit_decision_brief',
    'submit_plan_artifact',
  ]);
}

// ─── Validators (shape) ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isConfidence(value: unknown): value is ConfidenceLevel {
  return value === 'low' || value === 'medium' || value === 'high';
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorkflowError };

function fail(code: WorkflowErrorCode, message: string, details?: Record<string, unknown>): ValidationResult<never> {
  return { ok: false, error: workflowError(code, message, details) };
}

export function validateEvidenceRef(value: unknown): ValidationResult<EvidenceRef> {
  if (!isRecord(value)) return fail('ARTIFACT_INVALID', 'evidence must be an object');
  if (!isNonEmptyString(value.id)) return fail('ARTIFACT_INVALID', 'evidence.id required');
  const kind = value.kind;
  if (
    kind !== 'command' &&
    kind !== 'test' &&
    kind !== 'review' &&
    kind !== 'file' &&
    kind !== 'log' &&
    kind !== 'user' &&
    kind !== 'other'
  ) {
    return fail('ARTIFACT_INVALID', 'evidence.kind invalid', { kind });
  }
  if (!isNonEmptyString(value.summary)) return fail('ARTIFACT_INVALID', 'evidence.summary required');
  const out: EvidenceRef = {
    id: value.id,
    kind,
    summary: value.summary,
  };
  if (typeof value.excerpt === 'string') out.excerpt = value.excerpt;
  if (typeof value.path === 'string') out.path = value.path;
  if (typeof value.producedAt === 'string') out.producedAt = value.producedAt;
  return { ok: true, value: out };
}

function parseEvidenceList(value: unknown): ValidationResult<EvidenceRef[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return fail('ARTIFACT_INVALID', 'evidence must be an array');
  const out: EvidenceRef[] = [];
  for (const item of value) {
    const parsed = validateEvidenceRef(item);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}

function parseEnvelopeMeta(
  value: Record<string, unknown>,
  kind: ArtifactKind,
): ValidationResult<{
  id: string;
  rootTaskId: string;
  workflowRunId: string;
  producedByTaskId: string;
  producedAt: string;
  consumer: ArtifactEnvelope<ArtifactKind, unknown>['consumer'];
  planRevision?: number;
  producedByTurnId?: string;
}> {
  if (value.contractVersion !== WORKFLOW_CONTRACT_VERSION) {
    return fail('ARTIFACT_INVALID', `contractVersion must be ${WORKFLOW_CONTRACT_VERSION}`, {
      got: value.contractVersion,
    });
  }
  if (value.kind !== kind) {
    return fail('ARTIFACT_INVALID', `kind must be ${kind}`, { got: value.kind });
  }
  if (!isNonEmptyString(value.id)) return fail('ARTIFACT_INVALID', 'id required');
  if (!isNonEmptyString(value.rootTaskId)) return fail('ARTIFACT_INVALID', 'rootTaskId required');
  if (!isNonEmptyString(value.workflowRunId)) return fail('ARTIFACT_INVALID', 'workflowRunId required');
  if (!isNonEmptyString(value.producedByTaskId)) {
    return fail('ARTIFACT_INVALID', 'producedByTaskId required');
  }
  if (!isNonEmptyString(value.producedAt)) return fail('ARTIFACT_INVALID', 'producedAt required');
  const consumer = value.consumer;
  const allowed = ['host', 'user', 'planner', 'executor', 'reviewer', 'tester', 'debugger'] as const;
  if (typeof consumer !== 'string' || !(allowed as readonly string[]).includes(consumer)) {
    return fail('ARTIFACT_INVALID', 'consumer invalid', { consumer });
  }
  const meta: {
    id: string;
    rootTaskId: string;
    workflowRunId: string;
    producedByTaskId: string;
    producedAt: string;
    consumer: ArtifactEnvelope<ArtifactKind, unknown>['consumer'];
    planRevision?: number;
    producedByTurnId?: string;
  } = {
    id: value.id,
    rootTaskId: value.rootTaskId,
    workflowRunId: value.workflowRunId,
    producedByTaskId: value.producedByTaskId,
    producedAt: value.producedAt,
    consumer: consumer as ArtifactEnvelope<ArtifactKind, unknown>['consumer'],
  };
  if (value.planRevision !== undefined) {
    if (typeof value.planRevision !== 'number' || !Number.isInteger(value.planRevision) || value.planRevision < 1) {
      return fail('ARTIFACT_INVALID', 'planRevision must be a positive integer');
    }
    meta.planRevision = value.planRevision;
  }
  if (value.producedByTurnId !== undefined) {
    if (!isNonEmptyString(value.producedByTurnId)) {
      return fail('ARTIFACT_INVALID', 'producedByTurnId must be a non-empty string');
    }
    meta.producedByTurnId = value.producedByTurnId;
  }
  return { ok: true, value: meta };
}

export function validateDecisionBrief(raw: unknown): ValidationResult<DecisionBrief> {
  if (!isRecord(raw)) return fail('ARTIFACT_INVALID', 'decision brief must be an object');
  const meta = parseEnvelopeMeta(raw, 'decision_brief');
  if (!meta.ok) return meta;
  if (!isRecord(raw.body)) return fail('ARTIFACT_INVALID', 'body required');
  const b = raw.body;
  if (!isNonEmptyString(b.goal)) return fail('ARTIFACT_INVALID', 'body.goal required');
  if (!isNonEmptyString(b.problemSummary)) {
    return fail('ARTIFACT_INVALID', 'body.problemSummary required');
  }
  if (!isStringArray(b.constraints)) return fail('ARTIFACT_INVALID', 'body.constraints must be string[]');
  if (!isStringArray(b.openQuestions)) return fail('ARTIFACT_INVALID', 'body.openQuestions must be string[]');
  if (!isStringArray(b.assumptions)) return fail('ARTIFACT_INVALID', 'body.assumptions must be string[]');
  if (!isStringArray(b.risks)) return fail('ARTIFACT_INVALID', 'body.risks must be string[]');
  if (!isNonEmptyString(b.recommendedApproach)) {
    return fail('ARTIFACT_INVALID', 'body.recommendedApproach required');
  }
  if (!Array.isArray(b.alternatives)) return fail('ARTIFACT_INVALID', 'body.alternatives must be an array');
  const alternatives: DecisionBriefBody['alternatives'] = [];
  for (const alt of b.alternatives) {
    if (!isRecord(alt) || !isNonEmptyString(alt.option) || !isNonEmptyString(alt.tradeoff)) {
      return fail('ARTIFACT_INVALID', 'body.alternatives entries need option and tradeoff');
    }
    alternatives.push({ option: alt.option, tradeoff: alt.tradeoff });
  }
  if (!isConfidence(b.confidence)) return fail('ARTIFACT_INVALID', 'body.confidence invalid');
  if (!isStringArray(b.unknowns)) return fail('ARTIFACT_INVALID', 'body.unknowns must be string[]');
  const evidence = parseEvidenceList(b.evidence);
  if (!evidence.ok) return evidence;

  const value: DecisionBrief = {
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    kind: 'decision_brief',
    ...meta.value,
    body: {
      goal: b.goal,
      problemSummary: b.problemSummary,
      constraints: b.constraints,
      openQuestions: b.openQuestions,
      assumptions: b.assumptions,
      risks: b.risks,
      recommendedApproach: b.recommendedApproach,
      alternatives,
      confidence: b.confidence,
      unknowns: b.unknowns,
      evidence: evidence.value,
    },
  };
  return { ok: true, value };
}

function validateProposedTaskNode(value: unknown, index: number): ValidationResult<ProposedTaskNode> {
  if (!isRecord(value)) {
    return fail('PLAN_INVALID', `tasks[${index}] must be an object`);
  }
  if (!isNonEmptyString(value.proposalId)) {
    return fail('PLAN_INVALID', `tasks[${index}].proposalId required`);
  }
  if (!isNonEmptyString(value.goal)) {
    return fail('PLAN_INVALID', `tasks[${index}].goal required`);
  }
  if (value.role !== 'coordinator' && value.role !== 'worker') {
    return fail('PLAN_INVALID', `tasks[${index}].role must be coordinator|worker`);
  }
  if (!isNonEmptyString(value.backend)) {
    return fail('PLAN_INVALID', `tasks[${index}].backend required`);
  }
  if (!isStringArray(value.dependsOn)) {
    return fail('PLAN_INVALID', `tasks[${index}].dependsOn must be string[]`);
  }
  if (!isStringArray(value.acceptanceCriteria) || value.acceptanceCriteria.length === 0) {
    return fail('PLAN_INVALID', `tasks[${index}].acceptanceCriteria required (non-empty)`);
  }
  if (!isStringArray(value.verification) || value.verification.length === 0) {
    return fail('PLAN_INVALID', `tasks[${index}].verification required (non-empty)`);
  }
  const node: ProposedTaskNode = {
    proposalId: value.proposalId,
    goal: value.goal,
    role: value.role,
    backend: value.backend,
    dependsOn: value.dependsOn,
    acceptanceCriteria: value.acceptanceCriteria,
    verification: value.verification,
  };
  if (value.capabilities !== undefined) {
    if (!isStringArray(value.capabilities)) {
      return fail('PLAN_INVALID', `tasks[${index}].capabilities must be string[]`);
    }
    node.capabilities = value.capabilities;
  }
  if (value.model !== undefined) {
    if (!isNonEmptyString(value.model)) {
      return fail('PLAN_INVALID', `tasks[${index}].model must be a non-empty string`);
    }
    node.model = value.model;
  }
  if (value.notes !== undefined) {
    if (typeof value.notes !== 'string') {
      return fail('PLAN_INVALID', `tasks[${index}].notes must be a string`);
    }
    node.notes = value.notes;
  }
  return { ok: true, value: node };
}

export function validatePlanArtifactShape(raw: unknown): ValidationResult<PlanArtifact> {
  if (!isRecord(raw)) return fail('PLAN_INVALID', 'plan must be an object');
  const meta = parseEnvelopeMeta(raw, 'plan');
  if (!meta.ok) return fail('PLAN_INVALID', meta.error.message, meta.error.details);
  if (!isRecord(raw.body)) return fail('PLAN_INVALID', 'body required');
  const b = raw.body;
  if (!isNonEmptyString(b.title)) return fail('PLAN_INVALID', 'body.title required');
  if (!isNonEmptyString(b.summary)) return fail('PLAN_INVALID', 'body.summary required');
  if (!isNonEmptyString(b.goal)) return fail('PLAN_INVALID', 'body.goal required');
  if (typeof b.revision !== 'number' || !Number.isInteger(b.revision) || b.revision < 1) {
    return fail('PLAN_INVALID', 'body.revision must be a positive integer');
  }
  if (!Array.isArray(b.tasks) || b.tasks.length === 0) {
    return fail('PLAN_INVALID', 'body.tasks must be a non-empty array');
  }
  const tasks: ProposedTaskNode[] = [];
  for (let i = 0; i < b.tasks.length; i++) {
    const node = validateProposedTaskNode(b.tasks[i], i);
    if (!node.ok) return node;
    tasks.push(node.value);
  }
  if (!isStringArray(b.acceptanceCriteria) || b.acceptanceCriteria.length === 0) {
    return fail('PLAN_INVALID', 'body.acceptanceCriteria required (non-empty)');
  }
  if (!isStringArray(b.verificationStrategy) || b.verificationStrategy.length === 0) {
    return fail('PLAN_INVALID', 'body.verificationStrategy required (non-empty)');
  }
  if (!isStringArray(b.rollbackNotes)) return fail('PLAN_INVALID', 'body.rollbackNotes must be string[]');
  if (!isStringArray(b.openQuestions)) return fail('PLAN_INVALID', 'body.openQuestions must be string[]');
  if (!isStringArray(b.constraints)) return fail('PLAN_INVALID', 'body.constraints must be string[]');
  if (!isConfidence(b.confidence)) return fail('PLAN_INVALID', 'body.confidence invalid');
  if (!isStringArray(b.unknowns)) return fail('PLAN_INVALID', 'body.unknowns must be string[]');
  const evidence = parseEvidenceList(b.evidence);
  if (!evidence.ok) return fail('PLAN_INVALID', evidence.error.message, evidence.error.details);

  const body: PlanArtifactBody = {
    title: b.title,
    summary: b.summary,
    goal: b.goal,
    revision: b.revision,
    tasks,
    acceptanceCriteria: b.acceptanceCriteria,
    verificationStrategy: b.verificationStrategy,
    rollbackNotes: b.rollbackNotes,
    openQuestions: b.openQuestions,
    constraints: b.constraints,
    confidence: b.confidence,
    unknowns: b.unknowns,
    evidence: evidence.value,
  };
  if (b.revisesRevision !== undefined) {
    if (typeof b.revisesRevision !== 'number' || !Number.isInteger(b.revisesRevision) || b.revisesRevision < 1) {
      return fail('PLAN_INVALID', 'body.revisesRevision must be a positive integer');
    }
    body.revisesRevision = b.revisesRevision;
  }
  if (b.decisionBriefId !== undefined) {
    if (!isNonEmptyString(b.decisionBriefId)) {
      return fail('PLAN_INVALID', 'body.decisionBriefId must be a non-empty string');
    }
    body.decisionBriefId = b.decisionBriefId;
  }

  return {
    ok: true,
    value: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      kind: 'plan',
      ...meta.value,
      body,
    },
  };
}

// ─── Semantic plan validation ───────────────────────────────────────────────

export interface PlanSemanticContext {
  /** Known backend ids (e.g. BACKEND_IDS). */
  knownBackends: ReadonlySet<string> | readonly string[];
  /** Existing proposal ids already materialised (optional collision check). */
  reservedTaskIds?: ReadonlySet<string>;
}

export interface PlanSemanticIssue {
  path: string;
  message: string;
}

/**
 * Semantic checks beyond JSON shape: stable unique IDs, acyclic dependsOn,
 * known backends, acceptance/verification present (already shape-checked).
 */
export function validatePlanSemantics(
  plan: PlanArtifact,
  ctx: PlanSemanticContext,
): ValidationResult<PlanArtifact> {
  const issues: PlanSemanticIssue[] = [];
  const backends =
    ctx.knownBackends instanceof Set
      ? ctx.knownBackends
      : new Set(ctx.knownBackends);

  const ids = new Set<string>();
  for (const task of plan.body.tasks) {
    if (ids.has(task.proposalId)) {
      issues.push({ path: `tasks.${task.proposalId}`, message: 'duplicate proposalId' });
    }
    ids.add(task.proposalId);
    if (ctx.reservedTaskIds?.has(task.proposalId)) {
      issues.push({
        path: `tasks.${task.proposalId}`,
        message: 'proposalId collides with reserved task id',
      });
    }
    if (!backends.has(task.backend)) {
      issues.push({
        path: `tasks.${task.proposalId}.backend`,
        message: `unknown backend '${task.backend}'`,
      });
    }
    for (const dep of task.dependsOn) {
      if (!ids.has(dep) && !plan.body.tasks.some((t) => t.proposalId === dep)) {
        // deferred — full set after loop
      }
    }
  }

  // Resolve dependsOn against full id set
  for (const task of plan.body.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        issues.push({
          path: `tasks.${task.proposalId}.dependsOn`,
          message: `unknown dependency '${dep}'`,
        });
      }
      if (dep === task.proposalId) {
        issues.push({
          path: `tasks.${task.proposalId}.dependsOn`,
          message: 'self-dependency is not allowed',
        });
      }
    }
  }

  // Cycle detection (Kahn)
  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    edges.set(id, []);
  }
  for (const task of plan.body.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) continue;
      edges.get(dep)!.push(task.proposalId);
      indegree.set(task.proposalId, (indegree.get(task.proposalId) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen += 1;
    for (const next of edges.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (seen !== ids.size) {
    issues.push({ path: 'tasks', message: 'dependency graph contains a cycle' });
  }

  if (issues.length > 0) {
    return fail('PLAN_INVALID', 'plan failed semantic validation', { issues });
  }
  return { ok: true, value: plan };
}

/** Shape + semantic validation in one step. */
export function validatePlanArtifact(
  raw: unknown,
  ctx: PlanSemanticContext,
): ValidationResult<PlanArtifact> {
  const shape = validatePlanArtifactShape(raw);
  if (!shape.ok) return shape;
  return validatePlanSemantics(shape.value, ctx);
}

// ─── Report validators (shared shape helpers) ───────────────────────────────

export function validateTestReport(raw: unknown): ValidationResult<TestReport> {
  if (!isRecord(raw)) return fail('ARTIFACT_INVALID', 'test report must be an object');
  const meta = parseEnvelopeMeta(raw, 'test_report');
  if (!meta.ok) return meta;
  if (!isRecord(raw.body)) return fail('ARTIFACT_INVALID', 'body required');
  const b = raw.body;
  if (!isNonEmptyString(b.scope)) return fail('ARTIFACT_INVALID', 'body.scope required');
  if (!isStringArray(b.commands)) return fail('ARTIFACT_INVALID', 'body.commands must be string[]');
  if (typeof b.passed !== 'boolean') return fail('ARTIFACT_INVALID', 'body.passed must be boolean');
  if (!isNonEmptyString(b.summary)) return fail('ARTIFACT_INVALID', 'body.summary required');
  if (!Array.isArray(b.failures)) return fail('ARTIFACT_INVALID', 'body.failures must be an array');
  const failures: TestReportBody['failures'] = [];
  for (const f of b.failures) {
    if (!isRecord(f) || !isNonEmptyString(f.name) || !isNonEmptyString(f.detail)) {
      return fail('ARTIFACT_INVALID', 'failures entries need name and detail');
    }
    failures.push({ name: f.name, detail: f.detail });
  }
  if (!isConfidence(b.confidence)) return fail('ARTIFACT_INVALID', 'body.confidence invalid');
  if (!isStringArray(b.unknowns)) return fail('ARTIFACT_INVALID', 'body.unknowns must be string[]');
  if (!isStringArray(b.residualRisks)) {
    return fail('ARTIFACT_INVALID', 'body.residualRisks must be string[]');
  }
  const evidence = parseEvidenceList(b.evidence);
  if (!evidence.ok) return evidence;
  return {
    ok: true,
    value: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      kind: 'test_report',
      ...meta.value,
      body: {
        scope: b.scope,
        commands: b.commands,
        passed: b.passed,
        summary: b.summary,
        failures,
        evidence: evidence.value,
        confidence: b.confidence,
        unknowns: b.unknowns,
        residualRisks: b.residualRisks,
      },
    },
  };
}

export function validateReviewReport(raw: unknown): ValidationResult<ReviewReport> {
  if (!isRecord(raw)) return fail('ARTIFACT_INVALID', 'review report must be an object');
  const meta = parseEnvelopeMeta(raw, 'review_report');
  if (!meta.ok) return meta;
  if (!isRecord(raw.body)) return fail('ARTIFACT_INVALID', 'body required');
  const b = raw.body;
  if (!isNonEmptyString(b.scope)) return fail('ARTIFACT_INVALID', 'body.scope required');
  if (!isNonEmptyString(b.summary)) return fail('ARTIFACT_INVALID', 'body.summary required');
  if (
    b.recommendation !== 'approve' &&
    b.recommendation !== 'request_changes' &&
    b.recommendation !== 'block'
  ) {
    return fail('ARTIFACT_INVALID', 'body.recommendation invalid');
  }
  if (!isConfidence(b.confidence)) return fail('ARTIFACT_INVALID', 'body.confidence invalid');
  if (!isStringArray(b.unknowns)) return fail('ARTIFACT_INVALID', 'body.unknowns must be string[]');
  if (!isStringArray(b.residualRisks)) {
    return fail('ARTIFACT_INVALID', 'body.residualRisks must be string[]');
  }
  if (!Array.isArray(b.findings)) return fail('ARTIFACT_INVALID', 'body.findings must be an array');
  const findings: ReviewFinding[] = [];
  for (const f of b.findings) {
    if (!isRecord(f)) return fail('ARTIFACT_INVALID', 'finding must be an object');
    if (f.severity !== 'info' && f.severity !== 'warning' && f.severity !== 'error') {
      return fail('ARTIFACT_INVALID', 'finding.severity invalid');
    }
    if (!isNonEmptyString(f.title) || !isNonEmptyString(f.detail)) {
      return fail('ARTIFACT_INVALID', 'finding needs title and detail');
    }
    const finding: ReviewFinding = {
      severity: f.severity,
      title: f.title,
      detail: f.detail,
    };
    if (typeof f.path === 'string') finding.path = f.path;
    findings.push(finding);
  }
  const evidence = parseEvidenceList(b.evidence);
  if (!evidence.ok) return evidence;
  return {
    ok: true,
    value: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      kind: 'review_report',
      ...meta.value,
      body: {
        scope: b.scope,
        summary: b.summary,
        findings,
        recommendation: b.recommendation,
        evidence: evidence.value,
        confidence: b.confidence,
        unknowns: b.unknowns,
        residualRisks: b.residualRisks,
      },
    },
  };
}

export function validateVerificationReport(raw: unknown): ValidationResult<VerificationReport> {
  if (!isRecord(raw)) return fail('ARTIFACT_INVALID', 'verification report must be an object');
  const meta = parseEnvelopeMeta(raw, 'verification_report');
  if (!meta.ok) return meta;
  if (!isRecord(raw.body)) return fail('ARTIFACT_INVALID', 'body required');
  const b = raw.body;
  if (!Array.isArray(b.checks) || b.checks.length === 0) {
    return fail('EVIDENCE_MISSING', 'body.checks required (non-empty)');
  }
  const checks: VerificationReportBody['checks'] = [];
  for (const c of b.checks) {
    if (!isRecord(c) || !isNonEmptyString(c.name) || typeof c.passed !== 'boolean' || !isNonEmptyString(c.detail)) {
      return fail('ARTIFACT_INVALID', 'checks need name, passed, detail');
    }
    const check: VerificationReportBody['checks'][number] = {
      name: c.name,
      passed: c.passed,
      detail: c.detail,
    };
    if (typeof c.command === 'string') check.command = c.command;
    checks.push(check);
  }
  if (typeof b.overallPassed !== 'boolean') {
    return fail('ARTIFACT_INVALID', 'body.overallPassed must be boolean');
  }
  if (!isNonEmptyString(b.summary)) return fail('ARTIFACT_INVALID', 'body.summary required');
  if (!isConfidence(b.confidence)) return fail('ARTIFACT_INVALID', 'body.confidence invalid');
  if (!isStringArray(b.unknowns)) return fail('ARTIFACT_INVALID', 'body.unknowns must be string[]');
  if (!isStringArray(b.residualRisks)) {
    return fail('ARTIFACT_INVALID', 'body.residualRisks must be string[]');
  }
  const evidence = parseEvidenceList(b.evidence);
  if (!evidence.ok) return evidence;
  if (b.overallPassed && evidence.value.length === 0) {
    return fail('EVIDENCE_MISSING', 'verified success requires recorded evidence');
  }
  return {
    ok: true,
    value: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      kind: 'verification_report',
      ...meta.value,
      body: {
        checks,
        overallPassed: b.overallPassed,
        summary: b.summary,
        evidence: evidence.value,
        confidence: b.confidence,
        unknowns: b.unknowns,
        residualRisks: b.residualRisks,
      },
    },
  };
}

export function validateDebugReport(raw: unknown): ValidationResult<DebugReport> {
  if (!isRecord(raw)) return fail('ARTIFACT_INVALID', 'debug report must be an object');
  const meta = parseEnvelopeMeta(raw, 'debug_report');
  if (!meta.ok) return meta;
  if (!isRecord(raw.body)) return fail('ARTIFACT_INVALID', 'body required');
  const b = raw.body;
  if (!isNonEmptyString(b.symptom)) return fail('ARTIFACT_INVALID', 'body.symptom required');
  if (!Array.isArray(b.attempts)) return fail('ARTIFACT_INVALID', 'body.attempts must be an array');
  const attempts: DebugReportBody['attempts'] = [];
  for (const a of b.attempts) {
    if (!isRecord(a) || !isNonEmptyString(a.action) || !isNonEmptyString(a.result)) {
      return fail('ARTIFACT_INVALID', 'attempts need action and result');
    }
    attempts.push({ action: a.action, result: a.result });
  }
  if (!isConfidence(b.confidence)) return fail('ARTIFACT_INVALID', 'body.confidence invalid');
  if (!isNonEmptyString(b.nextStep)) return fail('ARTIFACT_INVALID', 'body.nextStep required');
  if (!isStringArray(b.unknowns)) return fail('ARTIFACT_INVALID', 'body.unknowns must be string[]');
  if (typeof b.retryable !== 'boolean') return fail('ARTIFACT_INVALID', 'body.retryable must be boolean');
  const evidence = parseEvidenceList(b.evidence);
  if (!evidence.ok) return evidence;
  const body: DebugReportBody = {
    symptom: b.symptom,
    attempts,
    confidence: b.confidence,
    nextStep: b.nextStep,
    evidence: evidence.value,
    unknowns: b.unknowns,
    retryable: b.retryable,
  };
  if (b.rootCause !== undefined) {
    if (!isNonEmptyString(b.rootCause)) {
      return fail('ARTIFACT_INVALID', 'body.rootCause must be a non-empty string when present');
    }
    body.rootCause = b.rootCause;
  }
  return {
    ok: true,
    value: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      kind: 'debug_report',
      ...meta.value,
      body,
    },
  };
}

export function validateTaskHandoff(raw: unknown): ValidationResult<TaskHandoff> {
  if (!isRecord(raw)) return fail('ARTIFACT_INVALID', 'task handoff must be an object');
  const meta = parseEnvelopeMeta(raw, 'task_handoff');
  if (!meta.ok) return meta;
  if (!isRecord(raw.body)) return fail('ARTIFACT_INVALID', 'body required');
  const b = raw.body;
  if (!isNonEmptyString(b.goal)) return fail('ARTIFACT_INVALID', 'body.goal required');
  if (!isStringArray(b.constraints)) return fail('ARTIFACT_INVALID', 'body.constraints must be string[]');
  if (!isStringArray(b.allowedActions)) {
    return fail('ARTIFACT_INVALID', 'body.allowedActions must be string[]');
  }
  if (!isNonEmptyString(b.outputContract)) {
    return fail('ARTIFACT_INVALID', 'body.outputContract required');
  }
  if (!isStringArray(b.acceptanceCriteria) || b.acceptanceCriteria.length === 0) {
    return fail('ARTIFACT_INVALID', 'body.acceptanceCriteria required (non-empty)');
  }
  if (!Array.isArray(b.evidenceRefs)) {
    return fail('ARTIFACT_INVALID', 'body.evidenceRefs must be an array');
  }
  const evidenceRefs: ProvenanceRef[] = [];
  for (const ref of b.evidenceRefs) {
    if (!isRecord(ref) || !isNonEmptyString(ref.artifactId)) {
      return fail('ARTIFACT_INVALID', 'evidenceRefs need artifactId');
    }
    const pr: ProvenanceRef = { artifactId: ref.artifactId };
    if (typeof ref.label === 'string') pr.label = ref.label;
    if (typeof ref.producedByTaskId === 'string') pr.producedByTaskId = ref.producedByTaskId;
    if (typeof ref.producedByTurnId === 'string') pr.producedByTurnId = ref.producedByTurnId;
    evidenceRefs.push(pr);
  }
  const body: TaskHandoffBody = {
    goal: b.goal,
    constraints: b.constraints,
    allowedActions: b.allowedActions,
    outputContract: b.outputContract,
    evidenceRefs,
    acceptanceCriteria: b.acceptanceCriteria,
  };
  if (typeof b.childProposalId === 'string') body.childProposalId = b.childProposalId;
  if (typeof b.childTaskId === 'string') body.childTaskId = b.childTaskId;
  if (typeof b.notes === 'string') body.notes = b.notes;
  return {
    ok: true,
    value: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      kind: 'task_handoff',
      ...meta.value,
      body,
    },
  };
}

export function validateWorkflowOutcomeProposal(
  raw: unknown,
): ValidationResult<WorkflowOutcomeProposal> {
  if (!isRecord(raw)) return fail('ARTIFACT_INVALID', 'outcome proposal must be an object');
  const meta = parseEnvelopeMeta(raw, 'outcome_proposal');
  if (!meta.ok) return meta;
  if (!isRecord(raw.body)) return fail('ARTIFACT_INVALID', 'body required');
  const b = raw.body;
  if (b.kind !== 'complete' && b.kind !== 'fail') {
    return fail('ARTIFACT_INVALID', 'body.kind must be complete|fail');
  }
  if (!isNonEmptyString(b.summary)) return fail('ARTIFACT_INVALID', 'body.summary required');
  if (!isConfidence(b.confidence)) return fail('ARTIFACT_INVALID', 'body.confidence invalid');
  if (!isStringArray(b.residualRisks)) {
    return fail('ARTIFACT_INVALID', 'body.residualRisks must be string[]');
  }
  if (!Array.isArray(b.evidenceRefs)) {
    return fail('ARTIFACT_INVALID', 'body.evidenceRefs must be an array');
  }
  const evidenceRefs: ProvenanceRef[] = [];
  for (const ref of b.evidenceRefs) {
    if (!isRecord(ref) || !isNonEmptyString(ref.artifactId)) {
      return fail('ARTIFACT_INVALID', 'evidenceRefs need artifactId');
    }
    evidenceRefs.push({ artifactId: ref.artifactId });
  }
  if (b.kind === 'complete' && evidenceRefs.length === 0) {
    return fail('EVIDENCE_MISSING', 'complete proposal requires evidence references');
  }
  const body: WorkflowOutcomeProposalBody = {
    kind: b.kind,
    summary: b.summary,
    evidenceRefs,
    residualRisks: b.residualRisks,
    confidence: b.confidence,
  };
  if (typeof b.result === 'string') body.result = b.result;
  if (typeof b.error === 'string') body.error = b.error;
  return {
    ok: true,
    value: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      kind: 'outcome_proposal',
      ...meta.value,
      body,
    },
  };
}

/** Lookup command meta by id or alias. */
export function findCommandSpec(name: string): CommandSpecMeta | undefined {
  const lower = name.toLowerCase();
  return NATIVE_COMMAND_SPECS.find(
    (s) => s.id === lower || s.aliases.some((a) => a === lower),
  );
}

export function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  return typeof value === 'string' && (WORKFLOW_PHASES as readonly string[]).includes(value);
}
