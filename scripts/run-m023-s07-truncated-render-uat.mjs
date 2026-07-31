/**
 * Package Muster and launch one disposable VS Code Extension Development Host
 * to capture M023/S07's real webview retention-summary DOM observation.
 * T06 owns committing the resulting ledger; this runner writes only a caller
 * supplied temporary output or an explicit local path.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { runTests } from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';
import {
  assembleBlockedTruncatedRenderEvidence,
  assembleTruncatedRenderEvidence,
} from './m023-s07-render-evidence-assembly.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const version = process.env.MUSTER_VSCODE_VERSION || 'stable';
const vscodeExecutablePath = process.env.MUSTER_VSCODE_EXECUTABLE_PATH;
const downloadTimeout = Number.parseInt(process.env.MUSTER_VSCODE_DOWNLOAD_TIMEOUT_MS || '120000', 10);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm023-s07-render-'));
const evidenceOut = process.env.MUSTER_UAT_EVIDENCE_OUT || path.join(tempDir, 'm023-s07-truncated-render-evidence.json');
const hostResultOut = path.join(tempDir, 'host-result.json');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function assertPackagedContents(zip) {
  const entries = zip.getEntries().map((entry) => entry.entryName.replaceAll('\\', '/'));
  const forbidden = entries.filter((entry) => /(?:^|\/)(?:\.env(?:\..*)?|\.gsd(?:[./].*)?|\.bg-shell(?:\/.*)?|Python(?:\/.*)?|NUL)$/i.test(entry));
  if (forbidden.length) throw new Error(`VSIX contains workspace-local or secret files: ${forbidden.slice(0, 10).join(', ')}`);
  if (!zip.getEntry('extension/dist/src/extension.js')) throw new Error('VSIX is missing compiled extension entry');
  if (!zip.getEntry('extension/dist/scripts/m023-s07-truncated-render-host.js')) throw new Error('VSIX is missing compiled M023/S07 host entry');
}

async function main() {
  const vsixPath = path.join(tempDir, 'muster.vsix');
  const compiledTest = path.join(root, 'dist', 'scripts', 'm023-s07-truncated-render-host.js');
  try {
    await createVSIX({ cwd: root, packagePath: vsixPath, dependencies: true, allowMissingRepository: false });
    if (!fs.existsSync(compiledTest)) throw new Error('vscode:prepublish did not produce m023-s07-truncated-render-host.js');

    const zip = new AdmZip(vsixPath);
    assertPackagedContents(zip);
    const extractedRoot = path.join(tempDir, 'extracted');
    zip.extractAllTo(extractedRoot, true);
    const extensionDevelopmentPath = path.join(extractedRoot, 'extension');
    const workspacePath = path.join(tempDir, 'workspace');
    const userDataDir = path.join(tempDir, 'user-data');
    fs.mkdirSync(path.join(workspacePath, '.vscode'), { recursive: true });
    // The fixture has four aged settled turns plus one live turn. Use the normal
    // workspace configuration surface so the production retention pass retains
    // only the live turn and strips the four aged file-change payloads.
    fs.writeFileSync(
      path.join(workspacePath, '.vscode', 'settings.json'),
      `${JSON.stringify({ 'muster.retention.maxRetainedTurnsPerTask': 1 })}\n`,
    );
    fs.mkdirSync(userDataDir, { recursive: true });

    await runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version }),
      timeout: Number.isFinite(downloadTimeout) ? downloadTimeout : 120_000,
      extensionDevelopmentPath,
      extensionTestsPath: compiledTest,
      extensionTestsEnv: {
        MUSTER_UAT_MODE: '1', MUSTER_UAT_ROLE: 'm023-s07', MUSTER_UAT_HOST_RESULT_OUT: hostResultOut,
      },
      launchArgs: [workspacePath, `--user-data-dir=${userDataDir}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--no-cached-data'],
    });
    if (!fs.existsSync(hostResultOut)) throw new Error('Extension Development Host exited without a render observation');
    const result = JSON.parse(fs.readFileSync(hostResultOut, 'utf8'));
    writeJson(evidenceOut, assembleTruncatedRenderEvidence(result));
    console.log(`[run-m023-s07-truncated-render-uat] PASS evidence=${evidenceOut}`);
  } catch (error) {
    const evidence = assembleBlockedTruncatedRenderEvidence(error);
    writeJson(evidenceOut, evidence);
    console.log(`[run-m023-s07-truncated-render-uat] BLOCKED evidence=${evidenceOut}`);
    if (process.env.MUSTER_UAT_ALLOW_BLOCKED !== '1') throw error;
  }
}

try {
  await main();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
