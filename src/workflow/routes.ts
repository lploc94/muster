/**
 * Native workflow command routes: implement/test/review/debug/verify/finish.
 * Host-side orchestration stubs that stage artifacts and phase transitions.
 */

import { randomUUID } from 'crypto';
import { BACKEND_IDS } from '../backends';
import type { TaskStoreFile } from '../task/types';
import type { CommandRequest, CommandResult } from '../commands/types';
import {
  WORKFLOW_CONTRACT_VERSION,
  workflowError,
  type WorkflowPhase,
} from './contracts';
import {
  archiveWorkflowRun,
  attachArtifact,
  getWorkflowRunForRoot,
  stagePlanForApproval,
  transitionWorkflowPhase,
} from './store';
import type { PlanArtifact } from './contracts';
import { buildContextReport } from './context';
import { compactWorkflowTranscript } from './compact';
import { exportWorkflowJson, exportWorkflowMarkdown } from './export';
import {
  debugRolePreamble,
  implementHandoffPreamble,
  reviewRolePreamble,
  testRolePreamble,
  verifyRolePreamble,
} from './prompts';
import {
  defaultVerificationSelection,
  discoverPackageScripts,
} from './verification-discovery';

const KNOWN_BACKENDS = new Set<string>(BACKEND_IDS);
const PRE_EXECUTION_PHASES: WorkflowPhase[] = ['draft', 'thinking', 'planning', 'awaiting_plan_approval'];
const ACTIVE_TURN_STATUSES = new Set(['queued', 'running', 'waiting_user']);

function hasActiveTurn(file: TaskStoreFile, taskId: string): boolean {
  return Object.values(file.turns).some(
    (turn) => turn.taskId === taskId && ACTIVE_TURN_STATUSES.has(turn.status),
  );
}

function commandError(
  commandId: CommandRequest['commandId'],
  code: Parameters<typeof workflowError>[0],
  message: string,
  details?: Record<string, unknown>,
): CommandResult {
  return {
    ok: false,
    commandId,
    error: workflowError(code, message, details),
    presenter: 'error',
  };
}

function phaseOk(
  file: TaskStoreFile,
  rootTaskId: string,
  allowed: WorkflowPhase[],
): { ok: true; workflowRunId: string; phase: WorkflowPhase } | { ok: false; result: CommandResult } {
  const run = getWorkflowRunForRoot(file, rootTaskId);
  if (!run) {
    return {
      ok: false,
      result: {
        ok: false,
        error: workflowError('NOT_FOUND', 'workflow run not found'),
        presenter: 'error',
      },
    };
  }
  if (!allowed.includes(run.phase)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: workflowError(
          'COMMAND_PHASE',
          `phase '${run.phase}' does not allow this command`,
          { phase: run.phase, allowed },
        ),
        presenter: 'error',
      },
    };
  }
  return { ok: true, workflowRunId: run.id, phase: run.phase };
}

function transitionIfNeeded(
  draft: TaskStoreFile,
  workflowRunId: string,
  phase: WorkflowPhase,
  to: WorkflowPhase,
  now: string,
): CommandResult | undefined {
  if (phase === to) return undefined;
  const transitioned = transitionWorkflowPhase(draft, {
    workflowRunId,
    to,
    now,
  });
  if (!transitioned.ok) {
    return {
      ok: false,
      error: transitioned.error,
      presenter: 'error',
    };
  }
  return undefined;
}

export function routeThink(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, ['draft', 'thinking', 'planning', 'awaiting_plan_approval']);
  if (!gate.ok) return { ...gate.result, commandId: 'think' };
  const phaseError = transitionIfNeeded(draft, gate.workflowRunId, gate.phase, 'thinking', now);
  if (phaseError) return { ...phaseError, commandId: 'think' };
  const root = draft.tasks[rootTaskId];
  const goal = request.rawArgs || root?.goal || 'focused task';
  const artifactId = randomUUID();
  attachArtifact(draft, {
    id: artifactId,
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    kind: 'decision_brief',
    rootTaskId,
    workflowRunId: gate.workflowRunId,
    producedByTaskId: rootTaskId,
    producedAt: now,
    consumer: 'planner',
    body: {
      goal,
      problemSummary: `Decision brief for ${goal}`,
      constraints: ['Do not modify files during thinking.'],
      openQuestions: [],
      assumptions: ['The focused task describes the intended work.'],
      risks: ['Implementation details still need plan approval.'],
      recommendedApproach: 'Create a plan artifact before execution.',
      alternatives: [
        {
          option: 'Answer directly',
          tradeoff: 'Appropriate only for non-task chat, not workflow execution.',
        },
      ],
      confidence: 'medium',
      unknowns: [],
      evidence: [
        {
          id: `command:${artifactId}`,
          kind: 'command',
          summary: '/think command created this decision brief',
          producedAt: now,
        },
      ],
    },
  });
  return {
    ok: true,
    commandId: 'think',
    effectClass: 'mutate_plan',
    presenter: 'plan_card',
    message: 'Decision brief created',
    data: { artifactId, phase: 'thinking' },
  };
}

