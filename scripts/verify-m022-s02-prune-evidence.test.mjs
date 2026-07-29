/**
 * Fail-closed contract for the M022/S02+S03 packaging-gate evidence snapshot.
 *
 * Asserts the tracked post-prune VSIX evidence:
 * - allowlist.mode is enforcing sdk-closure-only with empty violations
 * - node_modules entry count is far below the S01 15801 baseline (< 5000)
 * - activation=ok, bridgePhase=ok, bridge.port > 0 with redacted keys only
 * - all three required archive entrypoints present/resolved/phase ok
 * - marketplace metadata ships: resources/icon.png + CHANGELOG.md present in archive
 * - docs/PACKAGING.md documents the release path, gates, CI surface, and injected regression
 *
 * Fixture-backed node:test — never inspects live hosts, secrets, or gitignored paths.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const EVIDENCE_REL = 'docs/plans/m022-s01-packaging-gate-evidence.json';
const PACKAGING_DOC_REL = 'docs/PACKAGING.md';
const S01_NODE_MODULES_BASELINE = 15801;
const PRUNE_NODE_MODULES_CEILING = 5000;

/** Webview-only packages that must not re-enter the staged archive after the prune. */
const WEBVIEW_ONLY_PACKAGES = [
  '@tailwindcss/typography',
  '@tanstack/svelte-virtual',
  '@tanstack/virtual-core',
  '@vscode-elements/elements',
  'diff',
  'dompurify',
  'github-markdown-css',
  'highlight.js',
  'marked',
  'mermaid',
];

const REQUIRED_ENTRYPOINTS = [
  'extension/dist/src/extension.js',
  'extension/dist/src/task/sqlite/worker.js',
  'extension/dist/src/bridge/mcp-stdio-proxy.js',
];

/** Marketplace metadata paths that must appear in the packaged archive (M022/S03). */
const REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES = [
  'extension/resources/icon.png',
  'extension/changelog.md',
];

/** Pre-icon resources count from S02 evidence (claude-acp 3 + codex-acp 2). */
const PRE_ICON_RESOURCES_COUNT = 5;

const PACKAGING_DOC_MARKERS = [
  'npm run package',
  'vsce package',
  'npm run test:packaging',
  'npm run test:m022-s02',
  'npm run test:m022-s02-archive',
  'npm run test:m022-s03',
  'sdk-closure-only',
  '@modelcontextprotocol/sdk',
  'docs/plans/m022-s01-packaging-gate-evidence.json',
  'nodeModulesEntryCount',
  'activation',
  'bridgePhase',
  '--census-only',
  'packaging-gate',
  'xvfb-run',
  'test:m022-s03-regression',
  'resources/icon.png',
  'CHANGELOG.md',
];

async function readTracked(rel) {
  return readFile(new URL(rel, root), 'utf8');
}

/**
 * Validate the tracked packaging-gate evidence after the S02 dependency prune.
 * @param {unknown} evidence
 */
