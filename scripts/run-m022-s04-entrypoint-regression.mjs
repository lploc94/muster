/**
 * M022/S04 deliberately injected entrypoint-resolution regression drill.
 *
 * 1. Snapshot .vscodeignore as originalBytes + sha256Before.
 * 2. Inject an exclusion for a required archive entrypoint (default: SQLite worker).
 * 3. Run the packaging census gate with --evidence at a temp path; require a
 *    non-zero exit that names the broken entry path and its typed phase.
 * 4. Restore .vscodeignore byte-for-byte and record sha256After.
 * 5. Re-run the same gate command and require exit 0.
 * 6. Write docs/plans/m022-s04-entrypoint-regression-evidence.json.
 *
 * Self-diagnosing: always prints which command was expected to fail, its actual
 * exit code, the entry path/phase, and whether .vscodeignore was restored —
 * even on abort.
 *
 * Never clobbers the packaging-gate tracked evidence artifact (MEM336 / S04).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const mutatedFileRel = '.vscodeignore';
const mutatedFilePath = path.join(root, mutatedFileRel);
const evidenceRel = 'docs/plans/m022-s04-entrypoint-regression-evidence.json';
const evidencePath = path.join(root, evidenceRel);
const DEFAULT_EXCLUSION = 'dist/src/task/sqlite/worker.js';
const DEFAULT_ENTRY_PATH = 'extension/dist/src/task/sqlite/worker.js';
const DEFAULT_TYPED_PHASE = 'missing-archive-entry';

/** @type {{
 *   restored: boolean,
 *   restoredByteForByte: boolean,
 *   regressionExitCode: number | null,
 *   restoredExitCode: number | null,
 *   injectedExclusion: string | null,
 *   entryPath: string | null,
 *   typedPhase: string | null,
 *   sha256Before: string | null,
 *   sha256After: string | null,
 * }} */
const drillState = {
  restored: false,
  restoredByteForByte: false,
  regressionExitCode: null,
  restoredExitCode: null,
  injectedExclusion: null,
  entryPath: null,
  typedPhase: null,
  sha256Before: null,
  sha256After: null,
};

/**
 * @param {string} label
 * @param {unknown} value
 */
function log(label, value) {
  console.log(`[m022-s04-entrypoint-regression] ${label}: ${String(value)}`);
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Run packaging gate in census-only mode with a temp --evidence path.
 * @param {string} tempEvidencePath
 * @returns {{ exitCode: number, combined: string, command: string }}
 */
function runCensusGate(tempEvidencePath) {
  // Use a relative evidence token in the recorded command so the tracked
  // evidence JSON never carries absolute machine paths.
  const command = `node scripts/run-packaging-gate.mjs --census-only --evidence <temp-evidence>`;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'run-packaging-gate.mjs'),
      '--census-only',
      '--evidence',
      tempEvidencePath,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const exitCode =
    typeof result.status === 'number'
      ? result.status
      : result.signal
        ? 1
        : 1;
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}${
    result.error ? `\n${result.error.message}` : ''
  }`;
  return { exitCode, combined, command };
}

/**
 * @param {Buffer} originalBytes
 * @returns {boolean}
 */
function restoreMutatedFile(originalBytes) {
  writeFileSync(mutatedFilePath, originalBytes);
  const after = readFileSync(mutatedFilePath);
  const ok = Buffer.compare(after, originalBytes) === 0;
  drillState.restored = true;
  drillState.restoredByteForByte = ok;
  drillState.sha256After = sha256Hex(after);
  return ok;
}

/**
 * Append an exclusion line if not already present.
 * @param {string} originalText
 * @param {string} exclusion
 * @returns {string}
 */
function injectExclusion(originalText, exclusion) {
  const lines = originalText.split(/\r?\n/);
  const already = lines.some((line) => line.trim() === exclusion);
  if (already) {
    throw new Error(
      `exclusion ${exclusion} is already present in ${mutatedFileRel} — aborting before mutate`,
    );
  }
  const needsTrailingNewline =
    originalText.length === 0 || originalText.endsWith('\n');
  const body = needsTrailingNewline ? originalText : `${originalText}\n`;
  return `${body}\n# M022/S04 entrypoint-resolution regression injection (temporary)\n${exclusion}\n`;
}

