/**
 * Pure Phase 6 webview virtualization evidence validators (P6-W3).
 * No I/O — used by unit tests and the evidence verifier.
 */

const ALLOWED_ROOT_KEYS = new Set([
  'ok',
  'kind',
  'schemaVersion',
  'baselineCommit',
  'w1Commit',
  'w2Commit',
  'runtime',
  'viewport',
  'fixture',
  'thresholds',
  'metrics',
  'contentSafety',
  'generatedAt',
  'durationMs',
  'commands',
  'verdict',
]);

const ALLOWED_RUNTIME_KEYS = new Set(['node', 'platform', 'browser']);
const ALLOWED_VIEWPORT_KEYS = new Set(['width', 'height']);
const ALLOWED_FIXTURE_KEYS = new Set([
  'transcriptItems',
  'treeVisibleRows',
  'contentClasses',
]);
const ALLOWED_THRESHOLD_KEYS = new Set([
  'maxMountedRows',
  'maxTreeMountedRows',
  'maxRetainedDeltaBytes',
  'heapRatio',
  'maxDomPeakDelta',
  'maxDomFinalDelta',
]);
const ALLOWED_CHAT_METRIC_KEYS = new Set([
  'baselineUsedBytes',
  'finalUsedBytes',
  'retainedDeltaBytes',
  'baselineDomNodes',
  'peakDomNodes',
  'finalDomNodes',
  'peakMountedRows',
]);
const ALLOWED_TREE_METRIC_KEYS = new Set([
  ...ALLOWED_CHAT_METRIC_KEYS,
  'logicalRows',
]);
const CONTENT_SAFETY_KEYS = [
  'absolutePathsStoredInEvidence',
  'messageBodiesStoredInEvidence',
  'sessionIdsStoredInEvidence',
  'canaryStoredInEvidence',
];
const ALLOWED_CONTENT_CLASSES = new Set([
  'user',
  'assistant',
  'tool',
  'reasoning',
  'tall-markdown',
  'wide-tree',
  'error',
]);

