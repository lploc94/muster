/**
 * Contract tests for the controlled visual-failure probe (M014/S03 T02).
 * Pure inventory / mismatch helpers must fail closed before the e2e runner runs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ARTIFACT_CONTRACT,
  applyDisposableMismatch,
  classifyArtifact,
  inventoryFromRelPaths,
  missingRequiredKinds,
  restoreIfMismatchApplied,
} from './probe-visual-failure.mjs';

describe('probe-visual-failure artifact contract', () => {
  it('names stable roots for test-results and playwright-report', () => {
    assert.equal(ARTIFACT_CONTRACT.testResultsDir, 'test-results');
    assert.equal(ARTIFACT_CONTRACT.htmlReportDir, 'playwright-report');
    assert.equal(ARTIFACT_CONTRACT.htmlReportIndex, 'playwright-report/index.html');
    assert.equal(ARTIFACT_CONTRACT.probeCaseId, 'V01-webview-compact-dark');
    assert.equal(
      ARTIFACT_CONTRACT.mismatchTarget,
      'e2e/fixtures/visual-environment.ts',
    );
    assert.deepEqual(ARTIFACT_CONTRACT.requiredKinds, [
      'expected',
      'actual',
      'diff',
      'trace',
      'failureScreenshot',
      'htmlReport',
    ]);
  });

  it('classifies Playwright comparison and retain-on-failure artifacts', () => {
    assert.equal(
      classifyArtifact(
        'test-results/visual-V01/V01-webview-compact-dark-expected.png',
      ),
      'expected',
    );
    assert.equal(
      classifyArtifact(
        'test-results/visual-V01/V01-webview-compact-dark-actual.png',
      ),
      'actual',
    );
    assert.equal(
      classifyArtifact(
        'test-results/visual-V01/V01-webview-compact-dark-diff.png',
      ),
      'diff',
    );
    assert.equal(
      classifyArtifact('test-results/visual-V01/trace.zip'),
      'trace',
    );
    assert.equal(
      classifyArtifact('test-results/visual-V01/test-failed-1.png'),
      'failureScreenshot',
    );
    assert.equal(
      classifyArtifact('playwright-report/index.html'),
      'htmlReport',
    );
    assert.equal(classifyArtifact('test-results/visual-linux-diagnostics.json'), null);
  });

  it('reports missing kinds when inventory is incomplete (negative)', () => {
    const inventory = inventoryFromRelPaths([
      'test-results/x/V01-webview-compact-dark-expected.png',
      'test-results/x/V01-webview-compact-dark-actual.png',
      // missing diff, trace, failureScreenshot, htmlReport
    ]);
    const missing = missingRequiredKinds(inventory);
    assert.ok(missing.includes('diff'));
    assert.ok(missing.includes('trace'));
    assert.ok(missing.includes('failureScreenshot'));
    assert.ok(missing.includes('htmlReport'));
    assert.ok(!missing.includes('expected'));
    assert.ok(!missing.includes('actual'));
  });

  it('accepts a complete inventory', () => {
    const inventory = inventoryFromRelPaths([
      'test-results/x/V01-webview-compact-dark-expected.png',
      'test-results/x/V01-webview-compact-dark-actual.png',
      'test-results/x/V01-webview-compact-dark-diff.png',
      'test-results/x/trace.zip',
      'test-results/x/test-failed-1.png',
      'playwright-report/index.html',
    ]);
    assert.deepEqual(missingRequiredKinds(inventory), []);
  });
});

describe('probe-visual-failure disposable mismatch helpers', () => {
  const sample = `export const THEME = {
  dark: {
    '--vscode-foreground': '#cccccc',
    '--vscode-background': '#1e1e1e',
  },
};
`;

  it('applies a unique probe marker without touching baseline paths', () => {
    const next = applyDisposableMismatch(sample);
    assert.notEqual(next, sample);
    assert.match(next, /MUSTER_VISUAL_PROBE_MISMATCH/);
    assert.doesNotMatch(next, /e2e\/visual\/.*-snapshots/);
  });

  it('rejects content that already carries the probe marker (negative)', () => {
    const polluted = applyDisposableMismatch(sample);
    assert.throws(
      () => applyDisposableMismatch(polluted),
      /already contains probe mismatch marker/i,
    );
  });

  it('rejects content missing the mismatch needle (negative)', () => {
    assert.throws(
      () => applyDisposableMismatch('export const empty = true;'),
      /mismatch needle not found/i,
    );
  });

  it('restores original content after mismatch', () => {
    const next = applyDisposableMismatch(sample);
    const restored = restoreIfMismatchApplied(next, sample);
    assert.equal(restored, sample);
  });
});
