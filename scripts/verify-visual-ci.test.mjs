/**
 * M014/S03 visual CI contract.
 *
 * Guards the repository-local wiring that makes the pinned Linux visual matrix a
 * blocking, diagnosable PR gate:
 * - compare vs explicit baseline-update commands stay separate
 * - CI runs compare-only (`npm run test:visual:linux`) never --update-snapshots
 * - failure artifacts use a stable name with bounded retention
 * - the existing behavioral CI job remains intact and independent
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const STABLE_ARTIFACT_NAME = 'visual-regression-failure';
const MAX_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;

function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

function nonCommentLines(text) {
  return normalizeNewlines(text)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
}

/**
 * Validate package.json visual script separation.
 * @param {Record<string, string> | undefined} scripts
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateVisualPackageScripts(scripts = {}) {
  const errors = [];
  const compare = scripts['test:visual:linux'];
  const update = scripts['test:visual:linux:update'];
  const hostCompare = scripts['test:visual'];
  const hostUpdate = scripts['test:visual:update'];

  if (typeof compare !== 'string' || !compare.includes('run-visual-baselines.mjs')) {
    errors.push(
      'package.json scripts["test:visual:linux"] must invoke scripts/run-visual-baselines.mjs for pinned Linux compare',
    );
  } else if (/(?:^|[\s"'])--update(?:-snapshots)?(?:\s|$)/.test(compare)) {
    errors.push(
      'package.json scripts["test:visual:linux"] must be compare-only (no --update / --update-snapshots)',
    );
  }

  if (
    typeof update !== 'string' ||
    !update.includes('run-visual-baselines.mjs') ||
    !/(?:^|[\s"'])--update(?:\s|$)/.test(update)
  ) {
    errors.push(
      'package.json scripts["test:visual:linux:update"] must invoke run-visual-baselines.mjs with --update for explicit authoring',
    );
  }

  if (typeof hostCompare === 'string' && /(?:^|[\s"'])--update-snapshots(?:\s|$)/.test(hostCompare)) {
    errors.push(
      'package.json scripts["test:visual"] must be host compare-only (no --update-snapshots)',
    );
  }

  if (
    typeof hostUpdate === 'string' &&
    !/(?:^|[\s"'])--update-snapshots(?:\s|$)/.test(hostUpdate)
  ) {
    errors.push(
      'package.json scripts["test:visual:update"] must pass --update-snapshots for explicit host authoring',
    );
  }

  if (compare && update && compare === update) {
    errors.push('compare and update Linux visual scripts must not be identical');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate GitHub Actions visual CI workflow contract (text-level, no YAML dep).
 * @param {string} workflowText
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateVisualCiWorkflow(workflowText) {
  const errors = [];
  const text = normalizeNewlines(workflowText ?? '');
  const lines = nonCommentLines(text);

  if (!text.trim()) {
    return { ok: false, errors: ['.github/workflows/ci.yml is empty or missing'] };
  }

  // Behavioral job remains present and independently required.
  // Accept both "- run:" and multi-key steps where run is a sibling field under - name:.
  const hasRun = (command) =>
    lines.some((line) => new RegExp(`^\\s*-?\\s*run:\\s*${command}\\s*$`).test(line));
  const hasBehavioralWebview = hasRun('npm run test:webview');
  const hasNpmTest = hasRun('npm test');
  if (!hasNpmTest) {
    errors.push(
      'behavioral CI path must still run `npm test` (do not replace the existing verifier with visual-only)',
    );
  }
  if (!hasBehavioralWebview) {
    errors.push(
      'behavioral CI path must still run `npm run test:webview` independently of the visual gate',
    );
  }

  // Distinct visual job (job id `visual:` at jobs indent).
  const hasVisualJob = /^ {2}visual:\s*$/m.test(text);
  if (!hasVisualJob) {
    errors.push(
      'CI must define a top-level jobs.visual job so the visual gate is a distinct required check',
    );
  }

  // Compare-only command inside visual job.
  const hasVisualCompare = hasRun('npm run test:visual:linux');
  if (!hasVisualCompare) {
    errors.push(
      'visual CI job must run `npm run test:visual:linux` (pinned Linux Chromium compare)',
    );
  }

  // Never auto-update snapshots in standing CI (ignore comments).
  if (lines.some((line) => /(?:^|[\s"'])--update-snapshots(?:\s|$|"|')/.test(line))) {
    errors.push(
      'CI must never pass --update-snapshots (baselines are explicit-update only)',
    );
  }
  if (lines.some((line) => /test:visual:linux:update/.test(line))) {
    errors.push(
      'CI must never run test:visual:linux:update (authoring is explicit and local)',
    );
  }
  // Stronger: any update script in run steps is forbidden.
  if (lines.some((line) => /^\s*-\s*run:.*test:visual(?::linux)?:update\b/.test(line))) {
    errors.push('CI run steps must not invoke any visual update script');
  }

  // Stable failure artifact name + bounded retention.
  // Accept both "- uses:" and multi-key steps where uses is a sibling field.
  const hasUploadAction = lines.some((line) =>
    /^\s*-?\s*uses:\s*actions\/upload-artifact@v4\s*$/.test(line),
  );
  if (!hasUploadAction) {
    errors.push(
      'visual CI must upload failure evidence via actions/upload-artifact@v4',
    );
  }

  const nameLine = lines.find((line) =>
    new RegExp(`^\\s*name:\\s*${STABLE_ARTIFACT_NAME}\\s*$`).test(line),
  );
  if (!nameLine) {
    errors.push(
      `visual failure artifact name must be exactly "${STABLE_ARTIFACT_NAME}" for stable download paths`,
    );
  }

  const retentionLine = lines.find((line) => /^\s*retention-days:\s*\d+\s*$/.test(line));
  if (!retentionLine) {
    errors.push(
      'visual failure artifact upload must set retention-days (bounded retention)',
    );
  } else {
    const days = Number(retentionLine.match(/retention-days:\s*(\d+)/)?.[1]);
    if (
      !Number.isFinite(days) ||
      days < MIN_RETENTION_DAYS ||
      days > MAX_RETENTION_DAYS
    ) {
      errors.push(
        `visual failure artifact retention-days must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} (got ${days})`,
      );
    }
  }

  // Failure-only upload keeps green runs quiet and matches "failure artifacts".
  if (!/if:\s*failure\(\)/.test(text)) {
    errors.push(
      'visual artifact upload must be gated with `if: failure()` so only failing runs retain evidence',
    );
  }

  // Evidence paths maintainers expect.
  const needsPath = (fragment) => {
    if (!text.includes(fragment)) {
      errors.push(
        `visual artifact upload paths must include ${fragment} (expected/actual/diff/trace or HTML report surface)`,
      );
    }
  };
  needsPath('test-results/');
  needsPath('playwright-report/');

  // Visual job should run on Linux (ubuntu-*).
  // Prefer checking a `visual:` block contains ubuntu-latest.
  const visualBlockMatch = text.match(
    /^ {2}visual:[\s\S]*?(?=^ {2}[A-Za-z0-9_-]+:|\Z)/m,
  );
  if (visualBlockMatch) {
    const block = visualBlockMatch[0];
    if (!/runs-on:\s*ubuntu-latest/.test(block)) {
      errors.push(
        'jobs.visual must use runs-on: ubuntu-latest (pinned Linux Chromium environment)',
      );
    }
    if (!/npm run test:visual:linux/.test(block)) {
      errors.push(
        'jobs.visual must contain the compare command `npm run test:visual:linux`',
      );
    }
    const blockLines = nonCommentLines(block);
    if (
      blockLines.some(
        (line) =>
          /(?:^|[\s"'])--update-snapshots(?:\s|$|"|')/.test(line) ||
          /test:visual:linux:update/.test(line),
      )
    ) {
      errors.push('jobs.visual must never update snapshots');
    }
  }

  // Workflow still triggers on PR + main push.
  if (!/^\s*push:\s*$/m.test(text) || !/branches:\s*\[main\]/.test(text)) {
    errors.push('CI must still trigger on push to main');
  }
  if (!/^\s*pull_request:\s*$/m.test(text)) {
    errors.push('CI must still trigger on pull_request to main');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Combined contract used by positive + negative tests.
 * @param {{ packageJson?: object, workflow?: string }} input
 */
