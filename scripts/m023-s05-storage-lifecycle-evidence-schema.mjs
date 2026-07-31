/**
 * Pure M023/S05 live storage lifecycle evidence validator.
 * No I/O: safe for unit tests and the tracked-evidence verifier.
 */

const ROOT_KEYS = new Set([
  'ok',
  'kind',
  'schemaVersion',
  'before',
  'afterSeed',
  'afterRetention',
  'peerAfterRetention',
  'contentSafety',
  'generatedAt',
]);
const STATE_KEYS = new Set(['storage', 'retention', 'durableRows', 'retentionTruncatedEntries']);
const STORAGE_KEYS = new Set([
  'fileBytes',
  'walBytes',
  'shmBytes',
  'pageCount',
  'freelistCount',
  'pageSize',
  'autoVacuum',
  'tableBytesSource',
  'tables',
]);
const RETENTION_KEYS = new Set(['completedPasses', 'failedPasses', 'latestPassOrdinal']);
const ROW_KEYS = new Set(['tasks', 'turns', 'messages', 'operations']);
const TABLE_KEYS = new Set(['name', 'bytes']);
const CONTENT_SAFETY_KEYS = [
  'absolutePathsStoredInEvidence',
  'messageBodiesStoredInEvidence',
  'sessionIdsStoredInEvidence',
  'canaryStoredInEvidence',
];
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SAFE_TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_BYTES = 2_000_000_000;
const MAX_COUNT = 1_000_000;
const SENSITIVE = /CANARY_|\/Users\/|\/home\/|\/private\/tmp\/|\/var\/folders\/|\/tmp\/[A-Za-z0-9._-]+|[A-Za-z]:\\|\bfile:\/\/|\\?"(?:workspaceId|sessionId|taskId|messageBody|prompt)\\?"\s*:|\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\b|\bDELETE\s+FROM\b|stackTrace|\bError:\s|\bat\s+(?:async\s+)?[\w.<>$[\]]+\(/i;

function unknownKeys(object, allowed, label, failures) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) failures.push(`${label} unknown key: ${key}`);
  }
}

function nonNegativeInteger(value, label, failures, max = MAX_COUNT) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    failures.push(`${label} must be a safe integer in [0, ${max}]`);
  }
}

function validateStorage(storage, label) {
  const failures = [];
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return [`${label} must be an object`];
  unknownKeys(storage, STORAGE_KEYS, label, failures);
  for (const key of ['fileBytes', 'walBytes', 'shmBytes', 'pageCount', 'freelistCount', 'pageSize', 'autoVacuum', 'tableBytesSource', 'tables']) {
    if (!(key in storage)) failures.push(`${label} missing ${key}`);
  }
  for (const key of ['fileBytes', 'walBytes', 'shmBytes']) nonNegativeInteger(storage[key], `${label}.${key}`, failures, MAX_BYTES);
  for (const key of ['pageCount', 'freelistCount', 'pageSize', 'autoVacuum']) nonNegativeInteger(storage[key], `${label}.${key}`, failures);
  if (storage.pageSize !== 4096) failures.push(`${label}.pageSize must be 4096`);
  if (![0, 1, 2].includes(storage.autoVacuum)) failures.push(`${label}.autoVacuum must be 0, 1, or 2`);
  if (storage.tableBytesSource !== 'dbstat' && storage.tableBytesSource !== 'estimated') {
    failures.push(`${label}.tableBytesSource must be dbstat or estimated`);
  }
  if (storage.tables !== undefined) {
    if (!Array.isArray(storage.tables) || storage.tables.length > 4096) {
      failures.push(`${label}.tables must be a bounded array when present`);
    } else {
      for (const [index, table] of storage.tables.entries()) {
        if (!table || typeof table !== 'object' || Array.isArray(table)) {
          failures.push(`${label}.tables[${index}] must be an object`);
          continue;
        }
        unknownKeys(table, TABLE_KEYS, `${label}.tables[${index}]`, failures);
        if (typeof table.name !== 'string' || !SAFE_TABLE_NAME.test(table.name)) {
          failures.push(`${label}.tables[${index}].name must be a safe table token`);
        }
        nonNegativeInteger(table.bytes, `${label}.tables[${index}].bytes`, failures, MAX_BYTES);
      }
    }
  }
  return failures;
}

