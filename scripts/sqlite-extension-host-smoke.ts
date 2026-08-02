import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface PackagedReclaimResult {
  mode: 'incremental' | 'full' | 'refused' | 'noop';
  fileBytesBefore: number;
  fileBytesAfter: number;
  freelistCountBefore: number;
  freelistCountAfter: number;
  batchesRun: number;
  walCheckpoints: number;
  residualWalBytes: number;
}

interface PackagedStorageReport {
  fileBytes: number;
  walBytes: number;
  shmBytes: number;
  pageCount: number;
  freelistCount: number;
  pageSize: number;
  autoVacuum: number;
  tables: Array<{ name: string; bytes: number }>;
  tableBytesSource: 'dbstat' | 'estimated';
}

interface PackagedDbClient {
  open(dbPath: string, busyTimeoutMs?: number): Promise<void>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  pragma(name: string): Promise<number>;
  reclaimStorage(): Promise<PackagedReclaimResult>;
  storageReport(): Promise<PackagedStorageReport>;
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
  const sqlite = require('node:sqlite') as {
    DatabaseSync?: new (p: string, o?: { readOnly?: boolean }) => {
      exec(sql: string): void;
      prepare(sql: string): { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
      close(): void;
    };
  };
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
    assert.equal(
      schema.SQLITE_SCHEMA_VERSION,
      3,
      'packaged schema version drifted from expected current (v3)',
    );
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

    // M023/S01 + S02: these measurements and reclaim run through the packaged
    // worker inside Electron, not merely local Node's node:sqlite implementation.
    assert.equal(await client.pragma('auto_vacuum'), 2);
    assert.equal(await client.pragma('journal_size_limit'), 16 * 1024 * 1024);
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)`,
      ['ws-reclaim', 'reclaim-key', 'x'.repeat(8 * 1024 * 1024), 'now', 'now'],
    );
    await client.run('DELETE FROM workspaces WHERE id = ?', ['ws-reclaim']);
    const beforeReclaim = await client.storageReport();
    assert.ok(beforeReclaim.freelistCount > 0, 'deleted payload must leave SQLite free pages');
    const reclaimResult = await client.reclaimStorage();
    const storageReport = await client.storageReport();
    assert.equal(reclaimResult.mode, 'incremental');
    assert.ok(reclaimResult.fileBytesAfter < reclaimResult.fileBytesBefore, 'reclaim must shrink the main database file');
    assert.ok(reclaimResult.freelistCountAfter < reclaimResult.freelistCountBefore, 'reclaim must reduce SQLite free pages');
    assert.ok(reclaimResult.batchesRun > 0 && reclaimResult.batchesRun <= 16, 'reclaim batch count must be bounded and observable');
    assert.ok(reclaimResult.walCheckpoints >= 3, 'reclaim must report its checked WAL checkpoints');
    assert.ok(reclaimResult.residualWalBytes <= 16 * 1024 * 1024, 'reclaim must leave WAL within the owned connection limit');
    assert.equal(storageReport.fileBytes, reclaimResult.fileBytesAfter, 'after report must use the reclaim measurement surface');
    assert.ok(storageReport.fileBytes < beforeReclaim.fileBytes, 'reclaim must shrink the report file bytes after payload deletion');
    assert.deepEqual(fs.readdirSync(tempDir).sort(), ['muster.sqlite3', 'muster.sqlite3-shm', 'muster.sqlite3-wal']);
    assert.ok(storageReport.fileBytes > 0, 'storage report must include database bytes');
    assert.ok(storageReport.pageCount > 0, 'storage report must include a positive page count');
    assert.ok(storageReport.pageSize > 0, 'storage report must include a positive page size');
    assert.ok(
      storageReport.tables.every((table) => table.bytes >= 0 && table.bytes <= storageReport.pageCount * storageReport.pageSize),
      'each table byte count must be bounded by the database page capacity',
    );
    assert.ok(
      storageReport.tableBytesSource === 'dbstat' || storageReport.tableBytesSource === 'estimated',
      `unexpected storage report byte source: ${String(storageReport.tableBytesSource)}`,
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

    // M023/S02: Persist a schema-current store in SQLite's legacy NONE mode,
    // then reopen it through a second packaged worker. This proves normal open
    // accepts mixed modes and does not silently rewrite the existing file.
    const legacyPath = path.join(tempDir, 'legacy-muster.sqlite3');
    const legacyBootstrap = new packaged.DbClient({ workerPath });
    await legacyBootstrap.open(legacyPath);
    await legacyBootstrap.close();
    const legacyFixture = new sqlite.DatabaseSync!(legacyPath);
    try {
      legacyFixture.exec('PRAGMA auto_vacuum = NONE');
      legacyFixture.exec('VACUUM');
      const legacyAutoVacuum = legacyFixture.prepare('PRAGMA auto_vacuum').get() as Record<string, number>;
      assert.equal(Object.values(legacyAutoVacuum)[0], 0, 'legacy fixture must persist auto_vacuum = NONE');
    } finally {
      legacyFixture.close();
    }
    const legacyClient = new packaged.DbClient({ workerPath });
    try {
      await legacyClient.open(legacyPath);
      assert.equal(await legacyClient.pragma('application_id'), 0x4d555354);
      assert.equal(await legacyClient.pragma('user_version'), schema.SQLITE_SCHEMA_VERSION);
      assert.equal(
        await legacyClient.pragma('auto_vacuum'),
        0,
        'opening a legacy store must preserve auto_vacuum = NONE',
      );
      assert.equal(await legacyClient.pragma('journal_size_limit'), 16 * 1024 * 1024);
    } finally {
      await legacyClient.close();
    }

    console.log(
      `[muster-sqlite-host-smoke] ok vscode=${vscode.version} node=${process.versions.node} ` +
        `remote=${vscode.env.remoteName ?? 'desktop'} backup=${backupMeta.mechanism} ` +
        `autoVacuum=${storageReport.autoVacuum} journalSizeLimit=${await client.pragma('journal_size_limit')} ` +
        `reclaimMode=${reclaimResult.mode} reclaimBytes=${reclaimResult.fileBytesBefore}->${reclaimResult.fileBytesAfter} ` +
        `reclaimFreelist=${reclaimResult.freelistCountBefore}->${reclaimResult.freelistCountAfter} ` +
        `reclaimBatches=${reclaimResult.batchesRun} reclaimCheckpoints=${reclaimResult.walCheckpoints} ` +
        `residualWalBytes=${reclaimResult.residualWalBytes} tableBytesSource=${storageReport.tableBytesSource}`, 
    );
  } finally {
    await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
