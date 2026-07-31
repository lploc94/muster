/**
 * Unit tests for packaging-gate evidence assembly (T03).
 * Pure helpers only — no createVSIX / zip I/O.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGING_ALLOWLIST,
  REQUIRED_ARCHIVE_ENTRYPOINTS,
  REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES,
} from './packaging-allowlist.mjs';
import {
  buildArchiveCensus,
  buildMarketplaceEntryResults,
  evaluateAllowlist,
  findMissingEntrypoints,
} from './packaging-archive-census.mjs';
import {
  applyHostStageToEvidence,
  buildEntrypointResults,
  buildFailClosedEvidence,
  buildPackagingGateEvidence,
  parseHostSmokeResult,
  redactGateDetail,
} from './run-packaging-gate.mjs';

const FIXTURE_ENTRIES = [
  'extension/package.json',
  'extension/changelog.md',
  'extension/resources/icon.png',
  'extension/dist/src/extension.js',
  'extension/dist/src/task/sqlite/worker.js',
  'extension/dist/src/bridge/mcp-stdio-proxy.js',
  'extension/node_modules/@modelcontextprotocol/sdk/package.json',
  'extension/node_modules/express/index.js',
];

/** Valid redacted bridgeClosure observation used by ok host fixtures. */
const OK_BRIDGE_CLOSURE = {
  port: 64149,
  trace: 'present',
  bridgeClosed: true,
  postExitProbe: 'refused',
  phase: 'ok',
};


test('buildEntrypointResults marks present+resolved when entry exists and file is on disk', () => {
  const results = buildEntrypointResults({
    entryNames: FIXTURE_ENTRIES,
    requiredEntrypoints: REQUIRED_ARCHIVE_ENTRYPOINTS,
    fileExists: (archivePath) => archivePath.endsWith('.js'),
  });
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.present, true, r.path);
    assert.equal(r.resolved, true, r.path);
    assert.equal(r.phase, 'ok', r.path);
  }
});

test('buildEntrypointResults reports missing-archive-entry when zip lacks the path', () => {
  const results = buildEntrypointResults({
    entryNames: ['extension/package.json'],
    requiredEntrypoints: REQUIRED_ARCHIVE_ENTRYPOINTS,
    fileExists: () => true,
  });
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.present, false);
    assert.equal(r.resolved, false);
    assert.equal(r.phase, 'missing-archive-entry');
  }
});

test('buildEntrypointResults reports require-failed when zip has entry but disk file is absent', () => {
  const results = buildEntrypointResults({
    entryNames: FIXTURE_ENTRIES,
    requiredEntrypoints: ['extension/dist/src/extension.js'],
    fileExists: () => false,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].present, true);
  assert.equal(results[0].resolved, false);
  assert.equal(results[0].phase, 'require-failed');
});

test('buildPackagingGateEvidence exposes totalEntries, nodeModulesEntryCount, missingEntrypoints', () => {
  const census = buildArchiveCensus(FIXTURE_ENTRIES);
  const allowlist = evaluateAllowlist(census, PACKAGING_ALLOWLIST);
  const missing = findMissingEntrypoints(FIXTURE_ENTRIES, REQUIRED_ARCHIVE_ENTRYPOINTS);
  const entrypoints = buildEntrypointResults({
    entryNames: FIXTURE_ENTRIES,
    requiredEntrypoints: REQUIRED_ARCHIVE_ENTRYPOINTS,
    fileExists: () => true,
  });
  const marketplaceEntries = buildMarketplaceEntryResults(
    FIXTURE_ENTRIES,
    REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES,
  );
  const evidence = buildPackagingGateEvidence({
    census,
    allowlistResult: allowlist,
    missingEntrypoints: missing,
    entrypoints,
    marketplaceEntries,
    mode: 'census-only',
  });

  assert.equal(evidence.kind, 'm022-s01-packaging-gate');
  assert.ok(evidence.totalEntries > 0);
  assert.equal(evidence.totalEntries, census.totalEntries);
  assert.equal(evidence.nodeModulesEntryCount, census.nodeModulesEntries);
  assert.deepEqual(evidence.missingEntrypoints, []);
  assert.equal(evidence.allowlist.ok, true);
  assert.equal(evidence.allowlist.mode, 'sdk-closure-only');
  assert.deepEqual(evidence.allowlist.violations, []);
  assert.ok(Array.isArray(evidence.nodeModulesPackages));
  assert.ok(evidence.topLevelCounts.dist > 0);
  assert.equal(evidence.entrypoints.length, 3);
  assert.equal(evidence.marketplaceEntries.length, 2);
  assert.ok(evidence.marketplaceEntries.every((r) => r.present === true));
  assert.equal(evidence.ok, true);
  assert.equal(evidence.mode, 'census-only');
  // Host stage is T04; packaging stage leaves these deferred/null.
  assert.equal(evidence.activation, 'deferred');
  assert.equal(evidence.bridge, null);
});

