/**
 * Pure fail-closed result contract for M019/S05 native first-run host runs.
 * Safe to import from unit tests without loading the `vscode` module.
 */

import {
  parseNativeFirstRunObservation,
  type NativeFirstRunObservation,
  type NativeFirstRunVerdict,
} from '../src/host/m019-s05-native-first-run';
import { BACKEND_READINESS_IDS, type BackendReadinessId } from '../src/shared/backend-readiness';

export const NATIVE_FIRST_RUN_RESULT_KIND = 'm019-s05-native-first-run' as const;
export const NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION = 1 as const;

export const NATIVE_FIRST_RUN_SCENARIO_IDS = [
  'NATIVE-HOST-ACTIVATE',
  'NATIVE-CLAUDE-FIRST-RUN',
  'NATIVE-GROK-FIRST-RUN',
  'NATIVE-KIRO-FIRST-RUN',
  'NATIVE-CODEX-FIRST-RUN',
  'NATIVE-OPENCODE-FIRST-RUN',
  'NATIVE-DOCTOR',
  'NATIVE-FIRST-TASK-ACCEPTANCE',
  'NATIVE-FINAL-CLEANUP',
] as const;

export type NativeFirstRunScenarioId = (typeof NATIVE_FIRST_RUN_SCENARIO_IDS)[number];

export type NativeFirstRunScenarioLedgerVerdict = 'PASS' | 'FAIL' | 'ENVIRONMENT_BLOCKED';

export type NativeFirstRunScenarioResult = {
  id: NativeFirstRunScenarioId;
  verdict: NativeFirstRunScenarioLedgerVerdict;
  /** Bounded, content-free detail for runner logs / evidence drafting. */
  detail: string;
  providerId?: BackendReadinessId;
  observation?: NativeFirstRunObservation;
};

export type NativeFirstRunHostResult = {
  ok: boolean;
  kind: typeof NATIVE_FIRST_RUN_RESULT_KIND;
  schemaVersion: typeof NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION;
  vscodeVersion: string;
  nodeVersion: string;
  extensionActive: boolean;
  uatMode: boolean;
  scenarios: NativeFirstRunScenarioResult[];
  readyProviderId?: BackendReadinessId;
  cleanupCompleted: boolean;
};

const SCENARIO_ID_SET = new Set<string>(NATIVE_FIRST_RUN_SCENARIO_IDS);
const LEDGER_VERDICT_SET = new Set<string>(['PASS', 'FAIL', 'ENVIRONMENT_BLOCKED']);

export const PROVIDER_SCENARIO: Record<BackendReadinessId, NativeFirstRunScenarioId> = {
  claude: 'NATIVE-CLAUDE-FIRST-RUN',
  grok: 'NATIVE-GROK-FIRST-RUN',
  kiro: 'NATIVE-KIRO-FIRST-RUN',
  codex: 'NATIVE-CODEX-FIRST-RUN',
  opencode: 'NATIVE-OPENCODE-FIRST-RUN',
};

const DETAIL_MAX = 300;

export function boundDetail(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= DETAIL_MAX) return trimmed;
  return `${trimmed.slice(0, DETAIL_MAX - 1)}…`;
}

function mapObservationVerdict(
  verdict: NativeFirstRunVerdict,
): NativeFirstRunScenarioLedgerVerdict {
  if (verdict === 'PASS') return 'PASS';
  if (verdict === 'FAIL') return 'FAIL';
  return 'ENVIRONMENT_BLOCKED';
}

function observationDetail(observation: NativeFirstRunObservation): string {
  const parts = [
    `step=${observation.attemptedStep}`,
    `verdict=${observation.verdict}`,
  ];
  if (observation.readiness) {
    parts.push(
      `state=${observation.readiness.state}`,
      `code=${observation.readiness.code}`,
      `recovery=${observation.readiness.recoveryAction}`,
    );
  }
  if (observation.environmentBlockCode) {
    parts.push(`block=${observation.environmentBlockCode}`);
  }
  if (observation.doctorResult) {
    parts.push(`doctor=${observation.doctorResult}`);
  }
  if (observation.firstSend) {
    parts.push(
      `firstSend=${observation.firstSend.accepted ? 'accepted' : 'rejected'}`,
    );
    if (observation.firstSend.rejectCode) {
      parts.push(`reject=${observation.firstSend.rejectCode}`);
    }
  }
  if (observation.cleanupCompleted !== undefined) {
    parts.push(`cleanup=${observation.cleanupCompleted ? 'yes' : 'no'}`);
  }
  return boundDetail(parts.join(' '));
}

export function blockedScenario(
  id: NativeFirstRunScenarioId,
  detail: string,
  providerId?: BackendReadinessId,
): NativeFirstRunScenarioResult {
  return {
    id,
    verdict: 'ENVIRONMENT_BLOCKED',
    detail: boundDetail(detail),
    ...(providerId ? { providerId } : {}),
  };
}

export function scenarioFromObservation(
  id: NativeFirstRunScenarioId,
  observation: NativeFirstRunObservation,
): NativeFirstRunScenarioResult {
  return {
    id,
    verdict: mapObservationVerdict(observation.verdict),
    detail: observationDetail(observation),
    providerId: observation.providerId,
    observation,
  };
}

