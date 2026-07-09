import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidencePath = new URL('../docs/uat/m005-s04/add-context-live-host-evidence.md', import.meta.url);

const requiredHeadings = [
  '# M005 S04 Add Context Live Host Evidence',
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
  'ADD-CONTEXT-MENU-OPEN',
  'ADD-CONTEXT-ADD-FILE',
  'ADD-CONTEXT-BROWSE-WORKSPACE-FILES',
  'ADD-CONTEXT-SHARED-FILE-PICKED-INSERTION',
  'ADD-CONTEXT-DISABLED-FUTURE-ACTIONS',
  'ADD-CONTEXT-DISMISSAL-AND-DRAFT-PRESERVATION',
];

const requiredEvidenceIds = [
  'EDH-ADD-CONTEXT-EVIDENCE-PENDING-MENU-OPEN',
  'EDH-ADD-CONTEXT-EVIDENCE-PENDING-ADD-FILE',
  'EDH-ADD-CONTEXT-EVIDENCE-PENDING-BROWSE-WORKSPACE-FILES',
  'EDH-ADD-CONTEXT-EVIDENCE-PENDING-FILE-PICKED-INSERTION',
  'EDH-ADD-CONTEXT-EVIDENCE-PENDING-DISABLED-FUTURE-ACTIONS',
  'EDH-ADD-CONTEXT-EVIDENCE-PENDING-DISMISSAL-DRAFT-PRESERVATION',
];

const requiredTrackedReferences = [
  'docs/uat/m005-s04/add-context-live-host-evidence.md',
  'scripts/verify-add-context-live-host-evidence.test.mjs',
  'webview/src/lib/context-actions.test.ts',
  'webview/src/lib/context-actions.ts',
  'webview/src/components/Composer.svelte',
  'src/host/workspace-files.test.ts',
  'src/host/workspace-files.ts',
  'src/extension.ts',
];

const requiredCommandReferences = [
  'node --test scripts/verify-add-context-live-host-evidence.test.mjs',
  'npm test -- webview/src/lib/context-actions.test.ts src/host/workspace-files.test.ts',
  'npm run test:webview',
  'npm run compile',
];

const requiredRedactionStatements = [
  'Record only redacted high-level metadata',
  'Do not include provider tokens',
  'Do not paste raw `.muster-tasks.json` content',
  'Do not include `.gsd/` artifact content',
  'Use relative tracked source and command references only',
  'Do not treat mocked browser or Playwright coverage as live Extension Development Host proof',
];

const requiredStatusBoundaryStatements = [
  'Live host scenario verdicts must be recorded as `PASS`, `FAIL`, or `BLOCKED`',
  'Use `BLOCKED` instead of inference whenever the Extension Development Host cannot be launched or interacted with',
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
  'browser test proves live host behavior',
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
    assert.fail(
      `Missing Add Context live host evidence document: docs/uat/m005-s04/add-context-live-host-evidence.md (${err.code ?? err.message})`,
    );
  }
}

function assertIncludesAll(text, values, label) {
  for (const value of values) {
    assert.ok(text.includes(value), `Expected Add Context live host evidence to include ${label}: ${value}`);
  }
}

function assertExcludesAll(text, values, label) {
  for (const value of values) {
    assert.ok(!text.includes(value), `Expected Add Context live host evidence to avoid ${label}: ${value}`);
  }
}

function assertUsesRelativeTrackedReferences(text) {
  const absolutePathPattern = /(?:[A-Za-z]:[\\/]|\\\\|\bfile:\/\/|\/home\/|\/Users\/|\/tmp\/)/;
  assert.ok(!absolutePathPattern.test(text), 'Expected Add Context evidence to avoid absolute local paths');
  assertIncludesAll(text, requiredTrackedReferences, 'tracked source reference');
}

function assertAddContextLiveHostEvidence(text) {
  assert.ok(text.trim().length > 0, 'Expected docs/uat/m005-s04/add-context-live-host-evidence.md to be non-empty');
  assertIncludesAll(text, requiredHeadings, 'heading');
  assertIncludesAll(text, requiredScenarioIds, 'Add Context scenario id');
  assertIncludesAll(text, requiredEvidenceIds, 'Extension Development Host evidence id slot');
  assertIncludesAll(text, requiredCommandReferences, 'command reference');
  assertIncludesAll(text, requiredRedactionStatements, 'redaction rule');
  assertIncludesAll(text, requiredStatusBoundaryStatements, 'live-host verdict boundary rule');
  assertUsesRelativeTrackedReferences(text);
  assertExcludesAll(text, unsupportedOrUnsafeMarkers, 'unsafe secret, raw-store, or mocked-live marker');
  assertExcludesAll(text, forbiddenRuntimeArtifactClaims, 'runtime artifact claim');
}

