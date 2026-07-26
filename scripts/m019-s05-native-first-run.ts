/**
 * M019/S05 packaged Extension Host native first-run entrypoint.
 *
 * Loaded via @vscode/test-electron as extensionTestsPath against a freshly
 * packaged VSIX (extensionDevelopmentPath). Observes activation, per-provider
 * readiness refresh + isolated probe, Doctor, optional first-task acceptance,
 * and cleanup through the non-production MUSTER_UAT_MODE command surface.
 *
 * Pure result builders live in m019-s05-native-first-run-result.ts so unit
 * tests never import the vscode module.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  NATIVE_FIRST_RUN_UAT_COMMANDS,
  parseNativeFirstRunObservation,
} from '../src/host/m019-s05-native-first-run';
import { UAT_COMMANDS } from '../src/host/uat-commands';
import { BACKEND_READINESS_IDS, type BackendReadinessId } from '../src/shared/backend-readiness';
import {
  NATIVE_FIRST_RUN_RESULT_KIND,
  NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION,
  NATIVE_FIRST_RUN_SCENARIO_IDS,
  PROVIDER_SCENARIO,
  blockedScenario,
  boundDetail,
  buildEnvironmentBlockedMatrix,
  scenarioFromObservation,
  type NativeFirstRunHostResult,
  type NativeFirstRunScenarioResult,
} from './m019-s05-native-first-run-result';

export {
  NATIVE_FIRST_RUN_RESULT_KIND,
  NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION,
  NATIVE_FIRST_RUN_SCENARIO_IDS,
  PROVIDER_SCENARIO,
  blockedScenario,
  boundDetail,
  buildEnvironmentBlockedMatrix,
  parseNativeFirstRunHostResult,
  scenarioFromObservation,
} from './m019-s05-native-first-run-result';
export type {
  NativeFirstRunHostResult,
  NativeFirstRunScenarioId,
  NativeFirstRunScenarioLedgerVerdict,
  NativeFirstRunScenarioResult,
} from './m019-s05-native-first-run-result';

async function cmd<T>(command: string, args?: unknown): Promise<T> {
  return (await vscode.commands.executeCommand(command, args)) as T;
}

async function activateMuster(): Promise<{ sessionId: string }> {
  const extension = vscode.extensions.getExtension('tlelabs.muster');
  assert.ok(extension, 'packaged tlelabs.muster was not discovered');
  await extension.activate();
  assert.equal(extension.isActive, true, 'extension failed to activate');
  const ping = await cmd<{ ok: boolean; sessionId: string }>(UAT_COMMANDS.ping);
  assert.equal(ping.ok, true, 'UAT surface is unavailable (MUSTER_UAT_MODE required)');
  await vscode.commands.executeCommand('muster.openChat');
  return { sessionId: ping.sessionId };
}

function writeResult(result: NativeFirstRunHostResult): void {
  const outPath = process.env.MUSTER_UAT_EVIDENCE_OUT;
  if (!outPath) return;
  // Only write when the outer runner supplies a path; never invent machine paths.
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(tmp, outPath);
}

/**
 * Extension Host entry — invoked by @vscode/test-electron.
 */