test('buildPackagingGateEvidence fails closed when marketplace metadata is missing', () => {
  const census = buildArchiveCensus(FIXTURE_ENTRIES);
  const allowlist = evaluateAllowlist(census, PACKAGING_ALLOWLIST);
  const missing = findMissingEntrypoints(FIXTURE_ENTRIES, REQUIRED_ARCHIVE_ENTRYPOINTS);
  const entrypoints = buildEntrypointResults({
    entryNames: FIXTURE_ENTRIES,
    requiredEntrypoints: REQUIRED_ARCHIVE_ENTRYPOINTS,
    fileExists: () => true,
  });
  const evidence = buildPackagingGateEvidence({
    census,
    allowlistResult: allowlist,
    missingEntrypoints: missing,
    entrypoints,
    marketplaceEntries: [
      { path: 'extension/resources/icon.png', present: false, actualPath: null },
      { path: 'extension/changelog.md', present: true, actualPath: 'extension/CHANGELOG.md' },
    ],
    mode: 'census-only',
  });
  assert.equal(evidence.ok, false);
  assert.equal(
    evidence.marketplaceEntries.find((r) => r.path.endsWith('icon.png'))?.present,
    false,
  );
});

test('buildPackagingGateEvidence fails closed when entrypoints are missing', () => {
  const census = buildArchiveCensus(['extension/package.json']);
  const allowlist = evaluateAllowlist(census, PACKAGING_ALLOWLIST);
  const missing = findMissingEntrypoints(
    ['extension/package.json'],
    REQUIRED_ARCHIVE_ENTRYPOINTS,
  );
  const entrypoints = buildEntrypointResults({
    entryNames: ['extension/package.json'],
    requiredEntrypoints: REQUIRED_ARCHIVE_ENTRYPOINTS,
    fileExists: () => false,
  });
  const evidence = buildPackagingGateEvidence({
    census,
    allowlistResult: allowlist,
    missingEntrypoints: missing,
    entrypoints,
    mode: 'census-only',
  });
  assert.equal(evidence.missingEntrypoints.length, 3);
  assert.equal(evidence.ok, false);
});

function packagingBaseEvidence() {
  const census = buildArchiveCensus(FIXTURE_ENTRIES);
  const allowlist = evaluateAllowlist(census, PACKAGING_ALLOWLIST);
  const missing = findMissingEntrypoints(FIXTURE_ENTRIES, REQUIRED_ARCHIVE_ENTRYPOINTS);
  const entrypoints = buildEntrypointResults({
    entryNames: FIXTURE_ENTRIES,
    requiredEntrypoints: REQUIRED_ARCHIVE_ENTRYPOINTS,
    fileExists: () => true,
  });
  const marketplaceEntries = buildMarketplaceEntryResults(
    FIXTURE_ENTRIES,
    REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES,
  );
  return buildPackagingGateEvidence({
    census,
    allowlistResult: allowlist,
    missingEntrypoints: missing,
    entrypoints,
    marketplaceEntries,
    mode: 'full',
  });
}

