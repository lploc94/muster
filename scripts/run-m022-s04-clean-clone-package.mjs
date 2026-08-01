/**
 * M022/S04 clean-clone package drill.
 *
 * Proves the documented release path works from a real clean checkout:
 *   1. git clone the current repo into a scratch dir (local clone)
 *   2. npm ci in the clone
 *   3. npm run package in the clone (documented command — not createVSIX API)
 *   4. assert a .vsix was emitted; record name + size
 *   5. write docs/plans/m022-s04-clean-clone-evidence.json
 *
 * Self-diagnosing: always prints install/package exit codes, vsix name/size,
 * and clone cleanup status — even on abort.
 *
 * Never clobbers the packaging-gate tracked evidence artifact (MEM336 / S04).
 * Never calls createVSIX — that is the packaging-gate wrapper path.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const evidenceRel = 'docs/plans/m022-s04-clean-clone-evidence.json';
const evidencePath = path.join(root, evidenceRel);
const DOCUMENTED_PACKAGE_COMMAND = 'npm run package';
const DOCUMENTED_INSTALL_COMMAND = 'npm ci';
const CLONE_METHOD = 'git-clone-local';

/** @type {{
 *   scratchDir: string | null,
 *   cleaned: boolean,
 *   npmCiExitCode: number | null,
 *   packageExitCode: number | null,
 *   vsixName: string | null,
 *   vsixSizeBytes: number | null,
 * }} */
const drillState = {
  scratchDir: null,
  cleaned: false,
  npmCiExitCode: null,
  packageExitCode: null,
  vsixName: null,
  vsixSizeBytes: null,
};

/**
 * @param {string} label
 * @param {unknown} value
 */
function log(label, value) {
  console.log(`[m022-s04-clean-clone] ${label}: ${String(value)}`);
}

/**
 * Spawn a command in cwd.
 * On Windows, shell:true is required so npm resolves to npm.cmd. Spawning
 * npm.cmd with shell:false fails with EINVAL on current Node (no .cmd exec
 * without a shell). Matches the S03 drill pattern (shell:true for npm).
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ exitCode: number, combined: string }}
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    // Windows: npm is a .cmd shim. Node cannot spawn .cmd with shell:false
    // (EINVAL). shell:true lets cmd.exe resolve npm → npm.cmd and run git.
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
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
 * @param {string} dir
 * @returns {{ name: string, sizeBytes: number } | null}
 */
function findVsix(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const vsix = entries.find((name) => name.endsWith('.vsix'));
  if (!vsix) return null;
  const full = path.join(dir, vsix);
  const st = statSync(full);
  return { name: vsix, sizeBytes: st.size };
}

/**
 * Best-effort cleanup of the scratch clone.
 * @returns {boolean}
 */
function cleanupScratch() {
  if (!drillState.scratchDir) {
    drillState.cleaned = true;
    return true;
  }
  try {
    rmSync(drillState.scratchDir, { recursive: true, force: true });
    drillState.cleaned = !existsSync(drillState.scratchDir);
  } catch {
    drillState.cleaned = !existsSync(drillState.scratchDir);
  }
  return drillState.cleaned;
}

