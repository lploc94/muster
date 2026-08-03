import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = path.join(root, 'dist', 'src', 'uninstall.js');

function runEntrypoint(storageDirectory, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd: root,
      env: { ...process.env, MUSTER_GLOBAL_STORAGE_DIR: storageDirectory, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function registerTarget(extensionRoot, storageDirectory, registryPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      `require('./dist/src/uninstall.js').registerUninstallStorageTarget(${JSON.stringify(extensionRoot)}, ${JSON.stringify(storageDirectory)})`,
    ], {
      cwd: root,
      env: { ...process.env, MUSTER_UNINSTALL_REGISTRY_PATH: registryPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

async function withTemporaryDirectory(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muster-uninstall-'));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('manifest ships the compiled uninstall entrypoint', async () => {
  const [packageText, vscodeIgnore] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8'),
    readFile(path.join(root, '.vscodeignore'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.scripts?.['vscode:uninstall'], 'node ./dist/src/uninstall.js');
  assert.doesNotMatch(vscodeIgnore, /^dist\/src\/\*\*$/m);
});

test('compiled uninstall entrypoint removes only the extension global-storage directory', async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const storageDirectory = path.join(temporaryDirectory, 'tlelabs.muster');
    await mkdir(path.join(storageDirectory, 'nested'), { recursive: true });
    await writeFile(path.join(storageDirectory, 'muster.sqlite3'), 'database');
    await writeFile(path.join(storageDirectory, 'nested', 'lease'), 'lease');

    const result = await runEntrypoint(storageDirectory);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^uninstall: reclaimed_bytes: 13\r?\n$/);
    await assert.rejects(access(storageDirectory));
  });
});

test('compiled uninstall entrypoint resolves only its activation-registered storage target', async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const storageDirectory = path.join(temporaryDirectory, 'profile-authority', 'tlelabs.muster');
    const registry = path.join(temporaryDirectory, 'registry.json');
    await mkdir(storageDirectory, { recursive: true });
    await writeFile(path.join(storageDirectory, 'muster.sqlite3'), 'database');
    await registerTarget(root, storageDirectory, registry);

    const result = await runEntrypoint(undefined, { MUSTER_UNINSTALL_REGISTRY_PATH: registry });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^uninstall: reclaimed_bytes: 8\r?\n$/);
    await assert.rejects(access(storageDirectory));
  });
});

test('compiled uninstall entrypoint exits zero and reports an absent storage directory', async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const result = await runEntrypoint(path.join(temporaryDirectory, 'tlelabs.muster'));

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'uninstall: absent\n');
  });
});

test('compiled uninstall entrypoint refuses an unregistered default instead of guessing Stable Code storage', async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const result = await runEntrypoint(undefined, {
      MUSTER_UNINSTALL_REGISTRY_PATH: path.join(temporaryDirectory, 'missing-registry.json'),
    });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'uninstall: refused\n');
  });
});

test('compiled uninstall entrypoint refuses a mis-resolved directory without deleting it', async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const unrelatedDirectory = path.join(temporaryDirectory, 'not-muster');
    await mkdir(unrelatedDirectory);
    await writeFile(path.join(unrelatedDirectory, 'keep.txt'), 'keep');

    const result = await runEntrypoint(unrelatedDirectory);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'uninstall: refused\n');
    await access(path.join(unrelatedDirectory, 'keep.txt'));
  });
});
