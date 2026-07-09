import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidencePath = new URL('../docs/uat/m003-s04/live-uat-evidence.md', import.meta.url);

const requiredHeadings = [
  '# M003 S04 Live UAT Evidence',
  '## UAT Environment',
  '## Extension Development Host Preconditions',
  '## Scenario Matrix',
  '## Evidence Records',
  '## Session Metadata and Redaction',
  '## Limitations',
  '## Commands',
  '## Final Verifier Results',
  '## Failure Modes',
  '## Load Profile',
  '## Negative Tests',
];

const requiredScenarioIds = [
  'LIVE-UAT-TASK-CREATION',
  'LIVE-UAT-RUNNING-SETTLEMENT',
  'LIVE-UAT-RUNTIME-FAILURE-RECOVERY',
  'LIVE-UAT-COMMAND-ERROR-MISSING-BACKEND',
  'LIVE-UAT-CANCELLATION',
  'LIVE-UAT-TASK-SCOPED-SESSION-METADATA',
];

const requiredEvidenceIds = [
  'EDH-EVIDENCE-PENDING-TASK-CREATION',
  'EDH-EVIDENCE-PENDING-RUNNING-SETTLEMENT',
  'EDH-EVIDENCE-PENDING-RUNTIME-RECOVERY',
  'EDH-EVIDENCE-PENDING-COMMAND-ERROR',
  'EDH-EVIDENCE-PENDING-CANCELLATION',
  'EDH-EVIDENCE-PENDING-SESSION-METADATA',
];

const requiredTrackedReferences = [
  'docs/uat/m003-s04/live-uat-evidence.md',
  'scripts/verify-live-uat-evidence.test.mjs',
  'src/extension.ts',
  'webview/src/lib/protocol.ts',
  'e2e/muster-webview-state.spec.ts',
];

const requiredCommandReferences = [
  'node --test scripts/verify-live-uat-evidence.test.mjs',
  'npm test',
  'npm run compile',
  'npx playwright test e2e/muster-webview-state.spec.ts',
];

const requiredRedactionStatements = [
  'Record only redacted high-level metadata',
  'Do not include provider tokens',
  'Do not paste raw `.muster-tasks.json` content',
  'Do not include `.gsd/` artifact content',
  'Use relative tracked source and command references only',
];

const unsupportedOrUnsafeMarkers = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'provider token:',
  'Bearer sk-',
  'sk-ant-',
  'sk-proj-',
  'unredacted session dump',
  'raw session dump',
  '.muster-sessions.json contents',
  'raw `.muster-tasks.json` content:',
  '.muster-tasks.json raw content',
  'mocked Playwright evidence proves live Extension Development Host behavior',
  'Playwright mock is live Extension Development Host proof',
];

const forbiddenRuntimeArtifactClaims = [
  'read `.gsd/` for evidence',
  'read .gsd for evidence',
  'copied `.muster-tasks.json` into this ledger',
  'copied .muster-tasks.json into this ledger',
];

async function readEvidenceDocument() {
  try {
    return await readFile(evidencePath, 'utf8');
  } catch (err) {
    assert.fail(`Missing live UAT evidence document: docs/uat/m003-s04/live-uat-evidence.md (${err.code ?? err.message})`);
  }
}

function assertIncludesAll(text, values, label) {
  for (const value of values) {
    assert.ok(text.includes(value), `Expected live UAT evidence to include ${label}: ${value}`);
  }
}

function assertExcludesAll(text, values, label) {
  for (const value of values) {
    assert.ok(!text.includes(value), `Expected live UAT evidence to avoid ${label}: ${value}`);
  }
}

function assertUsesRelativeTrackedReferences(text) {
  const absolutePathPattern = /(?:[A-Za-z]:[\\/]|\\\\|\bfile:\/\/|\/home\/|\/Users\/|\/tmp\/)/;
  assert.ok(!absolutePathPattern.test(text), 'Expected evidence to avoid absolute local paths');
  assertIncludesAll(text, requiredTrackedReferences, 'tracked source reference');
}

