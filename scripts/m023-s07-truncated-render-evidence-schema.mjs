/**
 * Pure M023/S07 truncated-render live-host evidence validator.
 * No I/O: safe for fixture tests and the later tracked-evidence verifier.
 */

const ROOT_KEYS = new Set([
  'ok',
  'kind',
  'schemaVersion',
  'verdict',
  'provenance',
  'observation',
  'contentSafety',
  'blockedReason',
  'generatedAt',
]);
const PROVENANCE_KEYS = new Set(['vscodeVersion', 'hostMode', 'probeSource']);
const OBSERVATION_KEYS = new Set(['fileChangeGroups', 'files']);
const GROUP_KEYS = new Set(['fileRowCount']);
const FILE_KEYS = new Set([
  'retentionTruncated',
  'pathText',
  'countsLabel',
  'hasStaticSummary',
  'hasDiffBody',
]);
const CONTENT_SAFETY_KEYS = [
  'absolutePathsStoredInEvidence',
  'messageBodiesStoredInEvidence',
  'sessionIdsStoredInEvidence',
  'canaryStoredInEvidence',
];
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const VSCODE_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const SENSITIVE = /CANARY_|\/Users\/|\/home\/|\/private\/tmp\/|\/var\/folders\/|\/tmp\/[A-Za-z0-9._-]+|[A-Za-z]:\\|\bfile:\/\/|\\?"(?:workspaceId|sessionId|taskId|messageBody|prompt)\\?"\s*:|\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\b|\bDELETE\s+FROM\b|stackTrace|\bError:\s|\bat\s+(?:async\s+)?[\w.<>$[\]]+\(/i;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(object, allowed, label, failures) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) failures.push(`${label} unknown key: ${key}`);
  }
}

function validatePassProvenance(provenance) {
  const failures = [];
  if (!isObject(provenance)) return ['provenance required for PASS'];
  unknownKeys(provenance, PROVENANCE_KEYS, 'provenance', failures);
  if (typeof provenance.vscodeVersion !== 'string' || !VSCODE_VERSION.test(provenance.vscodeVersion)) {
    failures.push('provenance.vscodeVersion must be a VS Code version');
  }
  if (provenance.hostMode !== 'extension-development-host') {
    failures.push('provenance.hostMode must be extension-development-host');
  }
  if (provenance.probeSource !== 'live-extension-host-dom') {
    failures.push('provenance.probeSource must be live-extension-host-dom');
  }
  return failures;
}

function validatePassObservation(observation) {
  const failures = [];
  if (!isObject(observation)) return ['observation required for PASS'];
  unknownKeys(observation, OBSERVATION_KEYS, 'observation', failures);
  if (!Array.isArray(observation.fileChangeGroups) || observation.fileChangeGroups.length === 0) {
    failures.push('observation.fileChangeGroups must be a non-empty array');
  } else {
    for (const [index, group] of observation.fileChangeGroups.entries()) {
      if (!isObject(group)) {
        failures.push(`observation.fileChangeGroups[${index}] must be an object`);
        continue;
      }
      unknownKeys(group, GROUP_KEYS, `observation.fileChangeGroups[${index}]`, failures);
      if (!Number.isSafeInteger(group.fileRowCount) || group.fileRowCount < 1) {
        failures.push(`observation.fileChangeGroups[${index}].fileRowCount must be a positive integer`);
      }
    }
  }

  if (!Array.isArray(observation.files) || observation.files.length === 0) {
    failures.push('observation.files must be a non-empty array');
    return failures;
  }

  let truncatedCount = 0;
  let liveDiffCount = 0;
  for (const [index, file] of observation.files.entries()) {
    if (!isObject(file)) {
      failures.push(`observation.files[${index}] must be an object`);
      continue;
    }
    unknownKeys(file, FILE_KEYS, `observation.files[${index}]`, failures);
    for (const key of FILE_KEYS) {
      if (!(key in file)) failures.push(`observation.files[${index}] missing ${key}`);
    }
    if (typeof file.retentionTruncated !== 'boolean') {
      failures.push(`observation.files[${index}].retentionTruncated must be boolean`);
    }
    if (typeof file.pathText !== 'string' || !file.pathText.trim()) {
      failures.push(`observation.files[${index}].pathText must be non-empty`);
    }
    if (typeof file.countsLabel !== 'string' || !file.countsLabel.trim()) {
      failures.push(`observation.files[${index}].countsLabel must be non-empty`);
    }
    if (typeof file.hasStaticSummary !== 'boolean' || typeof file.hasDiffBody !== 'boolean') {
      failures.push(`observation.files[${index}] summary and diff flags must be boolean`);
    }
    if (file.retentionTruncated === true) {
      truncatedCount++;
      if (!/retention summary/i.test(file.countsLabel ?? '')) {
        failures.push(`observation.files[${index}].countsLabel must mark a retention summary`);
      }
      if (file.hasStaticSummary !== true) {
        failures.push(`observation.files[${index}].hasStaticSummary must be true for retention truncation`);
      }
      if (file.hasDiffBody !== false) {
        failures.push(`observation.files[${index}].hasDiffBody must be false for retention truncation`);
      }
    } else if (file.hasDiffBody === true) {
      liveDiffCount++;
    }
  }
  if (truncatedCount === 0) failures.push('observation must include a retention-truncated file');
  if (liveDiffCount === 0) failures.push('observation must include an untruncated file with a diff body');
  return failures;
}

