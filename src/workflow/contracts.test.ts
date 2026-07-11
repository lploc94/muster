import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CONTRACT_VERSION,
  bridgeActionsForPhase,
  canTransitionPhase,
  findCommandSpec,
  isPreApprovalPhase,
  validateDecisionBrief,
  validateDebugReport,
  validatePlanArtifact,
  validatePlanArtifactShape,
  validateTaskHandoff,
  validateTestReport,
  validateVerificationReport,
  validateWorkflowOutcomeProposal,
  type PlanArtifact,
} from './contracts';

const BACKENDS = new Set(['claude', 'grok', 'kiro', 'codex', 'opencode']);

function envelopeBase(kind: string) {
  return {
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    id: `${kind}-1`,
    kind,
    rootTaskId: 'root-1',
    workflowRunId: 'wf-1',
    producedByTaskId: 'root-1',
    producedAt: '2026-07-11T00:00:00.000Z',
    consumer: 'host' as const,
  };
}

function validPlanBody(overrides: Partial<PlanArtifact['body']> = {}): PlanArtifact['body'] {
  return {
    title: 'Add feature',
    summary: 'Implement X with tests',
    goal: 'Ship X',
    revision: 1,
    tasks: [
      {
        proposalId: 't-impl',
        goal: 'Implement X',
        role: 'worker',
        backend: 'claude',
        dependsOn: [],
        acceptanceCriteria: ['code compiles'],
        verification: ['npm test'],
      },
      {
        proposalId: 't-test',
        goal: 'Test X',
        role: 'worker',
        backend: 'claude',
        dependsOn: ['t-impl'],
        acceptanceCriteria: ['tests pass'],
        verification: ['npm test'],
      },
    ],
    acceptanceCriteria: ['feature works'],
    verificationStrategy: ['npm test', 'npm run compile'],
    rollbackNotes: ['revert commit'],
    openQuestions: [],
    constraints: ['no new deps'],
    confidence: 'medium',
    unknowns: [],
    evidence: [],
    ...overrides,
  };
}

describe('workflow phase transitions', () => {
  it('allows thinking → planning → awaiting_plan_approval → approved', () => {
    expect(canTransitionPhase('thinking', 'planning')).toBe(true);
    expect(canTransitionPhase('planning', 'awaiting_plan_approval')).toBe(true);
    expect(canTransitionPhase('awaiting_plan_approval', 'approved')).toBe(true);
    expect(canTransitionPhase('approved', 'implementing')).toBe(true);
  });

  it('denies jumping from draft to implementing', () => {
    expect(canTransitionPhase('draft', 'implementing')).toBe(false);
  });

  it('treats completed and abandoned as terminal', () => {
    expect(canTransitionPhase('completed', 'planning')).toBe(false);
    expect(canTransitionPhase('abandoned', 'thinking')).toBe(false);
  });
});

describe('bridge actions by phase', () => {
  it('denies start/complete/fail before approval', () => {
    for (const phase of ['draft', 'thinking', 'planning', 'awaiting_plan_approval'] as const) {
      expect(isPreApprovalPhase(phase)).toBe(true);
      const actions = bridgeActionsForPhase(phase);
      expect(actions.has('start_task')).toBe(false);
      expect(actions.has('complete_task')).toBe(false);
      expect(actions.has('fail_task')).toBe(false);
      expect(actions.has('submit_plan_artifact')).toBe(true);
      expect(actions.has('submit_decision_brief')).toBe(true);
    }
  });

  it('allows start_task after approval', () => {
    expect(bridgeActionsForPhase('approved').has('start_task')).toBe(true);
    expect(bridgeActionsForPhase('implementing').has('complete_task')).toBe(true);
  });
});

describe('command specs', () => {
  it('resolves aliases', () => {
    expect(findCommandSpec('list')?.id).toBe('tasks');
    expect(findCommandSpec('?')?.id).toBe('help');
    expect(findCommandSpec('approve')?.requiredPhases).toContain('awaiting_plan_approval');
  });
});

