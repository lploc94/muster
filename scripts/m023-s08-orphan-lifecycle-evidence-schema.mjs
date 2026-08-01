/**
 * Pure M023/S08 live orphan lifecycle evidence validator.
 * No I/O: safe for fixture tests and the later tracked-evidence verifier.
 */

const ROOT_KEYS = new Set([
  'ok', 'kind', 'schemaVersion', 'before', 'afterSeed', 'afterRetention',
  'peerAfterRetention', 'orphanBeforeCleanup', 'orphanCleanup',
  'afterOrphanCleanup', 'peerAfterOrphanCleanup', 'contentSafety', 'generatedAt',
]);
const STATE_KEYS = new Set(['storage', 'retention', 'durableRows', 'retentionTruncatedEntries']);
const STORAGE_KEYS = new Set(['fileBytes', 'walBytes', 'shmBytes', 'pageCount', 'freelistCount', 'pageSize', 'autoVacuum', 'tableBytesSource', 'tables']);
const RETENTION_KEYS = new Set(['completedPasses', 'failedPasses', 'latestPassOrdinal']);
const ROW_KEYS = new Set(['tasks', 'turns', 'messages', 'operations']);
const TABLE_KEYS = new Set(['name', 'bytes']);
const CLASSIFICATION_KEYS = new Set(['deadLegacyStores', 'staleLeases', 'removable', 'liveFiles']);
const BUCKET_KEYS = new Set(['count', 'bytes']);
const LIVE_FILES_KEYS = new Set(['sqlite', 'wal', 'shm', 'activeLeaseCount']);
const CLEANUP_KEYS = new Set(['removedFiles', 'bytesReclaimed', 'failedRemovals']);
const AFTER_CLEANUP_KEYS = new Set(['state', 'classification']);
const CONTENT_SAFETY_KEYS = ['absolutePathsStoredInEvidence', 'messageBodiesStoredInEvidence', 'sessionIdsStoredInEvidence', 'canaryStoredInEvidence'];
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SAFE_TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_BYTES = 2_000_000_000;
const MAX_COUNT = 1_000_000;
const SENSITIVE = /CANARY_|\/Users\/|\/home\/|\/private\/tmp\/|\/var\/folders\/|\/tmp\/[A-Za-z0-9._-]+|[A-Za-z]:\\|\bfile:\/\/|\\?"(?:workspaceId|sessionId|taskId|messageBody|prompt)\\?"\s*:|\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\b|\bDELETE\s+FROM\b|stackTrace|\bError:\s|\bat\s+(?:async\s+)?[\w.<>$[\]]+\(/i;

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function unknownKeys(object, allowed, label, failures) { for (const key of Object.keys(object)) if (!allowed.has(key)) failures.push(`${label} unknown key: ${key}`); }
function requiredKeys(object, allowed, label, failures) { for (const key of allowed) if (!(key in object)) failures.push(`${label} missing ${key}`); }
function nonNegativeInteger(value, label, failures, max = MAX_COUNT) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) failures.push(`${label} must be a safe integer in [0, ${max}]`);
}

function validateStorage(storage, label) {
  const failures = [];
  if (!isObject(storage)) return [`${label} must be an object`];
  unknownKeys(storage, STORAGE_KEYS, label, failures); requiredKeys(storage, STORAGE_KEYS, label, failures);
  for (const key of ['fileBytes', 'walBytes', 'shmBytes']) nonNegativeInteger(storage[key], `${label}.${key}`, failures, MAX_BYTES);
  for (const key of ['pageCount', 'freelistCount', 'pageSize', 'autoVacuum']) nonNegativeInteger(storage[key], `${label}.${key}`, failures);
  if (storage.pageSize !== 4096) failures.push(`${label}.pageSize must be 4096`);
  if (![0, 1, 2].includes(storage.autoVacuum)) failures.push(`${label}.autoVacuum must be 0, 1, or 2`);
  if (!['dbstat', 'estimated'].includes(storage.tableBytesSource)) failures.push(`${label}.tableBytesSource must be dbstat or estimated`);
  if (!Array.isArray(storage.tables) || storage.tables.length > 4096) failures.push(`${label}.tables must be a bounded array`);
  else for (const [index, table] of storage.tables.entries()) {
    if (!isObject(table)) { failures.push(`${label}.tables[${index}] must be an object`); continue; }
    unknownKeys(table, TABLE_KEYS, `${label}.tables[${index}]`, failures); requiredKeys(table, TABLE_KEYS, `${label}.tables[${index}]`, failures);
    if (typeof table.name !== 'string' || !SAFE_TABLE_NAME.test(table.name)) failures.push(`${label}.tables[${index}].name must be a safe table token`);
    nonNegativeInteger(table.bytes, `${label}.tables[${index}].bytes`, failures, MAX_BYTES);
  }
  return failures;
}

