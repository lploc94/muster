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
  REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES,
} from './packaging-allowlist.mjs';
import {
  buildArchiveCensus,
  buildMarketplaceEntryResults,
  evaluateAllowlist,
  findMissingEntrypoints,
  formatCensusReport,
} from './packaging-archive-census.mjs';
import { redactInstallDetail } from './packaging-install-result.mjs';

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
 *   marketplaceEntries?: Array<{ path: string, present: boolean, actualPath?: string | null }>,
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
  marketplaceEntries,
  mode = 'census-only',
  activation = 'deferred',
  bridge = null,
  bridgePhase = null,
  generatedAt = new Date().toISOString(),
  durationMs = 0,
}) {
  const missing = Array.isArray(missingEntrypoints) ? missingEntrypoints : [];
  const eps = Array.isArray(entrypoints) ? entrypoints : [];
  const market =
    Array.isArray(marketplaceEntries) && marketplaceEntries.length > 0
      ? marketplaceEntries
      : REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES.map((path) => ({
          path,
          present: false,
          actualPath: null,
        }));
  const allowOk = allowlistResult?.ok === true;
  const entrypointsOk = eps.every((r) => r.present && r.resolved && r.phase === 'ok');
  const marketplaceOk = market.every((r) => r.present === true);
  const packagingOk = allowOk && missing.length === 0 && entrypointsOk && marketplaceOk;
  // 'full' requires live host observations; 'census-only' / 'packaging' only gate archive contents.
  const hostRequired = mode === 'full';
  const bridgeOk =
    bridge &&
    typeof bridge.port === 'number' &&
    bridge.port > 0 &&
    bridge.status === 'ok';
  const activationOk = activation === 'ok';
  const ok = packagingOk && (!hostRequired || (activationOk && bridgeOk === true));

  /** @type {PackagingGatePhase} */
  let phase;
  if (ok) {
    phase = 'ok';
  } else if (!packagingOk) {
    phase = 'archive-invalid';
  } else if (!activationOk) {
    phase = 'activation-failed';
  } else {
    phase = 'bridge-unreachable';
  }

  return {
    kind: 'm022-s01-packaging-gate',
    ok,
    phase,
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
    marketplaceEntries: market,
    activation,
    bridge,
    bridgePhase,
    generatedAt,
    durationMs,
  };
}

/**
 * Typed packaging-gate phases. `ok` is the only passing value; every other
 * value names where the gate stopped.
 *
 * @typedef {'ok'
 *   | 'gate-incomplete'
 *   | 'package-failed'
 *   | 'archive-invalid'
 *   | 'host-launch-failed'
 *   | 'activation-failed'
 *   | 'bridge-unreachable'
 *   | 'closure-failed'} PackagingGatePhase
 */

/**
 * Strip machine paths and secret-like tokens from a failure detail before it
 * reaches tracked evidence. Shares the S05 redactor so both gates redact the
 * same classes instead of drifting apart.
 *
 * @param {unknown} detail
 * @param {number} [maxLen]
 */
export function redactGateDetail(detail, maxLen = 300) {
  return redactInstallDetail(typeof detail === 'string' ? detail : '', maxLen);
}

/**
 * Build fail-closed evidence for a run that produced no archive census.
 *
 * The tracked evidence artifact is uploaded by CI with `if: always()`, so it
 * must never survive a failed run still describing an earlier successful one.
 * The runner writes this shape before `createVSIX()` and re-writes it with the
 * failure detail on the way out, which also covers a hard kill or timeout that
 * never reaches a catch block.
 *
 * @param {{
 *   phase?: PackagingGatePhase,
 *   detail?: string,
 *   mode?: string,
 *   generatedAt?: string,
 *   durationMs?: number,
 * }} args
 */