test('parseHostSmokeResult accepts a successful host smoke payload', () => {
  const parsed = parseHostSmokeResult({
    kind: 'm022-s01-packaging-host-smoke',
    ok: true,
    activation: 'ok',
    bridge: { port: 41234, status: 'ok', generation: 1 },
    bridgePhase: 'ok',
    bridgeClosure: OK_BRIDGE_CLOSURE,
    entrypoints: [
      {
        path: 'extension/dist/src/extension.js',
        present: true,
        resolved: true,
        phase: 'ok',
      },
      {
        path: 'extension/dist/src/task/sqlite/worker.js',
        present: true,
        resolved: true,
        phase: 'ok',
      },
      {
        path: 'extension/dist/src/bridge/mcp-stdio-proxy.js',
        present: true,
        resolved: true,
        phase: 'ok',
      },
    ],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.activation, 'ok');
  assert.equal(parsed.bridge.port, 41234);
  assert.equal(parsed.bridgePhase, 'ok');
  assert.equal(parsed.entrypoints.length, 3);
});

test('parseHostSmokeResult classifies missing/invalid host output as activation failure', () => {
  const missing = parseHostSmokeResult(null);
  assert.equal(missing.ok, false);
  assert.equal(missing.activation, 'failed');
  assert.equal(missing.bridgePhase, 'activation');
  assert.equal(missing.bridge, null);

  const badKind = parseHostSmokeResult({ kind: 'wrong', activation: 'ok' });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.bridgePhase, 'activation');
});

test('applyHostStageToEvidence promotes activation/bridge and recomputes ok for full mode', () => {
  const base = packagingBaseEvidence();
  assert.equal(base.activation, 'deferred');
  assert.equal(base.bridge, null);

  const merged = applyHostStageToEvidence(
    base,
    parseHostSmokeResult({
      kind: 'm022-s01-packaging-host-smoke',
      ok: true,
      activation: 'ok',
      bridge: { port: 55555, status: 'ok', generation: 2 },
      bridgePhase: 'ok',
      bridgeClosure: OK_BRIDGE_CLOSURE,
      entrypoints: base.entrypoints.map((r) => ({ ...r, phase: 'ok', resolved: true, present: true })),
    }),
  );

  assert.equal(merged.mode, 'full');
  assert.equal(merged.activation, 'ok');
  assert.deepEqual(merged.bridge, { port: 55555, status: 'ok', generation: 2 });
  assert.equal(merged.ok, true);
  assert.equal(merged.bridgePhase, 'ok');
});

test('applyHostStageToEvidence fails closed when bridge is not listening', () => {
  const base = packagingBaseEvidence();
  const merged = applyHostStageToEvidence(
    base,
    parseHostSmokeResult({
      kind: 'm022-s01-packaging-host-smoke',
      ok: false,
      activation: 'ok',
      bridge: { port: 0, status: 'unavailable', generation: 0 },
      bridgePhase: 'health-unreachable',
      entrypoints: base.entrypoints,
    }),
  );
  assert.equal(merged.activation, 'ok');
  assert.equal(merged.ok, false);
  assert.equal(merged.bridgePhase, 'health-unreachable');
  assert.equal(merged.bridge.status, 'unavailable');
});

test('applyHostStageToEvidence fails closed when stdio proxy require graph fails', () => {
  const base = packagingBaseEvidence();
  const entrypoints = base.entrypoints.map((r) =>
    r.path.endsWith('mcp-stdio-proxy.js')
      ? {
          ...r,
          resolved: false,
          phase: 'require-failed',
          detail: 'MODULE_NOT_FOUND: express',
        }
      : r,
  );
  const merged = applyHostStageToEvidence(
    base,
    parseHostSmokeResult({
      kind: 'm022-s01-packaging-host-smoke',
      ok: false,
      activation: 'ok',
      bridge: { port: 4000, status: 'ok', generation: 1 },
      bridgePhase: 'ok',
      bridgeClosure: OK_BRIDGE_CLOSURE,
      entrypoints,
    }),
  );
  assert.equal(merged.ok, false);
  const proxy = merged.entrypoints.find((r) => r.path.endsWith('mcp-stdio-proxy.js'));
  assert.equal(proxy.phase, 'require-failed');
  assert.equal(proxy.resolved, false);
});