function validateState(state, label) {
  const failures = [];
  if (!isObject(state)) return [`${label} must be an object`];
  unknownKeys(state, STATE_KEYS, label, failures); requiredKeys(state, STATE_KEYS, label, failures);
  failures.push(...validateStorage(state.storage, `${label}.storage`));
  for (const [key, allowed] of [['retention', RETENTION_KEYS], ['durableRows', ROW_KEYS]]) {
    if (!isObject(state[key])) failures.push(`${label}.${key} must be an object`);
    else { unknownKeys(state[key], allowed, `${label}.${key}`, failures); requiredKeys(state[key], allowed, `${label}.${key}`, failures); for (const field of allowed) nonNegativeInteger(state[key][field], `${label}.${key}.${field}`, failures); }
  }
  nonNegativeInteger(state.retentionTruncatedEntries, `${label}.retentionTruncatedEntries`, failures);
  return failures;
}

function validateBucket(bucket, label) {
  const failures = [];
  if (!isObject(bucket)) return [`${label} must be an object`];
  unknownKeys(bucket, BUCKET_KEYS, label, failures); requiredKeys(bucket, BUCKET_KEYS, label, failures);
  nonNegativeInteger(bucket.count, `${label}.count`, failures); nonNegativeInteger(bucket.bytes, `${label}.bytes`, failures, MAX_BYTES);
  return failures;
}

function validateClassification(classification, label) {
  const failures = [];
  if (!isObject(classification)) return [`${label} must be an object`];
  unknownKeys(classification, CLASSIFICATION_KEYS, label, failures); requiredKeys(classification, CLASSIFICATION_KEYS, label, failures);
  for (const key of ['deadLegacyStores', 'staleLeases', 'removable']) failures.push(...validateBucket(classification[key], `${label}.${key}`));
  if (!isObject(classification.liveFiles)) failures.push(`${label}.liveFiles must be an object`);
  else {
    unknownKeys(classification.liveFiles, LIVE_FILES_KEYS, `${label}.liveFiles`, failures); requiredKeys(classification.liveFiles, LIVE_FILES_KEYS, `${label}.liveFiles`, failures);
    for (const key of ['sqlite', 'wal', 'shm']) if (typeof classification.liveFiles[key] !== 'boolean') failures.push(`${label}.liveFiles.${key} must be boolean`);
    nonNegativeInteger(classification.liveFiles.activeLeaseCount, `${label}.liveFiles.activeLeaseCount`, failures);
  }
  return failures;
}

