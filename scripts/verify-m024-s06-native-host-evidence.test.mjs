import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidenceUrl = new URL('../docs/uat/m024-s06-native-host-evidence.md', import.meta.url);
const smokeUrl = new URL('./sqlite-extension-host-smoke.ts', import.meta.url);

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
  assert.match(text, /npm run test:sqlite-extension-host/);
  assert.match(text, /requestWorkflowGraph/);
  assert.match(text, /workflowGraphResult/);
  assert.match(text, /sqlite-extension-host-smoke\.ts/);
  assert.match(text, /does not exercise|does not contain|lacks/i);
  assert.match(text, /Vite|mocked webview|Playwright/i);
  assert.match(text, /cannot replace|not substituted|does not establish/i);
  assert.match(text, /exit code:/i);

  const blocked = /^- Verdict: ENVIRONMENT BLOCKED$/m.test(text);
  if (blocked) {
    assert.match(text, /deterministic|structural/i, 'blocked result needs a deterministic constraint');
    assert.match(text, /no graph-specific native host entry point|cannot produce.*graph-specific/i);
  }
}

test('tracked M024 S06 evidence records a bounded native graph PASS or explicit block', async () => {
  const text = await readFile(evidenceUrl, 'utf8');
  validateNativeHostEvidence(text);
});

test('the native SQLite smoke asserts the shipped schema-v3 baseline but has no graph probe', async () => {
  const smoke = await readFile(smokeUrl, 'utf8');
  assert.match(smoke, /schema\.SQLITE_SCHEMA_VERSION,\s*3,/);
  assert.doesNotMatch(smoke, /requestWorkflowGraph|workflowGraphResult/);
});

test('rejects a generic green SQLite-host claim without graph identifiers', () => {
  assert.throws(
    () => validateNativeHostEvidence('# M024 S06 Native Host Workflow Graph Evidence\n- Verdict: PASS\n'),
    /missing|requestWorkflowGraph|workflowGraphResult/,
  );
});
