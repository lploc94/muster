import { describe, expect, it } from 'vitest';
import {
  decodeWorkflowCompositeSpec,
  expandWorkflowComposite,
  fingerprintWorkflowComposite,
  reduceWorkflowPolicies,
  type WorkflowCompositeComponentAuthority,
} from './workflow-composite-codec';
import {
  DEFAULT_WORKFLOW_POLICY,
  decodeWorkflowManifest,
  fingerprintDefinition,
  projectWorkflowOutputs,
  validateDefineWorkflow,
} from './workflow';
import type {
  WorkflowCompositeSpec,
  WorkflowDefinition,
  WorkflowPolicy,
} from './workflow-types';

type RecordValue = Record<string, any>;

const LEFT_REF = `workflow-${'a'.repeat(32)}@1`;
const RIGHT_REF = `workflow-${'b'.repeat(32)}@1`;

function agent(nodeKey: string, next = 'The result is ready.'): RecordValue {
  return {
    nodeKey,
    taskType: 'research',
    outcome: {
      kind: 'agent',
      requireExplicitDisposition: true,
      next: { when: next },
      fail: { when: 'The result cannot be produced.' },
    },
  };
}

function manifest(input: {
  name: string;
  nodes: RecordValue[];
  inputs?: RecordValue[];
  outputs: RecordValue[];
  edges?: RecordValue[];
}): RecordValue {
  return {
    schema: 'muster.workflow/v2',
    name: input.name,
    inputs: input.inputs ?? [],
    outputs: input.outputs,
    nodes: input.nodes,
    edges: input.edges ?? [],
  };
}

function definition(raw: unknown, definitionId: string, policy: WorkflowPolicy = DEFAULT_WORKFLOW_POLICY): WorkflowDefinition {
  const decoded = decodeWorkflowManifest(raw, 'inline');
  if (!decoded.ok) throw new Error(decoded.reason);
  const validated = validateDefineWorkflow({
    definitionId,
    version: 1,
    name: decoded.name,
    topology: decoded.topology,
    entryContracts: decoded.entryContracts,
    policy,
    scope: { kind: 'workspace' },
    createdAt: '2026-09-04T00:00:00.000Z',
  });
  if (!validated.ok) throw new Error(validated.reason);
  return validated.definition;
}

function componentAuthority(
  key: string,
  workflowRef: string,
  value: WorkflowDefinition,
): WorkflowCompositeComponentAuthority {
  return {
    key,
    source: {
      kind: 'workflow',
      workflowRef,
      fingerprint: fingerprintDefinition(value),
    },
    definition: value,
  };
}

function twoComponentAssembly(): {
  raw: RecordValue;
  left: WorkflowDefinition;
  right: WorkflowDefinition;
} {
  const leftRaw = manifest({
    name: 'Left',
    nodes: [agent('entry')],
    inputs: [{ name: 'request', kind: 'request', to: 'entry', inputRef: 'request' }],
    outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
  });
  const rightRaw = manifest({
    name: 'Right',
    nodes: [agent('entry')],
    inputs: [{ name: 'upstream', kind: 'result', to: 'entry', inputRef: 'upstream' }],
    outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
  });
  const left = definition(leftRaw, 'workflow-' + 'a'.repeat(32));
  const right = definition(rightRaw, 'workflow-' + 'b'.repeat(32));
  return {
    raw: {
      components: [
        { key: 'left', workflow: LEFT_REF },
        { key: 'right', workflow: RIGHT_REF },
      ],
      connections: [{
        from: { component: 'left', output: 'result' },
        to: { component: 'right', input: 'upstream' },
      }],
      inputs: [{
        name: 'request',
        to: { component: 'left', input: 'request' },
      }],
      outputs: [
        { name: 'leftResult', from: { component: 'left', output: 'result' } },
        { name: 'rightResult', from: { component: 'right', output: 'result' } },
      ],
    },
    left,
    right,
  };
}