export function validatePrunedPackagingEvidence(evidence) {
  assert.ok(evidence && typeof evidence === 'object', 'evidence must be an object');
  const e = /** @type {Record<string, unknown>} */ (evidence);

  assert.equal(e.kind, 'm022-s01-packaging-gate', 'kind must remain m022-s01-packaging-gate');
  assert.equal(e.ok, true, 'evidence.ok must be true');
  assert.equal(e.mode, 'full', 'mode must be full (host stage completed)');

  const nm = e.nodeModulesEntryCount;
  assert.equal(typeof nm, 'number', 'nodeModulesEntryCount must be a number');
  assert.ok(
    Number.isFinite(nm) && nm > 0,
    'nodeModulesEntryCount must be a positive finite number',
  );
  assert.ok(
    nm < PRUNE_NODE_MODULES_CEILING,
    `nodeModulesEntryCount ${nm} must be < ${PRUNE_NODE_MODULES_CEILING} after prune (S01 baseline ${S01_NODE_MODULES_BASELINE})`,
  );
  assert.ok(
    nm < S01_NODE_MODULES_BASELINE,
    `nodeModulesEntryCount ${nm} must be below S01 baseline ${S01_NODE_MODULES_BASELINE}`,
  );

  const allowlist = /** @type {Record<string, unknown>} */ (e.allowlist ?? {});
  assert.equal(allowlist.mode, 'sdk-closure-only', 'allowlist.mode must be sdk-closure-only');
  assert.equal(allowlist.ok, true, 'allowlist.ok must be true');
  assert.ok(Array.isArray(allowlist.violations), 'allowlist.violations must be an array');
  assert.deepEqual(allowlist.violations, [], 'allowlist.violations must be empty');

  assert.equal(e.activation, 'ok', 'activation must be ok');
  assert.equal(e.bridgePhase, 'ok', 'bridgePhase must be ok');

  const bridge = e.bridge;
  assert.ok(bridge && typeof bridge === 'object', 'bridge payload is required');
  const bridgeKeys = Object.keys(/** @type {object} */ (bridge)).sort();
  assert.deepEqual(
    bridgeKeys,
    ['generation', 'port', 'status'],
    'bridge payload keys must be exactly generation,port,status',
  );

  // bridgeClosure: deactivate() closed the bridge (not pid-exit inference).
  assert.ok(e.bridgeClosure && typeof e.bridgeClosure === 'object', 'bridgeClosure required');
  const closure = /** @type {Record<string, unknown>} */ (e.bridgeClosure);
  const closureKeys = Object.keys(closure).sort();
  assert.deepEqual(
    closureKeys,
    ['bridgeClosed', 'phase', 'port', 'postExitProbe', 'trace'],
    'bridgeClosure keys must be exactly bridgeClosed,phase,port,postExitProbe,trace',
  );
  assert.equal(typeof closure.port, 'number');
  assert.ok(/** @type {number} */ (closure.port) > 0, 'bridgeClosure.port must be > 0');
  assert.equal(closure.trace, 'present', 'bridgeClosure.trace must be present');
  assert.equal(closure.bridgeClosed, true, 'bridgeClosure.bridgeClosed must be true');
  assert.equal(closure.postExitProbe, 'refused', 'bridgeClosure.postExitProbe must be refused');
  assert.equal(closure.phase, 'ok', 'bridgeClosure.phase must be ok');
  const closureJson = JSON.stringify(closure);
  assert.ok(
    !/token|secret|bearer|Users|workspace|MUSTER_/i.test(closureJson),
    'bridgeClosure must not carry tokens paths or env',
  );
  const b = /** @type {{ port: unknown, status: unknown, generation: unknown }} */ (bridge);
  assert.equal(typeof b.port, 'number', 'bridge.port must be a number');
  assert.ok(
    Number.isFinite(b.port) && b.port > 0,
    `bridge.port must be > 0 (got ${String(b.port)})`,
  );
  assert.equal(b.status, 'ok', 'bridge.status must be ok');
  assert.equal(typeof b.generation, 'number', 'bridge.generation must be a number');
  assert.ok(
    Number.isFinite(b.generation) && b.generation >= 0,
    'bridge.generation must be a non-negative finite number',
  );

  assert.ok(Array.isArray(e.missingEntrypoints), 'missingEntrypoints must be an array');
  assert.deepEqual(e.missingEntrypoints, [], 'missingEntrypoints must be empty');

  assert.ok(Array.isArray(e.entrypoints), 'entrypoints must be an array');
  const entrypoints = /** @type {Array<Record<string, unknown>>} */ (e.entrypoints);
  assert.equal(
    entrypoints.length,
    REQUIRED_ENTRYPOINTS.length,
    `expected ${REQUIRED_ENTRYPOINTS.length} entrypoints`,
  );
  for (const required of REQUIRED_ENTRYPOINTS) {
    const match = entrypoints.find((r) => r.path === required);
    assert.ok(match, `missing entrypoint record for ${required}`);
    assert.equal(match.present, true, `${required}: present must be true`);
    assert.equal(match.resolved, true, `${required}: resolved must be true`);
    assert.equal(match.phase, 'ok', `${required}: phase must be ok`);
  }

  const packages = Array.isArray(e.nodeModulesPackages)
    ? /** @type {string[]} */ (e.nodeModulesPackages)
    : [];
  assert.ok(
    packages.includes('@modelcontextprotocol/sdk'),
    'staged packages must include @modelcontextprotocol/sdk',
  );
  assert.ok(
    packages.includes('express'),
    'staged packages must include express (D067 dynamic bridge resolution)',
  );
  for (const webviewPkg of WEBVIEW_ONLY_PACKAGES) {
    assert.ok(
      !packages.includes(webviewPkg),
      `webview-only package ${webviewPkg} must not be staged after prune`,
    );
  }

  // M022/S03: marketplace metadata must ship in the archive and be recorded.
  assert.ok(
    Array.isArray(e.marketplaceEntries),
    'marketplaceEntries must be an array (icon + CHANGELOG archive presence)',
  );
  const marketplaceEntries = /** @type {Array<Record<string, unknown>>} */ (
    e.marketplaceEntries
  );
  assert.equal(
    marketplaceEntries.length,
    REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES.length,
    `expected ${REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES.length} marketplaceEntries`,
  );
  for (const required of REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES) {
    const match = marketplaceEntries.find(
      (r) =>
        typeof r.path === 'string' &&
        String(r.path).replaceAll('\\', '/').toLowerCase() === required.toLowerCase(),
    );
    assert.ok(match, `missing marketplaceEntries record for ${required}`);
    assert.equal(match.present, true, `${required}: present must be true`);
  }

  const top = /** @type {Record<string, number>} */ (e.topLevelCounts ?? {});
  const changelogCount =
    (typeof top['changelog.md'] === 'number' ? top['changelog.md'] : 0) +
    (typeof top['CHANGELOG.md'] === 'number' ? top['CHANGELOG.md'] : 0);
  assert.ok(
    changelogCount >= 1,
    'topLevelCounts must include changelog.md after marketplace metadata ships',
  );
  const resourcesCount = typeof top.resources === 'number' ? top.resources : 0;
  assert.ok(
    resourcesCount > PRE_ICON_RESOURCES_COUNT,
    `topLevelCounts.resources must exceed pre-icon baseline ${PRE_ICON_RESOURCES_COUNT} (got ${resourcesCount})`,
  );

  return true;
}