function main() {
  const started = Date.now();
  const originalBytes = readFileSync(mutatedFilePath);
  const sha256Before = sha256Hex(originalBytes);
  drillState.sha256Before = sha256Before;

  const injectedExclusion =
    process.env.M022_S04_INJECTED_EXCLUSION?.trim() || DEFAULT_EXCLUSION;
  const entryPath =
    process.env.M022_S04_ENTRY_PATH?.trim() || DEFAULT_ENTRY_PATH;
  const typedPhase =
    process.env.M022_S04_TYPED_PHASE?.trim() || DEFAULT_TYPED_PHASE;
  drillState.injectedExclusion = injectedExclusion;
  drillState.entryPath = entryPath;
  drillState.typedPhase = typedPhase;

  const tempDir = mkdtempSync(path.join(tmpdir(), 'm022-s04-entrypoint-'));
  const tempEvidencePath = path.join(tempDir, 'packaging-gate-evidence.json');

  log('command expected to fail', 'node scripts/run-packaging-gate.mjs --census-only --evidence <temp-evidence>');
  log('mutatedFile', mutatedFileRel);
  log('injectedExclusion', injectedExclusion);
  log('entryPath', entryPath);
  log('typedPhase', typedPhase);
  log('sha256Before', sha256Before);

  writeFileSync(
    mutatedFilePath,
    injectExclusion(originalBytes.toString('utf8'), injectedExclusion),
  );

  let regressionExitCode = 1;
  let regressionNamedEntryPath = false;
  let regressionNamedPhase = false;
  let restoredExitCode = 1;
  let ok = false;
  let failure = /** @type {string | null} */ (null);
  let command =
    'node scripts/run-packaging-gate.mjs --census-only --evidence <temp-evidence>';

  try {
    const regression = runCensusGate(tempEvidencePath);
    command = regression.command;
    regressionExitCode = regression.exitCode;
    drillState.regressionExitCode = regressionExitCode;
    regressionNamedEntryPath = regression.combined.includes(entryPath);
    regressionNamedPhase =
      regression.combined.includes(typedPhase) ||
      regression.combined.includes(`${entryPath}(${typedPhase})`);

    log('regression exit code', regressionExitCode);
    log('regression named entry path', regressionNamedEntryPath);
    log('regression named phase', regressionNamedPhase);

    if (regressionExitCode === 0) {
      failure = `expected packaging census gate to fail after excluding ${injectedExclusion}, but exit code was 0`;
    } else if (!regressionNamedEntryPath) {
      failure = `expected failure output to name entry path ${entryPath}`;
    } else if (!regressionNamedPhase) {
      failure = `expected failure output to name typed phase ${typedPhase}`;
    }
  } finally {
    // Always restore .vscodeignore, even when the regression phase aborts.
    const restoredOk = restoreMutatedFile(originalBytes);
    log('restored', restoredOk);
    log('restoredByteForByte', restoredOk);
    log('sha256After', drillState.sha256After);
    if (!restoredOk) {
      failure =
        failure ??
        `${mutatedFileRel} was not restored byte-for-byte after the injected regression`;
    }
  }

  if (!failure) {
    const clean = runCensusGate(tempEvidencePath);
    restoredExitCode = clean.exitCode;
    drillState.restoredExitCode = restoredExitCode;
    log('restored exit code', restoredExitCode);
    if (restoredExitCode !== 0) {
      failure = `expected packaging census gate to pass after restore, but exit code was ${restoredExitCode}`;
    } else {
      ok = true;
    }
  } else {
    // Still attempt a clean re-run after restore so an aborted drill leaves a
    // usable tree and a recorded restoredExitCode when possible.
    try {
      const clean = runCensusGate(tempEvidencePath);
      restoredExitCode = clean.exitCode;
      drillState.restoredExitCode = restoredExitCode;
      log('restored exit code', restoredExitCode);
    } catch (error) {
      log('restored re-run error', error instanceof Error ? error.message : error);
    }
  }

  const evidence = {
    kind: 'm022-s04-entrypoint-regression',
    ok,
    command,
    mutatedFile: mutatedFileRel,
    injectedExclusion,
    entryPath,
    typedPhase,
    regressionExitCode,
    regressionNamedEntryPath,
    regressionNamedPhase,
    sha256Before,
    sha256After: drillState.sha256After,
    restored: drillState.restored,
    restoredByteForByte: drillState.restoredByteForByte,
    restoredExitCode,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  log('evidence written', evidenceRel);
  log('ok', ok);

  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore temp cleanup
  }

  if (failure) {
    console.error(`[m022-s04-entrypoint-regression] FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `[m022-s04-entrypoint-regression] PASS: packaging census gate blocked excluded ${entryPath} phase=${typedPhase} (exit ${regressionExitCode}) and passed after byte-for-byte restore (sha256 match)`,
  );
}

try {
  main();
} catch (error) {
  // Best-effort restore if we already snapshotted inside main; for pre-mutation
  // failures the file was never written.
  log(
    'aborted',
    error instanceof Error ? error.message : String(error),
  );
  log('restored', drillState.restored);
  log('restoredByteForByte', drillState.restoredByteForByte);
  log('sha256Before', drillState.sha256Before);
  log('sha256After', drillState.sha256After);
  console.error(
    `[m022-s04-entrypoint-regression] FAIL: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
