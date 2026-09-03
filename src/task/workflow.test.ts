import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKFLOW_POLICY,
  WORKFLOW_RUN_BUDGET_BOUNDS,
  WORKFLOW_FAIL_REASON_CODES,
  WORKFLOW_FAILURE_FIXED_REPORT,
  WORKFLOW_FAILURE_UNAVAILABLE_REPORT,
  WORKFLOW_ENGINE_FAILURE_REPORTS,
  boundWorkflowFailReason,
  buildWorkflowFailureReport,
  clampWorkflowRunBudgets,
  decodeRunClosureEnvelope,
  decodeTopology,
  decodeWorkflowFailureDetail,
  decodeWorkflowManifest,
  unavailableWorkflowFailureDetail,
  defineWorkflowConflict,
  defineWorkflowCreated,
  defineWorkflowInvalid,
  defineWorkflowLedgerKey,
  defineWorkflowReplay,
  deriveFeedbackRequestMessageId,
  deriveFeedbackResponseMessageId,
  deriveFeedbackResumeMessageId,
  deriveFeedbackResumeTurnId,
  deriveFeedbackRoundId,
  deriveFeedbackTargetMessageId,
  deriveFeedbackTargetTurnId,
  deriveNextContributionMessageId,
  deriveNodeActivationIdentities,
  deriveProducerArtifactId,
  deriveProducerArtifactRevision,
  deriveRunClosureFenceId,
  deriveStartIdentities,
  deriveWorkflowStartContinuationId,
  deriveWorkflowStartResumeMessageId,
  deriveWorkflowStartResumeTurnId,
  entryNodeIds,
  fingerprintDefinition,
  formatWorkflowEntryAggregate,
  maximumWorkflowEntryAggregateBytes,
  terminalNodeId,
  terminalNodeIds,
  validateDefineWorkflow,
  validateStartWorkflow,
  workflowRunAttentionCode,
  workflowRunTerminalStatusForReason,
} from './workflow';
import {
  WORKFLOW_ENTRY_CONTRACTS_MAX,
  WORKFLOW_GRAPH_MAX_EDGES,
  WORKFLOW_GRAPH_MAX_NODES,
  WORKFLOW_INSTRUCTIONS_MAX_LENGTH,
} from './workflow-types';

type TestRecord = Record<string, unknown>;

interface TestManifest extends TestRecord {
  schema: string;
  name: string;
  description?: string;
  inputs: TestRecord[];
  outputs: TestRecord[];
  nodes: TestRecord[];
  edges: TestRecord[];
}

function record(value: unknown): TestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected test record');
  }
  return value as TestRecord;
}

function recordArray(value: unknown): TestRecord[] {
  if (!Array.isArray(value)) throw new Error('expected test record array');
  return value.map(record);
}

function oneNodeManifest(): TestManifest {
  return {
    schema: 'muster.workflow/v2',
    name: 'Inspect scheduling',
    description: 'Inspect one subsystem.',
    inputs: [
      { name: 'request', kind: 'request', to: 'inspect', inputRef: 'request' },
    ],
    outputs: [
      { name: 'report', kind: 'report', from: 'inspect' },
    ],
    nodes: [
      {
        nodeKey: 'inspect',
        taskType: 'research',
        title: 'Inspection title',
        instructions: { inline: 'Inspect the implementation and report evidence.' },
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The inspection report is complete.' },
          fail: { when: 'The implementation cannot be inspected.' },
        },
      },
    ],
    edges: [],
  };
}

function fanInManifest(): TestManifest {
  return {
    schema: 'muster.workflow/v2',
    name: 'Plan and verify',
    inputs: [
      { name: 'request', kind: 'request', to: 'plan', inputRef: 'request' },
      { name: 'constraints', kind: 'constraints', to: 'research', inputRef: 'constraints' },
    ],
    outputs: [
      { name: 'planDraft', kind: 'plan', from: 'plan' },
      { name: 'researchEvidence', kind: 'evidence', from: 'research' },
      { name: 'verifiedPlan', kind: 'plan', from: 'verify' },
    ],
    nodes: [
      {
        nodeKey: 'plan',
        taskType: 'planner',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The plan draft is ready.' },
          fail: { when: 'The plan cannot be produced.' },
        },
      },
      {
        nodeKey: 'research',
        taskType: 'research',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The research evidence is ready.' },
          fail: { when: 'The evidence cannot be gathered.' },
        },
      },
      {
        nodeKey: 'verify',
        taskType: 'reviewer',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The plan is complete and verified.' },
          prev: [
            {
              when: 'The plan needs correction.',
              targets: ['plan'],
              feedback: 'required',
            },
            {
              when: 'The evidence needs correction.',
              targets: ['evidence'],
              feedback: 'required',
            },
          ],
          fail: { when: 'Verification cannot be completed.' },
        },
      },
    ],
    edges: [
      { from: 'plan', to: 'verify', inputRef: 'plan' },
      { from: 'research', to: 'verify', inputRef: 'evidence' },
    ],
  };
}

function multiSinkManifest(): TestManifest {
  return {
    schema: 'muster.workflow/v2',
    name: 'Parallel reports',
    inputs: [
      { name: 'leftRequest', kind: 'request', to: 'left', inputRef: 'request' },
      { name: 'rightRequest', kind: 'request', to: 'right', inputRef: 'request' },
    ],
    outputs: [
      { name: 'leftDraft', kind: 'report', from: 'left' },
      { name: 'leftReport', kind: 'report', from: 'leftResult' },
      { name: 'rightDraft', kind: 'report', from: 'right' },
      { name: 'rightReport', kind: 'report', from: 'rightResult' },
    ],
    nodes: [
      {
        nodeKey: 'left',
        taskType: 'research',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The left draft is ready.' },
          fail: { when: 'The left draft cannot be produced.' },
        },
      },
      {
        nodeKey: 'leftResult',
        taskType: 'review',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The left review is complete.' },
          fail: { when: 'The left review cannot be completed.' },
        },
      },
      {
        nodeKey: 'right',
        taskType: 'research',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The right draft is ready.' },
          fail: { when: 'The right draft cannot be produced.' },
        },
      },
      {
        nodeKey: 'rightResult',
        taskType: 'review',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The right review is complete.' },
          fail: { when: 'The right review cannot be completed.' },
        },
      },
    ],
    edges: [
      { from: 'left', to: 'leftResult', inputRef: 'draft' },
      { from: 'right', to: 'rightResult', inputRef: 'draft' },
    ],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectInvalidManifest(value: unknown, reason?: RegExp): void {
  const decoded = decodeWorkflowManifest(value, 'inline');
  expect(decoded.ok).toBe(false);
  if (!decoded.ok && reason) expect(decoded.reason).toMatch(reason);
}

