import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHASE5_SCENARIO_IDS,
  buildPhase5Evidence,
  validatePhase5Evidence,
  validatePhase5Scenario,
} from './sqlite-phase5-evidence-schema.mjs';

const DEFAULT_CODES = {
  corrupt_open: 'corrupt',
  not_a_database_open: 'not_a_database',
  foreign_reject: 'foreign_database',
  incompatible_reject: 'incompatible_schema',
  write_full_rollback: 'full',
  write_readonly_rollback: 'readonly',
  busy_responsiveness: 'busy',
  backup_wal_writer: 'ok',
  backup_reopen_consistency: 'ok',
  reset_cancel: 'cancel',
  reset_success: 'ok',
  cross_window_reset_contention: 'ok',
};

function completeScenario(id = 'corrupt_open') {
  const scenario = {
    scenarioId: id,
    resultCode: DEFAULT_CODES[id] ?? 'ok',
    verdict: 'PASS',
    durationMs: 12.5,
    count: 1,
    schemaVersion: 7,
  };
  if (id === 'cross_window_reset_contention') {
    scenario.hash = 'a1b2c3d4e5f60718';
  }
  if (id === 'backup_wal_writer') {
    scenario.mechanism = 'vacuum';
    scenario.byteSize = 4096;
  }
  if (id === 'backup_reopen_consistency') {
    scenario.hash = 'abcdef0123456789';
    scenario.byteSize = 4096;
  }
  return scenario;
}

function completeRuntime(runtimeClass = '1.101.0') {
  return {
    runtimeClass,
    vscodeVersion: runtimeClass === '1.101.0' ? '1.101.0' : '1.129.0',
    nodeVersion: '22.15.1',
    scenarios: PHASE5_SCENARIO_IDS.map((id) => completeScenario(id)),
  };
}

function completeEvidence() {
  return buildPhase5Evidence([completeRuntime('1.101.0'), completeRuntime('stable')]);
}

test('accepts a complete synthetic Phase 5 evidence matrix', () => {
  const evidence = completeEvidence();
  assert.deepEqual(validatePhase5Evidence(evidence), []);
});

test('rejects missing runtime, missing scenario, duplicate, FAIL, unknown key, path, canary', () => {
  const base = completeEvidence();

  assert.ok(
    validatePhase5Evidence({ ...base, runtimes: [completeRuntime('1.101.0')] }).some((f) =>
      /exactly two|1\.101\.0 and stable/i.test(f),
    ),
  );

  const missingScenario = completeRuntime('stable');
  missingScenario.scenarios = missingScenario.scenarios.filter((s) => s.scenarioId !== 'reset_cancel');
  assert.ok(
    validatePhase5Evidence({
      ...base,
      runtimes: [completeRuntime('1.101.0'), missingScenario],
    }).some((f) => /missing scenario reset_cancel/i.test(f)),
  );

  const dup = completeRuntime('1.101.0');
  dup.scenarios = [...dup.scenarios, completeScenario('corrupt_open')];
  assert.ok(
    validatePhase5Evidence({
      ...base,
      runtimes: [dup, completeRuntime('stable')],
    }).some((f) => /duplicate scenario corrupt_open/i.test(f)),
  );

  const fail = completeRuntime('stable');
  fail.scenarios = fail.scenarios.map((s) =>
    s.scenarioId === 'busy_responsiveness' ? { ...s, verdict: 'FAIL', resultCode: 'busy' } : s,
  );
  assert.ok(
    validatePhase5Evidence({
      ...base,
      runtimes: [completeRuntime('1.101.0'), fail],
    }).some((f) => /must be PASS/i.test(f)),
  );

  assert.ok(
    validatePhase5Scenario({ ...completeScenario(), path: '/Users/secret/db' }).some((f) =>
      /unknown key: path/i.test(f),
    ),
  );

  assert.ok(
    validatePhase5Scenario({
      ...completeScenario(),
      resultCode: 'file_tmp_workspace',
    }).some((f) => /not allowlisted|fixed snake_case/i.test(f)),
  );

  assert.ok(
    validatePhase5Scenario({
      ...completeScenario('corrupt_open'),
      resultCode: 'ok',
    }).some((f) => /not allowlisted for corrupt_open/i.test(f)),
  );

  assert.ok(
    validatePhase5Evidence({
      ...base,
      extra: true,
    }).some((f) => /unknown key: extra/i.test(f)),
  );

  const freeText = completeScenario();
  freeText.detail = 'long free-form narrative';
  assert.ok(validatePhase5Scenario(freeText).some((f) => /unknown key: detail/i.test(f)));

  const huge = completeScenario();
  huge.durationMs = Number.MAX_SAFE_INTEGER;
  assert.ok(validatePhase5Scenario(huge).some((f) => /durationMs/i.test(f)));

  const badTs = { ...base, generatedAt: 'T file:///tmp/session' };
  assert.ok(validatePhase5Evidence(badTs).some((f) => /generatedAt|sensitive/i.test(f)));
});

test('buildPhase5Evidence drops non-allowlisted fields from inputs', () => {
  const evidence = buildPhase5Evidence([
    {
      runtimeClass: '1.101.0',
      vscodeVersion: '1.101.0',
      nodeVersion: '22.15.1',
      secret: 'CANARY_x',
      scenarios: [
        {
          scenarioId: 'corrupt_open',
          resultCode: 'corrupt',
          verdict: 'PASS',
          durationMs: 1,
          messageBody: 'CANARY_x',
          dbPath: '/Users/secret/muster.sqlite3',
        },
        ...PHASE5_SCENARIO_IDS.filter((id) => id !== 'corrupt_open').map((id) => completeScenario(id)),
      ],
    },
    completeRuntime('stable'),
  ]);
  const text = JSON.stringify(evidence);
  assert.equal(text.includes('CANARY_'), false);
  assert.equal(text.includes('/Users/'), false);
  assert.equal(text.includes('messageBody'), false);
  assert.deepEqual(validatePhase5Evidence(evidence), []);
});
