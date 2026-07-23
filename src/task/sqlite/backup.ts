/**
 * SQLite-aware live backup for the Muster global store (P5-W4).
 *
 * Runs inside the DB worker only. Prefers module-level `node:sqlite.backup`
 * when present; falls back to coordinated `VACUUM INTO` on older hosts
 * (VS Code 1.101 / Node 22.15.1). Never copies the live main file while WAL
 * may hold committed pages.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { findSchemaFingerprintFailure } from './schema-fingerprint';
import { MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './schema';
import { MusterInvariantError, MusterSqliteError, mapToMusterSqliteError } from './errors';
import { maybeInjectFault } from './fault-inject';

export type BackupMechanism = 'api' | 'vacuum';

export type BackupResultMeta = {
  mechanism: BackupMechanism;
  schemaVersion: number;
  workspaceRevision: number;
  byteSize: number;
};

export type BackupRequestOptions = {
  destinationPath: string;
  overwrite: boolean;
  /** Request-scoped Int32 flag: 0 running, 1 cancelled (Atomics). */
  cancellationFlag?: SharedArrayBuffer;
  /** Test-only (fault capability): force mechanism selection. */
  forceMechanism?: BackupMechanism;
  /** Test-only: arm cancel flag after snapshot (before verify/publish). */
  armCancelAfterSnapshot?: boolean;
  /** Test-only: corrupt temp after snapshot before verify. */
  corruptBeforeVerify?: boolean;
  /** Test-only: throw after verify, before publish. */
  failBeforePublish?: boolean;
  /** Test-only: throw inside publishBackupArtifact after destination checks. */
  failDuringPublish?: boolean;
  /**
   * Test-only: SharedArrayBuffer Int32 set to 1 on the first native backup
   * progress callback so concurrent-writer tests can wait for real overlap.
   */
  progressFlag?: SharedArrayBuffer;
};

const NATIVE_BACKUP_PAGE_RATE = 50;

type SqliteBackupFn = (
  sourceDb: DatabaseSync,
  destination: string,
  options?: {
    rate?: number;
    progress?: (info: { totalPages: number; remainingPages: number }) => void;
  },
) => Promise<void>;

function readScalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : 0;
}

function quoteSqlitePathLiteral(filePath: string): string {
  return `'${filePath.replace(/'/g, "''")}'`;
}

function isCancelled(flag: SharedArrayBuffer | undefined): boolean {
  if (!flag) return false;
  return Atomics.load(new Int32Array(flag), 0) !== 0;
}

function throwIfCancelled(flag: SharedArrayBuffer | undefined): void {
  if (isCancelled(flag)) {
    throw new MusterInvariantError('invariant', 'backup');
  }
}

function probeNativeBackup(): SqliteBackupFn | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('node:sqlite') as { backup?: SqliteBackupFn };
    return typeof mod.backup === 'function' ? mod.backup.bind(mod) : undefined;
  } catch {
    return undefined;
  }
}

/** Exported for packaged smoke / tests: which mechanism this runtime prefers. */
export function preferredBackupMechanism(): BackupMechanism {
  return probeNativeBackup() ? 'api' : 'vacuum';
}

type PathIdentity = {
  normalized: string;
  real: string | undefined;
  dev: number | undefined;
  ino: number | undefined;
};

function identityForExisting(filePath: string): PathIdentity {
  const normalized = path.resolve(filePath);
  let real: string | undefined;
  let dev: number | undefined;
  let ino: number | undefined;
  try {
    real = fs.realpathSync(normalized);
  } catch {
    real = undefined;
  }
  try {
    const st = fs.statSync(real ?? normalized);
    dev = st.dev;
    ino = st.ino;
  } catch {
    // ignore
  }
  return { normalized, real, dev, ino };
}

function identityForDestination(destPath: string): PathIdentity {
  const normalized = path.resolve(destPath);
  if (fs.existsSync(normalized)) {
    return identityForExisting(normalized);
  }
  const parent = path.dirname(normalized);
  const base = path.basename(normalized);
  let parentReal = parent;
  try {
    parentReal = fs.realpathSync(parent);
  } catch {
    parentReal = path.resolve(parent);
  }
  return {
    normalized: path.join(parentReal, base),
    real: undefined,
    dev: undefined,
    ino: undefined,
  };
}

function sameIdentity(a: PathIdentity, b: PathIdentity): boolean {
  if (a.normalized === b.normalized) return true;
  if (a.real && b.real && a.real === b.real) return true;
  if (
    a.dev !== undefined &&
    b.dev !== undefined &&
    a.ino !== undefined &&
    b.ino !== undefined &&
    a.dev === b.dev &&
    a.ino === b.ino
  ) {
    return true;
  }
  if (a.real && a.real === b.normalized) return true;
  if (b.real && b.real === a.normalized) return true;
  return false;
}

