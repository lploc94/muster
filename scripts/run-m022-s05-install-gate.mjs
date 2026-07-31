/**
 * M022/S05 T03 — real CLI install gate.
 *
 * Proves Muster works when *installed*, not when loaded from
 * extensionDevelopmentPath (D070):
 *   1. Package a VSIX (createVSIX) or accept --vsix
 *   2. Resolve VS Code + CLI; install the VSIX into a disposable --extensions-dir
 *   3. Launch runTests with a throwaway probe extension as extensionDevelopmentPath
 *      and the disposable --extensions-dir/--user-data-dir in launchArgs
 *      (never the disable-extensions flag)
 *   4. Host smoke reports extensionPath; classifyInstalledOrigin must be
 *      extensions-dir (under disposable dir, outside repo root)
 *   5. Write docs/plans/m022-s05-install-gate-evidence.json via buildInstallGateEvidence
 *
 * Usage:
 *   node scripts/run-m022-s05-install-gate.mjs
 *   node scripts/run-m022-s05-install-gate.mjs --evidence <path> --vsix <path>
 *   npm run test:m022-s05-install
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';

import {
  buildInstallGateEvidence,
  classifyInstalledOrigin,
  parseInstallHostResult,
} from './packaging-install-result.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const DEFAULT_EVIDENCE_PATH = path.join(
  root,
  'docs',
  'plans',
  'm022-s05-install-gate-evidence.json',
);
const HOST_SMOKE_JS = path.join(root, 'dist', 'scripts', 'packaging-install-host-smoke.js');

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ evidence: string, vsix: string | null }} */
  const out = { evidence: DEFAULT_EVIDENCE_PATH, vsix: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--evidence' && argv[i + 1]) {
      out.evidence = path.resolve(argv[++i]);
    } else if (a === '--vsix' && argv[i + 1]) {
      out.vsix = path.resolve(argv[++i]);
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/run-m022-s05-install-gate.mjs [--evidence path] [--vsix path]',
      );
      process.exit(0);
    }
  }
  return out;
}

/**
 * @param {string} label
 * @param {unknown} value
 */
function log(label, value) {
  console.log(`[m022-s05-install-gate] ${label}: ${String(value)}`);
}

/**
 * Write a throwaway probe extension used only as extensionDevelopmentPath so
 * @vscode/test-electron's required seam is satisfied without loading Muster
 * from the repository (D070).
 *
 * @param {string} probeDir
 */
