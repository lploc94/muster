/**
 * Fail-closed contract for the M022/S03 deliberately injected dependency regression.
 *
 * Proves the CI-wired fast-tier gate (`npm run test:m022-s02`) blocks when a
 * webview-only package is reintroduced under `dependencies`, that the failure
 * names the injected package, and that package.json is restored byte-for-byte
 * before a clean re-run passes.
 *
 * Fixture-backed node:test — never inspects live hosts, secrets, or gitignored paths.
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const EVIDENCE_REL = 'docs/plans/m022-s03-injected-regression-evidence.json';
const RUNNER_REL = 'scripts/run-m022-s03-injected-regression.mjs';
const CI_WIRED_COMMAND = 'npm run test:m022-s02';
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

async function readTracked(rel) {
  return readFile(path.join(root, rel), 'utf8');
}

/**
 * Validate the tracked injected-regression evidence snapshot.
 * @param {unknown} evidence
 */
export function validateInjectedRegressionEvidence(evidence) {
  assert.ok(evidence && typeof evidence === 'object', 'evidence must be an object');
  const e = /** @type {Record<string, unknown>} */ (evidence);

  assert.equal(e.kind, 'm022-s03-injected-regression', 'kind must be m022-s03-injected-regression');
  assert.equal(e.ok, true, 'evidence.ok must be true (drill succeeded end-to-end)');
  assert.equal(
    e.command,
    CI_WIRED_COMMAND,
    `command must be the CI-wired fast-tier gate (${CI_WIRED_COMMAND})`,
  );

  const injectedPackage = e.injectedPackage;
  assert.equal(typeof injectedPackage, 'string', 'injectedPackage must be a string');
  assert.ok(
    WEBVIEW_ONLY_PACKAGES.includes(/** @type {string} */ (injectedPackage)),
    `injectedPackage must be a known webview-only package; got ${String(injectedPackage)}`,
  );
  assert.equal(typeof e.injectedVersion, 'string', 'injectedVersion must be a string');
  assert.ok(
    String(e.injectedVersion).length > 0,
    'injectedVersion must be non-empty',
  );

  const regressionExitCode = e.regressionExitCode;
  assert.equal(typeof regressionExitCode, 'number', 'regressionExitCode must be a number');
  assert.ok(
    Number.isInteger(regressionExitCode) && regressionExitCode !== 0,
    `regressionExitCode must be a non-zero integer (got ${String(regressionExitCode)})`,
  );

  assert.equal(
    e.regressionNamedPackage,
    true,
    'regressionNamedPackage must be true (failure output named the injected package)',
  );
  assert.equal(e.restored, true, 'restored must be true');
  assert.equal(
    e.packageJsonRestoredByteForByte,
    true,
    'packageJsonRestoredByteForByte must be true',
  );

  const restoredExitCode = e.restoredExitCode;
  assert.equal(typeof restoredExitCode, 'number', 'restoredExitCode must be a number');
  assert.equal(
    restoredExitCode,
    0,
    `restoredExitCode must be 0 after package.json restore (got ${String(restoredExitCode)})`,
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
    kind: 'm022-s03-injected-regression',
    ok: true,
    command: CI_WIRED_COMMAND,
    injectedPackage: 'mermaid',
    injectedVersion: '^11.16.0',
    regressionExitCode: 1,
    regressionNamedPackage: true,
    restored: true,
    packageJsonRestoredByteForByte: true,
    restoredExitCode: 0,
    generatedAt: '2026-07-29T00:00:00.000Z',
    durationMs: 1200,
    ...overrides,
  };
}

test('tracked injected-regression evidence satisfies the operational contract', async () => {
  let raw;
  try {
    raw = await readTracked(EVIDENCE_REL);
  } catch (error) {
    assert.fail(`missing injected-regression evidence (${error.code ?? error.message})`);
  }
  const evidence = JSON.parse(raw);
  validateInjectedRegressionEvidence(evidence);
});

test('package.json exposes regression runner + evidence scripts', async () => {
  const pkg = JSON.parse(await readTracked('package.json'));
  assert.equal(
    pkg.scripts?.['test:m022-s03-regression'],
    'node scripts/run-m022-s03-injected-regression.mjs',
    'test:m022-s03-regression must invoke the injected-regression runner',
  );
  assert.equal(
    pkg.scripts?.['test:m022-s03-regression-evidence'],
    'node --test scripts/verify-m022-s03-injected-regression-evidence.test.mjs',
    'test:m022-s03-regression-evidence must run this contract',
  );
  await stat(path.join(root, RUNNER_REL));
});

test('runner restores package.json and prints self-diagnosing drill output', async () => {
  const source = await readTracked(RUNNER_REL);
  assert.match(source, /package\.json/, 'runner must touch package.json');
  assert.match(source, /test:m022-s02/, 'runner must invoke the CI-wired command');
  assert.match(source, /restor/i, 'runner must restore package.json');
  assert.match(
    source,
    /byte[- ]?for[- ]?byte|originalBuffer|originalBytes|originalRaw/i,
    'runner must restore package.json byte-for-byte',
  );
  assert.match(source, /console\.log/, 'runner must print drill diagnostics');
  assert.match(source, /exit code|exitCode|exit_code/i, 'runner must report exit codes');
  // Must never clobber the packaging-gate tracked evidence (MEM336).
  assert.doesNotMatch(
    source,
    /m022-s01-packaging-gate-evidence\.json/,
    'runner must not write the packaging-gate tracked evidence path',
  );
});

test('accepts a complete injected-regression fixture', () => {
  assert.equal(validateInjectedRegressionEvidence(fixtureEvidence()), true);
});

test('rejects clean exit on the injected regression phase', () => {
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({ regressionExitCode: 0, ok: true }),
      ),
    /regressionExitCode/,
  );
});

test('rejects when the failure did not name the injected package', () => {
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({ regressionNamedPackage: false }),
      ),
    /regressionNamedPackage/,
  );
});

test('rejects unrestored package.json or non-zero clean re-run', () => {
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({
          restored: false,
          packageJsonRestoredByteForByte: false,
        }),
      ),
    /restored|packageJsonRestoredByteForByte/,
  );
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({ restoredExitCode: 1 }),
      ),
    /restoredExitCode/,
  );
});

test('rejects wrong command, wrong kind, or non-webview package', () => {
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({ command: 'npm run test:packaging' }),
      ),
    /CI-wired|test:m022-s02/,
  );
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({ kind: 'm022-s01-packaging-gate' }),
      ),
    /kind/,
  );
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({ injectedPackage: 'left-pad' }),
      ),
    /webview-only/,
  );
});

test('rejects secret-like text and absolute paths in evidence', () => {
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({ note: 'OPENAI_API_KEY leaked' }),
      ),
    /secret-like/,
  );
  assert.throws(
    () =>
      validateInjectedRegressionEvidence(
        fixtureEvidence({ note: 'D:/_Dev/muster/package.json' }),
      ),
    /absolute machine paths/,
  );
});
