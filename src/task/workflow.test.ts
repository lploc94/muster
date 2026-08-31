import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKFLOW_POLICY,
  WORKFLOW_RUN_BUDGET_BOUNDS,
  WORKFLOW_FAIL_REASON_CODES,
  boundWorkflowFailReason,
  clampWorkflowRunBudgets,
  decodeStoredTopologyJson,
  decodeTopology,
  decodeWorkflowManifest,
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
      { name: 'verifiedPlan', kind: 'plan', from: 'verify' },
    ],
    nodes: [
      { nodeKey: 'plan', taskType: 'planner' },
      { nodeKey: 'research', taskType: 'research' },
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
      { name: 'leftReport', kind: 'report', from: 'leftResult' },
      { name: 'rightReport', kind: 'report', from: 'rightResult' },
    ],
    nodes: [
      { nodeKey: 'left', taskType: 'research' },
      { nodeKey: 'leftResult', taskType: 'review' },
      { nodeKey: 'right', taskType: 'research' },
      { nodeKey: 'rightResult', taskType: 'review' },
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
          name: 'report', semanticKind: 'report', terminalNodeId: 'inspect',
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

  it('accepts optional and required agent outcomes and complete execute outcomes', () => {
    const optional = oneNodeManifest();
    optional.nodes[0]!.outcome = {
      kind: 'agent',
      requireExplicitDisposition: false,
      next: { when: 'The report is complete.' },
    };
    expect(decodeWorkflowManifest(optional, 'inline').ok).toBe(true);
    expect(decodeWorkflowManifest(fanInManifest(), 'inline').ok).toBe(true);

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
    duplicateOutputName.outputs[1]!.name = 'leftReport';
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

  it('rejects invalid entry/output contracts and requires every terminal exactly once', () => {
    const downstreamInput = clone(fanInManifest());
    downstreamInput.inputs[0]!.to = 'verify';
    expectInvalidManifest(downstreamInput, /entry/i);

    const nonTerminalOutput = clone(fanInManifest());
    nonTerminalOutput.outputs[0]!.from = 'plan';
    expectInvalidManifest(nonTerminalOutput, /terminal/i);

    const missingTerminal = clone(multiSinkManifest());
    missingTerminal.outputs.pop();
    expectInvalidManifest(missingTerminal, /terminal.*export|unexported/i);

    const duplicateTerminal = clone(multiSinkManifest());
    duplicateTerminal.outputs[1]!.from = 'leftResult';
    expectInvalidManifest(duplicateTerminal, /terminal.*once|duplicate.*terminal/i);

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
    expectInvalidManifest(optionalWithoutNext, /NEXT/i);

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
    fanOut.nodes.push({ nodeKey: 'other', taskType: 'reviewer' });
    fanOut.edges.push({ from: 'plan', to: 'other', inputRef: 'plan' });
    fanOut.outputs.push({ name: 'other', kind: 'review', from: 'other' });
    expectInvalidManifest(fanOut, /fan-out/i);

    const isolated = clone(fanInManifest());
    isolated.nodes.push({ nodeKey: 'isolated', taskType: 'research' });
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
    expect(decodeStoredTopologyJson(validated.topologyJson)).toEqual({
      ok: true,
      topology: validated.definition.topology,
    });
    expect(validated.topologyJson).toContain('"kind":"workflow"');

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
      entryContracts: [{
        entryNodeId: 'inspect', inputRef: 'request', expectedArtifactKind: 'workflow_input',
      }],
    };
    const left = validateStartWorkflow({
      ...base,
      entryInputs: [{
        entryNodeId: 'inspect', inputRef: 'request', fromRun: 'prior-run', output: 'leftReport',
      }],
    });
    const right = validateStartWorkflow({
      ...base,
      entryInputs: [{
        entryNodeId: 'inspect', inputRef: 'request', fromRun: 'prior-run', output: 'rightReport',
      }],
    });
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.entryInputs).toEqual([{
      entryNodeId: 'inspect', inputRef: 'request', fromRun: 'prior-run', output: 'leftReport',
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
