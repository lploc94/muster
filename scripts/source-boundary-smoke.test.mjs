import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runSourceBoundarySmoke } from './source-boundary-smoke.mjs';

const smokeScript = fileURLToPath(new URL('./source-boundary-smoke.mjs', import.meta.url));

async function withFixture(files, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muster-smoke-'));
  try {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(root, filePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf8');
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runSmokeCli(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeScript], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const validEvidenceDocument = [
  '# M002 Verification Evidence',
  '## Evidence Ledger',
  '| Proof Class | Source | Boundary |',
  '|---|---|---|',
  '| Contract proof | `package.json`, `npm test` | Proves command wiring, not provider behavior. |',
  '| Integration proof | `.github/workflows/ci.yml` | Proves tracked workflow shape, not remote runner outcome. |',
  '| Operational proof | `scripts/source-boundary-smoke.mjs` | Proves local diagnostic behavior. |',
  '| Artifact-driven UAT proof | `scripts/source-boundary-smoke.test.mjs` | Proves artifact behavior under local fixtures. |',
  'Executable command references include `npm test` and `node scripts/source-boundary-smoke.mjs`.',
  '## Non-Live Limitations',
  'It does not verify live VS Code activation, live provider subprocess execution, live MCP transport behavior, package publishing, marketplace readiness, remote workflow execution, or runtime session persistence.',
].join('\n');

const validFixture = {
  'package.json': JSON.stringify({
    scripts: {
      compile: 'tsc -p .',
      test: 'vitest run',
      'test:source-boundary': 'node scripts/source-boundary-smoke.mjs',
    },
  }),
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      strict: true,
      rootDir: '.',
      outDir: 'dist',
      types: ['node', 'vscode'],
    },
    include: ['src/**/*', 'scripts/**/*'],
  }),
  '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: "24"\n          cache: npm\n      - run: npm ci\n      - run: npm test\n',
  'docs/VERIFICATION-EVIDENCE.md': validEvidenceDocument,
  'src/extension.ts': "import * as vscode from 'vscode';\nimport { makeBackend } from './backends/index';\nwebview.postMessage({ type: 'done' });\n",
  'src/backends/claude.ts': "import { spawn } from 'child_process';\nimport { Backend, NormalizedEvent, RunOptions } from '../types';\nspawn('claude', []);\nyield { type: 'turnCompleted' };\n",
  'src/runner.ts': "import { Backend, NormalizedEvent, RunOptions } from './types';\nexport async function* runTurn(backend: Backend, options: RunOptions): AsyncIterable<NormalizedEvent> { yield* backend.run(options); }\n",
  'src/task/store.ts': "export class TaskStore { commit() {} }\nexport interface TaskStoreFile {}\n",
  'src/types.ts': "export type NormalizedEvent = { type: 'turnCompleted' } | { type: 'error'; message: string };\nexport interface RunOptions { prompt: string; resumeId?: string; mcpConfigPath?: string; }\nexport interface Backend { run(options: RunOptions): AsyncIterable<NormalizedEvent>; }\n",
  'mcp/muster-ask-server.mjs': "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';\nconst runtimeDir = process.env.MUSTER_RUNTIME_DIR;\nif (!runtimeDir) process.exit(1);\nawait server.connect(new StdioServerTransport());\n",
};

test('accepts a fixture that satisfies the source-boundary contract', async () => {
  await withFixture(validFixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.ok(result.checked.length >= 10);
  });
});

test('repository package.json exposes the source-boundary smoke command', async () => {
  const packageJsonUrl = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));

  assert.equal(packageJson.scripts?.['test:source-boundary'], 'node scripts/source-boundary-smoke.mjs');
});

test('repository GitHub Actions workflow runs npm test automatically on main push and pull request', async () => {
  const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^on:\r?\n  push:\r?\n    branches: \[main\]\r?\n  pull_request:\r?\n    branches: \[main\]/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /uses: actions\/setup-node@v4/);
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /cache: npm/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm test/);
  assert.doesNotMatch(workflow, /run: npm run compile/);
  assert.doesNotMatch(workflow, /strategy:\n\s+matrix:/);
});