/**
 * Fail-closed parser for the durable host runner result.
 * Rejects unknown keys, open scenario IDs, secrets-shaped fields, and absolute paths in detail.
 */
export function parseNativeFirstRunHostResult(
  value: unknown,
): NativeFirstRunHostResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'ok',
    'kind',
    'schemaVersion',
    'vscodeVersion',
    'nodeVersion',
    'extensionActive',
    'uatMode',
    'scenarios',
    'readyProviderId',
    'cleanupCompleted',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return null;
  }
  if (raw.kind !== NATIVE_FIRST_RUN_RESULT_KIND) return null;
  if (raw.schemaVersion !== NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION) return null;
  if (typeof raw.ok !== 'boolean') return null;
  if (typeof raw.vscodeVersion !== 'string' || raw.vscodeVersion.length > 32) return null;
  if (typeof raw.nodeVersion !== 'string' || raw.nodeVersion.length > 32) return null;
  if (typeof raw.extensionActive !== 'boolean') return null;
  if (typeof raw.uatMode !== 'boolean') return null;
  if (typeof raw.cleanupCompleted !== 'boolean') return null;
  if (raw.readyProviderId !== undefined) {
    if (
      typeof raw.readyProviderId !== 'string' ||
      !(BACKEND_READINESS_IDS as readonly string[]).includes(raw.readyProviderId)
    ) {
      return null;
    }
  }
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length !== NATIVE_FIRST_RUN_SCENARIO_IDS.length) {
    return null;
  }

  const scenarios: NativeFirstRunScenarioResult[] = [];
  for (let i = 0; i < NATIVE_FIRST_RUN_SCENARIO_IDS.length; i++) {
    const expectedId = NATIVE_FIRST_RUN_SCENARIO_IDS[i]!;
    const item = raw.scenarios[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const s = item as Record<string, unknown>;
    const sAllowed = new Set(['id', 'verdict', 'detail', 'providerId', 'observation']);
    for (const key of Object.keys(s)) {
      if (!sAllowed.has(key)) return null;
    }
    if (s.id !== expectedId || !SCENARIO_ID_SET.has(String(s.id))) return null;
    if (typeof s.verdict !== 'string' || !LEDGER_VERDICT_SET.has(s.verdict)) return null;
    if (typeof s.detail !== 'string' || s.detail.length < 8 || s.detail.length > DETAIL_MAX) {
      return null;
    }
    if (/(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|\/tmp\/)/.test(s.detail)) return null;
    if (/\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|Bearer\s+sk-|sk-ant-|sk-proj-)\b/i.test(s.detail)) {
      return null;
    }
    let providerId: BackendReadinessId | undefined;
    if (s.providerId !== undefined) {
      if (
        typeof s.providerId !== 'string' ||
        !(BACKEND_READINESS_IDS as readonly string[]).includes(s.providerId)
      ) {
        return null;
      }
      providerId = s.providerId as BackendReadinessId;
    }
    let observation: NativeFirstRunObservation | undefined;
    if (s.observation !== undefined) {
      const parsed = parseNativeFirstRunObservation(s.observation);
      if (!parsed) return null;
      observation = parsed;
    }
    scenarios.push({
      id: expectedId,
      verdict: s.verdict as NativeFirstRunScenarioLedgerVerdict,
      detail: s.detail,
      ...(providerId ? { providerId } : {}),
      ...(observation ? { observation } : {}),
    });
  }

  return {
    ok: raw.ok,
    kind: NATIVE_FIRST_RUN_RESULT_KIND,
    schemaVersion: NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION,
    vscodeVersion: raw.vscodeVersion,
    nodeVersion: raw.nodeVersion,
    extensionActive: raw.extensionActive,
    uatMode: raw.uatMode,
    scenarios,
    ...(raw.readyProviderId
      ? { readyProviderId: raw.readyProviderId as BackendReadinessId }
      : {}),
    cleanupCompleted: raw.cleanupCompleted,
  };
}

export function buildEnvironmentBlockedMatrix(input: {
  vscodeVersion: string;
  nodeVersion: string;
  extensionActive: boolean;
  uatMode: boolean;
  reason: string;
}): NativeFirstRunHostResult {
  const detail = boundDetail(input.reason);
  const scenarios: NativeFirstRunScenarioResult[] = NATIVE_FIRST_RUN_SCENARIO_IDS.map((id) => {
    if (id.endsWith('-FIRST-RUN') && id.startsWith('NATIVE-')) {
      const provider = id
        .replace('NATIVE-', '')
        .replace('-FIRST-RUN', '')
        .toLowerCase() as BackendReadinessId;
      if ((BACKEND_READINESS_IDS as readonly string[]).includes(provider)) {
        return blockedScenario(id, detail, provider);
      }
    }
    return blockedScenario(id, detail);
  });
  return {
    ok: false,
    kind: NATIVE_FIRST_RUN_RESULT_KIND,
    schemaVersion: NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION,
    vscodeVersion: input.vscodeVersion,
    nodeVersion: input.nodeVersion,
    extensionActive: input.extensionActive,
    uatMode: input.uatMode,
    scenarios,
    cleanupCompleted: false,
  };
}