function validateContentSafety(contentSafety) {
  const failures = [];
  if (!isObject(contentSafety)) return ['contentSafety required for PASS'];
  unknownKeys(contentSafety, new Set(CONTENT_SAFETY_KEYS), 'contentSafety', failures);
  for (const key of CONTENT_SAFETY_KEYS) {
    if (contentSafety[key] !== false) failures.push(`contentSafety.${key} must be false`);
  }
  return failures;
}

/**
 * Validates an M023/S07 ledger entry. PASS is reserved for a real Electron
 * Extension Development Host DOM observation; blocked runs retain only a
 * bounded explanation and cannot be promoted to proof by requirePass.
 * @param {unknown} evidence
 * @param {{ requirePass?: boolean }} [opts]
 * @returns {string[]}
 */
export function validateTruncatedRenderEvidence(evidence, opts = {}) {
  const failures = [];
  if (!isObject(evidence)) return ['evidence must be an object'];
  unknownKeys(evidence, ROOT_KEYS, 'root', failures);
  if (evidence.kind !== 'm023-s07-truncated-render-live-uat') {
    failures.push('kind must be m023-s07-truncated-render-live-uat');
  }
  if (evidence.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (typeof evidence.generatedAt !== 'string' || !ISO_TS.test(evidence.generatedAt)) {
    failures.push('generatedAt must be ISO UTC');
  }

  if (evidence.verdict === 'PASS') {
    if (evidence.ok !== true) failures.push('PASS evidence must set ok true');
    if ('blockedReason' in evidence) failures.push('PASS evidence must not include blockedReason');
    failures.push(...validatePassProvenance(evidence.provenance));
    failures.push(...validatePassObservation(evidence.observation));
    failures.push(...validateContentSafety(evidence.contentSafety));
  } else if (evidence.verdict === 'BLOCKED') {
    if (evidence.ok !== false) failures.push('BLOCKED evidence must set ok false');
    if (typeof evidence.blockedReason !== 'string' || !evidence.blockedReason.trim() || evidence.blockedReason.length > 500) {
      failures.push('blockedReason must be a non-empty bounded string');
    }
    for (const key of ['provenance', 'observation', 'contentSafety']) {
      if (key in evidence) failures.push(`BLOCKED evidence must not include ${key}`);
    }
  } else {
    failures.push('verdict must be PASS or BLOCKED');
  }

  if (opts.requirePass && (evidence.ok !== true || evidence.verdict !== 'PASS')) {
    failures.push('requirePass: ok must be true and verdict PASS');
  }
  if (SENSITIVE.test(JSON.stringify(evidence))) failures.push('evidence contains sensitive content');
  return failures;
}
