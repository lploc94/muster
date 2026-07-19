/**
 * P5-W4 SQLite-aware live backup contract tests.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DbClient, DbWorkerError } from './client';
import { MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './schema';
import { preferredBackupMechanism } from './backup';
import { safeMessageForCode } from './errors';

const WORKER_TS = path.join(__dirname, 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

const clients: DbClient[] = [];
const tempDirs: string[] = [];

function makeClient(opts: { faultCapability?: boolean; faultPlan?: {
  code: 'full' | 'readonly' | 'io' | 'busy' | 'corrupt' | 'not_a_database';
  operation: 'backup' | 'unknown';
  remaining: number;
}} = {}): DbClient {
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
    ...(opts.faultCapability ? { faultCapability: true } : {}),
    ...(opts.faultPlan ? { faultPlan: opts.faultPlan } : {}),
  });
  clients.push(client);
  return client;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-backup-'));
  tempDirs.push(dir);
  return dir;
}

async function seedMusterDb(client: DbClient, dbPath: string): Promise<{
  workspaceRevision: number;
}> {
  await client.open(dbPath);
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
     VALUES (?,?,?,?,?)`,
    ['ws1', 'key1', 'WS One', 'now', 'now'],
  );
  await client.run(
    `INSERT INTO workspace_revisions (workspace_id, revision) VALUES (?, ?)`,
    ['ws1', 7],
  );
  await client.run(
    `INSERT INTO tasks
     (id, workspace_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['t1', 'ws1', 'worker', 'open', 'draft', 'goal', 'grok', 0, 'now', 'now', '{}'],
  );
  await client.run(
    `INSERT INTO messages
     (id, workspace_id, task_id, role, state, content, created_at, payload_json)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['m-wal', 'ws1', 't1', 'assistant', 'final', 'WAL_ONLY_COMMITTED_ROW', 'now', '{}'],
  );
  return { workspaceRevision: 7 };
}

function reopenArtifact(artifactPath: string): {
  applicationId: number;
  userVersion: number;
  quickCheck: string;
  message: string | undefined;
  revision: number;
} {
  const db = new DatabaseSync(artifactPath, { readOnly: true });
  try {
    const applicationId = Number(
      Object.values(
        (db.prepare('PRAGMA application_id').get() as Record<string, number>) ?? {},
      )[0] ?? 0,
    );
    const userVersion = Number(
      Object.values(
        (db.prepare('PRAGMA user_version').get() as Record<string, number>) ?? {},
      )[0] ?? 0,
    );
    const quick = db.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>;
    const quickCheck = String(Object.values(quick[0] ?? {})[0] ?? '');
    const msg = db
      .prepare(`SELECT content FROM messages WHERE id = ?`)
      .get('m-wal') as { content?: string } | undefined;
    const rev = db
      .prepare(`SELECT COALESCE(MAX(revision),0) AS r FROM workspace_revisions`)
      .get() as { r: number };
    return {
      applicationId,
      userVersion,
      quickCheck,
      message: msg?.content,
      revision: rev.r,
    };
  } finally {
    db.close();
  }
}

function cancelFlag(value = 0): SharedArrayBuffer {
  const buf = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(buf), 0, value);
  return buf;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('P5-W4 SQLite-aware live backup', () => {
  it('captures committed-but-uncheckpointed WAL rows in a verified independent artifact', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    const client = makeClient();
    const { workspaceRevision } = await seedMusterDb(client, dbPath);

    // Ensure WAL sidecars can exist; do not checkpoint.
    expect(fs.existsSync(dbPath)).toBe(true);

    const meta = await client.backup(dest, { overwrite: false });
    expect(meta.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    expect(meta.workspaceRevision).toBe(workspaceRevision);
    expect(meta.byteSize).toBeGreaterThan(0);
    expect(meta.mechanism === 'api' || meta.mechanism === 'vacuum').toBe(true);
    expect(JSON.stringify(meta)).not.toMatch(/muster\.sqlite3|WAL_ONLY|\/Users\/|SELECT /i);

    const art = reopenArtifact(dest);
    expect(art.applicationId).toBe(MUSTER_APPLICATION_ID);
    expect(art.userVersion).toBe(SQLITE_SCHEMA_VERSION);
    expect(art.quickCheck).toBe('ok');
    expect(art.message).toBe('WAL_ONLY_COMMITTED_ROW');
    expect(art.revision).toBe(workspaceRevision);

    // Negative oracle: raw main-file copy must not be treated as a correct backup
    // when committed pages may still live only in the WAL.
    const rawCopy = path.join(dir, 'raw-copy.sqlite3');
    fs.copyFileSync(dbPath, rawCopy);
    let rawHasWalRow = false;
    try {
      const rawDb = new DatabaseSync(rawCopy, { readOnly: true });
      try {
        const row = rawDb
          .prepare(`SELECT content FROM messages WHERE id = ?`)
          .get('m-wal') as { content?: string } | undefined;
        rawHasWalRow = row?.content === 'WAL_ONLY_COMMITTED_ROW';
      } finally {
        rawDb.close();
      }
    } catch {
      rawHasWalRow = false;
    }
    // Either the raw copy is unreadable/missing the row, or the SQLite-aware
    // backup still proves independent reopen with the row (already asserted).
    // When a -wal file exists with content, raw copy must not equal the aware backup.
    if (fs.existsSync(`${dbPath}-wal`) && fs.statSync(`${dbPath}-wal`).size > 0) {
      expect(rawHasWalRow).toBe(false);
    }

    // After a successful SQLite-aware backup the source still has the row.
    const sourceRow = await client.get<{ content: string }>(
      `SELECT content FROM messages WHERE id = ?`,
      ['m-wal'],
    );
    expect(sourceRow?.content).toBe('WAL_ONLY_COMMITTED_ROW');
    // Source remains writable.
    await client.run(
      `INSERT INTO messages (id, workspace_id, task_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['m2', 'ws1', 't1', 'user', 'final', 'after-backup', 'now', '{}'],
    );
  }, 30_000);

  it('concurrent writer yields a valid pre-or-post snapshot, never mixed state', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    const a = makeClient({ faultCapability: true });
    await seedMusterDb(a, dbPath);
    const blob = 'y'.repeat(64 * 1024);
    for (let i = 0; i < 30; i += 1) {
      await a.run(
        `INSERT INTO messages (id, workspace_id, task_id, role, state, content, created_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?)`,
        [`m-big-${i}`, 'ws1', 't1', 'assistant', 'final', blob, 'now', '{}'],
      );
    }

    const b = makeClient();
    await b.open(dbPath);

    const progress = cancelFlag(0);
    let backupSettled = false;
    const backupPromise = a.backup(dest, {
      overwrite: false,
      progressFlag: progress,
      ...(preferredBackupMechanism() === 'api' ? { forceMechanism: 'api' as const } : {}),
    });
    // Attach settlement handlers immediately so late observation cannot race.
    void backupPromise.then(
      () => {
        backupSettled = true;
      },
      () => {
        backupSettled = true;
      },
    );
    // Deterministic barrier: wait until worker signals mid-snapshot progress.
    const deadline = Date.now() + 15_000;
    while (Atomics.load(new Int32Array(progress), 0) === 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(Atomics.load(new Int32Array(progress), 0)).toBe(1);
    // Yield microtasks so a already-settled promise would flip backupSettled.
    await Promise.resolve();
    await Promise.resolve();
    expect(backupSettled).toBe(false);
    // One atomic concurrent commit: row + revision move together so the snapshot
    // is strictly pre (rev 7, no row) or post (rev 8 + row), never intermediate.
    await b.transaction([
      {
        sql: `INSERT INTO messages (id, workspace_id, task_id, role, state, content, created_at, payload_json)
              VALUES (?,?,?,?,?,?,?,?)`,
        params: [
          'm-concurrent',
          'ws1',
          't1',
          'assistant',
          'final',
          'CONCURRENT_ROW',
          'now',
          '{}',
        ],
      },
      {
        sql: `UPDATE workspace_revisions SET revision = revision + 1 WHERE workspace_id = ?`,
        params: ['ws1'],
      },
    ]);
    const meta = await backupPromise;
    backupSettled = true;

    const art = reopenArtifact(dest);
    expect(art.applicationId).toBe(MUSTER_APPLICATION_ID);
    expect(art.quickCheck).toBe('ok');
    expect(art.message).toBe('WAL_ONLY_COMMITTED_ROW');
    // Exactly one consistent snapshot: either pre (rev 7, no concurrent) or post (rev 8 + row).
    const artDb = new DatabaseSync(dest, { readOnly: true });
    try {
      const concurrent = artDb
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get('m-concurrent') as { content?: string } | undefined;
      if (meta.workspaceRevision === 7) {
        expect(concurrent).toBeUndefined();
        expect(art.revision).toBe(7);
      } else if (meta.workspaceRevision === 8) {
        expect(concurrent?.content).toBe('CONCURRENT_ROW');
        expect(art.revision).toBe(8);
      } else {
        throw new Error(`unexpected snapshot revision ${meta.workspaceRevision}`);
      }
    } finally {
      artDb.close();
    }

    // Source has both rows and accepts another write.
    const srcCount = await a.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`);
    expect(srcCount?.n).toBeGreaterThanOrEqual(2);
    await a.run(
      `INSERT INTO messages (id, workspace_id, task_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['m-after', 'ws1', 't1', 'user', 'final', 'still-writable', 'now', '{}'],
    );
  }, 30_000);

  it.each([
    { label: 'missing dest overwrite false', exists: false, overwrite: false, expectOk: true },
    { label: 'existing dest overwrite false', exists: true, overwrite: false, expectOk: false },
    { label: 'existing dest overwrite true', exists: true, overwrite: true, expectOk: true },
  ] as const)('$label', async ({ exists, overwrite, expectOk }) => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    const client = makeClient();
    await seedMusterDb(client, dbPath);

    let prior: Buffer | undefined;
    if (exists) {
      fs.writeFileSync(dest, Buffer.from('PRIOR_GOOD_BACKUP_BYTES_XXXX'));
      prior = fs.readFileSync(dest);
    }

    if (expectOk) {
      const meta = await client.backup(dest, { overwrite });
      expect(meta.byteSize).toBeGreaterThan(0);
      const art = reopenArtifact(dest);
      expect(art.message).toBe('WAL_ONLY_COMMITTED_ROW');
      if (prior) {
        expect(fs.readFileSync(dest).equals(prior)).toBe(false);
      }
    } else {
      await expect(client.backup(dest, { overwrite })).rejects.toBeInstanceOf(DbWorkerError);
      expect(fs.readFileSync(dest).equals(prior!)).toBe(true);
    }
    // No temp siblings left behind.
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('muster-bak-tmp'));
    expect(leftovers).toEqual([]);
  }, 30_000);

  it('pre-cancel is a no-op that leaves destination untouched', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    fs.writeFileSync(dest, Buffer.from('KEEP_ME'));
    const prior = fs.readFileSync(dest);
    const client = makeClient();
    await seedMusterDb(client, dbPath);

    const flag = cancelFlag(1);
    await expect(
      client.backup(dest, { overwrite: true, cancellationFlag: flag }),
    ).rejects.toBeInstanceOf(DbWorkerError);
    expect(fs.readFileSync(dest).equals(prior)).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.includes('muster-bak-tmp'))).toEqual([]);
  }, 30_000);

  it('shared-flag cancellation after snapshot prevents publish (api and vacuum)', async () => {
    const mechanisms = ['api', 'vacuum'] as const;
    for (const mechanism of mechanisms) {
      if (mechanism === 'api' && preferredBackupMechanism() !== 'api') {
        continue;
      }
      const dir = tempDir();
      const dbPath = path.join(dir, 'muster.sqlite3');
      const dest = path.join(dir, `backup-${mechanism}.sqlite3`);
      fs.writeFileSync(dest, Buffer.from(`PRIOR_${mechanism}`));
      const prior = fs.readFileSync(dest);
      const client = makeClient({ faultCapability: true });
      await seedMusterDb(client, dbPath);
      const flag = cancelFlag(0);
      await expect(
        client.backup(dest, {
          overwrite: true,
          cancellationFlag: flag,
          forceMechanism: mechanism,
          armCancelAfterSnapshot: true,
        }),
      ).rejects.toBeInstanceOf(DbWorkerError);
      expect(fs.readFileSync(dest).equals(prior)).toBe(true);
      expect(fs.readdirSync(dir).filter((n) => n.includes('muster-bak-tmp'))).toEqual([]);
      expect(Atomics.load(new Int32Array(flag), 0)).not.toBe(0);
    }
  }, 45_000);

  it('corrupt-before-verify fails without latching the source client', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    fs.writeFileSync(dest, Buffer.from('PRIOR_VERIFY'));
    const prior = fs.readFileSync(dest);
    const client = makeClient({ faultCapability: true });
    await seedMusterDb(client, dbPath);
    await expect(
      client.backup(dest, { overwrite: true, corruptBeforeVerify: true }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/corrupt|not_a_database|unknown/),
      operation: 'backup',
    });
    expect(fs.readFileSync(dest).equals(prior)).toBe(true);
    // Source still usable — no terminal latch.
    const row = await client.get<{ content: string }>(
      `SELECT content FROM messages WHERE id = ?`,
      ['m-wal'],
    );
    expect(row?.content).toBe('WAL_ONLY_COMMITTED_ROW');
    await client.run(
      `INSERT INTO messages (id, workspace_id, task_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['m-after-corrupt', 'ws1', 't1', 'user', 'final', 'still-ok', 'now', '{}'],
    );
  }, 30_000);

  it('failDuringPublish leaves destination byte-identical and removes temp', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    fs.writeFileSync(dest, Buffer.from('PRIOR_PUBLISH_FAIL'));
    const prior = fs.readFileSync(dest);
    const client = makeClient({ faultCapability: true });
    await seedMusterDb(client, dbPath);
    await expect(
      client.backup(dest, { overwrite: true, failDuringPublish: true }),
    ).rejects.toBeInstanceOf(DbWorkerError);
    expect(fs.readFileSync(dest).equals(prior)).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.includes('muster-bak-tmp'))).toEqual([]);
  }, 30_000);

  it('rejects malformed backup request fields via exact guard', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    const client = makeClient();
    await seedMusterDb(client, dbPath);
    // Empty destination is rejected by exact request guard / backup path checks.
    await expect(client.backup('   ', { overwrite: false })).rejects.toBeInstanceOf(DbWorkerError);
    // Oversized cancellation buffer is rejected.
    const badFlag = new SharedArrayBuffer(16);
    await expect(
      client.backup(dest, { overwrite: false, cancellationFlag: badFlag }),
    ).rejects.toBeInstanceOf(DbWorkerError);
    expect(fs.existsSync(dest)).toBe(false);
  }, 30_000);

  it('refuses overwrite when destination WAL/SHM sidecars exist', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    fs.writeFileSync(dest, Buffer.from('PRIOR_WITH_SIDECARS'));
    fs.writeFileSync(`${dest}-wal`, Buffer.from('STALE_WAL'));
    const prior = fs.readFileSync(dest);
    const client = makeClient();
    await seedMusterDb(client, dbPath);
    await expect(client.backup(dest, { overwrite: true })).rejects.toBeInstanceOf(DbWorkerError);
    expect(fs.readFileSync(dest).equals(prior)).toBe(true);
    expect(fs.existsSync(`${dest}-wal`)).toBe(true);
  }, 30_000);

  it('injected backup fault before publish preserves existing destination', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const dest = path.join(dir, 'backup.sqlite3');
    fs.writeFileSync(dest, Buffer.from('PRIOR_FAULT'));
    const prior = fs.readFileSync(dest);
    const client = makeClient({
      faultCapability: true,
      faultPlan: { code: 'full', operation: 'backup', remaining: 1 },
    });
    await seedMusterDb(client, dbPath);

    await expect(client.backup(dest, { overwrite: true })).rejects.toMatchObject({
      code: 'full',
      operation: 'backup',
      message: safeMessageForCode('full'),
    });
    expect(fs.readFileSync(dest).equals(prior)).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.includes('muster-bak-tmp'))).toEqual([]);
  }, 30_000);

  it.each([
    { kind: 'main' as const },
    { kind: 'wal' as const },
    { kind: 'shm' as const },
    { kind: 'normalized' as const },
  ])('rejects live source destination alias ($kind) under both overwrite modes', async ({ kind }) => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = makeClient();
    await seedMusterDb(client, dbPath);
    // Force real WAL activity so -wal/-shm exist without overwriting them with empty files
    // (empty overwrite of a live WAL can SIGBUS the open connection).
    await client.run(
      `INSERT INTO messages (id, workspace_id, task_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      [`m-force-wal-${kind}`, 'ws1', 't1', 'user', 'final', 'force-wal', 'now', '{}'],
    );

    const dest =
      kind === 'main'
        ? dbPath
        : kind === 'wal'
          ? `${dbPath}-wal`
          : kind === 'shm'
            ? `${dbPath}-shm`
            : path.join(dir, 'sub', '..', 'muster.sqlite3');

    // wal/shm may still be absent on some journal paths; path-string rejection still applies.
    for (const overwrite of [false, true]) {
      await expect(client.backup(dest, { overwrite })).rejects.toBeInstanceOf(DbWorkerError);
    }

    // Live trio and data unchanged / still writable.
    const row = await client.get<{ content: string }>(
      `SELECT content FROM messages WHERE id = ?`,
      ['m-wal'],
    );
    expect(row?.content).toBe('WAL_ONLY_COMMITTED_ROW');
    await client.run(
      `INSERT INTO messages (id, workspace_id, task_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      [`m-after-${kind}`, 'ws1', 't1', 'user', 'final', 'ok', 'now', '{}'],
    );
    expect(fs.readdirSync(dir).filter((n) => n.includes('muster-bak-tmp'))).toEqual([]);
  }, 30_000);

  it('rejects symlink alias of the live main under both overwrite modes', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = makeClient();
    await seedMusterDb(client, dbPath);
    const alias = path.join(dir, 'alias-main.sqlite3');
    try {
      fs.symlinkSync(dbPath, alias);
    } catch {
      // Platform without symlink support — skip.
      return;
    }
    for (const overwrite of [false, true]) {
      await expect(client.backup(alias, { overwrite })).rejects.toBeInstanceOf(DbWorkerError);
    }
    const row = await client.get<{ content: string }>(
      `SELECT content FROM messages WHERE id = ?`,
      ['m-wal'],
    );
    expect(row?.content).toBe('WAL_ONLY_COMMITTED_ROW');
  }, 30_000);

  it('rejects canonical WAL/SHM when source is opened through a file symlink', async () => {
    const dir = tempDir();
    const realDir = path.join(dir, 'real');
    fs.mkdirSync(realDir);
    const realDb = path.join(realDir, 'muster.sqlite3');
    const alias = path.join(dir, 'alias.sqlite3');
    try {
      fs.symlinkSync(realDb, alias);
    } catch {
      return;
    }
    // Open via alias so openPath is the symlink; canonical WAL is under real/.
    const client = makeClient();
    await seedMusterDb(client, alias);
    await client.run(
      `INSERT INTO messages (id, workspace_id, task_id, role, state, content, created_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['m-sym-wal', 'ws1', 't1', 'user', 'final', 'force', 'now', '{}'],
    );
    for (const suffix of ['-wal', '-shm'] as const) {
      const canonicalSidecar = `${realDb}${suffix}`;
      for (const overwrite of [false, true]) {
        await expect(client.backup(canonicalSidecar, { overwrite })).rejects.toBeInstanceOf(
          DbWorkerError,
        );
      }
    }
    const row = await client.get<{ content: string }>(
      `SELECT content FROM messages WHERE id = ?`,
      ['m-wal'],
    );
    expect(row?.content).toBe('WAL_ONLY_COMMITTED_ROW');
  }, 30_000);

  it('rejects hard-link alias of the live main when the platform supports it', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = makeClient();
    await seedMusterDb(client, dbPath);
    // Close before hard-link: some platforms refuse link() on an open SQLite file.
    await client.close();
    const alias = path.join(dir, 'hardlink-main.sqlite3');
    try {
      fs.linkSync(dbPath, alias);
    } catch {
      return;
    }
    const client2 = makeClient();
    await client2.open(dbPath);
    for (const overwrite of [false, true]) {
      await expect(client2.backup(alias, { overwrite })).rejects.toBeInstanceOf(DbWorkerError);
    }
  }, 30_000);

  it('errors never echo path, SQL, or content', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = makeClient();
    await seedMusterDb(client, dbPath);
    try {
      await client.backup(dbPath, { overwrite: true });
      throw new Error('expected reject');
    } catch (error) {
      const err = error as DbWorkerError;
      expect(err).toBeInstanceOf(DbWorkerError);
      expect(err.operation).toBe('backup');
      expect(JSON.stringify(err.detail)).not.toMatch(/muster\.sqlite3|WAL_ONLY|SELECT |\/Users\//i);
      expect(err.message).toBe(safeMessageForCode(err.code as 'invariant'));
    }
  }, 30_000);
});