export function buildFailClosedEvidence({
  phase = 'gate-incomplete',
  detail = '',
  mode = 'census-only',
  generatedAt = new Date().toISOString(),
  durationMs = 0,
} = {}) {
  const evidence = buildPackagingGateEvidence({
    // No archive was produced, so there is nothing to census. Empty inputs make
    // buildPackagingGateEvidence compute ok:false by construction.
    census: null,
    allowlistResult: null,
    missingEntrypoints: [],
    entrypoints: [],
    marketplaceEntries: [],
    mode,
    activation: 'failed',
    bridge: null,
    bridgePhase: null,
    generatedAt,
    durationMs,
  });

  const redacted = redactGateDetail(detail);
  return {
    ...evidence,
    ok: false,
    phase,
    ...(redacted ? { failureDetail: redacted } : {}),
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
  const obj = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {'ok' | 'failed'} */
  const activation = obj.activation === 'ok' ? 'ok' : 'failed';
  /** @type {'ok' | 'activation' | 'uat-command-unavailable' | 'health-unreachable'} */
  let bridgePhase = 'activation';
  if (
    obj.bridgePhase === 'ok' ||
    obj.bridgePhase === 'activation' ||
    obj.bridgePhase === 'uat-command-unavailable' ||
    obj.bridgePhase === 'health-unreachable'
  ) {
    bridgePhase = obj.bridgePhase;
  }

  /** @type {{ port: number, status: 'ok' | 'stopping' | 'unavailable', generation: number } | null} */
  let bridge = null;
  if (obj.bridge && typeof obj.bridge === 'object') {
    const b = /** @type {Record<string, unknown>} */ (obj.bridge);
    const port = typeof b.port === 'number' && Number.isFinite(b.port) ? b.port : 0;
    const generation =
      typeof b.generation === 'number' && Number.isFinite(b.generation) ? b.generation : 0;
    /** @type {'ok' | 'stopping' | 'unavailable'} */
    let status = 'unavailable';
    if (b.status === 'ok' || b.status === 'stopping' || b.status === 'unavailable') {
      status = b.status;
    } else if (port > 0) {
      status = 'ok';
    }
    bridge = { port, status, generation };
  }

  const entrypointsRaw = Array.isArray(obj.entrypoints) ? obj.entrypoints : [];
  const entrypoints = entrypointsRaw.map((item) => {
    const e = item && typeof item === 'object' ? /** @type {Record<string, unknown>} */ (item) : {};
    /** @type {'ok' | 'missing-archive-entry' | 'require-failed' | 'spawn-failed'} */
    let phase = 'missing-archive-entry';
    if (
      e.phase === 'ok' ||
      e.phase === 'missing-archive-entry' ||
      e.phase === 'require-failed' ||
      e.phase === 'spawn-failed'
    ) {
      phase = e.phase;
    }
    return {
      path: typeof e.path === 'string' ? e.path : '',
      present: e.present === true,
      resolved: e.resolved === true,
      phase,
      ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
    };
  });

  /** @type {{ port: number, trace: 'present' | 'missing', bridgeClosed: boolean, postExitProbe: 'refused' | 'still-serving' | 'unknown', phase: string } | null} */
  let bridgeClosure = null;
  if (obj.bridgeClosure && typeof obj.bridgeClosure === 'object') {
    const c = /** @type {Record<string, unknown>} */ (obj.bridgeClosure);
    const cPort = typeof c.port === 'number' && Number.isFinite(c.port) ? c.port : 0;
    const cTrace = c.trace === 'present' || c.trace === 'missing' ? c.trace : 'missing';
    const cClosed = c.bridgeClosed === true;
    const cProbe =
      c.postExitProbe === 'refused' ||
      c.postExitProbe === 'still-serving' ||
      c.postExitProbe === 'unknown'
        ? c.postExitProbe
        : 'unknown';
    const cPhase =
      c.phase === 'ok' ||
      c.phase === 'deactivate-failed' ||
      c.phase === 'trace-missing' ||
      c.phase === 'not-closed' ||
      c.phase === 'still-serving' ||
      c.phase === 'probe-unknown'
        ? c.phase
        : 'trace-missing';
    bridgeClosure = {
      port: cPort,
      trace: cTrace,
      bridgeClosed: cClosed,
      postExitProbe: cProbe,
      phase: cPhase,
    };
  }

  const activationOk = activation === 'ok';
  const bridgeListening = bridge !== null && bridge.status === 'ok' && bridge.port > 0;
  const entrypointsOk = entrypoints.every(
    (r) => r.present === true && r.resolved === true && r.phase === 'ok',
  );
  const bridgeClosureOk =
    bridgeClosure !== null &&
    bridgeClosure.phase === 'ok' &&
    bridgeClosure.trace === 'present' &&
    bridgeClosure.bridgeClosed === true &&
    bridgeClosure.postExitProbe === 'refused' &&
    bridgeClosure.port > 0;
  // Host smoke ok requires bridge closure proof — never pid-exit inference alone.
  const ok =
    activationOk &&
    bridgeListening === true &&
    entrypointsOk &&
    bridgePhase === 'ok' &&
    bridgeClosureOk;

  return {
    kind: 'm022-s01-packaging-host-smoke',
    ok,
    activation,
    bridge,
    bridgePhase,
    bridgeClosure,
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
export function applyHostStageToEvidence(evidence, host) {
  const entrypoints = Array.isArray(host.entrypoints)
    ? host.entrypoints.map((r) => ({
        path: r.path,
        present: r.present === true,
        resolved: r.resolved === true,
        phase: r.phase,
        ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
      }))
    : [];

  const bridge =
    host.bridge &&
    typeof host.bridge.port === 'number' &&
    (host.bridge.status === 'ok' ||
      host.bridge.status === 'stopping' ||
      host.bridge.status === 'unavailable')
      ? {
          port: host.bridge.port,
          status: host.bridge.status,
          generation:
            typeof host.bridge.generation === 'number' ? host.bridge.generation : 0,
        }
      : null;

  const activationOk = host.activation === 'ok';
  const bridgeOk = bridge !== null && bridge.status === 'ok' && bridge.port > 0;
  const bridgePhaseOk = host.bridgePhase === 'ok';

  const bridgeClosure =
    host.bridgeClosure &&
    typeof host.bridgeClosure === 'object' &&
    typeof host.bridgeClosure.port === 'number' &&
    (host.bridgeClosure.trace === 'present' || host.bridgeClosure.trace === 'missing') &&
    typeof host.bridgeClosure.bridgeClosed === 'boolean' &&
    (host.bridgeClosure.postExitProbe === 'refused' ||
      host.bridgeClosure.postExitProbe === 'still-serving' ||
      host.bridgeClosure.postExitProbe === 'unknown') &&
    typeof host.bridgeClosure.phase === 'string'
      ? {
          port: host.bridgeClosure.port,
          trace: host.bridgeClosure.trace,
          bridgeClosed: host.bridgeClosure.bridgeClosed,
          postExitProbe: host.bridgeClosure.postExitProbe,
          phase: host.bridgeClosure.phase,
        }
      : null;

  const bridgeClosureOk =
    bridgeClosure !== null &&
    bridgeClosure.phase === 'ok' &&
    bridgeClosure.trace === 'present' &&
    bridgeClosure.bridgeClosed === true &&
    bridgeClosure.postExitProbe === 'refused' &&
    bridgeClosure.port > 0;

  // Prefer host.ok when present, but recompute from fields so a forged ok:true
  // cannot pass without a listening bridge, bridge closure proof, and resolved entrypoints.
  const ok =
    host.ok === true &&
    activationOk &&
    bridgeOk === true &&
    bridgePhaseOk &&
    bridgeClosureOk;

  // The packaging stage already stamped a phase for the archive-only verdict.
  // Recompute it here or a passing packaging stage would leave `phase: 'ok'`
  // sitting next to `ok: false` after the host stage fails.
  /** @type {PackagingGatePhase} */
  let phase;
  if (ok) {
    phase = 'ok';
  } else if (!activationOk) {
    phase = 'activation-failed';
  } else if (!(bridgeOk && bridgePhaseOk)) {
    phase = 'bridge-unreachable';
  } else if (!bridgeClosureOk) {
    phase = 'closure-failed';
  } else {
    // Fields all check out but host.ok was not true — a forged or truncated result.
    phase = 'gate-incomplete';
  }

  return {
    ...evidence,
    mode: 'full',
    phase,
    entrypoints,
    activation: host.activation,
    bridge,
    bridgePhase: host.bridgePhase,
    bridgeClosure,
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
  const stageMode = censusOnly ? 'census-only' : 'packaging';
  /** @type {ReturnType<typeof buildPackagingGateEvidence> | null} */
  let censusEvidence = null;

  // CI uploads the tracked evidence with `if: always()`. Stamp it fail-closed
  // before the first fallible step so a run that dies inside createVSIX — or is
  // hard-killed before any catch runs — can never leave the previous run's
  // `ok: true` on disk for release diagnostics to misread.
  writeEvidence(
    evidencePath,
    buildFailClosedEvidence({
      phase: 'gate-incomplete',
      mode: stageMode,
      detail: 'packaging gate started; no stage has completed yet',
    }),
  );

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
    const marketplaceEntries = buildMarketplaceEntryResults(
      entryNames,
      REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES,
    );

    const report = formatCensusReport(census, allowlistResult, missingEntrypoints);
    console.log(report);
    console.log('[packaging-gate] entrypoint verdicts:');
    for (const r of entrypoints) {
      console.log(
        `  ${r.path}: present=${r.present} resolved=${r.resolved} phase=${r.phase}`,
      );
    }
    console.log('[packaging-gate] marketplace archive entries:');
    for (const r of marketplaceEntries) {
      console.log(
        `  ${r.path}: present=${r.present}` +
          (r.actualPath && r.actualPath !== r.path ? ` actual=${r.actualPath}` : ''),
      );
    }

    // Intermediate packaging evidence does not require host yet; host stage promotes to 'full'.
    const evidence = buildPackagingGateEvidence({
      census,
      allowlistResult,
      missingEntrypoints,
      entrypoints,
      marketplaceEntries,
      mode: censusOnly ? 'census-only' : 'packaging',
      activation: 'deferred',
      bridge: null,
      bridgePhase: null,
      durationMs: Date.now() - started,
    });

    censusEvidence = evidence;
    // A full run still owes host observations. Persist the census payload for
    // diagnostics but withhold the passing verdict until the host stage writes
    // its merged result, so a host-stage crash or hard kill cannot leave
    // `ok: true` on disk. --census-only has no host stage, so its verdict is final.
    writeEvidence(
      evidencePath,
      censusOnly ? evidence : { ...evidence, ok: false, phase: 'gate-incomplete' },
    );
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
      const missingMarket = marketplaceEntries.filter((r) => !r.present);
      if (missingMarket.length > 0) {
        reasons.push(
          `missing marketplace entries: ${missingMarket.map((r) => r.path).join(', ')}`,
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
    const detail = err instanceof Error ? err.message : String(err);
    // Evidence must describe *this* run. Keep the census when we have one — it is
    // the diagnostic payload — but never leave a passing verdict behind.
    try {
      const failed = censusEvidence
        ? {
            ...censusEvidence,
            ok: false,
            phase: censusEvidence.phase === 'ok' ? 'gate-incomplete' : censusEvidence.phase,
          }
        : buildFailClosedEvidence({ phase: 'package-failed', mode: stageMode });
      writeEvidence(evidencePath, {
        ...failed,
        failureDetail: redactGateDetail(detail),
        durationMs: Date.now() - started,
      });
    } catch {
      // ignore evidence write errors; the original failure is rethrown below
    }
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
    const detail =
      'vscode:prepublish did not produce dist/scripts/packaging-gate-extension-host-smoke.js';
    // Nothing downstream will write evidence for this run, so stamp the failure
    // here rather than leaving the packaging-stage payload as the last word.
    writeEvidence(
      evidencePath,
      buildFailClosedEvidence({
        phase: 'host-launch-failed',
        mode: 'full',
        detail,
        durationMs: Date.now() - started,
      }),
    );
    throw new Error(detail);
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
