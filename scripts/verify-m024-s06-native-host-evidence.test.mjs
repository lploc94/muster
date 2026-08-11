import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidenceUrl = new URL('../docs/uat/m024-s06-native-host-evidence.md', import.meta.url);
const smokeUrl = new URL('./sqlite-extension-host-smoke.ts', import.meta.url);
const hostUrl = new URL('./m024-s06-workflow-graph-host.ts', import.meta.url);
const runnerUrl = new URL('./run-m024-s06-workflow-graph-uat.mjs', import.meta.url);
const assemblyUrl = new URL('./m024-s06-workflow-graph-evidence-assembly.mjs', import.meta.url);

export function validateNativeHostEvidence(text) {
  assert.match(text, /^# M024 S06 Native Host Workflow Graph Evidence$/m);
  for (const heading of [
    '## Proof Boundary',
    '## Observation',
    '## Objective Command Evidence',
    '## Why Supportive Evidence Is Not Substituted',
    '## Failure Modes',
    '## Load Profile',
    '## Negative Tests',
  ]) {
    assert.match(text, new RegExp(`^${heading}$`, 'm'), `missing ${heading}`);
  }

  assert.match(text, /^- Verdict: (?:PASS|ENVIRONMENT BLOCKED)$/m);
  assert.match(text, /requestWorkflowGraph/);
  assert.match(text, /workflowGraphResult/);
  assert.match(text, /sqlite-extension-host-smoke\.ts/);
  assert.match(text, /does not contain|lacks|cannot establish/i);
  assert.match(text, /Vite|mocked webview|Playwright/i);
  assert.match(text, /cannot replace|not substituted|does not establish/i);
  assert.match(text, /exit code:/i);

  const blocked = /^- Verdict: ENVIRONMENT BLOCKED$/m.test(text);
  if (blocked) {
    assert.match(text, /deterministic|structural/i, 'blocked result needs a deterministic constraint');
    assert.match(text, /no graph-specific native host entry point|cannot produce.*graph-specific/i);
    return;
  }

  // D094: PASS must name the graph-specific executable proof, not merely an
  // unrelated green host smoke. Counts are the redacted durable observation.
  assert.match(text, /npm run test:m024-s06-workflow-graph-live-uat/);
  assert.match(text, /scripts\/m024-s06-workflow-graph-host\.ts/);
  assert.match(text, /scripts\/run-m024-s06-workflow-graph-uat\.mjs/);
  assert.match(text, /live-extension-host-transport/);
  assert.match(text, /Correlated round trip/i);
  assert.match(text, /5 nodes, 4 edges, 4 reused nodes, 4 reused edges/i);
  assert.match(text, /identifier redaction|task IDs, run IDs, request IDs/i);
  assert.match(text, /fails closed/i);
}

test('tracked M024 S06 evidence records a bounded native graph PASS or explicit block', async () => {
  const text = await readFile(evidenceUrl, 'utf8');
  validateNativeHostEvidence(text);
});

test('PASS evidence names the graph-specific runner rather than laundering SQLite smoke', () => {
  const genericPass = `# M024 S06 Native Host Workflow Graph Evidence
## Proof Boundary
## Observation
- Verdict: PASS
## Objective Command Evidence
npm run test:sqlite-extension-host
requestWorkflowGraph workflowGraphResult sqlite-extension-host-smoke.ts does not contain
## Why Supportive Evidence Is Not Substituted
Vite mocked webview Playwright cannot replace
## Failure Modes
exit code: 0
## Load Profile
## Negative Tests`;
  assert.throws(() => validateNativeHostEvidence(genericPass), /workflow-graph-live-uat|host\.ts/);
});

test('the native SQLite smoke pins packaged schema to its source tree but stays graph-free', async () => {
  const smoke = await readFile(smokeUrl, 'utf8');
  // Deliberately version-agnostic. Pinning the literal here forced a hand edit in two
  // files on every schema bump, and because this job runs outside vitest a missed edit
  // surfaced only as a packaged-host CI failure. Acknowledging a bump stays machine-
  // enforced by the vitest schema tests; the contract this file owns is that the
  // packaged artifact agrees with the tree it was built from.
  assert.match(smoke, /from '\.\.\/src\/task\/sqlite\/schema'/);
  assert.match(smoke, /schema\.SQLITE_SCHEMA_VERSION,\s*TREE_SCHEMA_VERSION,/);
  assert.doesNotMatch(smoke, /requestWorkflowGraph|workflowGraphResult/);
});

test('graph-specific host, runner, and fail-closed assembly keep the real transport proof', async () => {
  const [host, runner, assembly] = await Promise.all([
    readFile(hostUrl, 'utf8'),
    readFile(runnerUrl, 'utf8'),
    readFile(assemblyUrl, 'utf8'),
  ]);
  assert.match(host, /requestWorkflowGraph/);
  assert.match(host, /workflowGraphResult/);
  assert.match(host, /observeWorkflowGraphRoundTrip/);
  assert.match(runner, /createVSIX/);
  assert.match(runner, /runTests/);
  assert.match(runner, /m024-s06-workflow-graph-host\.js/);
  assert.match(assembly, /live-extension-host-transport/);
  assert.match(assembly, /did not correlate/);
  assert.match(assembly, /leaked a runtime identifier/);
});
