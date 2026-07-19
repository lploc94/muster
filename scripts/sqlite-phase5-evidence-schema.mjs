/**
 * Pure Phase 5 packaged-fault evidence validators (P5-W7).
 * No I/O — used by unit tests and the evidence verifier/runner.
 */

export const PHASE5_SCENARIO_IDS = [
  'corrupt_open',
  'not_a_database_open',
  'foreign_reject',
  'incompatible_reject',
  'write_full_rollback',
  'write_readonly_rollback',
  'busy_responsiveness',
  'backup_wal_writer',
  'backup_reopen_consistency',
  'reset_cancel',
  'reset_success',
  'cross_window_reset_contention',
];

export const PHASE5_RUNTIME_CLASSES = ['1.101.0', 'stable'];

/** Scenario-specific allowlisted fixed result codes. */
export const PHASE5_RESULT_CODES = {
  corrupt_open: ['corrupt', 'not_a_database'],
  not_a_database_open: ['not_a_database', 'corrupt'],
  foreign_reject: ['foreign_database'],
  incompatible_reject: ['incompatible_schema'],
  write_full_rollback: ['full'],
  write_readonly_rollback: ['readonly'],
  busy_responsiveness: ['busy'],
  backup_wal_writer: ['ok'],
  backup_reopen_consistency: ['ok'],
  reset_cancel: ['cancel'],
  reset_success: ['ok'],
  cross_window_reset_contention: ['ok', 'busy'],
};

const ALLOWED_RESULT_KEYS = new Set([
  'scenarioId',
  'resultCode',
  'verdict',
  'durationMs',
  'count',
  'byteSize',
  'hash',
  'mechanism',
  'schemaVersion',
]);

const ALLOWED_RUNTIME_KEYS = new Set([
  'runtimeClass',
  'vscodeVersion',
  'nodeVersion',
  'scenarios',
]);

const ALLOWED_ROOT_KEYS = new Set([
  'ok',
  'kind',
  'schemaVersion',
  'runtimes',
  'contentSafety',
  'generatedAt',
]);

const CONTENT_SAFETY_KEYS = [
  'absolutePathsStoredInEvidence',
  'messageBodiesStoredInEvidence',
  'sessionIdsStoredInEvidence',
  'canaryStoredInEvidence',
];

const SENSITIVE =
  /CANARY_|\/Users\/|\/private\/tmp\/|\/var\/folders\/|\/tmp\/[A-Za-z0-9._-]+|\\\\Users\\\\|file:\/\/|"workspaceId"\s*:|"taskId"\s*:|"sessionId"\s*:|\bSELECT\s+\*|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|stackTrace|Error\\n|at Object\.|toolOutput|messageBody|"prompt"\s*:/i;

const FIXED_CODE = /^[a-z][a-z0-9_]{0,31}$/;
const VSCODE_VERSION = /^\d+\.\d+\.\d+(?:-.*)?$/;
const NODE_VERSION = /^\d+\.\d+\.\d+(?:-.*)?$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MAX_DURATION_MS = 600_000;
const MAX_COUNT = 1_000_000;
const MAX_BYTE_SIZE = 2_000_000_000;

/**
 * @param {unknown} scenario
 * @param {{ requirePass?: boolean }} [opts]
 * @returns {string[]}
 */