function completeFixture() {
  return [
    '# M005 S04 Add Context Live Host Evidence',
    '## UAT Environment',
    'Use relative tracked source and command references only',
    'Live host scenario verdicts must be recorded as `PASS`, `FAIL`, or `BLOCKED`',
    'Use `BLOCKED` instead of inference whenever the Extension Development Host cannot be launched or interacted with',
    'Do not treat mocked browser or Playwright coverage as live Extension Development Host proof',
    ...requiredTrackedReferences,
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
    '## Final Verifier Results',
    '## Failure Modes',
    '## Load Profile',
    '## Negative Tests',
  ].join('\n');
}

test('tracked Add Context live host evidence ledger satisfies the M005 S04 structure', async () => {
  assertAddContextLiveHostEvidence(await readEvidenceDocument());
});

test('rejects an empty evidence document', () => {
  assert.throws(() => assertAddContextLiveHostEvidence(''), /non-empty/);
});

test('rejects missing headings, scenario IDs, redaction rules, and command references', () => {
  const valid = completeFixture();

  assert.throws(() => assertAddContextLiveHostEvidence(valid.replace('## Scenario Matrix', '## Scenarios')), /heading: ## Scenario Matrix/);
  assert.throws(
    () => assertAddContextLiveHostEvidence(valid.replace('ADD-CONTEXT-ADD-FILE', 'ADD-CONTEXT-OTHER')),
    /Add Context scenario id: ADD-CONTEXT-ADD-FILE/,
  );
  assert.throws(
    () => assertAddContextLiveHostEvidence(valid.replace('Record only redacted high-level metadata', 'Record metadata')),
    /redaction rule: Record only redacted high-level metadata/,
  );
  assert.throws(
    () => assertAddContextLiveHostEvidence(valid.replace('node --test scripts/verify-add-context-live-host-evidence.test.mjs', 'node --test other.test.mjs')),
    /command reference: node --test scripts\/verify-add-context-live-host-evidence.test.mjs/,
  );
  assert.throws(
    () => assertAddContextLiveHostEvidence(valid.replace('Live host scenario verdicts must be recorded as `PASS`, `FAIL`, or `BLOCKED`', 'Live host scenario verdicts are optional')),
    /live-host verdict boundary rule/,
  );
});

test('rejects unsafe raw stores, provider tokens, session dumps, and mocked-live claims', () => {
  const valid = completeFixture();

  assert.throws(() => assertAddContextLiveHostEvidence(`${valid}\nANTHROPIC_API_KEY`), /unsafe secret/);
  assert.throws(() => assertAddContextLiveHostEvidence(`${valid}\nprovider token: abc123`), /unsafe secret/);
  assert.throws(() => assertAddContextLiveHostEvidence(`${valid}\nunredacted session dump`), /unsafe secret/);
  assert.throws(() => assertAddContextLiveHostEvidence(`${valid}\nraw \`.muster-tasks.json\` content:`), /unsafe secret/);
  assert.throws(
    () => assertAddContextLiveHostEvidence(`${valid}\nmocked Playwright evidence proves live Extension Development Host behavior`),
    /mocked-live marker/,
  );
});

test('rejects absolute paths and structurally complete but scenario-incomplete documents', () => {
  const valid = completeFixture();

  assert.throws(() => assertAddContextLiveHostEvidence(`${valid}\nD:/_Dev/muster/.gsd-worktrees/M005/src/extension.ts`), /absolute local paths/);
  assert.throws(
    () => assertAddContextLiveHostEvidence(valid.replace('EDH-ADD-CONTEXT-EVIDENCE-PENDING-ADD-FILE', 'EDH-ADD-CONTEXT-EVIDENCE-PENDING-OTHER')),
    /Extension Development Host evidence id slot: EDH-ADD-CONTEXT-EVIDENCE-PENDING-ADD-FILE/,
  );
});
