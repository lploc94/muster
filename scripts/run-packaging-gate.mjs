/**
 * Packaging gate runner (M022/S01).
 *
 * Packaging stage (T03): createVSIX -> extract -> census -> allowlist ->
 * entrypoint presence -> evidence JSON.
 *
 * Host stage (T04): real Extension Host against the extracted archive —
 * activation, packaged SQLite worker spawn, stdio proxy require graph, and
 * MCP bridge /health listen via muster.uat.bridgeHealth.
 *
 * Usage:
 *   node scripts/run-packaging-gate.mjs --census-only
 *   npm run test:packaging
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { runTests } from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';

import {
  PACKAGING_ALLOWLIST,
  REQUIRED_ARCHIVE_ENTRYPOINTS,
} from './packaging-allowlist.mjs';
import {
  buildArchiveCensus,
  evaluateAllowlist,
  findMissingEntrypoints,
  formatCensusReport,
} from './packaging-archive-census.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const DEFAULT_EVIDENCE_PATH = path.join(
  root,
  'docs',
  'plans',
  'm022-s01-packaging-gate-evidence.json',
);

/**
 * @typedef {object} EntrypointResult
 * @property {string} path
 * @property {boolean} present
 * @property {boolean} resolved
 * @property {'ok' | 'missing-archive-entry' | 'require-failed' | 'spawn-failed'} phase
 * @property {string} [detail]
 */

/**
 * @param {{
 *   entryNames: string[],
 *   requiredEntrypoints: string[],
 *   fileExists: (archivePath: string) => boolean,
 * }} args
 * @returns {EntrypointResult[]}
 */
export function buildEntrypointResults({ entryNames, requiredEntrypoints, fileExists }) {
  const names = Array.isArray(entryNames) ? entryNames : [];
  const required = Array.isArray(requiredEntrypoints) ? requiredEntrypoints : [];
  const presentSet = new Set(names.map((n) => String(n ?? '').replaceAll('\\', '/')));

  return required.map((rawPath) => {
    const archivePath = String(rawPath ?? '').replaceAll('\\', '/');
    const present = presentSet.has(archivePath);
    if (!present) {
      return {
        path: archivePath,
        present: false,
        resolved: false,
        phase: 'missing-archive-entry',
      };
    }
    const resolved = fileExists(archivePath) === true;
    if (!resolved) {
      return {
        path: archivePath,
        present: true,
        resolved: false,
        phase: 'require-failed',
        detail: 'archive entry present but extracted file missing or empty',
      };
    }
    return {
      path: archivePath,
      present: true,
      resolved: true,
      phase: 'ok',
    };
  });
}

/**
 * @param {{
 *   census: import('./packaging-archive-census.mjs').ArchiveCensus | {
 *     totalEntries: number,
 *     nodeModulesEntries: number,
 *     nonNodeModulesEntries: number,
 *     topLevelCounts: Record<string, number>,
 *     nodeModulesPackages: string[],
 *     nodeModulesPackageCounts?: Record<string, number>,
 *   },
 *   allowlistResult: { mode: string, ok: boolean, violations: string[] },
 *   missingEntrypoints: string[],
 *   entrypoints: EntrypointResult[],
 *   mode?: string,
 *   activation?: string,
 *   bridge?: { port: number, status: string, generation?: number } | null,
 *   bridgePhase?: string | null,
 *   generatedAt?: string,
 *   durationMs?: number,
 * }} args
 */
