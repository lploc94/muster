/**
 * Fail-closed contract for the M022/S04 entrypoint-resolution regression drill.
 *
 * Proves the packaging census gate blocks when a required archive entrypoint is
 * excluded via `.vscodeignore`, that the failure names the entry path with a
 * typed phase, and that the mutated file is restored with matching sha256
 * before a clean re-run passes.
 *
 * Fixture-backed node:test — never inspects live hosts, secrets, or gitignored paths.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const EVIDENCE_REL = 'docs/plans/m022-s04-entrypoint-regression-evidence.json';
const RUNNER_REL = 'scripts/run-m022-s04-entrypoint-regression.mjs';
const MUTATED_FILE = '.vscodeignore';
const GATE_COMMAND_PREFIX = 'node scripts/run-packaging-gate.mjs --census-only --evidence';
const ALLOWED_ENTRY_PATHS = [
  'extension/dist/src/extension.js',
  'extension/dist/src/task/sqlite/worker.js',
  'extension/dist/src/bridge/mcp-stdio-proxy.js',
];
const ALLOWED_PHASES = [
  'missing-archive-entry',
  'require-failed',
  'spawn-failed',
];

async function readTracked(rel) {
  return readFile(path.join(root, rel), 'utf8');
}

/**
 * Validate the tracked entrypoint-regression evidence snapshot.
 * @param {unknown} evidence
 */