function main() {
  const started = Date.now();
  log('command', DOCUMENTED_PACKAGE_COMMAND);
  log('installCommand', DOCUMENTED_INSTALL_COMMAND);
  log('cloneMethod', CLONE_METHOD);

  // Parent temp dir for the clone; avoid embedding absolute paths in evidence.
  const parentScratch = mkdtempSync(path.join(tmpdir(), 'm022-s04-clean-clone-'));
  const cloneDir = path.join(parentScratch, 'repo');
  drillState.scratchDir = parentScratch;

  let npmCiExitCode = 1;
  let packageExitCode = 1;
  /** @type {string | null} */
  let vsixName = null;
  /** @type {number | null} */
  let vsixSizeBytes = null;
  let ok = false;
  /** @type {string | null} */
  let failure = null;

  try {
    // Local clone of the current repo HEAD into a clean working tree.
    // --no-hardlinks avoids Windows cross-volume hardlink failures when the
    // scratch dir lives on a different filesystem than the worktree
    // (fatal: Improper link under .git/objects). Still offline / no network.
    const clone = run(
      'git',
      ['clone', '--local', '--no-hardlinks', root, cloneDir],
      root,
    );
    log('git clone exit code', clone.exitCode);
    if (clone.exitCode !== 0) {
      const tail = clone.combined
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(-12)
        .join('\n');
      log('git clone output tail', tail);
      failure = `git clone --local --no-hardlinks failed with exit code ${clone.exitCode}`;
      throw new Error(failure);
    }

    const install = run('npm', ['ci'], cloneDir);
    npmCiExitCode = install.exitCode;
    drillState.npmCiExitCode = npmCiExitCode;
    log('npm ci exit code', npmCiExitCode);
    if (npmCiExitCode !== 0) {
      failure = `npm ci failed with exit code ${npmCiExitCode}`;
      throw new Error(failure);
    }

    // Documented package surface only — never createVSIX API.
    const pkgRun = run('npm', ['run', 'package'], cloneDir);
    packageExitCode = pkgRun.exitCode;
    drillState.packageExitCode = packageExitCode;
    log('npm run package exit code', packageExitCode);
    if (packageExitCode !== 0) {
      // Tail a bounded diagnostic without dumping secrets/paths into evidence.
      const tail = pkgRun.combined
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(-20)
        .join('\n');
      log('package output tail', tail);
      failure = `npm run package failed with exit code ${packageExitCode}`;
      throw new Error(failure);
    }

    const vsix = findVsix(cloneDir);
    if (!vsix) {
      failure = 'npm run package exited 0 but no .vsix was emitted in the clone root';
      throw new Error(failure);
    }
    vsixName = vsix.name;
    vsixSizeBytes = vsix.sizeBytes;
    drillState.vsixName = vsixName;
    drillState.vsixSizeBytes = vsixSizeBytes;
    log('vsixName', vsixName);
    log('vsixSizeBytes', vsixSizeBytes);

    if (!Number.isInteger(vsixSizeBytes) || vsixSizeBytes <= 0) {
      failure = `emitted .vsix has invalid size ${String(vsixSizeBytes)}`;
      throw new Error(failure);
    }

    ok = true;
  } catch (error) {
    if (!failure) {
      failure = error instanceof Error ? error.message : String(error);
    }
    log('aborted', failure);
  } finally {
    const cleaned = cleanupScratch();
    log('scratch cleaned', cleaned);
  }

  const evidence = {
    kind: 'm022-s04-clean-clone',
    ok,
    command: DOCUMENTED_PACKAGE_COMMAND,
    installCommand: DOCUMENTED_INSTALL_COMMAND,
    npmCiExitCode,
    packageExitCode,
    vsixName: vsixName ?? '',
    vsixSizeBytes: vsixSizeBytes ?? 0,
    cloneMethod: CLONE_METHOD,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  log('evidence written', evidenceRel);
  log('ok', ok);

  if (failure || !ok) {
    console.error(
      `[m022-s04-clean-clone] FAIL: ${failure ?? 'clean-clone package drill did not succeed'}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[m022-s04-clean-clone] PASS: ${DOCUMENTED_INSTALL_COMMAND} + ${DOCUMENTED_PACKAGE_COMMAND} produced ${vsixName} (${vsixSizeBytes} bytes) from a real clean clone`,
  );
}

try {
  main();
} catch (error) {
  cleanupScratch();
  log('scratch cleaned', drillState.cleaned);
  log('npm ci exit code', drillState.npmCiExitCode ?? 'n/a');
  log('package exit code', drillState.packageExitCode ?? 'n/a');
  console.error(
    `[m022-s04-clean-clone] FAIL: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