/**
 * @param {string} text
 */
export function validatePackagingDocs(text) {
  assert.ok(text.trim(), 'PACKAGING.md must be non-empty');
  for (const marker of PACKAGING_DOC_MARKERS) {
    assert.ok(text.includes(marker), `PACKAGING.md missing marker: ${marker}`);
  }
  // Must not claim that census-only proves host activation.
  assert.ok(
    !/(?:census-only|--census-only).{0,80}(?:proves|guarantees|is sufficient for).{0,40}(?:activation|bridge|host)/i.test(
      text,
    ),
    'PACKAGING.md must not claim census-only proves host activation',
  );
  assert.ok(
    !/(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|Bearer\s+sk-)/i.test(text),
    'PACKAGING.md must not contain secret-like text',
  );
  return true;
}

function fixtureEvidence(overrides = {}) {
  return {
    kind: 'm022-s01-packaging-gate',
    ok: true,
    mode: 'full',
    totalEntries: 3402,
    nodeModulesEntryCount: 3137,
    nonNodeModulesEntries: 265,
    topLevelCounts: {
      dist: 239,
      node_modules: 3137,
      resources: 6,
      'changelog.md': 1,
      'package.json': 1,
    },
    nodeModulesPackages: [
      '@modelcontextprotocol/sdk',
      'express',
      'hono',
      'zod',
    ],
    nodeModulesPackageCounts: {
      '@modelcontextprotocol/sdk': 341,
      express: 22,
    },
    allowlist: {
      mode: 'sdk-closure-only',
      ok: true,
      violations: [],
    },
    missingEntrypoints: [],
    entrypoints: REQUIRED_ENTRYPOINTS.map((path) => ({
      path,
      present: true,
      resolved: true,
      phase: 'ok',
    })),
    marketplaceEntries: REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES.map((path) => ({
      path,
      present: true,
    })),
    activation: 'ok',
    bridge: {
      port: 64149,
      status: 'ok',
      generation: 1,
    },
    bridgePhase: 'ok',
    bridgeClosure: {
      port: 64149,
      trace: 'present',
      bridgeClosed: true,
      postExitProbe: 'refused',
      phase: 'ok',
    },
    generatedAt: '2026-07-28T00:00:00.000Z',
    durationMs: 50000,
    ...overrides,
  };
}

test('tracked post-prune packaging evidence satisfies the S02 operational contract', async () => {
  let raw;
  try {
    raw = await readTracked(EVIDENCE_REL);
  } catch (error) {
    assert.fail(`missing packaging evidence (${error.code ?? error.message})`);
  }
  const evidence = JSON.parse(raw);
  validatePrunedPackagingEvidence(evidence);
});