function definitionFromManifest(raw: unknown) {
  const decoded = decodeWorkflowManifest(raw, 'inline');
  if (!decoded.ok) throw new Error(decoded.reason);
  return {
    definitionId: 'workflow-contract',
    version: 1,
    name: decoded.name,
    topology: decoded.topology,
    entryContracts: decoded.entryContracts,
    policy: DEFAULT_WORKFLOW_POLICY,
    scope: { kind: 'workspace' as const },
    createdAt: '2026-08-31T00:00:00.000Z',
  };
}

describe('canonical workflow manifest contract', () => {
  it('normalizes instruction-less and inline-instruction agent nodes', () => {
    const withoutInstructions = oneNodeManifest();
    delete withoutInstructions.nodes[0]!.instructions;
    const decodedWithout = decodeWorkflowManifest(withoutInstructions, 'inline');
    expect(decodedWithout).toMatchObject({
      ok: true,
      name: 'Inspect scheduling',
      topology: {
        kind: 'workflow',
        nodes: [{ nodeId: 'inspect', taskType: 'research', title: 'Inspection title' }],
        inputs: [{
          name: 'request', semanticKind: 'request', entryNodeId: 'inspect', inputRef: 'request',
        }],
        outputs: [{
          name: 'report', semanticKind: 'report', sourceNodeId: 'inspect',
        }],
      },
      entryContracts: [{
        entryNodeId: 'inspect', inputRef: 'request', expectedArtifactKind: 'workflow_input',
      }],
    });

    const decodedInline = decodeWorkflowManifest(oneNodeManifest(), 'inline');
    expect(decodedInline).toMatchObject({
      ok: true,
      topology: {
        nodes: [{
          nodeId: 'inspect',
          instructions: {
            kind: 'inline',
            content: 'Inspect the implementation and report evidence.',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        }],
      },
    });
  });

  it('accepts explicit agent and complete execute outcomes', () => {
    const explicit = oneNodeManifest();
    explicit.nodes[0]!.outcome = {
      kind: 'agent',
      requireExplicitDisposition: true,
      next: { when: 'The report is complete.' },
      fail: { when: 'The report cannot be completed.' },
    };
    expect(decodeWorkflowManifest(explicit, 'inline').ok).toBe(true);
    expect(decodeWorkflowManifest(fanInManifest(), 'inline').ok).toBe(true);

    const optional = oneNodeManifest();
    optional.nodes[0]!.outcome = {
      kind: 'agent',
      requireExplicitDisposition: false,
      next: { when: 'The report is complete.' },
      fail: { when: 'The report cannot be completed.' },
    };
    expectInvalidManifest(optional, /requireExplicitDisposition|literal.*true/i);

    const missingFail = oneNodeManifest();
    missingFail.nodes[0]!.outcome = {
      kind: 'agent',
      requireExplicitDisposition: true,
      next: { when: 'The report is complete.' },
    };
    expectInvalidManifest(missingFail, /FAIL|fail/i);

    const executeFail = oneNodeManifest();
    executeFail.nodes = [{
      nodeKey: 'inspect',
      title: 'Run check',
      script: { interpreter: 'node', file: 'scripts/check.js', args: ['--json'] },
      outcome: {
        kind: 'exit',
        next: { when: { exitCode: 0 } },
        fail: { when: { exitCode: 'nonzero' } },
      },
    }];
    expect(decodeWorkflowManifest(executeFail, 'inline')).toMatchObject({
      ok: true,
      topology: {
        nodes: [{
          nodeId: 'inspect',
          execution: {
            kind: 'script', interpreter: 'node', file: 'scripts/check.js', args: ['--json'],
          },
          outcome: { kind: 'exit' },
        }],
      },
    });

    const executePrev = fanInManifest();
    executePrev.nodes[2] = {
      nodeKey: 'verify',
      title: 'Run verifier',
      script: { interpreter: 'python3', file: 'scripts/verify.py', args: [] },
      outcome: {
        kind: 'exit',
        next: { when: { exitCode: 0 } },
        prev: {
          when: { exitCode: 'nonzero' },
          targets: ['plan'],
          feedback: 'stdout',
        },
      },
    };
    expect(decodeWorkflowManifest(executePrev, 'inline').ok).toBe(true);
  });

  it('allows file instructions only in saved-package validation context', () => {
    const manifest = oneNodeManifest();
    manifest.nodes[0]!.instructions = { file: 'prompts/inspect.md' };
    expect(decodeWorkflowManifest(manifest, 'inline')).toMatchObject({ ok: false });
    expect(decodeWorkflowManifest(manifest, 'saved')).toMatchObject({
      ok: true,
      topology: {
        nodes: [{ instructions: { kind: 'file', file: 'prompts/inspect.md' } }],
      },
    });
  });

  it('rejects unknown fields at the root and every nested contract level', () => {
    const root = clone(oneNodeManifest());
    Object.assign(root, { policy: {} });
    expectInvalidManifest(root, /field|unknown/i);

    const input = clone(oneNodeManifest());
    Object.assign(input.inputs[0]!, { artifactId: 'forged' });
    expectInvalidManifest(input, /input/i);

    const output = clone(oneNodeManifest());
    Object.assign(output.outputs[0]!, { revision: 2 });
    expectInvalidManifest(output, /output/i);

    const node = clone(oneNodeManifest());
    Object.assign(node.nodes[0]!, { backend: 'forged' });
    expectInvalidManifest(node, /node/i);

    const instructions = clone(oneNodeManifest());
    Object.assign(record(instructions.nodes[0]!.instructions), { digest: 'forged' });
    expectInvalidManifest(instructions, /instructions/i);

    const edge = clone(fanInManifest());
    Object.assign(edge.edges[0]!, { expectedArtifactKind: 'forged' });
    expectInvalidManifest(edge, /edge/i);

    const outcome = clone(fanInManifest());
    Object.assign(record(outcome.nodes[2]!.outcome), { targetNodeId: 'plan' });
    expectInvalidManifest(outcome, /outcome/i);

    const route = clone(fanInManifest());
    Object.assign(record(record(route.nodes[2]!.outcome).next), { to: 'elsewhere' });
    expectInvalidManifest(route, /next|outcome/i);

    const prev = clone(fanInManifest());
    Object.assign(recordArray(record(prev.nodes[2]!.outcome).prev)[0]!, { note: 'forged' });
    expectInvalidManifest(prev, /prev|outcome/i);
  });

  it('rejects NUL in canonical workflow names and descriptions', () => {
    const unsafeName = clone(oneNodeManifest());
    unsafeName.name = 'unsafe\0name';
    expectInvalidManifest(unsafeName, /name/i);

    const unsafeDescription = clone(oneNodeManifest());
    unsafeDescription.description = 'unsafe\0description';
    expectInvalidManifest(unsafeDescription, /description/i);

    const definition = definitionFromManifest(oneNodeManifest());
    expect(validateDefineWorkflow({ ...definition, name: 'unsafe\0name' })).toMatchObject({ ok: false });
    expect(validateDefineWorkflow({
      ...definition,
      topology: { ...definition.topology, description: 'unsafe\0description' },
    })).toMatchObject({ ok: false });
  });

  it('rejects removed label, edge as, script onFailure, and legacy topology fields', () => {
    const label = clone(oneNodeManifest());
    Object.assign(label.nodes[0]!, { label: 'legacy objective' });
    expectInvalidManifest(label, /node/i);

    const edgeAs = clone(fanInManifest());
    Object.assign(edgeAs.edges[0]!, { as: 'legacy' });
    expectInvalidManifest(edgeAs, /edge/i);

    const onFailure = clone(oneNodeManifest());
    onFailure.nodes = [{
      nodeKey: 'inspect',
      script: { interpreter: 'node', file: 'scripts/check.js', onFailure: 'continue' },
      outcome: {
        kind: 'exit',
        next: { when: { exitCode: 0 } },
        fail: { when: { exitCode: 'nonzero' } },
      },
    }];
    expectInvalidManifest(onFailure, /script/i);

    expect(decodeTopology({
      kind: 'one_node_v1', nodes: [{ nodeId: 'inspect' }], entryNodeId: 'inspect',
    }).ok).toBe(false);
    expect(decodeTopology({ kind: 'graph_v1', nodes: [], edges: [] }).ok).toBe(false);
  });

  it('rejects prompt-structural and control characters in every inputRef identity', () => {
    const unsafeInputRef = 'request"\n# Workflow instructions';

    const publicInput = clone(oneNodeManifest());
    publicInput.inputs[0]!.inputRef = unsafeInputRef;
    expectInvalidManifest(publicInput, /inputRef|workflow input/i);

    const edgeAndTarget = clone(fanInManifest());
    edgeAndTarget.edges[0]!.inputRef = unsafeInputRef;
    recordArray(record(edgeAndTarget.nodes[2]!.outcome).prev)[0]!.targets = [unsafeInputRef];
    expectInvalidManifest(edgeAndTarget, /inputRef|PREV target/i);

    const normalized = structuredClone(definitionFromManifest(fanInManifest()).topology) as unknown as TestRecord;
    recordArray(normalized.edges)[0]!.inputRef = unsafeInputRef;
    const normalizedVerify = recordArray(normalized.nodes).find((node) => node.nodeId === 'verify')!;
    recordArray(record(normalizedVerify.outcome).prev)[0]!.targets = [unsafeInputRef];
    const decoded = decodeTopology(normalized);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toMatch(/inputRef|node specification/i);
  });

  it('rejects duplicate semantic names and duplicate destination slots', () => {
    const duplicateNode = clone(fanInManifest());
    duplicateNode.nodes[1]!.nodeKey = 'plan';
    expectInvalidManifest(duplicateNode, /duplicate.*node/i);

    const duplicateInputName = clone(fanInManifest());
    duplicateInputName.inputs[1]!.name = 'request';
    expectInvalidManifest(duplicateInputName, /duplicate.*input/i);

    const duplicateOutputName = clone(multiSinkManifest());
    duplicateOutputName.outputs[2]!.name = 'leftReport';
    expectInvalidManifest(duplicateOutputName, /duplicate.*output/i);

    const duplicateSlot = clone(fanInManifest());
    duplicateSlot.edges[1]!.inputRef = 'plan';
    expectInvalidManifest(duplicateSlot, /duplicate.*inputRef|consumer/i);

    const duplicatePublicSlot = clone(oneNodeManifest());
    duplicatePublicSlot.inputs.push({
      name: 'otherRequest', kind: 'request', to: 'inspect', inputRef: 'request',
    });
    expectInvalidManifest(duplicatePublicSlot, /duplicate.*input|entry/i);
  });

  it('rejects invalid entry/output contracts and requires every node exactly once', () => {
    const downstreamInput = clone(fanInManifest());
    downstreamInput.inputs[0]!.to = 'verify';
    expectInvalidManifest(downstreamInput, /entry/i);

    const nonTerminalOutput = clone(fanInManifest());
    nonTerminalOutput.outputs = nonTerminalOutput.outputs.filter((output) => output.from !== 'plan');
    expectInvalidManifest(nonTerminalOutput, /every node|unexported/i);

    const validCheckpoint = clone(fanInManifest());
    validCheckpoint.outputs[0]!.from = 'plan';
    expect(decodeWorkflowManifest(validCheckpoint, 'inline')).toMatchObject({
      ok: true,
      topology: {
        outputs: expect.arrayContaining([
          {
            name: validCheckpoint.outputs[0]!.name,
            semanticKind: 'plan',
            sourceNodeId: 'plan',
          },
        ]),
      },
    });

    const missingTerminal = clone(multiSinkManifest());
    missingTerminal.outputs.pop();
    expectInvalidManifest(missingTerminal, /terminal.*export|unexported/i);

    const duplicateTerminal = clone(multiSinkManifest());
    duplicateTerminal.outputs[1]!.from = 'left';
    expectInvalidManifest(duplicateTerminal, /node.*once|duplicate.*node|output/i);

    const unknownOutput = clone(oneNodeManifest());
    unknownOutput.outputs[0]!.from = 'missing';
    expectInvalidManifest(unknownOutput, /output|unknown node/i);
  });

  it('rejects invalid agent outcome and instruction shapes', () => {
    const missingBoolean = clone(fanInManifest());
    delete record(missingBoolean.nodes[2]!.outcome).requireExplicitDisposition;
    expectInvalidManifest(missingBoolean, /requireExplicitDisposition/i);

    const optionalWithoutNext = clone(fanInManifest());
    const optionalOutcome = record(optionalWithoutNext.nodes[2]!.outcome);
    optionalOutcome.requireExplicitDisposition = false;
    delete optionalOutcome.next;
    expectInvalidManifest(optionalWithoutNext, /requireExplicitDisposition|literal.*true|NEXT/i);

    const illegalTarget = clone(fanInManifest());
    recordArray(record(illegalTarget.nodes[2]!.outcome).prev)[0]!.targets = ['research'];
    expectInvalidManifest(illegalTarget, /PREV.*target|inbound/i);

    const duplicateTarget = clone(fanInManifest());
    recordArray(record(duplicateTarget.nodes[2]!.outcome).prev)[0]!.targets = ['plan', 'plan'];
    expectInvalidManifest(duplicateTarget, /duplicate.*target/i);

    const missingFeedback = clone(fanInManifest());
    delete recordArray(record(missingFeedback.nodes[2]!.outcome).prev)[0]!.feedback;
    expectInvalidManifest(missingFeedback, /feedback/i);

    const entryPrev = clone(oneNodeManifest());
    entryPrev.nodes[0]!.outcome = {
      kind: 'agent',
      requireExplicitDisposition: true,
      next: { when: 'The result is ready.' },
      fail: { when: 'The result cannot be produced.' },
      prev: [{ when: 'Retry caller input.', targets: ['request'], feedback: 'required' }],
    };
    expectInvalidManifest(entryPrev, /entry.*PREV|inbound/i);

    const xor = clone(oneNodeManifest());
    Object.assign(record(xor.nodes[0]!.instructions), { file: 'prompts/inspect.md' });
    expectInvalidManifest(xor, /instructions/i);

    const emptyInstructions = clone(oneNodeManifest());
    emptyInstructions.nodes[0]!.instructions = { inline: '' };
    expectInvalidManifest(emptyInstructions, /instructions/i);

    const oversizedInstructions = clone(oneNodeManifest());
    oversizedInstructions.nodes[0]!.instructions = {
      inline: 'x'.repeat(WORKFLOW_INSTRUCTIONS_MAX_LENGTH + 1),
    };
    expectInvalidManifest(oversizedInstructions, /instructions/i);
  });

  it('rejects a false failWorkflow policy before definition validation succeeds', () => {
    const definition = definitionFromManifest(oneNodeManifest());
    expect(validateDefineWorkflow({
      ...definition,
      policy: { ...definition.policy, failWorkflow: false },
    })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/failWorkflow/i),
    });
  });

  it('rejects agent/exit mismatches and incomplete exit coverage', () => {
    const agentWithExit = clone(oneNodeManifest());
    agentWithExit.nodes[0]!.outcome = {
      kind: 'exit',
      next: { when: { exitCode: 0 } },
      fail: { when: { exitCode: 'nonzero' } },
    };
    expectInvalidManifest(agentWithExit, /agent|exit/i);

    const executeWithAgent = clone(oneNodeManifest());
    executeWithAgent.nodes = [{
      nodeKey: 'inspect',
      script: { interpreter: 'node', file: 'scripts/check.js' },
      outcome: {
        kind: 'agent',
        requireExplicitDisposition: false,
        next: { when: 'Complete.' },
      },
    }];
    expectInvalidManifest(executeWithAgent, /agent|exit/i);

    const missingNonzero = clone(executeWithAgent);
    missingNonzero.nodes[0]!.outcome = {
      kind: 'exit',
      next: { when: { exitCode: 0 } },
    };
    expectInvalidManifest(missingNonzero, /nonzero|coverage/i);

    const overlappingNonzero = clone(missingNonzero);
    overlappingNonzero.nodes[0]!.outcome = {
      kind: 'exit',
      next: { when: { exitCode: 0 } },
      prev: {
        when: { exitCode: 'nonzero' }, targets: ['request'], feedback: 'stdout',
      },
      fail: { when: { exitCode: 'nonzero' } },
    };
    expectInvalidManifest(overlappingNonzero, /nonzero|exactly one/i);

    const wrongZero = clone(missingNonzero);
    wrongZero.nodes[0]!.outcome = {
      kind: 'exit',
      next: { when: { exitCode: 'nonzero' } },
      fail: { when: { exitCode: 0 } },
    };
    expectInvalidManifest(wrongZero, /exitCode|zero/i);
  });

  it('rejects cycles, fan-out, isolated nodes, and graph bounds', () => {
    const cycle = clone(fanInManifest());
    cycle.edges.push({ from: 'verify', to: 'plan', inputRef: 'back' });
    expectInvalidManifest(cycle, /cycle/i);

    const fanOut = clone(fanInManifest());
    fanOut.nodes.push({
      nodeKey: 'other',
      taskType: 'reviewer',
      outcome: {
        kind: 'agent',
        requireExplicitDisposition: true,
        next: { when: 'The other review is complete.' },
        fail: { when: 'The other review cannot be completed.' },
      },
    });
    fanOut.edges.push({ from: 'plan', to: 'other', inputRef: 'plan' });
    fanOut.outputs.push({ name: 'other', kind: 'review', from: 'other' });
    expectInvalidManifest(fanOut, /fan-out/i);

    const isolated = clone(fanInManifest());
    isolated.nodes.push({
      nodeKey: 'isolated',
      taskType: 'research',
      outcome: {
        kind: 'agent',
        requireExplicitDisposition: true,
        next: { when: 'The isolated research is complete.' },
        fail: { when: 'The isolated research cannot be completed.' },
      },
    });
    isolated.outputs.push({ name: 'isolated', kind: 'report', from: 'isolated' });
    expectInvalidManifest(isolated, /isolated|workflow path/i);

    const oversized = oneNodeManifest();
    oversized.nodes = Array.from(
      { length: WORKFLOW_GRAPH_MAX_NODES + 1 },
      (_, index) => ({ nodeKey: `n${index}`, taskType: 'research' }),
    );
    expectInvalidManifest(oversized, /nodes|64/i);
  });

  it('rejects every over-bound canonical array before decoding its elements', () => {
    const tooManyOutputs = clone(oneNodeManifest());
    tooManyOutputs.outputs = Array.from(
      { length: WORKFLOW_GRAPH_MAX_NODES + 1 },
      (_, index) => ({ name: `report${index}`, kind: 'report', from: 'inspect' }),
    );
    expectInvalidManifest(tooManyOutputs, /output.*bound|graph.*bound/i);

    const tooManyAgentTargets = clone(fanInManifest());
    recordArray(record(tooManyAgentTargets.nodes[2]!.outcome).prev)[0]!.targets = Array.from(
      { length: WORKFLOW_GRAPH_MAX_EDGES + 1 },
      (_, index) => `input${index}`,
    );
    expectInvalidManifest(tooManyAgentTargets, /PREV target.*bound/i);

    const tooManyExitTargets = clone(fanInManifest());
    tooManyExitTargets.nodes[2] = {
      nodeKey: 'verify',
      script: { interpreter: 'node', file: 'scripts/verify.js' },
      outcome: {
        kind: 'exit',
        next: { when: { exitCode: 0 } },
        prev: {
          when: { exitCode: 'nonzero' },
          targets: Array.from(
            { length: WORKFLOW_GRAPH_MAX_EDGES + 1 },
            (_, index) => `input${index}`,
          ),
          feedback: 'stdout',
        },
      },
    };
    expectInvalidManifest(tooManyExitTargets, /PREV target.*bound/i);

    const topology = definitionFromManifest(oneNodeManifest()).topology;
    const overBoundTopologies: Array<readonly [name: string, topology: unknown]> = [
      ['nodes', { ...topology, nodes: Array(WORKFLOW_GRAPH_MAX_NODES + 1).fill(null) }],
      ['edges', { ...topology, edges: Array(WORKFLOW_GRAPH_MAX_EDGES + 1).fill(null) }],
      ['inputs', { ...topology, inputs: Array(WORKFLOW_ENTRY_CONTRACTS_MAX + 1).fill(null) }],
      ['outputs', { ...topology, outputs: Array(WORKFLOW_GRAPH_MAX_NODES + 1).fill(null) }],
    ];
    for (const [name, raw] of overBoundTopologies) {
      const decoded = decodeTopology(raw);
      expect(decoded.ok, name).toBe(false);
      if (!decoded.ok) expect(decoded.reason, name).toMatch(/bound|1\.\.64/i);
    }
  });

  it('enforces global and frozen per-entry gate input limits', () => {
    const overGlobalGateLimit = clone(oneNodeManifest());
    overGlobalGateLimit.inputs = Array.from(
      { length: DEFAULT_WORKFLOW_POLICY.maxInputsPerGate + 1 },
      (_, index) => ({
        name: `request${index}`,
        kind: 'request',
        to: 'inspect',
        inputRef: `request${index}`,
      }),
    );
    expectInvalidManifest(overGlobalGateLimit, /input.*gate|per-gate|64/i);

    const twoInputs = clone(oneNodeManifest());
    twoInputs.inputs.push({
      name: 'context', kind: 'context', to: 'inspect', inputRef: 'context',
    });
    const definition = definitionFromManifest(twoInputs);
    expect(validateDefineWorkflow({
      ...definition,
      policy: { ...definition.policy, maxInputsPerGate: 1 },
    })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/entry.*policy|maxInputsPerGate/i),
    });
  });

  it('normalizes object order but fingerprints every persisted semantic difference', () => {
    const original = fanInManifest();
    const reordered = {
      edges: original.edges.map(({ from, to, inputRef }) => ({ inputRef, to, from })),
      nodes: original.nodes.map((node) => ({ ...node })),
      outputs: original.outputs.map(({ name, kind, from }) => ({ from, kind, name })),
      inputs: original.inputs.map(({ name, kind, to, inputRef }) => ({ inputRef, to, kind, name })),
      name: original.name,
      schema: original.schema,
    };
    const originalDefinition = definitionFromManifest(original);
    const reorderedDefinition = definitionFromManifest(reordered);
    expect(fingerprintDefinition(reorderedDefinition)).toBe(fingerprintDefinition(originalDefinition));

    const variants: Array<readonly [name: string, manifest: unknown]> = [];
    const outputName = clone(original);
    outputName.outputs[0]!.name = 'approvedPlan';
    variants.push(['output name', outputName]);
    const outputKind = clone(original);
    outputKind.outputs[0]!.kind = 'verified-plan';
    variants.push(['output semantic kind', outputKind]);
    const inputOrder = clone(original);
    inputOrder.inputs.reverse();
    variants.push(['input order', inputOrder]);
    const nodeOrder = clone(original);
    nodeOrder.nodes.reverse();
    variants.push(['node order', nodeOrder]);
    const edgeOrder = clone(original);
    edgeOrder.edges.reverse();
    variants.push(['edge order', edgeOrder]);
    const routeOrder = clone(original);
    const routeOutcome = record(routeOrder.nodes[2]!.outcome);
    routeOutcome.prev = recordArray(routeOutcome.prev).reverse();
    variants.push(['PREV route order', routeOrder]);
    const targetOrder = clone(original);
    recordArray(record(targetOrder.nodes[2]!.outcome).prev)[0]!.targets = ['plan', 'evidence'];
    variants.push(['PREV target order', targetOrder]);
    const outcomeText = clone(original);
    record(record(outcomeText.nodes[2]!.outcome).next).when = 'Different normalized condition.';
    variants.push(['outcome text', outcomeText]);
    const instructions = clone(original);
    instructions.nodes[0]!.instructions = { inline: 'Frozen plan instructions.' };
    variants.push(['frozen instructions', instructions]);

    for (const [name, variant] of variants) {
      expect(fingerprintDefinition(definitionFromManifest(variant)), name)
        .not.toBe(fingerprintDefinition(originalDefinition));
    }

    const multiSink = definitionFromManifest(multiSinkManifest());
    const reversedOutputs = clone(multiSinkManifest());
    reversedOutputs.outputs.reverse();
    expect(fingerprintDefinition(definitionFromManifest(reversedOutputs)))
      .not.toBe(fingerprintDefinition(multiSink));
  });

  it('round-trips the one canonical normalized topology and validates a definition', () => {
    const definition = definitionFromManifest(fanInManifest());
    const validated = validateDefineWorkflow(definition);
    expect(validated).toMatchObject({
      ok: true,
      definition: { topology: { kind: 'workflow' } },
    });
    if (!validated.ok) return;
    expect(entryNodeIds(validated.definition.topology)).toEqual(['plan', 'research']);
    expect(terminalNodeIds(validated.definition.topology)).toEqual(['verify']);
    expect(terminalNodeId(validated.definition.topology)).toBe('verify');
    const fp = validated.fingerprint;
    expect(defineWorkflowCreated(validated.definition, fp)).toMatchObject({
      ok: true, changed: true, definitionId: 'workflow-contract', version: 1, fingerprint: fp,
    });
    expect(defineWorkflowReplay(validated.definition, fp)).toMatchObject({
      ok: true, changed: false, replay: true, fingerprint: fp,
    });
    expect(defineWorkflowConflict('workflow-contract', 1)).toMatchObject({
      ok: false, conflict: true, reason: 'definition fingerprint conflict',
    });
    expect(defineWorkflowInvalid('invalid topology')).toMatchObject({
      ok: false, conflict: true, reason: 'invalid topology',
    });
    expect(defineWorkflowLedgerKey('workflow-contract', 1))
      .toBe('define_workflow:workspace:workflow-contract:1');
  });

  it('rejects a valid route shape whose rendered outcome contract exceeds its prompt section', () => {
    const manifest = clone(fanInManifest());
    const outcome = record(manifest.nodes[2]!.outcome);
    outcome.prev = Array.from({ length: 128 }, (_, index) => ({
      when: `${index}:`.padEnd(4_096, 'x'),
      targets: ['plan'],
      feedback: 'required',
    }));

    expect(validateDefineWorkflow(definitionFromManifest(manifest))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Workflow outcome contract exceeds'),
    });
  });

  it('retains named prior outputs in durable start validation and fingerprints', () => {
    const base = {
      definitionId: 'workflow-contract',
      version: 1,
      startIdempotencyKey: 'start-with-named-output',
      entryNodeId: 'inspect',
      entryNodeIds: ['inspect'],
      allNodeIds: ['inspect'],
      createdAt: '2026-08-31T00:00:00.000Z',
      goal: 'Inspect the selected report.',
      backend: 'grok',
      ownerRootTaskId: 'root-task',
      callerTaskId: 'caller-task',
      callerTurnId: 'caller-turn',
      inputContracts: [{
        name: 'request', semanticKind: 'result', entryNodeId: 'inspect', inputRef: 'request',
      }],
      entryContracts: [{
        entryNodeId: 'inspect', inputRef: 'request', expectedArtifactKind: 'workflow_input',
      }],
    };
    const left = validateStartWorkflow({
      ...base,
      inputs: [{ name: 'request', fromRun: 'prior-run', output: 'leftReport' }],
    });
    const right = validateStartWorkflow({
      ...base,
      inputs: [{ name: 'request', fromRun: 'prior-run', output: 'rightReport' }],
    });
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.entryInputs).toEqual([{
      name: 'request', semanticKind: 'result', entryNodeId: 'inspect', inputRef: 'request',
      fromRun: 'prior-run', output: 'leftReport',
    }]);
    expect(left.fingerprint).not.toBe(right.fingerprint);
  });

  it('keeps the aggregate byte boundary exact for derived transport entry contracts', () => {
    const definition = definitionFromManifest(oneNodeManifest());
    const maxArtifactBytes = 8;
    const exactAggregateBytes = maximumWorkflowEntryAggregateBytes(
      definition.entryContracts,
      maxArtifactBytes,
    );
    expect(new TextEncoder().encode(formatWorkflowEntryAggregate([
      { inputRef: 'request', value: 'éééé' },
    ])).byteLength).toBe(exactAggregateBytes);

    expect(validateDefineWorkflow({
      ...definition,
      policy: { ...definition.policy, maxArtifactBytes, maxAggregateBytes: exactAggregateBytes },
    }).ok).toBe(true);
    expect(validateDefineWorkflow({
      ...definition,
      policy: {
        ...definition.policy,
        maxArtifactBytes,
        maxAggregateBytes: exactAggregateBytes - 1,
      },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/aggregate exceeds policy/i) });
  });
});

