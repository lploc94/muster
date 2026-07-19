import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { runTests } from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const version = process.env.MUSTER_VSCODE_VERSION || 'stable';
const vscodeExecutablePath = process.env.MUSTER_VSCODE_EXECUTABLE_PATH;
const expectIncompatible = process.env.MUSTER_EXPECT_INCOMPATIBLE === '1';
const requireRemote = process.env.MUSTER_REQUIRE_REMOTE === '1';
const downloadTimeout = Number.parseInt(
  process.env.MUSTER_VSCODE_DOWNLOAD_TIMEOUT_MS || '120000',
  10,
);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-vsix-host-smoke-'));

async function main() {
  const compiledTest = path.join(root, 'dist', 'scripts', 'sqlite-extension-host-smoke.js');
  const vsixPath = path.join(tempDir, 'muster.vsix');
  // createVSIX runs vscode:prepublish, so the smoke always tests a fresh build.
  await createVSIX({
    cwd: root,
    packagePath: vsixPath,
    dependencies: true,
    allowMissingRepository: false,
  });
  if (!fs.existsSync(compiledTest)) {
    throw new Error('vscode:prepublish did not produce the compiled Extension Host test');
  }

  const zip = new AdmZip(vsixPath);
  const packagedWorker = 'extension/dist/src/task/sqlite/worker.js';
  const packagedClient = 'extension/dist/src/task/sqlite/client.js';
  const packagedSchema = 'extension/dist/src/task/sqlite/schema.js';
  if (!zip.getEntry(packagedWorker) || !zip.getEntry(packagedClient) || !zip.getEntry(packagedSchema)) {
    throw new Error(`VSIX is missing compiled SQLite worker/client/schema (${packagedWorker})`);
  }
  const manifest = JSON.parse(zip.readAsText('extension/package.json'));
  if (manifest.engines?.vscode !== '^1.101.0') {
    throw new Error(`VSIX engines.vscode drifted: ${String(manifest.engines?.vscode)}`);
  }

  const extractedRoot = path.join(tempDir, 'extracted');
  zip.extractAllTo(extractedRoot, true);
  const extensionDevelopmentPath = path.join(extractedRoot, 'extension');
  const workspacePath = path.join(tempDir, 'workspace');
  const userDataDir = path.join(tempDir, 'user-data');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version }),
    timeout: Number.isFinite(downloadTimeout) ? downloadTimeout : 120_000,
    extensionDevelopmentPath,
    extensionTestsPath: compiledTest,
    extensionTestsEnv: {
      MUSTER_EXPECT_INCOMPATIBLE: expectIncompatible ? '1' : '0',
      MUSTER_REQUIRE_REMOTE: requireRemote ? '1' : '0',
    },
    launchArgs: [
      workspacePath,
      // Fresh user-data so globalStorage/muster.sqlite3 is blank current schema
      // (no leftover incompatible user_version from prior smoke runs).
      `--user-data-dir=${userDataDir}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-extensions',
    ],
  });
}

try {
  await main();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