/**
 * Reject destinations that alias the live main/WAL/SHM trio under either
 * overwrite mode. Uses both lexical and canonical (realpath) source paths so a
 * file-symlink open path cannot hide the real WAL/SHM names.
 */
export function assertDestinationNotLiveSource(
  sourcePath: string,
  destinationPath: string,
): void {
  if (!sourcePath || sourcePath === ':memory:') {
    throw new MusterInvariantError('invariant', 'backup');
  }
  if (typeof destinationPath !== 'string' || destinationPath.trim() === '') {
    throw new MusterInvariantError('invariant', 'backup');
  }
  const dest = identityForDestination(destinationPath);

  let canonicalMain = path.resolve(sourcePath);
  try {
    canonicalMain = fs.realpathSync(path.resolve(sourcePath));
  } catch {
    // keep resolved lexical path
  }

  const livePaths = new Set<string>();
  for (const base of [path.resolve(sourcePath), canonicalMain]) {
    livePaths.add(base);
    livePaths.add(`${base}-wal`);
    livePaths.add(`${base}-shm`);
  }
  if (livePaths.has(dest.normalized) || (dest.real && livePaths.has(dest.real))) {
    throw new MusterInvariantError('invariant', 'backup');
  }

  const liveIdentities: PathIdentity[] = [];
  for (const p of livePaths) {
    liveIdentities.push(identityForExisting(p));
  }
  for (const src of liveIdentities) {
    if (sameIdentity(src, dest)) {
      throw new MusterInvariantError('invariant', 'backup');
    }
  }
}

/**
 * Destination with leftover -wal/-shm would pair a newly published main with
 * stale journals. Fail closed before publication; leave existing dest untouched.
 */
export function assertDestinationSidecarsAbsent(destinationPath: string): void {
  const dest = path.resolve(destinationPath);
  if (fs.existsSync(`${dest}-wal`) || fs.existsSync(`${dest}-shm`)) {
    throw new MusterInvariantError('invariant', 'backup');
  }
}

