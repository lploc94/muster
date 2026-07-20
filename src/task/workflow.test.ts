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
  deriveStartIdentities,
  entryNodeIds,
  fingerprintDefinition,
  makeGraphFanInDefinition,
  makeOneNodeDefinition,
  terminalNodeId,
  validateDefineWorkflow,
} from './workflow';

describe('workflow domain (one-node define)', () => {
  it('accepts a valid one-node topology and fingerprints stably', () => {
    const def = makeOneNodeDefinition();
    const validated = validateDefineWorkflow({
      definitionId: def.definitionId,
      version: def.version,
      name: def.name,
      topology: def.topology,
      createdAt: def.createdAt,
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
      definitionId: def.definitionId,
      version: def.version,
      name: def.name,
      topology: def.topology,
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
    expect(validateDefineWorkflow({
      definitionId: '',
      version: 1,
      name: 'x',
      topology: makeOneNodeDefinition().topology,
      createdAt: '2026-07-19T00:00:00.000Z',
    }).ok).toBe(false);
    expect(validateDefineWorkflow({
      definitionId: 'wf',
      version: 0,
      name: 'x',
      topology: makeOneNodeDefinition().topology,
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
    expect(defineWorkflowLedgerKey('wf-one', 1)).toBe('define_workflow:wf-one:1');
  });
});

describe('workflow domain (graph_v1 multi-node topology)', () => {
  it('accepts a two-producer fan-in graph and fingerprints stably', () => {
    const def = makeGraphFanInDefinition();
    const validated = validateDefineWorkflow({
      definitionId: def.definitionId,
      version: def.version,
      name: def.name,
      topology: def.topology,
      createdAt: def.createdAt,
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

    // Fingerprint ignores createdAt and is stable under edge reorder.
    const reordered = makeGraphFanInDefinition();
    if (reordered.topology.kind !== 'graph_v1') return;
    const edges = [...reordered.topology.edges].reverse();
    const nodes = [...reordered.topology.nodes].reverse();
    const again = validateDefineWorkflow({
      definitionId: reordered.definitionId,
      version: reordered.version,
      name: reordered.name,
      topology: { kind: 'graph_v1', nodes, edges },
      createdAt: '2099-01-01T00:00:00.000Z',
    });
    expect(again.ok && again.fingerprint).toBe(validated.fingerprint);
  });

  it('rejects fan-out, cycles, duplicate inputRef, missing route-to-gate, and terminal count', () => {
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

    // Multiple terminals: two nodes with no outgoing route.
    const multiTerminal = decodeGraphTopology({
      kind: 'graph_v1',
      nodes: baseNodes,
      edges: [
        { fromNodeId: 'p1', toNodeId: 'consumer', inputRef: 'a' },
        // p2 has no outgoing → second terminal alongside consumer
      ],
    });
    expect(multiTerminal.ok).toBe(false);
    if (!multiTerminal.ok) expect(multiTerminal.reason).toMatch(/terminal/i);

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
    const valid = validateDefineWorkflow({
      definitionId: 'wf-fan',
      version: 1,
      name: 'fan-in',
      topology: makeGraphFanInDefinition().topology,
      createdAt: '2026-07-19T00:00:00.000Z',
    });
    expect(valid.ok).toBe(true);

    const invalid = validateDefineWorkflow({
      definitionId: 'wf-fan',
      version: 1,
      name: 'fan-in',
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

});