export function routePlan(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, ['draft', 'thinking', 'planning', 'awaiting_plan_approval']);
  if (!gate.ok) return { ...gate.result, commandId: 'plan' };
  const phaseError = transitionIfNeeded(draft, gate.workflowRunId, gate.phase, 'planning', now);
  if (phaseError) return { ...phaseError, commandId: 'plan' };
  const root = draft.tasks[rootTaskId];
  const run = getWorkflowRunForRoot(draft, rootTaskId);
  if (!run) {
    return commandError('plan', 'NOT_FOUND', 'workflow run not found');
  }
  const revision = run.planRevision + 1;
  const artifactId = randomUUID();
  const goal = request.rawArgs || root?.goal || 'focused task';
  const currentDecisionBriefId = run.currentDecisionBriefId;
  const plan: PlanArtifact = {
    id: artifactId,
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    kind: 'plan',
    rootTaskId,
    workflowRunId: gate.workflowRunId,
    planRevision: revision,
    producedByTaskId: rootTaskId,
    producedAt: now,
    consumer: 'planner',
    body: {
      title: `Plan for ${goal}`,
      summary: 'Native Muster plan generated from the focused workflow command.',
      goal,
      revision,
      ...(revision > 1 ? { revisesRevision: revision - 1 } : {}),
      ...(currentDecisionBriefId ? { decisionBriefId: currentDecisionBriefId } : {}),
      tasks: [
        {
          proposalId: 'implement',
          goal: `Implement: ${goal}`,
          role: 'worker',
          backend: root?.backend ?? 'claude',
          ...(root?.model ? { model: root.model } : {}),
          dependsOn: [],
          acceptanceCriteria: ['Implementation matches the approved plan goal.'],
          verification: ['Run /test, /review, and /verify before /finish.'],
        },
      ],
      acceptanceCriteria: ['A user can approve the plan before execution starts.'],
      verificationStrategy: ['Use native slash command verification stages.'],
      rollbackNotes: ['Archive or replan the workflow; do not delete task data.'],
      openQuestions: [],
      constraints: ['No implementation runs before /approve.'],
      confidence: 'medium',
      unknowns: [],
      evidence: [
        {
          id: `command:${artifactId}`,
          kind: 'command',
          summary: '/plan command created this plan artifact',
          producedAt: now,
        },
      ],
    },
  };
  const staged = stagePlanForApproval(draft, {
    workflowRunId: gate.workflowRunId,
    plan,
    now,
  });
  if (!staged.ok) {
    return {
      ok: false,
      commandId: 'plan',
      error: staged.error,
      presenter: 'error',
    };
  }
  return {
    ok: true,
    commandId: 'plan',
    effectClass: 'mutate_plan',
    presenter: 'plan_card',
    message: 'Plan ready for approval',
    data: { artifactId, phase: 'awaiting_plan_approval', revision },
  };
}

export function routeImplement(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, ['approved', 'implementing', 'debugging']);
  if (!gate.ok) return gate.result;
  const phaseError = transitionIfNeeded(draft, gate.workflowRunId, gate.phase, 'implementing', now);
  if (phaseError) return { ...phaseError, commandId: 'implement' };
  const root = draft.tasks[rootTaskId];
  const handoff = implementHandoffPreamble({
    goal: root?.goal ?? (request.rawArgs || 'implement approved plan'),
    constraints: [],
    acceptanceCriteria: ['matches approved plan'],
  });
  return {
    ok: true,
    commandId: 'implement',
    effectClass: 'mutate_execution',
    presenter: 'message',
    message: 'Implementation phase active',
    data: { handoff, phase: 'implementing' },
  };
}

