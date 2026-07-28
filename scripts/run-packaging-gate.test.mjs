/**
 * Unit tests for packaging-gate evidence assembly (T03).
 * Pure helpers only — no createVSIX / zip I/O.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PACKAGING_ALLOWLIST,
  REQUIRED_ARCHIVE_ENTRYPOINTS,
} from './packaging-allowlist.mjs';
import {
  buildArchiveCensus,
  evaluateAllowlist,
  findMissingEntrypoints,
} from './packaging-archive-census.mjs';
import {
  buildEntrypointResults,
  buildPackagingGateEvidence,
} from './run-packaging-gate.mjs';

const FIXTURE_ENTRIES = [
  'extension/package.json',
  'extension/dist/src/extension.js',
  'extension/dist/src/task/sqlite/worker.js',
  'extension/dist/src/bridge/mcp-stdio-proxy.js',
  'extension/node_modules/@modelcontextprotocol/sdk/package.json',
  'extension/node_modules/express/index.js',
];

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
  const evidence = buildPackagingGateEvidence({
    census,
    allowlistResult: allowlist,
    missingEntrypoints: missing,
    entrypoints,
    mode: 'census-only',
  });

  assert.equal(evidence.kind, 'm022-s01-packaging-gate');
  assert.ok(evidence.totalEntries > 0);
  assert.equal(evidence.totalEntries, census.totalEntries);
  assert.equal(evidence.nodeModulesEntryCount, census.nodeModulesEntries);
  assert.deepEqual(evidence.missingEntrypoints, []);
  assert.equal(evidence.allowlist.ok, true);
  assert.equal(evidence.allowlist.mode, 'current-tree');
  assert.ok(Array.isArray(evidence.nodeModulesPackages));
  assert.ok(evidence.topLevelCounts.dist > 0);
  assert.equal(evidence.entrypoints.length, 3);
  assert.equal(evidence.mode, 'census-only');
  // Host stage is T04; packaging stage leaves these deferred/null.
  assert.equal(evidence.activation, 'deferred');
  assert.equal(evidence.bridge, null);
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