export function buildPackagingGateEvidence({
  census,
  allowlistResult,
  missingEntrypoints,
  entrypoints,
  mode = 'census-only',
  activation = 'deferred',
  bridge = null,
  bridgePhase = null,
  generatedAt = new Date().toISOString(),
  durationMs = 0,
}) {
  const missing = Array.isArray(missingEntrypoints) ? missingEntrypoints : [];
  const eps = Array.isArray(entrypoints) ? entrypoints : [];
  const allowOk = allowlistResult?.ok === true;
  const entrypointsOk = eps.every((r) => r.present && r.resolved && r.phase === 'ok');
  const packagingOk = allowOk && missing.length === 0 && entrypointsOk;
  // 'full' requires live host observations; 'census-only' / 'packaging' only gate archive contents.
  const hostRequired = mode === 'full';
  const bridgeOk =
    bridge &&
    typeof bridge.port === 'number' &&
    bridge.port > 0 &&
    bridge.status === 'ok';
  const activationOk = activation === 'ok';
  const ok = packagingOk && (!hostRequired || (activationOk && bridgeOk === true));

  return {
    kind: 'm022-s01-packaging-gate',
    ok,
    mode,
    totalEntries: census?.totalEntries ?? 0,
    nodeModulesEntryCount: census?.nodeModulesEntries ?? 0,
    nonNodeModulesEntries: census?.nonNodeModulesEntries ?? 0,
    topLevelCounts: census?.topLevelCounts ?? {},
    nodeModulesPackages: census?.nodeModulesPackages ?? [],
    nodeModulesPackageCounts: census?.nodeModulesPackageCounts ?? {},
    allowlist: {
      mode: allowlistResult?.mode ?? 'unknown',
      ok: allowOk,
      violations: allowlistResult?.violations ?? [],
    },
    missingEntrypoints: missing,
    entrypoints: eps,
    activation,
    bridge,
    bridgePhase,
    generatedAt,
    durationMs,
  };
}

/**
 * Normalize the host-smoke result written by packaging-gate-extension-host-smoke.
 * Missing/invalid payloads are classified as activation failures so the runner
 * never invents a listening bridge.
 *
 * @param {unknown} raw
 */