export function validatePhase5Scenario(scenario, opts = {}) {
  const failures = [];
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return ['scenario must be an object'];
  }
  for (const key of Object.keys(scenario)) {
    if (!ALLOWED_RESULT_KEYS.has(key)) {
      failures.push(`scenario has unknown key: ${key}`);
    }
  }
  if (typeof scenario.scenarioId !== 'string' || !PHASE5_SCENARIO_IDS.includes(scenario.scenarioId)) {
    failures.push(`invalid scenarioId: ${String(scenario.scenarioId)}`);
  }
  if (typeof scenario.resultCode !== 'string' || !FIXED_CODE.test(scenario.resultCode)) {
    failures.push('resultCode must be a fixed snake_case token');
  } else if (
    scenario.scenarioId &&
    PHASE5_RESULT_CODES[scenario.scenarioId] &&
    !PHASE5_RESULT_CODES[scenario.scenarioId].includes(scenario.resultCode)
  ) {
    failures.push(
      `resultCode ${scenario.resultCode} not allowlisted for ${scenario.scenarioId}`,
    );
  }
  if (scenario.verdict !== 'PASS' && scenario.verdict !== 'FAIL') {
    failures.push('verdict must be PASS or FAIL');
  }
  if (opts.requirePass && scenario.verdict !== 'PASS') {
    failures.push(`scenario ${scenario.scenarioId} must be PASS`);
  }
  if (
    typeof scenario.durationMs !== 'number' ||
    !Number.isFinite(scenario.durationMs) ||
    scenario.durationMs < 0 ||
    scenario.durationMs > MAX_DURATION_MS
  ) {
    failures.push('durationMs must be a finite number in [0, 600000]');
  }
  if (
    scenario.count !== undefined &&
    (!Number.isSafeInteger(scenario.count) || scenario.count < 0 || scenario.count > MAX_COUNT)
  ) {
    failures.push('count must be a safe integer in [0, 1000000] when present');
  }
  if (
    scenario.byteSize !== undefined &&
    (!Number.isSafeInteger(scenario.byteSize) ||
      scenario.byteSize < 0 ||
      scenario.byteSize > MAX_BYTE_SIZE)
  ) {
    failures.push('byteSize must be a safe integer in [0, 2e9] when present');
  }
  if (scenario.hash !== undefined) {
    if (typeof scenario.hash !== 'string' || !/^[a-f0-9]{8,64}$/.test(scenario.hash)) {
      failures.push('hash must be a bounded hex string when present');
    }
  }
  if (scenario.mechanism !== undefined && scenario.mechanism !== 'api' && scenario.mechanism !== 'vacuum') {
    failures.push('mechanism must be api|vacuum when present');
  }
  if (scenario.schemaVersion !== undefined && scenario.schemaVersion !== 7) {
    failures.push('schemaVersion must be 7 when present');
  }
  if (
    (scenario.scenarioId === 'backup_wal_writer' ||
      scenario.scenarioId === 'backup_reopen_consistency' ||
      scenario.scenarioId === 'reset_success') &&
    scenario.schemaVersion !== 7
  ) {
    failures.push(`${scenario.scenarioId} must report schemaVersion 7`);
  }
  if (scenario.scenarioId === 'cross_window_reset_contention' && typeof scenario.hash !== 'string') {
    failures.push('cross_window_reset_contention must include shared physical identity hash');
  }
  const blob = JSON.stringify(scenario);
  if (SENSITIVE.test(blob)) {
    failures.push(`scenario ${scenario.scenarioId} contains sensitive/unredacted content`);
  }
  if (blob.length > 800) {
    failures.push(`scenario ${scenario.scenarioId} payload too large`);
  }
  return failures;
}

/**
 * @param {unknown} runtime
 * @param {{ requirePass?: boolean }} [opts]
 */
export function validatePhase5Runtime(runtime, opts = {}) {
  const failures = [];
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return ['runtime must be an object'];
  }
  for (const key of Object.keys(runtime)) {
    if (!ALLOWED_RUNTIME_KEYS.has(key)) failures.push(`runtime unknown key: ${key}`);
  }
  if (!PHASE5_RUNTIME_CLASSES.includes(runtime.runtimeClass)) {
    failures.push(`invalid runtimeClass: ${String(runtime.runtimeClass)}`);
  }
  if (typeof runtime.vscodeVersion !== 'string' || !VSCODE_VERSION.test(runtime.vscodeVersion)) {
    failures.push('vscodeVersion must look like x.y.z');
  }
  if (typeof runtime.nodeVersion !== 'string' || !NODE_VERSION.test(runtime.nodeVersion)) {
    failures.push('nodeVersion must look like x.y.z');
  }
  if (!Array.isArray(runtime.scenarios)) {
    failures.push('scenarios must be an array');
    return failures;
  }
  if (runtime.scenarios.length !== PHASE5_SCENARIO_IDS.length) {
    failures.push(
      `scenarios must contain exactly ${PHASE5_SCENARIO_IDS.length} entries for ${runtime.runtimeClass}`,
    );
  }
  const ids = runtime.scenarios.map((s) => s?.scenarioId);
  for (const required of PHASE5_SCENARIO_IDS) {
    if (!ids.includes(required)) failures.push(`missing scenario ${required} for ${runtime.runtimeClass}`);
  }
  const seen = new Set();
  for (const scenario of runtime.scenarios) {
    failures.push(...validatePhase5Scenario(scenario, opts).map((f) => `${runtime.runtimeClass}: ${f}`));
    if (scenario?.scenarioId) {
      if (seen.has(scenario.scenarioId)) {
        failures.push(`${runtime.runtimeClass}: duplicate scenario ${scenario.scenarioId}`);
      }
      seen.add(scenario.scenarioId);
    }
  }
  if (SENSITIVE.test(JSON.stringify(runtime))) {
    failures.push(`runtime ${runtime.runtimeClass} contains sensitive content`);
  }
  return failures;
}