test('tracked PACKAGING.md documents the release package path and gates', async () => {
  let text;
  try {
    text = await readTracked(PACKAGING_DOC_REL);
  } catch (error) {
    assert.fail(`missing PACKAGING.md (${error.code ?? error.message})`);
  }
  validatePackagingDocs(text);
});

test('accepts a complete pruned evidence fixture', () => {
  assert.equal(validatePrunedPackagingEvidence(fixtureEvidence()), true);
});

test('rejects pre-prune baseline (current-tree + 15801 entries)', () => {
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          nodeModulesEntryCount: S01_NODE_MODULES_BASELINE,
          allowlist: { mode: 'current-tree', ok: true, violations: [] },
          nodeModulesPackages: [
            '@modelcontextprotocol/sdk',
            'express',
            'mermaid',
            'highlight.js',
          ],
        }),
      ),
    /nodeModulesEntryCount|sdk-closure-only|webview-only/,
  );
});

test('rejects allowlist violations and non-enforcing mode', () => {
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          allowlist: {
            mode: 'sdk-closure-only',
            ok: false,
            violations: ['mermaid'],
          },
          ok: false,
        }),
      ),
    /evidence\.ok|allowlist\.ok|violations/,
  );
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          allowlist: { mode: 'current-tree', ok: true, violations: [] },
        }),
      ),
    /sdk-closure-only/,
  );
});

test('rejects host failures and non-redacted bridge payloads', () => {
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          activation: 'failed',
          // keep ok:true so validation reaches activation/bridge checks
          bridgePhase: 'activation',
          bridge: null,
        }),
      ),
    /activation|bridge/,
  );
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          bridgePhase: 'health-unreachable',
          // keep ok:true so validation reaches bridgePhase/port checks
          bridge: { port: 0, status: 'unavailable', generation: 0 },
        }),
      ),
    /bridgePhase|bridge\.port|bridge\.status/,
  );
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          bridge: {
            port: 64149,
            status: 'ok',
            generation: 1,
            secret: 'nope',
          },
        }),
      ),
    /bridge payload keys/,
  );
});

test('rejects missing entrypoints and staged webview packages', () => {
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          entrypoints: [
            {
              path: REQUIRED_ENTRYPOINTS[0],
              present: false,
              resolved: false,
              phase: 'missing-archive-entry',
            },
          ],
          missingEntrypoints: [REQUIRED_ENTRYPOINTS[0]],
          // keep ok:true so validation reaches the entrypoint contract
        }),
      ),
    /entrypoint|missingEntrypoints|present must be true/,
  );
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          nodeModulesPackages: [
            '@modelcontextprotocol/sdk',
            'express',
            'mermaid',
          ],
        }),
      ),
    /webview-only package mermaid/,
  );
});

test('rejects missing marketplace archive entries and pre-icon resources count', () => {
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          marketplaceEntries: undefined,
        }),
      ),
    /marketplaceEntries/,
  );
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          marketplaceEntries: [
            { path: 'extension/resources/icon.png', present: false },
            { path: 'extension/changelog.md', present: true },
          ],
        }),
      ),
    /present must be true|icon\.png/,
  );
  assert.throws(
    () =>
      validatePrunedPackagingEvidence(
        fixtureEvidence({
          topLevelCounts: {
            dist: 239,
            node_modules: 3137,
            resources: PRE_ICON_RESOURCES_COUNT,
          },
        }),
      ),
    /changelog\.md|resources must exceed pre-icon/,
  );
});

test('rejects incomplete PACKAGING.md and census-only-as-host overclaim', () => {
  const complete = PACKAGING_DOC_MARKERS.join('\n');
  assert.equal(validatePackagingDocs(complete), true);
  assert.throws(
    () => validatePackagingDocs(complete.replace('sdk-closure-only', '')),
    /missing marker: sdk-closure-only/,
  );
  assert.throws(
    () =>
      validatePackagingDocs(
        `${complete}\n--census-only proves activation of the host bridge.`,
      ),
    /census-only proves host activation/,
  );
});

test('rejects evidence missing bridgeClosure (pid-exit inference is not enough)', () => {
  const evidence = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'docs/plans/m022-s01-packaging-gate-evidence.json'), 'utf8'),
  );
  // If the tracked file already has bridgeClosure, strip it for the negative.
  const { bridgeClosure, ...rest } = evidence;
  assert.throws(
    () => validatePrunedPackagingEvidence(rest),
    /bridgeClosure required/,
  );
});
