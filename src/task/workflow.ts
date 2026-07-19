/**
 * Workflow domain boundary for M018 S01.
 * Owns topology validation and define result shaping; repository owns CAS writes.
 */

import {
  decodeDefineWorkflowInput,
  encodeTopologyJson,
  fingerprintWorkflowDefinition,
} from './workflow-codec';
import type {
  DefineWorkflowInput,
  DefineWorkflowResult,
  WorkflowDefinitionV1,
} from './workflow-types';

export {
  decodeDefineWorkflowInput,
  decodeOneNodeTopology,
  decodeStoredTopologyJson,
  encodeTopologyJson,
  fingerprintWorkflowDefinition,
} from './workflow-codec';
export type {
  DefineWorkflowInput,
  DefineWorkflowResult,
  OneNodeTopologyV1,
  WorkflowDefinitionV1,
  WorkflowNodeSpecV1,
} from './workflow-types';

/** Operations ledger key for an immutable definition claim. */
export function defineWorkflowLedgerKey(definitionId: string, version: number): string {
  return `define_workflow:${definitionId}:${version}`;
}

/**
 * Validate define input without persistence.
 * Used by repository and unit tests to fail closed before any SQL.
 */
export function validateDefineWorkflow(
  input: DefineWorkflowInput,
):
  | { ok: true; definition: WorkflowDefinitionV1; fingerprint: string; topologyJson: string }
  | { ok: false; reason: string } {
  const decoded = decodeDefineWorkflowInput(input);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason };
  }
  return {
    ok: true,
    definition: decoded.definition,
    fingerprint: decoded.fingerprint,
    topologyJson: encodeTopologyJson(decoded.definition.topology),
  };
}

/** Shape a successful first-write define result. */
export function defineWorkflowCreated(
  definition: WorkflowDefinitionV1,
  fingerprint: string,
): DefineWorkflowResult {
  return {
    ok: true,
    changed: true,
    definitionId: definition.definitionId,
    version: definition.version,
    fingerprint,
  };
}

/** Shape a same-fingerprint replay result. */
export function defineWorkflowReplay(
  definition: WorkflowDefinitionV1,
  fingerprint: string,
): DefineWorkflowResult {
  return {
    ok: true,
    changed: false,
    definitionId: definition.definitionId,
    version: definition.version,
    fingerprint,
    replay: true,
  };
}

/** Shape a conflict (same key, different fingerprint). */
export function defineWorkflowConflict(
  definitionId: string,
  version: number,
): DefineWorkflowResult {
  return {
    ok: false,
    conflict: true,
    reason: 'definition fingerprint conflict',
    definitionId,
    version,
  };
}

/** Shape a validation failure without partial rows. */
export function defineWorkflowInvalid(
  reason: 'invalid topology' | 'invalid identity',
): DefineWorkflowResult {
  return { ok: false, conflict: true, reason };
}

/** Helper for tests/fixtures: build a minimal valid one-node definition. */
export function makeOneNodeDefinition(overrides?: {
  definitionId?: string;
  version?: number;
  name?: string;
  nodeId?: string;
  createdAt?: string;
}): WorkflowDefinitionV1 {
  const nodeId = overrides?.nodeId ?? 'entry';
  return {
    definitionId: overrides?.definitionId ?? 'wf-one',
    version: overrides?.version ?? 1,
    name: overrides?.name ?? 'one-node',
    topology: {
      kind: 'one_node_v1',
      nodes: [{ nodeId }],
      entryNodeId: nodeId,
    },
    createdAt: overrides?.createdAt ?? '2026-07-19T00:00:00.000Z',
  };
}

/** Fingerprint helper re-export for callers that already hold a definition. */
export function fingerprintDefinition(definition: WorkflowDefinitionV1): string {
  return fingerprintWorkflowDefinition(definition);
}
