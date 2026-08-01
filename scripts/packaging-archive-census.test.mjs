import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PACKAGING_ALLOWLIST,
  REQUIRED_ARCHIVE_ENTRYPOINTS,
} from './packaging-allowlist.mjs';
import {
  buildArchiveCensus,
  evaluateAllowlist,
  findMissingEntrypoints,
  formatCensusReport,
} from './packaging-archive-census.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_ENTRIES = [
  'extension/package.json',
  'extension/dist/src/extension.js',
  'extension/dist/src/task/sqlite/worker.js',
  'extension/dist/src/bridge/mcp-stdio-proxy.js',
  'extension/dist/src/bridge/server.js',
  'extension/resources/icon.png',
  'extension/node_modules/@modelcontextprotocol/sdk/package.json',
  'extension/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js',
  'extension/node_modules/express/package.json',
  'extension/node_modules/express/lib/express.js',
  'extension/node_modules/express/node_modules/debug/package.json',
  'extension/node_modules/zod/package.json',
  // Windows-style separators must normalize before census.
  'extension\\node_modules\\body-parser\\package.json',
];

test('scoped package parsing yields @modelcontextprotocol/sdk not @modelcontextprotocol', () => {
  const census = buildArchiveCensus(FIXTURE_ENTRIES);
  assert.ok(
    census.nodeModulesPackages.includes('@modelcontextprotocol/sdk'),
    `expected scoped package in ${JSON.stringify(census.nodeModulesPackages)}`,
  );
  assert.equal(
    census.nodeModulesPackages.includes('@modelcontextprotocol'),
    false,
    'scoped root must not be truncated to the scope alone',
  );
});

test('topLevelCounts separates dist from node_modules from resources', () => {
  const census = buildArchiveCensus(FIXTURE_ENTRIES);
  assert.ok(census.topLevelCounts.dist > 0);
  assert.ok(census.topLevelCounts.node_modules > 0);
  assert.ok(census.topLevelCounts.resources > 0);
  assert.equal(
    census.topLevelCounts.dist +
      census.topLevelCounts.node_modules +
      census.topLevelCounts.resources +
      (census.topLevelCounts['package.json'] ?? 0),
    census.totalEntries,
  );
});

test('current-tree mode reports zero violations even with hundreds of staged packages', () => {
  const many = [];
  for (let i = 0; i < 250; i += 1) {
    many.push(`extension/node_modules/pkg-${i}/index.js`);
  }
  many.push('extension/dist/src/extension.js');
  const census = buildArchiveCensus(many);
  assert.equal(census.nodeModulesPackages.length, 250);
  const result = evaluateAllowlist(census, {
    ...PACKAGING_ALLOWLIST,
    mode: 'current-tree',
    allowedNodeModulesPrefixes: [],
  });
  assert.equal(result.mode, 'current-tree');
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('sdk-closure-only mode flags a package outside the allowlist and passes when every package is allowed', () => {
  const census = buildArchiveCensus(FIXTURE_ENTRIES);
  const failing = evaluateAllowlist(census, {
    mode: 'sdk-closure-only',
    allowedNodeModulesPrefixes: ['@modelcontextprotocol/sdk', 'express'],
    sdkClosureRootPackages: ['@modelcontextprotocol/sdk'],
  });
  assert.equal(failing.ok, false);
  assert.ok(failing.violations.includes('body-parser'));
  assert.ok(failing.violations.includes('zod'));
  assert.equal(failing.violations.includes('@modelcontextprotocol/sdk'), false);
  assert.equal(failing.violations.includes('express'), false);

  const allowed = [...census.nodeModulesPackages];
  const passing = evaluateAllowlist(census, {
    mode: 'sdk-closure-only',
    allowedNodeModulesPrefixes: allowed,
    sdkClosureRootPackages: ['@modelcontextprotocol/sdk'],
  });
  assert.equal(passing.ok, true);
  assert.deepEqual(passing.violations, []);
});

test('findMissingEntrypoints returns all three paths for an empty archive and empty when all present', () => {
  assert.deepEqual(
    findMissingEntrypoints([], REQUIRED_ARCHIVE_ENTRYPOINTS),
    [...REQUIRED_ARCHIVE_ENTRYPOINTS],
  );
  assert.deepEqual(
    findMissingEntrypoints(FIXTURE_ENTRIES, REQUIRED_ARCHIVE_ENTRYPOINTS),
    [],
  );
  // Backslash form still counts as present after normalize.
  assert.deepEqual(
    findMissingEntrypoints(
      ['extension\\dist\\src\\extension.js', 'extension/dist/src/task/sqlite/worker.js', 'extension/dist/src/bridge/mcp-stdio-proxy.js'],
      REQUIRED_ARCHIVE_ENTRYPOINTS,
    ),
    [],
  );
});

test('formatCensusReport returns a non-empty string mentioning the total count', () => {
  const census = buildArchiveCensus(FIXTURE_ENTRIES);
  const allowlistResult = evaluateAllowlist(census, PACKAGING_ALLOWLIST);
  const missing = findMissingEntrypoints(FIXTURE_ENTRIES, REQUIRED_ARCHIVE_ENTRYPOINTS);
  const report = formatCensusReport(census, allowlistResult, missing);
  assert.equal(typeof report, 'string');
  assert.ok(report.length > 0);
  assert.match(report, new RegExp(String(census.totalEntries)));
  assert.match(report, /node_modules/i);
});

test('census arithmetic matches fixture entry totals', () => {
  const census = buildArchiveCensus(FIXTURE_ENTRIES);
  assert.equal(census.totalEntries, FIXTURE_ENTRIES.length);
  assert.equal(census.nodeModulesEntries + census.nonNodeModulesEntries, census.totalEntries);
  assert.deepEqual(census.nodeModulesPackages, [
    '@modelcontextprotocol/sdk',
    'body-parser',
    'express',
    'zod',
  ]);
});

test('new modules stay pure — no adm-zip, @vscode/vsce, or node:fs imports', () => {
  for (const rel of ['packaging-allowlist.mjs', 'packaging-archive-census.mjs']) {
    const source = readFileSync(path.join(scriptDir, rel), 'utf8');
    assert.equal(/adm-zip/.test(source), false, `${rel} must not import adm-zip`);
    assert.equal(/@vscode\/vsce/.test(source), false, `${rel} must not import @vscode/vsce`);
    assert.equal(/node:fs/.test(source), false, `${rel} must not import node:fs`);
    assert.equal(/from ['"]fs['"]/.test(source), false, `${rel} must not import fs`);
  }
});
