/**
 * Package Muster once, run P5-W7 fault UAT on VS Code 1.101.0 and stable,
 * then write redacted evidence JSON.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { runTests } from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';
import {
  buildPhase5Evidence,
  validatePhase5Evidence,
} from './sqlite-phase5-evidence-schema.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const evidenceOut =
  process.env.MUSTER_PHASE5_EVIDENCE_OUT ||
  path.join(root, 'docs', 'plans', 'sqlite-phase5-packaged-fault-uat-evidence.json');
const runtimes = (process.env.MUSTER_PHASE5_RUNTIMES || '1.101.0,stable')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const downloadTimeout = Number.parseInt(
  process.env.MUSTER_VSCODE_DOWNLOAD_TIMEOUT_MS || '120000',
  10,
);
const runTimeoutMs = Number.parseInt(process.env.MUSTER_PHASE5_RUN_TIMEOUT_MS || '300000', 10);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-p5-fault-run-'));

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runOne(version, extensionDevelopmentPath, compiledTest) {
  const safe = version.replace(/[^a-z0-9.-]/gi, '_');
  const userDataDir = path.join(tempDir, `ud-${safe}`);
  const workspacePath = path.join(tempDir, `ws-${safe}`);
  const scenarioOut = path.join(tempDir, `scenarios-${safe}.json`);
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  await withTimeout(
    runTests({
      version,
      timeout: Number.isFinite(downloadTimeout) ? downloadTimeout : 120_000,
      extensionDevelopmentPath,
      extensionTestsPath: compiledTest,
      extensionTestsEnv: {
        MUSTER_PHASE5_RUNTIME_CLASS: version === '1.101.0' ? '1.101.0' : 'stable',
        MUSTER_PHASE5_SCENARIO_OUT: scenarioOut,
      },
      launchArgs: [
        workspacePath,
        `--user-data-dir=${userDataDir}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-extensions',
      ],
    }),
    Number.isFinite(runTimeoutMs) ? runTimeoutMs : 300_000,
    `packaged fault UAT ${version}`,
  );

  if (!fs.existsSync(scenarioOut)) {
    throw new Error(`scenario output missing for ${version}`);
  }
  return JSON.parse(fs.readFileSync(scenarioOut, 'utf8'));
}

async function main() {
  const compiledTest = path.join(root, 'dist', 'scripts', 'sqlite-packaged-fault-uat.js');
  const vsixPath = path.join(tempDir, 'muster.vsix');
  await createVSIX({
    cwd: root,
    packagePath: vsixPath,
    dependencies: true,
    allowMissingRepository: false,
  });
  if (!fs.existsSync(compiledTest)) {
    throw new Error('vscode:prepublish did not produce sqlite-packaged-fault-uat.js');
  }

  const zip = new AdmZip(vsixPath);
  const extractedRoot = path.join(tempDir, 'extracted');
  zip.extractAllTo(extractedRoot, true);
  const extensionDevelopmentPath = path.join(extractedRoot, 'extension');

  const runtimeResults = [];
  for (const version of runtimes) {
    console.log(`[phase5-fault-runner] starting ${version}`);
    const result = await runOne(version, extensionDevelopmentPath, compiledTest);
    runtimeResults.push({
      runtimeClass: result.runtimeClass,
      vscodeVersion: result.vscodeVersion,
      nodeVersion: result.nodeVersion,
      scenarios: result.scenarios,
    });
  }

  const evidence = buildPhase5Evidence(runtimeResults);
  const failures = validatePhase5Evidence(evidence, { requirePass: true });
  if (failures.length > 0) {
    console.error('phase5 evidence validation failed:');
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(evidenceOut), { recursive: true });
  fs.writeFileSync(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[phase5-fault-runner] wrote ${path.relative(root, evidenceOut)}`);
}

try {
  await main();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