export function routeTest(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
  cwd?: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, [
    'implementing',
    'testing',
    'reviewing',
    'debugging',
    'verifying',
  ]);
  if (!gate.ok) return gate.result;
  const phaseError = transitionIfNeeded(draft, gate.workflowRunId, gate.phase, 'testing', now);
  if (phaseError) return { ...phaseError, commandId: 'test' };
  const checks = cwd ? discoverPackageScripts(cwd) : [];
  const selected = defaultVerificationSelection(checks);
  const artifactId = randomUUID();
  attachArtifact(draft, {
    id: artifactId,
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    kind: 'test_report',
    rootTaskId,
    workflowRunId: gate.workflowRunId,
    producedByTaskId: rootTaskId,
    producedAt: now,
    consumer: 'tester',
    body: {
      scope: request.rawArgs || 'default',
      commands: selected.map((c) => c.command),
      passed: false,
      summary: 'Test run staged — execute declared checks and update evidence',
      failures: [],
      evidence: [],
      confidence: 'low',
      unknowns: selected.length === 0 ? ['no package scripts discovered'] : [],
      residualRisks: [],
    },
  });
  return {
    ok: true,
    commandId: 'test',
    effectClass: 'mutate_execution',
    presenter: 'message',
    message: testRolePreamble(request.rawArgs || 'default'),
    data: { artifactId, checks: selected, phase: 'testing' },
  };
}

export function routeReview(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, [
    'implementing',
    'testing',
    'reviewing',
    'debugging',
    'verifying',
  ]);
  if (!gate.ok) return gate.result;
  const phaseError = transitionIfNeeded(draft, gate.workflowRunId, gate.phase, 'reviewing', now);
  if (phaseError) return { ...phaseError, commandId: 'review' };
  const artifactId = randomUUID();
  attachArtifact(draft, {
    id: artifactId,
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    kind: 'review_report',
    rootTaskId,
    workflowRunId: gate.workflowRunId,
    producedByTaskId: rootTaskId,
    producedAt: now,
    consumer: 'reviewer',
    body: {
      scope: request.rawArgs || 'diff',
      summary: 'Review staged',
      findings: [],
      recommendation: 'request_changes',
      evidence: [],
      confidence: 'low',
      unknowns: ['awaiting reviewer agent'],
      residualRisks: [],
    },
  });
  return {
    ok: true,
    commandId: 'review',
    effectClass: 'mutate_execution',
    presenter: 'message',
    message: reviewRolePreamble(request.rawArgs || 'diff'),
    data: { artifactId, phase: 'reviewing' },
  };
}

export function routeDebug(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, [
    'implementing',
    'testing',
    'reviewing',
    'debugging',
    'verifying',
    'finishing',
  ]);
  if (!gate.ok) return gate.result;
  const phaseError = transitionIfNeeded(draft, gate.workflowRunId, gate.phase, 'debugging', now);
  if (phaseError) return { ...phaseError, commandId: 'debug' };
  const symptom = request.rawArgs || 'unspecified failure';
  const artifactId = randomUUID();
  attachArtifact(draft, {
    id: artifactId,
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    kind: 'debug_report',
    rootTaskId,
    workflowRunId: gate.workflowRunId,
    producedByTaskId: rootTaskId,
    producedAt: now,
    consumer: 'debugger',
    body: {
      symptom,
      attempts: [],
      confidence: 'low',
      nextStep: 'investigate',
      evidence: [],
      unknowns: [],
      retryable: true,
    },
  });
  return {
    ok: true,
    commandId: 'debug',
    effectClass: 'mutate_execution',
    presenter: 'message',
    message: debugRolePreamble(symptom),
    data: { artifactId, phase: 'debugging', retryable: true },
  };
}

