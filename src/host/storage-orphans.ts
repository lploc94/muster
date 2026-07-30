import { readdir, stat } from 'node:fs/promises';
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

const LIVE_STORAGE_FILES = new Set([
  'muster.sqlite3',
  'muster.sqlite3-wal',
  'muster.sqlite3-shm',
]);
const LEGACY_STORE_FILE = '.muster-tasks.json';
const LEASE_PREFIX = '.lease.turn%3A';

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
    const file = { name: entry.name, bytes: entry.bytes };
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
