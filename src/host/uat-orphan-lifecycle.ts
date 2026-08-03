import type { ReclaimOrphanedFilesCommandResult } from './sqlite-maintenance-commands';
import type { StorageFile, StorageOrphanReport } from './storage-orphans';

export type OrphanBucketObservation = { count: number; bytes: number };

/** Path-free facts consumed by the live UAT evidence writer. */
export type OrphanLifecycleObservation = {
  deadLegacyStores: OrphanBucketObservation;
  staleLeases: OrphanBucketObservation;
  removable: OrphanBucketObservation;
  liveFiles: {
    sqlite: boolean;
    wal: boolean;
    shm: boolean;
    activeLeaseCount: number;
  };
};

export type VerifiedOrphanCleanup = Pick<
  Extract<ReclaimOrphanedFilesCommandResult, { kind: 'success' }>,
  'removedFiles' | 'bytesReclaimed' | 'failedRemovals' | 'skippedRemovals'
> & { postCleanup: OrphanLifecycleObservation };

function summarize(files: readonly StorageFile[]): OrphanBucketObservation {
  return {
    count: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

/**
 * Reduces classifier output to numeric and boolean facts. Filenames and storage
 * paths intentionally cannot reach the UAT command/evidence surface.
 */
export function observeOrphanLifecycle(report: StorageOrphanReport): OrphanLifecycleObservation {
  const deadLegacyStores = summarize(report.deadLegacyStores);
  const staleLeases = summarize(report.staleLeases);
  const live = new Set(report.live.map((file) => file.name));
  return {
    deadLegacyStores,
    staleLeases,
    removable: {
      count: deadLegacyStores.count + staleLeases.count,
      bytes: deadLegacyStores.bytes + staleLeases.bytes,
    },
    liveFiles: {
      sqlite: live.has('muster.sqlite3'),
      wal: live.has('muster.sqlite3-wal'),
      shm: live.has('muster.sqlite3-shm'),
      activeLeaseCount: report.activeLeases.length,
    },
  };
}

function hasLiveStorageSurvivors(observation: OrphanLifecycleObservation): boolean {
  return observation.liveFiles.sqlite
    && observation.liveFiles.wal
    && observation.liveFiles.shm
    && observation.liveFiles.activeLeaseCount > 0;
}

/**
 * Fails the live UAT runner before it writes evidence if the production reclaim
 * result diverges from the classifier snapshot or protected files did not survive.
 */
export function verifyOrphanCleanup(
  before: StorageOrphanReport,
  result: ReclaimOrphanedFilesCommandResult,
  after: StorageOrphanReport,
): VerifiedOrphanCleanup {
  if (result.kind !== 'success') {
    throw new Error('orphan reclamation did not succeed');
  }

  const expected = observeOrphanLifecycle(before).removable;
  if (
    result.removedFiles !== expected.count
    || result.bytesReclaimed !== expected.bytes
    || result.failedRemovals !== 0
    // A skipped removal means the pinned file changed under the modal. The run
    // proved nothing about the classified set, so it cannot pass as evidence.
    || result.skippedRemovals !== 0
  ) {
    throw new Error('orphan reclamation totals differ from classification');
  }

  const postCleanup = observeOrphanLifecycle(after);
  if (
    postCleanup.removable.count !== 0
    || postCleanup.removable.bytes !== 0
    || !hasLiveStorageSurvivors(postCleanup)
  ) {
    throw new Error('live SQLite trio or active lease missing after orphan cleanup');
  }

  return {
    removedFiles: result.removedFiles,
    bytesReclaimed: result.bytesReclaimed,
    failedRemovals: result.failedRemovals,
    skippedRemovals: result.skippedRemovals,
    postCleanup,
  };
}
