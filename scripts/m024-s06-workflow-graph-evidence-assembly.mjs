/**
 * Pure assembly of M024/S06 live Extension Development Host workflow graph
 * observations. This module performs no filesystem or process I/O.
 *
 * Fail-closed by construction (D094): PASS evidence is only produced from a
 * genuine live-host round-trip result with matching provenance and correlation.
 * A green but unrelated host run cannot be laundered into a graph PASS, and any
 * shortfall raises instead of silently downgrading.
 *
 * Identifiers are stripped: the committed ledger keeps counts, statuses, and
 * booleans only — never task ids, run ids, request ids, node ids, or paths.
 */
const HOST_KIND = 'm024-s06-workflow-graph-host-result';
const EVIDENCE_KIND = 'm024-s06-workflow-graph-live-uat';
const MAX_BLOCKED_REASON_LENGTH = 500;
/** Chain of five nodes; the caller binds one..four, so only `five` activates. */
const EXPECTED_NODE_COUNT = 5;
const EXPECTED_EDGE_COUNT = 4;
const EXPECTED_REUSED_NODE_COUNT = 4;
const EXPECTED_REUSED_EDGE_COUNT = 4;

const DIAGNOSTIC_CODES = new Set([
  'workflow_graph_topology_undecodable',
  'workflow_graph_nodes_truncated',
  'workflow_graph_edges_truncated',
  'workflow_graph_child_runs_truncated',
]);

function boundedReason(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/[A-Za-z]:[\\/][^\s)]+/g, '<redacted-path>')
    .replace(
      /(?:\/Users\/|\/home\/|\/private\/tmp\/|\/var\/folders\/|\/tmp\/)[^\s)]+/g,
      '<redacted-path>',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BLOCKED_REASON_LENGTH);
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validates one assembled evidence object.
 * @param {unknown} evidence
 * @param {{ requirePass?: boolean }} [options]
 * @returns {string[]} failures; empty means valid
 */