/**
 * @param {unknown} evidence
 * @param {{ requirePass?: boolean }} [opts]
 */
export function validatePhase5Evidence(evidence, opts = { requirePass: true }) {
  const failures = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['evidence must be an object'];
  }
  for (const key of Object.keys(evidence)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) failures.push(`root unknown key: ${key}`);
  }
  if (evidence.ok !== true) failures.push('ok must be true');
  if (evidence.kind !== 'sqlite-phase5-packaged-fault-uat') {
    failures.push('kind must be sqlite-phase5-packaged-fault-uat');
  }
  if (evidence.schemaVersion !== 7) failures.push('root schemaVersion must be 7');
  if (!Array.isArray(evidence.runtimes) || evidence.runtimes.length !== 2) {
    failures.push('runtimes must contain exactly two entries (1.101.0 and stable)');
  } else {
    const classes = evidence.runtimes.map((r) => r?.runtimeClass).sort();
    if (classes.join(',') !== '1.101.0,stable') {
      failures.push('runtimes must cover 1.101.0 and stable exactly once each');
    }
    for (const runtime of evidence.runtimes) {
      failures.push(...validatePhase5Runtime(runtime, opts));
    }
  }
  const safety = evidence.contentSafety;
  if (!safety || typeof safety !== 'object') {
    failures.push('contentSafety required');
  } else {
    const keys = Object.keys(safety).sort();
    if (keys.join(',') !== [...CONTENT_SAFETY_KEYS].sort().join(',')) {
      failures.push('contentSafety must contain exactly the allowlisted flags');
    }
    for (const flag of CONTENT_SAFETY_KEYS) {
      if (safety[flag] !== false) failures.push(`contentSafety.${flag} must be false`);
    }
  }
  if (typeof evidence.generatedAt !== 'string' || !ISO_TS.test(evidence.generatedAt)) {
    failures.push('generatedAt must be an ISO-8601 UTC timestamp');
  }
  if (SENSITIVE.test(JSON.stringify(evidence))) {
    failures.push('evidence contains sensitive/unredacted content');
  }
  return failures;
}

/**
 * Build published evidence from typed runtime results (allowlist only).
 * Extra/canary-bearing fields on inputs are dropped.
 * @param {object[]} runtimes
 */
export function buildPhase5Evidence(runtimes) {
  return {
    ok: true,
    kind: 'sqlite-phase5-packaged-fault-uat',
    schemaVersion: 7,
    runtimes: runtimes.map((runtime) => ({
      runtimeClass: runtime.runtimeClass,
      vscodeVersion: String(runtime.vscodeVersion),
      nodeVersion: String(runtime.nodeVersion),
      scenarios: runtime.scenarios.map((s) => {
        const out = {
          scenarioId: s.scenarioId,
          resultCode: s.resultCode,
          verdict: s.verdict,
          durationMs: s.durationMs,
        };
        if (s.count !== undefined) out.count = s.count;
        if (s.byteSize !== undefined) out.byteSize = s.byteSize;
        if (s.hash !== undefined) out.hash = s.hash;
        if (s.mechanism !== undefined) out.mechanism = s.mechanism;
        if (s.schemaVersion !== undefined) out.schemaVersion = s.schemaVersion;
        return out;
      }),
    })),
    contentSafety: {
      absolutePathsStoredInEvidence: false,
      messageBodiesStoredInEvidence: false,
      sessionIdsStoredInEvidence: false,
      canaryStoredInEvidence: false,
    },
    generatedAt: new Date().toISOString(),
  };
}