/** Validates numeric/enum-only M023/S08 lifecycle observations and anti-vacuity invariants. */
export function validateOrphanLifecycleEvidence(evidence, opts = {}) {
  const failures = [];
  if (!isObject(evidence)) return ['evidence must be an object'];
  unknownKeys(evidence, ROOT_KEYS, 'root', failures); requiredKeys(evidence, ROOT_KEYS, 'root', failures);
  if (evidence.kind !== 'm023-s08-orphan-lifecycle-live-uat') failures.push('kind must be m023-s08-orphan-lifecycle-live-uat');
  if (evidence.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (evidence.ok !== true) failures.push('ok must be true');
  if (opts.requirePass && evidence.ok !== true) failures.push('requirePass: ok must be true');
  for (const label of ['before', 'afterSeed', 'afterRetention', 'peerAfterRetention', 'peerAfterOrphanCleanup']) failures.push(...validateState(evidence[label], label));
  failures.push(...validateClassification(evidence.orphanBeforeCleanup, 'orphanBeforeCleanup'));
  if (!isObject(evidence.orphanCleanup)) failures.push('orphanCleanup must be an object');
  else { unknownKeys(evidence.orphanCleanup, CLEANUP_KEYS, 'orphanCleanup', failures); requiredKeys(evidence.orphanCleanup, CLEANUP_KEYS, 'orphanCleanup', failures); for (const key of CLEANUP_KEYS) nonNegativeInteger(evidence.orphanCleanup[key], `orphanCleanup.${key}`, failures, MAX_BYTES); }
  if (!isObject(evidence.afterOrphanCleanup)) failures.push('afterOrphanCleanup must be an object');
  else { unknownKeys(evidence.afterOrphanCleanup, AFTER_CLEANUP_KEYS, 'afterOrphanCleanup', failures); requiredKeys(evidence.afterOrphanCleanup, AFTER_CLEANUP_KEYS, 'afterOrphanCleanup', failures); failures.push(...validateState(evidence.afterOrphanCleanup.state, 'afterOrphanCleanup.state')); failures.push(...validateClassification(evidence.afterOrphanCleanup.classification, 'afterOrphanCleanup.classification')); }

  const { before, afterSeed: seeded, afterRetention: retained, peerAfterRetention: peer, orphanBeforeCleanup: classified, orphanCleanup: cleanup, afterOrphanCleanup: after, peerAfterOrphanCleanup: peerAfter } = evidence;
  if (Number.isSafeInteger(before?.storage?.fileBytes) && Number.isSafeInteger(seeded?.storage?.fileBytes) && seeded.storage.fileBytes <= before.storage.fileBytes) failures.push('afterSeed.storage.fileBytes must strictly exceed before.storage.fileBytes');
  if (Number.isSafeInteger(seeded?.storage?.fileBytes) && Number.isSafeInteger(retained?.storage?.fileBytes) && retained.storage.fileBytes >= seeded.storage.fileBytes) failures.push('afterRetention.storage.fileBytes must be strictly below afterSeed.storage.fileBytes');
  if (retained?.retention?.completedPasses < 2 || retained?.retention?.latestPassOrdinal < 2 || retained?.retention?.failedPasses !== 0 || retained?.retentionTruncatedEntries !== 4) failures.push('afterRetention must record two successful retention passes and four truncated entries');
  for (const key of ROW_KEYS) if (Number.isSafeInteger(seeded?.durableRows?.[key]) && Number.isSafeInteger(retained?.durableRows?.[key]) && seeded.durableRows[key] !== retained.durableRows[key]) failures.push(`durableRows.${key} must be unchanged afterSeed to afterRetention`);
  if (Number.isSafeInteger(retained?.storage?.fileBytes) && retained.storage.fileBytes !== peer?.storage?.fileBytes) failures.push('peerAfterRetention.storage.fileBytes must equal afterRetention.storage.fileBytes');
  if (classified?.removable?.count < 1 || classified?.removable?.bytes < 1) failures.push('orphanBeforeCleanup.removable must prove non-empty orphan reclamation');
  if (classified?.removable?.count !== (classified?.deadLegacyStores?.count ?? NaN) + (classified?.staleLeases?.count ?? NaN) || classified?.removable?.bytes !== (classified?.deadLegacyStores?.bytes ?? NaN) + (classified?.staleLeases?.bytes ?? NaN)) failures.push('orphanBeforeCleanup.removable must equal classified bucket totals');
  if (cleanup?.removedFiles !== classified?.removable?.count || cleanup?.bytesReclaimed !== classified?.removable?.bytes || cleanup?.failedRemovals !== 0) failures.push('orphanCleanup totals must exactly equal classified removables with no failed removals');
  if (after?.classification?.removable?.count !== 0 || after?.classification?.removable?.bytes !== 0 || after?.classification?.deadLegacyStores?.count !== 0 || after?.classification?.staleLeases?.count !== 0) failures.push('afterOrphanCleanup classification must contain no removable orphans');
  const live = after?.classification?.liveFiles;
  if (live?.sqlite !== true || live?.wal !== true || live?.shm !== true || live?.activeLeaseCount < 1) failures.push('afterOrphanCleanup must prove SQLite trio and active lease survival');
  if (after?.state?.storage?.fileBytes !== peerAfter?.storage?.fileBytes) failures.push('peerAfterOrphanCleanup.storage.fileBytes must equal afterOrphanCleanup.state.storage.fileBytes');
  const safety = evidence.contentSafety;
  if (!isObject(safety)) failures.push('contentSafety required');
  else { unknownKeys(safety, new Set(CONTENT_SAFETY_KEYS), 'contentSafety', failures); requiredKeys(safety, new Set(CONTENT_SAFETY_KEYS), 'contentSafety', failures); for (const key of CONTENT_SAFETY_KEYS) if (safety[key] !== false) failures.push(`contentSafety.${key} must be false`); }
  if (typeof evidence.generatedAt !== 'string' || !ISO_TS.test(evidence.generatedAt)) failures.push('generatedAt must be ISO UTC');
  if (SENSITIVE.test(JSON.stringify(evidence))) failures.push('evidence contains sensitive content');
  return failures;
}