function assertLiveUatEvidence(text) {
  assert.ok(text.trim().length > 0, 'Expected docs/uat/m003-s04/live-uat-evidence.md to be non-empty');
  assertIncludesAll(text, requiredHeadings, 'heading');
  assertIncludesAll(text, requiredScenarioIds, 'scenario id');
  assertIncludesAll(text, requiredEvidenceIds, 'Extension Development Host evidence id slot');
  assertIncludesAll(text, requiredCommandReferences, 'command reference');
  assertIncludesAll(text, requiredRedactionStatements, 'redaction rule');
  assertUsesRelativeTrackedReferences(text);
  assertExcludesAll(text, unsupportedOrUnsafeMarkers, 'unsafe secret, raw-store, or mocked-live marker');
  assertExcludesAll(text, forbiddenRuntimeArtifactClaims, 'runtime artifact claim');
}

function completeFixture() {
  return [
    '# M003 S04 Live UAT Evidence',
    '## UAT Environment',
    'Use relative tracked source and command references only',
    'src/extension.ts',
    'webview/src/lib/protocol.ts',
    'e2e/muster-webview-state.spec.ts',
    '## Extension Development Host Preconditions',
    '## Scenario Matrix',
    ...requiredScenarioIds,
    ...requiredEvidenceIds,
    '## Evidence Records',
    '## Session Metadata and Redaction',
    'Record only redacted high-level metadata',
    'Do not include provider tokens',
    'Do not paste raw `.muster-tasks.json` content',
    'Do not include `.gsd/` artifact content',
    '## Limitations',
    '## Commands',
    ...requiredCommandReferences,
    'docs/uat/m003-s04/live-uat-evidence.md',
    'scripts/verify-live-uat-evidence.test.mjs',
    '## Final Verifier Results',
    '## Failure Modes',
    '## Load Profile',
    '## Negative Tests',
  ].join('\n');
}

test('tracked live UAT evidence ledger satisfies the M003 S04 structure', async () => {
  assertLiveUatEvidence(await readEvidenceDocument());
});

test('rejects an empty evidence document', () => {
  assert.throws(() => assertLiveUatEvidence(''), /non-empty/);
});

test('rejects missing headings, scenario IDs, redaction rules, and command references', () => {
  const valid = completeFixture();

  assert.throws(() => assertLiveUatEvidence(valid.replace('## Scenario Matrix', '## Scenarios')), /heading: ## Scenario Matrix/);
  assert.throws(
    () => assertLiveUatEvidence(valid.replace('LIVE-UAT-TASK-CREATION', 'LIVE-UAT-OTHER')),
    /scenario id: LIVE-UAT-TASK-CREATION/,
  );
  assert.throws(
    () => assertLiveUatEvidence(valid.replace('Record only redacted high-level metadata', 'Record metadata')),
    /redaction rule: Record only redacted high-level metadata/,
  );
  assert.throws(
    () => assertLiveUatEvidence(valid.replace('node --test scripts/verify-live-uat-evidence.test.mjs', 'node --test other.test.mjs')),
    /command reference: node --test scripts\/verify-live-uat-evidence.test.mjs/,
  );
});

test('rejects unsafe raw stores, provider tokens, session dumps, and mocked-live claims', () => {
  const valid = completeFixture();

  assert.throws(() => assertLiveUatEvidence(`${valid}\nANTHROPIC_API_KEY`), /unsafe secret/);
  assert.throws(() => assertLiveUatEvidence(`${valid}\nprovider token: abc123`), /unsafe secret/);
  assert.throws(() => assertLiveUatEvidence(`${valid}\nunredacted session dump`), /unsafe secret/);
  assert.throws(() => assertLiveUatEvidence(`${valid}\nraw \`.muster-tasks.json\` content:`), /unsafe secret/);
  assert.throws(
    () => assertLiveUatEvidence(`${valid}\nmocked Playwright evidence proves live Extension Development Host behavior`),
    /mocked-live marker/,
  );
});

test('rejects absolute paths and structurally complete but scenario-incomplete documents', () => {
  const valid = completeFixture();

  assert.throws(() => assertLiveUatEvidence(`${valid}\nD:/_Dev/muster/.gsd-worktrees/M003/src/extension.ts`), /absolute local paths/);
  assert.throws(
    () => assertLiveUatEvidence(valid.replace('EDH-EVIDENCE-PENDING-CANCELLATION', 'EDH-EVIDENCE-PENDING-OTHER')),
    /Extension Development Host evidence id slot: EDH-EVIDENCE-PENDING-CANCELLATION/,
  );
});