function validateState(state, label) {
  const failures = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [`${label} must be an object`];
  unknownKeys(state, STATE_KEYS, label, failures);
  for (const key of STATE_KEYS) if (!(key in state)) failures.push(`${label} missing ${key}`);
  failures.push(...validateStorage(state.storage, `${label}.storage`));
  if (!state.retention || typeof state.retention !== 'object' || Array.isArray(state.retention)) {
    failures.push(`${label}.retention must be an object`);
  } else {
    unknownKeys(state.retention, RETENTION_KEYS, `${label}.retention`, failures);
    for (const key of RETENTION_KEYS) nonNegativeInteger(state.retention[key], `${label}.retention.${key}`, failures);
  }
  if (!state.durableRows || typeof state.durableRows !== 'object' || Array.isArray(state.durableRows)) {
    failures.push(`${label}.durableRows must be an object`);
  } else {
    unknownKeys(state.durableRows, ROW_KEYS, `${label}.durableRows`, failures);
    for (const key of ROW_KEYS) nonNegativeInteger(state.durableRows[key], `${label}.durableRows.${key}`, failures);
  }
  nonNegativeInteger(state.retentionTruncatedEntries, `${label}.retentionTruncatedEntries`, failures);
  return failures;
}

/**
 * Validates only the numeric/enum storage lifecycle evidence shape and invariant claims.
 * @param {unknown} evidence
 * @param {{ requirePass?: boolean }} [opts]
 * @returns {string[]}
 */
export function validateStorageLifecycleEvidence(evidence, opts = {}) {
  const failures = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return ['evidence must be an object'];
  unknownKeys(evidence, ROOT_KEYS, 'root', failures);
  if (evidence.kind !== 'm023-s05-storage-lifecycle-live-uat') failures.push('kind must be m023-s05-storage-lifecycle-live-uat');
  if (evidence.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (evidence.ok !== true) failures.push('ok must be true');
  if (opts.requirePass && evidence.ok !== true) failures.push('requirePass: ok must be true');
  for (const label of ['before', 'afterSeed', 'afterRetention', 'peerAfterRetention']) {
    failures.push(...validateState(evidence[label], label));
  }
  const before = evidence.before;
  const seeded = evidence.afterSeed;
  const retained = evidence.afterRetention;
  const peer = evidence.peerAfterRetention;
  if (Number.isSafeInteger(before?.storage?.fileBytes) && Number.isSafeInteger(seeded?.storage?.fileBytes) && seeded.storage.fileBytes <= before.storage.fileBytes) {
    failures.push('afterSeed.storage.fileBytes must strictly exceed before.storage.fileBytes');
  }
  if (Number.isSafeInteger(seeded?.storage?.fileBytes) && Number.isSafeInteger(retained?.storage?.fileBytes) && retained.storage.fileBytes >= seeded.storage.fileBytes) {
    failures.push('afterRetention.storage.fileBytes must be strictly below afterSeed.storage.fileBytes');
  }
  if (Number.isSafeInteger(retained?.retention?.completedPasses) && retained.retention.completedPasses < 2) {
    failures.push('afterRetention.retention.completedPasses must be at least 2');
  }
  if (Number.isSafeInteger(retained?.retention?.latestPassOrdinal) && retained.retention.latestPassOrdinal < 2) {
    failures.push('afterRetention.retention.latestPassOrdinal must be at least 2');
  }
  if (retained?.retention?.failedPasses !== 0) failures.push('afterRetention.retention.failedPasses must be 0');
  if (retained?.retentionTruncatedEntries !== 4) failures.push('afterRetention.retentionTruncatedEntries must be 4');
  for (const rows of ROW_KEYS) {
    if (Number.isSafeInteger(before?.durableRows?.[rows]) && Number.isSafeInteger(retained?.durableRows?.[rows]) && before.durableRows[rows] !== retained.durableRows[rows]) {
      failures.push(`durableRows.${rows} must be unchanged before to afterRetention`);
    }
  }
  if (Number.isSafeInteger(retained?.storage?.fileBytes) && Number.isSafeInteger(peer?.storage?.fileBytes) && peer.storage.fileBytes !== retained.storage.fileBytes) {
    failures.push('peerAfterRetention.storage.fileBytes must equal afterRetention.storage.fileBytes');
  }
  const safety = evidence.contentSafety;
  if (!safety || typeof safety !== 'object' || Array.isArray(safety)) {
    failures.push('contentSafety required');
  } else {
    unknownKeys(safety, new Set(CONTENT_SAFETY_KEYS), 'contentSafety', failures);
    for (const key of CONTENT_SAFETY_KEYS) if (safety[key] !== false) failures.push(`contentSafety.${key} must be false`);
  }
  if (typeof evidence.generatedAt !== 'string' || !ISO_TS.test(evidence.generatedAt)) failures.push('generatedAt must be ISO UTC');
  if (SENSITIVE.test(JSON.stringify(evidence))) failures.push('evidence contains sensitive content');
  return failures;
}