test('host smoke ok requires bridgeClosure proof (not pid-exit inference)', () => {
  const entrypoints = [
    {
      path: 'extension/dist/src/extension.js',
      present: true,
      resolved: true,
      phase: 'ok',
    },
    {
      path: 'extension/dist/src/task/sqlite/worker.js',
      present: true,
      resolved: true,
      phase: 'ok',
    },
    {
      path: 'extension/dist/src/bridge/mcp-stdio-proxy.js',
      present: true,
      resolved: true,
      phase: 'ok',
    },
  ];

  // Listening bridge alone is no longer enough — missing bridgeClosure must fail closed.
  const withoutClosure = parseHostSmokeResult({
    kind: 'm022-s01-packaging-host-smoke',
    ok: true,
    activation: 'ok',
    bridge: { port: 64149, status: 'ok', generation: 1 },
    bridgePhase: 'ok',
    entrypoints,
  });
  assert.equal(withoutClosure.ok, false);
  assert.equal(withoutClosure.bridgeClosure, null);

  // still-serving postExitProbe must fail (bridge did not actually close).
  const stillServing = parseHostSmokeResult({
    kind: 'm022-s01-packaging-host-smoke',
    ok: true,
    activation: 'ok',
    bridge: { port: 64149, status: 'ok', generation: 1 },
    bridgePhase: 'ok',
    bridgeClosure: {
      port: 64149,
      trace: 'present',
      bridgeClosed: true,
      postExitProbe: 'still-serving',
      phase: 'still-serving',
    },
    entrypoints,
  });
  assert.equal(stillServing.ok, false);
  assert.equal(stillServing.bridgeClosure?.phase, 'still-serving');

  // Full redacted bridgeClosure with refused probe passes.
  const withClosure = parseHostSmokeResult({
    kind: 'm022-s01-packaging-host-smoke',
    ok: true,
    activation: 'ok',
    bridge: { port: 64149, status: 'ok', generation: 1 },
    bridgePhase: 'ok',
    bridgeClosure: OK_BRIDGE_CLOSURE,
    entrypoints,
  });
  assert.equal(withClosure.ok, true);
  assert.deepEqual(withClosure.bridgeClosure, OK_BRIDGE_CLOSURE);

  const evidence = applyHostStageToEvidence(
    {
      kind: 'm022-s01-packaging-gate',
      mode: 'full',
      ok: false,
      allowlist: { mode: 'sdk-closure-only', ok: true, violations: [] },
      entrypoints: [],
      activation: 'failed',
      bridge: null,
      bridgePhase: 'activation',
      archiveEntries: [],
      generatedAt: '2026-07-28T00:00:00.000Z',
      durationMs: 1,
    },
    withClosure,
  );
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.bridgeClosure, OK_BRIDGE_CLOSURE);

  // applyHostStage must not accept forged host.ok without bridgeClosure.
  const forged = applyHostStageToEvidence(evidence, {
    kind: 'm022-s01-packaging-host-smoke',
    ok: true,
    activation: 'ok',
    bridge: { port: 64149, status: 'ok', generation: 1 },
    bridgePhase: 'ok',
    bridgeClosure: null,
    entrypoints,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.bridgeClosure, null);
});

// --- Evidence must always describe *this* run (CI uploads it with if: always()) ---

