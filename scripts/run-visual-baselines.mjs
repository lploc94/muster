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

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function parseArgs(argv) {
  const result = {
    mode: 'compare',
    update: false,
    diagnosticsOnly: false,
    help: false,
    playwrightArgs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    // npm often strips quotes around --grep patterns; reassemble multi-word values.
    if (arg === '--grep' || arg === '-g') {
      result.playwrightArgs.push('--grep');
      const parts = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith('-')) {
        parts.push(argv[j]);
        j += 1;
      }
      if (parts.length > 0) {
        result.playwrightArgs.push(parts.join(' '));
        i = j - 1;
      }
      continue;
    }
    // Forward remaining flags (e.g. --list) to Playwright.
    result.playwrightArgs.push(arg);
  }
  return result;
}

export function buildPlaywrightCommand({ update, playwrightArgs = [] } = {}) {
  // Path filters must precede options so --update-snapshots does not consume them as mode.
  const rawArgs = playwrightArgs.map(String);
  const pathArgs = rawArgs.filter(
    (a) => a.startsWith('e2e/') || /\.(spec|test)\.tsx?$/.test(a),
  );
  const otherArgs = rawArgs.filter((a) => !pathArgs.includes(a));
  const testPaths = pathArgs.length > 0 ? pathArgs : ['e2e/visual'];
  const parts = [
    'npx playwright test',
    ...testPaths.map((p) => shellQuote(p)),
    '--project=visual-chromium',
  ];
  if (update) {
    parts.push('--update-snapshots');
  }
  for (const arg of otherArgs) {
    parts.push(shellQuote(arg));
  }
  return parts.join(' ');
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


/**
 * Resolve host uid/gid for Docker --user so bind-mounted artifacts are not
 * root-owned. Prefer explicit MUSTER_VISUAL_UID/GID (CI), then getuid/getgid.
 */
export function resolveHostUserIds(env = process.env) {
  let uid = String(env.MUSTER_VISUAL_UID || env.UID || '').trim();
  let gid = String(env.MUSTER_VISUAL_GID || env.GID || '').trim();
  if ((!uid || !gid) && typeof process.getuid === 'function') {
    try {
      uid = uid || String(process.getuid());
    } catch {
      /* ignore platforms without getuid */
    }
    try {
      gid = gid || String(process.getgid());
    } catch {
      /* ignore */
    }
  }
  if (!uid || !gid || !/^\d+$/.test(uid) || !/^\d+$/.test(gid)) {
    return null;
  }
  return { uid, gid };
}

/**
 * Docker args that run the container as the host user. Without this, Linux CI
 * produces root-owned test-results/ and the host writeDiagnostics step fails
 * with EACCES even when Playwright itself passed.
 */
export function dockerUserArgs(env = process.env) {
  const ids = resolveHostUserIds(env);
  if (!ids) return [];
  // Non-root Playwright image needs a writable HOME for npm/cache temp files.
  return ['--user', ids.uid + ':' + ids.gid, '-e', 'HOME=/tmp'];
}

/**
 * After a root container writes bind-mounted artifacts, chown them back to the
 * host user so host-side writeDiagnostics / artifact upload can read them.
 * Best-effort: never throws; writeDiagnostics also has an EACCES fallback.
 */
export function buildChownArgs({
  image,
  workdir,
  hostRepo,
  mountStyle = 'native',
  uid,
  gid,
  paths = ['test-results', 'playwright-report'],
}) {
  const mountPath = toDockerMountPath(hostRepo, { style: mountStyle });
  return [
    'run',
    '--rm',
    '-v',
    `${mountPath}:${workdir}`,
    '-w',
    workdir,
    image,
    'chown',
    '-R',
    `${uid}:${gid}`,
    ...paths,
  ];
}


export function buildDockerArgs({
  image,
  workdir,
  hostRepo,
  command,
  mountStyle = 'native',
  userArgs = [],
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
    ...userArgs,
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
  node scripts/run-visual-baselines.mjs [--update] [--diagnostics-only] [--] [playwright args...]

Options:
  --update             Author/update committed goldens inside Docker (explicit only)
  --diagnostics-only   Write platform/font diagnostics without running Playwright
  --help               Show this help

Any other arguments (for example --grep or --list) are forwarded to Playwright.

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
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, 'utf8');
    console.log(`Wrote visual diagnostics: ${path.relative(REPO_ROOT, outPath)}`);
    return outPath;
  } catch (err) {
    // Docker as root can leave test-results/ unwritable for the host user.
    // Prefer a repo-root fallback over crashing a green Playwright run.
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      const fallback = path.join(REPO_ROOT, path.basename(outPath));
      writeFileSync(fallback, body, 'utf8');
      console.warn(
        `WARN: could not write ${outPath} (${err.code}); wrote fallback ${path.relative(REPO_ROOT, fallback)}`,
      );
      return fallback;
    }
    throw err;
  }
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
  // Host-owned dirs first so container writes (as --user) land on writable paths.
  mkdirSync(path.join(REPO_ROOT, 'test-results'), { recursive: true });
  mkdirSync(path.join(REPO_ROOT, 'playwright-report'), { recursive: true });

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

  const playwrightCmd = buildPlaywrightCommand({
    update: args.update,
    playwrightArgs: args.playwrightArgs,
  });
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

  // Reclaim root-owned bind mounts so host writeDiagnostics does not EACCES.
  const hostIds = resolveHostUserIds();
  if (hostIds) {
    runDocker(
      engine,
      buildChownArgs({
        image,
        workdir,
        hostRepo,
        mountStyle: engine.mountStyle,
        uid: hostIds.uid,
        gid: hostIds.gid,
      }),
    );
  }

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
