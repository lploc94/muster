import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface PackagedDbClient {
  open(dbPath: string, busyTimeoutMs?: number): Promise<void>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  pragma(name: string): Promise<number>;
  close(): Promise<void>;
}

interface PackagedClientModule {
  DbClient: new (options: { workerPath: string }) => PackagedDbClient;
  resolveWorkerPath(dir?: string): string;
}

interface PackagedSchemaModule {
  SQLITE_SCHEMA_VERSION: number;
}

/**
 * Runs inside the real VS Code Extension Host. The runner extracts a freshly
 * built VSIX and passes that extracted directory as extensionDevelopmentPath,
 * so every import below comes from package contents rather than the source tree.
 */
export async function run(): Promise<void> {
  const expectIncompatible = process.env.MUSTER_EXPECT_INCOMPATIBLE === '1';
  const requireRemote = process.env.MUSTER_REQUIRE_REMOTE === '1';
  const extension = vscode.extensions.getExtension('tlelabs.muster');

  if (expectIncompatible) {
    assert.equal(
      extension,
      undefined,
      `VS Code ${vscode.version} loaded Muster despite engines.vscode ^1.101.0`,
    );
    return;
  }

  assert.ok(extension, 'freshly packaged tlelabs.muster extension was not discovered');
  if (requireRemote) {
    assert.ok(vscode.env.remoteName, 'Remote smoke must run in a Remote Extension Host');
  }
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  assert.ok(nodeMajor >= 22, `Extension Host Node is too old for node:sqlite: ${process.versions.node}`);
  const sqlite = require('node:sqlite') as { DatabaseSync?: unknown };
  assert.equal(typeof sqlite.DatabaseSync, 'function', 'Extension Host does not provide node:sqlite DatabaseSync');

  const sqliteDir = path.join(extension.extensionPath, 'dist', 'src', 'task', 'sqlite');
  const clientPath = path.join(sqliteDir, 'client.js');
  const workerPath = path.join(sqliteDir, 'worker.js');
  const schemaPath = path.join(sqliteDir, 'schema.js');
  assert.ok(fs.existsSync(clientPath), `packaged SQLite client missing: ${clientPath}`);
  assert.ok(fs.existsSync(workerPath), `packaged SQLite worker missing: ${workerPath}`);
  assert.ok(fs.existsSync(schemaPath), `packaged SQLite schema missing: ${schemaPath}`);

  // Activating the extracted extension catches missing packaged dependencies and
  // verifies the real globalStorage registry path can open before task runtime.
  await extension.activate();
  assert.equal(extension.isActive, true, 'packaged extension did not activate');

  // Spawn the worker from the extracted VSIX. This is the ABI/runtime check that
  // source-level node tests cannot provide.
  const packaged = require(clientPath) as PackagedClientModule;
  const schema = require(schemaPath) as PackagedSchemaModule;
  assert.equal(packaged.resolveWorkerPath(sqliteDir), workerPath);
  const client = new packaged.DbClient({ workerPath });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-vsix-sqlite-smoke-'));
  try {
    const dbPath = path.join(tempDir, 'muster.sqlite3');
    await client.open(dbPath);
    assert.equal(await client.pragma('application_id'), 0x4d555354);
    assert.equal(await client.pragma('foreign_keys'), 1);
    assert.equal(await client.pragma('user_version'), schema.SQLITE_SCHEMA_VERSION);
    assert.deepEqual(await client.get<{ journal_mode: string }>('PRAGMA journal_mode'), {
      journal_mode: 'wal',
    });
    console.log(
      `[muster-sqlite-host-smoke] ok vscode=${vscode.version} node=${process.versions.node} ` +
        `remote=${vscode.env.remoteName ?? 'desktop'}`,
    );
  } finally {
    await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