function mappingAssembly(): {
  base: RecordValue;
  alternate: RecordValue;
  source: WorkflowDefinition;
  first: WorkflowDefinition;
  second: WorkflowDefinition;
} {
  const sourceRaw = manifest({
    name: 'Mapping source',
    nodes: [agent('entryA'), agent('resultA'), agent('entryB'), agent('resultB')],
    edges: [
      { from: 'entryA', to: 'resultA', inputRef: 'fromA' },
      { from: 'entryB', to: 'resultB', inputRef: 'fromB' },
    ],
    inputs: [
      { name: 'requestA', kind: 'request', to: 'entryA', inputRef: 'requestA' },
      { name: 'requestB', kind: 'request', to: 'entryB', inputRef: 'requestB' },
    ],
    outputs: [
      { name: 'entryAResult', kind: 'result', from: 'entryA' },
      { name: 'firstResult', kind: 'result', from: 'resultA' },
      { name: 'entryBResult', kind: 'result', from: 'entryB' },
      { name: 'secondResult', kind: 'result', from: 'resultB' },
    ],
  });
  const firstRaw = manifest({
    name: 'First sink',
    nodes: [agent('entry')],
    inputs: [{ name: 'input', kind: 'result', to: 'entry', inputRef: 'input' }],
    outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
  });
  const secondRaw = manifest({
    name: 'Second sink',
    nodes: [agent('entry')],
    inputs: [{ name: 'input', kind: 'result', to: 'entry', inputRef: 'input' }],
    outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
  });
  const source = definition(sourceRaw, `workflow-${'f'.repeat(32)}`);
  const first = definition(firstRaw, `workflow-${'0'.repeat(32)}`);
  const second = definition(secondRaw, `workflow-${'1'.repeat(32)}`);
  const components = [
    { key: 'source', workflow: `workflow-${'f'.repeat(32)}@1` },
    { key: 'first', workflow: `workflow-${'0'.repeat(32)}@1` },
    { key: 'second', workflow: `workflow-${'1'.repeat(32)}@1` },
  ];
  const outputs = [
    { name: 'entryAResult', from: { component: 'source', output: 'entryAResult' } },
    { name: 'firstSourceResult', from: { component: 'source', output: 'firstResult' } },
    { name: 'entryBResult', from: { component: 'source', output: 'entryBResult' } },
    { name: 'secondSourceResult', from: { component: 'source', output: 'secondResult' } },
    { name: 'firstResult', from: { component: 'first', output: 'result' } },
    { name: 'secondResult', from: { component: 'second', output: 'result' } },
  ];
  return {
    base: {
      components,
      connections: [
        {
          from: { component: 'source', output: 'firstResult' },
          to: { component: 'first', input: 'input' },
        },
        {
          from: { component: 'source', output: 'secondResult' },
          to: { component: 'second', input: 'input' },
        },
      ],
      inputs: [
        { name: 'requestA', to: { component: 'source', input: 'requestA' } },
        { name: 'requestB', to: { component: 'source', input: 'requestB' } },
      ],
      outputs,
    },
    alternate: {
      components,
      connections: [
        {
          from: { component: 'source', output: 'firstResult' },
          to: { component: 'second', input: 'input' },
        },
        {
          from: { component: 'source', output: 'secondResult' },
          to: { component: 'first', input: 'input' },
        },
      ],
      inputs: [
        { name: 'requestA', to: { component: 'source', input: 'requestA' } },
        { name: 'requestB', to: { component: 'source', input: 'requestB' } },
      ],
      outputs,
    },
    source,
    first,
    second,
  };
}

function chainDefinition(definitionId: string, count: number): WorkflowDefinition {
  const nodes = Array.from({ length: count }, (_, index) => agent(`node${index}`));
  const edges = Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
    from: `node${index}`,
    to: `node${index + 1}`,
    inputRef: `from${index}`,
  }));
  const outputs = Array.from({ length: count }, (_, index) => ({
    name: `result${index}`,
    kind: 'result',
    from: `node${index}`,
  }));
  return definition(manifest({
    name: `Chain ${count}`,
    nodes,
    edges,
    outputs,
  }), definitionId);
}

