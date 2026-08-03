import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mapToMusterSqliteError, MusterSqliteError } from './errors';

export type ReclaimMode = 'incremental' | 'full' | 'refused' | 'noop';

export type ReclaimResult = {
  mode: ReclaimMode;
  fileBytesBefore: number;
  fileBytesAfter: number;
  /** WAL bytes before the first checkpoint; reports checkpoint-only reclamation. */
  walBytesBefore: number;
  freelistCountBefore: number;
  freelistCountAfter: number;
  batchesRun: number;
  walCheckpoints: number;
  residualWalBytes: number;
  requiredBytes?: number;
  availableBytes?: number;
};

export type ReclaimOptions = {
  /** Test seam for deterministic legacy full-compaction preflight. */
  availableBytes?: number;
};

/** Bound synchronous worker occupancy even when a store has a very large freelist. */
export const INCREMENTAL_VACUUM_BATCH_PAGES = 256;
export const MAX_INCREMENTAL_VACUUM_BATCHES = 16;

function scalar(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function fileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function availableBytes(filePath: string): number {
  const stat = fs.statfsSync(filePath);
  const bytes = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new MusterSqliteError('io', 'write');
  return bytes;
}

/**
 * Checkpoint the owned WAL and return whether SQLite reported it as busy.
 * A busy checkpoint is an operational failure: reclamation must not claim a
 * before/after result while another connection still prevents durable release.
 */
function checkpointTruncate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<string, number>;
  const busy = Number(row.busy ?? Object.values(row)[0] ?? 0);
  if (busy !== 0) throw new MusterSqliteError('busy', 'write');
}

function resultBase(
  db: DatabaseSync,
  sourcePath: string,
  walBytesBefore: number,
): Omit<ReclaimResult, 'mode' | 'fileBytesAfter' | 'freelistCountAfter' | 'batchesRun' | 'walCheckpoints' | 'residualWalBytes'> {
  return {
    // main-file baseline is after the initial checkpoint: only then are both
    // sides comparable for incremental vacuum/VACUUM page reclamation.
    fileBytesBefore: fileBytes(sourcePath),
    walBytesBefore,
    freelistCountBefore: scalar(db, 'freelist_count'),
  };
}

function finish(
  db: DatabaseSync,
  sourcePath: string,
  base: ReturnType<typeof resultBase>,
  mode: ReclaimMode,
  batchesRun: number,
  walCheckpoints: number,
  extra: Pick<ReclaimResult, 'requiredBytes' | 'availableBytes'> = {},
): ReclaimResult {
  return {
    mode,
    ...base,
    fileBytesAfter: fileBytes(sourcePath),
    freelistCountAfter: scalar(db, 'freelist_count'),
    batchesRun,
    walCheckpoints,
    residualWalBytes: fileBytes(`${sourcePath}-wal`),
    ...extra,
  };
}

/**
 * Reclaim free SQLite pages from an already-open worker-owned database.
 * INCREMENTAL stores are bounded to 16 x 256-page cycles; legacy NONE stores
 * use VACUUM only after confirming enough free disk for SQLite's temporary work.
 */
export function reclaimOpenDatabase(
  db: DatabaseSync,
  sourcePath: string,
  options: ReclaimOptions = {},
): ReclaimResult {
  try {
    // Measure both main DB and WAL before checkpointing. A checkpoint-only pass
    // can free significant WAL bytes while freelist_count remains zero; measuring
    // afterward incorrectly reports that useful reclaim as a no-op.
    const walBytesBefore = fileBytes(`${sourcePath}-wal`);
    checkpointTruncate(db);
    const base = resultBase(db, sourcePath, walBytesBefore);
    const autoVacuum = scalar(db, 'auto_vacuum');

    if (base.freelistCountBefore === 0) {
      return finish(db, sourcePath, base, 'noop', 0, 1);
    }

    if (autoVacuum === 2) {
      let batchesRun = 0;
      let walCheckpoints = 1;
      while (scalar(db, 'freelist_count') > 0 && batchesRun < MAX_INCREMENTAL_VACUUM_BATCHES) {
        checkpointTruncate(db);
        walCheckpoints += 1;
        db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_BATCH_PAGES})`);
        batchesRun += 1;
        checkpointTruncate(db);
        walCheckpoints += 1;
      }
      return finish(db, sourcePath, base, 'incremental', batchesRun, walCheckpoints);
    }

    if (autoVacuum === 0) {
      const requiredBytes = base.fileBytesBefore * 2;
      const available = options.availableBytes ?? availableBytes(sourcePath);
      if (available < requiredBytes) {
        return finish(db, sourcePath, base, 'refused', 0, 1, {
          requiredBytes,
          availableBytes: available,
        });
      }
      db.exec('VACUUM');
      checkpointTruncate(db);
      return finish(db, sourcePath, base, 'full', 1, 2, { requiredBytes, availableBytes: available });
    }

    // FULL auto_vacuum has no incremental freelist reclaim contract. Avoid a
    // surprise rewrite; the user command only routes incremental and legacy NONE.
    return finish(db, sourcePath, base, 'noop', 0, 1);
  } catch (error) {
    throw mapToMusterSqliteError(error, 'write');
  }
}