test('reports actionable diagnostics for missing source-boundary script wiring', async () => {
  const fixture = {
    ...validFixture,
    'package.json': JSON.stringify({ scripts: { compile: 'tsc -p .', test: 'vitest run' } }),
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /package\.json/);
    assert.match(result.failures.join('\n'), /test:source-boundary/);
    assert.match(result.failures.join('\n'), /node scripts\/source-boundary-smoke\.mjs/);
  });
});

test('rejects a manual-only GitHub Actions workflow', async () => {
  const fixture = {
    ...validFixture,
    '.github/workflows/ci.yml': 'name: CI\non:\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: "24"\n          cache: npm\n      - run: npm ci\n      - run: npm test\n',
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /\.github\/workflows\/ci\.yml/);
    assert.match(result.failures.join('\n'), /push/);
    assert.match(result.failures.join('\n'), /pull_request/);
  });
});

test('rejects GitHub Actions workflow drift back to compile-only CI', async () => {
  const fixture = {
    ...validFixture,
    '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: "24"\n          cache: npm\n      - run: npm ci\n      - run: npm run compile\n',
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /\.github\/workflows\/ci\.yml/);
    assert.match(result.failures.join('\n'), /npm test/);
    assert.match(result.failures.join('\n'), /npm run compile/);
  });
});

test('rejects GitHub Actions workflow with missing or wrong Node 24 setup', async () => {
  const fixture = {
    ...validFixture,
    '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: "22"\n          cache: npm\n      - run: npm ci\n      - run: npm test\n',
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /\.github\/workflows\/ci\.yml/);
    assert.match(result.failures.join('\n'), /node-version/);
    assert.match(result.failures.join('\n'), /Node 24/);
  });
});

test('reports malformed JSON with the inspected file path', async () => {
  const fixture = {
    ...validFixture,
    'tsconfig.json': '{ not-json',
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /tsconfig\.json/);
    assert.match(result.failures.join('\n'), /valid JSON/);
  });
});

test('reports actionable diagnostics when verification evidence is missing', async () => {
  const { 'docs/VERIFICATION-EVIDENCE.md': _evidence, ...fixture } = validFixture;

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /docs\/VERIFICATION-EVIDENCE\.md/);
    assert.match(result.failures.join('\n'), /Missing required source-boundary file/);
  });
});

test('reports actionable diagnostics when verification evidence is structurally incomplete', async () => {
  const fixture = {
    ...validFixture,
    'docs/VERIFICATION-EVIDENCE.md': '# M002 Verification Evidence\n\n## Evidence Ledger\nContract proof only.\n',
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /docs\/VERIFICATION-EVIDENCE\.md/);
    assert.match(result.failures.join('\n'), /Artifact-driven UAT/);
    assert.match(result.failures.join('\n'), /Non-Live Limitations/);
  });
});

test('keeps smoke checks source-bound and rejects live runtime scope', async () => {
  const fixture = {
    ...validFixture,
    'src/backends/claude.ts': "import { spawn } from 'child_process';\nimport { Backend } from '../types';\nspawn('claude', []);\nconst marker = 'real Claude CLI execution verified';\n",
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /non-live scope/);
    assert.match(result.failures.join('\n'), /src\/backends\/claude\.ts/);
  });
});

test('rejects unsupported live-runtime claims in verification evidence', async () => {
  const fixture = {
    ...validFixture,
    'docs/VERIFICATION-EVIDENCE.md': `${validEvidenceDocument}\nhosted CI execution verified\n`,
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSourceBoundarySmoke({ rootDir });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /non-live scope/);
    assert.match(result.failures.join('\n'), /docs\/VERIFICATION-EVIDENCE\.md/);
    assert.match(result.failures.join('\n'), /hosted CI execution verified/);
  });
});

test('CLI exits non-zero and prints numbered diagnostics for broken contracts', async () => {
  const fixture = {
    ...validFixture,
    'package.json': JSON.stringify({ scripts: { compile: 'tsc -p .', test: 'vitest run' } }),
  };

  await withFixture(fixture, async (rootDir) => {
    const result = await runSmokeCli(rootDir);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /source-boundary-smoke: failed source-boundary contract checks/);
    assert.match(result.stderr, /1\. Expected package\.json scripts\.test/);
    assert.match(result.stderr, /node scripts\/source-boundary-smoke\.mjs/);
  });
});
