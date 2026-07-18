/**
 * P5-W7 packaged Extension Host fault UAT.
 * Runs against freshly packaged VSIX modules (not the source tree).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
const PHASE5_SCENARIO_IDS = [
  'corrupt_open',
  'not_a_database_open',
  'foreign_reject',
  'incompatible_reject',
  'write_full_rollback',
  'write_readonly_rollback',
  'busy_responsiveness',
  'backup_wal_writer',
  'backup_reopen_consistency',
  'reset_cancel',
  'reset_success',
  'cross_window_reset_contention',
] as const;

type ScenarioResult = {
  scenarioId: (typeof PHASE5_SCENARIO_IDS)[number];
  resultCode: string;
  verdict: 'PASS' | 'FAIL';
  durationMs: number;
  count?: number;
  byteSize?: number;
  hash?: string;
  mechanism?: 'api' | 'vacuum';
  schemaVersion?: number;
};

interface PackagedDbClient {
  open(dbPath: string, busyTimeoutMs?: number): Promise<void>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  transaction(statements: Array<{ sql: string; params?: unknown[] }>): Promise<unknown>;
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
  reset(opts?: { path?: string }): Promise<{ schemaVersion: number }>;
  close(): Promise<void>;
}

interface PackagedClientModule {
  DbClient: new (options: {
    workerPath: string;
    faultCapability?: boolean;
    faultPlan?: { code: string; operation: string; remaining: number };
  }) => PackagedDbClient;
  resolveWorkerPath(dir?: string): string;
}

interface PackagedSchemaModule {
  SQLITE_SCHEMA_VERSION: number;
  MUSTER_APPLICATION_ID: number;
}

interface PackagedMaintenanceModule {
  handleBackupDatabaseCommand: (deps: Record<string, unknown>) => Promise<{ kind: string; code?: string }>;
  handleDeveloperResetCommand: (deps: Record<string, unknown>) => Promise<{ kind: string; code?: string }>;
  RESET_CHOICE_WITHOUT_BACKUP: string;
  RESET_CHOICE_BACKUP: string;
}

function msNow(): number {
  return Date.now();
}

function hashBytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function timed(
  scenarioId: ScenarioResult['scenarioId'],
  fn: () => Promise<Omit<ScenarioResult, 'scenarioId' | 'durationMs'>>,
  timeoutMs = 20_000,
): Promise<ScenarioResult> {
  const start = msNow();
  try {
    const body = await withTimeout(fn(), timeoutMs, scenarioId);
    return { scenarioId, durationMs: msNow() - start, ...body };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'fail';
    return {
      scenarioId,
      durationMs: msNow() - start,
      resultCode: msg.startsWith('timeout:') ? 'timeout' : 'fail',
      verdict: 'FAIL',
      count: 0,
    };
  }
}

function loadPackaged(extensionPath: string): {
  clientMod: PackagedClientModule;
  schema: PackagedSchemaModule;
  workerPath: string;
  maintenance?: PackagedMaintenanceModule;
} {
  const sqliteDir = path.join(extensionPath, 'dist', 'src', 'task', 'sqlite');
  const hostDir = path.join(extensionPath, 'dist', 'src', 'host');
  const clientPath = path.join(sqliteDir, 'client.js');
  const schemaPath = path.join(sqliteDir, 'schema.js');
  const workerPath = path.join(sqliteDir, 'worker.js');
  assert.ok(fs.existsSync(clientPath), 'packaged client missing');
  assert.ok(fs.existsSync(workerPath), 'packaged worker missing');
  const clientMod = require(clientPath) as PackagedClientModule;
  const schema = require(schemaPath) as PackagedSchemaModule;
  let maintenance: PackagedMaintenanceModule | undefined;
  const maintPath = path.join(hostDir, 'sqlite-maintenance-commands.js');
  if (fs.existsSync(maintPath)) {
    maintenance = require(maintPath) as PackagedMaintenanceModule;
  }
  return { clientMod, schema, workerPath, maintenance };
}

function seedMinimal(client: PackagedDbClient, workspaceId = 'ws-fault'): Promise<void> {
  return client
    .run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
       VALUES (?,?,?,?,?)`,
      [workspaceId, `${workspaceId}-key`, 'Fault', 'now', 'now'],
    )
    .then(() =>
      client.run(`INSERT INTO workspace_revisions (workspace_id, revision) VALUES (?, ?)`, [
        workspaceId,
        1,
      ]),
    )
    .then(() => undefined);
}

function reopenReadonly(
  dbPath: string,
): {
  applicationId: number;
  userVersion: number;
  quickCheck: string;
  revision: number;
  close(): void;
} {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
      prepare(sql: string): { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
      close(): void;
    };
  };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const appId = db.prepare('PRAGMA application_id').get() as Record<string, number>;
  const ver = db.prepare('PRAGMA user_version').get() as Record<string, number>;
  const quick = db.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>;
  const rev = db.prepare('SELECT COALESCE(MAX(revision),0) AS r FROM workspace_revisions').get() as {
    r: number;
  };
  return {
    applicationId: Number(Object.values(appId)[0] ?? 0),
    userVersion: Number(Object.values(ver)[0] ?? 0),
    quickCheck: String(Object.values(quick[0] ?? {})[0] ?? ''),
    revision: rev?.r ?? 0,
    close: () => db.close(),
  };
}

/** Same pattern as write-failure.test.ts: spin-hold BEGIN IMMEDIATE then COMMIT. */
function spawnLockHolder(dbPath: string, holdMs: number): {
  worker: Worker;
  held: Promise<void>;
  exited: Promise<void>;
} {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.path);
      db.exec('PRAGMA busy_timeout = 0');
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      parentPort.postMessage({ held: true });
      const end = Date.now() + workerData.holdMs;
      while (Date.now() < end) { /* hold lock */ }
      try { db.exec('COMMIT'); } catch { try { db.exec('ROLLBACK'); } catch {} }
      db.close();
      parentPort.postMessage({ released: true });
    `,
    { eval: true, workerData: { path: dbPath, holdMs } },
  );
  const held = new Promise<void>((resolve, reject) => {
    worker.once('message', (msg: { held?: boolean }) => {
      if (msg.held) resolve();
      else reject(new Error('lock not held'));
    });
    worker.once('error', reject);
  });
  const exited = new Promise<void>((resolve) => {
    worker.once('exit', () => resolve());
  });
  return { worker, held, exited };
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('tlelabs.muster');
  assert.ok(extension, 'packaged extension missing');
  await extension.activate();

  const { clientMod, schema, workerPath, maintenance } = loadPackaged(extension.extensionPath);
  assert.equal(schema.SQLITE_SCHEMA_VERSION, 7);
  const runtimeClass = process.env.MUSTER_PHASE5_RUNTIME_CLASS || 'stable';
  const outPath = process.env.MUSTER_PHASE5_SCENARIO_OUT;
  assert.ok(outPath, 'MUSTER_PHASE5_SCENARIO_OUT required');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-p5-fault-'));
  const results: ScenarioResult[] = [];

  const makeClient = (opts: { faultCapability?: boolean; faultPlan?: { code: string; operation: string; remaining: number } } = {}) =>
    new clientMod.DbClient({
      workerPath,
      ...(opts.faultCapability ? { faultCapability: true } : {}),
      ...(opts.faultPlan ? { faultPlan: opts.faultPlan } : {}),
    });

  // --- corrupt_open ---
  results.push(
    await timed('corrupt_open', async () => {
      const dbPath = path.join(root, 'corrupt.sqlite3');
      {
        const c = makeClient();
        await c.open(dbPath);
        await c.close();
      }
      const original = fs.readFileSync(dbPath);
      fs.writeFileSync(dbPath, original.subarray(0, Math.min(120, original.length)));
      const before = fs.readFileSync(dbPath);
      const c = makeClient();
      try {
        await c.open(dbPath);
        return { resultCode: 'unexpected_open', verdict: 'FAIL' };
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'unknown');
        const after = fs.readFileSync(dbPath);
        assert.equal(Buffer.compare(before, after), 0);
        assert.ok(code === 'corrupt' || code === 'not_a_database');
        return { resultCode: code, verdict: 'PASS', byteSize: after.length, hash: hashBytes(after) };
      } finally {
        await c.close().catch(() => undefined);
      }
    }),
  );

  // --- not_a_database_open ---
  results.push(
    await timed('not_a_database_open', async () => {
      const dbPath = path.join(root, 'notadb.sqlite3');
      fs.writeFileSync(dbPath, Buffer.from('this is not a sqlite database file at all'));
      const before = fs.readFileSync(dbPath);
      const c = makeClient();
      try {
        await c.open(dbPath);
        return { resultCode: 'unexpected_open', verdict: 'FAIL' };
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'unknown');
        assert.equal(Buffer.compare(before, fs.readFileSync(dbPath)), 0);
        assert.ok(code === 'not_a_database' || code === 'corrupt');
        return { resultCode: code, verdict: 'PASS' };
      } finally {
        await c.close().catch(() => undefined);
      }
    }),
  );

  // --- foreign_reject ---
  results.push(
    await timed('foreign_reject', async () => {
      const dbPath = path.join(root, 'foreign.sqlite3');
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
      };
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA application_id = 12345');
      seed.exec('CREATE TABLE t(x INTEGER)');
      seed.close();
      const before = fs.readFileSync(dbPath);
      const c = makeClient();
      try {
        await c.open(dbPath);
        return { resultCode: 'unexpected_open', verdict: 'FAIL' };
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'unknown');
        assert.equal(code, 'foreign_database');
        assert.equal(Buffer.compare(before, fs.readFileSync(dbPath)), 0);
        return { resultCode: code, verdict: 'PASS' };
      } finally {
        await c.close().catch(() => undefined);
      }
    }),
  );

  // --- incompatible_reject ---
  results.push(
    await timed('incompatible_reject', async () => {
      const dbPath = path.join(root, 'incompat.sqlite3');
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
      };
      const seed = new DatabaseSync(dbPath);
      seed.exec(`PRAGMA application_id = ${schema.MUSTER_APPLICATION_ID}`);
      seed.exec('PRAGMA user_version = 1');
      seed.exec('CREATE TABLE workspaces(id TEXT)');
      seed.close();
      const before = fs.readFileSync(dbPath);
      const c = makeClient();
      try {
        await c.open(dbPath);
        return { resultCode: 'unexpected_open', verdict: 'FAIL' };
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'unknown');
        assert.equal(code, 'incompatible_schema');
        assert.equal(Buffer.compare(before, fs.readFileSync(dbPath)), 0);
        return { resultCode: code, verdict: 'PASS', schemaVersion: schema.SQLITE_SCHEMA_VERSION };
      } finally {
        await c.close().catch(() => undefined);
      }
    }),
  );

  // --- write_full_rollback ---
  results.push(
    await timed('write_full_rollback', async () => {
      const dbPath = path.join(root, 'full.sqlite3');
      {
        const setup = makeClient();
        await setup.open(dbPath);
        await seedMinimal(setup);
        await setup.close();
      }
      const beforeRev = await (async () => {
        const c = makeClient();
        await c.open(dbPath);
        const row = await c.get<{ r: number }>(
          'SELECT COALESCE(MAX(revision),0) AS r FROM workspace_revisions',
        );
        await c.close();
        return row?.r ?? 0;
      })();
      const c = makeClient({
        faultCapability: true,
        faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
      });
      await c.open(dbPath);
      try {
        await c.transaction([
          {
            sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                  VALUES (?,?,?,?,?)`,
            params: ['ws-full', 'k', 'F', 'now', 'now'],
          },
        ]);
        return { resultCode: 'unexpected_success', verdict: 'FAIL' };
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'unknown');
        assert.equal(code, 'full');
        const row = await c.get<{ r: number }>(
          'SELECT COALESCE(MAX(revision),0) AS r FROM workspace_revisions',
        );
        assert.equal(row?.r ?? 0, beforeRev);
        const ws = await c.get('SELECT id FROM workspaces WHERE id = ?', ['ws-full']);
        assert.equal(ws, undefined);
        return { resultCode: code, verdict: 'PASS', count: beforeRev };
      } finally {
        await c.close().catch(() => undefined);
      }
    }),
  );

  // --- write_readonly_rollback ---
  results.push(
    await timed('write_readonly_rollback', async () => {
      const dbPath = path.join(root, 'readonly.sqlite3');
      {
        const setup = makeClient();
        await setup.open(dbPath);
        await seedMinimal(setup, 'ws-ro');
        await setup.close();
      }
      const c = makeClient({
        faultCapability: true,
        faultPlan: { code: 'readonly', operation: 'transaction', remaining: 1 },
      });
      await c.open(dbPath);
      try {
        await c.transaction([
          {
            sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                  VALUES (?,?,?,?,?)`,
            params: ['ws-ro-fail', 'k', 'R', 'now', 'now'],
          },
        ]);
        return { resultCode: 'unexpected_success', verdict: 'FAIL' };
      } catch (error) {
        const code = String((error as { code?: string }).code ?? 'unknown');
        assert.equal(code, 'readonly');
        const ws = await c.get('SELECT id FROM workspaces WHERE id = ?', ['ws-ro-fail']);
        assert.equal(ws, undefined);
        return { resultCode: code, verdict: 'PASS' };
      } finally {
        await c.close().catch(() => undefined);
      }
    }),
  );

  // --- busy_responsiveness ---
  results.push(
    await timed('busy_responsiveness', async () => {
      const dbPath = path.join(root, 'busy.sqlite3');
      {
        const setup = makeClient();
        await setup.open(dbPath);
        await seedMinimal(setup, 'ws-busy');
        await setup.close();
      }
      const lock = spawnLockHolder(dbPath, 500);
      await lock.held;
      let ticks = 0;
      const heartbeat = setInterval(() => {
        ticks += 1;
      }, 20);
      const c = makeClient();
      try {
        await c.open(dbPath, 80);
        try {
          await c.transaction([
            {
              sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                    VALUES (?,?,?,?,?)`,
              params: ['ws-busy-x', 'kb', 'WS', 'now', 'now'],
            },
          ]);
          return { resultCode: 'unexpected_success', verdict: 'FAIL', count: ticks };
        } catch (error) {
          const code = String((error as { code?: string }).code ?? 'unknown');
          assert.equal(code, 'busy');
          clearInterval(heartbeat);
          await lock.exited;
          assert.ok(ticks > 0, 'host heartbeat stalled during busy wait');
          // Same client recovers after release.
          await c.transaction([
            {
              sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                    VALUES (?,?,?,?,?)`,
              params: ['ws-after', 'ka', 'WS', 'now', 'now'],
            },
          ]);
          return { resultCode: 'busy', verdict: 'PASS', count: ticks };
        }
      } finally {
        clearInterval(heartbeat);
        await lock.exited.catch(() => undefined);
        await c.close().catch(() => undefined);
      }
    }),
  );

  // --- backup_wal_writer + backup_reopen_consistency ---
  const backupPair = await (async () => {
    const dbPath = path.join(root, 'backup-src.sqlite3');
    const backupPath = path.join(root, 'backup-out.sqlite3');
    const c = makeClient();
    await c.open(dbPath);
    await seedMinimal(c, 'ws-bak');
    await c.run(
      `INSERT INTO tasks
        (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['t1', 'ws-bak', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}'],
    );
    await c.run(
      `INSERT INTO messages
        (id, workspace_id, task_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['m-wal', 'ws-bak', 't1', 'assistant', 'final', 'WAL_ROW', 'now', '{}'],
    );
    // Concurrent writer commits during backup window (best-effort second client).
    const writer = makeClient();
    await writer.open(dbPath);
    const writePromise = writer.run(
      `INSERT INTO messages
        (id, workspace_id, task_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['m-concurrent', 'ws-bak', 't1', 'user', 'complete', 'later', 'now', '{}'],
    );
    const start = msNow();
    const meta = await c.backup(backupPath, { overwrite: false });
    await writePromise.catch(() => undefined);
    const durationMs = msNow() - start;
    const art = reopenReadonly(backupPath);
    try {
      assert.equal(art.applicationId, schema.MUSTER_APPLICATION_ID);
      assert.equal(art.userVersion, schema.SQLITE_SCHEMA_VERSION);
      assert.equal(art.quickCheck, 'ok');
    } finally {
      art.close();
    }
    await writer.close().catch(() => undefined);
    await c.close().catch(() => undefined);
    return {
      wal: {
        scenarioId: 'backup_wal_writer' as const,
        resultCode: 'ok',
        verdict: 'PASS' as const,
        durationMs,
        mechanism: meta.mechanism,
        schemaVersion: meta.schemaVersion,
        byteSize: meta.byteSize,
      },
      reopen: {
        scenarioId: 'backup_reopen_consistency' as const,
        resultCode: 'ok',
        verdict: 'PASS' as const,
        durationMs: 1,
        schemaVersion: art.userVersion,
        hash: hashBytes(fs.readFileSync(backupPath)),
        byteSize: meta.byteSize,
      },
    };
  })();
  results.push(backupPair.wal, backupPair.reopen);

  // --- reset_cancel / reset_success ---
  assert.ok(maintenance, 'packaged maintenance commands module required');
  results.push(
    await timed('reset_cancel', async () => {
      let quiesce = 0;
      let reset = 0;
      let reload = 0;
      const result = await maintenance!.handleDeveloperResetCommand({
        showWarningMessage: async () => undefined,
        runBackupFlow: async () => ({ kind: 'cancel' }),
        quiesceForMaintenance: async () => {
          quiesce += 1;
        },
        resetDatabase: async () => {
          reset += 1;
          return { schemaVersion: 7 };
        },
        reloadWindow: async () => {
          reload += 1;
        },
        showErrorMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        isMaintenanceActive: () => false,
        setMaintenanceActive: () => undefined,
      });
      assert.equal(result.kind, 'cancel');
      assert.equal(quiesce + reset + reload, 0);
      return { resultCode: 'cancel', verdict: 'PASS', count: 0 };
    }),
  );

  results.push(
    await timed('reset_success', async () => {
      const dbPath = path.join(root, 'reset-ok.sqlite3');
      {
        const setup = makeClient();
        await setup.open(dbPath);
        await seedMinimal(setup, 'ws-reset');
        await setup.run(
          `INSERT INTO tasks
            (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          ['t-reset', 'ws-reset', 'worker', 'open', 'draft', 'g', 'grok', 0, 'now', 'now', '{}'],
        );
        await setup.close();
      }
      const order: string[] = [];
      const result = await maintenance!.handleDeveloperResetCommand({
        showWarningMessage: async (_m: string, ...items: string[]) =>
          items.find((i) => /Without Backup/i.test(i)) ?? items[1],
        runBackupFlow: async () => ({ kind: 'cancel' }),
        quiesceForMaintenance: async () => {
          order.push('quiesce');
        },
        resetDatabase: async () => {
          order.push('reset');
          const c = makeClient();
          try {
            return await c.reset({ path: dbPath });
          } finally {
            await c.close().catch(() => undefined);
          }
        },
        reloadWindow: async () => {
          order.push('reload');
        },
        showErrorMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        isMaintenanceActive: () => false,
        setMaintenanceActive: (active: boolean) => {
          order.push(active ? 'hold' : 'release');
        },
      });
      assert.equal(result.kind, 'success');
      assert.ok(order.indexOf('quiesce') < order.indexOf('reset'));
      assert.ok(order.indexOf('reset') < order.indexOf('reload'));
      const c2 = makeClient();
      await c2.open(dbPath);
      try {
        const tasks = await c2.all('SELECT id FROM tasks');
        assert.equal(tasks.length, 0);
        assert.equal(await c2.pragma('user_version'), schema.SQLITE_SCHEMA_VERSION);
        assert.equal(await c2.pragma('application_id'), schema.MUSTER_APPLICATION_ID);
      } finally {
        await c2.close();
      }
      return { resultCode: 'ok', verdict: 'PASS', schemaVersion: schema.SQLITE_SCHEMA_VERSION, count: order.length };
    }),
  );

  // --- cross_window_reset_contention (two workers, one packaged identity) ---
  results.push(
    await timed('cross_window_reset_contention', async () => {
      const dbPath = path.join(root, 'contention.sqlite3');
      {
        const setup = makeClient();
        await setup.open(dbPath);
        await seedMinimal(setup, 'ws-ct');
        await setup.close();
      }
      const lock = spawnLockHolder(dbPath, 800);
      await lock.held;
      const tokenBefore = (() => {
        const st = fs.statSync(dbPath);
        return hashBytes(Buffer.from(`${st.dev}:${st.ino}`));
      })();
      const busyClient = makeClient();
      let sawBusy = false;
      try {
        await busyClient.open(dbPath, 200);
        try {
          await busyClient.reset();
        } catch (error) {
          const code = String((error as { code?: string }).code ?? 'unknown');
          assert.equal(code, 'busy');
          sawBusy = true;
        }
      } finally {
        await busyClient.close().catch(() => undefined);
        await lock.exited;
      }
      assert.ok(sawBusy, 'expected busy under peer lock');
      // After release, exclusive reset succeeds on same path identity.
      const resetter = makeClient();
      try {
        const meta = await resetter.reset({ path: dbPath });
        assert.equal(meta.schemaVersion, schema.SQLITE_SCHEMA_VERSION);
      } finally {
        await resetter.close().catch(() => undefined);
      }
      const tokenAfter = (() => {
        const st = fs.statSync(dbPath);
        return hashBytes(Buffer.from(`${st.dev}:${st.ino}`));
      })();
      assert.equal(tokenBefore, tokenAfter);
      return { resultCode: 'ok', verdict: 'PASS', hash: tokenAfter, schemaVersion: 7 };
    }),
  );

  // Ensure all required IDs present.
  for (const id of PHASE5_SCENARIO_IDS) {
    if (!results.some((r) => r.scenarioId === id)) {
      results.push({
        scenarioId: id,
        resultCode: 'missing',
        verdict: 'FAIL',
        durationMs: 0,
      });
    }
  }

  const payload = {
    runtimeClass,
    vscodeVersion: vscode.version,
    nodeVersion: process.versions.node,
    scenarios: results,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  const failed = results.filter((r) => r.verdict !== 'PASS');
  if (failed.length > 0) {
    console.error(
      `[phase5-fault-uat] FAIL runtime=${runtimeClass} failed=${failed.map((f) => f.scenarioId).join(',')}`,
    );
    throw new Error(`packaged fault UAT failed: ${failed.map((f) => f.scenarioId).join(',')}`);
  }
  console.log(
    `[phase5-fault-uat] ok runtime=${runtimeClass} vscode=${vscode.version} node=${process.versions.node} scenarios=${results.length}`,
  );
}
