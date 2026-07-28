/**
 * Packaging gate runner (M022/S01).
 *
 * Packaging stage (T03): createVSIX -> extract -> census -> allowlist ->
 * entrypoint presence -> evidence JSON.
 *
 * Host stage (T04): real Extension Host against the extracted archive.
 * Until T04 lands, non-census-only runs still complete the packaging stage and
 * leave activation/bridge as deferred/null.
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
  generatedAt = new Date().toISOString(),
  durationMs = 0,
}) {
  const missing = Array.isArray(missingEntrypoints) ? missingEntrypoints : [];
  const eps = Array.isArray(entrypoints) ? entrypoints : [];
  const allowOk = allowlistResult?.ok === true;
  const entrypointsOk = eps.every((r) => r.present && r.resolved && r.phase === 'ok');
  const ok = allowOk && missing.length === 0 && entrypointsOk;

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
    generatedAt,
    durationMs,
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

    const evidence = buildPackagingGateEvidence({
      census,
      allowlistResult,
      missingEntrypoints,
      entrypoints,
      mode: censusOnly ? 'census-only' : 'full',
      // T04 replaces deferred/null with live host observations.
      activation: 'deferred',
      bridge: null,
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

    if (!censusOnly) {
      console.log(
        '[packaging-gate] host stage deferred (T04): activation/bridge remain deferred/null',
      );
    }

    return { evidence, tempDir, extensionRoot, vsixPath };
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

  // Keep temp dir only if caller needs it for a follow-on host stage (T04).
  // Packaging-only mode cleans up immediately.
  try {
    fs.rmSync(result.tempDir, { recursive: true, force: true });
  } catch {
    // ignore
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
