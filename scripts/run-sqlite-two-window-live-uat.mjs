/**
 * Package Muster, launch two real VS Code/Extension Host processes against one
 * SQLite file, restart peer B once, and run live scenarios A–I.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const version = process.env.MUSTER_VSCODE_VERSION || 'stable';
const vscodeExecutablePathEnv = process.env.MUSTER_VSCODE_EXECUTABLE_PATH;
const downloadTimeout = Number.parseInt(
  process.env.MUSTER_VSCODE_DOWNLOAD_TIMEOUT_MS || '120000',
  10,
);
// Keep user-data paths short: VS Code IPC socket paths have a small platform cap.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2w-'));
const evidenceOut =
  process.env.MUSTER_UAT_EVIDENCE_OUT ||
  path.join(root, 'docs', 'plans', 'sqlite-phase4-two-window-live-uat-evidence.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * VS Code locks each user-data directory to one main process. Isolate the two
 * processes but symlink the extension's globalStorage directory to one target.
 */
function linkSharedGlobalStorage(userDataDir, sharedStorageDir) {
  const globalStorageRoot = path.join(userDataDir, 'User', 'globalStorage');
  ensureDir(globalStorageRoot);
  const target = path.join(globalStorageRoot, 'tlelabs.muster');
  if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.symlinkSync(sharedStorageDir, target, 'dir');
}

function spawnWindow({
  executable,
  extensionDevelopmentPath,
  extensionTestsPath,
  workspacePath,
  userDataDir,
  role,
  generation,
  controlDir,
  logPath,
  appendLog = false,
}) {
  const args = [
    workspacePath,
    `--user-data-dir=${userDataDir}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-extensions',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--no-cached-data',
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--extensionTestsPath=${extensionTestsPath}`,
  ];
  const env = {
    ...process.env,
    MUSTER_UAT_MODE: '1',
    MUSTER_UAT_ROLE: role,
    MUSTER_UAT_PEER_GENERATION: String(generation),
    MUSTER_UAT_CONTROL_DIR: controlDir,
  };
  const label = role === 'B' ? `B${generation}` : role;
  const logStream = fs.createWriteStream(logPath, { flags: appendLog ? 'a' : 'w' });
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.stdout?.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return { child, logPath, label };
}

async function waitForExit(child, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForPeerReady(window, readyPath, generation, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (window.child.exitCode !== null) {
      const log = fs.existsSync(window.logPath) ? fs.readFileSync(window.logPath, 'utf8') : '';
      throw new Error(`${window.label} exited before ready (${window.child.exitCode}):\n${log.slice(-4000)}`);
    }
    if (fs.existsSync(readyPath)) {
      try {
        const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
        if (ready?.generation === generation) return ready;
      } catch {
        // Atomic writer may be between rename/read on a slow filesystem; retry.
      }
    }
    if (Date.now() > deadline) {
      const log = fs.existsSync(window.logPath) ? fs.readFileSync(window.logPath, 'utf8') : '';
      throw new Error(`${window.label} did not become ready:\n${log.slice(-4000)}`);
    }
    await sleep(100);
  }
}

function validateSuccessResult(result) {
  if (!result || typeof result !== 'object' || result.ok !== true) {
    throw new Error('two-window live UAT returned a failure result');
  }
  if (result.kind !== 'live-two-window-extension-host') throw new Error('unexpected UAT result kind');
  if (result.extensionHostsDistinct !== true || result.peerRestarted !== true) {
    throw new Error('UAT did not prove distinct/restarted Extension Hosts');
  }
  if (!Array.isArray(result.scenarios) || result.scenarios.length !== 9) {
    throw new Error('UAT must report exactly scenarios A–I');
  }
  const expected = 'ABCDEFGHI'.split('');
  result.scenarios.forEach((scenario, index) => {
    if (
      scenario?.id !== expected[index] ||
      scenario?.verdict !== 'PASS' ||
      typeof scenario?.detail !== 'string' ||
      scenario.detail.length > 300
    ) {
      throw new Error(`invalid UAT scenario result at index ${index}`);
    }
  });
  const db = result.dbIdentity;
  if (
    !db ||
    typeof db.dbFileToken !== 'string' ||
    !/^[a-f0-9]{16}$/.test(db.dbFileToken) ||
    db.userVersion !== 7 ||
    db.applicationId !== 0x4d555354 ||
    db.journalMode !== 'wal'
  ) {
    throw new Error('invalid redacted DB identity');
  }
  if (!Number.isSafeInteger(result.finalRevision) || result.finalRevision < 1) {
    throw new Error('invalid final revision');
  }
}

