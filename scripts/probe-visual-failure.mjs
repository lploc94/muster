#!/usr/bin/env node
/**
 * Controlled disposable visual-failure probe (M014/S03 T02).
 *
 * Flow:
 *   1. Apply a temporary fixture color mismatch (never touch committed goldens).
 *   2. Run one pinned Linux visual case and expect a non-zero compare exit.
 *   3. Inventory expected / actual / diff / trace / failure screenshot / HTML report.
 *   4. Always restore the fixture before exiting.
 *
 * Usage:
 *   node scripts/probe-visual-failure.mjs
 *   node --test scripts/probe-visual-failure.test.mjs
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const ARTIFACT_CONTRACT = Object.freeze({
  testResultsDir: 'test-results',
  htmlReportDir: 'playwright-report',
  htmlReportIndex: 'playwright-report/index.html',
  requiredKinds: Object.freeze([
    'expected',
    'actual',
    'diff',
    'trace',
    'failureScreenshot',
    'htmlReport',
  ]),
  probeCaseId: 'V01-webview-compact-dark',
  probeSpec: 'e2e/visual/muster-webview.visual.spec.ts',
  mismatchTarget: 'e2e/fixtures/visual-environment.ts',
  /**
   * Dark-theme foreground used by V01 compact webview. Swapping this color is a
   * disposable visual delta that must fail strict maxDiffPixelRatio: 0 compares.
   */
  mismatchNeedle: "'--vscode-foreground': '#cccccc'",
  mismatchReplacement:
    "'--vscode-foreground': '#ff00aa' /* MUSTER_VISUAL_PROBE_MISMATCH */",
  probeMarker: 'MUSTER_VISUAL_PROBE_MISMATCH',
  /** Stable GitHub Actions artifact name for visual failure evidence. */
  ciArtifactName: 'visual-regression-failure',
  /** Bounded retention days for uploaded visual failure evidence. */
  ciRetentionDays: 14,
});

/**
 * Classify a repo-relative artifact path into a required kind, or null.
 * @param {string} relPath
 * @returns {string|null}
 */
export function classifyArtifact(relPath) {
  const n = String(relPath).replace(/\\/g, '/');
  if (
    n === ARTIFACT_CONTRACT.htmlReportIndex ||
    n.endsWith('/playwright-report/index.html') ||
    n.endsWith('playwright-report/index.html')
  ) {
    return 'htmlReport';
  }
  if (n.endsWith('-expected.png') || /\/[^/]+-expected\.png$/i.test(n)) {
    return 'expected';
  }
  if (n.endsWith('-actual.png') || /\/[^/]+-actual\.png$/i.test(n)) {
    return 'actual';
  }
  if (n.endsWith('-diff.png') || /\/[^/]+-diff\.png$/i.test(n)) {
    return 'diff';
  }
  if (n.endsWith('trace.zip') || /\/trace\.zip$/i.test(n)) {
    return 'trace';
  }
  if (/test-failed-\d+\.png$/i.test(n)) {
    return 'failureScreenshot';
  }
  return null;
}

/**
 * Build an inventory map kind -> relative paths from a list of relative paths.
 * @param {string[]} relPaths
 */
export function inventoryFromRelPaths(relPaths) {
  /** @type {Record<string, string[]>} */
  const inventory = {};
  for (const kind of ARTIFACT_CONTRACT.requiredKinds) {
    inventory[kind] = [];
  }
  for (const rel of relPaths) {
    const kind = classifyArtifact(rel);
    if (!kind) continue;
    if (!inventory[kind]) inventory[kind] = [];
    inventory[kind].push(rel.replace(/\\/g, '/'));
  }
  return inventory;
}

/**
 * @param {Record<string, string[]>} inventory
 * @returns {string[]}
 */
export function missingRequiredKinds(inventory) {
  return ARTIFACT_CONTRACT.requiredKinds.filter(
    (kind) => !inventory[kind] || inventory[kind].length === 0,
  );
}

/**
 * Apply the disposable probe mismatch to fixture source text.
 * @param {string} content
 */
export function applyDisposableMismatch(content) {
  if (content.includes(ARTIFACT_CONTRACT.probeMarker)) {
    throw new Error(
      'Fixture already contains probe mismatch marker; refuse to re-apply',
    );
  }
  if (!content.includes(ARTIFACT_CONTRACT.mismatchNeedle)) {
    throw new Error(
      `Mismatch needle not found in fixture (expected ${ARTIFACT_CONTRACT.mismatchNeedle})`,
    );
  }
  return content.replace(
    ARTIFACT_CONTRACT.mismatchNeedle,
    ARTIFACT_CONTRACT.mismatchReplacement,
  );
}

/**
 * Restore original fixture content when a mismatch was applied.
 * @param {string} current
 * @param {string} original
 */
export function restoreIfMismatchApplied(current, original) {
  if (current.includes(ARTIFACT_CONTRACT.probeMarker) || current !== original) {
    return original;
  }
  return current;
}