export function routeVerify(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
  cwd?: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, [
    'implementing',
    'testing',
    'reviewing',
    'debugging',
    'verifying',
  ]);
  if (!gate.ok) return gate.result;
  const phaseError = transitionIfNeeded(draft, gate.workflowRunId, gate.phase, 'verifying', now);
  if (phaseError) return { ...phaseError, commandId: 'verify' };
  const checks = cwd ? defaultVerificationSelection(discoverPackageScripts(cwd)) : [];
  const artifactId = randomUUID();
  // Staged report is not overallPassed — evidence required for success claims
  attachArtifact(draft, {
    id: artifactId,
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    kind: 'verification_report',
    rootTaskId,
    workflowRunId: gate.workflowRunId,
    producedByTaskId: rootTaskId,
    producedAt: now,
    consumer: 'host',
    body: {
      checks: checks.map((c) => ({
        name: c.name,
        command: c.command,
        passed: false,
        detail: 'pending',
      })),
      overallPassed: false,
      summary: 'Verification staged — run declared checks and attach evidence',
      evidence: [],
      confidence: 'low',
      unknowns: checks.length === 0 ? ['no checks discovered'] : [],
      residualRisks: [],
    },
  });
  return {
    ok: true,
    commandId: 'verify',
    effectClass: 'mutate_execution',
    presenter: 'message',
    message: verifyRolePreamble(),
    data: { artifactId, checks, phase: 'verifying' },
  };
}

export function routeFinish(
  draft: TaskStoreFile,
  _request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, [
    'verifying',
    'finishing',
    'reviewing',
    'testing',
    'implementing',
  ]);
  if (!gate.ok) return gate.result;
  const phaseError = transitionIfNeeded(draft, gate.workflowRunId, gate.phase, 'finishing', now);
  if (phaseError) return { ...phaseError, commandId: 'finish' };

  // Collect evidence refs from existing artifacts
  const artifacts = Object.values(draft.workflowArtifacts ?? {}).filter(
    (a) => a.workflowRunId === gate.workflowRunId,
  );
  const evidenceRefs = artifacts
    .filter((a) =>
      ['test_report', 'review_report', 'verification_report', 'plan'].includes(a.kind),
    )
    .map((a) => ({ artifactId: a.id }));

  if (evidenceRefs.length === 0) {
    return {
      ok: false,
      commandId: 'finish',
      error: workflowError('EVIDENCE_MISSING', 'cannot finish without plan/test/review/verify artifacts'),
      presenter: 'error',
    };
  }

  const artifactId = randomUUID();
  attachArtifact(draft, {
    id: artifactId,
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    kind: 'outcome_proposal',
    rootTaskId,
    workflowRunId: gate.workflowRunId,
    producedByTaskId: rootTaskId,
    producedAt: now,
    consumer: 'user',
    body: {
      kind: 'complete',
      summary: 'Ready for user outcome seal',
      evidenceRefs,
      residualRisks: [],
      confidence: 'medium',
    },
  });

  // Stage lifecycle proposal on root without sealing
  const root = draft.tasks[rootTaskId];
  if (root && root.lifecycle === 'open') {
    draft.tasks[rootTaskId] = {
      ...root,
      outcomeProposal: {
        kind: 'complete',
        result: 'Workflow finish staged — accept to seal lifecycle',
        proposedByTurnId: 'workflow-finish',
        proposedAt: now,
      },
      revision: root.revision + 1,
      updatedAt: now,
    };
  }

  return {
    ok: true,
    commandId: 'finish',
    effectClass: 'mutate_lifecycle',
    presenter: 'message',
    message: 'Outcome proposal staged (lifecycle not sealed)',
    data: { artifactId, evidenceRefs, phase: 'finishing' },
  };
}

export function routeBackend(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const backend = request.argv[0];
  if (!backend) {
    return commandError('backend', 'COMMAND_ARGS', '/backend requires a backend id');
  }
  if (!KNOWN_BACKENDS.has(backend)) {
    return commandError('backend', 'COMMAND_ARGS', `Unknown backend '${backend}'`, {
      knownBackends: [...KNOWN_BACKENDS],
    });
  }
  const gate = phaseOk(draft, rootTaskId, PRE_EXECUTION_PHASES);
  if (!gate.ok) return { ...gate.result, commandId: 'backend' };
  if (hasActiveTurn(draft, rootTaskId)) {
    return commandError('backend', 'TRANSITION_DENIED', '/backend requires the root task to be idle');
  }
  const root = draft.tasks[rootTaskId];
  if (!root) {
    return commandError('backend', 'NOT_FOUND', 'root task not found');
  }
  draft.tasks[rootTaskId] = {
    ...root,
    backend,
    revision: root.revision + 1,
    updatedAt: now,
  };
  return {
    ok: true,
    commandId: 'backend',
    effectClass: 'mutate_store',
    presenter: 'message',
    message: `Backend set to ${backend}`,
    data: { taskId: rootTaskId, backend },
  };
}

