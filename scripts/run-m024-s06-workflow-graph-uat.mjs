/**
 * Package Muster and launch one disposable VS Code Extension Development Host
 * to capture M024/S06's real workflow graph request/result round trip.
 *
 * The runner never fabricates a PASS: if packaging, launch, or the round trip
 * fails, it writes BLOCKED evidence with a bounded reason and rethrows unless
 * MUSTER_UAT_ALLOW_BLOCKED=1.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { runTests } from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';
import {
  assembleBlockedWorkflowGraphEvidence,
  assembleWorkflowGraphEvidence,
} from './m024-s06-workflow-graph-evidence-assembly.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const version = process.env.MUSTER_VSCODE_VERSION || 'stable';
const vscodeExecutablePath = process.env.MUSTER_VSCODE_EXECUTABLE_PATH;
const downloadTimeout = Number.parseInt(
  process.env.MUSTER_VSCODE_DOWNLOAD_TIMEOUT_MS || '120000',
  10,
);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm024-s06-graph-'));
// Keep the caller-visible evidence outside the disposable VSIX temp tree. CI
// overrides this path into RUNNER_TEMP and uploads it; local defaults remain
// ignored under artifacts/ for inspection after the process exits.
const evidenceOut =
  process.env.MUSTER_UAT_EVIDENCE_OUT ||
  path.join(root, 'artifacts', 'm024-s06-workflow-graph-evidence.json');
const hostResultOut = path.join(tempDir, 'host-result.json');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function assertPackagedContents(zip) {
  const entries = zip.getEntries().map((entry) => entry.entryName.replaceAll('\\', '/'));
  const forbidden = entries.filter((entry) =>
    /(?:^|\/)(?:\.env(?:\..*)?|\.gsd(?:[./].*)?|\.bg-shell(?:\/.*)?|Python(?:\/.*)?|NUL)$/i.test(
      entry,
    ),
  );
  if (forbidden.length) {
    throw new Error(
      `VSIX contains workspace-local or secret files: ${forbidden.slice(0, 10).join(', ')}`,
    );
  }
  if (!zip.getEntry('extension/dist/src/extension.js')) {
    throw new Error('VSIX is missing compiled extension entry');
  }
  if (!zip.getEntry('extension/dist/scripts/m024-s06-workflow-graph-host.js')) {
    throw new Error('VSIX is missing compiled M024/S06 host entry');
  }
}

async function main() {
  const vsixPath = path.join(tempDir, 'muster.vsix');
  const compiledTest = path.join(root, 'dist', 'scripts', 'm024-s06-workflow-graph-host.js');
  try {
    await createVSIX({
      cwd: root,
      packagePath: vsixPath,
      dependencies: true,
      allowMissingRepository: false,
    });
    if (!fs.existsSync(compiledTest)) {
      throw new Error('vscode:prepublish did not produce m024-s06-workflow-graph-host.js');
    }

    const zip = new AdmZip(vsixPath);
    assertPackagedContents(zip);
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
        MUSTER_UAT_MODE: '1',
        MUSTER_UAT_ROLE: 'm024-s06',
        MUSTER_UAT_HOST_RESULT_OUT: hostResultOut,
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
        '--no-cached-data',
      ],
    });
    if (!fs.existsSync(hostResultOut)) {
      throw new Error('Extension Development Host exited without a workflow graph observation');
    }
    const result = JSON.parse(fs.readFileSync(hostResultOut, 'utf8'));
    const evidence = assembleWorkflowGraphEvidence(result);
    writeJson(evidenceOut, evidence);
    console.log(
      `[run-m024-s06-workflow-graph-uat] PASS nodes=${evidence.roundTrip.nodeCount} reusedNodes=${evidence.roundTrip.reusedNodeCount} evidence=${evidenceOut}`,
    );
  } catch (error) {
    writeJson(evidenceOut, assembleBlockedWorkflowGraphEvidence(error));
    console.log(`[run-m024-s06-workflow-graph-uat] BLOCKED evidence=${evidenceOut}`);
    if (process.env.MUSTER_UAT_ALLOW_BLOCKED !== '1') throw error;
  }
}

try {
  await main();
} finally {
  // Windows can retain a VS Code child-process handle briefly after runTests
  // resolves. Evidence is already atomically written, so cleanup must never
  // convert a proven PASS into a process failure. The OS will reclaim the temp
  // directory; a later retry can remove it once the handle is released.
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  } catch (error) {
    console.warn(`[run-m024-s06-workflow-graph-uat] cleanup deferred: ${String(error)}`);
  }
}