describe('workflow runtime identities and bounded status helpers', () => {
  it('derives deterministic multi-entry start identities', () => {
    const definition = definitionFromManifest(fanInManifest());
    const entries = entryNodeIds(definition.topology);
    const all = definition.topology.nodes.map((node: { nodeId: string }) => node.nodeId);
    const a = deriveStartIdentities({
      definitionId: definition.definitionId,
      version: definition.version,
      startIdempotencyKey: 'start-fan-1',
      entryNodeId: entries[0]!,
      entryNodeIds: entries,
      allNodeIds: all,
    });
    const b = deriveStartIdentities({
      definitionId: definition.definitionId,
      version: definition.version,
      startIdempotencyKey: 'start-fan-1',
      entryNodeId: entries[0]!,
      entryNodeIds: [...entries].reverse(),
      allNodeIds: [...all].reverse(),
    });
    expect(a.runId).toBe(b.runId);
    expect(a.nodeGates).toHaveLength(3);
    expect(a.entries.map((entry) => entry.nodeId).sort()).toEqual([...entries].sort());
  });

  it('derives distinct durable NEXT, PREV, and continuation identities', () => {
    const runId = 'wfr_abc';
    const next = deriveNextContributionMessageId(runId, 'gate', 'plan', 'producer');
    expect(next).toBe(deriveNextContributionMessageId(runId, 'gate', 'plan', 'producer'));
    expect(next).not.toBe(deriveNextContributionMessageId(runId, 'gate', 'other', 'producer'));
    expect(deriveProducerArtifactRevision('updated')).toBe(1);
    expect(deriveProducerArtifactRevision('unchanged')).toBe(1);
    expect(next).not.toBe(deriveProducerArtifactId(runId, 'producer'));
    expect(next).not.toBe(deriveNodeActivationIdentities(runId, 'producer').messageId);

    const round = deriveFeedbackRoundId(runId, 'consumer', 'turn');
    const request = deriveFeedbackRequestMessageId(runId, round, 'producer');
    expect(request).not.toBe(deriveFeedbackResponseMessageId(runId, round, 'producer'));
    expect(deriveFeedbackTargetTurnId(runId, round, 'producer'))
      .not.toBe(deriveFeedbackTargetMessageId(runId, round, 'producer'));
    expect(deriveFeedbackResumeTurnId(runId, round))
      .not.toBe(deriveFeedbackResumeMessageId(runId, round));

    const continuation = deriveWorkflowStartContinuationId(runId, 'caller-turn');
    expect(new Set([
      continuation,
      deriveWorkflowStartResumeTurnId(runId, 'caller-turn'),
      deriveWorkflowStartResumeMessageId(runId, 'caller-turn'),
    ]).size).toBe(3);
  });

  it('bounds workflow budgets, fail reasons, and terminal status mappings', () => {
    expect(deriveRunClosureFenceId('run', 'failed'))
      .not.toBe(deriveRunClosureFenceId('run', 'cancelled'));
    expect(workflowRunAttentionCode('failed')).toBe('workflow_run_failed');
    expect(workflowRunAttentionCode('cancelled')).toBe('workflow_run_cancelled');
    expect(workflowRunTerminalStatusForReason('agent_fail')).toBe('failed');
    expect(workflowRunTerminalStatusForReason('required_target_cancelled')).toBe('cancelled');
    expect(WORKFLOW_FAIL_REASON_CODES).toContain('agent_fail');

    expect(clampWorkflowRunBudgets({
      maxFeedbackRoundsPerRun: 10_000,
      maxWorkflowTurnsPerRun: 10_000,
    })).toEqual({
      maxFeedbackRoundsPerRun: WORKFLOW_RUN_BUDGET_BOUNDS.maxFeedbackRoundsPerRun,
      maxWorkflowTurnsPerRun: WORKFLOW_RUN_BUDGET_BOUNDS.maxWorkflowTurnsPerRun,
    });
    const bounded = boundWorkflowFailReason('x'.repeat(2_000));
    expect(new TextEncoder().encode(bounded!).byteLength)
      .toBeLessThanOrEqual(WORKFLOW_RUN_BUDGET_BOUNDS.maxFailReasonBytes);
  });
});