export function validateWorkflowGraphEvidence(evidence, options = {}) {
  const failures = [];
  if (!evidence || typeof evidence !== 'object') return ['evidence must be an object'];
  if (evidence.kind !== EVIDENCE_KIND) failures.push(`kind must be ${EVIDENCE_KIND}`);
  if (evidence.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (typeof evidence.generatedAt !== 'string' || !evidence.generatedAt) {
    failures.push('generatedAt must be a non-empty string');
  }
  if (evidence.verdict !== 'PASS' && evidence.verdict !== 'BLOCKED') {
    failures.push('verdict must be PASS or BLOCKED');
  }
  if (options.requirePass && evidence.verdict !== 'PASS') failures.push('verdict must be PASS');

  if (evidence.verdict === 'BLOCKED') {
    if (evidence.ok !== false) failures.push('BLOCKED evidence must set ok=false');
    if (typeof evidence.blockedReason !== 'string' || !evidence.blockedReason) {
      failures.push('BLOCKED evidence requires a blockedReason');
    }
    if ('roundTrip' in evidence) failures.push('BLOCKED evidence must not carry a roundTrip');
    return failures;
  }

  if (evidence.ok !== true) failures.push('PASS evidence must set ok=true');
  const provenance = evidence.provenance;
  if (!provenance || typeof provenance !== 'object') {
    failures.push('PASS evidence requires provenance');
  } else {
    if (typeof provenance.vscodeVersion !== 'string' || !provenance.vscodeVersion) {
      failures.push('provenance.vscodeVersion must be a non-empty string');
    }
    if (provenance.hostMode !== 'extension-development-host') {
      failures.push('provenance.hostMode must be extension-development-host');
    }
    if (provenance.probeSource !== 'live-extension-host-transport') {
      failures.push('provenance.probeSource must be live-extension-host-transport');
    }
  }

  const round = evidence.roundTrip;
  if (!round || typeof round !== 'object') {
    failures.push('PASS evidence requires roundTrip');
  } else {
    if (round.correlated !== true) {
      failures.push('roundTrip.correlated must be true for PASS');
    }
    if (round.resultOk !== true) failures.push('roundTrip.resultOk must be true for PASS');
    if (round.hasRunId !== true) failures.push('roundTrip.hasRunId must be true for PASS');
    for (const field of [
      'nodeCount',
      'edgeCount',
      'reusedNodeCount',
      'reusedEdgeCount',
      'reuseNodeCount',
      'reuseEdgeCount',
      'childRunCount',
      'feedbackRoundCount',
    ]) {
      if (!isCount(round[field])) failures.push(`roundTrip.${field} must be a non-negative integer`);
    }
    if (round.nodeCount !== EXPECTED_NODE_COUNT) {
      failures.push(`roundTrip.nodeCount must be ${EXPECTED_NODE_COUNT}`);
    }
    if (round.edgeCount !== EXPECTED_EDGE_COUNT) {
      failures.push(`roundTrip.edgeCount must be ${EXPECTED_EDGE_COUNT}`);
    }
    if (round.reusedNodeCount !== EXPECTED_REUSED_NODE_COUNT) {
      failures.push(`roundTrip.reusedNodeCount must be ${EXPECTED_REUSED_NODE_COUNT}`);
    }
    if (round.reusedEdgeCount !== EXPECTED_REUSED_EDGE_COUNT) {
      failures.push(`roundTrip.reusedEdgeCount must be ${EXPECTED_REUSED_EDGE_COUNT}`);
    }
    // Wire-level reuse flags and the host's own counters must agree, or the
    // projection drifted from the transport payload.
    if (round.reusedNodeCount !== round.reuseNodeCount) {
      failures.push('roundTrip reused node flags disagree with the host reuse counter');
    }
    if (round.reusedEdgeCount !== round.reuseEdgeCount) {
      failures.push('roundTrip reused edge flags disagree with the host reuse counter');
    }
    if (!Array.isArray(round.nodeStatuses) || !round.nodeStatuses.includes('reused')) {
      failures.push('roundTrip.nodeStatuses must include reused');
    }
    if (
      !Array.isArray(round.diagnostics) ||
      round.diagnostics.some((code) => !DIAGNOSTIC_CODES.has(code))
    ) {
      failures.push('roundTrip.diagnostics must contain only known diagnostic codes');
    }
  }

  const safety = evidence.contentSafety;
  if (!safety || typeof safety !== 'object') {
    failures.push('PASS evidence requires contentSafety');
  } else {
    for (const field of [
      'taskIdsStoredInEvidence',
      'runIdsStoredInEvidence',
      'absolutePathsStoredInEvidence',
      'promptTextStoredInEvidence',
    ]) {
      if (safety[field] !== false) failures.push(`contentSafety.${field} must be false`);
    }
  }
  return failures;
}

/**
 * @param {unknown} result live host result
 * @param {string} generatedAt
 */
export function assembleWorkflowGraphEvidence(result, generatedAt = new Date().toISOString()) {
  if (!result || typeof result !== 'object' || result.ok !== true || result.kind !== HOST_KIND) {
    throw new Error(
      'live Extension Development Host workflow graph result is required for PASS evidence',
    );
  }
  if (
    result.hostMode !== 'extension-development-host' ||
    result.probeSource !== 'live-extension-host-transport'
  ) {
    throw new Error('live Extension Development Host provenance is required for PASS evidence');
  }
  const observation = result.observation;
  const fixture = result.fixture;
  if (!observation || typeof observation !== 'object' || !fixture || typeof fixture !== 'object') {
    throw new Error('live host result is missing its observation or fixture');
  }
  // Re-verify correlation here rather than trusting the in-host assertions.
  const correlated =
    typeof observation.taskId === 'string' &&
    observation.taskId.length > 0 &&
    observation.taskId === fixture.focusTaskId &&
    typeof observation.requestId === 'string' &&
    observation.requestId.length > 0;
  if (!correlated) {
    throw new Error('live host observation did not correlate with the seeded workflow task');
  }
  const graph = observation.graph;
  if (observation.ok !== true || !graph || typeof graph !== 'object') {
    throw new Error(
      `live host graph result was not ok (code=${String(observation.code ?? 'none')})`,
    );
  }

  const evidence = {
    ok: true,
    kind: EVIDENCE_KIND,
    schemaVersion: 1,
    verdict: 'PASS',
    provenance: {
      vscodeVersion: result.vscodeVersion,
      hostMode: result.hostMode,
      probeSource: result.probeSource,
    },
    roundTrip: {
      correlated: true,
      resultOk: true,
      hasRunId: graph.hasRunId === true,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      reusedNodeCount: graph.reusedNodeCount,
      reusedEdgeCount: graph.reusedEdgeCount,
      reuseNodeCount: graph.reuseNodeCount,
      reuseEdgeCount: graph.reuseEdgeCount,
      nodeStatuses: graph.nodeStatuses,
      childRunCount: graph.childRunCount,
      feedbackRoundCount: graph.feedbackRoundCount,
      diagnostics: graph.diagnostics,
    },
    fixture: {
      reusedNodeCount: fixture.reusedNodeCount,
      liveNodeCount: fixture.liveNodeCount,
    },
    contentSafety: {
      taskIdsStoredInEvidence: false,
      runIdsStoredInEvidence: false,
      absolutePathsStoredInEvidence: false,
      promptTextStoredInEvidence: false,
    },
    generatedAt,
  };

  const failures = validateWorkflowGraphEvidence(evidence, { requirePass: true });
  if (failures.length) {
    throw new Error(`live host observation failed evidence contract: ${failures.join('; ')}`);
  }
  // Machine-enforced redaction: the seeded identifiers must not survive anywhere
  // in the serialized ledger, so contentSafety cannot be a hollow claim.
  const serialized = JSON.stringify(evidence);
  for (const identifier of [fixture.focusTaskId, observation.taskId, observation.requestId]) {
    if (typeof identifier === 'string' && identifier.length > 0 && serialized.includes(identifier)) {
      throw new Error('assembled evidence leaked a runtime identifier');
    }
  }
  return evidence;
}

/** @param {unknown} error @param {string} generatedAt */
export function assembleBlockedWorkflowGraphEvidence(
  error,
  generatedAt = new Date().toISOString(),
) {
  const evidence = {
    ok: false,
    kind: EVIDENCE_KIND,
    schemaVersion: 1,
    verdict: 'BLOCKED',
    blockedReason:
      boundedReason(error) ||
      'live Extension Development Host run was blocked without a diagnostic reason',
    generatedAt,
  };
  const failures = validateWorkflowGraphEvidence(evidence);
  if (failures.length) throw new Error(`blocked evidence failed contract: ${failures.join('; ')}`);
  return evidence;
}