export function routeModel(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const model = request.argv[0];
  if (!model) {
    return commandError('model', 'COMMAND_ARGS', '/model requires a model id');
  }
  const gate = phaseOk(draft, rootTaskId, PRE_EXECUTION_PHASES);
  if (!gate.ok) return { ...gate.result, commandId: 'model' };
  if (hasActiveTurn(draft, rootTaskId)) {
    return commandError('model', 'TRANSITION_DENIED', '/model requires the root task to be idle');
  }
  const root = draft.tasks[rootTaskId];
  if (!root) {
    return commandError('model', 'NOT_FOUND', 'root task not found');
  }
  const next = model === 'auto' || model === 'default'
    ? { ...root, model: undefined }
    : { ...root, model };
  draft.tasks[rootTaskId] = {
    ...next,
    revision: root.revision + 1,
    updatedAt: now,
  };
  return {
    ok: true,
    commandId: 'model',
    effectClass: 'mutate_store',
    presenter: 'message',
    message: next.model ? `Model set to ${next.model}` : 'Model reset to backend default',
    data: { taskId: rootTaskId, model: next.model },
  };
}

export function dispatchWorkflowRoute(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
  cwd?: string,
): CommandResult {
  switch (request.commandId) {
    case 'implement':
      return routeImplement(draft, request, rootTaskId, now);
    case 'test':
      return routeTest(draft, request, rootTaskId, now, cwd);
    case 'review':
      return routeReview(draft, request, rootTaskId, now);
    case 'debug':
      return routeDebug(draft, request, rootTaskId, now);
    case 'verify':
      return routeVerify(draft, request, rootTaskId, now, cwd);
    case 'finish':
      return routeFinish(draft, request, rootTaskId, now);
    case 'backend':
      return routeBackend(draft, request, rootTaskId, now);
    case 'model':
      return routeModel(draft, request, rootTaskId, now);
    case 'fork':
      return commandError('fork', 'COMMAND_ARGS', '/fork is not implemented yet');
    case 'retry':
      return commandError('retry', 'COMMAND_ARGS', '/retry is not implemented yet');
    case 'think':
      return routeThink(draft, request, rootTaskId, now);
    case 'plan':
      return routePlan(draft, request, rootTaskId, now);
    case 'context': {
      const report = buildContextReport(draft, rootTaskId);
      return {
        ok: true,
        commandId: 'context',
        effectClass: 'read',
        presenter: 'context',
        message: 'Context report',
        data: report,
      };
    }
    case 'compact': {
      const result = compactWorkflowTranscript(draft, {
        rootTaskId,
        now,
      });
      return {
        ok: true,
        commandId: 'compact',
        effectClass: 'mutate_store',
        presenter: 'message',
        message: `Compacted messages ${result.beforeMessageCount} → ${result.afterMessageCount}`,
        data: result,
      };
    }
    case 'export': {
      const format = request.argv[0] === 'json' ? 'json' : 'md';
      const content =
        format === 'json'
          ? exportWorkflowJson(draft, rootTaskId)
          : exportWorkflowMarkdown(draft, rootTaskId);
      return {
        ok: true,
        commandId: 'export',
        effectClass: 'export',
        presenter: 'export',
        message: `Export ready (${format})`,
        data: { format, content },
      };
    }
    case 'archive': {
      const run = getWorkflowRunForRoot(draft, rootTaskId);
      if (!run) {
        return {
          ok: false,
          commandId: 'archive',
          error: workflowError('NOT_FOUND', 'workflow run not found'),
          presenter: 'error',
        };
      }
      archiveWorkflowRun(draft, { workflowRunId: run.id, now });
      return {
        ok: true,
        commandId: 'archive',
        effectClass: 'mutate_store',
        presenter: 'message',
        message: `Archived workflow ${run.id} (lifecycle unchanged)`,
        data: { workflowRunId: run.id },
      };
    }
    default:
      return {
        ok: false,
        commandId: request.commandId,
        error: workflowError('COMMAND_UNKNOWN', `No workflow route for ${request.commandId}`),
        presenter: 'error',
      };
  }
}
