/**
 * Native workflow command routes: implement/test/review/debug/verify/finish.
 * Host-side orchestration stubs that stage artifacts and phase transitions.
 */

import { randomUUID } from 'crypto';
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
  transitionWorkflowPhase,
} from './store';
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

export function routeImplement(
  draft: TaskStoreFile,
  request: CommandRequest,
  rootTaskId: string,
  now: string,
): CommandResult {
  const gate = phaseOk(draft, rootTaskId, ['approved', 'implementing', 'debugging']);
  if (!gate.ok) return gate.result;
  transitionWorkflowPhase(draft, {
    workflowRunId: gate.workflowRunId,
    to: 'implementing',
    now,
  });
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
  transitionWorkflowPhase(draft, {
    workflowRunId: gate.workflowRunId,
    to: 'testing',
    now,
  });
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
  transitionWorkflowPhase(draft, {
    workflowRunId: gate.workflowRunId,
    to: 'reviewing',
    now,
  });
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
  transitionWorkflowPhase(draft, {
    workflowRunId: gate.workflowRunId,
    to: 'debugging',
    now,
  });
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
  transitionWorkflowPhase(draft, {
    workflowRunId: gate.workflowRunId,
    to: 'verifying',
    now,
  });
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
  transitionWorkflowPhase(draft, {
    workflowRunId: gate.workflowRunId,
    to: 'finishing',
    now,
  });

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
    case 'think':
    case 'plan':
      return {
        ok: true,
        commandId: request.commandId,
        effectClass: 'mutate_plan',
        presenter: 'message',
        message: `Continue ${request.commandId} via planner turn (submit_* bridge tools)`,
        data: { phase: getWorkflowRunForRoot(draft, rootTaskId)?.phase },
      };
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