export function parseHostSmokeResult(raw) {
  /** @type {{ ok: false, activation: 'failed', bridge: null, bridgePhase: 'activation', entrypoints: [], detail: string }} */
  const activationFailure = (detail) => ({
    kind: 'm022-s01-packaging-host-smoke',
    ok: false,
    activation: 'failed',
    bridge: null,
    bridgePhase: 'activation',
    entrypoints: [],
    detail,
  });

  if (!raw || typeof raw !== 'object') {
    return activationFailure('host smoke did not write a result payload');
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (obj.kind !== 'm022-s01-packaging-host-smoke') {
    return activationFailure(`unexpected host smoke kind: ${String(obj.kind)}`);
  }

  const activation = obj.activation === 'ok' ? 'ok' : 'failed';
  const entrypoints = Array.isArray(obj.entrypoints)
    ? obj.entrypoints.map((item) => {
        const r = /** @type {Record<string, unknown>} */ (item ?? {});
        return {
          path: String(r.path ?? ''),
          present: r.present === true,
          resolved: r.resolved === true,
          phase:
            r.phase === 'ok' ||
            r.phase === 'missing-archive-entry' ||
            r.phase === 'require-failed' ||
            r.phase === 'spawn-failed'
              ? r.phase
              : 'require-failed',
          ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
        };
      })
    : [];

  let bridge = null;
  if (obj.bridge && typeof obj.bridge === 'object') {
    const b = /** @type {Record<string, unknown>} */ (obj.bridge);
    const port = typeof b.port === 'number' && Number.isFinite(b.port) ? b.port : 0;
    const generation =
      typeof b.generation === 'number' && Number.isFinite(b.generation) ? b.generation : 0;
    const status =
      b.status === 'ok' || b.status === 'stopping' || b.status === 'unavailable'
        ? b.status
        : port > 0
          ? 'ok'
          : 'unavailable';
    bridge = { port, status, generation };
  }

  const allowedBridgePhases = new Set([
    'ok',
    'activation',
    'uat-command-unavailable',
    'health-unreachable',
  ]);
  let bridgePhase =
    typeof obj.bridgePhase === 'string' && allowedBridgePhases.has(obj.bridgePhase)
      ? obj.bridgePhase
      : activation === 'ok'
        ? 'health-unreachable'
        : 'activation';

  const bridgeListening =
    bridge && bridge.status === 'ok' && typeof bridge.port === 'number' && bridge.port > 0;
  if (activation === 'ok' && bridgeListening) {
    bridgePhase = bridgePhase === 'ok' ? 'ok' : bridgePhase;
  }

  const entrypointsOk = entrypoints.length > 0 && entrypoints.every((r) => r.present && r.resolved && r.phase === 'ok');
  const ok = activation === 'ok' && bridgeListening === true && entrypointsOk && bridgePhase === 'ok';

  return {
    kind: 'm022-s01-packaging-host-smoke',
    ok,
    activation,
    bridge,
    bridgePhase,
    entrypoints,
    ...(typeof obj.detail === 'string' ? { detail: obj.detail } : {}),
  };
}

/**
 * Merge host-smoke observations into packaging evidence and recompute ok.
 *
 * @param {ReturnType<typeof buildPackagingGateEvidence>} evidence
 * @param {ReturnType<typeof parseHostSmokeResult>} hostResult
 */
export function applyHostStageToEvidence(evidence, hostResult) {
  const host = hostResult ?? parseHostSmokeResult(null);
  const entrypoints =
    Array.isArray(host.entrypoints) && host.entrypoints.length > 0
      ? host.entrypoints
      : evidence.entrypoints;

  const packagingOk =
    evidence.allowlist?.ok === true &&
    (evidence.missingEntrypoints?.length ?? 0) === 0 &&
    entrypoints.every((r) => r.present && r.resolved && r.phase === 'ok');

  const bridge = host.bridge;
  const bridgeOk =
    bridge &&
    typeof bridge.port === 'number' &&
    bridge.port > 0 &&
    bridge.status === 'ok';
  const activationOk = host.activation === 'ok';
  const bridgePhaseOk = host.bridgePhase === 'ok';
  const ok = packagingOk && activationOk && bridgeOk === true && bridgePhaseOk;

  return {
    ...evidence,
    mode: 'full',
    entrypoints,
    activation: host.activation,
    bridge,
    bridgePhase: host.bridgePhase,
    ok,
    ...(typeof host.detail === 'string' ? { hostDetail: host.detail } : {}),
  };
}

/**
 * @param {string} evidencePath
 * @param {ReturnType<typeof buildPackagingGateEvidence>} evidence
 */
function writeEvidence(evidencePath, evidence) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

/**
 * @param {object} opts
 * @param {boolean} opts.censusOnly
 * @param {string} opts.evidencePath
 */
async function runPackagingStage({ censusOnly, evidencePath }) {
  const started = Date.now();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-packaging-gate-'));
  const vsixPath = path.join(tempDir, 'muster.vsix');

  try {
    // createVSIX runs vscode:prepublish, so the gate always tests a fresh build.
    console.log('[packaging-gate] createVSIX…');
    await createVSIX({
      cwd: root,
      packagePath: vsixPath,
      dependencies: true,
      allowMissingRepository: false,
    });

    if (!fs.existsSync(vsixPath)) {
      throw new Error(`createVSIX did not produce ${vsixPath}`);
    }

    const zip = new AdmZip(vsixPath);
    const entryNames = zip
      .getEntries()
      .map((entry) => String(entry.entryName ?? '').replaceAll('\\', '/'));

    const forbiddenPackageEntries = entryNames.filter((entry) =>
      /(?:^|\/)(?:\.env(?:\..*)?|\.gsd(?:[./].*)?|\.bg-shell(?:\/.*)?|Python(?:\/.*)?|NUL)$/i.test(
        entry,
      ),
    );
    if (forbiddenPackageEntries.length > 0) {
      throw new Error(
        `VSIX contains workspace-local or secret files: ${forbiddenPackageEntries
          .slice(0, 10)
          .join(', ')}`,
      );
    }

    const extractedRoot = path.join(tempDir, 'extracted');
    zip.extractAllTo(extractedRoot, true);
    const extensionRoot = path.join(extractedRoot, 'extension');

    const census = buildArchiveCensus(entryNames);
    const allowlistResult = evaluateAllowlist(census, PACKAGING_ALLOWLIST);
    const missingEntrypoints = findMissingEntrypoints(
      entryNames,
      REQUIRED_ARCHIVE_ENTRYPOINTS,
    );
    const entrypoints = buildEntrypointResults({
      entryNames,
      requiredEntrypoints: REQUIRED_ARCHIVE_ENTRYPOINTS,
      fileExists: (archivePath) => {
        // archivePath is like extension/dist/src/extension.js
        const relative = archivePath.replace(/^extension\//, '');
        const full = path.join(extensionRoot, relative);
        try {
          const st = fs.statSync(full);
          return st.isFile() && st.size > 0;
        } catch {
          return false;
        }
      },
    });

    const report = formatCensusReport(census, allowlistResult, missingEntrypoints);
    console.log(report);
    console.log('[packaging-gate] entrypoint verdicts:');
    for (const r of entrypoints) {
      console.log(
        `  ${r.path}: present=${r.present} resolved=${r.resolved} phase=${r.phase}`,
      );
    }

    // Intermediate packaging evidence does not require host yet; host stage promotes to 'full'.
    const evidence = buildPackagingGateEvidence({
      census,
      allowlistResult,
      missingEntrypoints,
      entrypoints,
      mode: censusOnly ? 'census-only' : 'packaging',
      activation: 'deferred',
      bridge: null,
      bridgePhase: null,
      durationMs: Date.now() - started,
    });

    writeEvidence(evidencePath, evidence);
    console.log(
      `[packaging-gate] wrote evidence ${path.relative(root, evidencePath)} ` +
        `(totalEntries=${evidence.totalEntries}, nodeModulesEntryCount=${evidence.nodeModulesEntryCount})`,
    );

    if (!evidence.ok) {
      const reasons = [];
      if (!allowlistResult.ok) {
        reasons.push(
          `allowlist violations: ${allowlistResult.violations.slice(0, 20).join(', ')}`,
        );
      }
      if (missingEntrypoints.length > 0) {
        reasons.push(`missing entrypoints: ${missingEntrypoints.join(', ')}`);
      }
      const failedEps = entrypoints.filter((r) => !r.present || !r.resolved);
      if (failedEps.length > 0) {
        reasons.push(
          `entrypoint failures: ${failedEps.map((r) => `${r.path}(${r.phase})`).join(', ')}`,
        );
      }
      throw new Error(`packaging gate failed: ${reasons.join('; ')}`);
    }

    return {
      evidence,
      tempDir,
      extensionRoot,
      vsixPath,
      started,
      packagingOk: true,
    };
  } catch (err) {
    // Best-effort cleanup on failure; success path also cleans in finally of main.
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Launch a real Extension Host against the extracted archive and merge host observations.
 *
 * @param {{
 *   extensionRoot: string,
 *   tempDir: string,
 *   evidence: ReturnType<typeof buildPackagingGateEvidence>,
 *   evidencePath: string,
 *   started: number,
 * }} args
 */
async function runHostStage({ extensionRoot, tempDir, evidence, evidencePath, started }) {
  const compiledTest = path.join(root, 'dist', 'scripts', 'packaging-gate-extension-host-smoke.js');
  if (!fs.existsSync(compiledTest)) {
    throw new Error(
      'vscode:prepublish did not produce dist/scripts/packaging-gate-extension-host-smoke.js',
    );
  }

  const hostResultPath = path.join(tempDir, 'packaging-host-smoke-result.json');
  const workspacePath = path.join(tempDir, 'workspace');
  const userDataDir = path.join(tempDir, 'user-data');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const version = process.env.MUSTER_VSCODE_VERSION || 'stable';
  const vscodeExecutablePath = process.env.MUSTER_VSCODE_EXECUTABLE_PATH;
  const downloadTimeout = Number.parseInt(
    process.env.MUSTER_VSCODE_DOWNLOAD_TIMEOUT_MS || '180000',
    10,
  );

  console.log('[packaging-gate] Extension Host stage…');
  let hostRunError = null;
  try {
    await runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : { version }),
      timeout: Number.isFinite(downloadTimeout) ? downloadTimeout : 180_000,
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: compiledTest,
      extensionTestsEnv: {
        MUSTER_UAT_MODE: '1',
        MUSTER_PACKAGING_HOST_RESULT_OUT: hostResultPath,
      },
      launchArgs: [
        workspacePath,
        `--user-data-dir=${userDataDir}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-extensions',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-updates',
        '--no-cached-data',
      ],
    });
  } catch (err) {
    hostRunError = err;
  }

  let rawHost = null;
  if (fs.existsSync(hostResultPath)) {
    try {
      rawHost = JSON.parse(fs.readFileSync(hostResultPath, 'utf8'));
    } catch {
      rawHost = null;
    }
  }

  const hostResult = parseHostSmokeResult(rawHost);
  if (hostRunError && hostResult.activation === 'ok' && hostResult.ok) {
    // Host asserted ok but runner still threw — surface as activation failure.
    hostResult.ok = false;
    hostResult.activation = 'failed';
    hostResult.bridgePhase = 'activation';
    hostResult.detail =
      hostRunError instanceof Error ? hostRunError.message : String(hostRunError);
  } else if (hostRunError && !rawHost) {
    // Keep parseHostSmokeResult activation failure, attach runner error detail.
    hostResult.detail =
      hostRunError instanceof Error ? hostRunError.message : String(hostRunError);
  }

  const merged = applyHostStageToEvidence(evidence, hostResult);
  merged.durationMs = Date.now() - started;
  writeEvidence(evidencePath, merged);

  console.log(
    `[packaging-gate] host stage: activation=${merged.activation} ` +
      `bridge=${merged.bridge ? `${merged.bridge.status}@${merged.bridge.port}` : 'null'} ` +
      `bridgePhase=${merged.bridgePhase ?? 'n/a'} ok=${merged.ok}`,
  );
  for (const r of merged.entrypoints) {
    console.log(
      `  ${r.path}: present=${r.present} resolved=${r.resolved} phase=${r.phase}` +
        (r.detail ? ` detail=${r.detail}` : ''),
    );
  }

  if (!merged.ok) {
    const reasons = [];
    if (merged.activation !== 'ok') {
      reasons.push(`activation=${merged.activation}`);
    }
    if (!(merged.bridge && merged.bridge.status === 'ok' && merged.bridge.port > 0)) {
      reasons.push(`bridgePhase=${merged.bridgePhase ?? 'unknown'}`);
    }
    const failedEps = (merged.entrypoints ?? []).filter(
      (r) => !r.present || !r.resolved || r.phase !== 'ok',
    );
    if (failedEps.length > 0) {
      reasons.push(
        `entrypoint failures: ${failedEps.map((r) => `${r.path}(${r.phase})`).join(', ')}`,
      );
    }
    if (merged.hostDetail) {
      reasons.push(String(merged.hostDetail));
    }
    throw new Error(`packaging gate host stage failed: ${reasons.join('; ')}`);
  }

  return merged;
}

async function main() {
  const argv = process.argv.slice(2);
  const censusOnly = argv.includes('--census-only');
  const evidenceArgIdx = argv.indexOf('--evidence');
  const evidencePath =
    evidenceArgIdx >= 0 && argv[evidenceArgIdx + 1]
      ? path.resolve(argv[evidenceArgIdx + 1])
      : process.env.MUSTER_PACKAGING_GATE_EVIDENCE_OUT
        ? path.resolve(process.env.MUSTER_PACKAGING_GATE_EVIDENCE_OUT)
        : DEFAULT_EVIDENCE_PATH;

  const result = await runPackagingStage({ censusOnly, evidencePath });

  try {
    if (!censusOnly) {
      await runHostStage({
        extensionRoot: result.extensionRoot,
        tempDir: result.tempDir,
        evidence: result.evidence,
        evidencePath,
        started: result.started,
      });
    }
  } finally {
    try {
      fs.rmSync(result.tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error('[packaging-gate] FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
