#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_FILES = [
  'package.json',
  'tsconfig.json',
  '.github/workflows/ci.yml',
  'docs/VERIFICATION-EVIDENCE.md',
  'src/extension.ts',
  'src/backends/claude.ts',
  'src/runner.ts',
  'src/task/repository.ts',
  'src/types.ts',
  'mcp/muster-ask-server.mjs',
];

const FORBIDDEN_LIVE_CLAIMS = [
  'live VS Code activation verified',
  'real Claude CLI execution verified',
  'MCP stdio behavior verified',
  'package/release readiness verified',
  'hosted CI execution verified',
  'runtime session persistence verified',
];

const EVIDENCE_REQUIRED_TEXT = [
  'Contract proof',
  'Integration proof',
  'Operational proof',
  'Artifact-driven UAT proof',
  'npm test',
  '.github/workflows/ci.yml',
  '## Non-Live Limitations',
];

const EVIDENCE_LIMITATION_MARKERS = [
  {
    label: 'VS Code activation',
    phrases: ['VS Code activation'],
  },
  {
    label: 'Claude CLI or provider subprocess execution',
    phrases: ['Claude CLI', 'provider subprocess execution'],
  },
  {
    label: 'MCP stdio or transport behavior',
    phrases: ['MCP stdio', 'MCP transport behavior', 'MCP bridge'],
  },
  {
    label: 'packaging or release readiness',
    phrases: ['package publishing', 'marketplace readiness', 'package/release readiness'],
  },
  {
    label: 'hosted CI execution',
    phrases: ['hosted CI', 'remote CI job result', 'remote workflow execution'],
  },
  {
    label: 'runtime session persistence',
    phrases: ['runtime session files', 'persisted user sessions', 'runtime session persistence'],
  },
];

function displayPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function includesAll(text, terms) {
  return terms.every((term) => text.includes(term));
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function normalizeLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function hasYamlLine(text, pattern) {
  return normalizeLines(text).some((line) => !/^\s*#/.test(line) && pattern.test(line));
}

/**
 * Index of the first non-comment YAML step line whose `run:` value matches pattern.
 * Returns -1 when absent. Used to assert step ordering (e.g. compile before fast tier).
 */
function findYamlRunStepIndex(text, runPattern) {
  const lines = normalizeLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    if (!/^\s*-?\s*run:\s*/.test(line)) continue;
    const runValue = line.replace(/^\s*-?\s*run:\s*/, '').replace(/\s*(?:#.*)?$/, '');
    if (runPattern.test(runValue)) return i;
  }
  return -1;
}

function getTopLevelYamlBlock(text, key) {
  const lines = normalizeLines(text);
  const startIndex = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
  if (startIndex === -1) return '';

  const block = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() !== '' && /^\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function getIndentedYamlBlock(text, key, indent) {
  const lines = normalizeLines(text);
  const startPattern = new RegExp(`^ {${indent}}${key}:\\s*(?:#.*)?$`);
  const startIndex = lines.findIndex((line) => startPattern.test(line));
  if (startIndex === -1) return '';

  const block = [];
  for (const line of lines.slice(startIndex + 1)) {
    const currentIndent = line.match(/^ */)?.[0].length ?? 0;
    if (line.trim() !== '' && currentIndent <= indent) break;
    block.push(line);
  }
  return block.join('\n');
}

function expectCiWorkflowContract(workflowText, failures) {
  const workflowPath = '.github/workflows/ci.yml';
  if (workflowText === undefined) return;

  const onBlock = getTopLevelYamlBlock(workflowText, 'on');
  const pushBlock = getIndentedYamlBlock(onBlock, 'push', 2);
  const pullRequestBlock = getIndentedYamlBlock(onBlock, 'pull_request', 2);

  expectCondition(
    pushBlock !== '' && hasYamlLine(pushBlock, /^\s{4}branches:\s*\[main\]\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} on.push to target main so GitHub Actions runs the local \`npm test\` verifier automatically on push.`,
  );
  expectCondition(
    pullRequestBlock !== '' && hasYamlLine(pullRequestBlock, /^\s{4}branches:\s*\[main\]\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} on.pull_request to target main so GitHub Actions runs the local \`npm test\` verifier automatically on pull_request.`,
  );
  expectCondition(
    hasYamlLine(workflowText, /^\s*-\s*uses:\s*actions\/checkout@v4\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to use \`actions/checkout@v4\` before running the local \`npm test\` verifier.`,
  );
  expectCondition(
    hasYamlLine(workflowText, /^\s*-\s*uses:\s*actions\/setup-node@v4\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to use \`actions/setup-node@v4\` for the CI Node runtime.`,
  );
  expectCondition(
    hasYamlLine(workflowText, /^\s*node-version:\s*["']?24["']?\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} actions/setup-node configuration to set \`node-version: "24"\` for Node 24 LTS.`,
  );
  expectCondition(
    hasYamlLine(workflowText, /^\s*cache:\s*npm\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} actions/setup-node configuration to enable the npm cache for \`npm ci\`.`,
  );
  expectCondition(
    hasYamlLine(workflowText, /^\s*-\s*run:\s*npm ci\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to install dependencies with \`npm ci\` before running \`npm test\`.`,
  );
  const hasNpmTest = hasYamlLine(workflowText, /^\s*-\s*run:\s*npm test\s*(?:#.*)?$/);
  const hasCompile = hasYamlLine(workflowText, /^\s*-\s*run:\s*npm run compile\s*(?:#.*)?$/);
  expectCondition(
    hasNpmTest,
    failures,
    `Expected ${workflowPath} to run \`npm test\` as the shared local and CI verifier.`,
  );
  // Allow `npm run compile` only as an additional gate after `npm test`.
  // Reject the old compile-only CI path (compile without test).
  expectCondition(
    !hasCompile || hasNpmTest,
    failures,
    `Expected ${workflowPath} to run \`npm test\` when using \`npm run compile\` (reject compile-only CI).`,
  );
  // A VS Code-version matrix is intentional for the packaged Extension Host
  // compatibility smoke (old engine rejection + minimum/current hosts). The
  // invariant here is narrower: CI must not fan out the Node runtime itself.
  expectCondition(
    !/node-version\s*:\s*\[/.test(workflowText),
    failures,
    `Expected ${workflowPath} to use one Node 24 LTS runtime, not a node-version matrix.`,
  );

  // Behavioral webview suite stays on the compile job (visual gate is optional/local).
  expectCondition(
    hasYamlLine(workflowText, /^\s*-?\s*run:\s*npm run test:webview\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to run \`npm run test:webview\`.`,
  );
  // If a visual job is reintroduced later, never auto-update snapshots in CI.
  expectCondition(
    !hasYamlLine(workflowText, /(?:^|[\s"'])--update-snapshots(?:\s|$|"|')/) &&
      !hasYamlLine(workflowText, /test:visual:linux:update/),
    failures,
    `Expected ${workflowPath} never to pass --update-snapshots or run test:visual:linux:update.`,
  );

  // M022/S03 packaging gate — fast compile-job tier + dedicated host job.
  // Fast tier localises dependency/allowlist regressions in seconds without packaging.
  expectCondition(
    hasYamlLine(workflowText, /^\s*-?\s*run:\s*npm run test:m022-s02\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to run \`npm run test:m022-s02\` as the packaging fast-tier dependency/allowlist contract.`,
  );
  expectCondition(
    hasYamlLine(workflowText, /^\s*-?\s*run:\s*npm run test:m022-s03\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to run \`npm run test:m022-s03\` as the packaging marketplace-metadata contract.`,
  );
  // M022/S04: tracked evidence aggregate (clean-clone + entrypoint-regression).
  // D069 cost split — validates recorded local-drill evidence in seconds; does
  // not re-run multi-minute clean-clone package or vsce census drills in CI.
  expectCondition(
    hasYamlLine(workflowText, /^\s*-?\s*run:\s*npm run test:m022-s04\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to run \`npm run test:m022-s04\` as the packaging S04 evidence aggregate (clean-clone + entrypoint-regression).`,
  );

  // M022/S04: fast tier includes a fail-closed webview bundle check that needs
  // dist/webview from `npm run compile`. Running test:m022-s02 before compile
  // would always see a missing bundle in a clean CI checkout.
  const compileStepIndex = findYamlRunStepIndex(workflowText, /npm run compile/);
  const m022S02StepIndex = findYamlRunStepIndex(workflowText, /npm run test:m022-s02/);
  expectCondition(
    compileStepIndex !== -1 && m022S02StepIndex !== -1 && compileStepIndex < m022S02StepIndex,
    failures,
    `Expected ${workflowPath} to run \`npm run compile\` before \`npm run test:m022-s02\` so the packaging fast tier sees a built dist/webview (fail-closed webview bundle check).`,
  );

  const packagingGateBlock = getIndentedYamlBlock(workflowText, 'packaging-gate', 2);
  expectCondition(
    packagingGateBlock !== '',
    failures,
    `Expected ${workflowPath} to define a dedicated \`packaging-gate\` job for the real Extension Host packaging gate.`,
  );
  if (packagingGateBlock !== '') {
    expectCondition(
      hasYamlLine(packagingGateBlock, /^\s*-?\s*run:\s*xvfb-run -a npm run test:packaging\s*(?:#.*)?$/),
      failures,
      `Expected ${workflowPath} packaging-gate job to run \`xvfb-run -a npm run test:packaging\` so the host gate has a display on ubuntu-latest.`,
    );
    expectCondition(
      hasYamlLine(packagingGateBlock, /^\s*if:\s*always\(\)\s*(?:#.*)?$/),
      failures,
      `Expected ${workflowPath} packaging-gate job to upload evidence with \`if: always()\` so failed hosted runs still leave a machine-readable snapshot.`,
    );
    expectCondition(
      hasYamlLine(packagingGateBlock, /^\s*-?\s*uses:\s*actions\/upload-artifact@v4\s*(?:#.*)?$/),
      failures,
      `Expected ${workflowPath} packaging-gate job to use \`actions/upload-artifact@v4\` for packaging-gate evidence upload.`,
    );
    expectCondition(
      packagingGateBlock.includes('docs/plans/m022-s01-packaging-gate-evidence.json'),
      failures,
      `Expected ${workflowPath} packaging-gate job to upload \`docs/plans/m022-s01-packaging-gate-evidence.json\` as the packaging-gate evidence artifact.`,
    );
  }
}

async function readText(rootDir, relativePath, failures) {
  const fullPath = path.join(rootDir, relativePath);
  try {
    return await readFile(fullPath, 'utf8');
  } catch (err) {
    failures.push(`Missing required source-boundary file: ${displayPath(relativePath)} (${err.code ?? err.message})`);
    return undefined;
  }
}

async function readJson(rootDir, relativePath, failures) {
  const text = await readText(rootDir, relativePath, failures);
  if (text === undefined) return undefined;

  try {
    return JSON.parse(text);
  } catch (err) {
    failures.push(`Expected ${displayPath(relativePath)} to be valid JSON: ${err.message}`);
    return undefined;
  }
}

function expectCondition(condition, failures, message) {
  if (!condition) failures.push(message);
}

function expectText(text, failures, relativePath, expectation, terms) {
  expectCondition(
    text !== undefined && includesAll(text, terms),
    failures,
    `Expected ${displayPath(relativePath)} to ${expectation}.`,
  );
}

function expectVerificationEvidenceContract(evidenceText, failures) {
  const evidencePath = 'docs/VERIFICATION-EVIDENCE.md';
  if (evidenceText === undefined) return;

  for (const requiredText of EVIDENCE_REQUIRED_TEXT) {
    expectCondition(
      evidenceText.includes(requiredText),
      failures,
      `Expected ${evidencePath} to include verification evidence marker: ${requiredText}.`,
    );
  }

  for (const marker of EVIDENCE_LIMITATION_MARKERS) {
    expectCondition(
      includesAny(evidenceText, marker.phrases),
      failures,
      `Expected ${evidencePath} Non-Live Limitations to mention ${marker.label}.`,
    );
  }
}

export async function runSourceBoundarySmoke(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const failures = [];
  const checked = [];

  const packageJson = await readJson(rootDir, 'package.json', failures);
  checked.push('package.json exists and parses');
  if (packageJson) {
    const scripts = packageJson.scripts ?? {};
    expectCondition(
      typeof scripts.compile === 'string' && scripts.compile.includes('tsc -p .'),
      failures,
      'Expected package.json scripts.compile to run `tsc -p .` so TypeScript compile remains the first local verifier.',
    );
    checked.push('package.json scripts.compile');

    expectCondition(
      typeof scripts['test:source-boundary'] === 'string' &&
        scripts['test:source-boundary'].includes('node scripts/source-boundary-smoke.mjs'),
      failures,
      'Expected package.json scripts.test:source-boundary to run `node scripts/source-boundary-smoke.mjs`.',
    );
    checked.push('package.json scripts.test:source-boundary');

    // M014: compare vs explicit update must stay separate for Linux visual goldens.
    const visualCompare = scripts['test:visual:linux'];
    const visualUpdate = scripts['test:visual:linux:update'];
    expectCondition(
      typeof visualCompare === 'string' &&
        visualCompare.includes('run-visual-baselines.mjs') &&
        !/(?:^|[\s"'])--update(?:-snapshots)?(?:\s|$)/.test(visualCompare),
      failures,
      'Expected package.json scripts.test:visual:linux to run scripts/run-visual-baselines.mjs compare-only (no --update).',
    );
    checked.push('package.json scripts.test:visual:linux');
    expectCondition(
      typeof visualUpdate === 'string' &&
        visualUpdate.includes('run-visual-baselines.mjs') &&
        /(?:^|[\s"'])--update(?:\s|$)/.test(visualUpdate),
      failures,
      'Expected package.json scripts.test:visual:linux:update to run scripts/run-visual-baselines.mjs with --update.',
    );
    checked.push('package.json scripts.test:visual:linux:update');
  }

  const tsconfig = await readJson(rootDir, 'tsconfig.json', failures);
  checked.push('tsconfig.json exists and parses');
  if (tsconfig) {
    const compilerOptions = tsconfig.compilerOptions ?? {};
    const includes = tsconfig.include ?? [];
    const types = compilerOptions.types ?? [];
    expectCondition(
      compilerOptions.strict === true,
      failures,
      'Expected tsconfig.json compilerOptions.strict to be true for local type-safety enforcement.',
    );
    expectCondition(
      includes.includes('src/**/*') && includes.includes('scripts/**/*'),
      failures,
      'Expected tsconfig.json include to cover `src/**/*` and `scripts/**/*` for source and verifier coverage.',
    );
    expectCondition(
      types.includes('node') && types.includes('vscode'),
      failures,
      'Expected tsconfig.json compilerOptions.types to include `node` and `vscode`.',
    );
    checked.push('tsconfig compiler options');
  }

  const textFiles = new Map();
  for (const relativePath of SOURCE_FILES.filter((filePath) => !['package.json', 'tsconfig.json'].includes(filePath))) {
    textFiles.set(relativePath, await readText(rootDir, relativePath, failures));
    checked.push(`${relativePath} exists`);
  }

  expectCiWorkflowContract(textFiles.get('.github/workflows/ci.yml'), failures);
  checked.push('CI npm test boundary');

  expectText(
    textFiles.get('src/extension.ts'),
    failures,
    'src/extension.ts',
    'wire the VS Code extension to backend selection and webview messaging without requiring live activation',
    ['vscode', 'makeBackend', 'postMessage'],
  );
  checked.push('extension boundary');

  expectText(
    textFiles.get('src/backends/claude.ts'),
    failures,
    'src/backends/claude.ts',
    'define the Claude subprocess backend against shared backend types',
    ['spawn', 'claude', 'Backend', 'NormalizedEvent', 'RunOptions'],
  );
  checked.push('Claude backend boundary');

  expectText(
    textFiles.get('src/runner.ts'),
    failures,
    'src/runner.ts',
    'delegate runTurn to the provided backend instead of invoking a live provider in smoke tests',
    ['runTurn', 'backend.run'],
  );
  checked.push('runner boundary');

  expectText(
    textFiles.get('src/task/repository.ts'),
    failures,
    'src/task/repository.ts',
    'centralize SQLite persistence behind named repository commands',
    ['SqliteTaskRepository', 'TaskRepository', 'execute'],
  );
  checked.push('task-repository boundary');

  expectText(
    textFiles.get('src/types.ts'),
    failures,
    'src/types.ts',
    'declare normalized events, run options, and backend contracts',
    ['NormalizedEvent', 'RunOptions', 'Backend'],
  );
  checked.push('type boundary');

  expectText(
    textFiles.get('mcp/muster-ask-server.mjs'),
    failures,
    'mcp/muster-ask-server.mjs',
    'define the MCP stdio bridge with MUSTER_RUNTIME_DIR as an explicit runtime dependency',
    ['StdioServerTransport', 'MUSTER_RUNTIME_DIR', 'server.connect'],
  );
  checked.push('MCP bridge boundary');

  expectVerificationEvidenceContract(textFiles.get('docs/VERIFICATION-EVIDENCE.md'), failures);
  checked.push('verification evidence boundary');

  for (const [relativePath, text] of textFiles.entries()) {
    if (text === undefined) continue;
    for (const forbiddenClaim of FORBIDDEN_LIVE_CLAIMS) {
      if (text.includes(forbiddenClaim)) {
        failures.push(
          `Expected non-live scope in ${displayPath(relativePath)}; remove unsupported claim '${forbiddenClaim}'.`,
        );
      }
    }
  }
  checked.push('non-live scope boundaries');

  return {
    ok: failures.length === 0,
    checked,
    failures,
  };
}

function formatFailures(failures) {
  return failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n');
}

async function main() {
  const result = await runSourceBoundarySmoke();
  if (result.ok) {
    console.log(`source-boundary-smoke: passed ${result.checked.length} checks`);
    return;
  }

  console.error('source-boundary-smoke: failed source-boundary contract checks');
  console.error(formatFailures(result.failures));
  process.exitCode = 1;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
