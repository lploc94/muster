import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidencePath = new URL('../docs/uat/m007-s02/file-drop-live-host-evidence.md', import.meta.url);

const scenarios = [
  'FILE-DROP-EXPLORER',
  'FILE-DROP-OS-FILE-MANAGER',
  'FILE-DROP-CARET-INSERTION',
  'FILE-DROP-PATH-WITH-SPACES',
  'FILE-DROP-OUTSIDE-WORKSPACE',
  'FILE-DROP-DISABLED-COMPOSER',
  'FILE-DROP-MALFORMED-PAYLOAD',
  'FILE-DROP-CLEANUP-RELOAD',
];
const fields = ['Verdict:', 'Timestamp:', 'Expected:', 'Observed:', 'Blocker:', 'Cleanup:', 'Evidence:'];
const headings = ['# M007 S02 File Drop Live Host Evidence', '## Proof Boundary', '## Scenario Evidence', '## Redaction Rules', '## Failure Modes', '## Load Profile', '## Negative Tests'];
const forbidden = [
  /\b(?:PENDING|TODO|TBD|FIXME)\b/i,
  /(?:ANTHROPIC|OPENAI|GITHUB|AZURE|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)/i,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]+/i,
  /(?:[A-Za-z]:[\\/]|\\\\|\bfile:\/\/|\/home\/|\/Users\/|\/tmp\/)/,
  /raw (?:task[- ]store|transcript|\.muster-tasks\.json|\.muster-sessions\.json)/i,
  /(?:mocked|Playwright|browser) (?:result|test|evidence).{0,40}(?:proves|is) live/i,
];

function scenarioSection(text, id) {
  const marker = `### ${id}`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `Missing required scenario: ${id}`);
  const next = text.indexOf('\n### ', start + marker.length);
  return text.slice(start, next === -1 ? text.length : next);
}

function validate(text) {
  assert.ok(text.trim(), 'Evidence ledger must be non-empty');
  for (const heading of headings) assert.ok(text.includes(heading), `Missing heading: ${heading}`);
  const scenarioEvidence = text.slice(text.indexOf('## Scenario Evidence'), text.indexOf('## Redaction Rules'));
  for (const pattern of forbidden) assert.ok(!pattern.test(scenarioEvidence), `Forbidden evidence content: ${pattern}`);

  for (const id of scenarios) {
    const section = scenarioSection(text, id);
    for (const field of fields) assert.ok(section.includes(`- ${field}`), `${id} missing field ${field}`);
    const verdict = section.match(/^- Verdict: (.+)$/m)?.[1];
    assert.match(verdict ?? '', /^(PASS|FAIL|ENVIRONMENT BLOCKED)$/, `${id} has invalid verdict`);
    assert.match(section, /^- Timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m, `${id} has invalid UTC timestamp`);
    for (const field of fields.slice(2)) {
      const value = section.match(new RegExp(`^- ${field.replace(':', '')}: (.+)$`, 'm'))?.[1]?.trim();
      assert.ok(value && value !== 'N/A' && value !== 'None', `${id} has unbounded ${field}`);
      assert.ok(value.length <= 500, `${id} ${field} exceeds 500 characters`);
    }
    if (verdict === 'ENVIRONMENT BLOCKED') {
      assert.match(section, /^- Blocker: Attempted: .+ Blocker: .+$/m, `${id} blocked verdict needs attempted step and blocker`);
    }
    if (verdict === 'PASS' || verdict === 'FAIL') {
      assert.match(section, /^- Evidence: (?!supportive-only:).+$/m, `${id} live verdict needs direct evidence`);
    }
  }
  return true;
}

function validFixture() {
  const records = scenarios.map((id) => `### ${id}\n- Verdict: ENVIRONMENT BLOCKED\n- Timestamp: 2026-07-11T00:00:00Z\n- Expected: Observe the named behavior in a live Extension Development Host.\n- Observed: Live behavior could not be observed in this contract-establishment run.\n- Blocker: Attempted: reserve the scenario for live execution. Blocker: live host execution belongs to T02.\n- Cleanup: No scenario-created UI or files exist; later runs must close created UI and reload if exercised.\n- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs`);
  return `${headings[0]}\n\n${headings[1]}\nOnly direct Extension Development Host observation can establish PASS or FAIL. Local tests are supportive-only.\n\n${headings[2]}\n\n${records.join('\n\n')}\n\n${headings.slice(3).join('\nSafe bounded text.\n')}`;
}

test('tracked file-drop live-host ledger satisfies the complete contract', async () => {
  let text;
  try { text = await readFile(evidencePath, 'utf8'); }
  catch (error) { assert.fail(`Missing file-drop live-host evidence ledger (${error.code ?? error.message})`); }
  assert.equal(validate(text), true);
});

test('rejects omitted scenarios, invalid verdicts, malformed timestamps, and missing fields', () => {
  const valid = validFixture();
  assert.throws(() => validate(valid.replace('### FILE-DROP-EXPLORER', '### OTHER')), /Missing required scenario/);
  assert.throws(() => validate(valid.replace('Verdict: ENVIRONMENT BLOCKED', 'Verdict: BLOCKED')), /invalid verdict/);
  assert.throws(() => validate(valid.replace('2026-07-11T00:00:00Z', 'yesterday')), /invalid UTC timestamp/);
  assert.throws(() => validate(valid.replace('- Cleanup:', '- Teardown:')), /missing field Cleanup/);
});

test('rejects placeholders, secrets, absolute paths, raw stores, transcripts, and mocked-live promotion', () => {
  const valid = validFixture();
  for (const unsafe of ['TODO', 'OPENAI_API_KEY', 'D:/private/work.txt', 'raw task-store', 'raw transcript', 'Playwright evidence proves live behavior']) {
    assert.throws(() => validate(valid.replace('## Redaction Rules', `${unsafe}\n\n## Redaction Rules`)), /Forbidden evidence content/);
  }
});

test('requires actionable blockers, bounded fields, cleanup, and direct evidence for live verdicts', () => {
  const valid = validFixture();
  assert.throws(() => validate(valid.replace('Attempted: reserve the scenario for live execution. Blocker: live host execution belongs to T02.', 'host unavailable')), /attempted step and blocker/);
  assert.throws(() => validate(valid.replace('Observe the named behavior in a live Extension Development Host.', 'x'.repeat(501))), /exceeds 500 characters/);
  const promoted = valid.replace('Verdict: ENVIRONMENT BLOCKED', 'Verdict: PASS');
  assert.throws(() => validate(promoted), /live verdict needs direct evidence/);
});
