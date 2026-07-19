import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface PackagedDbClient {
  open(dbPath: string, busyTimeoutMs?: number): Promise<void>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  pragma(name: string): Promise<number>;
  backup(
    destinationPath: string,
    options?: { overwrite?: boolean },
  ): Promise<{
    mechanism: 'api' | 'vacuum';
    schemaVersion: number;
    workspaceRevision: number;
    byteSize: number;
  }>;
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
    assert.equal(schema.SQLITE_SCHEMA_VERSION, 7, 'packaged Phase 4 schema version drifted');
    assert.equal(await client.pragma('user_version'), schema.SQLITE_SCHEMA_VERSION);
    assert.deepEqual(await client.get<{ journal_mode: string }>('PRAGMA journal_mode'), {
      journal_mode: 'wal',
    });
    const durableTables = await client.all<{ name: string }>(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table'
          AND name IN ('change_log', 'change_feed_watermarks', 'send_outbox',
                       'presentations', 'presentation_operations')
        ORDER BY name`,
    );
    assert.deepEqual(durableTables.map((row) => row.name), [
      'change_feed_watermarks',
      'change_log',
      'presentation_operations',
      'presentations',
      'send_outbox',
    ]);
    assert.deepEqual(
      await client.get<{ name: string }>(
        `SELECT name FROM sqlite_schema
          WHERE type = 'trigger' AND name = 'trg_send_outbox_capacity'`,
      ),
      { name: 'trg_send_outbox_capacity' },
    );

    // P5-W4: packaged worker must create a verified backup using only capabilities
    // present on this Extension Host. VS Code 1.101 (Node 22.15.1) has no
    // node:sqlite.backup API and must use the VACUUM INTO fallback; newer hosts
    // may use the API. Never require the API on the minimum host.
    const sqliteMod = require('node:sqlite') as { backup?: unknown };
    const hostHasBackupApi = typeof sqliteMod.backup === 'function';
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)`,
      ['ws-smoke', 'smoke-key', 'Smoke', 'now', 'now'],
    );
    await client.run(
      `INSERT INTO workspace_revisions (workspace_id, revision) VALUES (?, ?)`,
      ['ws-smoke', 3],
    );
    const backupPath = path.join(tempDir, 'muster-backup.sqlite3');
    const backupMeta = await client.backup(backupPath, { overwrite: false });
    assert.ok(
      backupMeta.mechanism === 'api' || backupMeta.mechanism === 'vacuum',
      `unexpected backup mechanism: ${String(backupMeta.mechanism)}`,
    );
    if (!hostHasBackupApi) {
      assert.equal(
        backupMeta.mechanism,
        'vacuum',
        'minimum host without node:sqlite.backup must use VACUUM INTO fallback',
      );
    } else {
      assert.equal(
        backupMeta.mechanism,
        'api',
        'host with node:sqlite.backup must prefer the SQLite backup API',
      );
    }
    assert.equal(backupMeta.schemaVersion, schema.SQLITE_SCHEMA_VERSION);
    assert.equal(backupMeta.workspaceRevision, 3);
    assert.ok(backupMeta.byteSize > 0);
    assert.ok(fs.existsSync(backupPath), 'backup artifact missing');
    // Reopen independently (read-only) without going through openStoreDatabase.
    const artifact = new (require('node:sqlite') as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
        prepare(sql: string): { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
        close(): void;
      };
    }).DatabaseSync(backupPath, { readOnly: true });
    try {
      const appId = artifact.prepare('PRAGMA application_id').get() as Record<string, number>;
      assert.equal(Object.values(appId)[0], 0x4d555354);
      const ver = artifact.prepare('PRAGMA user_version').get() as Record<string, number>;
      assert.equal(Object.values(ver)[0], schema.SQLITE_SCHEMA_VERSION);
      const quick = artifact.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>;
      assert.equal(Object.values(quick[0] ?? {})[0], 'ok');
      const rev = artifact
        .prepare('SELECT revision FROM workspace_revisions WHERE workspace_id = ?')
        .get('ws-smoke') as { revision: number };
      assert.equal(rev.revision, 3);
    } finally {
      artifact.close();
    }

    console.log(
      `[muster-sqlite-host-smoke] ok vscode=${vscode.version} node=${process.versions.node} ` +
        `remote=${vscode.env.remoteName ?? 'desktop'} backup=${backupMeta.mechanism}`,
    );
  } finally {
    await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