test('buildFailClosedEvidence never yields a passing verdict', () => {
  const evidence = buildFailClosedEvidence({
    phase: 'package-failed',
    detail: String.raw`createVSIX failed at C:\Users\dev\muster token sk-abc123`,
    mode: 'packaging',
    durationMs: 42,
  });

  assert.equal(evidence.kind, 'm022-s01-packaging-gate');
  assert.equal(evidence.ok, false);
  assert.equal(evidence.phase, 'package-failed');
  assert.equal(evidence.activation, 'failed');
  assert.equal(evidence.bridge, null);
  assert.equal(evidence.totalEntries, 0);
  // The detail reaches tracked evidence, so machine paths and tokens are stripped.
  assert.match(evidence.failureDetail, /\[redacted\]/);
  assert.ok(
    !/Users|sk-abc123/.test(JSON.stringify(evidence)),
    'fail-closed evidence must not leak machine paths or tokens',
  );
});

test('buildFailClosedEvidence defaults to a typed incomplete phase', () => {
  const evidence = buildFailClosedEvidence();
  assert.equal(evidence.ok, false);
  assert.equal(evidence.phase, 'gate-incomplete');
});

test('redactGateDetail strips POSIX runner paths and bearer tokens', () => {
  const out = redactGateDetail('boom in /home/runner/work/muster and Bearer abc.def');
  assert.ok(!out.includes('/home/runner'), 'POSIX runner path must be redacted');
  assert.ok(!out.includes('abc.def'), 'bearer token must be redacted');
});

test('buildPackagingGateEvidence stamps a typed phase next to ok', () => {
  // mode 'full' with no host observations yet: packaging passed, host did not run.
  const base = packagingBaseEvidence();
  assert.equal(base.ok, false);
  assert.equal(base.phase, 'activation-failed');
});

test('applyHostStageToEvidence never leaves phase ok next to ok false', () => {
  const base = packagingBaseEvidence();
  const merged = applyHostStageToEvidence(
    base,
    parseHostSmokeResult({
      kind: 'm022-s01-packaging-host-smoke',
      ok: false,
      activation: 'ok',
      bridge: { port: 0, status: 'unavailable', generation: 0 },
      bridgePhase: 'health-unreachable',
      entrypoints: base.entrypoints,
    }),
  );

  assert.equal(merged.ok, false);
  assert.notEqual(merged.phase, 'ok', 'a failed run must not report phase ok');
  assert.equal(merged.phase, 'bridge-unreachable');
});

test('applyHostStageToEvidence rejects a self-contradictory bridge closure', () => {
  const base = packagingBaseEvidence();
  const merged = applyHostStageToEvidence(base, {
    kind: 'm022-s01-packaging-host-smoke',
    ok: true,
    activation: 'ok',
    bridgePhase: 'ok',
    bridge: { port: 4321, status: 'ok', generation: 1 },
    // Claims phase ok while the observations say the bridge never stopped serving.
    bridgeClosure: {
      port: 4321,
      trace: 'present',
      bridgeClosed: false,
      postExitProbe: 'still-serving',
      phase: 'ok',
    },
    entrypoints: base.entrypoints.map((r) => ({
      ...r,
      present: true,
      resolved: true,
      phase: 'ok',
    })),
  });

  assert.equal(merged.ok, false, 'phase ok alone must not mint a passing verdict');
  assert.equal(merged.phase, 'closure-failed');
});

test('packaging stage stamps fail-closed evidence before the first fallible step', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'run-packaging-gate.mjs'), 'utf8');
  const stageStart = src.indexOf('async function runPackagingStage');
  assert.ok(stageStart > -1, 'runPackagingStage must exist');

  const stage = src.slice(stageStart);
  const preStamp = stage.indexOf('buildFailClosedEvidence');
  const createVsix = stage.indexOf('await createVSIX(');
  assert.ok(preStamp > -1, 'packaging stage must stamp fail-closed evidence');
  assert.ok(createVsix > -1, 'packaging stage must call createVSIX');
  assert.ok(
    preStamp < createVsix,
    'fail-closed evidence must be written before createVSIX, or a crash leaves the previous run\u2019s passing verdict on disk',
  );
});
