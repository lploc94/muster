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
  'src/task/store.ts',
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
  expectCondition(
    hasYamlLine(workflowText, /^\s*-\s*run:\s*npm test\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to run \`npm test\` as the shared local and CI verifier.`,
  );
  expectCondition(
    !hasYamlLine(workflowText, /^\s*-\s*run:\s*npm run compile\s*(?:#.*)?$/),
    failures,
    `Expected ${workflowPath} to run \`npm test\` directly instead of retaining the old \`npm run compile\` compile-only CI path.`,
  );
  expectCondition(
    !hasYamlLine(workflowText, /^\s*matrix:\s*(?:#.*)?$/) && !/node-version:\s*\[/.test(workflowText),
    failures,
    `Expected ${workflowPath} to use one Node 24 LTS environment, not a Node version matrix.`,
  );
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
    textFiles.get('src/task/store.ts'),
    failures,
    'src/task/store.ts',
    'centralize task and session persistence without requiring smoke checks to read runtime session files',
    ['TaskStore', 'TaskStoreFile', 'commit'],
  );
  checked.push('task-store boundary');

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