function writeProbeExtension(probeDir) {
  fs.mkdirSync(probeDir, { recursive: true });
  const manifest = {
    name: 'muster-install-probe',
    displayName: 'Muster Install Probe',
    description: 'Throwaway probe extension for M022/S05 install-gate host launch',
    version: '0.0.0',
    publisher: 'muster-test',
    engines: { vscode: '^1.90.0' },
    main: './extension.js',
  };
  fs.writeFileSync(
    path.join(probeDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(probeDir, 'extension.js'),
    [
      '"use strict";',
      'exports.activate = function activate() {};',
      'exports.deactivate = function deactivate() {};',
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * @param {string} evidencePath
 * @param {ReturnType<typeof buildInstallGateEvidence>} evidence
 */
function writeEvidence(evidencePath, evidence) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

/**
 * Best-effort vscode version label without leaking paths.
 * @param {string} vscodeExecutablePath
 * @param {string} requestedVersion
 */
function resolveVscodeVersionLabel(vscodeExecutablePath, requestedVersion) {
  // Prefer a version segment from the download cache path when present.
  const m = String(vscodeExecutablePath).match(
    /vscode-[^\\/]+-(\d+\.\d+\.\d+)/i,
  );
  if (m) return m[1];
  if (requestedVersion && requestedVersion !== 'stable' && requestedVersion !== 'insiders') {
    return requestedVersion;
  }
  return requestedVersion || 'stable';
}

/**
 * Install a VSIX via the resolved VS Code CLI into a disposable extensions-dir.
 *
 * @param {{
 *   vscodeExecutablePath: string,
 *   vsixPath: string,
 *   extensionsDir: string,
 *   userDataDir: string,
 * }} args
 * @returns {{ exitCode: number, combined: string }}
 */
function installVsixWithCli({
  vscodeExecutablePath,
  vsixPath,
  extensionsDir,
  userDataDir,
}) {
  const cli = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
  // Construct CLI args ourselves so the disposable --extensions-dir wins over
  // the test-electron default profile dirs (D070).
  const cliArgs = [
    `--extensions-dir=${extensionsDir}`,
    `--user-data-dir=${userDataDir}`,
    '--install-extension',
    vsixPath,
    '--force',
  ];
  log('install-cli', cli);
  log('install-args', cliArgs.map((a) => (a === vsixPath ? '<vsix>' : a)).join(' '));

  const result = spawnSync(cli, cliArgs, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    // Windows: code.cmd requires a shell.
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });

  const exitCode =
    typeof result.status === 'number'
      ? result.status
      : result.signal
        ? 1
        : result.error
          ? 1
          : 1;
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}${
    result.error ? `\n${result.error.message}` : ''
  }`;
  return { exitCode, combined };
}

/**
 * Derive the install-gate phase from install + host observations.
 *
 * @param {{
 *   installExitCode: number,
 *   hostParsed: ReturnType<typeof parseInstallHostResult> | null,
 *   installedOrigin: import('./packaging-install-result.mjs').InstalledOrigin | string,
 *   hostLaunchFailed: boolean,
 * }} args
 * @returns {import('./packaging-install-result.mjs').InstallGatePhase | string}
 */
function derivePhase({ installExitCode, hostParsed, installedOrigin, hostLaunchFailed }) {
  if (installExitCode !== 0) {
    return 'install-rejected';
  }
  if (hostLaunchFailed && (!hostParsed || hostParsed.activation !== 'ok')) {
    // Prefer a more specific host phase when the smoke wrote a result.
    if (hostParsed?.phase && hostParsed.phase !== 'ok') {
      return hostParsed.phase;
    }
    return 'host-launch-failed';
  }
  if (!hostParsed) {
    return 'host-launch-failed';
  }
  if (installedOrigin !== 'extensions-dir') {
    return 'origin-not-installed';
  }
  if (hostParsed.activation !== 'ok') {
    return 'activation-failed';
  }
  if (
    !hostParsed.bridge ||
    hostParsed.bridge.status !== 'ok' ||
    !(hostParsed.bridge.port > 0)
  ) {
    return 'bridge-unreachable';
  }
  if (!hostParsed.bridgeClosure || hostParsed.bridgeClosure.phase !== 'ok') {
    return 'closure-failed';
  }
  return 'ok';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const evidencePath = args.evidence;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-s05-install-'));
  const extensionsDir = path.join(tempDir, 'extensions-dir');
  const userDataDir = path.join(tempDir, 'user-data');
  const workspacePath = path.join(tempDir, 'workspace');
  const probeDir = path.join(tempDir, 'probe-extension');
  const hostResultPath = path.join(tempDir, 'install-host-smoke-result.json');
  const packagedVsixPath = path.join(tempDir, 'muster.vsix');

  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  writeProbeExtension(probeDir);

  /** @type {number} */
  let installExitCode = -1;
  /** @type {string} */
  let installDetail = '';
  /** @type {import('./packaging-install-result.mjs').InstalledOrigin | string} */
  let installedOrigin = 'unknown';
  /** @type {ReturnType<typeof parseInstallHostResult> | null} */
  let hostParsed = null;
  /** @type {boolean} */
  let hostLaunchFailed = false;
  /** @type {string} */
  let phase = 'package-failed';
  /** @type {string} */
  let vscodeVersionLabel = 'unknown';

  try {
    // ── 1. Package (or accept prebuilt VSIX) ──────────────────────────────
    let vsixPath = args.vsix;
    if (!vsixPath) {
      log('stage', 'createVSIX');
      try {
        await createVSIX({
          cwd: root,
          packagePath: packagedVsixPath,
          dependencies: true,
          allowMissingRepository: false,
        });
      } catch (err) {
        installDetail = err instanceof Error ? err.message : String(err);
        phase = 'package-failed';
        throw err;
      }
      if (!fs.existsSync(packagedVsixPath)) {
        phase = 'package-failed';
        throw new Error('createVSIX did not produce a VSIX');
      }
      vsixPath = packagedVsixPath;
    } else if (!fs.existsSync(vsixPath)) {
      phase = 'package-failed';
      throw new Error(`--vsix path does not exist: ${vsixPath}`);
    }
    log('vsix', path.basename(vsixPath));

    // Host smoke must be compiled (vscode:prepublish / tsc).
    if (!fs.existsSync(HOST_SMOKE_JS)) {
      phase = 'host-launch-failed';
      throw new Error(
        'dist/scripts/packaging-install-host-smoke.js missing — run compile / vscode:prepublish first',
      );
    }

    // ── 2. Resolve VS Code ────────────────────────────────────────────────
    const requestedVersion = process.env.MUSTER_VSCODE_VERSION || '1.130.0';
    const downloadTimeout = Number.parseInt(
      process.env.MUSTER_VSCODE_DOWNLOAD_TIMEOUT_MS || '180000',
      10,
    );
    log('vscode-version-request', requestedVersion);

    let vscodeExecutablePath = process.env.MUSTER_VSCODE_EXECUTABLE_PATH;
    if (!vscodeExecutablePath) {
      vscodeExecutablePath = await downloadAndUnzipVSCode({
        version: requestedVersion,
        timeout: Number.isFinite(downloadTimeout) ? downloadTimeout : 180_000,
      });
    }
    vscodeVersionLabel = resolveVscodeVersionLabel(
      vscodeExecutablePath,
      requestedVersion,
    );
    log('vscode-executable', '<resolved>');
    log('vscode-version-label', vscodeVersionLabel);

    // ── 3. CLI install into disposable extensions-dir ─────────────────────
    log('stage', 'cli-install');
    const install = installVsixWithCli({
      vscodeExecutablePath,
      vsixPath,
      extensionsDir,
      userDataDir,
    });
    installExitCode = install.exitCode;
    installDetail = install.combined;
    log('installExitCode', installExitCode);
    if (installExitCode !== 0) {
      phase = 'install-rejected';
      throw new Error(`VS Code CLI --install-extension exited ${installExitCode}`);
    }

    // ── 4. Host stage with probe extension (D070) ─────────────────────────
    log('stage', 'host-smoke');
    try {
      await runTests({
        vscodeExecutablePath,
        timeout: Number.isFinite(downloadTimeout) ? downloadTimeout : 180_000,
        // Probe extension — NOT Muster — so extensionDevelopmentPath cannot
        // silently re-prove the S01–S04 development-path path.
        extensionDevelopmentPath: probeDir,
        extensionTestsPath: HOST_SMOKE_JS,
        extensionTestsEnv: {
          MUSTER_UAT_MODE: '1',
          MUSTER_PACKAGING_HOST_RESULT_OUT: hostResultPath,
        },
        launchArgs: [
          workspacePath,
          `--user-data-dir=${userDataDir}`,
          `--extensions-dir=${extensionsDir}`,
          '--disable-workspace-trust',
          '--skip-welcome',
          '--skip-release-notes',
          // Deliberately omit the disable-extensions flag so the CLI-installed Muster loads.
          '--no-sandbox',
          '--disable-gpu-sandbox',
          '--disable-updates',
          '--no-cached-data',
        ],
      });
    } catch (err) {
      hostLaunchFailed = true;
      installDetail = `${installDetail}\n${err instanceof Error ? err.message : String(err)}`;
      log('host-run-error', err instanceof Error ? err.message : String(err));
    }

    let rawHost = null;
    if (fs.existsSync(hostResultPath)) {
      try {
        rawHost = JSON.parse(fs.readFileSync(hostResultPath, 'utf8'));
      } catch {
        rawHost = null;
      }
    }
    hostParsed = parseInstallHostResult(rawHost);

    const extensionPath =
      typeof hostParsed.extensionPath === 'string' ? hostParsed.extensionPath : '';
    installedOrigin = classifyInstalledOrigin({
      extensionPath,
      extensionsDir,
      repoRoot: root,
      caseInsensitive: process.platform === 'win32',
    });
    log('installedOrigin', installedOrigin);
    log('host.activation', hostParsed.activation);
    log('host.phase', hostParsed.phase);

    phase = derivePhase({
      installExitCode,
      hostParsed,
      installedOrigin,
      hostLaunchFailed,
    });

    const evidence = buildInstallGateEvidence({
      installExitCode,
      installDetail,
      installedOrigin,
      activation: hostParsed.activation,
      bridge: hostParsed.bridge,
      bridgeClosure: hostParsed.bridgeClosure,
      vscodeVersion: vscodeVersionLabel,
      platform: process.platform,
      phase,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });

    writeEvidence(evidencePath, evidence);
    log(
      'wrote-evidence',
      evidencePath === DEFAULT_EVIDENCE_PATH
        ? 'docs/plans/m022-s05-install-gate-evidence.json'
        : '<custom-evidence>',
    );
    log('ok', evidence.ok);
    log('phase', evidence.phase);

    if (!evidence.ok) {
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', message);

    // Prefer install-rejected if CLI already failed; otherwise keep derived phase.
    if (installExitCode !== 0 && installExitCode !== -1) {
      phase = 'install-rejected';
    } else if (phase === 'package-failed' || phase === 'ok') {
      // leave package-failed; if somehow ok, fall through to host-launch-failed
      if (phase === 'ok') phase = 'host-launch-failed';
    }

    const evidence = buildInstallGateEvidence({
      installExitCode: installExitCode === -1 ? 1 : installExitCode,
      installDetail: installDetail || message,
      installedOrigin,
      activation: hostParsed?.activation ?? 'failed',
      bridge: hostParsed?.bridge ?? null,
      bridgeClosure: hostParsed?.bridgeClosure ?? null,
      vscodeVersion: vscodeVersionLabel,
      platform: process.platform,
      phase,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });
    try {
      writeEvidence(evidencePath, evidence);
      log(
        'wrote-evidence',
        evidencePath === DEFAULT_EVIDENCE_PATH
          ? 'docs/plans/m022-s05-install-gate-evidence.json'
          : '<custom-evidence>',
      );
    } catch (writeErr) {
      log(
        'evidence-write-failed',
        writeErr instanceof Error ? writeErr.message : String(writeErr),
      );
    }
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      log('cleanup', 'ok');
    } catch (cleanupErr) {
      log(
        'cleanup-failed',
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      );
    }
  }
}

main().catch((err) => {
  console.error(
    '[m022-s05-install-gate] fatal:',
    err instanceof Error ? err.stack || err.message : err,
  );
  process.exitCode = 1;
});