export function validateVisualCiContract(input = {}) {
  const errors = [];
  const scripts = input.packageJson?.scripts ?? {};
  const pkg = validateVisualPackageScripts(scripts);
  const wf = validateVisualCiWorkflow(input.workflow ?? '');
  errors.push(...pkg.errors, ...wf.errors);
  return { ok: errors.length === 0, errors };
}

function loadRepoPackageJson() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
}

function loadRepoWorkflow() {
  return readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
}

describe('visual CI contract (M014 S03 T01)', () => {
  it('repository package scripts separate compare from explicit baseline update', () => {
    const packageJson = loadRepoPackageJson();
    const result = validateVisualPackageScripts(packageJson.scripts);
    assert.equal(
      result.ok,
      true,
      `package visual script contract failed:\n${result.errors.join('\n')}`,
    );
  });

  it('repository CI runs pinned Linux compare with stable bounded failure artifacts', () => {
    const workflow = loadRepoWorkflow();
    const result = validateVisualCiWorkflow(workflow);
    assert.equal(
      result.ok,
      true,
      `visual CI workflow contract failed:\n${result.errors.join('\n')}`,
    );
  });

  it('combined repository contract passes', () => {
    const result = validateVisualCiContract({
      packageJson: loadRepoPackageJson(),
      workflow: loadRepoWorkflow(),
    });
    assert.equal(
      result.ok,
      true,
      `combined visual CI contract failed:\n${result.errors.join('\n')}`,
    );
  });

  it('rejects compare script that auto-updates snapshots (negative)', () => {
    const result = validateVisualPackageScripts({
      'test:visual:linux': 'node scripts/run-visual-baselines.mjs --update',
      'test:visual:linux:update': 'node scripts/run-visual-baselines.mjs --update',
      'test:visual': 'playwright test e2e/visual --project=visual-chromium --update-snapshots',
      'test:visual:update': 'playwright test e2e/visual --project=visual-chromium --update-snapshots',
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /compare-only/.test(e)));
  });

  it('rejects workflow that updates snapshots or lacks visual job (negative)', () => {
    const bad = `
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  compile:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run test:webview
      - run: npm run test:visual:linux -- --update-snapshots
`;
    const result = validateVisualCiWorkflow(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /jobs\.visual|update-snapshots|visual CI job/i.test(e)));
  });

  it('rejects unbounded or misnamed failure artifacts (negative)', () => {
    const bad = `
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  compile:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run test:webview
  visual:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:visual:linux
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: pw-stuff-\${{ github.run_id }}
          path: |
            test-results/
            playwright-report/
          retention-days: 90
`;
    const result = validateVisualCiWorkflow(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /visual-regression-failure/.test(e)));
    assert.ok(result.errors.some((e) => /retention-days/.test(e)));
  });
});