describe('decision brief', () => {
  it('accepts a well-formed brief', () => {
    const result = validateDecisionBrief({
      ...envelopeBase('decision_brief'),
      body: {
        goal: 'Ship X',
        problemSummary: 'Need X',
        constraints: ['time'],
        openQuestions: ['scope?'],
        assumptions: ['npm available'],
        risks: ['regression'],
        recommendedApproach: 'thin vertical slice',
        alternatives: [{ option: 'big bang', tradeoff: 'riskier' }],
        confidence: 'high',
        unknowns: [],
        evidence: [{ id: 'e1', kind: 'file', summary: 'README' }],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects missing goal', () => {
    const result = validateDecisionBrief({
      ...envelopeBase('decision_brief'),
      body: {
        problemSummary: 'Need X',
        constraints: [],
        openQuestions: [],
        assumptions: [],
        risks: [],
        recommendedApproach: 'x',
        alternatives: [],
        confidence: 'low',
        unknowns: [],
        evidence: [],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ARTIFACT_INVALID');
  });
});

describe('plan artifact', () => {
  it('accepts a valid DAG plan', () => {
    const result = validatePlanArtifact(
      { ...envelopeBase('plan'), body: validPlanBody() },
      { knownBackends: BACKENDS },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects unknown backend', () => {
    const body = validPlanBody({
      tasks: [
        {
          proposalId: 't1',
          goal: 'x',
          role: 'worker',
          backend: 'not-a-backend',
          dependsOn: [],
          acceptanceCriteria: ['a'],
          verification: ['v'],
        },
      ],
    });
    const result = validatePlanArtifact(
      { ...envelopeBase('plan'), body },
      { knownBackends: BACKENDS },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_INVALID');
      expect(JSON.stringify(result.error.details)).toMatch(/unknown backend/);
    }
  });

  it('rejects cycles', () => {
    const body = validPlanBody({
      tasks: [
        {
          proposalId: 'a',
          goal: 'A',
          role: 'worker',
          backend: 'claude',
          dependsOn: ['b'],
          acceptanceCriteria: ['a'],
          verification: ['v'],
        },
        {
          proposalId: 'b',
          goal: 'B',
          role: 'worker',
          backend: 'claude',
          dependsOn: ['a'],
          acceptanceCriteria: ['a'],
          verification: ['v'],
        },
      ],
    });
    const result = validatePlanArtifact(
      { ...envelopeBase('plan'), body },
      { knownBackends: BACKENDS },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error.details)).toMatch(/cycle/);
  });

  it('rejects missing acceptance criteria at shape level', () => {
    const body = validPlanBody();
    // @ts-expect-error intentional invalid
    body.acceptanceCriteria = [];
    const result = validatePlanArtifactShape({ ...envelopeBase('plan'), body });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown dependency ids', () => {
    const body = validPlanBody({
      tasks: [
        {
          proposalId: 'only',
          goal: 'x',
          role: 'worker',
          backend: 'claude',
          dependsOn: ['missing'],
          acceptanceCriteria: ['a'],
          verification: ['v'],
        },
      ],
    });
    const result = validatePlanArtifact(
      { ...envelopeBase('plan'), body },
      { knownBackends: BACKENDS },
    );
    expect(result.ok).toBe(false);
  });
});

describe('reports and handoffs', () => {
  it('requires evidence for successful verification', () => {
    const result = validateVerificationReport({
      ...envelopeBase('verification_report'),
      body: {
        checks: [{ name: 'unit', passed: true, detail: 'ok' }],
        overallPassed: true,
        summary: 'all good',
        evidence: [],
        confidence: 'high',
        unknowns: [],
        residualRisks: [],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EVIDENCE_MISSING');
  });

  it('accepts verification with evidence', () => {
    const result = validateVerificationReport({
      ...envelopeBase('verification_report'),
      body: {
        checks: [{ name: 'unit', command: 'npm test', passed: true, detail: 'ok' }],
        overallPassed: true,
        summary: 'all good',
        evidence: [{ id: 'e1', kind: 'test', summary: 'vitest pass' }],
        confidence: 'high',
        unknowns: [],
        residualRisks: [],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('validates test, debug, handoff, and outcome proposal', () => {
    expect(
      validateTestReport({
        ...envelopeBase('test_report'),
        body: {
          scope: 'unit',
          commands: ['npm test'],
          passed: true,
          summary: 'ok',
          failures: [],
          evidence: [],
          confidence: 'medium',
          unknowns: [],
          residualRisks: [],
        },
      }).ok,
    ).toBe(true);

    expect(
      validateDebugReport({
        ...envelopeBase('debug_report'),
        body: {
          symptom: 'failing test',
          attempts: [{ action: 'rerun', result: 'still fails' }],
          rootCause: 'null check',
          confidence: 'medium',
          nextStep: 'add guard',
          evidence: [],
          unknowns: [],
          retryable: true,
        },
      }).ok,
    ).toBe(true);

    expect(
      validateTaskHandoff({
        ...envelopeBase('task_handoff'),
        body: {
          goal: 'implement',
          constraints: [],
          allowedActions: ['edit'],
          outputContract: 'TestReport',
          evidenceRefs: [{ artifactId: 'plan-1' }],
          acceptanceCriteria: ['done'],
        },
      }).ok,
    ).toBe(true);

    const completeNoEvidence = validateWorkflowOutcomeProposal({
      ...envelopeBase('outcome_proposal'),
      body: {
        kind: 'complete',
        summary: 'done',
        evidenceRefs: [],
        residualRisks: [],
        confidence: 'high',
      },
    });
    expect(completeNoEvidence.ok).toBe(false);
    if (!completeNoEvidence.ok) expect(completeNoEvidence.error.code).toBe('EVIDENCE_MISSING');
  });
});