function walkFiles(absDir, baseRel = '') {
  if (!existsSync(absDir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(absDir)) {
    const abs = path.join(absDir, entry);
    const rel = baseRel ? `${baseRel}/${entry}` : entry;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkFiles(abs, rel.replace(/\\/g, '/')));
    } else if (st.isFile()) {
      out.push(rel.replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * Inventory failure artifacts under the repo root.
 * @param {string} [repoRoot]
 */
export function inventoryFailureArtifacts(repoRoot = REPO_ROOT) {
  const roots = [
    ARTIFACT_CONTRACT.testResultsDir,
    ARTIFACT_CONTRACT.htmlReportDir,
  ];
  /** @type {string[]} */
  const rels = [];
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    for (const rel of walkFiles(abs, root)) {
      rels.push(rel);
    }
  }
  return inventoryFromRelPaths(rels);
}

function clearProbeArtifactDirs(repoRoot = REPO_ROOT) {
  for (const dir of [
    ARTIFACT_CONTRACT.testResultsDir,
    ARTIFACT_CONTRACT.htmlReportDir,
  ]) {
    const abs = path.join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    rmSync(abs, { recursive: true, force: true });
  }
  mkdirSync(path.join(repoRoot, ARTIFACT_CONTRACT.testResultsDir), {
    recursive: true,
  });
}

/**
 * Run the pinned Linux visual compare for the probe case (expect failure).
 * @param {{ spawn?: typeof spawnSync, repoRoot?: string }} [opts]
 */
export function runProbeVisualCompare({
  spawn = spawnSync,
  repoRoot = REPO_ROOT,
} = {}) {
  const result = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'run-visual-baselines.mjs'),
      ARTIFACT_CONTRACT.probeSpec,
      '--grep',
      ARTIFACT_CONTRACT.probeCaseId,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    },
  );
  return result.status ?? 1;
}

/**
 * Full probe: mismatch → fail → inventory → restore.
 * @param {{ spawn?: typeof spawnSync, repoRoot?: string, skipClear?: boolean }} [opts]
 */
export function runProbe({
  spawn = spawnSync,
  repoRoot = REPO_ROOT,
  skipClear = false,
} = {}) {
  const targetAbs = path.join(repoRoot, ARTIFACT_CONTRACT.mismatchTarget);
  if (!existsSync(targetAbs)) {
    throw new Error(`Mismatch target missing: ${ARTIFACT_CONTRACT.mismatchTarget}`);
  }

  const original = readFileSync(targetAbs, 'utf8');
  let applied = false;
  /** @type {{ exitCode: number, inventory: Record<string, string[]>, missing: string[], compareExit: number }} */
  const report = {
    exitCode: 1,
    inventory: {},
    missing: [],
    compareExit: 0,
  };

  try {
    if (!skipClear) {
      clearProbeArtifactDirs(repoRoot);
    }

    const mismatched = applyDisposableMismatch(original);
    writeFileSync(targetAbs, mismatched, 'utf8');
    applied = true;
    console.log(
      `Applied disposable mismatch to ${ARTIFACT_CONTRACT.mismatchTarget} (case ${ARTIFACT_CONTRACT.probeCaseId})`,
    );

    const compareExit = runProbeVisualCompare({ spawn, repoRoot });
    report.compareExit = compareExit;

    if (compareExit === 0) {
      throw new Error(
        'Probe expected visual compare to FAIL after mismatch, but it passed (exit 0). Baselines may already match the mismatched fixture, or the probe case did not run.',
      );
    }
    if (compareExit === 2) {
      throw new Error(
        'Docker engine unavailable for probe (exit 2). Start Docker Desktop or WSL docker-ce, then re-run node scripts/probe-visual-failure.mjs.',
      );
    }

    const inventory = inventoryFailureArtifacts(repoRoot);
    report.inventory = inventory;
    const missing = missingRequiredKinds(inventory);
    report.missing = missing;

    if (missing.length > 0) {
      console.error('Missing required visual failure artifacts:');
      for (const kind of missing) {
        console.error(`  - ${kind}`);
      }
      console.error('Inventory snapshot:');
      console.error(JSON.stringify(inventory, null, 2));
      report.exitCode = 1;
      return report;
    }

    console.log('Probe verified all required visual failure artifacts:');
    for (const kind of ARTIFACT_CONTRACT.requiredKinds) {
      console.log(`  ✓ ${kind}: ${inventory[kind].join(', ')}`);
    }
    console.log(
      `CI upload contract: artifact name "${ARTIFACT_CONTRACT.ciArtifactName}" retention ${ARTIFACT_CONTRACT.ciRetentionDays}d`,
    );
    report.exitCode = 0;
    return report;
  } finally {
    if (applied) {
      writeFileSync(targetAbs, original, 'utf8');
      console.log(`Restored ${ARTIFACT_CONTRACT.mismatchTarget}`);
    } else {
      try {
        const cur = readFileSync(targetAbs, 'utf8');
        if (cur.includes(ARTIFACT_CONTRACT.probeMarker)) {
          writeFileSync(targetAbs, original, 'utf8');
          console.log(`Force-restored ${ARTIFACT_CONTRACT.mismatchTarget}`);
        }
      } catch {
        // ignore
      }
    }
  }
}

function main() {
  try {
    const report = runProbe();
    if (report.exitCode !== 0) {
      console.error(
        `probe-visual-failure FAILED (compareExit=${report.compareExit}, missing=${report.missing.join(',') || 'none'})`,
      );
    } else {
      console.log('probe-visual-failure PASSED');
    }
    return report.exitCode;
  } catch (err) {
    console.error(`probe-visual-failure ERROR: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  process.exitCode = main();
}
