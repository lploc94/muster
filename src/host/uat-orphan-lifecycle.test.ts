import { describe, expect, it } from 'vitest';
import {
  observeOrphanLifecycle,
  verifyOrphanCleanup,
} from './uat-orphan-lifecycle';

const initialReport = {
  live: [
    { name: 'muster.sqlite3', bytes: 100 },
    { name: 'muster.sqlite3-wal', bytes: 20 },
    { name: 'muster.sqlite3-shm', bytes: 10 },
  ],
  deadLegacyStores: [{ name: '.muster-tasks.json', bytes: 40 }],
  activeLeases: [{ name: '.lease.turn%3Alive', bytes: 30 }],
  staleLeases: [{ name: '.lease.turn%3Aexpired', bytes: 50 }],
};

describe('live UAT orphan lifecycle observations', () => {
  it('reports classifier counts, bytes, and live-file survival facts without paths or identifiers', () => {
    const observation = observeOrphanLifecycle(initialReport);

    expect(observation).toEqual({
      deadLegacyStores: { count: 1, bytes: 40 },
      staleLeases: { count: 1, bytes: 50 },
      removable: { count: 2, bytes: 90 },
      liveFiles: {
        sqlite: true,
        wal: true,
        shm: true,
        activeLeaseCount: 1,
      },
    });
    expect(JSON.stringify(observation)).not.toMatch(/[\\/]|muster-tasks|lease\.turn/i);
  });

  it('accepts exact removal totals only when post-cleanup classifications are empty and live files survive', () => {
    expect(verifyOrphanCleanup(initialReport, {
      kind: 'success', removedFiles: 2, bytesReclaimed: 90, failedRemovals: 0,
    }, {
      live: initialReport.live,
      deadLegacyStores: [],
      activeLeases: initialReport.activeLeases,
      staleLeases: [],
    })).toEqual({
      removedFiles: 2,
      bytesReclaimed: 90,
      failedRemovals: 0,
      postCleanup: {
        deadLegacyStores: { count: 0, bytes: 0 },
        staleLeases: { count: 0, bytes: 0 },
        removable: { count: 0, bytes: 0 },
        liveFiles: { sqlite: true, wal: true, shm: true, activeLeaseCount: 1 },
      },
    });
  });

  it('fails closed when a production reclaim command cancels, partially removes, or leaves protected files absent', () => {
    expect(() => verifyOrphanCleanup(initialReport, { kind: 'cancel' }, initialReport))
      .toThrow('orphan reclamation did not succeed');
    expect(() => verifyOrphanCleanup(initialReport, {
      kind: 'success', removedFiles: 1, bytesReclaimed: 40, failedRemovals: 1,
    }, initialReport)).toThrow('orphan reclamation totals differ from classification');
    expect(() => verifyOrphanCleanup(initialReport, {
      kind: 'success', removedFiles: 2, bytesReclaimed: 90, failedRemovals: 0,
    }, {
      ...initialReport,
      deadLegacyStores: [],
      staleLeases: [],
      live: initialReport.live.filter((file) => file.name !== 'muster.sqlite3-wal'),
    })).toThrow('live SQLite trio or active lease missing after orphan cleanup');
  });
});
