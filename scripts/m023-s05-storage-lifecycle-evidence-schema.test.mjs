import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStorageLifecycleEvidence } from './m023-s05-storage-lifecycle-evidence-schema.mjs';

function report(fileBytes) {
  return {
    fileBytes,
    walBytes: 0,
    shmBytes: 0,
    pageCount: Math.ceil(fileBytes / 4096),
    freelistCount: 0,
    pageSize: 4096,
    autoVacuum: 0,
    tableBytesSource: 'dbstat',
    tables: [
      { name: 'operations', bytes: Math.floor(fileBytes / 2) },
      { name: 'tasks', bytes: Math.ceil(fileBytes / 2) },
    ],
  };
}

function lifecycle(rows = { tasks: 2, turns: 4, messages: 0, operations: 4 }) {
  return {
    storage: report(1000),
    retention: { completedPasses: 2, failedPasses: 0, latestPassOrdinal: 2 },
    durableRows: rows,
    retentionTruncatedEntries: 4,
  };
}

function completeEvidence() {
  const seededRows = { tasks: 3, turns: 5, messages: 0, operations: 8 };
  return {
    ok: true,
    kind: 'm023-s05-storage-lifecycle-live-uat',
    schemaVersion: 1,
    before: lifecycle(),
    afterSeed: { ...lifecycle(seededRows), storage: report(2000) },
    afterRetention: lifecycle(seededRows),
    peerAfterRetention: lifecycle(seededRows),
    contentSafety: {
      absolutePathsStoredInEvidence: false,
      messageBodiesStoredInEvidence: false,
      sessionIdsStoredInEvidence: false,
      canaryStoredInEvidence: false,
    },
    generatedAt: '2026-07-31T12:00:00.000Z',
  };
}

test('accepts a complete numeric-only storage lifecycle observation', () => {
  assert.deepEqual(validateStorageLifecycleEvidence(completeEvidence(), { requirePass: true }), []);
});

test('rejects an S01 storage report that omits tables', () => {
  const evidence = completeEvidence();
  delete evidence.afterSeed.storage.tables;
  assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /afterSeed\.storage missing tables/.test(failure)));
});

test('rejects lifecycle evidence that misses its byte, pass, row, or peer invariants', () => {
  {
    const evidence = completeEvidence();
    evidence.afterSeed.storage.fileBytes = evidence.before.storage.fileBytes;
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /afterSeed\.storage\.fileBytes/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.afterRetention.storage.fileBytes = evidence.afterSeed.storage.fileBytes;
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /afterRetention\.storage\.fileBytes/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.afterRetention.retention.completedPasses = 1;
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /completedPasses/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.afterRetention.durableRows = {
      ...evidence.afterRetention.durableRows,
      turns: evidence.afterRetention.durableRows.turns + 1,
    };
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /durableRows\.turns/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.peerAfterRetention.storage.fileBytes++;
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /peerAfterRetention\.storage\.fileBytes/.test(failure)));
  }
});

test('rejects unknown, non-numeric, path-bearing, and message-bearing evidence', () => {
  {
    const evidence = completeEvidence();
    evidence.extra = true;
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /root unknown key: extra/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.before.storage.fileBytes = 1.5;
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /fileBytes must be a safe integer/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.before.storage.path = '/Users/secret/muster.sqlite3';
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /unknown key: path|sensitive/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.afterRetention.messageBody = 'secret';
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /unknown key: messageBody|sensitive/.test(failure)));
  }
  {
    const evidence = completeEvidence();
    evidence.contentSafety.canaryStoredInEvidence = true;
    assert.ok(validateStorageLifecycleEvidence(evidence).some((failure) => /canaryStoredInEvidence must be false/.test(failure)));
  }
});