export async function run(): Promise<void> {
  const uatMode = process.env.MUSTER_UAT_MODE === '1';
  const baseMeta = {
    vscodeVersion: vscode.version,
    nodeVersion: process.versions.node,
  };

  if (!uatMode) {
    const blocked = buildEnvironmentBlockedMatrix({
      ...baseMeta,
      extensionActive: false,
      uatMode: false,
      reason:
        'MUSTER_UAT_MODE is not enabled; native first-run UAT commands are unavailable in production hosts.',
    });
    writeResult(blocked);
    throw new Error(blocked.scenarios[0]!.detail);
  }

  let extensionActive = false;
  try {
    await activateMuster();
    extensionActive = true;
  } catch (error) {
    const reason =
      error instanceof Error
        ? boundDetail(`activation failed: ${error.message}`)
        : 'activation failed: unknown host error';
    const blocked = buildEnvironmentBlockedMatrix({
      ...baseMeta,
      extensionActive: false,
      uatMode: true,
      reason,
    });
    writeResult(blocked);
    throw new Error(reason);
  }

  const scenarios: NativeFirstRunScenarioResult[] = [];
  scenarios.push({
    id: 'NATIVE-HOST-ACTIVATE',
    verdict: 'PASS',
    detail: boundDetail(
      'packaged extension activated; UAT ping ok; chat view open requested',
    ),
  });

  let readyProviderId: BackendReadinessId | undefined;

  for (const providerId of BACKEND_READINESS_IDS) {
    const scenarioId = PROVIDER_SCENARIO[providerId];
    try {
      const refreshRaw = await cmd<unknown>(NATIVE_FIRST_RUN_UAT_COMMANDS.refreshReadiness, {
        providerId,
      });
      const refresh = parseNativeFirstRunObservation(refreshRaw);
      if (!refresh) {
        scenarios.push(
          blockedScenario(
            scenarioId,
            'refresh observation failed closed (malformed or unallowlisted fields)',
            providerId,
          ),
        );
        continue;
      }

      const probeRaw = await cmd<unknown>(NATIVE_FIRST_RUN_UAT_COMMANDS.probeBackend, {
        providerId,
      });
      const probe = parseNativeFirstRunObservation(probeRaw);
      if (!probe) {
        scenarios.push(
          blockedScenario(
            scenarioId,
            'probe observation failed closed (malformed or unallowlisted fields)',
            providerId,
          ),
        );
        continue;
      }

      scenarios.push(scenarioFromObservation(scenarioId, probe));
      if (probe.verdict === 'PASS' && probe.readiness?.state === 'ready' && !readyProviderId) {
        readyProviderId = providerId;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'provider scenario host error';
      scenarios.push(
        blockedScenario(
          scenarioId,
          boundDetail(`provider scenario host error: ${message}`),
          providerId,
        ),
      );
    }
  }

  // Doctor — prefer a ready provider id for the observation tag; else first allowlisted.
  const doctorProvider = readyProviderId ?? BACKEND_READINESS_IDS[0]!;
  try {
    const doctorRaw = await cmd<unknown>(NATIVE_FIRST_RUN_UAT_COMMANDS.runDoctor, {
      providerId: doctorProvider,
    });
    const doctor = parseNativeFirstRunObservation(doctorRaw);
    if (!doctor) {
      scenarios.push(
        blockedScenario(
          'NATIVE-DOCTOR',
          'doctor observation failed closed (malformed or unallowlisted fields)',
          doctorProvider,
        ),
      );
    } else {
      scenarios.push(scenarioFromObservation('NATIVE-DOCTOR', doctor));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'doctor host error';
    scenarios.push(
      blockedScenario(
        'NATIVE-DOCTOR',
        boundDetail(`doctor host error: ${message}`),
        doctorProvider,
      ),
    );
  }

  // First-task acceptance only when at least one provider is ready.
  if (readyProviderId) {
    try {
      const acceptRaw = await cmd<unknown>(NATIVE_FIRST_RUN_UAT_COMMANDS.acceptFirstTask, {
        providerId: readyProviderId,
      });
      const accept = parseNativeFirstRunObservation(acceptRaw);
      if (!accept) {
        scenarios.push(
          blockedScenario(
            'NATIVE-FIRST-TASK-ACCEPTANCE',
            'first-send observation failed closed (malformed or unallowlisted fields)',
            readyProviderId,
          ),
        );
      } else {
        scenarios.push(scenarioFromObservation('NATIVE-FIRST-TASK-ACCEPTANCE', accept));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'first-send host error';
      scenarios.push(
        blockedScenario(
          'NATIVE-FIRST-TASK-ACCEPTANCE',
          boundDetail(`first-send host error: ${message}`),
          readyProviderId,
        ),
      );
    }
  } else {
    scenarios.push(
      blockedScenario(
        'NATIVE-FIRST-TASK-ACCEPTANCE',
        'no ready provider after refresh/probe; first-task acceptance not attempted',
      ),
    );
  }

  // Cleanup for the ready provider (or first allowlisted) + any created first task.
  let cleanupCompleted = false;
  try {
    const cleanupProvider = readyProviderId ?? BACKEND_READINESS_IDS[0]!;
    const cleanupRaw = await cmd<unknown>(NATIVE_FIRST_RUN_UAT_COMMANDS.cleanup, {
      providerId: cleanupProvider,
    });
    const cleanup = parseNativeFirstRunObservation(cleanupRaw);
    if (cleanup) {
      scenarios.push(scenarioFromObservation('NATIVE-FINAL-CLEANUP', cleanup));
      cleanupCompleted = cleanup.cleanupCompleted === true && cleanup.verdict === 'PASS';
    } else {
      scenarios.push(
        blockedScenario(
          'NATIVE-FINAL-CLEANUP',
          'cleanup observation failed closed (malformed or unallowlisted fields)',
          cleanupProvider,
        ),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cleanup host error';
    scenarios.push(
      blockedScenario(
        'NATIVE-FINAL-CLEANUP',
        boundDetail(`cleanup host error: ${message}`),
      ),
    );
  }

  // Ensure fixed cardinality / order even if a branch skipped a push (defensive).
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const ordered = NATIVE_FIRST_RUN_SCENARIO_IDS.map(
    (id) =>
      byId.get(id) ??
      blockedScenario(id, 'scenario result missing after host run; fail-closed'),
  );

  const anyFail = ordered.some((s) => s.verdict === 'FAIL');
  const result: NativeFirstRunHostResult = {
    ok: !anyFail && extensionActive && uatMode,
    kind: NATIVE_FIRST_RUN_RESULT_KIND,
    schemaVersion: NATIVE_FIRST_RUN_RESULT_SCHEMA_VERSION,
    vscodeVersion: baseMeta.vscodeVersion,
    nodeVersion: baseMeta.nodeVersion,
    extensionActive,
    uatMode,
    scenarios: ordered,
    ...(readyProviderId ? { readyProviderId } : {}),
    cleanupCompleted,
  };

  writeResult(result);

  // Surface a concise summary for the outer runner log (no secrets/paths).
  console.log(
    `[m019-s05-native-first-run] ok=${result.ok} ready=${readyProviderId ?? 'none'} ` +
      `cleanup=${cleanupCompleted} scenarios=${ordered
        .map((s) => `${s.id}:${s.verdict}`)
        .join(',')}`,
  );

  // Host process exit: do not throw on ENVIRONMENT_BLOCKED-only matrices;
  // FAIL or activation/UAT contract breaks still fail the process.
  if (anyFail) {
    throw new Error('native first-run matrix reported FAIL');
  }
  if (!extensionActive || !uatMode) {
    throw new Error('native first-run host contract not satisfied');
  }
}
