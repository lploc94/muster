import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTruncatedRenderEvidence } from './m023-s07-truncated-render-evidence-schema.mjs';

function livePassEvidence() {
  return {
    ok: true,
    kind: 'm023-s07-truncated-render-live-uat',
    schemaVersion: 1,
    verdict: 'PASS',
    provenance: {
      vscodeVersion: '1.101.0',
      hostMode: 'extension-development-host',
      probeSource: 'live-extension-host-dom',
    },
    observation: {
      fileChangeGroups: [{ fileRowCount: 2 }],
      files: [
        {
          retentionTruncated: true,
          pathText: 'src/aged-change.ts',
          countsLabel: '2 additions, 1 deletion (retention summary)',
          hasStaticSummary: true,
          hasDiffBody: false,
        },
        {
          retentionTruncated: false,
          pathText: 'src/live-change.ts',
          countsLabel: '1 addition',
          hasStaticSummary: false,
          hasDiffBody: true,
        },
      ],
    },
    contentSafety: {
      absolutePathsStoredInEvidence: false,
      messageBodiesStoredInEvidence: false,
      sessionIdsStoredInEvidence: false,
      canaryStoredInEvidence: false,
    },
    generatedAt: '2026-07-31T12:00:00.000Z',
  };
}

function blockedEvidence() {
  return {
    ok: false,
    kind: 'm023-s07-truncated-render-live-uat',
    schemaVersion: 1,
    verdict: 'BLOCKED',
    blockedReason: 'VS Code Extension Development Host could not be launched.',
    generatedAt: '2026-07-31T12:00:00.000Z',
  };
}

test('accepts a pass only when it records live Extension Development Host DOM provenance', () => {
  assert.deepEqual(validateTruncatedRenderEvidence(livePassEvidence(), { requirePass: true }), []);
});

test('rejects mocked, browser, and missing provenance for a pass verdict', () => {
  for (const probeSource of ['vitest-jsdom', 'playwright-browser', undefined]) {
    const evidence = livePassEvidence();
    evidence.provenance.probeSource = probeSource;
    assert.ok(
      validateTruncatedRenderEvidence(evidence, { requirePass: true }).some((failure) => /live-extension-host-dom/.test(failure)),
      `expected ${String(probeSource)} to be refused as pass proof`,
    );
  }
});

test('permits an honest blocked verdict with a bounded reason, but never as pass proof', () => {
  const evidence = blockedEvidence();
  assert.deepEqual(validateTruncatedRenderEvidence(evidence), []);
  assert.ok(
    validateTruncatedRenderEvidence(evidence, { requirePass: true }).some((failure) => /requirePass/.test(failure)),
  );

  evidence.blockedReason = '';
  assert.ok(validateTruncatedRenderEvidence(evidence).some((failure) => /blockedReason/.test(failure)));
});

test('rejects incomplete observations, unknown fields, and sensitive ledger content', () => {
  {
    const evidence = livePassEvidence();
    evidence.observation.files[0].hasDiffBody = true;
    assert.ok(validateTruncatedRenderEvidence(evidence).some((failure) => /hasDiffBody/.test(failure)));
  }
  {
    const evidence = livePassEvidence();
    evidence.observation.files[0].pathText = '';
    assert.ok(validateTruncatedRenderEvidence(evidence).some((failure) => /pathText/.test(failure)));
  }
  {
    const evidence = livePassEvidence();
    evidence.extra = true;
    assert.ok(validateTruncatedRenderEvidence(evidence).some((failure) => /root unknown key/.test(failure)));
  }
  {
    const evidence = livePassEvidence();
    evidence.observation.files[0].pathText = '/Users/secret/private.ts';
    assert.ok(validateTruncatedRenderEvidence(evidence).some((failure) => /sensitive/.test(failure)));
  }
});
