import { describe, expect, it } from 'vitest';
import {
  decodeGraphTopology,
  decodeOneNodeTopology,
  decodeStoredTopologyJson,
  decodeTopology,
  defineWorkflowConflict,
  defineWorkflowCreated,
  defineWorkflowInvalid,
  defineWorkflowLedgerKey,
  defineWorkflowReplay,
  deriveNextContributionMessageId,
  deriveNodeActivationIdentities,
  deriveProducerArtifactId,
  deriveProducerArtifactRevision,
  deriveFeedbackRoundId,
  deriveFeedbackRequestMessageId,
  deriveFeedbackResponseMessageId,
  deriveFeedbackTargetTurnId,
  deriveFeedbackTargetMessageId,
  deriveFeedbackResumeTurnId,
  deriveFeedbackResumeMessageId,
  deriveWorkflowStartContinuationId,
  deriveWorkflowStartResumeMessageId,
  deriveWorkflowStartResumeTurnId,
  deriveRunClosureFenceId,
  clampWorkflowRunBudgets,
  WORKFLOW_RUN_BUDGET_BOUNDS,
  WORKFLOW_FAIL_REASON_CODES,
  workflowRunAttentionCode,
  workflowRunTerminalStatusForReason,
  boundWorkflowFailReason,
  deriveStartIdentities,
  entryNodeIds,
  fingerprintDefinition,
  formatWorkflowEntryAggregate,
  makeGraphFanInDefinition,
  makeOneNodeDefinition,
  maximumWorkflowEntryAggregateBytes,
  terminalNodeIds,
  terminalNodeId,
  validateDefineWorkflow,
} from './workflow';
import { WORKFLOW_NODE_LABEL_MAX_LENGTH } from './workflow-types';

