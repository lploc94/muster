import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOrphanLifecycleEvidence } from './m023-s08-orphan-lifecycle-evidence-schema.mjs';

function storage(fileBytes) {
  return {
    fileBytes,
    walBytes: 0,
    shmBytes: 32768,
    pageCount: Math.ceil(fileBytes / 4096),
    freelistCount: 0,
    pageSize: 4096,
    autoVacuum: 2,
    tableBytesSource: 'dbstat',
    tables: [{ name: 'operations', bytes: fileBytes }],
  };
}

function state(fileBytes, completedPasses = 2) {
  return {
    storage: storage(fileBytes),
    retention: { completedPasses, failedPasses: 0, latestPassOrdinal: completedPasses },
    durableRows: { tasks: 2, turns: 4, messages: 0, operations: 4 },
    retentionTruncatedEntries: completedPasses >= 2 ? 4 : 0,
  };
}

function classification(deadLegacyStores, staleLeases) {
  const removable = {
    count: deadLegacyStores.count + staleLeases.count,
    bytes: deadLegacyStores.bytes + staleLeases.bytes,
  };
  return {
    deadLegacyStores,
    staleLeases,
    removable,
    liveFiles: { sqlite: true, wal: true, shm: true, activeLeaseCount: 1 },
  };
}

function completeEvidence() {
  const afterRetention = state(1000);
  return {
    ok: true,
    kind: 'm023-s08-orphan-lifecycle-live-uat',
    schemaVersion: 1,
    before: state(900, 0),
    afterSeed: state(2000, 0),
    afterRetention,
    peerAfterRetention: afterRetention,
    orphanBeforeCleanup: classification({ count: 1, bytes: 400 }, { count: 1, bytes: 600 }),
    orphanCleanup: { removedFiles: 2, bytesReclaimed: 1000, failedRemovals: 0 },
    afterOrphanCleanup: {
      state: state(1000),
      classification: classification({ count: 0, bytes: 0 }, { count: 0, bytes: 0 }),
    },
    peerAfterOrphanCleanup: state(1000),
    contentSafety: {
      absolutePathsStoredInEvidence: false,
      messageBodiesStoredInEvidence: false,
      sessionIdsStoredInEvidence: false,
      canaryStoredInEvidence: false,
    },
    generatedAt: '2026-08-01T12:00:00.000Z',
  };
}

test('accepts a complete numeric-only orphan lifecycle observation', () => {
  assert.deepEqual(validateOrphanLifecycleEvidence(completeEvidence(), { requirePass: true }), []);
});

test('rejects vacuous or mismatched orphan cleanup facts', () => {
  {
    const evidence = completeEvidence();
    evidence.orphanBeforeCleanup = classification({ count: 0, bytes: 0 }, { count: 0, bytes: 0 });
    evidence.orphanCleanup = { removedFiles: 0, bytesReclaimed: 0, failedRemovals: 0 };
    assert.ok(validateOrphanLifecycleEvidence(evidence).some((failure) => /non-empty orphan reclamation/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.orphanCleanup.bytesReclaimed--;
    assert.ok(validateOrphanLifecycleEvidence(evidence).some((failure) => /totals must exactly equal/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.afterOrphanCleanup.classification.liveFiles.wal = false;
    assert.ok(validateOrphanLifecycleEvidence(evidence).some((failure) => /SQLite trio and active lease survival/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.afterOrphanCleanup.classification.staleLeases.count = 1;
    evidence.afterOrphanCleanup.classification.removable.count = 1;
    assert.ok(validateOrphanLifecycleEvidence(evidence).some((failure) => /no removable orphans/.test(failure)));
  }
});

test('rejects unknown, non-numeric, and privacy-bearing evidence', () => {
  {
    const evidence = completeEvidence();
    evidence.extra = true;
    assert.ok(validateOrphanLifecycleEvidence(evidence).some((failure) => /root unknown key: extra/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.orphanCleanup.removedFiles = 1.5;
    assert.ok(validateOrphanLifecycleEvidence(evidence).some((failure) => /removedFiles must be a safe integer/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.afterOrphanCleanup.classification.path = 'C:\\Users\\secret\\muster.sqlite3';
    assert.ok(validateOrphanLifecycleEvidence(evidence).some((failure) => /unknown key: path|sensitive/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.contentSafety.messageBodiesStoredInEvidence = true;
    assert.ok(validateOrphanLifecycleEvidence(evidence).some((failure) => /messageBodiesStoredInEvidence must be false/.test(failure)));
  }
});
