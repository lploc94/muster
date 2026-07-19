import { describe, expect, it } from 'vitest';
import {
  decodeOneNodeTopology,
  decodeStoredTopologyJson,
  defineWorkflowConflict,
  defineWorkflowCreated,
  defineWorkflowInvalid,
  defineWorkflowLedgerKey,
  defineWorkflowReplay,
  fingerprintDefinition,
  makeOneNodeDefinition,
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
    expect(validated.definition.topology.entryNodeId).toBe('entry');
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