function buildEvidence(result, exitA, peerExits) {
  return {
    ok: true,
    kind: result.kind,
    vscodeVersion: String(result.vscodeVersion),
    nodeVersion: String(result.nodeVersion),
    schemaVersion: result.schemaVersion,
    dbIdentity: {
      dbFileToken: result.dbIdentity.dbFileToken,
      applicationId: result.dbIdentity.applicationId,
      userVersion: result.dbIdentity.userVersion,
      pageCount: result.dbIdentity.pageCount,
      byteSize: result.dbIdentity.byteSize,
      journalMode: result.dbIdentity.journalMode,
      workspaceId: result.dbIdentity.workspaceId,
      workspaceIdentityKind: result.dbIdentity.workspaceIdentityKind,
    },
    extensionHostsDistinct: true,
    peerRestarted: true,
    polling: {
      aPollCount: result.polling.aPollCount,
      bPollCount: result.polling.bPollCount,
      // Headless CI cannot keep two independent Electron apps OS-focused at once.
      focusGateOverridden: result.polling.focusGateOverridden,
    },
    finalRevision: result.finalRevision,
    finalTaskCount: result.finalTaskCount,
    scenarios: result.scenarios.map(({ id, verdict, detail }) => ({ id, verdict, detail })),
    launcher: {
      kind: 'two-real-vscode-processes-and-extension-hosts',
      sameLocalAuthority: true,
      sharedWorkspaceFolder: true,
      sharedGlobalStorageDirectory: true,
      separateIsolatedUserDataDirs: true,
      packagedArtifactContents: true,
      peerRestartCount: 1,
      exitCodes: { a: exitA.code, b: peerExits.map((entry) => entry.code) },
    },
    contentSafety: {
      absolutePathsStoredInEvidence: false,
      messageBodiesStoredInEvidence: false,
      sessionIdsStoredInEvidence: false,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  let keepTemp = false;
  let windowA;
  let activeWindowB;
  try {
    const compiledTest = path.join(root, 'dist', 'scripts', 'sqlite-two-window-live-uat.js');
    const vsixPath = path.join(tempDir, 'muster.vsix');
    await createVSIX({
      cwd: root,
      packagePath: vsixPath,
      dependencies: true,
      allowMissingRepository: false,
    });
    if (!fs.existsSync(compiledTest)) {
      throw new Error('vscode:prepublish did not produce sqlite-two-window-live-uat.js');
    }

    const zip = new AdmZip(vsixPath);
    const extractedRoot = path.join(tempDir, 'extracted');
    zip.extractAllTo(extractedRoot, true);
    const extensionDevelopmentPath = path.join(extractedRoot, 'extension');
    const workspacePath = path.join(tempDir, 'ws');
    const userDataA = path.join(tempDir, 'uda');
    const userDataB = path.join(tempDir, 'udb');
    const sharedStorage = path.join(tempDir, 'gs');
    const controlDir = path.join(tempDir, 'ctl');
    for (const dir of [workspacePath, userDataA, userDataB, sharedStorage, controlDir]) ensureDir(dir);
    linkSharedGlobalStorage(userDataA, sharedStorage);
    linkSharedGlobalStorage(userDataB, sharedStorage);

    const executable =
      vscodeExecutablePathEnv ||
      (await downloadAndUnzipVSCode({
        version,
        timeout: Number.isFinite(downloadTimeout) ? downloadTimeout : 120_000,
      }));

    const logA = path.join(tempDir, 'window-a.log');
    const logB = path.join(tempDir, 'window-b.log');
    const readyB = path.join(controlDir, 'ready-b.json');
    const restartB = path.join(controlDir, 'restart-b.json');
    const done = path.join(controlDir, 'done.json');
    const spawnB = (generation, appendLog = false) =>
      spawnWindow({
        executable,
        extensionDevelopmentPath,
        extensionTestsPath: compiledTest,
        workspacePath,
        userDataDir: userDataB,
        role: 'B',
        generation,
        controlDir,
        logPath: logB,
        appendLog,
      });

    activeWindowB = spawnB(1);
    await waitForPeerReady(activeWindowB, readyB, 1);
    windowA = spawnWindow({
      executable,
      extensionDevelopmentPath,
      extensionTestsPath: compiledTest,
      workspacePath,
      userDataDir: userDataA,
      role: 'A',
      generation: 1,
      controlDir,
      logPath: logA,
    });

    let exitA;
    let peerExits;
    try {
      const peerLifecycle = async () => {
        const first = await waitForExit(activeWindowB.child, 'window B generation 1', 300_000);
        if (first.code !== 0) throw new Error(`window B generation 1 exited ${first.code}`);
        if (!fs.existsSync(restartB)) {
          if (!fs.existsSync(done)) throw new Error('window B exited before restart/done');
          return [first];
        }
        fs.rmSync(restartB, { force: true });
        activeWindowB = spawnB(2, true);
        await waitForPeerReady(activeWindowB, readyB, 2);
        const second = await waitForExit(activeWindowB.child, 'window B generation 2', 300_000);
        if (second.code !== 0) throw new Error(`window B generation 2 exited ${second.code}`);
        return [first, second];
      };
      [exitA, peerExits] = await Promise.all([
        waitForExit(windowA.child, 'window A', 300_000),
        peerLifecycle(),
      ]);
    } catch (error) {
      windowA?.child.kill('SIGKILL');
      activeWindowB?.child.kill('SIGKILL');
      const logAText = fs.existsSync(logA) ? fs.readFileSync(logA, 'utf8') : '';
      const logBText = fs.existsSync(logB) ? fs.readFileSync(logB, 'utf8') : '';
      const controlListing = fs.existsSync(controlDir) ? fs.readdirSync(controlDir).join(', ') : '(missing)';
      keepTemp = true;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `control files: ${controlListing}\n` +
          `tempDir=${tempDir}\n` +
          `--- window A log ---\n${logAText.slice(-6000)}\n` +
          `--- window B log ---\n${logBText.slice(-6000)}`,
      );
    }

    const resultPath = path.join(controlDir, 'result.json');
    if (!fs.existsSync(resultPath)) {
      keepTemp = true;
      throw new Error('live UAT produced no result.json');
    }
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (exitA.code !== 0 || peerExits.length !== 2 || peerExits.some((entry) => entry.code !== 0)) {
      keepTemp = true;
      throw new Error(`invalid Extension Host exits: A=${exitA.code} B=${peerExits.map((e) => e.code).join(',')}`);
    }
    validateSuccessResult(result);
    const evidence = buildEvidence(result, exitA, peerExits);
    const serialized = JSON.stringify(evidence);
    const forbidden = [
      tempDir,
      root,
      'from-window-a',
      'from-window-b',
      'while-b-hidden',
      'pending-draft',
      'reject-draft',
      '# plan',
    ];
    const leaked = forbidden.find((value) => serialized.includes(value));
    if (leaked) throw new Error('evidence contains a forbidden path or synthetic body');

    ensureDir(path.dirname(evidenceOut));
    writeJson(evidenceOut, evidence);
    console.log(
      `[muster-two-window-live-uat] PASS scenarios=${result.scenarios.map((s) => s.id).join(',')} ` +
        `finalRevision=${result.finalRevision} vscode=${result.vscodeVersion} node=${result.nodeVersion}`,
    );
    console.log(`[muster-two-window-live-uat] evidence=${evidenceOut}`);
  } finally {
    if (!keepTemp) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    } else {
      console.error(`[muster-two-window-live-uat] preserved temp dir for diagnosis: ${tempDir}`);
    }
  }
}

await main();