const SENSITIVE =
  /CANARY_|\/Users\/|\/home\/|\/private\/tmp\/|\/var\/folders\/|\/tmp\/[A-Za-z0-9._-]+|[A-Za-z]:\\|\bfile:\/\/|\\?"workspaceId\\?"\s*:|\\?"sessionId\\?"\s*:|\\?"taskId\\?"\s*:|\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\b|\bDELETE\s+FROM\b|\bDELETE\b\s+\w|stackTrace|\bat\s+(?:async\s+)?[\w.<>$[\]\s]+\(|Error:\s|\bsrc\/[\w./-]+:\d+|messageBody|\\?"prompt\\?"\s*:/i;

const SHA1 = /^[0-9a-f]{7,40}$/i;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const NODE_VERSION = /^\d+\.\d+\.\d+(?:-.*)?$/;

/** Approved Phase 6 provenance (full SHAs; short prefixes also accepted). */
export const PHASE6_BASELINE_COMMIT = 'a5864fc4262df8180b665acf7a54aca2ee90d916';
export const PHASE6_W1_COMMIT = 'f4c62bcf1b9351d97385b8b2df20012e626f080a';
export const PHASE6_W2_COMMIT = '3558914f855d2f50b0ae2fbd9eb7857ab526e743';

function matchesApprovedSha(value, approvedFull) {
  if (typeof value !== 'string' || !SHA1.test(value)) return false;
  const v = value.toLowerCase();
  const a = approvedFull.toLowerCase();
  return a.startsWith(v) || v.startsWith(a.slice(0, 7));
}

function isFiniteNonNegInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

function isFiniteNonNeg(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

function validateSurfaceMetrics(label, m, keys, thresholds) {
  const failures = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return [`${label} metrics must be an object`];
  }
  for (const k of unknownKeys(m, keys)) {
    failures.push(`${label} has unknown key: ${k}`);
  }
  for (const k of keys) {
    if (!(k in m)) failures.push(`${label} missing ${k}`);
  }
  for (const k of keys) {
    if (!(k in m)) continue;
    if (!isFiniteNonNegInt(m[k])) {
      failures.push(`${label}.${k} must be a non-negative integer`);
    }
  }
  const maxMounted =
    label === 'tree' ? thresholds.maxTreeMountedRows : thresholds.maxMountedRows;
  if (isFiniteNonNegInt(m.peakMountedRows) && m.peakMountedRows > maxMounted) {
    failures.push(`${label}.peakMountedRows ${m.peakMountedRows} exceeds max ${maxMounted}`);
  }
  if (
    isFiniteNonNegInt(m.retainedDeltaBytes) &&
    isFiniteNonNegInt(m.baselineUsedBytes) &&
    isFiniteNonNegInt(m.finalUsedBytes)
  ) {
    const expected = Math.max(0, m.finalUsedBytes - m.baselineUsedBytes);
    if (m.retainedDeltaBytes !== expected) {
      failures.push(`${label}.retainedDeltaBytes must equal max(0, final-baseline)`);
    }
  }
  const peakDelta = thresholds.maxDomPeakDelta ?? 2500;
  const finalDelta = thresholds.maxDomFinalDelta ?? 250;
  if (
    isFiniteNonNegInt(m.peakDomNodes) &&
    isFiniteNonNegInt(m.baselineDomNodes) &&
    m.peakDomNodes > m.baselineDomNodes + peakDelta
  ) {
    failures.push(`${label}.peakDomNodes exceeds baseline+${peakDelta}`);
  }
  if (
    isFiniteNonNegInt(m.finalDomNodes) &&
    isFiniteNonNegInt(m.baselineDomNodes) &&
    m.finalDomNodes > m.baselineDomNodes + finalDelta
  ) {
    failures.push(`${label}.finalDomNodes exceeds baseline+${finalDelta}`);
  }
  const heapRatio = thresholds.heapRatio ?? 1.5;
  if (
    isFiniteNonNegInt(m.finalUsedBytes) &&
    isFiniteNonNegInt(m.baselineUsedBytes) &&
    m.finalUsedBytes > heapRatio * m.baselineUsedBytes
  ) {
    failures.push(`${label}.finalUsedBytes exceeds ${heapRatio}x baseline`);
  }
  const maxRetained = thresholds.maxRetainedDeltaBytes ?? 16 * 1024 * 1024;
  if (isFiniteNonNegInt(m.retainedDeltaBytes) && m.retainedDeltaBytes > maxRetained) {
    failures.push(`${label}.retainedDeltaBytes exceeds maxRetainedDeltaBytes`);
  }
  return failures;
}

/**
 * @param {unknown} evidence
 * @param {{ requirePass?: boolean }} [opts]
 * @returns {string[]}
 */
export function validatePhase6Evidence(evidence, opts = {}) {
  const failures = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['evidence must be an object'];
  }
  for (const k of unknownKeys(evidence, ALLOWED_ROOT_KEYS)) {
    failures.push(`unknown root key: ${k}`);
  }
  if (evidence.kind !== 'sqlite-phase6-webview') {
    failures.push('kind must be sqlite-phase6-webview');
  }
  if (evidence.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (typeof evidence.ok !== 'boolean') failures.push('ok must be boolean');
  if (evidence.verdict !== 'PASS' && evidence.verdict !== 'FAIL') {
    failures.push('verdict must be PASS or FAIL');
  }
  if (opts.requirePass) {
    if (evidence.ok !== true || evidence.verdict !== 'PASS') {
      failures.push('requirePass: ok must be true and verdict PASS');
    }
  }
  if (!matchesApprovedSha(evidence.baselineCommit, PHASE6_BASELINE_COMMIT)) {
    failures.push('baselineCommit must match approved Phase 6 baseline');
  }
  if (!matchesApprovedSha(evidence.w1Commit, PHASE6_W1_COMMIT)) {
    failures.push('w1Commit must match approved P6-W1 commit');
  }
  if (!matchesApprovedSha(evidence.w2Commit, PHASE6_W2_COMMIT)) {
    failures.push('w2Commit must match approved P6-W2 commit');
  }
  if ('w3Commit' in evidence || 'finalCommit' in evidence) {
    failures.push('must not embed self-referential w3/final commit');
  }
  if (!evidence.runtime || typeof evidence.runtime !== 'object') {
    failures.push('runtime required');
  } else {
    for (const k of unknownKeys(evidence.runtime, ALLOWED_RUNTIME_KEYS)) {
      failures.push(`runtime unknown key: ${k}`);
    }
    if (typeof evidence.runtime.node !== 'string' || !NODE_VERSION.test(evidence.runtime.node)) {
      failures.push('runtime.node must be x.y.z');
    }
    if (typeof evidence.runtime.platform !== 'string' || !evidence.runtime.platform) {
      failures.push('runtime.platform required');
    }
    if (evidence.runtime.browser !== 'chromium') {
      failures.push('runtime.browser must be chromium');
    }
  }
  if (!evidence.viewport || typeof evidence.viewport !== 'object') {
    failures.push('viewport required');
  } else {
    for (const k of unknownKeys(evidence.viewport, ALLOWED_VIEWPORT_KEYS)) {
      failures.push(`viewport unknown key: ${k}`);
    }
    if (!isFiniteNonNegInt(evidence.viewport.width) || evidence.viewport.width < 320) {
      failures.push('viewport.width invalid');
    }
    if (!isFiniteNonNegInt(evidence.viewport.height) || evidence.viewport.height < 240) {
      failures.push('viewport.height invalid');
    }
  }
  if (!evidence.fixture || typeof evidence.fixture !== 'object') {
    failures.push('fixture required');
  } else {
    for (const k of unknownKeys(evidence.fixture, ALLOWED_FIXTURE_KEYS)) {
      failures.push(`fixture unknown key: ${k}`);
    }
    if (!isFiniteNonNegInt(evidence.fixture.transcriptItems) || evidence.fixture.transcriptItems < 1000) {
      failures.push('fixture.transcriptItems must be >= 1000');
    }
    if (!isFiniteNonNegInt(evidence.fixture.treeVisibleRows) || evidence.fixture.treeVisibleRows < 1000) {
      failures.push('fixture.treeVisibleRows must be >= 1000');
    }
    if (
      !Array.isArray(evidence.fixture.contentClasses) ||
      evidence.fixture.contentClasses.length < 3 ||
      !evidence.fixture.contentClasses.every(
        (c) => typeof c === 'string' && ALLOWED_CONTENT_CLASSES.has(c),
      )
    ) {
      failures.push('fixture.contentClasses must be approved non-empty strings');
    }
  }
  if (!evidence.thresholds || typeof evidence.thresholds !== 'object') {
    failures.push('thresholds required');
  } else {
    for (const k of unknownKeys(evidence.thresholds, ALLOWED_THRESHOLD_KEYS)) {
      failures.push(`thresholds unknown key: ${k}`);
    }
    if (evidence.thresholds.maxMountedRows !== 80) {
      failures.push('thresholds.maxMountedRows must be 80');
    }
    if (evidence.thresholds.maxTreeMountedRows !== 100) {
      failures.push('thresholds.maxTreeMountedRows must be 100');
    }
    if (evidence.thresholds.maxRetainedDeltaBytes !== 16 * 1024 * 1024) {
      failures.push('thresholds.maxRetainedDeltaBytes must be 16MiB');
    }
    if (evidence.thresholds.heapRatio !== 1.5) {
      failures.push('thresholds.heapRatio must be 1.5');
    }
    if (evidence.thresholds.maxDomPeakDelta !== 2500) {
      failures.push('thresholds.maxDomPeakDelta must be 2500');
    }
    if (evidence.thresholds.maxDomFinalDelta !== 250) {
      failures.push('thresholds.maxDomFinalDelta must be 250');
    }
  }
  if (!evidence.metrics || typeof evidence.metrics !== 'object') {
    failures.push('metrics required');
  } else {
    const thr = evidence.thresholds ?? {};
    failures.push(
      ...validateSurfaceMetrics('chat', evidence.metrics.chat, ALLOWED_CHAT_METRIC_KEYS, thr),
    );
    failures.push(
      ...validateSurfaceMetrics('tree', evidence.metrics.tree, ALLOWED_TREE_METRIC_KEYS, thr),
    );
  }
  if (!evidence.contentSafety || typeof evidence.contentSafety !== 'object') {
    failures.push('contentSafety required');
  } else {
    for (const k of unknownKeys(evidence.contentSafety, new Set(CONTENT_SAFETY_KEYS))) {
      failures.push(`contentSafety unknown key: ${k}`);
    }
    for (const k of CONTENT_SAFETY_KEYS) {
      if (evidence.contentSafety[k] !== false) {
        failures.push(`contentSafety.${k} must be false`);
      }
    }
  }
  if (typeof evidence.generatedAt !== 'string' || !ISO_TS.test(evidence.generatedAt)) {
    failures.push('generatedAt must be ISO UTC');
  }
  if (!isFiniteNonNegInt(evidence.durationMs) || evidence.durationMs > 600_000) {
    failures.push('durationMs invalid');
  }
  if (
    !Array.isArray(evidence.commands) ||
    !evidence.commands.every((c) => typeof c === 'string' && c.length > 0)
  ) {
    failures.push('commands must be non-empty string array');
  }
  const blob = JSON.stringify(evidence);
  if (SENSITIVE.test(blob)) {
    failures.push('evidence contains sensitive content');
  }
  return failures;
}
