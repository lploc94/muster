import type { Stats } from 'node:fs';
import { lstat, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';

/** A path-free filesystem observation suitable for the storage report surface. */
export type StorageDirectoryEntry = {
  name: string;
  bytes: number;
  modifiedAtMs: number;
};

/** A basename and byte count that is safe to show in the extension output channel. */
export type StorageFile = {
  name: string;
  bytes: number;
  /**
   * Pins the exact filesystem object that was classified. Removal re-reads this
   * so a file replaced after the confirmation modal is declined rather than
   * deleted under a basename the user was never shown.
   */
  modifiedAtMs: number;
};

/**
 * Files relevant to storage reclamation. Buckets are disjoint; callers must only
 * remove files from a removable bucket after applying their own confirmation flow.
 */
export type StorageOrphanReport = {
  live: StorageFile[];
  deadLegacyStores: StorageFile[];
  activeLeases: StorageFile[];
  staleLeases: StorageFile[];
};

/** The path-free result of a best-effort orphan removal pass. */
export type StorageOrphanRemoval = {
  removed: StorageFile[];
  bytesReclaimed: number;
  failedRemovals: number;
  /** Classified files whose on-disk identity changed before removal ran. */
  skippedRemovals: number;
};

const LIVE_STORAGE_FILES = new Set([
  'muster.sqlite3',
  'muster.sqlite3-wal',
  'muster.sqlite3-shm',
]);
const LEGACY_STORE_FILE = '.muster-tasks.json';
// The legacy JSON store named leases `${storePath}.lease.${encodeURIComponent(turnId)}`,
// and storePath was always the `.muster-tasks.json` file itself. Real residue is
// therefore `.muster-tasks.json.lease.turn%3A<id>`, never a bare `.lease.` name.
const LEASE_PREFIX = `${LEGACY_STORE_FILE}.lease.`;

/**
 * Reads a directory into path-free facts. A store can legitimately not exist
 * before first activation, in which case the caller receives an empty listing.
 */
export async function readStorageDirectoryEntries(
  directory: string,
): Promise<StorageDirectoryEntry[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const observations = await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) return undefined;
      const stats = await stat(path.join(directory, entry.name));
      return {
        name: entry.name,
        bytes: stats.size,
        modifiedAtMs: stats.mtimeMs,
      };
    }));
    return observations
      .filter((entry): entry is StorageDirectoryEntry => entry !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Partitions path-free directory facts without touching the filesystem, making
 * the retention decision deterministic under a caller-provided clock.
 */
export function classifyStorageOrphans(
  entries: readonly StorageDirectoryEntry[],
  nowMs: number,
  stalenessMs: number,
): StorageOrphanReport {
  const report: StorageOrphanReport = {
    live: [],
    deadLegacyStores: [],
    activeLeases: [],
    staleLeases: [],
  };

  for (const entry of entries) {
    const file = { name: entry.name, bytes: entry.bytes, modifiedAtMs: entry.modifiedAtMs };
    if (LIVE_STORAGE_FILES.has(entry.name)) {
      report.live.push(file);
    } else if (entry.name === LEGACY_STORE_FILE) {
      report.deadLegacyStores.push(file);
    } else if (entry.name.startsWith(LEASE_PREFIX)) {
      if (nowMs - entry.modifiedAtMs <= stalenessMs) report.activeLeases.push(file);
      else report.staleLeases.push(file);
    }
  }

  return report;
}

/**
 * Removes only files the classifier has already identified as reclaimable.
 * Files that disappear after classification are harmless; other removal errors
 * are recorded so callers can report partial reclamation without aborting.
 */
export async function removeStorageOrphans(
  directory: string,
  report: StorageOrphanReport,
): Promise<StorageOrphanRemoval> {
  const removed: StorageFile[] = [];
  let bytesReclaimed = 0;
  let failedRemovals = 0;
  let skippedRemovals = 0;

  for (const file of [...report.deadLegacyStores, ...report.staleLeases]) {
    if (file.name !== path.basename(file.name)) {
      failedRemovals += 1;
      continue;
    }

    const target = path.join(directory, file.name);
    // The modal described one exact object. A lease refreshed or recreated while
    // the modal was open is a different file that merely inherited the basename,
    // so re-read identity and decline on divergence.
    let current: Stats;
    try {
      current = await lstat(target);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failedRemovals += 1;
      continue;
    }
    if (!current.isFile() || current.size !== file.bytes || current.mtimeMs !== file.modifiedAtMs) {
      skippedRemovals += 1;
      continue;
    }

    try {
      await rm(target);
      removed.push(file);
      bytesReclaimed += file.bytes;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failedRemovals += 1;
    }
  }

  return { removed, bytesReclaimed, failedRemovals, skippedRemovals };
}
