/**
 * Closed, source-independent workflow composite normalization.
 *
 * This module deliberately stops at a validated run-authority candidate.  It
 * does not resolve catalog paths, read a database, or persist a definition.
 * Those responsibilities belong to the host and later run-owned storage phase.
 */

import { createHash } from 'node:crypto';
import {
  WORKFLOW_COMPOSITE_COMPONENTS_MAX,
  WORKFLOW_COMPOSITE_CONNECTIONS_MAX,
  WORKFLOW_COMPOSITE_INPUTS_MAX,
  WORKFLOW_COMPOSITE_OUTPUTS_MAX,
  WORKFLOW_GRAPH_MAX_EDGES,
  WORKFLOW_GRAPH_MAX_NODES,
  type WorkflowCompositeComponent,
  type WorkflowCompositeComponentAuthority,
  type WorkflowCompositeComponentProjection,
  type WorkflowCompositeConnection,
  type WorkflowCompositeExpansion,
  type WorkflowCompositeInlineManifest,
  type WorkflowCompositeInput,
  type WorkflowCompositeNodeProvenance,
  type WorkflowCompositeOutput,
  type WorkflowCompositeOutputProjection,
  type WorkflowCompositeSpec,
  type WorkflowCompositeWorkflowRef,
  type WorkflowDefinition,
  type WorkflowEntryContract,
  type WorkflowInputContract,
  type WorkflowNodeSpec,
  type WorkflowOutputContract,
  type WorkflowPolicy,
  type WorkflowTopology,
} from './workflow-types';
import {
  canonicalTopologyValue,
  decodeDefineWorkflowInput,
  decodeWorkflowManifest,
  deriveDefaultWorkflowPolicy,
  fingerprintWorkflowDefinition,
  WORKFLOW_POLICY_BOUNDS,
  validateTopologySemantics,
  workflowOutputRole,
} from './workflow-codec';

export const WORKFLOW_COMPOSITE_REF_PATTERN = '^(workflow-[a-f0-9]{32})@([1-9][0-9]*)$';
export const WORKFLOW_COMPOSITE_COMPONENT_KEY_MAX_LENGTH = 128;
export const WORKFLOW_COMPOSITE_ERROR_MAX_LENGTH = 240;

const COMPOSITE_REF_RE = new RegExp(WORKFLOW_COMPOSITE_REF_PATTERN);
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const POLICY_NUMERIC_KEYS = [
  'maxFeedbackRoundsPerRun',
  'maxTurnsPerTask',
  'maxWorkflowTurnsPerRun',
  'runTimeoutMs',
  'maxDepth',
  'maxTaskCount',
  'maxConcurrency',
  'maxInputsPerGate',
  'maxArtifactBytes',
  'maxAggregateBytes',
] as const satisfies readonly (keyof WorkflowPolicy)[];

type NumericPolicyKey = (typeof POLICY_NUMERIC_KEYS)[number];

type RecordValue = Record<string, unknown>;

export type WorkflowCompositeSpecDecodeResult =
  | { ok: true; spec: WorkflowCompositeSpec }
  | { ok: false; reason: string };

export type WorkflowCompositeExpansionResult =
  | ({ ok: true } & WorkflowCompositeExpansion)
  | { ok: false; reason: string };

