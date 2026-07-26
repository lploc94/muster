/**
 * Unit tests for the M019/S05 native first-run host result builders/parser.
 * No live VS Code launch — pure fail-closed contract coverage.
 */
import { describe, expect, it } from 'vitest';
import {
  NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION,
  type NativeFirstRunObservation,
} from '../src/host/m019-s05-native-first-run';
import {
  NATIVE_FIRST_RUN_RESULT_KIND,
  NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION,
  NATIVE_FIRST_RUN_SCENARIO_IDS,
  blockedScenario,
  buildEnvironmentBlockedMatrix,
  parseNativeFirstRunHostResult,
  scenarioFromObservation,
} from './m019-s05-native-first-run-result';

function sampleObservation(
  overrides: Partial<NativeFirstRunObservation> = {},
): NativeFirstRunObservation {
  return {
    schemaVersion: NATIVE_FIRST_RUN_OBSERVATION_SCHEMA_VERSION,
    providerId: 'claude',
    attemptedStep: 'probe',
    verdict: 'PASS',
    evidenceAt: '2026-07-26T00:00:00.000Z',
    readiness: {
      providerId: 'claude',
      state: 'ready',
      code: 'none',
      recoveryAction: 'none',
      checkedAt: '2026-07-26T00:00:00.000Z',
    },
    ...overrides,
  };
}

function validHostResult(overrides: Record<string, unknown> = {}) {
  const scenarios = NATIVE_FIRST_RUN_SCENARIO_IDS.map((id) => ({
    id,
    verdict: 'ENVIRONMENT_BLOCKED' as const,
    detail: 'structural matrix entry for fail-closed parser coverage',
  }));
  return {
    ok: false,
    kind: NATIVE_FIRST_RUN_RESULT_KIND,
    schemaVersion: NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION,
    vscodeVersion: '1.101.0',
    nodeVersion: '22.15.1',
    extensionActive: false,
    uatMode: true,
    scenarios,
    cleanupCompleted: false,
    ...overrides,
  };
}

describe('m019-s05 native first-run host result contract', () => {
  it('builds a fixed nine-scenario ENVIRONMENT_BLOCKED matrix', () => {
    const matrix = buildEnvironmentBlockedMatrix({
      vscodeVersion: '1.101.0',
      nodeVersion: '22.15.1',
      extensionActive: false,
      uatMode: false,
      reason: 'MUSTER_UAT_MODE is not enabled for this structural run',
    });
    expect(matrix.ok).toBe(false);
    expect(matrix.kind).toBe(NATIVE_FIRST_RUN_RESULT_KIND);
    expect(matrix.scenarios).toHaveLength(9);
    expect(matrix.scenarios.map((s) => s.id)).toEqual([...NATIVE_FIRST_RUN_SCENARIO_IDS]);
    expect(matrix.scenarios.every((s) => s.verdict === 'ENVIRONMENT_BLOCKED')).toBe(true);
    expect(matrix.scenarios.find((s) => s.id === 'NATIVE-CLAUDE-FIRST-RUN')?.providerId).toBe(
      'claude',
    );
    expect(matrix.scenarios.find((s) => s.id === 'NATIVE-OPENCODE-FIRST-RUN')?.providerId).toBe(
      'opencode',
    );
    expect(parseNativeFirstRunHostResult(matrix)).not.toBeNull();
  });

  it('maps observation verdicts into scenario results without smuggling bodies', () => {
    const pass = scenarioFromObservation(
      'NATIVE-CLAUDE-FIRST-RUN',
      sampleObservation({ verdict: 'PASS' }),
    );
    expect(pass.verdict).toBe('PASS');
    expect(pass.detail).toContain('step=probe');
    expect(pass.detail).toContain('state=ready');
    expect(pass.detail).not.toMatch(/prompt|stderr|sk-/i);

    const blocked = scenarioFromObservation(
      'NATIVE-GROK-FIRST-RUN',
      sampleObservation({
        providerId: 'grok',
        verdict: 'ENVIRONMENT_BLOCKED',
        environmentBlockCode: 'provider_missing',
        readiness: {
          providerId: 'grok',
          state: 'missing',
          code: 'executable_missing',
          recoveryAction: 'install',
          checkedAt: '2026-07-26T00:00:00.000Z',
        },
      }),
    );
    expect(blocked.verdict).toBe('ENVIRONMENT_BLOCKED');
    expect(blocked.detail).toContain('block=provider_missing');

    const fail = scenarioFromObservation(
      'NATIVE-FIRST-TASK-ACCEPTANCE',
      sampleObservation({
        attemptedStep: 'first_send',
        verdict: 'FAIL',
        firstSend: { accepted: false, rejectCode: 'validation' },
      }),
    );
    expect(fail.verdict).toBe('FAIL');
    expect(fail.detail).toContain('reject=validation');
  });

  it('accepts a complete host result and rejects open keys / bad cardinality', () => {
    expect(parseNativeFirstRunHostResult(validHostResult())).not.toBeNull();
    expect(
      parseNativeFirstRunHostResult(
        validHostResult({ secret: 'OPENAI_API_KEY', ok: true }),
      ),
    ).toBeNull();
    expect(
      parseNativeFirstRunHostResult(
        validHostResult({
          scenarios: validHostResult().scenarios.slice(0, 8),
        }),
      ),
    ).toBeNull();
  });

  it('rejects absolute paths and secret-like detail in scenario results', () => {
    const withPath = validHostResult();
    withPath.scenarios = withPath.scenarios.map((s, i) =>
      i === 0
        ? { ...s, detail: 'failed under D:/private/workspace for host launch' }
        : s,
    );
    expect(parseNativeFirstRunHostResult(withPath)).toBeNull();

    const withSecret = validHostResult();
    withSecret.scenarios = withSecret.scenarios.map((s, i) =>
      i === 0 ? { ...s, detail: 'token OPENAI_API_KEY leaked into detail' } : s,
    );
    expect(parseNativeFirstRunHostResult(withSecret)).toBeNull();
  });

  it('rejects unknown provider IDs and malformed nested observations', () => {
    const badProvider = validHostResult({ readyProviderId: 'not-a-provider' });
    expect(parseNativeFirstRunHostResult(badProvider)).toBeNull();

    const badObservation = validHostResult();
    badObservation.scenarios = badObservation.scenarios.map((s, i) =>
      i === 1
        ? {
            ...s,
            providerId: 'claude',
            observation: {
              ...sampleObservation(),
              prompt: 'muster-uat-first-run',
            },
          }
        : s,
    );
    expect(parseNativeFirstRunHostResult(badObservation)).toBeNull();
  });

  it('bounds blockedScenario detail and never invents a live PASS from structural blocks', () => {
    const long = 'x'.repeat(500);
    const scenario = blockedScenario('NATIVE-HOST-ACTIVATE', long);
    expect(scenario.verdict).toBe('ENVIRONMENT_BLOCKED');
    expect(scenario.detail.length).toBeLessThanOrEqual(300);
    const matrix = buildEnvironmentBlockedMatrix({
      vscodeVersion: '1.101.0',
      nodeVersion: '22.15.1',
      extensionActive: true,
      uatMode: true,
      reason: 'structural only — no live provider was exercised',
    });
    expect(matrix.ok).toBe(false);
    expect(matrix.scenarios.some((s) => s.verdict === 'PASS')).toBe(false);
  });
});
