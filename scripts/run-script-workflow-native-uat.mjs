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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-script-workflow-uat-'));
const evidenceOut = process.env.MUSTER_UAT_EVIDENCE_OUT ||
  path.join(root, 'artifacts', 'script-workflow-native-qa.json');
const hostResultOut = path.join(tempDir, 'host-result.json');

function boundedReason(error) {
  return (error instanceof Error ? error.message : String(error))
    // UNC first: `\\host\share\...` would otherwise survive the drive-letter pass.
    .replace(/\\\\[^\s)]+/g, '<redacted-path>')
    .replace(/[A-Za-z]:[\\/][^\s)]+/g, '<redacted-path>')
    // Any absolute POSIX path, not just /Users, /home and /tmp: macOS uses
    // /private/var for temp dirs and containers use /workspaces and /opt.
    .replace(/\/[A-Za-z0-9._-]+(?:\/[^\s)]*)+/g, '<redacted-path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${filePath}.tmp`, filePath);
}

async function main() {
  const compiledTest = path.join(root, 'dist', 'scripts', 'script-workflow-native-host.js');
  const vsixPath = path.join(tempDir, 'muster.vsix');
  try {
    await createVSIX({
      cwd: root,
      packagePath: vsixPath,
      dependencies: true,
      allowMissingRepository: false,
    });
    if (!fs.existsSync(compiledTest)) {
      throw new Error('vscode:prepublish did not produce script-workflow-native-host.js');
    }
    const zip = new AdmZip(vsixPath);
    if (!zip.getEntry('extension/dist/src/extension.js')) {
      throw new Error('VSIX is missing the compiled extension entry');
    }
    if (!zip.getEntry('extension/dist/src/host/script-workflow-uat-fixture.js')) {
      throw new Error('VSIX is missing the native script workflow fixture');
    }
    const extracted = path.join(tempDir, 'extracted');
    zip.extractAllTo(extracted, true);
    const extensionDevelopmentPath = path.join(extracted, 'extension');
    const workspacePath = path.join(tempDir, 'workspace');
    const userDataDir = path.join(tempDir, 'user-data');
    const isolatedHome = path.join(tempDir, 'home');
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(isolatedHome, { recursive: true });

    await runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version }),
      timeout: Number.isFinite(downloadTimeout) ? downloadTimeout : 120_000,
      extensionDevelopmentPath,
      extensionTestsPath: compiledTest,
      extensionTestsEnv: {
        MUSTER_UAT_MODE: '1',
        MUSTER_UAT_ROLE: 'script-workflow-native-qa',
        MUSTER_UAT_HOST_RESULT_OUT: hostResultOut,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      },
      launchArgs: [
        workspacePath,
        `--user-data-dir=${userDataDir}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-extensions',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-updates',
      ],
    });
    if (!fs.existsSync(hostResultOut)) {
      throw new Error('Extension Development Host exited without a QA observation');
    }
    const host = JSON.parse(fs.readFileSync(hostResultOut, 'utf8'));
    if (
      host?.ok !== true ||
      host?.kind !== 'script-workflow-native-host-result' ||
      host?.hostMode !== 'extension-development-host'
    ) {
      throw new Error('native host result has invalid provenance');
    }
    const evidence = {
      verdict: 'PASS',
      kind: 'script-workflow-native-qa',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      vscodeVersion: host.vscodeVersion,
      hostMode: host.hostMode,
      observation: host.observation,
    };
    writeJson(evidenceOut, evidence);
    console.log(`[run-script-workflow-native-uat] PASS evidence=${evidenceOut}`);
  } catch (error) {
    writeJson(evidenceOut, {
      verdict: 'BLOCKED',
      kind: 'script-workflow-native-qa',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      blockedReason: boundedReason(error),
    });
    console.log(`[run-script-workflow-native-uat] BLOCKED evidence=${evidenceOut}`);
    if (process.env.MUSTER_UAT_ALLOW_BLOCKED !== '1') throw error;
  }
}

try {
  await main();
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  } catch (error) {
    console.warn(`[run-script-workflow-native-uat] cleanup deferred: ${String(error)}`);
  }
}