describe('all-node semantic workflow outputs', () => {
  it('accepts every node as an exported result and derives terminal/checkpoint roles', () => {
    const raw = manifest({
      name: 'Checkpointed workflow',
      nodes: [agent('plan'), agent('verify')],
      edges: [{ from: 'plan', to: 'verify', inputRef: 'plan' }],
      outputs: [
        { name: 'draft', kind: 'plan', from: 'plan' },
        { name: 'verified', kind: 'plan', from: 'verify' },
      ],
    });
    const decoded = decodeWorkflowManifest(raw, 'inline');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.topology.outputs).toEqual([
      { name: 'draft', semanticKind: 'plan', sourceNodeId: 'plan' },
      { name: 'verified', semanticKind: 'plan', sourceNodeId: 'verify' },
    ]);
    expect(projectWorkflowOutputs(decoded.topology)).toEqual([
      { name: 'draft', semanticKind: 'plan', sourceNodeId: 'plan', role: 'checkpoint' },
      { name: 'verified', semanticKind: 'plan', sourceNodeId: 'verify', role: 'terminal' },
    ]);
  });

  it('rejects missing, duplicate, and unknown node exports', () => {
    const base = manifest({
      name: 'Exports',
      nodes: [agent('first'), agent('second')],
      edges: [{ from: 'first', to: 'second', inputRef: 'first' }],
      outputs: [
        { name: 'first', kind: 'result', from: 'first' },
        { name: 'second', kind: 'result', from: 'second' },
      ],
    });
    const missing = structuredClone(base) as RecordValue;
    missing.outputs.pop();
    expect(decodeWorkflowManifest(missing, 'inline')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/every node|unexported/i),
    });

    const duplicate = structuredClone(base) as RecordValue;
    duplicate.outputs[1].from = 'first';
    expect(decodeWorkflowManifest(duplicate, 'inline')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/node.*once|duplicate.*node|output/i),
    });

    const unknown = structuredClone(base) as RecordValue;
    unknown.outputs[1].from = 'missing';
    expect(decodeWorkflowManifest(unknown, 'inline')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unknown|output/i),
    });
  });
});