describe('WorkflowFailureDetail closed envelope', () => {
  const maxBytes = WORKFLOW_RUN_BUDGET_BOUNDS.maxFailReasonBytes;

  it('builds bounded reports with code-point-safe truncation and fixed fallback', () => {
    expect(buildWorkflowFailureReport(undefined)).toEqual({
      text: WORKFLOW_FAILURE_FIXED_REPORT, truncated: false,
    });
    expect(buildWorkflowFailureReport('   ')).toEqual({
      text: WORKFLOW_FAILURE_FIXED_REPORT, truncated: false,
    });
    expect(buildWorkflowFailureReport('  agent gave up  ')).toEqual({
      text: 'agent gave up', truncated: false,
    });
    // Multibyte text immediately below the limit is preserved exact.
    const below = 'é'.repeat(Math.floor(maxBytes / 2));
    expect(buildWorkflowFailureReport(below)).toEqual({ text: below, truncated: false });
    // Text above the limit truncates without splitting a code point and is marked.
    const above = 'é'.repeat(Math.floor(maxBytes / 2) + 1);
    const built = buildWorkflowFailureReport(above);
    expect(built.truncated).toBe(true);
    expect(new TextEncoder().encode(built.text).byteLength).toBeLessThanOrEqual(maxBytes);
    expect('é'.repeat(built.text.length)).toBe(built.text);
  });

  it('decodes every valid source with code-matched detail', () => {
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'agent_fail', source: 'workflow_fail',
      nodeKey: 'entry', nodeTitle: 'Entry',
      report: { text: 'tool reason', truncated: false },
    })).toMatchObject({ ok: true });
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'agent_fail', source: 'backend_refusal',
      nodeKey: 'entry',
      report: { text: 'final assistant report', truncated: false },
    })).toMatchObject({ ok: true });
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'decision_missing', source: 'decision_exhausted',
      nodeKey: 'entry', attempt: { number: 3, limit: 3 },
      report: { text: 'last response', truncated: false },
    })).toMatchObject({ ok: true });
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'invalid_route', source: 'engine',
      nodeKey: 'entry',
      report: { text: WORKFLOW_ENGINE_FAILURE_REPORTS.invalid_route, truncated: false },
    })).toMatchObject({ ok: true });
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'run_timeout', source: 'engine',
      report: { text: WORKFLOW_ENGINE_FAILURE_REPORTS.run_timeout, truncated: false },
    })).toMatchObject({ ok: true });
  });

  it('rejects source/code mismatch, physical ids, and unbounded or foreign fields', () => {
    // workflow_fail must carry agent_fail, not a decision code.
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'decision_missing', source: 'workflow_fail',
      nodeKey: 'entry', report: { text: 'x', truncated: false },
    }).ok).toBe(false);
    // decision_exhausted requires attempt 3 of 3.
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'decision_missing', source: 'decision_exhausted',
      nodeKey: 'entry', report: { text: 'x', truncated: false },
    }).ok).toBe(false);
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'decision_missing', source: 'decision_exhausted',
      nodeKey: 'entry', attempt: { number: 2, limit: 3 },
      report: { text: 'x', truncated: false },
    }).ok).toBe(false);
    // Physical task/turn/message/artifact/run ids are never semantic node keys.
    for (const physical of ['wft_abc', 'wftn_abc', 'wfm_abc', 'wfa_abc', 'wfr_abc']) {
      expect(decodeWorkflowFailureDetail({
        schema: 1, code: 'agent_fail', source: 'workflow_fail',
        nodeKey: physical, report: { text: 'x', truncated: false },
      }).ok).toBe(false);
    }
    // Unknown fields, raw coordinates, and over-limit reports are rejected.
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'agent_fail', source: 'workflow_fail',
      nodeKey: 'entry', taskId: 'wft_abc',
      report: { text: 'x', truncated: false },
    }).ok).toBe(false);
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'agent_fail', source: 'workflow_fail',
      nodeKey: 'entry', report: { text: 'x'.repeat(maxBytes + 1), truncated: false },
    }).ok).toBe(false);
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'agent_fail', source: 'workflow_fail',
      nodeKey: 'entry', report: { text: '', truncated: false },
    }).ok).toBe(false);
    // Engine failures without a responsible node must use the closed fixed report.
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'run_timeout', source: 'engine',
      report: { text: 'custom model prose', truncated: false },
    }).ok).toBe(false);
  });

  it('decodes run_closure envelopes only when code, status, and detail match', () => {
    const detail = {
      schema: 1, code: 'agent_fail', source: 'workflow_fail',
      nodeKey: 'entry', report: { text: 'tool reason', truncated: false },
    };
    expect(decodeRunClosureEnvelope({
      kind: 'run_closure', schema: 1,
      reasonCode: 'agent_fail', terminalStatus: 'failed', detail,
    })).toMatchObject({ ok: true });
    // Payload-version envelope field from storage is accepted.
    expect(decodeRunClosureEnvelope({
      payloadVersion: 1, kind: 'run_closure', schema: 1,
      reasonCode: 'agent_fail', terminalStatus: 'failed', detail,
    })).toMatchObject({ ok: true });
    // Detail code must match the envelope reason; status must match the code mapping.
    expect(decodeRunClosureEnvelope({
      kind: 'run_closure', schema: 1,
      reasonCode: 'decision_missing', terminalStatus: 'failed', detail,
    }).ok).toBe(false);
    expect(decodeRunClosureEnvelope({
      kind: 'run_closure', schema: 1,
      reasonCode: 'required_target_cancelled', terminalStatus: 'failed', detail,
    }).ok).toBe(false);
    expect(unavailableWorkflowFailureDetail('run_timeout')).toMatchObject({
      schema: 1, code: 'run_timeout', source: 'engine',
      report: { text: WORKFLOW_FAILURE_UNAVAILABLE_REPORT, truncated: false },
    });
  });

  it('round-trips the fixed unavailable diagnostic for every reason code', () => {
    for (const code of WORKFLOW_FAIL_REASON_CODES) {
      const fallback = unavailableWorkflowFailureDetail(code);
      const decoded = decodeWorkflowFailureDetail(fallback);
      expect(decoded.ok, code).toBe(true);
      if (!decoded.ok) continue;
      expect(decoded.value).toEqual(fallback);
      // The unavailable envelope carries no attribution.
      expect(decoded.value).not.toHaveProperty('nodeKey');
      expect(decoded.value).not.toHaveProperty('attempt');
    }
    // An unavailable report with an extra nested field is rejected even
    // though its text matches the fixed diagnostic.
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'agent_fail', source: 'engine',
      report: {
        text: WORKFLOW_FAILURE_UNAVAILABLE_REPORT,
        truncated: false,
        artifactId: 'wfa_forged',
      },
    }).ok).toBe(false);
  });

  it('accepts versioned envelopes only at payload version 1', () => {
    const detail = {
      schema: 1, code: 'agent_fail', source: 'workflow_fail',
      nodeKey: 'entry', report: { text: 'tool reason', truncated: false },
    };
    const base = {
      kind: 'run_closure', schema: 1,
      reasonCode: 'agent_fail', terminalStatus: 'failed', detail,
    };
    expect(decodeRunClosureEnvelope(base).ok).toBe(true);
    expect(decodeRunClosureEnvelope({ ...base, payloadVersion: 1 }).ok).toBe(true);
    expect(decodeRunClosureEnvelope({ ...base, payloadVersion: 2 }).ok).toBe(false);
    expect(decodeRunClosureEnvelope({ ...base, payloadVersion: 0 }).ok).toBe(false);
  });

  it('rejects unavailable engine detail carrying attribution', () => {
    // A forged semantic node attribution on the unavailable diagnostic is
    // corrupt closure metadata, not the attribution-free fallback.
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'run_timeout', source: 'engine',
      nodeKey: 'worker',
      report: { text: WORKFLOW_FAILURE_UNAVAILABLE_REPORT, truncated: false },
    }).ok).toBe(false);
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'invalid_route', source: 'engine',
      componentKey: 'worker',
      report: { text: WORKFLOW_FAILURE_UNAVAILABLE_REPORT, truncated: false },
    }).ok).toBe(false);
  });

  it('rejects fixed engine reports with truncated metadata', () => {
    const fixed = WORKFLOW_ENGINE_FAILURE_REPORTS.run_timeout;
    expect(typeof fixed).toBe('string');
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'run_timeout', source: 'engine',
      report: { text: fixed, truncated: true },
    }).ok).toBe(false);
    expect(decodeWorkflowFailureDetail({
      schema: 1, code: 'run_timeout', source: 'engine',
      report: { text: WORKFLOW_FAILURE_UNAVAILABLE_REPORT, truncated: true },
    }).ok).toBe(false);
  });
});
