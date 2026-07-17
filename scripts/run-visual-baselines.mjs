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

/**
 * Convert a host filesystem path into a mount path Docker can bind.
 * Docker Desktop on Windows accepts native Windows paths; docker-ce inside WSL
 * needs /mnt/<drive>/... form for Windows-drive checkouts.
 */
export function toDockerMountPath(hostPath, { style = 'native' } = {}) {
  const normalized = String(hostPath).replace(/\\/g, '/');
  if (style !== 'wsl') {
    return normalized;
  }
  const m = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!m) {
    return normalized;
  }
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
}

export function buildDockerArgs({
  image,
  workdir,
  hostRepo,
  command,
  mountStyle = 'native',
}) {
  const mountPath = toDockerMountPath(hostRepo, { style: mountStyle });
  const mount = `${mountPath}:${workdir}`;
  const shell = [
    'set -euo pipefail',
    `cd ${workdir}`,
    // Isolate from host node_modules via anonymous volume (see -v workdir/node_modules).
    'npm ci',
    "node -e \"const {spawnSync}=require('child_process'); const r=spawnSync('npx',['playwright','--version'],{encoding:'utf8'}); console.log(String(r.stdout||r.stderr||'').trim())\"",
    command,
  ].join(' && ');

  return [
    'run',
    '--rm',
    '-v',
    mount,
    '-v',
    `${workdir}/node_modules`,
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
  MUSTER_VISUAL_HOST_REPO         Override bind-mount source path
  MUSTER_VISUAL_MOUNT_STYLE       native|wsl (auto-detected when unset)
  MUSTER_DOCKER_BIN               Optional docker executable override
  MUSTER_WSL_DOCKER_DISTRO        WSL distro for docker-ce fallback (default Ubuntu-24.04)
`);
}

function readLockfileVersion(repoRoot = REPO_ROOT) {
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  return resolvePlaywrightVersionFromLock(lock);
}

export function resolveDockerEngine({
  spawn = spawnSync,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (env.MUSTER_VISUAL_SKIP_DOCKER === '1') {
    return null;
  }

  if (env.MUSTER_DOCKER_BIN) {
    const probe = spawn(env.MUSTER_DOCKER_BIN, ['info'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (probe.status === 0) {
      const osLine = String(probe.stdout || '');
      const mountStyle =
        env.MUSTER_VISUAL_MOUNT_STYLE ||
        (/Docker Desktop/i.test(osLine) ? 'native' : platform === 'win32' ? 'wsl' : 'native');
      return {
        command: env.MUSTER_DOCKER_BIN,
        prefixArgs: [],
        mountStyle,
        engine: 'custom',
      };
    }
  }

  const desktop = spawn('docker', ['info'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (desktop.status === 0) {
    const osLine = String(desktop.stdout || '');
    const mountStyle =
      env.MUSTER_VISUAL_MOUNT_STYLE ||
      (/Docker Desktop/i.test(osLine) || platform !== 'win32' ? 'native' : 'wsl');
    return {
      command: 'docker',
      prefixArgs: [],
      mountStyle,
      engine: /Docker Desktop/i.test(osLine) ? 'docker-desktop' : 'docker',
    };
  }

  if (platform === 'win32') {
    const distro = env.MUSTER_WSL_DOCKER_DISTRO || 'Ubuntu-24.04';
    spawn(
      'wsl.exe',
      [
        '-d',
        distro,
        '--',
        'bash',
        '-lc',
        'if ! /usr/bin/docker info >/dev/null 2>&1; then nohup dockerd >/tmp/dockerd.log 2>&1 & for i in $(seq 1 40); do /usr/bin/docker info >/dev/null 2>&1 && break; sleep 1; done; fi; /usr/bin/docker info >/dev/null',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const wsl = spawn(
      'wsl.exe',
      ['-d', distro, '--', '/usr/bin/docker', 'info'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (wsl.status === 0) {
      return {
        command: 'wsl.exe',
        prefixArgs: ['-d', distro, '--', '/usr/bin/docker'],
        mountStyle: env.MUSTER_VISUAL_MOUNT_STYLE || 'wsl',
        engine: 'wsl-docker-ce',
      };
    }
  }

  return null;
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

function writeDiagnostics(payload, outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote visual diagnostics: ${path.relative(REPO_ROOT, outPath)}`);
}

function runDocker(engine, args) {
  const full = [...engine.prefixArgs, ...args];
  console.log(
    `${engine.command} ${full
      .filter((a, i) => !(full[i - 1] === '-lc'))
      .join(' ')
      .slice(0, 240)}…`,
  );
  const result = spawnSync(engine.command, full, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
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

  const engine = resolveDockerEngine();
  if (!engine) {
    writeDiagnostics(
      {
        ...collectHostDiagnostics(),
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

  console.log(
    `Docker engine: ${engine.engine} (mountStyle=${engine.mountStyle})`,
  );

  const workdir = '/work';
  const hostRepo = process.env.MUSTER_VISUAL_HOST_REPO || REPO_ROOT;
  const mountPath = toDockerMountPath(hostRepo, { style: engine.mountStyle });

  if (args.diagnosticsOnly) {
    const diagCmd = [
      'set -euo pipefail',
      `cd ${workdir}`,
      'npm ci',
      'node scripts/collect-visual-linux-diagnostics.mjs test-results/visual-linux-diagnostics.container.json',
      'cat test-results/visual-linux-diagnostics.container.json',
    ].join(' && ');
    const diagArgs = [
      'run',
      '--rm',
      '-v',
      `${mountPath}:${workdir}`,
      '-v',
      `${workdir}/node_modules`,
      '-w',
      workdir,
      '-e',
      'CI=1',
      image,
      'bash',
      '-lc',
      diagCmd,
    ];
    const status = runDocker(engine, diagArgs);
    let container = null;
    const containerDiagPath = path.join(
      REPO_ROOT,
      'test-results',
      'visual-linux-diagnostics.container.json',
    );
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
        engine: engine.engine,
        mountStyle: engine.mountStyle,
        mountPath,
        exitCode: status,
        container: container?.container || container,
      },
      diagnosticsPath,
    );
    return status;
  }

  const playwrightCmd = buildPlaywrightCommand({ update: args.update });
  const command = [
    playwrightCmd,
    'mkdir -p test-results',
    'node scripts/collect-visual-linux-diagnostics.mjs test-results/visual-linux-diagnostics.container.json',
  ].join(' && ');

  const dockerArgs = buildDockerArgs({
    image,
    workdir,
    hostRepo,
    command,
    mountStyle: engine.mountStyle,
  });

  const status = runDocker(engine, dockerArgs);

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
      engine: engine.engine,
      mountStyle: engine.mountStyle,
      mountPath,
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