describe('closed workflow composite codec', () => {
  it('decodes and deterministically expands saved components with colliding local identities', () => {
    const assembly = twoComponentAssembly();
    const decoded = decodeWorkflowCompositeSpec(assembly.raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const expanded = expandWorkflowComposite({
      spec: decoded.spec,
      components: [
        componentAuthority('left', LEFT_REF, assembly.left),
        componentAuthority('right', RIGHT_REF, assembly.right),
      ],
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.topology.nodes).toHaveLength(2);
    expect(new Set(expanded.topology.nodes.map((node) => node.nodeId)).size).toBe(2);
    expect(expanded.topology.edges).toHaveLength(1);
    expect(expanded.topology.inputs).toEqual([{
      name: 'request',
      semanticKind: 'request',
      entryNodeId: expanded.topology.inputs[0]!.entryNodeId,
      inputRef: 'request',
    }]);
    expect(expanded.topology.outputs.map((output) => output.name)).toEqual(['leftResult', 'rightResult']);
    expect(expanded.outputs.map((output) => ({
      name: output.name,
      componentKey: output.componentKey,
      localNodeKey: output.localNodeKey,
      role: output.role,
    }))).toEqual([
      { name: 'leftResult', componentKey: 'left', localNodeKey: 'entry', role: 'checkpoint' },
      { name: 'rightResult', componentKey: 'right', localNodeKey: 'entry', role: 'terminal' },
    ]);
    expect(expanded.nodeProvenance.map((node) => [node.componentKey, node.localNodeKey])).toEqual([
      ['left', 'entry'],
      ['right', 'entry'],
    ]);
  });

  it('includes inline one-node components and maps every component output exactly once', () => {
    const inline = manifest({
      name: 'Inline sink',
      nodes: [agent('entry')],
      inputs: [{ name: 'input', kind: 'result', to: 'entry', inputRef: 'input' }],
      outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
    });
    const saved = manifest({
      name: 'Saved source',
      nodes: [agent('entry')],
      inputs: [{ name: 'request', kind: 'request', to: 'entry', inputRef: 'request' }],
      outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
    });
    const savedDefinition = definition(saved, 'workflow-' + 'c'.repeat(32));
    const raw = {
      components: [
        { key: 'saved', workflow: `workflow-${'c'.repeat(32)}@1` },
        { key: 'inline', manifest: inline },
      ],
      connections: [{
        from: { component: 'saved', output: 'result' },
        to: { component: 'inline', input: 'input' },
      }],
      inputs: [{ name: 'request', to: { component: 'saved', input: 'request' } }],
      outputs: [
        { name: 'source', from: { component: 'saved', output: 'result' } },
        { name: 'final', from: { component: 'inline', output: 'result' } },
      ],
    };
    const decoded = decodeWorkflowCompositeSpec(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const expanded = expandWorkflowComposite({
      spec: decoded.spec,
      components: [
        componentAuthority('saved', `workflow-${'c'.repeat(32)}@1`, savedDefinition),
      ],
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.components.map((component) => component.key)).toEqual(['saved', 'inline']);
    expect(expanded.topology.outputs.map((output) => output.name)).toEqual(['source', 'final']);
  });

  it('rejects supplied inline authority that does not match the requested manifest', () => {
    const inline = manifest({
      name: 'Inline authority',
      nodes: [agent('entry')],
      outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
    });
    const decoded = decodeWorkflowCompositeSpec({
      components: [{ key: 'inline', manifest: inline }],
      connections: [],
      inputs: [],
      outputs: [{ name: 'result', from: { component: 'inline', output: 'result' } }],
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const matching = definition(inline, `workflow-${'d'.repeat(32)}`);
    expect(expandWorkflowComposite({
      spec: decoded.spec,
      components: [{
        key: 'inline',
        source: { kind: 'inline' },
        definition: matching,
      }],
    })).toMatchObject({ ok: true });

    const altered = manifest({
      name: 'Inline authority',
      nodes: [agent('entry', 'A different executable result.')],
      outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
    });
    const mismatched = definition(altered, `workflow-${'e'.repeat(32)}`);
    expect(expandWorkflowComposite({
      spec: decoded.spec,
      components: [{
        key: 'inline',
        source: { kind: 'inline' },
        definition: mismatched,
      }],
    })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/match|authority|inline/i),
    });
  });

  it('rejects unknown, mutable, recursive, incomplete, ambiguous, and multi-node sources', () => {
    const assembly = twoComponentAssembly();
    const cases: Array<[string, RecordValue]> = [
      ['unknown field', { ...assembly.raw, extra: true }],
      ['duplicate component key', {
        ...assembly.raw,
        components: [{ key: 'left', workflow: LEFT_REF }, { key: 'left', workflow: RIGHT_REF }],
      }],
      ['mutable predefined ref', {
        ...assembly.raw,
        components: [{ key: 'left', predefinedWorkflowRef: `pwf_${'a'.repeat(32)}` }, { key: 'right', workflow: RIGHT_REF }],
      }],
      ['recursive source', {
        ...assembly.raw,
        components: [{ key: 'left', workflow: LEFT_REF }, { key: 'right', composite: {} }],
      }],
      ['duplicate output slot', {
        ...assembly.raw,
        outputs: [assembly.raw.outputs[0], { name: 'other', from: { component: 'left', output: 'result' } }],
      }],
      ['unknown connection component', {
        ...assembly.raw,
        connections: [{ from: { component: 'missing', output: 'result' }, to: { component: 'right', input: 'upstream' } }],
      }],
      ['unknown connection endpoint', {
        ...assembly.raw,
        connections: [{ from: { component: 'left', output: 'missing' }, to: { component: 'right', input: 'upstream' } }],
      }],
    ];
    for (const [name, raw] of cases) {
      const result = decodeWorkflowCompositeSpec(raw);
      if (name === 'unknown connection endpoint') {
        expect(result).toMatchObject({ ok: true });
        if (result.ok) {
          expect(expandWorkflowComposite({
            spec: result.spec,
            components: [
              componentAuthority('left', LEFT_REF, assembly.left),
              componentAuthority('right', RIGHT_REF, assembly.right),
            ],
          })).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown|interface/i) });
        }
      } else {
        expect(result, name).toMatchObject({
          ok: false,
          reason: expect.any(String),
        });
      }
    }

    const missingOutput = decodeWorkflowCompositeSpec({
      ...assembly.raw,
      outputs: [assembly.raw.outputs[0]],
    });
    expect(missingOutput).toMatchObject({ ok: true });
    if (missingOutput.ok) {
      expect(expandWorkflowComposite({
        spec: missingOutput.spec,
        components: [
          componentAuthority('left', LEFT_REF, assembly.left),
          componentAuthority('right', RIGHT_REF, assembly.right),
        ],
      })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/output|mapped/i),
      });
    }

    const multiNodeInline = manifest({
      name: 'Too large inline component',
      nodes: [agent('one'), agent('two')],
      edges: [{ from: 'one', to: 'two', inputRef: 'one' }],
      outputs: [
        { name: 'one', kind: 'result', from: 'one' },
        { name: 'two', kind: 'result', from: 'two' },
      ],
    });
    const inlineResult = decodeWorkflowCompositeSpec({
      components: [{ key: 'inline', manifest: multiNodeInline }],
      connections: [],
      inputs: [],
      outputs: [
        { name: 'one', from: { component: 'inline', output: 'one' } },
        { name: 'two', from: { component: 'inline', output: 'two' } },
      ],
    });
    expect(inlineResult).toMatchObject({ ok: false, reason: expect.stringMatching(/one node|inline/i) });

    const recursive = { ...assembly.left, authorityKind: 'composite' } as WorkflowDefinition;
    const recursiveDecoded = decodeWorkflowCompositeSpec(assembly.raw);
    expect(recursiveDecoded.ok).toBe(true);
    if (recursiveDecoded.ok) {
      expect(expandWorkflowComposite({
        spec: recursiveDecoded.spec,
        components: [
          componentAuthority('left', LEFT_REF, recursive),
          componentAuthority('right', RIGHT_REF, assembly.right),
        ],
      })).toMatchObject({ ok: false, reason: expect.stringMatching(/invalid|recursive|composite/i) });
    }
  });

  it('rejects a valid-interface cross-component fan-out and flattened aggregate overflow', () => {
    const sourceRaw = manifest({
      name: 'Fan-out source',
      nodes: [agent('source'), agent('sink')],
      edges: [{ from: 'source', to: 'sink', inputRef: 'source' }],
      outputs: [
        { name: 'sourceResult', kind: 'result', from: 'source' },
        { name: 'sinkResult', kind: 'result', from: 'sink' },
      ],
    });
    const destinationRaw = manifest({
      name: 'Fan-out destination',
      nodes: [agent('entry')],
      inputs: [
        { name: 'first', kind: 'result', to: 'entry', inputRef: 'first' },
        { name: 'second', kind: 'result', to: 'entry', inputRef: 'second' },
      ],
      outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
    });
    const source = definition(sourceRaw, `workflow-${'1'.repeat(32)}`);
    const destination = definition(destinationRaw, `workflow-${'2'.repeat(32)}`);
    const sourceRef = `workflow-${'1'.repeat(32)}@1`;
    const destinationRef = `workflow-${'2'.repeat(32)}@1`;
    const baseRaw = {
      components: [
        { key: 'source', workflow: sourceRef },
        { key: 'destination', workflow: destinationRef },
      ],
      connections: [{
        from: { component: 'source', output: 'sourceResult' },
        to: { component: 'destination', input: 'first' },
      }],
      inputs: [],
      outputs: [
        { name: 'sourceResult', from: { component: 'source', output: 'sourceResult' } },
        { name: 'sinkResult', from: { component: 'source', output: 'sinkResult' } },
        { name: 'destinationResult', from: { component: 'destination', output: 'result' } },
      ],
    };
    const base = decodeWorkflowCompositeSpec(baseRaw);
    expect(base.ok).toBe(true);
    if (base.ok) {
      const fanOut = {
        ...base.spec,
        connections: [
          ...base.spec.connections,
          {
            from: { component: 'source', output: 'sourceResult' },
            to: { component: 'destination', input: 'second' },
          },
        ],
      } satisfies WorkflowCompositeSpec;
      expect(expandWorkflowComposite({
        spec: fanOut,
        components: [
          componentAuthority('source', sourceRef, source),
          componentAuthority('destination', destinationRef, destination),
        ],
      })).toMatchObject({ ok: false, reason: expect.stringMatching(/fan-out/i) });
    }

    const largeLeft = chainDefinition(`workflow-${'3'.repeat(32)}`, 64);
    const largeRight = chainDefinition(`workflow-${'4'.repeat(32)}`, 64);
    const largeLeftRef = `workflow-${'3'.repeat(32)}@1`;
    const largeRightRef = `workflow-${'4'.repeat(32)}@1`;
    const largeSpec: WorkflowCompositeSpec = {
      components: [
        {
          key: 'left',
          workflow: { workflowRef: largeLeftRef, definitionId: largeLeft.definitionId, version: largeLeft.version },
        },
        {
          key: 'right',
          workflow: { workflowRef: largeRightRef, definitionId: largeRight.definitionId, version: largeRight.version },
        },
      ],
      connections: [],
      inputs: [],
      outputs: [
        ...largeLeft.topology.outputs.map((output) => ({
          name: `left_${output.name}`,
          from: { component: 'left', output: output.name },
        })),
        ...largeRight.topology.outputs.map((output) => ({
          name: `right_${output.name}`,
          from: { component: 'right', output: output.name },
        })),
      ],
    };
    expect(expandWorkflowComposite({
      spec: largeSpec,
      components: [
        componentAuthority('left', largeLeftRef, largeLeft),
        componentAuthority('right', largeRightRef, largeRight),
      ],
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/bounds|node|output/i) });
  });

  it('rejects kind mismatches, duplicate input satisfaction, cycles, and fan-out', () => {
    const assembly = twoComponentAssembly();
    const decoded = decodeWorkflowCompositeSpec(assembly.raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const mismatch = structuredClone(decoded.spec) as any;
    mismatch.inputs[0].to = { component: 'right', input: 'upstream' };
    const mismatchResult = expandWorkflowComposite({
      spec: mismatch,
      components: [
        componentAuthority('left', LEFT_REF, assembly.left),
        componentAuthority('right', RIGHT_REF, assembly.right),
      ],
    });
    expect(mismatchResult).toMatchObject({ ok: false, reason: expect.stringMatching(/input|satisf|kind/i) });

    const duplicateInput = structuredClone(assembly.raw) as RecordValue;
    duplicateInput.inputs.push({ name: 'again', to: { component: 'left', input: 'request' } });
    expect(decodeWorkflowCompositeSpec(duplicateInput)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/duplicate|input/i),
    });

    const cycle = structuredClone(decoded.spec) as any;
    cycle.connections.push({
      from: { component: 'right', output: 'result' },
      to: { component: 'left', input: 'request' },
    });
    expect(expandWorkflowComposite({
      spec: cycle,
      components: [
        componentAuthority('left', LEFT_REF, assembly.left),
        componentAuthority('right', RIGHT_REF, assembly.right),
      ],
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/cycle|input|kind/i) });
  });

  it('reduces policies conservatively and rejects false or corrupt policy authority', () => {
    const left = { ...DEFAULT_WORKFLOW_POLICY, maxTaskCount: 12, maxConcurrency: 8, maxArtifactBytes: 10_000 };
    const right = { ...DEFAULT_WORKFLOW_POLICY, maxTaskCount: 7, maxConcurrency: 4, maxArtifactBytes: 8_000 };
    const reduced = reduceWorkflowPolicies([left, right]);
    expect(reduced).toEqual({
      ok: true,
      policy: {
        ...DEFAULT_WORKFLOW_POLICY,
        maxTaskCount: 7,
        maxConcurrency: 4,
        maxArtifactBytes: 8_000,
      },
    });
    expect(reduceWorkflowPolicies([{ ...left, failWorkflow: false }])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/failWorkflow/i),
    });
    expect(reduceWorkflowPolicies([{ ...left, maxConcurrency: Number.NaN }])).toMatchObject({
      ok: false,
      reason: expect.any(String),
    });
  });

  it('fingerprints canonical object order while preserving component order and authority changes', () => {
    const assembly = twoComponentAssembly();
    const decoded = decodeWorkflowCompositeSpec(assembly.raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const authorities = [
      componentAuthority('left', LEFT_REF, assembly.left),
      componentAuthority('right', RIGHT_REF, assembly.right),
    ];
    const expanded = expandWorkflowComposite({ spec: decoded.spec, components: authorities });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const reordered = {
      outputs: decoded.spec.outputs,
      inputs: decoded.spec.inputs,
      connections: decoded.spec.connections,
      components: decoded.spec.components,
    };
    expect(fingerprintWorkflowComposite({ spec: decoded.spec, components: authorities }))
      .toBe(fingerprintWorkflowComposite({ spec: reordered, components: authorities }));
    const reversed = [...authorities].reverse();
    expect(fingerprintWorkflowComposite({ spec: decoded.spec, components: reversed })).toBe(
      fingerprintWorkflowComposite({ spec: decoded.spec, components: authorities }),
    );
    const reorderedSpec = {
      ...decoded.spec,
      components: [...decoded.spec.components].reverse(),
    };
    expect(fingerprintWorkflowComposite({ spec: reorderedSpec, components: reversed })).not.toBe(
      fingerprintWorkflowComposite({ spec: decoded.spec, components: authorities }),
    );
    expect(expanded.fingerprint).toBe(
      fingerprintWorkflowComposite({ spec: decoded.spec, components: authorities }),
    );

    const renamedOutput: WorkflowCompositeSpec = {
      ...decoded.spec,
      outputs: decoded.spec.outputs.map((output, index) => (
        index === 0 ? { ...output, name: 'renamedLeftResult' } : output
      )),
    };
    const renamedExpansion = expandWorkflowComposite({ spec: renamedOutput, components: authorities });
    expect(renamedExpansion).toMatchObject({ ok: true });
    if (renamedExpansion.ok) expect(renamedExpansion.fingerprint).not.toBe(expanded.fingerprint);

    const alternateLeftRaw = manifest({
      name: 'Left',
      nodes: [agent('entry')],
      inputs: [{ name: 'request', kind: 'request', to: 'entry', inputRef: 'request' }],
      outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
    });
    const alternateLeft = definition(alternateLeftRaw, `workflow-${'5'.repeat(32)}`);
    const alternateLeftRef = `workflow-${'5'.repeat(32)}@1`;
    const refChanged: WorkflowCompositeSpec = {
      ...decoded.spec,
      components: decoded.spec.components.map((component, index) => (
        index === 0
          ? {
              key: 'left',
              workflow: {
                workflowRef: alternateLeftRef,
                definitionId: alternateLeft.definitionId,
                version: alternateLeft.version,
              },
            }
          : component
      )),
    };
    const refExpansion = expandWorkflowComposite({
      spec: refChanged,
      components: [
        componentAuthority('left', alternateLeftRef, alternateLeft),
        authorities[1]!,
      ],
    });
    expect(refExpansion).toMatchObject({ ok: true });
    if (refExpansion.ok) expect(refExpansion.fingerprint).not.toBe(expanded.fingerprint);

    const lowerPolicy = {
      ...DEFAULT_WORKFLOW_POLICY,
      maxTaskCount: 7,
      maxConcurrency: 4,
      maxArtifactBytes: 8_000,
      maxAggregateBytes: 16_000,
    };
    const policyLeft = definition(alternateLeftRaw, assembly.left.definitionId, lowerPolicy);
    const policyExpansion = expandWorkflowComposite({
      spec: decoded.spec,
      components: [
        componentAuthority('left', LEFT_REF, policyLeft),
        authorities[1]!,
      ],
    });
    expect(policyExpansion).toMatchObject({ ok: true });
    if (policyExpansion.ok) {
      expect(policyExpansion.policy.maxTaskCount).toBe(7);
      expect(policyExpansion.fingerprint).not.toBe(expanded.fingerprint);
    }

    const mapped = mappingAssembly();
    const mappedBase = decodeWorkflowCompositeSpec(mapped.base);
    const mappedAlternate = decodeWorkflowCompositeSpec(mapped.alternate);
    expect(mappedBase.ok).toBe(true);
    expect(mappedAlternate.ok).toBe(true);
    if (mappedBase.ok && mappedAlternate.ok) {
      const mappedAuthorities = [
        componentAuthority('source', `workflow-${'f'.repeat(32)}@1`, mapped.source),
        componentAuthority('first', `workflow-${'0'.repeat(32)}@1`, mapped.first),
        componentAuthority('second', `workflow-${'1'.repeat(32)}@1`, mapped.second),
      ];
      const baseExpansion = expandWorkflowComposite({ spec: mappedBase.spec, components: mappedAuthorities });
      const alternateExpansion = expandWorkflowComposite({ spec: mappedAlternate.spec, components: mappedAuthorities });
      expect(baseExpansion, baseExpansion.ok ? undefined : baseExpansion.reason).toMatchObject({ ok: true });
      expect(alternateExpansion, alternateExpansion.ok ? undefined : alternateExpansion.reason).toMatchObject({ ok: true });
      if (baseExpansion.ok && alternateExpansion.ok) {
        expect(alternateExpansion.fingerprint).not.toBe(baseExpansion.fingerprint);
      }
    }

    const inlineA = decodeWorkflowCompositeSpec({
      components: [{ key: 'inline', manifest: manifest({
        name: 'Inline fingerprint',
        nodes: [agent('entry')],
        outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
      }) }],
      connections: [],
      inputs: [],
      outputs: [{ name: 'result', from: { component: 'inline', output: 'result' } }],
    });
    const inlineB = decodeWorkflowCompositeSpec({
      components: [{ key: 'inline', manifest: manifest({
        name: 'Inline fingerprint',
        nodes: [agent('entry', 'Changed inline content.')],
        outputs: [{ name: 'result', kind: 'result', from: 'entry' }],
      }) }],
      connections: [],
      inputs: [],
      outputs: [{ name: 'result', from: { component: 'inline', output: 'result' } }],
    });
    expect(inlineA.ok).toBe(true);
    expect(inlineB.ok).toBe(true);
    if (inlineA.ok && inlineB.ok) {
      expect(fingerprintWorkflowComposite(inlineA.spec)).not.toBe(
        fingerprintWorkflowComposite(inlineB.spec),
      );
    }
  });
});
