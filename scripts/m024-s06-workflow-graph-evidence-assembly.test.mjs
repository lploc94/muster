/**
 * Contract tests for M024/S06 workflow graph evidence assembly.
 *
 * The central guarantee under test is D094: a green-but-unrelated host run must
 * never be laundered into a graph PASS. Every rejection path below is a way a
 * dishonest PASS could otherwise slip into the committed ledger.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleBlockedWorkflowGraphEvidence,
  assembleWorkflowGraphEvidence,
  validateWorkflowGraphEvidence,
} from './m024-s06-workflow-graph-evidence-assembly.mjs';

const TASK_ID = 'wft-9f2c1a live node';
const REQUEST_ID = 'workflow-graph-1-1700000000000';
const GENERATED_AT = '2026-08-02T00:00:00.000Z';

function graph(overrides = {}) {
  return {
    runStatus: 'running',
    nodeCount: 5,
    edgeCount: 4,
    reusedNodeCount: 4,
    reusedEdgeCount: 4,
    reuseNodeCount: 4,
    reuseEdgeCount: 4,
    nodeStatuses: ['queued', 'reused'],
    feedbackRoundCount: 0,
    diagnostics: [],
    ...overrides,
  };
}

function hostResult(overrides = {}) {
  return {
    ok: true,
    kind: 'm024-s06-workflow-graph-host-result',
    schemaVersion: 1,
    vscodeVersion: '1.101.0',
    hostMode: 'extension-development-host',
    probeSource: 'live-extension-host-transport',
    fixture: { focusTaskId: TASK_ID, liveNodeId: 'five', reusedNodeCount: 4, liveNodeCount: 1 },
    observation: { requestId: REQUEST_ID, taskId: TASK_ID, ok: true, graph: graph() },
    ...overrides,
  };
}

test('assembles PASS evidence from a correlated live host round trip', () => {
  const evidence = assembleWorkflowGraphEvidence(hostResult(), GENERATED_AT);
  assert.equal(evidence.verdict, 'PASS');
  assert.equal(evidence.ok, true);
  assert.equal(evidence.provenance.probeSource, 'live-extension-host-transport');
  assert.equal(evidence.roundTrip.correlated, true);
  assert.equal(evidence.roundTrip.nodeCount, 5);
  assert.equal(evidence.roundTrip.reusedNodeCount, 4);
  assert.ok(evidence.roundTrip.nodeStatuses.includes('reused'));
  assert.deepEqual(validateWorkflowGraphEvidence(evidence, { requirePass: true }), []);
});

test('PASS evidence stores no runtime identifiers', () => {
  const evidence = assembleWorkflowGraphEvidence(hostResult(), GENERATED_AT);
  const serialized = JSON.stringify(evidence);
  for (const identifier of [TASK_ID, REQUEST_ID, 'wft-9f2c1a']) {
    assert.ok(!serialized.includes(identifier), `evidence leaked ${identifier}`);
  }
  assert.equal(evidence.contentSafety.taskIdsStoredInEvidence, false);
  assert.equal(evidence.contentSafety.runIdsStoredInEvidence, false);
});

test('refuses to launder a non-live host result into PASS', () => {
  // The exact D094 failure mode: a real host ran, but not the graph probe.
  for (const drift of [
    { hostMode: 'unit-test' },
    { probeSource: 'live-extension-host-dom' },
    { kind: 'm023-s07-truncated-render-host-result' },
    { ok: false },
  ]) {
    assert.throws(
      () => assembleWorkflowGraphEvidence(hostResult(drift), GENERATED_AT),
      /required for PASS evidence/,
      `accepted drifted host result ${JSON.stringify(drift)}`,
    );
  }
});

test('refuses an observation that does not correlate with the seeded task', () => {
  assert.throws(
    () =>
      assembleWorkflowGraphEvidence(
        hostResult({
          observation: { requestId: REQUEST_ID, taskId: 'wft-other', ok: true, graph: graph() },
        }),
        GENERATED_AT,
      ),
    /did not correlate/,
  );
  // A missing request id means no round trip was actually observed.
  assert.throws(
    () =>
      assembleWorkflowGraphEvidence(
        hostResult({
          observation: { requestId: '', taskId: TASK_ID, ok: true, graph: graph() },
        }),
        GENERATED_AT,
      ),
    /did not correlate/,
  );
});

test('refuses an error result or a missing graph', () => {
  assert.throws(
    () =>
      assembleWorkflowGraphEvidence(
        hostResult({
          observation: { requestId: REQUEST_ID, taskId: TASK_ID, ok: false, code: 'notInWorkflow' },
        }),
        GENERATED_AT,
      ),
    /was not ok \(code=notInWorkflow\)/,
  );
  assert.throws(
    () => assembleWorkflowGraphEvidence(hostResult({ observation: undefined }), GENERATED_AT),
    /missing its observation or fixture/,
  );
  assert.throws(
    () => assembleWorkflowGraphEvidence(hostResult({ fixture: undefined }), GENERATED_AT),
    /missing its observation or fixture/,
  );
});

test('refuses a graph whose reuse shape contradicts the seeded fixture', () => {
  // Reuse is the whole point of the fixture; a graph without it proves nothing.
  assert.throws(
    () =>
      assembleWorkflowGraphEvidence(
        hostResult({
          observation: {
            requestId: REQUEST_ID,
            taskId: TASK_ID,
            ok: true,
            graph: graph({
              reusedNodeCount: 0,
              reusedEdgeCount: 0,
              reuseNodeCount: 0,
              reuseEdgeCount: 0,
              nodeStatuses: ['queued'],
            }),
          },
        }),
        GENERATED_AT,
      ),
    /failed evidence contract/,
  );
  // Wire flags disagreeing with the host counter means the projection drifted.
  assert.throws(
    () =>
      assembleWorkflowGraphEvidence(
        hostResult({
          observation: {
            requestId: REQUEST_ID,
            taskId: TASK_ID,
            ok: true,
            graph: graph({ reuseNodeCount: 2 }),
          },
        }),
        GENERATED_AT,
      ),
    /failed evidence contract/,
  );
});

test('validator rejects unknown diagnostics and malformed counts', () => {
  const base = assembleWorkflowGraphEvidence(hostResult(), GENERATED_AT);
  const withBadDiagnostic = {
    ...base,
    roundTrip: { ...base.roundTrip, diagnostics: ['totally_made_up'] },
  };
  assert.ok(
    validateWorkflowGraphEvidence(withBadDiagnostic).some((failure) =>
      failure.includes('diagnostics'),
    ),
  );
  const withBadCount = { ...base, roundTrip: { ...base.roundTrip, edgeCount: -1 } };
  assert.ok(
    validateWorkflowGraphEvidence(withBadCount).some((failure) => failure.includes('edgeCount')),
  );
  const withWrongReuseEdges = {
    ...base,
    roundTrip: { ...base.roundTrip, reusedEdgeCount: 3, reuseEdgeCount: 3 },
  };
  assert.ok(
    validateWorkflowGraphEvidence(withWrongReuseEdges).some((failure) =>
      failure.includes('reusedEdgeCount'),
    ),
  );
  const withoutRunningStatus = { ...base, roundTrip: { ...base.roundTrip, runStatus: 'failed' } };
  assert.ok(
    validateWorkflowGraphEvidence(withoutRunningStatus).some((failure) => failure.includes('runStatus')),
  );
});

test('validator requires PASS when asked and rejects hollow content safety', () => {
  const base = assembleWorkflowGraphEvidence(hostResult(), GENERATED_AT);
  const blocked = assembleBlockedWorkflowGraphEvidence(new Error('nope'), GENERATED_AT);
  assert.ok(
    validateWorkflowGraphEvidence(blocked, { requirePass: true }).includes('verdict must be PASS'),
  );
  const hollow = {
    ...base,
    contentSafety: { ...base.contentSafety, taskIdsStoredInEvidence: true },
  };
  assert.ok(
    validateWorkflowGraphEvidence(hollow).some((failure) =>
      failure.includes('taskIdsStoredInEvidence'),
    ),
  );
});

test('blocked evidence redacts absolute paths and stays bounded', () => {
  const evidence = assembleBlockedWorkflowGraphEvidence(
    new Error(`launch failed for D:\\_Dev\\muster\\dist\\scripts\\host.js and /tmp/muster-x/vsix`),
    GENERATED_AT,
  );
  assert.equal(evidence.verdict, 'BLOCKED');
  assert.equal(evidence.ok, false);
  assert.ok(!evidence.blockedReason.includes('_Dev'), 'windows path survived redaction');
  assert.ok(!evidence.blockedReason.includes('muster-x'), 'posix temp path survived redaction');
  assert.ok(evidence.blockedReason.includes('<redacted-path>'));
  assert.ok(!('roundTrip' in evidence));
  assert.deepEqual(validateWorkflowGraphEvidence(evidence), []);

  const long = assembleBlockedWorkflowGraphEvidence(new Error('x'.repeat(4000)), GENERATED_AT);
  assert.ok(long.blockedReason.length <= 500);
  const empty = assembleBlockedWorkflowGraphEvidence(new Error(''), GENERATED_AT);
  assert.ok(empty.blockedReason.length > 0, 'blocked reason must never be empty');
});
