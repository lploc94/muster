#!/usr/bin/env node
/**
 * Pinned Linux Chromium authoring/compare runner for Muster visual baselines.
 *
 * Goldens are authored and compared only inside the official Playwright Docker
 * image that matches package-lock.json @playwright/test. CI compare paths must
 * never pass --update-snapshots.
 *
 * Usage:
 *   node scripts/run-visual-baselines.mjs              # compare
 *   node scripts/run-visual-baselines.mjs --update     # author/update goldens
 *   node scripts/run-visual-baselines.mjs --diagnostics-only
 *   npm run test:visual:linux
 *   npm run test:visual:linux:update
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIAGNOSTICS_PATH = path.join(
  REPO_ROOT,
  'test-results',
  'visual-linux-diagnostics.json',
);

export function resolvePlaywrightVersionFromLock(lock) {
  const version = lock?.packages?.['node_modules/@playwright/test']?.version;
  if (!version || typeof version !== 'string') {
    throw new Error(
      'Could not resolve @playwright/test version from package-lock.json packages["node_modules/@playwright/test"].version',
    );
  }
  return version;
}

export function playwrightDockerImage(version) {
  return `mcr.microsoft.com/playwright:v${version}-jammy`;
}

export function parseArgs(argv) {
  const result = {
    mode: 'compare',
    update: false,
    diagnosticsOnly: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--update') {
      result.mode = 'update';
      result.update = true;
      continue;
    }
    if (arg === '--diagnostics-only') {
      result.diagnosticsOnly = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

export function buildPlaywrightCommand({ update }) {
  const base = 'npx playwright test e2e/visual --project=visual-chromium';
  return update ? `${base} --update-snapshots` : base;
}

export function buildDockerArgs({ image, workdir, hostRepo, command }) {
  // Use POSIX path form for the container mount target.
  const mount = `${hostRepo}:${workdir}`;
  const shell = [
    `set -euo pipefail`,
    `cd ${workdir}`,
    // Prefer npm ci when node_modules is absent/mismatched inside the container volume.
    `if [ ! -d node_modules/@playwright/test ]; then npm ci; fi`,
    // Browsers ship in the image; still ensure project deps are present.
    `node -e "const {spawnSync}=require('child_process'); const r=spawnSync('npx',['playwright','--version'],{encoding:'utf8'}); console.log(String(r.stdout||r.stderr||'').trim())"`,
    command,
  ].join(' && ');

  return [
    'run',
    '--rm',
    '-t',
    '-v',
    mount,
    '-w',
    workdir,
    '-e',
    'CI=1',
    '-e',
    'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    image,
    'bash',
    '-lc',
    shell,
  ];
}

function printHelp() {
  console.log(`Pinned Linux visual baseline runner

Usage:
  node scripts/run-visual-baselines.mjs [--update] [--diagnostics-only]

Options:
  --update             Author/update committed goldens inside Docker (explicit only)
  --diagnostics-only   Write platform/font diagnostics without running Playwright
  --help               Show this help

Environment:
  MUSTER_VISUAL_DIAGNOSTICS_PATH  Override diagnostics JSON path
  MUSTER_VISUAL_SKIP_DOCKER=1     Fail with a clear message (do not fall back to host)
`);
}

function readLockfileVersion(repoRoot = REPO_ROOT) {
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  return resolvePlaywrightVersionFromLock(lock);
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function collectHostDiagnostics() {
  return {
    capturedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cwd: process.cwd(),
    },
  };
}

function collectContainerDiagnosticsScript() {
  // Runs inside the Playwright Linux image and prints one JSON object.
  return `node -e ${JSON.stringify(`
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch (e) { return String(e.stdout || e.stderr || e.message || e).trim(); }
}
const fonts = sh("fc-list : family | sort -u | head -80");
const diagnostics = {
  capturedAt: new Date().toISOString(),
  container: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    osType: os.type(),
    osRelease: os.release(),
    uname: sh('uname -a'),
    playwrightVersion: sh('npx playwright --version'),
    chromium: sh('ls /ms-playwright 2>/dev/null || true'),
    locale: process.env.LANG || process.env.LC_ALL || null,
    timezone: sh('date +%Z'),
    fontFamilies: fonts.split(/\\n/).filter(Boolean),
  }
};
process.stdout.write(JSON.stringify(diagnostics, null, 2));
`)}`;
}

function writeDiagnostics(payload, outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote visual diagnostics: ${path.relative(REPO_ROOT, outPath)}`);
}

function runDocker(args) {
  console.log(`docker ${args.filter((a, i) => !(args[i - 1] === '-lc')).join(' ').slice(0, 240)}…`);
  const result = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const version = readLockfileVersion();
  const image = playwrightDockerImage(version);
  const diagnosticsPath =
    process.env.MUSTER_VISUAL_DIAGNOSTICS_PATH || DEFAULT_DIAGNOSTICS_PATH;

  console.log(`Pinned Playwright version: ${version}`);
  console.log(`Pinned Docker image: ${image}`);
  console.log(`Mode: ${args.mode}`);

  if (!dockerAvailable()) {
    const host = collectHostDiagnostics();
    writeDiagnostics(
      {
        ...host,
        error:
          'Docker engine is unavailable. Start Docker Desktop (or a compatible engine), then re-run. Do not author goldens on the host OS — Linux Chromium in the pinned image is required for committed baselines.',
        image,
        version,
        fallback:
          'If Docker cannot be started, use a temporary explicit CI authoring workflow that uploads snapshot artifacts, review them, commit locally, and remove the temporary authoring path. Normal CI must never run --update-snapshots.',
      },
      diagnosticsPath,
    );
    console.error(
      'ERROR: Docker engine unavailable. Visual baselines must be authored/compared in the pinned Linux Playwright image.',
    );
    return 2;
  }

  const workdir = '/work';
  // Docker Desktop on Windows accepts the host path as-is when quoted via spawn.
  const hostRepo = REPO_ROOT;

  if (args.diagnosticsOnly) {
    const diagCmd = [
      'set -euo pipefail',
      `cd ${workdir}`,
      `if [ ! -d node_modules/@playwright/test ]; then npm ci; fi`,
      collectContainerDiagnosticsScript(),
    ].join(' && ');
    const diagArgs = [
      'run',
      '--rm',
      '-v',
      `${hostRepo}:${workdir}`,
      '-w',
      workdir,
      '-e',
      'CI=1',
      image,
      'bash',
      '-lc',
      diagCmd,
    ];
    const result = spawnSync('docker', diagArgs, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout || 'diagnostics failed');
      return result.status ?? 1;
    }
    let container;
    try {
      container = JSON.parse(result.stdout);
    } catch {
      container = { raw: result.stdout };
    }
    writeDiagnostics(
      {
        ...collectHostDiagnostics(),
        image,
        version,
        container: container.container || container,
      },
      diagnosticsPath,
    );
    return 0;
  }

  const playwrightCmd = buildPlaywrightCommand({ update: args.update });
  // Capture diagnostics after tests so font/rasterization context is next to results.
  const command = [
    playwrightCmd,
    // Best-effort diagnostics; do not fail the run if font listing is unavailable.
    `(${collectContainerDiagnosticsScript()} > ${workdir}/test-results/visual-linux-diagnostics.container.json || true)`,
  ].join(' && ');

  const dockerArgs = buildDockerArgs({
    image,
    workdir,
    hostRepo,
    command,
  });

  const status = runDocker(dockerArgs);

  const containerDiagPath = path.join(
    REPO_ROOT,
    'test-results',
    'visual-linux-diagnostics.container.json',
  );
  let container = null;
  if (existsSync(containerDiagPath)) {
    try {
      container = JSON.parse(readFileSync(containerDiagPath, 'utf8'));
    } catch {
      container = { parseError: true };
    }
  }
  writeDiagnostics(
    {
      ...collectHostDiagnostics(),
      image,
      version,
      mode: args.mode,
      exitCode: status,
      container: container?.container || container,
    },
    diagnosticsPath,
  );

  if (status !== 0) {
    console.error(`Pinned Linux visual run failed with exit code ${status}`);
  } else if (args.update) {
    console.log(
      'Baselines updated inside pinned Linux Chromium. Review PNG diffs before commit.',
    );
  } else {
    console.log('Pinned Linux visual compare passed.');
  }
  return status;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  process.exitCode = main();
}
