/**
 * Fail-closed contract for M022/S05 T03 install-gate evidence.
 *
 * Asserts the tracked install-gate snapshot proves a real CLI install origin
 * (extensions-dir), never a development-path load, and that the negative
 * drill observed a typed fail-closed phase without mutating tracked files or
 * clobbering the positive evidence path.
 *
 * Fixture-backed node:test — never launches VS Code or reads secrets.
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INSTALL_GATE_PHASES,
  INSTALLED_ORIGINS,
} from './packaging-install-result.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const INSTALL_EVIDENCE_REL = 'docs/plans/m022-s05-install-gate-evidence.json';
const NEGATIVE_EVIDENCE_REL = 'docs/plans/m022-s05-install-negative-evidence.json';
const INSTALL_RUNNER_REL = 'scripts/run-m022-s05-install-gate.mjs';
const NEGATIVE_RUNNER_REL = 'scripts/run-m022-s05-install-negative.mjs';
const HOST_SMOKE_REL = 'scripts/packaging-install-host-smoke.ts';

const NEGATIVE_PHASES = Object.freeze([
  'install-rejected',
  'activation-failed',
  'bridge-unreachable',
]);

const BRIDGE_CLOSURE_KEYS = Object.freeze([
  'port',
  'trace',
  'bridgeClosed',
  'postExitProbe',
  'phase',
]);

async function readTracked(rel) {
  return readFile(path.join(root, rel), 'utf8');
}

/**
 * @param {unknown} evidence
 */
export function validateInstallGateEvidence(evidence) {
  assert.ok(evidence && typeof evidence === 'object', 'evidence must be an object');
  const e = /** @type {Record<string, unknown>} */ (evidence);

  assert.equal(e.kind, 'm022-s05-install-gate', 'kind must be m022-s05-install-gate');
  assert.equal(e.schemaVersion, 1, 'schemaVersion must be 1');
  assert.equal(e.ok, true, 'evidence.ok must be true (install gate passed end-to-end)');

  assert.equal(e.installExitCode, 0, 'installExitCode must be 0');
  assert.equal(
    e.installedOrigin,
    'extensions-dir',
    'installedOrigin must be extensions-dir (not development-path)',
  );
  assert.equal(e.activation, 'ok', 'activation must be ok');
  assert.equal(e.phase, 'ok', 'phase must be ok');

  // Absolute ban on the development-path token in the tracked snapshot.
  const serialized = JSON.stringify(e);
  assert.doesNotMatch(
    serialized,
    /development-path/,
    'tracked install evidence must not contain the string "development-path"',
  );

  assert.ok(e.bridge && typeof e.bridge === 'object', 'bridge must be an object');
  const bridge = /** @type {Record<string, unknown>} */ (e.bridge);
  assert.equal(bridge.status, 'ok', 'bridge.status must be ok');
  assert.equal(typeof bridge.port, 'number', 'bridge.port must be a number');
  assert.ok(
    Number.isFinite(/** @type {number} */ (bridge.port)) &&
      /** @type {number} */ (bridge.port) > 0,
    'bridge.port must be > 0',
  );
  // Only port + status — no tokens/paths/env.
  const bridgeKeys = Object.keys(bridge).sort();
  assert.deepEqual(
    bridgeKeys,
    ['port', 'status'].sort(),
    'bridge must contain only port and status',
  );

  assert.ok(
    e.bridgeClosure && typeof e.bridgeClosure === 'object',
    'bridgeClosure must be an object',
  );
  const closure = /** @type {Record<string, unknown>} */ (e.bridgeClosure);
  assert.deepEqual(
    Object.keys(closure).sort(),
    [...BRIDGE_CLOSURE_KEYS].sort(),
    'bridgeClosure must have exact S04 key set',
  );
  assert.equal(closure.phase, 'ok', 'bridgeClosure.phase must be ok');
  assert.equal(closure.trace, 'present', 'bridgeClosure.trace must be present');
  assert.equal(closure.bridgeClosed, true, 'bridgeClosure.bridgeClosed must be true');
  assert.equal(
    closure.postExitProbe,
    'refused',
    'bridgeClosure.postExitProbe must be refused',
  );
  assert.equal(typeof closure.port, 'number', 'bridgeClosure.port must be a number');
  assert.ok(
    Number.isFinite(/** @type {number} */ (closure.port)) &&
      /** @type {number} */ (closure.port) > 0,
    'bridgeClosure.port must be > 0',
  );

  assert.equal(typeof e.installStderrExcerpt, 'string', 'installStderrExcerpt must be string');
  assert.ok(
    String(e.installStderrExcerpt).length <= 300,
    'installStderrExcerpt must be ≤300 chars',
  );

  assert.equal(typeof e.vscodeVersion, 'string', 'vscodeVersion must be a string');
  assert.ok(String(e.vscodeVersion).length > 0, 'vscodeVersion must be non-empty');
  assert.doesNotMatch(
    String(e.vscodeVersion),
    /[\\/]/,
    'vscodeVersion must not contain path separators',
  );

  assert.equal(typeof e.platform, 'string', 'platform must be a string');
  assert.ok(String(e.platform).length > 0, 'platform must be non-empty');

  assert.ok(
    INSTALL_GATE_PHASES.includes(/** @type {string} */ (e.phase)),
    `phase must be a closed InstallGatePhase; got ${String(e.phase)}`,
  );
  assert.ok(
    INSTALLED_ORIGINS.includes(/** @type {string} */ (e.installedOrigin)),
    `installedOrigin must be a closed InstalledOrigin; got ${String(e.installedOrigin)}`,
  );

  assert.equal(typeof e.generatedAt, 'string', 'generatedAt must be a string');
  assert.match(
    String(e.generatedAt),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    'generatedAt must be an ISO-8601 UTC timestamp',
  );
  assert.equal(typeof e.durationMs, 'number', 'durationMs must be a number');
  assert.ok(
    Number.isFinite(/** @type {number} */ (e.durationMs)) &&
      /** @type {number} */ (e.durationMs) >= 0,
    'durationMs must be a non-negative finite number',
  );

  // Redaction / safety: no secrets or absolute machine paths.
  assert.doesNotMatch(
    serialized,
    /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|Bearer\s+sk-|sk-ant-|sk-proj-|\bsk-[A-Za-z0-9_-]{8,})/i,
    'evidence must not contain secret-like text',
  );
  assert.doesNotMatch(
    serialized,
    /(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|\/tmp\/|file:\/\/)/,
    'evidence must not contain absolute machine paths',
  );

  return true;
}

