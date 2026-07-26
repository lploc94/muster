/**
 * Package Muster, launch one disposable VS Code Extension Development Host
 * against the packaged extension, and run the M019/S05 native first-run matrix.
 *
 * Live execution is owned by T05; this runner is the packaged host seam.
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm019-s05-native-'));
const evidenceOut =
  process.env.MUSTER_UAT_EVIDENCE_OUT ||
  path.join(tempDir, 'm019-s05-native-first-run-result.json');

async function main() {
  const compiledTest = path.join(root, 'dist', 'scripts', 'm019-s05-native-first-run.js');
  const vsixPath = path.join(tempDir, 'muster.vsix');

  // createVSIX runs vscode:prepublish, so the matrix always tests a fresh build.
  await createVSIX({
    cwd: root,
    packagePath: vsixPath,
    dependencies: true,
    allowMissingRepository: false,
  });
  if (!fs.existsSync(compiledTest)) {
    throw new Error(
      'vscode:prepublish did not produce dist/scripts/m019-s05-native-first-run.js',
    );
  }

  const zip = new AdmZip(vsixPath);
  const packagedEntries = zip.getEntries().map((entry) => entry.entryName.replaceAll('\\', '/'));
  const forbiddenPackageEntries = packagedEntries.filter((entry) =>
    /(?:^|\/)(?:\.env(?:\..*)?|\.gsd(?:[./].*)?|\.bg-shell(?:\/.*)?|Python(?:\/.*)?|NUL)$/i.test(
      entry,
    ),
  );
  if (forbiddenPackageEntries.length > 0) {
    throw new Error(
      `VSIX contains workspace-local or secret files: ${forbiddenPackageEntries
        .slice(0, 10)
        .join(', ')}`,
    );
  }
  if (!zip.getEntry('extension/dist/src/extension.js')) {
    throw new Error('VSIX is missing compiled extension entry (extension/dist/src/extension.js)');
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
      MUSTER_UAT_MODE: '1',
      MUSTER_UAT_ROLE: 'm019-s05',
      MUSTER_UAT_EVIDENCE_OUT: evidenceOut,
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

  if (fs.existsSync(evidenceOut)) {
    const raw = fs.readFileSync(evidenceOut, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('native first-run host wrote non-JSON evidence output');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.kind !== 'm019-s05-native-first-run' ||
      !Array.isArray(parsed.scenarios) ||
      parsed.scenarios.length !== 9
    ) {
      throw new Error('native first-run host evidence failed the closed result shape');
    }
    console.log(
      `[run-m019-s05-native-first-run] host ok=${String(parsed.ok)} ready=${
        parsed.readyProviderId ?? 'none'
      } cleanup=${String(parsed.cleanupCompleted)}`,
    );
  } else {
    console.log(
      '[run-m019-s05-native-first-run] host exited without evidence file; treat as environment blocked at reconcile time',
    );
  }
}

try {
  await main();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