export interface WorkflowCompositeExpansionInput {
  spec: WorkflowCompositeSpec;
  /** Already authorized/frozen source definitions. Inline components need no entry. */
  components?: readonly WorkflowCompositeComponentAuthority[];
  /** Alias accepted by host callers; exactly one source list may be supplied. */
  authorities?: readonly WorkflowCompositeComponentAuthority[];
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(record: RecordValue, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function isStableId(value: unknown, max = WORKFLOW_COMPOSITE_COMPONENT_KEY_MAX_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && STABLE_ID_RE.test(value);
}

function boundedError(reason: string): { ok: false; reason: string } {
  const safe = reason.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return { ok: false, reason: safe.slice(0, WORKFLOW_COMPOSITE_ERROR_MAX_LENGTH) || 'invalid workflow composite' };
}

function parseWorkflowRef(value: unknown):
  | { ok: true; ref: WorkflowCompositeWorkflowRef }
  | { ok: false; reason: string } {
  if (typeof value !== 'string') return boundedError('workflow component ref must be a versioned workflow ref');
  const match = COMPOSITE_REF_RE.exec(value);
  if (!match) return boundedError('workflow component ref must be a versioned immutable workflow ref');
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) return boundedError('invalid workflow component version');
  return {
    ok: true,
    ref: { workflowRef: value, definitionId: match[1]!, version },
  };
}

function decodeEndpoint(
  value: unknown,
  endpointName: 'input' | 'output',
): { ok: true; endpoint: { component: string; [key: string]: string } } | { ok: false; reason: string } {
  if (!isRecord(value) || !onlyKeys(value, ['component', endpointName])) {
    return boundedError(`invalid composite ${endpointName} endpoint`);
  }
  if (!isStableId(value.component) || !isStableId(value[endpointName])) {
    return boundedError(`invalid composite ${endpointName} endpoint`);
  }
  return {
    ok: true,
    endpoint: { component: value.component, [endpointName]: value[endpointName] as string },
  };
}

function decodeInlineManifest(value: unknown):
  | { ok: true; manifest: WorkflowCompositeInlineManifest }
  | { ok: false; reason: string } {
  const decoded = decodeWorkflowManifest(value, 'inline');
  if (!decoded.ok) return boundedError(`invalid inline workflow component: ${decoded.reason}`);
  if (decoded.topology.nodes.length !== 1) {
    return boundedError('inline workflow components must contain exactly one node');
  }
  const policy = deriveDefaultWorkflowPolicy(decoded.entryContracts);
  return {
    ok: true,
    manifest: {
      name: decoded.name,
      topology: decoded.topology,
      entryContracts: decoded.entryContracts,
      policy,
    },
  };
}

/** Decode the closed public composite DTO without resolving saved sources. */
export function decodeWorkflowCompositeSpec(raw: unknown): WorkflowCompositeSpecDecodeResult {
  if (!isRecord(raw) || !onlyKeys(raw, ['components', 'connections', 'inputs', 'outputs'])) {
    return boundedError('invalid workflow composite fields');
  }
  if (
    !Array.isArray(raw.components) ||
    !Array.isArray(raw.connections) ||
    !Array.isArray(raw.inputs) ||
    !Array.isArray(raw.outputs)
  ) return boundedError('workflow composite components, connections, inputs, and outputs are required arrays');
  if (
    raw.components.length < 1 ||
    raw.components.length > WORKFLOW_COMPOSITE_COMPONENTS_MAX
  ) return boundedError('workflow composite component count exceeds bounds');
  if (raw.connections.length > WORKFLOW_COMPOSITE_CONNECTIONS_MAX) {
    return boundedError('workflow composite connection count exceeds bounds');
  }
  if (raw.inputs.length > WORKFLOW_COMPOSITE_INPUTS_MAX) {
    return boundedError('workflow composite input count exceeds bounds');
  }
  if (
    raw.outputs.length < 1 ||
    raw.outputs.length > WORKFLOW_COMPOSITE_OUTPUTS_MAX
  ) return boundedError('workflow composite output count exceeds bounds');

  const components: WorkflowCompositeComponent[] = [];
  const componentKeys = new Set<string>();
  for (const value of raw.components) {
    if (!isRecord(value) || !onlyKeys(value, ['key', 'workflow', 'manifest'])) {
      return boundedError('invalid workflow composite component fields');
    }
    if (!isStableId(value.key)) return boundedError('invalid workflow composite component key');
    if (componentKeys.has(value.key)) return boundedError('duplicate workflow composite component key');
    componentKeys.add(value.key);
    const hasWorkflow = Object.prototype.hasOwnProperty.call(value, 'workflow');
    const hasManifest = Object.prototype.hasOwnProperty.call(value, 'manifest');
    if (hasWorkflow === hasManifest) {
      return boundedError('workflow composite component requires exactly one workflow or manifest source');
    }
    if (hasWorkflow) {
      const parsed = parseWorkflowRef(value.workflow);
      if (!parsed.ok) return parsed;
      components.push({ key: value.key, workflow: parsed.ref });
    } else {
      const parsed = decodeInlineManifest(value.manifest);
      if (!parsed.ok) return parsed;
      components.push({ key: value.key, inline: parsed.manifest });
    }
  }

  const connections: WorkflowCompositeConnection[] = [];
  const connectionSources = new Set<string>();
  const connectionDestinations = new Set<string>();
  for (const value of raw.connections) {
    if (!isRecord(value) || !onlyKeys(value, ['from', 'to'])) {
      return boundedError('invalid workflow composite connection fields');
    }
    const from = decodeEndpoint(value.from, 'output');
    const to = decodeEndpoint(value.to, 'input');
    if (!from.ok) return from;
    if (!to.ok) return to;
    if (!componentKeys.has(from.endpoint.component) || !componentKeys.has(to.endpoint.component)) {
      return boundedError('workflow composite connection references an unknown component');
    }
    const sourceKey = `${from.endpoint.component}\0${from.endpoint.output}`;
    const destinationKey = `${to.endpoint.component}\0${to.endpoint.input}`;
    if (connectionSources.has(sourceKey)) return boundedError('workflow composite connection fan-out is not allowed');
    if (connectionDestinations.has(destinationKey)) return boundedError('duplicate workflow composite input slot');
    connectionSources.add(sourceKey);
    connectionDestinations.add(destinationKey);
    connections.push({
      from: { component: from.endpoint.component, output: from.endpoint.output },
      to: { component: to.endpoint.component, input: to.endpoint.input },
    });
  }

  const inputs: WorkflowCompositeInput[] = [];
  const inputNames = new Set<string>();
  const inputDestinations = new Set(connectionDestinations);
  for (const value of raw.inputs) {
    if (!isRecord(value) || !onlyKeys(value, ['name', 'to'])) {
      return boundedError('invalid workflow composite input fields');
    }
    if (!isStableId(value.name)) return boundedError('invalid workflow composite input name');
    if (inputNames.has(value.name)) return boundedError('duplicate workflow composite input name');
    const to = decodeEndpoint(value.to, 'input');
    if (!to.ok) return to;
    if (!componentKeys.has(to.endpoint.component)) {
      return boundedError('workflow composite input references an unknown component');
    }
    const destinationKey = `${to.endpoint.component}\0${to.endpoint.input}`;
    if (inputDestinations.has(destinationKey)) return boundedError('duplicate workflow composite input slot');
    inputNames.add(value.name);
    inputDestinations.add(destinationKey);
    inputs.push({
      name: value.name,
      to: { component: to.endpoint.component, input: to.endpoint.input },
    });
  }

  const outputs: WorkflowCompositeOutput[] = [];
  const outputNames = new Set<string>();
  const outputSources = new Set<string>();
  for (const value of raw.outputs) {
    if (!isRecord(value) || !onlyKeys(value, ['name', 'from'])) {
      return boundedError('invalid workflow composite output fields');
    }
    if (!isStableId(value.name)) return boundedError('invalid workflow composite output name');
    if (outputNames.has(value.name)) return boundedError('duplicate workflow composite output name');
    const from = decodeEndpoint(value.from, 'output');
    if (!from.ok) return from;
    if (!componentKeys.has(from.endpoint.component)) {
      return boundedError('workflow composite output references an unknown component');
    }
    const sourceKey = `${from.endpoint.component}\0${from.endpoint.output}`;
    if (outputSources.has(sourceKey)) return boundedError('duplicate workflow composite output slot');
    outputNames.add(value.name);
    outputSources.add(sourceKey);
    outputs.push({
      name: value.name,
      from: { component: from.endpoint.component, output: from.endpoint.output },
    });
  }

  return { ok: true, spec: { components, connections, inputs, outputs } };
}

function compareKeys(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

/** Canonicalize object member order while deliberately preserving array order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareKeys)) result[key] = canonicalize(value[key]);
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function inlineManifestValue(manifest: WorkflowCompositeInlineManifest): RecordValue {
  return {
    name: manifest.name,
    topology: canonicalTopologyValue(manifest.topology),
    entryContracts: manifest.entryContracts.map((contract) => ({
      entryNodeId: contract.entryNodeId,
      inputRef: contract.inputRef,
      expectedArtifactKind: contract.expectedArtifactKind,
    })),
    policy: manifest.policy,
  };
}

function canonicalSpecValue(spec: WorkflowCompositeSpec): RecordValue {
  return {
    components: spec.components.map((component) => (
      'workflow' in component
        ? {
            key: component.key,
            workflow: {
              workflowRef: component.workflow.workflowRef,
              definitionId: component.workflow.definitionId,
              version: component.workflow.version,
            },
          }
        : { key: component.key, inline: inlineManifestValue(component.inline) }
    )),
    connections: spec.connections.map((connection) => ({
      from: { component: connection.from.component, output: connection.from.output },
      to: { component: connection.to.component, input: connection.to.input },
    })),
    inputs: spec.inputs.map((input) => ({
      name: input.name,
      to: { component: input.to.component, input: input.to.input },
    })),
    outputs: spec.outputs.map((output) => ({
      name: output.name,
      from: { component: output.from.component, output: output.from.output },
    })),
  };
}

function inlineFingerprint(manifest: WorkflowCompositeInlineManifest): string {
  return sha256(JSON.stringify(canonicalize(inlineManifestValue(manifest))));
}

function inlineDefinitionFingerprint(definition: WorkflowDefinition): string {
  return inlineFingerprint({
    name: definition.name,
    topology: definition.topology,
    entryContracts: definition.entryContracts,
    policy: definition.policy,
  });
}

function flattenedNodeId(componentKey: string, localNodeKey: string): string {
  return `wfc_${sha256(`${componentKey.length}:${componentKey}\0${localNodeKey.length}:${localNodeKey}`).slice(0, 48)}`;
}

function componentEndpointKey(component: string, name: string): string {
  return `${component}\0${name}`;
}

function validPolicy(policy: unknown): policy is WorkflowPolicy {
  if (!isRecord(policy)) return false;
  const allowed = new Set<string>([...POLICY_NUMERIC_KEYS, 'failWorkflow']);
  if (Object.keys(policy).some((key) => !allowed.has(key))) return false;
  if (policy.failWorkflow !== true) return false;
  const numericValues = {} as Record<NumericPolicyKey, number>;
  for (const key of POLICY_NUMERIC_KEYS) {
    const value = policy[key];
    const bounds = WORKFLOW_POLICY_BOUNDS[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < bounds.min ||
      value > bounds.max
    ) return false;
    numericValues[key] = value;
  }
  return numericValues.maxConcurrency <= numericValues.maxTaskCount &&
    numericValues.maxArtifactBytes <= numericValues.maxAggregateBytes;
}

/** Conservative field-wise policy reduction; never turns fail-fast off. */
export function reduceWorkflowPolicies(
  policies: readonly WorkflowPolicy[],
): { ok: true; policy: WorkflowPolicy } | { ok: false; reason: string } {
  if (policies.length === 0) return boundedError('workflow composite requires at least one component policy');
  if (policies.some((policy) => !validPolicy(policy))) {
    return boundedError('workflow composite component policy is invalid or failWorkflow is not true');
  }
  const policy = {
    ...policies[0]!,
    failWorkflow: true,
  } as WorkflowPolicy;
  for (const key of POLICY_NUMERIC_KEYS) {
    policy[key] = Math.min(...policies.map((candidate) => candidate[key]));
  }
  if (!validPolicy(policy)) return boundedError('reduced workflow composite policy is invalid');
  return { ok: true, policy };
}

interface ResolvedComponent {
  key: string;
  definition: WorkflowDefinition;
  source:
    | { kind: 'workflow'; workflowRef: string; fingerprint: string }
    | { kind: 'inline'; fingerprint: string };
  inline?: WorkflowCompositeInlineManifest;
}

interface ComponentContext extends ResolvedComponent {
  nodeIds: Map<string, string>;
  inputs: Map<string, WorkflowInputContract>;
  outputs: Map<string, WorkflowOutputContract>;
}

function validateFrozenDefinition(definition: WorkflowDefinition):
  | { ok: true; definition: WorkflowDefinition; fingerprint: string }
  | { ok: false; reason: string } {
  if (!isStableId(definition.definitionId) || !Number.isSafeInteger(definition.version) || definition.version < 1) {
    return boundedError('workflow component definition identity is invalid');
  }
  if ((definition as unknown as { authorityKind?: unknown }).authorityKind === 'composite') {
    return boundedError('recursive workflow composite components are not allowed');
  }
  const decoded = decodeDefineWorkflowInput({
    definitionId: definition.definitionId,
    version: definition.version,
    name: definition.name,
    topology: definition.topology,
    entryContracts: definition.entryContracts,
    policy: definition.policy,
    scope: definition.scope,
    createdAt: definition.createdAt,
  });
  if (!decoded.ok) return boundedError(`invalid frozen workflow component: ${decoded.reason}`);
  return { ok: true, definition: decoded.definition, fingerprint: decoded.fingerprint };
}

function makeInlineDefinition(
  component: Extract<WorkflowCompositeComponent, { inline: WorkflowCompositeInlineManifest }>,
): { ok: true; resolved: ResolvedComponent } | { ok: false; reason: string } {
  const fingerprint = inlineFingerprint(component.inline);
  const definitionId = `workflow-${sha256(`inline\0${fingerprint}`).slice(0, 32)}`;
  const decoded = decodeDefineWorkflowInput({
    definitionId,
    version: 1,
    name: component.inline.name,
    topology: component.inline.topology,
    entryContracts: component.inline.entryContracts,
    policy: component.inline.policy,
    scope: { kind: 'workspace' },
    createdAt: '1970-01-01T00:00:00.000Z',
  });
  if (!decoded.ok) return boundedError(`invalid inline workflow component: ${decoded.reason}`);
  return {
    ok: true,
    resolved: {
      key: component.key,
      definition: decoded.definition,
      source: { kind: 'inline', fingerprint },
      inline: component.inline,
    },
  };
}

function resolveComponents(
  spec: WorkflowCompositeSpec,
  supplied: readonly WorkflowCompositeComponentAuthority[],
): { ok: true; components: ResolvedComponent[] } | { ok: false; reason: string } {
  const suppliedByKey = new Map<string, WorkflowCompositeComponentAuthority>();
  for (const authority of supplied) {
    if (!isStableId(authority.key) || suppliedByKey.has(authority.key)) {
      return boundedError('duplicate or invalid workflow composite authority key');
    }
    suppliedByKey.set(authority.key, authority);
  }
  const specKeys = new Set(spec.components.map((component) => component.key));
  if ([...suppliedByKey.keys()].some((key) => !specKeys.has(key))) {
    return boundedError('workflow composite authority contains an unknown component');
  }

  const resolved: ResolvedComponent[] = [];
  for (const component of spec.components) {
    const authority = suppliedByKey.get(component.key);
    if ('workflow' in component) {
      if (!authority || authority.source.kind !== 'workflow') {
        return boundedError('saved workflow component authority is unavailable');
      }
      if (
        authority.source.workflowRef !== component.workflow.workflowRef ||
        !isStableId(authority.definition.definitionId) ||
        authority.definition.definitionId !== component.workflow.definitionId ||
        authority.definition.version !== component.workflow.version ||
        authority.source.fingerprint !== fingerprintWorkflowDefinition(authority.definition)
      ) return boundedError('saved workflow component authority is stale or corrupt');
      const validated = validateFrozenDefinition(authority.definition);
      if (!validated.ok || validated.fingerprint !== authority.source.fingerprint) {
        return boundedError('saved workflow component authority is invalid');
      }
      resolved.push({
        key: component.key,
        definition: validated.definition,
        source: {
          kind: 'workflow',
          workflowRef: component.workflow.workflowRef,
          fingerprint: validated.fingerprint,
        },
      });
      continue;
    }

    if (authority) {
      if (authority.source.kind !== 'inline') return boundedError('inline component authority source mismatch');
      const validated = validateFrozenDefinition(authority.definition);
      if (!validated.ok || validated.definition.topology.nodes.length !== 1) {
        return boundedError('inline workflow component authority is invalid');
      }
      const expected = inlineFingerprint(component.inline);
      if (inlineDefinitionFingerprint(validated.definition) !== expected) {
        return boundedError('inline workflow component authority does not match requested manifest');
      }
      if (
        authority.source.fingerprint !== undefined &&
        authority.source.fingerprint !== expected
      ) return boundedError('inline workflow component authority fingerprint mismatch');
      resolved.push({
        key: component.key,
        definition: validated.definition,
        source: { kind: 'inline', fingerprint: expected },
        inline: component.inline,
      });
    } else {
      const generated = makeInlineDefinition(component);
      if (!generated.ok) return generated;
      resolved.push(generated.resolved);
    }
  }
  return { ok: true, components: resolved };
}

function compositeFingerprintPayload(input: {
  spec: WorkflowCompositeSpec;
  components: readonly ResolvedComponent[];
  topology: WorkflowTopology;
  policy: WorkflowPolicy;
  nodeProvenance: readonly WorkflowCompositeNodeProvenance[];
}): RecordValue {
  return {
    kind: 'muster.workflow/composite-v1',
    spec: canonicalSpecValue(input.spec),
    components: input.components.map((component) => ({
      key: component.key,
      source: component.source,
      ...(component.inline ? { inline: inlineManifestValue(component.inline) } : {}),
    })),
    topology: canonicalTopologyValue(input.topology),
    nodeProvenance: input.nodeProvenance.map((provenance) => ({
      nodeId: provenance.nodeId,
      componentKey: provenance.componentKey,
      localNodeKey: provenance.localNodeKey,
    })),
    policy: input.policy,
  };
}

function expansionAuthorities(
  input: WorkflowCompositeExpansionInput,
):
  | { ok: true; authorities: readonly WorkflowCompositeComponentAuthority[] }
  | { ok: false; reason: string } {
  if (input.components !== undefined && input.authorities !== undefined) {
    return boundedError('workflow composite accepts one authority list');
  }
  return { ok: true, authorities: input.components ?? input.authorities ?? [] };
}

/**
 * Expand authorized/frozen components into one ordinary validated topology.
 * No source loader or repository mutation is reachable from this function.
 */
export function expandWorkflowComposite(
  input: WorkflowCompositeExpansionInput,
): WorkflowCompositeExpansionResult {
  if (!input || !input.spec) return boundedError('workflow composite spec is required');
  const spec = input.spec;
  const authorities = expansionAuthorities(input);
  if (!authorities.ok) return authorities;
  const supplied = authorities.authorities;
  const resolvedResult = resolveComponents(spec, supplied);
  if (!resolvedResult.ok) return resolvedResult;
  const resolved = resolvedResult.components;
  if (resolved.length !== spec.components.length) return boundedError('workflow composite component resolution is incomplete');

  const policies = resolved.map((component) => component.definition.policy);
  const reduced = reduceWorkflowPolicies(policies);
  if (!reduced.ok) return reduced;
  const policy = reduced.policy;

  let nodeCount = 0;
  let edgeCount = spec.connections.length;
  let outputCount = 0;
  let inputCount = spec.inputs.length;
  for (const component of resolved) {
    nodeCount += component.definition.topology.nodes.length;
    edgeCount += component.definition.topology.edges.length;
    outputCount += component.definition.topology.outputs.length;
    inputCount += component.definition.topology.inputs.length;
  }
  if (nodeCount > WORKFLOW_GRAPH_MAX_NODES) return boundedError('flattened workflow composite exceeds node bounds');
  if (edgeCount > WORKFLOW_GRAPH_MAX_EDGES) return boundedError('flattened workflow composite exceeds edge bounds');
  if (inputCount > WORKFLOW_COMPOSITE_INPUTS_MAX) return boundedError('flattened workflow composite exceeds input bounds');
  if (outputCount > WORKFLOW_GRAPH_MAX_NODES) return boundedError('flattened workflow composite exceeds output bounds');

  const contexts: ComponentContext[] = [];
  const flattenedNodes: WorkflowNodeSpec[] = [];
  const nodeProvenance: WorkflowCompositeNodeProvenance[] = [];
  const provenanceByNodeId = new Map<string, WorkflowCompositeNodeProvenance>();
  for (const component of resolved) {
    const nodeIds = new Map<string, string>();
    const inputs = new Map(component.definition.topology.inputs.map((value) => [value.name, value] as const));
    const outputs = new Map(component.definition.topology.outputs.map((value) => [value.name, value] as const));
    if (inputs.size !== component.definition.topology.inputs.length || outputs.size !== component.definition.topology.outputs.length) {
      return boundedError('workflow composite component has ambiguous interface names');
    }
    for (const node of component.definition.topology.nodes) {
      const nodeId = flattenedNodeId(component.key, node.nodeId);
      if (nodeIds.has(node.nodeId) || provenanceByNodeId.has(nodeId)) {
        return boundedError('workflow composite flattened node identity collision');
      }
      nodeIds.set(node.nodeId, nodeId);
      const provenance = { nodeId, componentKey: component.key, localNodeKey: node.nodeId };
      provenanceByNodeId.set(nodeId, provenance);
      nodeProvenance.push(provenance);
      flattenedNodes.push({ ...node, nodeId });
    }
    contexts.push({ ...component, nodeIds, inputs, outputs });
  }

  const contextByKey = new Map(contexts.map((context) => [context.key, context] as const));
  const flattenedEdges: WorkflowTopology['edges'][number][] = [];
  for (const context of contexts) {
    for (const edge of context.definition.topology.edges) {
      const fromNodeId = context.nodeIds.get(edge.fromNodeId);
      const toNodeId = context.nodeIds.get(edge.toNodeId);
      if (!fromNodeId || !toNodeId || (edge.expectedArtifactKind !== undefined && edge.expectedArtifactKind !== 'next_result')) {
        return boundedError('workflow composite component edge authority is invalid');
      }
      flattenedEdges.push({
        fromNodeId,
        toNodeId,
        inputRef: edge.inputRef,
        expectedArtifactKind: 'next_result',
      });
    }
  }

  const satisfiedInputs = new Set<string>();
  const flattenedInputs: WorkflowInputContract[] = [];
  const externalInputNames = new Set<string>();
  for (const input of spec.inputs) {
    const context = contextByKey.get(input.to.component);
    const contract = context?.inputs.get(input.to.input);
    if (!context || !contract) return boundedError('workflow composite input references an unknown component input');
    const slot = componentEndpointKey(context.key, contract.name);
    if (satisfiedInputs.has(slot)) return boundedError('workflow composite component input is satisfied more than once');
    if (externalInputNames.has(input.name)) return boundedError('duplicate workflow composite input name');
    satisfiedInputs.add(slot);
    externalInputNames.add(input.name);
    const entryNodeId = context.nodeIds.get(contract.entryNodeId);
    if (!entryNodeId) return boundedError('workflow composite input entry authority is invalid');
    flattenedInputs.push({
      name: input.name,
      semanticKind: contract.semanticKind,
      entryNodeId,
      inputRef: contract.inputRef,
    });
  }

  const connectedSources = new Set<string>();
  for (const connection of spec.connections) {
    const fromContext = contextByKey.get(connection.from.component);
    const toContext = contextByKey.get(connection.to.component);
    const output = fromContext?.outputs.get(connection.from.output);
    const input = toContext?.inputs.get(connection.to.input);
    if (!fromContext || !toContext || !output || !input) {
      return boundedError('workflow composite connection references an unknown interface slot');
    }
    if (output.semanticKind !== input.semanticKind) {
      return boundedError('workflow composite semantic kind mismatch');
    }
    const sourceKey = componentEndpointKey(fromContext.key, output.name);
    const destinationKey = componentEndpointKey(toContext.key, input.name);
    if (connectedSources.has(sourceKey)) return boundedError('workflow composite connection fan-out is not allowed');
    if (satisfiedInputs.has(destinationKey)) return boundedError('workflow composite component input is satisfied more than once');
    const fromNodeId = fromContext.nodeIds.get(output.sourceNodeId);
    const toNodeId = toContext.nodeIds.get(input.entryNodeId);
    if (!fromNodeId || !toNodeId) return boundedError('workflow composite interface source authority is invalid');
    connectedSources.add(sourceKey);
    satisfiedInputs.add(destinationKey);
    flattenedEdges.push({
      fromNodeId,
      toNodeId,
      inputRef: input.inputRef,
      expectedArtifactKind: 'next_result',
    });
  }

  for (const context of contexts) {
    for (const input of context.inputs.values()) {
      if (!satisfiedInputs.has(componentEndpointKey(context.key, input.name))) {
        return boundedError('workflow composite component input is not mapped exactly once');
      }
    }
  }

  const mappedOutputSlots = new Set<string>();
  const flattenedOutputs: WorkflowOutputContract[] = [];
  const outputMetadata: Array<{
    name: string;
    semanticKind: string;
    sourceNodeId: string;
    componentKey: string;
    localNodeKey: string;
  }> = [];
  for (const output of spec.outputs) {
    const context = contextByKey.get(output.from.component);
    const contract = context?.outputs.get(output.from.output);
    if (!context || !contract) return boundedError('workflow composite output references an unknown interface slot');
    const sourceKey = componentEndpointKey(context.key, contract.name);
    if (mappedOutputSlots.has(sourceKey)) return boundedError('workflow composite component output is mapped more than once');
    const sourceNodeId = context.nodeIds.get(contract.sourceNodeId);
    if (!sourceNodeId) return boundedError('workflow composite output source authority is invalid');
    mappedOutputSlots.add(sourceKey);
    flattenedOutputs.push({
      name: output.name,
      semanticKind: contract.semanticKind,
      sourceNodeId,
    });
    outputMetadata.push({
      name: output.name,
      semanticKind: contract.semanticKind,
      sourceNodeId,
      componentKey: context.key,
      localNodeKey: contract.sourceNodeId,
    });
  }
  for (const context of contexts) {
    for (const output of context.outputs.values()) {
      if (!mappedOutputSlots.has(componentEndpointKey(context.key, output.name))) {
        return boundedError('workflow composite component output is not mapped exactly once');
      }
    }
  }

  const inboundCount = new Map<string, number>();
  for (const input of flattenedInputs) inboundCount.set(input.entryNodeId, (inboundCount.get(input.entryNodeId) ?? 0) + 1);
  for (const edge of flattenedEdges) inboundCount.set(edge.toNodeId, (inboundCount.get(edge.toNodeId) ?? 0) + 1);
  if ([...inboundCount.values()].some((count) => count > policy.maxInputsPerGate)) {
    return boundedError('flattened workflow composite exceeds policy maxInputsPerGate');
  }

  const topology: WorkflowTopology = {
    kind: 'workflow',
    inputs: flattenedInputs,
    outputs: flattenedOutputs,
    nodes: flattenedNodes,
    edges: flattenedEdges,
  };
  const semanticError = validateTopologySemantics(topology);
  if (semanticError) return boundedError(`invalid flattened workflow composite: ${semanticError}`);
  const entryContracts: WorkflowEntryContract[] = flattenedInputs.map((input) => ({
    entryNodeId: input.entryNodeId,
    inputRef: input.inputRef,
    expectedArtifactKind: 'workflow_input',
  }));
  const validated = decodeDefineWorkflowInput({
    definitionId: `workflow-${sha256(JSON.stringify(canonicalize({ topology: canonicalTopologyValue(topology), policy }))).slice(0, 32)}`,
    version: 1,
    name: 'workflow-composite',
    topology,
    entryContracts,
    policy,
    scope: { kind: 'workspace' },
    createdAt: '1970-01-01T00:00:00.000Z',
  });
  if (!validated.ok) return boundedError(`invalid flattened workflow composite: ${validated.reason}`);

  const componentProjections: WorkflowCompositeComponentProjection[] = contexts.map((context) => ({
    key: context.key,
    source: context.source,
  }));
  const projectedOutputs: WorkflowCompositeOutputProjection[] = [];
  for (const output of outputMetadata) {
    const role = workflowOutputRole(validated.definition.topology, output.sourceNodeId);
    if (!role) return boundedError('workflow composite output role authority is invalid');
    projectedOutputs.push({ ...output, role });
  }
  const fingerprint = sha256(JSON.stringify(canonicalize(compositeFingerprintPayload({
    spec,
    components: contexts,
    topology: validated.definition.topology,
    policy,
    nodeProvenance,
  }))));
  return {
    ok: true,
    spec,
    topology: validated.definition.topology,
    entryContracts,
    policy,
    components: componentProjections,
    nodeProvenance,
    outputs: projectedOutputs,
    fingerprint,
  };
}

/** Fingerprint a normalized spec, or a fully resolved expansion authority. */
export function fingerprintWorkflowComposite(
  input: WorkflowCompositeSpec | WorkflowCompositeExpansionInput,
): string {
  if ('spec' in input) {
    const expanded = expandWorkflowComposite(input);
    if (expanded.ok) return expanded.fingerprint;
    return sha256(JSON.stringify(canonicalize({
      kind: 'muster.workflow/composite-invalid-v1',
      spec: canonicalSpecValue(input.spec),
      reason: expanded.reason,
    })));
  }
  return sha256(JSON.stringify(canonicalize({
    kind: 'muster.workflow/composite-v1',
    spec: canonicalSpecValue(input),
  })));
}

/** Descriptive alias used by host callers. */
export const fingerprintCompositeWorkflow = fingerprintWorkflowComposite;

export type {
  WorkflowCompositeComponent,
  WorkflowCompositeComponentAuthority,
  WorkflowCompositeComponentProjection,
  WorkflowCompositeConnection,
  WorkflowCompositeExpansion,
  WorkflowCompositeInlineManifest,
  WorkflowCompositeInput,
  WorkflowCompositeNodeProvenance,
  WorkflowCompositeOutput,
  WorkflowCompositeOutputProjection,
  WorkflowCompositeSpec,
  WorkflowCompositeWorkflowRef,
};
