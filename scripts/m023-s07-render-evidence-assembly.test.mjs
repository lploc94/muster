/** Pure M023/S07 live-host result to evidence assembly contract. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleBlockedTruncatedRenderEvidence,
  assembleTruncatedRenderEvidence,
} from './m023-s07-render-evidence-assembly.mjs';
import { validateTruncatedRenderEvidence } from './m023-s07-truncated-render-evidence-schema.mjs';

function hostResult(overrides = {}) {
  return {
    ok: true,
    kind: 'm023-s07-truncated-render-host-result',
    schemaVersion: 1,
    vscodeVersion: '1.101.0',
    hostMode: 'extension-development-host',
    probeSource: 'live-extension-host-dom',
    observation: {
      fileChangeGroups: [{ fileRowCount: 1 }, { fileRowCount: 4 }],
      files: [
        {
          retentionTruncated: true,
          pathText: 'src/retained-0.ts',
          countsLabel: 'Retention summary: 30720 lines changed',
          hasStaticSummary: true,
          hasDiffBody: false,
        },
        {
          retentionTruncated: false,
          pathText: 'src/live.ts',
          countsLabel: '1 line added, 1 line removed',
          hasStaticSummary: false,
          hasDiffBody: true,
        },
      ],
    },
    ...overrides,
  };
}

test('assembles only a schema-valid PASS ledger from a live extension host DOM result', () => {
  const evidence = assembleTruncatedRenderEvidence(hostResult(), '2026-07-31T12:00:00.000Z');
  assert.deepEqual(validateTruncatedRenderEvidence(evidence, { requirePass: true }), []);
  assert.equal(evidence.provenance.probeSource, 'live-extension-host-dom');
  assert.equal(evidence.contentSafety.messageBodiesStoredInEvidence, false);
});

test('rejects a non-live host result instead of promoting it to PASS evidence', () => {
  assert.throws(
    () => assembleTruncatedRenderEvidence(hostResult({ probeSource: 'fixture-dom' })),
    /live Extension Development Host DOM/i,
  );
});

test('makes bounded, content-safe BLOCKED evidence when launch or host observation fails', () => {
  const evidence = assembleBlockedTruncatedRenderEvidence(
    new Error(`failed at D:/private/workspace with ${'x'.repeat(600)}`),
    '2026-07-31T12:00:00.000Z',
  );
  assert.deepEqual(validateTruncatedRenderEvidence(evidence), []);
  assert.equal(evidence.verdict, 'BLOCKED');
  assert.ok(evidence.blockedReason.length <= 500);
  assert.doesNotMatch(evidence.blockedReason, /D:\//i);
});