function captureWorkspaceRevision(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(revision), 0) AS revision FROM workspace_revisions`)
    .get() as { revision: number } | undefined;
  const value = row?.revision ?? 0;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read-only verification — never calls openStoreDatabase (no stamp/WAL/bootstrap).
 */
export function verifyBackupArtifact(
  artifactPath: string,
  expectedSchemaVersion: number = SQLITE_SCHEMA_VERSION,
): {
  schemaVersion: number;
  workspaceRevision: number;
  byteSize: number;
} {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(artifactPath, { readOnly: true });
    const applicationId = readScalar(db, 'application_id');
    if (applicationId !== MUSTER_APPLICATION_ID) {
      throw new MusterSqliteError('foreign_database', 'backup');
    }
    const schemaVersion = readScalar(db, 'user_version');
    if (schemaVersion !== expectedSchemaVersion) {
      throw new MusterSqliteError('incompatible_schema', 'backup');
    }
    const fingerprint = findSchemaFingerprintFailure(db);
    if (fingerprint) {
      throw new MusterSqliteError('incompatible_schema', 'backup');
    }
    const quick = db.prepare('PRAGMA quick_check').all() as Array<Record<string, string>>;
    const ok =
      Array.isArray(quick) &&
      quick.length === 1 &&
      Object.values(quick[0] ?? {})[0] === 'ok';
    if (!ok) {
      throw new MusterSqliteError('corrupt', 'backup');
    }
    const workspaceRevision = captureWorkspaceRevision(db);
    const byteSize = fs.statSync(artifactPath).size;
    if (!Number.isFinite(byteSize) || byteSize <= 0) {
      throw new MusterSqliteError('unknown', 'backup');
    }
    return { schemaVersion, workspaceRevision, byteSize };
  } catch (error) {
    throw mapToMusterSqliteError(error, 'backup');
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // best-effort
      }
    }
  }
}

function tempSiblingPath(destinationPath: string): string {
  const dir = path.dirname(path.resolve(destinationPath));
  const base = path.basename(destinationPath);
  return path.join(dir, `.${base}.muster-bak-tmp-${randomUUID()}`);
}

function unlinkQuiet(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best-effort cleanup of invocation-owned artifacts only
  }
}

/** Remove an invocation-owned temp DB and any leftover -wal/-shm sidecars. */
function cleanupTempArtifact(tempPath: string | undefined): void {
  if (!tempPath) return;
  unlinkQuiet(tempPath);
  unlinkQuiet(`${tempPath}-wal`);
  unlinkQuiet(`${tempPath}-shm`);
}

/**
 * Atomically publish a verified temp artifact to the destination.
 * - no-overwrite: linkSync (fails with EEXIST if dest appears) then unlink temp
 * - overwrite: renameSync temp over dest (POSIX atomic replace; old dest remains if rename fails)
 */
export function publishBackupArtifact(
  tempPath: string,
  destinationPath: string,
  overwrite: boolean,
  options: { failDuringPublish?: boolean } = {},
): void {
  const dest = path.resolve(destinationPath);
  assertDestinationSidecarsAbsent(dest);
  if (options.failDuringPublish) {
    throw new MusterSqliteError('io', 'backup');
  }

  if (!overwrite) {
    // Atomic no-clobber: link fails with EEXIST if dest appears concurrently.
    // Temp and destination are siblings on the same filesystem by construction;
    // non-EEXIST failures fail closed rather than racing with rename.
    try {
      fs.linkSync(tempPath, dest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new MusterInvariantError('invariant', 'backup');
      }
      throw mapToMusterSqliteError(error, 'backup');
    }
    cleanupTempArtifact(tempPath);
    return;
  }

  // Atomic replace on same filesystem: destination remains if rename fails.
  fs.renameSync(tempPath, dest);
  cleanupTempArtifact(tempPath);
}

async function createSnapshotFile(
  db: DatabaseSync,
  tempPath: string,
  mechanism: BackupMechanism,
  cancellationFlag: SharedArrayBuffer | undefined,
  progressFlag: SharedArrayBuffer | undefined,
): Promise<void> {
  if (mechanism === 'api') {
    const backupFn = probeNativeBackup();
    if (!backupFn) {
      throw new MusterInvariantError('invariant', 'backup');
    }
    await backupFn(db, tempPath, {
      rate: NATIVE_BACKUP_PAGE_RATE,
      progress: (info) => {
        // Signal only while pages remain so concurrent tests observe mid-backup.
        if (progressFlag && info.remainingPages > 0) {
          Atomics.store(new Int32Array(progressFlag), 0, 1);
        }
        if (isCancelled(cancellationFlag)) {
          throw new MusterInvariantError('invariant', 'backup');
        }
      },
    });
    return;
  }
  // VACUUM INTO is one uninterruptible SQLite statement on the minimum host.
  // Signal progress immediately before the statement so tests can observe start.
  if (progressFlag) {
    Atomics.store(new Int32Array(progressFlag), 0, 1);
  }
  db.exec(`VACUUM INTO ${quoteSqlitePathLiteral(tempPath)}`);
}

/**
 * Backup the already-open live Muster connection to destinationPath.
 */
export async function backupOpenDatabase(
  db: DatabaseSync,
  sourcePath: string,
  options: BackupRequestOptions,
): Promise<BackupResultMeta> {
  throwIfCancelled(options.cancellationFlag);
  assertDestinationNotLiveSource(sourcePath, options.destinationPath);
  assertDestinationSidecarsAbsent(options.destinationPath);

  const destResolved = path.resolve(options.destinationPath);
  if (fs.existsSync(destResolved) && !options.overwrite) {
    throw new MusterInvariantError('invariant', 'backup');
  }

  const native = probeNativeBackup();
  const mechanism: BackupMechanism =
    options.forceMechanism ?? (native ? 'api' : 'vacuum');
  if (mechanism === 'api' && !native) {
    throw new MusterInvariantError('invariant', 'backup');
  }

  const tempPath = tempSiblingPath(options.destinationPath);
  let published = false;
  try {
    throwIfCancelled(options.cancellationFlag);
    await createSnapshotFile(
      db,
      tempPath,
      mechanism,
      options.cancellationFlag,
      options.progressFlag,
    );

    if (options.armCancelAfterSnapshot && options.cancellationFlag) {
      Atomics.store(new Int32Array(options.cancellationFlag), 0, 1);
    }
    // Fallback (and native) cancellation is publication-safe after snapshot.
    throwIfCancelled(options.cancellationFlag);

    if (options.corruptBeforeVerify) {
      fs.writeFileSync(tempPath, Buffer.from('NOT_A_SQLITE_DATABASE_CORRUPT'));
    }

    // Commit-boundary fault before verification/publication durability.
    maybeInjectFault('backup');
    throwIfCancelled(options.cancellationFlag);

    const verified = verifyBackupArtifact(tempPath);
    throwIfCancelled(options.cancellationFlag);

    if (options.failBeforePublish) {
      throw new MusterSqliteError('io', 'backup');
    }

    assertDestinationSidecarsAbsent(options.destinationPath);
    publishBackupArtifact(tempPath, options.destinationPath, options.overwrite, {
      ...(options.failDuringPublish ? { failDuringPublish: true } : {}),
    });
    published = true;

    return {
      mechanism,
      schemaVersion: verified.schemaVersion,
      workspaceRevision: verified.workspaceRevision,
      byteSize: verified.byteSize,
    };
  } catch (error) {
    if (!published) {
      cleanupTempArtifact(tempPath);
    }
    throw mapToMusterSqliteError(error, 'backup');
  }
}