describe('workflow domain (one-node define)', () => {
  it('accepts detailed node instructions up to the public workflow label bound', () => {
    expect(decodeOneNodeTopology({
      kind: 'one_node_v1',
      nodes: [{ nodeId: 'entry', label: 'x'.repeat(300), taskType: 'research' }],
      entryNodeId: 'entry',
    }).ok).toBe(true);
    expect(decodeOneNodeTopology({
      kind: 'one_node_v1',
      nodes: [{ nodeId: 'entry', label: 'x'.repeat(WORKFLOW_NODE_LABEL_MAX_LENGTH + 1), taskType: 'research' }],
      entryNodeId: 'entry',
    }).ok).toBe(false);
  });

  it('accepts a valid one-node topology and fingerprints stably', () => {
    const def = makeOneNodeDefinition();
    const validated = validateDefineWorkflow({
      ...def,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.definition.topology.kind).toBe('one_node_v1');
    if (validated.definition.topology.kind === 'one_node_v1') {
      expect(validated.definition.topology.entryNodeId).toBe('entry');
    }
    expect(validated.fingerprint).toBe(fingerprintDefinition(def));
    expect(validated.topologyJson).toContain('one_node_v1');
    const again = validateDefineWorkflow({
      ...def,
      createdAt: '2099-01-01T00:00:00.000Z',
    });
    expect(again.ok && again.fingerprint).toBe(validated.fingerprint);
  });

  it('rejects multi-node, mismatched entry, foreign keys, and corrupt JSON', () => {
    expect(decodeOneNodeTopology({ kind: 'one_node_v1', nodes: [], entryNodeId: 'a' }).ok).toBe(false);
    expect(decodeOneNodeTopology({
      kind: 'one_node_v1',
      nodes: [{ nodeId: 'a' }, { nodeId: 'b' }],
      entryNodeId: 'a',
    }).ok).toBe(false);
    expect(decodeOneNodeTopology({
      kind: 'one_node_v1',
      nodes: [{ nodeId: 'a' }],
      entryNodeId: 'b',
    }).ok).toBe(false);
    expect(decodeOneNodeTopology({
      kind: 'one_node_v1',
      nodes: [{ nodeId: 'a', taskId: 'smuggle' }],
      entryNodeId: 'a',
    }).ok).toBe(false);
    expect(decodeOneNodeTopology({
      kind: 'two_node_v1',
      nodes: [{ nodeId: 'a' }],
      entryNodeId: 'a',
    }).ok).toBe(false);
    expect(decodeStoredTopologyJson('{not-json').ok).toBe(false);
    const definition = makeOneNodeDefinition();
    expect(validateDefineWorkflow({
      ...definition,
      definitionId: '',
      name: 'x',
      createdAt: '2026-07-19T00:00:00.000Z',
    }).ok).toBe(false);
    expect(validateDefineWorkflow({
      ...definition,
      definitionId: 'wf',
      version: 0,
      name: 'x',
      createdAt: '2026-07-19T00:00:00.000Z',
    }).ok).toBe(false);
  });

  it('shapes created/replay/conflict results without leaking SQL or paths', () => {
    const def = makeOneNodeDefinition();
    const fp = fingerprintDefinition(def);
    expect(defineWorkflowCreated(def, fp)).toMatchObject({
      ok: true, changed: true, definitionId: 'wf-one', version: 1, fingerprint: fp,
    });
    expect(defineWorkflowReplay(def, fp)).toMatchObject({
      ok: true, changed: false, replay: true, fingerprint: fp,
    });
    expect(defineWorkflowConflict('wf-one', 1)).toMatchObject({
      ok: false, conflict: true, reason: 'definition fingerprint conflict',
    });
    expect(defineWorkflowInvalid('invalid topology')).toMatchObject({
      ok: false, conflict: true, reason: 'invalid topology',
    });
    expect(defineWorkflowLedgerKey('wf-one', 1)).toBe('define_workflow:workspace:wf-one:1');
  });
});

describe('workflow domain (graph_v1 multi-node topology)', () => {
  it('accepts a two-producer fan-in graph and fingerprints stably', () => {
    const def = makeGraphFanInDefinition();
    const validated = validateDefineWorkflow({
      ...def,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.definition.topology.kind).toBe('graph_v1');
    if (validated.definition.topology.kind !== 'graph_v1') return;
    expect(validated.definition.topology.nodes).toHaveLength(3);
    expect(validated.definition.topology.edges).toHaveLength(2);
    expect(entryNodeIds(validated.definition.topology).sort()).toEqual(['p1', 'p2']);
    expect(terminalNodeId(validated.definition.topology)).toBe('consumer');
    expect(validated.fingerprint).toBe(fingerprintDefinition(def));
    expect(validated.topologyJson).toContain('graph_v1');
    expect(validated.topologyJson).toContain('inputRef');

    // Fingerprint ignores createdAt but preserves frozen definition ordering.
    const reordered = makeGraphFanInDefinition();
    if (reordered.topology.kind !== 'graph_v1') return;
    const edges = [...reordered.topology.edges].reverse();
    const nodes = [...reordered.topology.nodes].reverse();
    const again = validateDefineWorkflow({
      ...reordered,
      topology: { kind: 'graph_v1', nodes, edges },
      createdAt: '2099-01-01T00:00:00.000Z',
    });
    expect(again.ok && again.fingerprint).not.toBe(validated.fingerprint);
  });

  it('rejects fan-out, cycles, duplicate inputRef, missing route-to-gate, and zero terminals', () => {
    const baseNodes = [
      { nodeId: 'p1' },
      { nodeId: 'p2' },
      { nodeId: 'consumer' },
    ];

    // Fan-out: non-terminal with two outgoing routes.
    const fanOut = decodeGraphTopology({
      kind: 'graph_v1',
      nodes: [...baseNodes, { nodeId: 'c2' }],
      edges: [
        { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'a' },
        { fromNodeId: 'p1', toNodeId: 'c2', inputRef: 'b' },
        { fromNodeId: 'p2', toNodeId: 'consumer', inputRef: 'c' },
      ],
    });
    expect(fanOut.ok).toBe(false);
    if (!fanOut.ok) expect(fanOut.reason).toMatch(/fan-out/i);

    // Cycle.
    const cycle = decodeGraphTopology({
      kind: 'graph_v1',
      nodes: [{ nodeId: 'a' }, { nodeId: 'b' }],
      edges: [
        { fromNodeId: 'a', toNodeId: 'b', inputRef: 'in' },
        { fromNodeId: 'b', toNodeId: 'a', inputRef: 'back' },
      ],
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.reason).toMatch(/cycle/i);

    // Duplicate inputRef on the same consumer.
    const dup = decodeGraphTopology({
      kind: 'graph_v1',
      nodes: baseNodes,
      edges: [
        { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'same' },
        { fromNodeId: 'p2', toNodeId: 'consumer', inputRef: 'same' },
      ],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/duplicate inputRef/i);

    // Missing route-to-gate: empty inputRef.
    const missingRoute = decodeGraphTopology({
      kind: 'graph_v1',
      nodes: baseNodes,
      edges: [
        { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'a' },
        { fromNodeId: 'p2', toNodeId: 'consumer', inputRef: '' },
      ],
    });
    expect(missingRoute.ok).toBe(false);
    if (!missingRoute.ok) expect(missingRoute.reason).toMatch(/route-to-gate|inputRef/i);

    // Zero terminals: every node has an outgoing edge (implies cycle or multi-component loop).
    const zeroTerminal = decodeGraphTopology({
      kind: 'graph_v1',
      nodes: [{ nodeId: 'a' }, { nodeId: 'b' }],
      edges: [
        { fromNodeId: 'a', toNodeId: 'b', inputRef: 'x' },
        { fromNodeId: 'b', toNodeId: 'a', inputRef: 'y' },
      ],
    });
    expect(zeroTerminal.ok).toBe(false);

    // Multiple terminals: independent paths may end at separate sink nodes.
    const multiTerminal = decodeGraphTopology({
      kind: 'graph_v1',
      nodes: [...baseNodes, { nodeId: 'c2' }],
      edges: [
        { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'a' },
        { fromNodeId: 'p2', toNodeId: 'c2', inputRef: 'b' },
      ],
    });
    expect(multiTerminal.ok).toBe(true);
    if (multiTerminal.ok) {
      expect(terminalNodeIds(multiTerminal.topology)).toEqual(['consumer', 'c2']);
    }

    // Unknown edge endpoint.
    const unknown = decodeGraphTopology({
      kind: 'graph_v1',
      nodes: baseNodes,
      edges: [
        { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'a' },
        { fromNodeId: 'ghost', toNodeId: 'consumer', inputRef: 'b' },
      ],
    });
    expect(unknown.ok).toBe(false);

    // one_node_v1 decoder still rejects graph_v1 shape; union decoder accepts both.
    expect(decodeOneNodeTopology(makeGraphFanInDefinition().topology).ok).toBe(false);
    expect(decodeTopology(makeGraphFanInDefinition().topology).ok).toBe(true);
    expect(decodeTopology(makeOneNodeDefinition().topology).ok).toBe(true);
    expect(decodeStoredTopologyJson(JSON.stringify(makeGraphFanInDefinition().topology)).ok).toBe(true);
  });

  it('define path freezes graph_v1 without persisting rows on invalid shapes', () => {
    const definition = makeGraphFanInDefinition();
    const valid = validateDefineWorkflow({
      ...definition,
      createdAt: '2026-07-19T00:00:00.000Z',
    });
    expect(valid.ok).toBe(true);

    const invalid = validateDefineWorkflow({
      definitionId: 'wf-fan',
      version: 1,
      name: 'fan-in',
      entryContracts: definition.entryContracts,
      policy: definition.policy,
      scope: definition.scope,
      topology: {
        kind: 'graph_v1',
        nodes: [{ nodeId: 'a' }, { nodeId: 'b' }, { nodeId: 'c' }],
        edges: [
          { fromNodeId: 'a', toNodeId: 'c', inputRef: 'x' },
          { fromNodeId: 'a', toNodeId: 'b', inputRef: 'y' }, // fan-out
        ],
      },
      createdAt: '2026-07-19T00:00:00.000Z',
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toMatch(/fan-out/i);
  });

  it('accepts the exact maximum entry aggregate and rejects one byte less', () => {
    const definition = makeOneNodeDefinition();
    const entryContracts = [
      { entryNodeId: 'entry', inputRef: 'request', expectedArtifactKind: 'text' },
    ];
    const maxArtifactBytes = 8;
    const exactAggregateBytes = maximumWorkflowEntryAggregateBytes(
      entryContracts,
      maxArtifactBytes,
    );
    expect(Buffer.byteLength(formatWorkflowEntryAggregate([
      { inputRef: 'request', value: 'éééé' },
    ]), 'utf8')).toBe(exactAggregateBytes);

    const exact = validateDefineWorkflow({
      ...definition,
      entryContracts,
      policy: { ...definition.policy, maxArtifactBytes, maxAggregateBytes: exactAggregateBytes },
    });
    expect(exact.ok).toBe(true);

    const overflow = validateDefineWorkflow({
      ...definition,
      entryContracts,
      policy: { ...definition.policy, maxArtifactBytes, maxAggregateBytes: exactAggregateBytes - 1 },
    });
    expect(overflow).toEqual({
      ok: false,
      reason: `entry contract aggregate exceeds policy: maxAggregateBytes must be at least ${exactAggregateBytes} for entry "entry" when maxArtifactBytes is ${maxArtifactBytes}`,
    });

    const engineStartBytes = maximumWorkflowEntryAggregateBytes([], maxArtifactBytes);
    const emptyEntryOverflow = validateDefineWorkflow({
      ...definition,
      policy: { ...definition.policy, maxArtifactBytes, maxAggregateBytes: engineStartBytes - 1 },
    });
    expect(emptyEntryOverflow).toEqual({
      ok: false,
      reason: `entry contract aggregate exceeds policy: maxAggregateBytes must be at least ${engineStartBytes} for entry "entry" when maxArtifactBytes is ${maxArtifactBytes}`,
    });
  });

  it('reports the accepted policy range for an invalid feedback budget', () => {
    const definition = makeOneNodeDefinition();
    const invalid = validateDefineWorkflow({
      ...definition,
      policy: { ...definition.policy, maxFeedbackRoundsPerRun: 0 },
    });
    expect(invalid).toEqual({
      ok: false,
      reason: 'invalid policy maxFeedbackRoundsPerRun: expected an integer from 1 to 32',
    });
  });


  it('derives multi-node start identities: one gate per node, entry activations only', () => {
    const def = makeGraphFanInDefinition();
    const entries = entryNodeIds(def.topology);
    const all = def.topology.nodes.map((n) => n.nodeId);
    const primary = entries[0]!;
    const a = deriveStartIdentities({
      definitionId: def.definitionId,
      version: def.version,
      startIdempotencyKey: 'start-fan-1',
      entryNodeId: primary,
      entryNodeIds: entries,
      allNodeIds: all,
    });
    const b = deriveStartIdentities({
      definitionId: def.definitionId,
      version: def.version,
      startIdempotencyKey: 'start-fan-1',
      entryNodeId: primary,
      entryNodeIds: [...entries].reverse(),
      allNodeIds: [...all].reverse(),
    });
    expect(a.runId).toBe(b.runId);
    expect(a.nodeGates).toHaveLength(3);
    expect(a.entries).toHaveLength(2);
    expect(a.entries.map((e) => e.nodeId).sort()).toEqual([...entries].sort());
    // Consumer has a gate but no entry activation.
    const consumerGate = a.nodeGates.find((g) => g.nodeId === 'consumer');
    expect(consumerGate).toBeDefined();
    expect(a.entries.find((e) => e.nodeId === 'consumer')).toBeUndefined();
    // One-node still uses S01-stable single-entry material.
    const one = deriveStartIdentities({
      definitionId: 'wf-one',
      version: 1,
      startIdempotencyKey: 'k',
      entryNodeId: 'entry',
    });
    expect(one.entries).toHaveLength(1);
    expect(one.nodeGates).toHaveLength(1);
    expect(one.entryTaskId).toBe(one.entries[0]!.taskId);
  });

  it('derives durable NEXT contribution message ids and deterministic artifact revisions', () => {
    const runId = 'wfr_abc';
    const gateId = 'wfg_gate';
    const a = deriveNextContributionMessageId(runId, gateId, 'from_p1', 'p1');
    const b = deriveNextContributionMessageId(runId, gateId, 'from_p1', 'p1');
    const otherRef = deriveNextContributionMessageId(runId, gateId, 'from_p2', 'p1');
    const otherProducer = deriveNextContributionMessageId(runId, gateId, 'from_p1', 'p2');
    expect(a).toBe(b);
    expect(a.startsWith('wfrm_')).toBe(true);
    expect(a).not.toBe(otherRef);
    expect(a).not.toBe(otherProducer);

    // Distinct from activation / artifact identity namespaces.
    const activation = deriveNodeActivationIdentities(runId, 'p1');
    const artifactId = deriveProducerArtifactId(runId, 'p1');
    expect(a).not.toBe(activation.messageId);
    expect(a).not.toBe(artifactId);

    // Contribution-scoped revision is fixed (not priorMax+1), so redelivery reuses it.
    expect(deriveProducerArtifactRevision('updated')).toBe(1);
    expect(deriveProducerArtifactRevision('unchanged')).toBe(1);
    expect(deriveProducerArtifactRevision('updated')).toBe(
      deriveProducerArtifactRevision('unchanged'),
    );
  });

  it('derives durable PREV feedback/round/resume identities without leaking bodies', () => {
    const runId = 'wfr_abc';
    const requesterNodeId = 'consumer';
    const requesterTurnId = 'wftn_req_1';
    const targetNodeId = 'p1';

    const roundA = deriveFeedbackRoundId(runId, requesterNodeId, requesterTurnId);
    const roundB = deriveFeedbackRoundId(runId, requesterNodeId, requesterTurnId);
    expect(roundA).toBe(roundB);
    expect(roundA.startsWith('wfrd_')).toBe(true);
    expect(roundA).not.toBe(
      deriveFeedbackRoundId(runId, requesterNodeId, 'wftn_other'),
    );

    const reqA = deriveFeedbackRequestMessageId(runId, roundA, targetNodeId);
    const reqB = deriveFeedbackRequestMessageId(runId, roundA, targetNodeId);
    expect(reqA).toBe(reqB);
    expect(reqA.startsWith('wfrm_')).toBe(true);
    expect(reqA).not.toBe(deriveFeedbackRequestMessageId(runId, roundA, 'p2'));
    expect(reqA).not.toBe(deriveFeedbackResponseMessageId(runId, roundA, targetNodeId));

    const resp = deriveFeedbackResponseMessageId(runId, roundA, targetNodeId);
    expect(resp.startsWith('wfrm_')).toBe(true);
    expect(resp).not.toBe(reqA);

    const turnId = deriveFeedbackTargetTurnId(runId, roundA, targetNodeId);
    const msgId = deriveFeedbackTargetMessageId(runId, roundA, targetNodeId);
    expect(turnId.startsWith('wftn_')).toBe(true);
    expect(msgId.startsWith('wfm_')).toBe(true);
    expect(turnId).not.toBe(msgId);

    const resumeTurn = deriveFeedbackResumeTurnId(runId, roundA);
    const resumeMsg = deriveFeedbackResumeMessageId(runId, roundA);
    expect(resumeTurn.startsWith('wftn_')).toBe(true);
    expect(resumeMsg.startsWith('wfm_')).toBe(true);
    expect(resumeTurn).toBe(deriveFeedbackResumeTurnId(runId, roundA));
    expect(resumeTurn).not.toBe(turnId);

    // Namespaces stay distinct from NEXT contribution fences.
    const next = deriveNextContributionMessageId(runId, 'wfg_gate', 'from_p1', 'p1');
    expect(reqA).not.toBe(next);
    expect(resp).not.toBe(next);
  });

  it('derives distinct deterministic top-level workflow continuation identities', () => {
    const continuation = deriveWorkflowStartContinuationId('wfr_abc', 'turn_caller');
    const resumeTurn = deriveWorkflowStartResumeTurnId('wfr_abc', 'turn_caller');
    const resumeMessage = deriveWorkflowStartResumeMessageId('wfr_abc', 'turn_caller');

    expect(continuation).toBe(deriveWorkflowStartContinuationId('wfr_abc', 'turn_caller'));
    expect(resumeTurn).toBe(deriveWorkflowStartResumeTurnId('wfr_abc', 'turn_caller'));
    expect(resumeMessage).toBe(deriveWorkflowStartResumeMessageId('wfr_abc', 'turn_caller'));
    expect(continuation.startsWith('wfcn_')).toBe(true);
    expect(resumeTurn.startsWith('wftn_')).toBe(true);
    expect(resumeMessage.startsWith('wfm_')).toBe(true);
    expect(new Set([continuation, resumeTurn, resumeMessage]).size).toBe(3);
    expect(continuation).not.toBe(
      deriveWorkflowStartContinuationId('wfr_abc', 'turn_other'),
    );
  });


  it('derives durable fail-fast closure identities, bounds budgets, and maps reason codes', () => {
    const runId = 'wfr_abc';
    const fenceFailedA = deriveRunClosureFenceId(runId, 'failed');
    const fenceFailedB = deriveRunClosureFenceId(runId, 'failed');
    const fenceCancelled = deriveRunClosureFenceId(runId, 'cancelled');
    expect(fenceFailedA).toBe(fenceFailedB);
    expect(fenceFailedA.startsWith('wfc_')).toBe(true);
    expect(fenceCancelled.startsWith('wfc_')).toBe(true);
    expect(fenceFailedA).not.toBe(fenceCancelled);
    expect(fenceFailedA).not.toBe(deriveRunClosureFenceId('wfr_other', 'failed'));

    expect(workflowRunAttentionCode('failed')).toBe('workflow_run_failed');
    expect(workflowRunAttentionCode('cancelled')).toBe('workflow_run_cancelled');

    expect(workflowRunTerminalStatusForReason('agent_fail')).toBe('failed');
    expect(workflowRunTerminalStatusForReason('invalid_route')).toBe('failed');
    expect(workflowRunTerminalStatusForReason('run_timeout')).toBe('failed');
    expect(workflowRunTerminalStatusForReason('aggregate_too_large')).toBe('failed');
    expect(workflowRunTerminalStatusForReason('feedback_budget_exhausted')).toBe('failed');
    expect(workflowRunTerminalStatusForReason('turn_budget_exhausted')).toBe('failed');
    expect(workflowRunTerminalStatusForReason('required_target_cancelled')).toBe('cancelled');

    expect(WORKFLOW_FAIL_REASON_CODES).toContain('agent_fail');
    expect(WORKFLOW_FAIL_REASON_CODES).toContain('required_target_cancelled');

    const defaults = clampWorkflowRunBudgets();
    expect(defaults.maxFeedbackRoundsPerRun).toBe(WORKFLOW_RUN_BUDGET_BOUNDS.defaultMaxFeedbackRoundsPerRun);
    expect(defaults.maxWorkflowTurnsPerRun).toBe(WORKFLOW_RUN_BUDGET_BOUNDS.defaultMaxWorkflowTurnsPerRun);

    const clampedHigh = clampWorkflowRunBudgets({
      maxFeedbackRoundsPerRun: 10_000,
      maxWorkflowTurnsPerRun: 10_000,
    });
    expect(clampedHigh.maxFeedbackRoundsPerRun).toBe(WORKFLOW_RUN_BUDGET_BOUNDS.maxFeedbackRoundsPerRun);
    expect(clampedHigh.maxWorkflowTurnsPerRun).toBe(WORKFLOW_RUN_BUDGET_BOUNDS.maxWorkflowTurnsPerRun);

    const clampedLow = clampWorkflowRunBudgets({
      maxFeedbackRoundsPerRun: 0,
      maxWorkflowTurnsPerRun: -1,
    });
    expect(clampedLow.maxFeedbackRoundsPerRun).toBe(WORKFLOW_RUN_BUDGET_BOUNDS.minFeedbackRoundsPerRun);
    expect(clampedLow.maxWorkflowTurnsPerRun).toBe(WORKFLOW_RUN_BUDGET_BOUNDS.minWorkflowTurnsPerRun);

    expect(boundWorkflowFailReason(undefined)).toBeUndefined();
    expect(boundWorkflowFailReason('  ')).toBeUndefined();
    const long = 'x'.repeat(2_000);
    const bounded = boundWorkflowFailReason(long);
    expect(bounded).toBeDefined();
    expect(Buffer.byteLength(bounded!, 'utf8')).toBeLessThanOrEqual(
      WORKFLOW_RUN_BUDGET_BOUNDS.maxFailReasonBytes,
    );
  });

});
