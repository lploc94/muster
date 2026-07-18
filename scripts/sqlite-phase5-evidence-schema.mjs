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

const SENSITIVE =
  /CANARY_|\/Users\/|\/private\/tmp\/|\/var\/folders\/|\\\\Users\\\\|\bSELECT\s+\*|\bINSERT\s+INTO\b|stackTrace|toolOutput|messageBody|"prompt"\s*:/i;

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
  if (typeof scenario.resultCode !== 'string' || scenario.resultCode.length < 1 || scenario.resultCode.length > 64) {
    failures.push('resultCode must be a short fixed string');
  }
  if (scenario.verdict !== 'PASS' && scenario.verdict !== 'FAIL') {
    failures.push('verdict must be PASS or FAIL');
  }
  if (opts.requirePass && scenario.verdict !== 'PASS') {
    failures.push(`scenario ${scenario.scenarioId} must be PASS`);
  }
  if (typeof scenario.durationMs !== 'number' || !Number.isFinite(scenario.durationMs) || scenario.durationMs < 0) {
    failures.push('durationMs must be a non-negative finite number');
  }
  if (scenario.count !== undefined && (!Number.isSafeInteger(scenario.count) || scenario.count < 0)) {
    failures.push('count must be a non-negative safe integer when present');
  }
  if (scenario.byteSize !== undefined && (!Number.isSafeInteger(scenario.byteSize) || scenario.byteSize < 0)) {
    failures.push('byteSize must be a non-negative safe integer when present');
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
  const blob = JSON.stringify(scenario);
  if (SENSITIVE.test(blob)) {
    failures.push(`scenario ${scenario.scenarioId} contains sensitive/unredacted content`);
  }
  if (blob.length > 2000) {
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
  if (typeof runtime.vscodeVersion !== 'string' || runtime.vscodeVersion.length < 1) {
    failures.push('vscodeVersion required');
  }
  if (typeof runtime.nodeVersion !== 'string' || !/^\d+\./.test(runtime.nodeVersion)) {
    failures.push('nodeVersion required');
  }
  if (!Array.isArray(runtime.scenarios)) {
    failures.push('scenarios must be an array');
    return failures;
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
    for (const flag of [
      'absolutePathsStoredInEvidence',
      'messageBodiesStoredInEvidence',
      'sessionIdsStoredInEvidence',
      'canaryStoredInEvidence',
    ]) {
      if (safety[flag] !== false) failures.push(`contentSafety.${flag} must be false`);
    }
  }
  if (typeof evidence.generatedAt !== 'string' || !evidence.generatedAt.includes('T')) {
    failures.push('generatedAt must be an ISO timestamp string');
  }
  if (SENSITIVE.test(JSON.stringify(evidence))) {
    failures.push('evidence contains sensitive/unredacted content');
  }
  return failures;
}

/**
 * Build published evidence from typed runtime results (allowlist only).
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
