/**
 * Fail-closed contract for the M022/S04 clean-clone package drill.
 *
 * Proves the documented release command (`npm run package`) produces a `.vsix`
 * after `npm ci` in a real clean clone — not via the createVSIX API the
 * packaging gate wraps. CI validates this tracked evidence artifact rather
 * than re-running the multi-minute clean-clone drill on every push (D069).
 *
 * Fixture-backed node:test — never inspects live hosts, secrets, or gitignored paths.
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const EVIDENCE_REL = 'docs/plans/m022-s04-clean-clone-evidence.json';
const RUNNER_REL = 'scripts/run-m022-s04-clean-clone-package.mjs';
const DOCUMENTED_PACKAGE_COMMAND = 'npm run package';
const DOCUMENTED_INSTALL_COMMAND = 'npm ci';
const ALLOWED_CLONE_METHODS = ['git-clone-local', 'git-clone'];

async function readTracked(rel) {
  return readFile(path.join(root, rel), 'utf8');
}

/**
 * Validate the tracked clean-clone package evidence snapshot.
 * @param {unknown} evidence
 */
export function validateCleanCloneEvidence(evidence) {
  assert.ok(evidence && typeof evidence === 'object', 'evidence must be an object');
  const e = /** @type {Record<string, unknown>} */ (evidence);

  assert.equal(e.kind, 'm022-s04-clean-clone', 'kind must be m022-s04-clean-clone');
  assert.equal(e.ok, true, 'evidence.ok must be true (drill succeeded end-to-end)');

  assert.equal(
    e.command,
    DOCUMENTED_PACKAGE_COMMAND,
    `command must be the documented package command (${DOCUMENTED_PACKAGE_COMMAND})`,
  );
  assert.equal(
    e.installCommand,
    DOCUMENTED_INSTALL_COMMAND,
    `installCommand must be ${DOCUMENTED_INSTALL_COMMAND}`,
  );

  // Must prove the documented npm script surface — not createVSIX API.
  const commandText = String(e.command);
  assert.doesNotMatch(
    commandText,
    /createVSIX|@vscode\/vsce\/.*create/i,
    'command must not invoke the createVSIX API the packaging gate wraps',
  );

  const npmCiExitCode = e.npmCiExitCode;
  assert.equal(typeof npmCiExitCode, 'number', 'npmCiExitCode must be a number');
  assert.equal(
    npmCiExitCode,
    0,
    `npmCiExitCode must be 0 (got ${String(npmCiExitCode)})`,
  );

  const packageExitCode = e.packageExitCode;
  assert.equal(typeof packageExitCode, 'number', 'packageExitCode must be a number');
  assert.equal(
    packageExitCode,
    0,
    `packageExitCode must be 0 (got ${String(packageExitCode)})`,
  );

  const vsixName = e.vsixName;
  assert.equal(typeof vsixName, 'string', 'vsixName must be a string');
  assert.match(
    String(vsixName),
    /^[\w.-]+\.vsix$/,
    `vsixName must be a .vsix basename (got ${String(vsixName)})`,
  );
  assert.doesNotMatch(
    String(vsixName),
    /[\\/]/,
    'vsixName must be a basename only (no path separators)',
  );

  const vsixSizeBytes = e.vsixSizeBytes;
  assert.equal(typeof vsixSizeBytes, 'number', 'vsixSizeBytes must be a number');
  assert.ok(
    Number.isInteger(/** @type {number} */ (vsixSizeBytes)) &&
      /** @type {number} */ (vsixSizeBytes) > 0,
    `vsixSizeBytes must be a positive integer (got ${String(vsixSizeBytes)})`,
  );

  const cloneMethod = e.cloneMethod;
  assert.equal(typeof cloneMethod, 'string', 'cloneMethod must be a string');
  assert.ok(
    ALLOWED_CLONE_METHODS.includes(/** @type {string} */ (cloneMethod)),
    `cloneMethod must be one of ${ALLOWED_CLONE_METHODS.join(', ')}; got ${String(cloneMethod)}`,
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
    kind: 'm022-s04-clean-clone',
    ok: true,
    command: DOCUMENTED_PACKAGE_COMMAND,
    installCommand: DOCUMENTED_INSTALL_COMMAND,
    npmCiExitCode: 0,
    packageExitCode: 0,
    vsixName: 'tlelabs-muster-0.1.0.vsix',
    vsixSizeBytes: 1_024_000,
    cloneMethod: 'git-clone-local',
    generatedAt: '2026-07-29T00:00:00.000Z',
    durationMs: 120_000,
    ...overrides,
  };
}

test('tracked clean-clone evidence satisfies the operational contract', async () => {
  let raw;
  try {
    raw = await readTracked(EVIDENCE_REL);
  } catch (error) {
    assert.fail(`missing clean-clone evidence (${error.code ?? error.message})`);
  }
  const evidence = JSON.parse(raw);
  validateCleanCloneEvidence(evidence);
});

