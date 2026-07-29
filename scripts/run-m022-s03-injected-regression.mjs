/**
 * M022/S03 deliberately injected dependency regression drill.
 *
 * 1. Snapshot package.json as originalBytes.
 * 2. Inject a webview-only package (default: mermaid) into dependencies.
 * 3. Run the CI-wired fast-tier command (`npm run test:m022-s02`) and require a
 *    non-zero exit that names the injected package.
 * 4. Restore package.json byte-for-byte.
 * 5. Re-run the same command and require exit 0.
 * 6. Write docs/plans/m022-s03-injected-regression-evidence.json.
 *
 * Self-diagnosing: always prints which command was expected to fail, its actual
 * exit code, and whether package.json was restored — even on abort.
 *
 * Never clobbers the packaging-gate tracked evidence artifact (MEM336).
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const packageJsonPath = path.join(root, 'package.json');
const evidenceRel = 'docs/plans/m022-s03-injected-regression-evidence.json';
const evidencePath = path.join(root, evidenceRel);
const CI_WIRED_COMMAND = 'npm run test:m022-s02';
const DEFAULT_INJECTED = 'mermaid';

/** @type {{ restored: boolean, packageJsonRestoredByteForByte: boolean, regressionExitCode: number | null, restoredExitCode: number | null, injectedPackage: string | null }} */
const drillState = {
  restored: false,
  packageJsonRestoredByteForByte: false,
  regressionExitCode: null,
  restoredExitCode: null,
  injectedPackage: null,
};

/**
 * @param {string} label
 * @param {unknown} value
 */
function log(label, value) {
  console.log(`[m022-s03-injected-regression] ${label}: ${String(value)}`);
}

/**
 * Run the CI-wired npm script via shell so Windows npm.cmd resolves.
 * @returns {{ exitCode: number, combined: string }}
 */
function runCiWiredCommand() {
  // Prefer spawning npm with args over shell string interpolation.
  const result = spawnSync('npm', ['run', 'test:m022-s02'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    shell: true, // required on Windows for npm.cmd
    maxBuffer: 16 * 1024 * 1024,
  });
  const exitCode =
    typeof result.status === 'number'
      ? result.status
      : result.signal
        ? 1
        : 1;
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}${
    result.error ? `\n${result.error.message}` : ''
  }`;
  return { exitCode, combined };
}

/**
 * @param {Buffer} originalBytes
 * @returns {boolean}
 */
function restorePackageJson(originalBytes) {
  writeFileSync(packageJsonPath, originalBytes);
  const after = readFileSync(packageJsonPath);
  const ok = Buffer.compare(after, originalBytes) === 0;
  drillState.restored = true;
  drillState.packageJsonRestoredByteForByte = ok;
  return ok;
}

function main() {
  const started = Date.now();
  const originalBytes = readFileSync(packageJsonPath);
  let pkg;
  try {
    pkg = JSON.parse(originalBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${error.message}`);
  }

  const injectedPackage =
    process.env.M022_S03_INJECTED_PACKAGE?.trim() || DEFAULT_INJECTED;
  drillState.injectedPackage = injectedPackage;

  const devVersion = pkg.devDependencies?.[injectedPackage];
  if (typeof devVersion !== 'string' || !devVersion) {
    throw new Error(
      `injected package ${injectedPackage} must exist under devDependencies so the drill reuses its version pin`,
    );
  }
  if (pkg.dependencies?.[injectedPackage]) {
    throw new Error(
      `injected package ${injectedPackage} is already under dependencies — aborting before mutating package.json`,
    );
  }

  log('command expected to fail', CI_WIRED_COMMAND);
  log('injectedPackage', injectedPackage);
  log('injectedVersion', devVersion);

  // Mutate: reintroduce webview-only package under production dependencies.
  const mutated = structuredClone(pkg);
  mutated.dependencies = {
    ...(mutated.dependencies ?? {}),
    [injectedPackage]: devVersion,
  };
  // Stable 2-space JSON + trailing newline matches repo package.json style closely
  // enough for the drill; byte-for-byte restore uses originalBytes regardless.
  writeFileSync(packageJsonPath, `${JSON.stringify(mutated, null, 2)}\n`);

  let regressionExitCode = 1;
  let regressionNamedPackage = false;
  let restoredExitCode = 1;
  let ok = false;
  let failure = /** @type {string | null} */ (null);

  try {
    const regression = runCiWiredCommand();
    regressionExitCode = regression.exitCode;
    drillState.regressionExitCode = regressionExitCode;
    regressionNamedPackage = regression.combined.includes(injectedPackage);

    log('regression exit code', regressionExitCode);
    log('regression named package', regressionNamedPackage);

    if (regressionExitCode === 0) {
      failure = `expected ${CI_WIRED_COMMAND} to fail after injecting ${injectedPackage}, but exit code was 0`;
    } else if (!regressionNamedPackage) {
      failure = `expected failure output to name injected package ${injectedPackage}`;
    }
  } finally {
    // Always restore package.json, even when the regression phase throws/aborts.
    const restoredOk = restorePackageJson(originalBytes);
    log('package.json restored', restoredOk);
    log('packageJsonRestoredByteForByte', restoredOk);
    if (!restoredOk) {
      failure =
        failure ??
        'package.json was not restored byte-for-byte after the injected regression';
    }
  }

  if (!failure) {
    const clean = runCiWiredCommand();
    restoredExitCode = clean.exitCode;
    drillState.restoredExitCode = restoredExitCode;
    log('restored exit code', restoredExitCode);
    if (restoredExitCode !== 0) {
      failure = `expected ${CI_WIRED_COMMAND} to pass after restore, but exit code was ${restoredExitCode}`;
    } else {
      ok = true;
    }
  } else {
    // Still attempt a clean re-run after restore so an aborted drill leaves a
    // usable tree and a recorded restoredExitCode when possible.
    try {
      const clean = runCiWiredCommand();
      restoredExitCode = clean.exitCode;
      drillState.restoredExitCode = restoredExitCode;
      log('restored exit code', restoredExitCode);
    } catch (error) {
      log('restored re-run error', error instanceof Error ? error.message : error);
    }
  }

  const evidence = {
    kind: 'm022-s03-injected-regression',
    ok,
    command: CI_WIRED_COMMAND,
    injectedPackage,
    injectedVersion: devVersion,
    regressionExitCode,
    regressionNamedPackage,
    restored: drillState.restored,
    packageJsonRestoredByteForByte: drillState.packageJsonRestoredByteForByte,
    restoredExitCode,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  log('evidence written', evidenceRel);
  log('ok', ok);

  if (failure) {
    console.error(`[m022-s03-injected-regression] FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `[m022-s03-injected-regression] PASS: ${CI_WIRED_COMMAND} blocked injected ${injectedPackage} (exit ${regressionExitCode}) and passed after byte-for-byte restore`,
  );
}

try {
  main();
} catch (error) {
  // Best-effort restore if we already snapshotted.
  try {
    if (!drillState.restored) {
      // Re-read is not possible if originalBytes is scoped inside main; the
      // finally inside main handles the common path. This catch covers parse/
      // pre-mutation failures only.
    }
  } catch {
    // ignore secondary restore errors
  }
  log('package.json restored', drillState.restored);
  log('regression exit code', drillState.regressionExitCode ?? 'n/a');
  console.error(
    `[m022-s03-injected-regression] ABORT: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
