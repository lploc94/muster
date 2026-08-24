/**
 * Runner for the image-attachment Extension Host smoke.
 *
 * Packages a fresh VSIX (createVSIX runs vscode:prepublish), extracts it, and
 * points @vscode/test-electron at the extracted directory so the smoke exercises
 * archive contents on a real Extension Host rather than the source tree.
 */
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
const downloadTimeout = Number.parseInt(
  process.env.MUSTER_VSCODE_DOWNLOAD_TIMEOUT_MS || '120000',
  10,
);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-image-host-runner-'));

async function main() {
  const compiledTest = path.join(root, 'dist', 'scripts', 'image-attachment-extension-host-smoke.js');
  const vsixPath = path.join(tempDir, 'muster.vsix');
  await createVSIX({
    cwd: root,
    packagePath: vsixPath,
    dependencies: true,
    allowMissingRepository: false,
  });
  if (!fs.existsSync(compiledTest)) {
    throw new Error('vscode:prepublish did not produce the compiled Extension Host test');
  }

  // The smoke requires these exact archive members; fail before launching VS Code
  // so a packaging regression is not reported as a test timeout.
  const zip = new AdmZip(vsixPath);
  for (const entry of [
    'extension/dist/src/backends/acp-run.js',
    'extension/dist/src/backends/acp-client.js',
    'extension/dist/src/shared/image-attachments.js',
  ]) {
    if (!zip.getEntry(entry)) {
      throw new Error(`VSIX is missing a module the image smoke drives: ${entry}`);
    }
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
    launchArgs: [
      workspacePath,
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