test('package.json exposes clean-clone runner, evidence, and aggregate scripts', async () => {
  const pkg = JSON.parse(await readTracked('package.json'));
  assert.equal(
    pkg.scripts?.['test:m022-s04-clean-clone'],
    'node scripts/run-m022-s04-clean-clone-package.mjs',
    'test:m022-s04-clean-clone must invoke the clean-clone package runner',
  );
  assert.equal(
    pkg.scripts?.['test:m022-s04-clean-clone-evidence'],
    'node --test scripts/verify-m022-s04-clean-clone-evidence.test.mjs',
    'test:m022-s04-clean-clone-evidence must run this contract',
  );
  const aggregate = pkg.scripts?.['test:m022-s04'];
  assert.equal(typeof aggregate, 'string', 'test:m022-s04 must be defined');
  assert.match(
    String(aggregate),
    /test:m022-s04-clean-clone-evidence/,
    'test:m022-s04 must include clean-clone evidence validation',
  );
  assert.match(
    String(aggregate),
    /test:m022-s04-entrypoint-regression-evidence/,
    'test:m022-s04 must include entrypoint-regression evidence validation',
  );
  assert.equal(
    pkg.scripts?.package,
    'vsce package',
    'documented package script must remain `vsce package` (not createVSIX API)',
  );
  await stat(path.join(root, RUNNER_REL));
});

test('runner clones cleanly, runs npm ci + npm run package, and never uses createVSIX API', async () => {
  const source = await readTracked(RUNNER_REL);
  assert.match(source, /git\s+clone|cloneMethod|git-clone/i, 'runner must perform a git clone');
  assert.match(source, /npm ci|npmCi|installCommand/i, 'runner must run npm ci in the clone');
  assert.match(
    source,
    /npm run package|run['"]\s*,\s*['"]package['"]/,
    'runner must invoke the documented npm run package command',
  );
  assert.match(source, /\.vsix/, 'runner must assert a .vsix artifact');
  assert.match(source, /console\.log/, 'runner must print drill diagnostics');
  assert.match(source, /exit code|exitCode|exit_code/i, 'runner must report exit codes');
  // Must never call createVSIX API directly — that is the packaging-gate path.
  // Comments may mention createVSIX as the forbidden surface; ban only call forms.
  assert.doesNotMatch(
    source,
    /createVSIX\s*\(|\.createVSIX\b|require\([^)]*@vscode\/vsce[^)]*\)/,
    'runner must not invoke createVSIX / @vscode/vsce (prove documented package command)',
  );
  // Must never clobber the packaging-gate tracked evidence (MEM336 / S04 plan).
  assert.doesNotMatch(
    source,
    /m022-s01-packaging-gate-evidence\.json/,
    'runner must not write the packaging-gate tracked evidence path',
  );
});

test('accepts a complete clean-clone fixture', () => {
  assert.equal(validateCleanCloneEvidence(fixtureEvidence()), true);
});

test('rejects non-zero npm ci or package exit codes', () => {
  assert.throws(
    () => validateCleanCloneEvidence(fixtureEvidence({ npmCiExitCode: 1 })),
    /npmCiExitCode/,
  );
  assert.throws(
    () => validateCleanCloneEvidence(fixtureEvidence({ packageExitCode: 1 })),
    /packageExitCode/,
  );
});

test('rejects missing or invalid vsix name/size', () => {
  assert.throws(
    () => validateCleanCloneEvidence(fixtureEvidence({ vsixName: 'not-a-vsix.zip' })),
    /vsixName/,
  );
  assert.throws(
    () => validateCleanCloneEvidence(fixtureEvidence({ vsixName: 'path/to/x.vsix' })),
    /basename|path separators|vsixName/,
  );
  assert.throws(
    () => validateCleanCloneEvidence(fixtureEvidence({ vsixSizeBytes: 0 })),
    /vsixSizeBytes/,
  );
  assert.throws(
    () => validateCleanCloneEvidence(fixtureEvidence({ vsixSizeBytes: -10 })),
    /vsixSizeBytes/,
  );
});

test('rejects createVSIX command surface or wrong documented command', () => {
  assert.throws(
    () =>
      validateCleanCloneEvidence(
        fixtureEvidence({ command: 'node -e "require(\'@vscode/vsce\').createVSIX()"' }),
      ),
    /documented package command|createVSIX|command/,
  );
  assert.throws(
    () =>
      validateCleanCloneEvidence(
        fixtureEvidence({ command: 'npm run test:packaging' }),
      ),
    /documented package command|npm run package/,
  );
  assert.throws(
    () =>
      validateCleanCloneEvidence(
        fixtureEvidence({ installCommand: 'npm install' }),
      ),
    /installCommand|npm ci/,
  );
});

test('rejects secret-like text and absolute paths in evidence', () => {
  assert.throws(
    () =>
      validateCleanCloneEvidence(
        fixtureEvidence({ note: 'OPENAI_API_KEY leaked' }),
      ),
    /secret-like/,
  );
  assert.throws(
    () =>
      validateCleanCloneEvidence(
        fixtureEvidence({ note: 'D:/_Dev/muster/package.json' }),
      ),
    /absolute machine paths/,
  );
});

test('docs/PACKAGING.md documents the clean-clone package drill', async () => {
  const docs = await readTracked('docs/PACKAGING.md');
  assert.match(
    docs,
    /test:m022-s04-clean-clone/,
    'PACKAGING.md must document test:m022-s04-clean-clone',
  );
  assert.match(
    docs,
    /m022-s04-clean-clone-evidence\.json/,
    'PACKAGING.md must name the clean-clone evidence artifact',
  );
  assert.match(
    docs,
    /clean clone|clean-clone|npm run package/,
    'PACKAGING.md must describe the clean-clone package surface',
  );
});