/**
 * @param {unknown} evidence
 */
export function validateInstallNegativeEvidence(evidence) {
  assert.ok(evidence && typeof evidence === 'object', 'evidence must be an object');
  const e = /** @type {Record<string, unknown>} */ (evidence);

  assert.equal(
    e.kind,
    'm022-s05-install-negative',
    'kind must be m022-s05-install-negative',
  );
  assert.equal(e.ok, true, 'negative drill evidence.ok must be true (fail-closed observed)');

  assert.equal(
    e.removedEntry,
    'extension/dist/src/extension.js',
    'removedEntry must be the extension entrypoint',
  );
  assert.equal(
    e.corruption,
    'removed-extension-entry',
    'corruption must be removed-extension-entry',
  );

  const gateExitCode = e.gateExitCode;
  assert.equal(typeof gateExitCode, 'number', 'gateExitCode must be a number');
  assert.ok(
    Number.isInteger(/** @type {number} */ (gateExitCode)) &&
      /** @type {number} */ (gateExitCode) !== 0,
    `gateExitCode must be non-zero (got ${String(gateExitCode)})`,
  );

  const gatePhase = e.gatePhase;
  assert.equal(typeof gatePhase, 'string', 'gatePhase must be a string');
  assert.ok(
    NEGATIVE_PHASES.includes(/** @type {string} */ (gatePhase)),
    `gatePhase must be one of ${NEGATIVE_PHASES.join(', ')}; got ${String(gatePhase)}`,
  );

  assert.equal(
    e.trackedFilesMutated,
    0,
    'trackedFilesMutated must be 0 (temp VSIX only)',
  );
  assert.equal(
    e.evidenceTarget,
    'temp',
    'evidenceTarget must be temp (must not clobber install-gate evidence)',
  );

  assert.equal(typeof e.generatedAt, 'string', 'generatedAt must be a string');
  assert.match(
    String(e.generatedAt),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    'generatedAt must be an ISO-8601 UTC timestamp',
  );
  assert.equal(typeof e.durationMs, 'number', 'durationMs must be a number');
  assert.ok(
    Number.isFinite(/** @type {number} */ (e.durationMs)) &&
      /** @type {number} */ (e.durationMs) >= 0,
    'durationMs must be a non-negative finite number',
  );

  const serialized = JSON.stringify(e);
  assert.doesNotMatch(
    serialized,
    /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|Bearer\s+sk-|sk-ant-|sk-proj-|\bsk-[A-Za-z0-9_-]{8,})/i,
    'negative evidence must not contain secret-like text',
  );
  assert.doesNotMatch(
    serialized,
    /(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|\/tmp\/|file:\/\/)/,
    'negative evidence must not contain absolute machine paths',
  );

  return true;
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function fixtureInstallEvidence(overrides = {}) {
  return {
    kind: 'm022-s05-install-gate',
    schemaVersion: 1,
    ok: true,
    installExitCode: 0,
    installStderrExcerpt: '',
    installedOrigin: 'extensions-dir',
    activation: 'ok',
    bridge: { port: 41234, status: 'ok' },
    bridgeClosure: {
      port: 41234,
      trace: 'present',
      bridgeClosed: true,
      postExitProbe: 'refused',
      phase: 'ok',
    },
    vscodeVersion: '1.130.0',
    platform: 'linux',
    phase: 'ok',
    generatedAt: '2026-07-29T00:00:00.000Z',
    durationMs: 90_000,
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function fixtureNegativeEvidence(overrides = {}) {
  return {
    kind: 'm022-s05-install-negative',
    ok: true,
    corruption: 'removed-extension-entry',
    removedEntry: 'extension/dist/src/extension.js',
    gateExitCode: 1,
    gatePhase: 'activation-failed',
    trackedFilesMutated: 0,
    evidenceTarget: 'temp',
    generatedAt: '2026-07-29T00:00:00.000Z',
    durationMs: 60_000,
    ...overrides,
  };
}

// ─── Unit fixtures ──────────────────────────────────────────────────────────

test('validateInstallGateEvidence accepts a healthy extensions-dir snapshot', () => {
  assert.equal(validateInstallGateEvidence(fixtureInstallEvidence()), true);
});

test('validateInstallGateEvidence rejects development-path origin and ok:false', () => {
  assert.throws(
    () =>
      validateInstallGateEvidence(
        fixtureInstallEvidence({
          ok: false,
          installedOrigin: 'development-path',
          phase: 'origin-not-installed',
        }),
      ),
    /ok must be true|extensions-dir|development-path/,
  );
});

test('validateInstallGateEvidence rejects missing bridge port and extra bridge keys', () => {
  assert.throws(
    () =>
      validateInstallGateEvidence(
        fixtureInstallEvidence({ bridge: { port: 0, status: 'ok' } }),
      ),
    /port must be > 0/,
  );
  assert.throws(
    () =>
      validateInstallGateEvidence(
        fixtureInstallEvidence({
          bridge: { port: 1, status: 'ok', generation: 1 },
        }),
      ),
    /only port and status/,
  );
});

test('validateInstallGateEvidence rejects absolute paths and secrets', () => {
  assert.throws(
    () =>
      validateInstallGateEvidence(
        fixtureInstallEvidence({
          installStderrExcerpt: 'failed at /Users/hiep/secret',
        }),
      ),
    /absolute machine paths/,
  );
  assert.throws(
    () =>
      validateInstallGateEvidence(
        fixtureInstallEvidence({
          installStderrExcerpt: 'Bearer sk-ant-secretvaluehere',
        }),
      ),
    /secret-like/,
  );
});

test('validateInstallNegativeEvidence accepts a typed fail-closed drill', () => {
  assert.equal(validateInstallNegativeEvidence(fixtureNegativeEvidence()), true);
  for (const gatePhase of NEGATIVE_PHASES) {
    assert.equal(
      validateInstallNegativeEvidence(fixtureNegativeEvidence({ gatePhase })),
      true,
      `phase ${gatePhase}`,
    );
  }
});

test('validateInstallNegativeEvidence rejects zero exit, wrong phase, or tracked mutation', () => {
  assert.throws(
    () => validateInstallNegativeEvidence(fixtureNegativeEvidence({ gateExitCode: 0 })),
    /non-zero/,
  );
  assert.throws(
    () =>
      validateInstallNegativeEvidence(
        fixtureNegativeEvidence({ gatePhase: 'closure-failed' }),
      ),
    /gatePhase must be one of/,
  );
  assert.throws(
    () =>
      validateInstallNegativeEvidence(
        fixtureNegativeEvidence({ trackedFilesMutated: 1 }),
      ),
    /trackedFilesMutated must be 0/,
  );
  assert.throws(
    () =>
      validateInstallNegativeEvidence(
        fixtureNegativeEvidence({ evidenceTarget: 'tracked' }),
      ),
    /evidenceTarget must be temp/,
  );
});

// ─── Tracked artifacts ──────────────────────────────────────────────────────

test('tracked install-gate evidence satisfies the install origin contract', async () => {
  const raw = await readTracked(INSTALL_EVIDENCE_REL);
  const evidence = JSON.parse(raw);
  validateInstallGateEvidence(evidence);
});

test('tracked install-negative evidence proves fail-closed without clobber', async () => {
  const raw = await readTracked(NEGATIVE_EVIDENCE_REL);
  const evidence = JSON.parse(raw);
  validateInstallNegativeEvidence(evidence);
});

// ─── Runner source contracts ────────────────────────────────────────────────

test('install-gate runner source implements CLI install + probe extension host (D070)', async () => {
  const src = await readTracked(INSTALL_RUNNER_REL);
  assert.match(src, /--install-extension|install-extension/);
  assert.match(src, /extensions-dir/);
  assert.match(src, /downloadAndUnzipVSCode|resolveCliPathFromVSCodeExecutablePath|resolveCliArgsFromVSCodeExecutablePath/);
  assert.match(src, /runTests/);
  assert.match(src, /packaging-install-host-smoke/);
  assert.match(src, /classifyInstalledOrigin|buildInstallGateEvidence/);
  assert.match(src, /muster-install-probe|probe extension|probeExtension/i);
  // Must never disable extensions (that would hide the installed copy).
  assert.doesNotMatch(src, /--disable-extensions/);
  // Must write the tracked evidence path by default.
  assert.match(src, /m022-s05-install-gate-evidence\.json/);
});

test('install-negative runner source corrupts a temp VSIX and routes evidence to temp (D071)', async () => {
  const src = await readTracked(NEGATIVE_RUNNER_REL);
  assert.match(src, /extension\/dist\/src\/extension\.js/);
  assert.match(src, /AdmZip|adm-zip/);
  assert.match(src, /run-m022-s05-install-gate/);
  assert.match(src, /m022-s05-install-negative-evidence\.json/);
  // Temp evidence routing — must not default to the positive tracked path.
  assert.match(src, /mkdtemp|temp|tmpdir/i);
  assert.match(src, /install-rejected|activation-failed|bridge-unreachable/);
  // Zero tracked mutations — no .vscodeignore / package.json rewrite.
  assert.doesNotMatch(src, /writeFileSync\(\s*path\.join\(root,\s*['"]package\.json['"]/);
  assert.doesNotMatch(src, /\.vscodeignore/);
});

test('install host smoke source still reports extensionPath for origin classification', async () => {
  const src = await readTracked(HOST_SMOKE_REL);
  assert.match(src, /extensionPath/);
  assert.match(src, /tlelabs\.muster/);
  assert.match(src, /m022-s05-install-host-smoke/);
});

test('tracked evidence files exist and are non-empty', async () => {
  for (const rel of [INSTALL_EVIDENCE_REL, NEGATIVE_EVIDENCE_REL]) {
    const st = await stat(path.join(root, rel));
    assert.ok(st.isFile(), `${rel} must be a file`);
    assert.ok(st.size > 20, `${rel} must be non-empty`);
  }
});