export function validateEntrypointRegressionEvidence(evidence) {
  assert.ok(evidence && typeof evidence === 'object', 'evidence must be an object');
  const e = /** @type {Record<string, unknown>} */ (evidence);

  assert.equal(
    e.kind,
    'm022-s04-entrypoint-regression',
    'kind must be m022-s04-entrypoint-regression',
  );
  assert.equal(e.ok, true, 'evidence.ok must be true (drill succeeded end-to-end)');

  const command = e.command;
  assert.equal(typeof command, 'string', 'command must be a string');
  assert.ok(
    String(command).startsWith(GATE_COMMAND_PREFIX),
    `command must start with "${GATE_COMMAND_PREFIX}" (got ${String(command)})`,
  );
  // Temp evidence path only — never the tracked packaging-gate artifact.
  assert.doesNotMatch(
    String(command),
    /m022-s01-packaging-gate-evidence\.json/,
    'command must not target the packaging-gate tracked evidence path',
  );

  assert.equal(
    e.mutatedFile,
    MUTATED_FILE,
    `mutatedFile must be ${MUTATED_FILE}`,
  );

  const injectedExclusion = e.injectedExclusion;
  assert.equal(typeof injectedExclusion, 'string', 'injectedExclusion must be a string');
  assert.ok(
    String(injectedExclusion).length > 0,
    'injectedExclusion must be non-empty',
  );
  assert.doesNotMatch(
    String(injectedExclusion),
    /\\/,
    'injectedExclusion must use forward-slash repo-relative paths',
  );

  const entryPath = e.entryPath;
  assert.equal(typeof entryPath, 'string', 'entryPath must be a string');
  assert.ok(
    ALLOWED_ENTRY_PATHS.includes(/** @type {string} */ (entryPath)),
    `entryPath must be a required archive entrypoint; got ${String(entryPath)}`,
  );

  const typedPhase = e.typedPhase;
  assert.equal(typeof typedPhase, 'string', 'typedPhase must be a string');
  assert.ok(
    ALLOWED_PHASES.includes(/** @type {string} */ (typedPhase)),
    `typedPhase must be a known packaging failure phase; got ${String(typedPhase)}`,
  );

  const regressionExitCode = e.regressionExitCode;
  assert.equal(typeof regressionExitCode, 'number', 'regressionExitCode must be a number');
  assert.ok(
    Number.isInteger(regressionExitCode) && regressionExitCode !== 0,
    `regressionExitCode must be a non-zero integer (got ${String(regressionExitCode)})`,
  );

  assert.equal(
    e.regressionNamedEntryPath,
    true,
    'regressionNamedEntryPath must be true (failure output named the broken entry path)',
  );
  assert.equal(
    e.regressionNamedPhase,
    true,
    'regressionNamedPhase must be true (failure output named the typed phase)',
  );

  const sha256Before = e.sha256Before;
  const sha256After = e.sha256After;
  assert.equal(typeof sha256Before, 'string', 'sha256Before must be a string');
  assert.equal(typeof sha256After, 'string', 'sha256After must be a string');
  assert.match(
    String(sha256Before),
    /^[a-f0-9]{64}$/,
    'sha256Before must be a 64-char lowercase hex digest',
  );
  assert.match(
    String(sha256After),
    /^[a-f0-9]{64}$/,
    'sha256After must be a 64-char lowercase hex digest',
  );
  assert.equal(
    sha256Before,
    sha256After,
    'sha256Before and sha256After must match (byte-for-byte restore)',
  );

  assert.equal(e.restored, true, 'restored must be true');
  assert.equal(
    e.restoredByteForByte,
    true,
    'restoredByteForByte must be true',
  );

  const restoredExitCode = e.restoredExitCode;
  assert.equal(typeof restoredExitCode, 'number', 'restoredExitCode must be a number');
  assert.equal(
    restoredExitCode,
    0,
    `restoredExitCode must be 0 after restore (got ${String(restoredExitCode)})`,
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

  // Redaction / safety: no env values, absolute paths, or secrets in the snapshot.
  const serialized = JSON.stringify(e);
  assert.doesNotMatch(
    serialized,
    /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|Bearer\s+sk-|sk-ant-|sk-proj-)/i,
    'evidence must not contain secret-like text',
  );
  assert.doesNotMatch(
    serialized,
    /(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|\/tmp\/)/,
    'evidence must not contain absolute machine paths',
  );

  return true;
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function fixtureEvidence(overrides = {}) {
  return {
    kind: 'm022-s04-entrypoint-regression',
    ok: true,
    command: `${GATE_COMMAND_PREFIX} <temp-evidence>`,
    mutatedFile: MUTATED_FILE,
    injectedExclusion: 'dist/src/task/sqlite/worker.js',
    entryPath: 'extension/dist/src/task/sqlite/worker.js',
    typedPhase: 'missing-archive-entry',
    regressionExitCode: 1,
    regressionNamedEntryPath: true,
    regressionNamedPhase: true,
    sha256Before: 'a'.repeat(64),
    sha256After: 'a'.repeat(64),
    restored: true,
    restoredByteForByte: true,
    restoredExitCode: 0,
    generatedAt: '2026-07-29T00:00:00.000Z',
    durationMs: 1200,
    ...overrides,
  };
}

test('tracked entrypoint-regression evidence satisfies the operational contract', async () => {
  let raw;
  try {
    raw = await readTracked(EVIDENCE_REL);
  } catch (error) {
    assert.fail(
      `missing entrypoint-regression evidence (${error.code ?? error.message})`,
    );
  }
  const evidence = JSON.parse(raw);
  validateEntrypointRegressionEvidence(evidence);
});

test('package.json exposes entrypoint-regression runner + evidence scripts', async () => {
  const pkg = JSON.parse(await readTracked('package.json'));
  assert.equal(
    pkg.scripts?.['test:m022-s04-entrypoint-regression'],
    'node scripts/run-m022-s04-entrypoint-regression.mjs',
    'test:m022-s04-entrypoint-regression must invoke the entrypoint-regression runner',
  );
  assert.equal(
    pkg.scripts?.['test:m022-s04-entrypoint-regression-evidence'],
    'node --test scripts/verify-m022-s04-entrypoint-regression-evidence.test.mjs',
    'test:m022-s04-entrypoint-regression-evidence must run this contract',
  );
  await stat(path.join(root, RUNNER_REL));
});

test('runner mutates .vscodeignore, uses temp --evidence, and restores with sha256', async () => {
  const source = await readTracked(RUNNER_REL);
  assert.match(source, /\.vscodeignore/, 'runner must touch .vscodeignore');
  assert.match(
    source,
    /--census-only/,
    'runner must invoke packaging gate in --census-only mode',
  );
  assert.match(source, /--evidence/, 'runner must route gate evidence via --evidence');
  assert.match(source, /sha256|createHash/i, 'runner must compute sha256 digests');
  assert.match(source, /restor/i, 'runner must restore the mutated file');
  assert.match(
    source,
    /byte[- ]?for[- ]?byte|originalBytes|originalRaw|Buffer\.compare/i,
    'runner must restore byte-for-byte',
  );
  assert.match(source, /console\.log/, 'runner must print drill diagnostics');
  assert.match(source, /exit code|exitCode|exit_code/i, 'runner must report exit codes');
  // Must never clobber the packaging-gate tracked evidence (MEM336 / S04 plan).
  assert.doesNotMatch(
    source,
    /m022-s01-packaging-gate-evidence\.json/,
    'runner must not write the packaging-gate tracked evidence path',
  );
  assert.doesNotMatch(
    source,
    /MUSTER_PACKAGING_GATE_EVIDENCE_OUT/,
    'runner must not rely on the default packaging-gate evidence env override alone',
  );
});

test('accepts a complete entrypoint-regression fixture', () => {
  assert.equal(validateEntrypointRegressionEvidence(fixtureEvidence()), true);
});

test('rejects clean exit on the injected regression phase', () => {
  assert.throws(
    () =>
      validateEntrypointRegressionEvidence(
        fixtureEvidence({ regressionExitCode: 0, ok: true }),
      ),
    /regressionExitCode/,
  );
});

test('rejects when the failure did not name the entry path or typed phase', () => {
  assert.throws(
    () =>
      validateEntrypointRegressionEvidence(
        fixtureEvidence({ regressionNamedEntryPath: false }),
      ),
    /regressionNamedEntryPath/,
  );
  assert.throws(
    () =>
      validateEntrypointRegressionEvidence(
        fixtureEvidence({ regressionNamedPhase: false }),
      ),
    /regressionNamedPhase/,
  );
});

test('rejects mismatched sha256 digests or unrestored file', () => {
  assert.throws(
    () =>
      validateEntrypointRegressionEvidence(
        fixtureEvidence({
          sha256Before: 'b'.repeat(64),
          sha256After: 'c'.repeat(64),
        }),
      ),
    /sha256/,
  );
  assert.throws(
    () =>
      validateEntrypointRegressionEvidence(
        fixtureEvidence({
          restored: false,
          restoredByteForByte: false,
        }),
      ),
    /restored/,
  );
});

test('rejects non-zero clean re-run after restore', () => {
  assert.throws(
    () =>
      validateEntrypointRegressionEvidence(
        fixtureEvidence({ restoredExitCode: 1 }),
      ),
    /restoredExitCode/,
  );
});

test('rejects evidence that targets the packaging-gate tracked artifact', () => {
  assert.throws(
    () =>
      validateEntrypointRegressionEvidence(
        fixtureEvidence({
          command:
            'node scripts/run-packaging-gate.mjs --census-only --evidence docs/plans/m022-s01-packaging-gate-evidence.json',
        }),
      ),
    /packaging-gate tracked evidence|command must not target/,
  );
});

test('docs/PACKAGING.md documents the entrypoint-regression drill', async () => {
  const docs = await readTracked('docs/PACKAGING.md');
  assert.match(
    docs,
    /test:m022-s04-entrypoint-regression/,
    'PACKAGING.md must document test:m022-s04-entrypoint-regression',
  );
  assert.match(
    docs,
    /m022-s04-entrypoint-regression-evidence\.json/,
    'PACKAGING.md must name the entrypoint-regression evidence artifact',
  );
  assert.match(
    docs,
    /missing-archive-entry|typed phase|entrypoint/,
    'PACKAGING.md must describe the entrypoint failure surface',
  );
});

// Keep createHash import live so future digest helpers can share this file.
void createHash;
