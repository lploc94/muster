import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidencePath = new URL('../docs/VERIFICATION-EVIDENCE.md', import.meta.url);

const requiredHeadings = [
  '# M002 Verification Evidence',
  '## Scope',
  '## Evidence Ledger',
  '## Contract Proof',
  '## Integration Proof',
  '## Operational Proof',
  '## Artifact-Driven UAT Proof',
  '## Requirement Impact',
  '## Non-Live Limitations',
  '## Redaction Rules',
  '## Failure Modes',
  '## Load Profile',
  '## Negative Tests',
];

const requiredProofClasses = [
  'Contract proof',
  'Integration proof',
  'Operational proof',
  'Artifact-driven UAT proof',
];

const requiredEvidenceIds = [
  '4eadab69-0625-468d-b8ea-a14ebf4c1f50',
  '1d35583d-5aa1-465b-a82f-b73e845f7b12',
  '19e55c63-33c2-4f7a-850a-d3995078c926',
  'c926e218-ec60-4024-8a7c-fda53d5e8bb1',
  '64f78de1-e31f-425b-ac37-69f3a9ceafb8',
];

const requiredFileReferences = [
  'package.json',
  '.github/workflows/ci.yml',
  'scripts/source-boundary-smoke.mjs',
  'scripts/source-boundary-smoke.test.mjs',
  'src/extension.ts',
  'src/backends/claude.ts',
  'src/runner.ts',
  'src/task/store.ts',
  'src/types.ts',
  'mcp/muster-ask-server.mjs',
];

const requiredCommandReferences = [
  'npm test',
  'npm run test:source-boundary',
  'node scripts/source-boundary-smoke.mjs',
  'node --test scripts/source-boundary-smoke.test.mjs',
  'node --test scripts/verify-verification-evidence.test.mjs',
];

const requiredRequirementIds = ['R003', 'R005', 'R006', 'R007'];

const unsupportedClaimPhrases = [
  'live VS Code activation verified',
  'real Claude CLI execution verified',
  'MCP stdio behavior verified',
  'package/release readiness verified',
  'hosted CI execution verified',
];

const forbiddenRuntimeSecretReferences = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'secret value',
  'session secret',
  '.muster-sessions.json contents',
  'runtime session contents',
];

async function readEvidenceDocument() {
  try {
    return await readFile(evidencePath, 'utf8');
  } catch (err) {
    assert.fail(`Missing verification evidence document: docs/VERIFICATION-EVIDENCE.md (${err.code ?? err.message})`);
  }
}

function assertIncludesAll(text, values, label) {
  for (const value of values) {
    assert.ok(text.includes(value), `Expected verification evidence to include ${label}: ${value}`);
  }
}

function assertExcludesAll(text, values, label) {
  for (const value of values) {
    assert.ok(!text.includes(value), `Expected verification evidence to avoid unsupported ${label}: ${value}`);
  }
}

function assertVerificationEvidence(text) {
  assert.ok(text.trim().length > 0, 'Expected docs/VERIFICATION-EVIDENCE.md to be non-empty');
  assertIncludesAll(text, requiredHeadings, 'heading');
  assertIncludesAll(text, requiredProofClasses, 'proof class');
  assertIncludesAll(text, requiredEvidenceIds, 'local evidence id');
  assertIncludesAll(text, requiredFileReferences, 'tracked file reference');
  assertIncludesAll(text, requiredCommandReferences, 'executable command reference');
  assertIncludesAll(text, requiredRequirementIds, 'requirement id');
  assertIncludesAll(
    text,
    [
      'does not read `.gsd/`',
      'does not inspect hosted services',
      'does not read runtime session files',
      'does not expose local secrets',
    ],
    'explicit limitation',
  );
  assertExcludesAll(text, unsupportedClaimPhrases, 'live-runtime claim');
  assertExcludesAll(text, forbiddenRuntimeSecretReferences, 'runtime or secret reference');
}

test('tracked verification evidence ledger satisfies the M002 proof structure', async () => {
  assertVerificationEvidence(await readEvidenceDocument());
});

test('rejects an empty evidence document', () => {
  assert.throws(() => assertVerificationEvidence(''), /non-empty/);
});

test('rejects missing proof classes, commands, files, evidence ids, and requirement ids', () => {
  const completeShape = [
    '# M002 Verification Evidence',
    ...requiredHeadings,
    ...requiredProofClasses,
    ...requiredEvidenceIds,
    ...requiredFileReferences,
    ...requiredCommandReferences,
    ...requiredRequirementIds,
    'does not read `.gsd/`',
    'does not inspect hosted services',
    'does not read runtime session files',
    'does not expose local secrets',
  ].join('\n');

  assert.throws(() => assertVerificationEvidence('# M002 Verification Evidence\n\n## Scope\n'), /heading: ## Evidence Ledger/);
  assert.throws(() => assertVerificationEvidence(completeShape.replace('Contract proof', 'Contract evidence')), /proof class: Contract proof/);
  assert.throws(
    () => assertVerificationEvidence(completeShape.replace('4eadab69-0625-468d-b8ea-a14ebf4c1f50', 'missing-evidence-id')),
    /local evidence id: 4eadab69/,
  );
  assert.throws(() => assertVerificationEvidence(completeShape.replace('package.json', 'manifest.json')), /tracked file reference: package\.json/);
  assert.throws(() => assertVerificationEvidence(completeShape.replace('npm test', 'npm verify')), /executable command reference: npm test/);
  assert.throws(() => assertVerificationEvidence(completeShape.replace('R003', 'R000')), /requirement id: R003/);
});

test('rejects unsupported live-runtime and secret/session claims', () => {
  const otherwiseValid = [
    '# M002 Verification Evidence',
    ...requiredHeadings,
    ...requiredProofClasses,
    ...requiredEvidenceIds,
    ...requiredFileReferences,
    ...requiredCommandReferences,
    ...requiredRequirementIds,
    'does not read `.gsd/`',
    'does not inspect hosted services',
    'does not read runtime session files',
    'does not expose local secrets',
  ].join('\n');

  assert.throws(
    () => assertVerificationEvidence(`${otherwiseValid}\nlive VS Code activation verified`),
    /live-runtime claim: live VS Code activation verified/,
  );
  assert.throws(
    () => assertVerificationEvidence(`${otherwiseValid}\nANTHROPIC_API_KEY`),
    /runtime or secret reference: ANTHROPIC_API_KEY/,
  );
});
