import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidencePath = new URL(
  '../docs/uat/m012-s04/settings-live-host-evidence.md',
  import.meta.url,
);

const scenarios = [
  'SETTINGS-TAB-KEYBOARD-FOCUS',
  'SETTINGS-TASK-TYPES-PERSISTENCE',
  'SETTINGS-PERMISSION-MODE-POLICY',
  'SETTINGS-PENDING-PERMISSION-ISOLATION',
  'SETTINGS-RETENTION-PERSISTENCE',
  'SETTINGS-HIDE-REVEAL-RESTORATION',
  'SETTINGS-320PX-REFLOW',
  'SETTINGS-DOMAIN-FEEDBACK-ISOLATION',
  'SETTINGS-FINAL-CLEANUP',
];

const fields = [
  'Verdict:',
  'Timestamp:',
  'Expected:',
  'Observed:',
  'Blocker:',
  'Cleanup:',
  'Evidence:',
];

const headings = [
  '# M012 S04 Settings Live Host Evidence',
  '## Proof Boundary',
  '## Scenario Evidence',
  '## Redaction Rules',
  '## Failure Modes',
  '## Load Profile',
  '## Negative Tests',
];

const forbidden = [
  // Whole-field placeholders only so domain language like "pending permission" is allowed.
  /^- [^:\n]+: (?:PENDING|TODO|TBD|FIXME)\s*$/im,
  /(?:ANTHROPIC|OPENAI|GITHUB|AZURE|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)/i,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]+/i,
  /(?:[A-Za-z]:[\\/]|\\\\|\bfile:\/\/|\/home\/|\/Users\/|\/tmp\/)/,
  /raw (?:task[- ]store|transcript|config|settings dump|\.muster-tasks\.json|\.muster-sessions\.json)/i,
  /(?:mocked|Playwright|browser) (?:result|test|evidence|checks?).{0,40}(?:proves|is|counts as) live/i,
];

function scenarioSection(text, id) {
  const marker = `### ${id}`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `Missing required scenario: ${id}`);
  const next = text.indexOf('\n### ', start + marker.length);
  return text.slice(start, next === -1 ? text.length : next);
}

function fieldBodies(text) {
  const scenarioEvidence = text.slice(
    text.indexOf('## Scenario Evidence'),
    text.indexOf('## Redaction Rules'),
  );
  // Inspect field values only so required scenario IDs such as
  // SETTINGS-PENDING-PERMISSION-ISOLATION do not trip placeholder filters.
  return scenarioEvidence
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .join('\n');
}

function validate(text) {
  assert.ok(text.trim(), 'Evidence ledger must be non-empty');
  for (const heading of headings) {
    assert.ok(text.includes(heading), `Missing heading: ${heading}`);
  }
  assert.match(text, /Playwright|supportive only/i, 'missing local/browser proof boundary');
  assert.match(
    text,
    /Extension Development Host/i,
    'missing Extension Development Host proof boundary',
  );

  const bodies = fieldBodies(text);
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(bodies), `Forbidden evidence content: ${pattern}`);
  }

  const scenarioEvidence = text.slice(
    text.indexOf('## Scenario Evidence'),
    text.indexOf('## Redaction Rules'),
  );
  for (const id of scenarios) {
    const occurrences = scenarioEvidence.split(`### ${id}`).length - 1;
    assert.equal(occurrences, 1, `${id} must appear exactly once (found ${occurrences})`);

    const section = scenarioSection(text, id);
    for (const field of fields) {
      assert.ok(section.includes(`- ${field}`), `${id} missing field ${field}`);
    }
    const verdict = section.match(/^- Verdict: (.+)$/m)?.[1];
    assert.match(
      verdict ?? '',
      /^(PASS|FAIL|ENVIRONMENT BLOCKED)$/,
      `${id} has invalid verdict`,
    );
    assert.match(
      section,
      /^- Timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m,
      `${id} has invalid UTC timestamp`,
    );
    for (const field of fields.slice(2)) {
      const value = section
        .match(new RegExp(`^- ${field.replace(':', '')}: (.+)$`, 'm'))?.[1]
        ?.trim();
      assert.ok(value && value !== 'N/A' && value !== 'None', `${id} has unbounded ${field}`);
      assert.ok(value.length <= 500, `${id} ${field} exceeds 500 characters`);
    }
    if (verdict === 'ENVIRONMENT BLOCKED') {
      assert.match(
        section,
        /^- Blocker: Attempted: .+ Blocker: .+$/m,
        `${id} blocked verdict needs attempted step and blocker`,
      );
    }
    if (verdict === 'PASS' || verdict === 'FAIL') {
      assert.match(
        section,
        /^- Evidence: (?!supportive-only:).+$/m,
        `${id} live verdict needs direct evidence`,
      );
    }
  }
  return true;
}

function validFixture() {
  const records = scenarios.map(
    (id) =>
      `### ${id}\n- Verdict: ENVIRONMENT BLOCKED\n- Timestamp: 2026-07-16T00:00:00Z\n- Expected: Observe the named Settings behavior in a live Extension Development Host.\n- Observed: Live Settings host behavior could not be observed in this non-interactive agent session.\n- Blocker: Attempted: detect a controllable Extension Development Host surface for Settings. Blocker: this session has no desktop UI automation for host webview control.\n- Cleanup: No Settings UI, prompts, or host window was created; later live runs must restore Settings values and close prompts or hosts.\n- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs`,
  );
  return `${headings[0]}\n\n${headings[1]}\nOnly direct Extension Development Host observation can establish PASS or FAIL. Playwright and local checks are supportive only.\n\n${headings[2]}\n\n${records.join('\n\n')}\n\n${headings.slice(3).join('\nSafe bounded text.\n')}`;
}

test('tracked settings live-host ledger satisfies the complete contract', async () => {
  let text;
  try {
    text = await readFile(evidencePath, 'utf8');
  } catch (error) {
    assert.fail(`Missing settings live-host evidence ledger (${error.code ?? error.message})`);
  }
  assert.equal(validate(text), true);
});

test('rejects omitted scenarios, invalid verdicts, malformed timestamps, and missing fields', () => {
  const valid = validFixture();
  assert.throws(
    () => validate(valid.replace('### SETTINGS-TAB-KEYBOARD-FOCUS', '### OTHER')),
    /must appear exactly once|Missing required scenario/,
  );
  assert.throws(
    () => validate(valid.replace('Verdict: ENVIRONMENT BLOCKED', 'Verdict: BLOCKED')),
    /invalid verdict/,
  );
  assert.throws(
    () => validate(valid.replace('2026-07-16T00:00:00Z', 'yesterday')),
    /invalid UTC timestamp/,
  );
  assert.throws(
    () => validate(valid.replace('- Cleanup:', '- Teardown:')),
    /missing field Cleanup/,
  );
});

test('rejects duplicate scenarios', () => {
  const valid = validFixture();
  const first = '### SETTINGS-TAB-KEYBOARD-FOCUS';
  const next = valid.indexOf('\n### ', valid.indexOf(first) + first.length);
  const dup = `${valid.slice(0, next)}\n\n${first}\n- Verdict: ENVIRONMENT BLOCKED\n- Timestamp: 2026-07-16T00:00:00Z\n- Expected: dup\n- Observed: dup\n- Blocker: Attempted: dup. Blocker: dup.\n- Cleanup: dup\n- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs${valid.slice(next)}`;
  assert.throws(() => validate(dup), /must appear exactly once/);
});

test('rejects placeholders, secrets, absolute paths, raw stores, transcripts, configs, and mocked-live promotion', () => {
  const valid = validFixture();
  for (const unsafe of [
    'TODO',
    'OPENAI_API_KEY',
    'D:/private/settings.json',
    'raw task-store',
    'raw transcript',
    'raw config',
    'Playwright evidence proves live behavior',
    'browser checks counts as live',
  ]) {
    assert.throws(
      () =>
        validate(
          valid.replace(
            '- Observed: Live Settings host behavior could not be observed in this non-interactive agent session.',
            `- Observed: ${unsafe}`,
          ),
        ),
      /Forbidden evidence content/,
    );
  }
});

test('requires actionable blockers, bounded fields, cleanup, and direct evidence for live verdicts', () => {
  const valid = validFixture();
  assert.throws(
    () =>
      validate(
        valid.replace(
          'Attempted: detect a controllable Extension Development Host surface for Settings. Blocker: this session has no desktop UI automation for host webview control.',
          'host unavailable',
        ),
      ),
    /attempted step and blocker/,
  );
  assert.throws(
    () =>
      validate(
        valid.replace(
          'Observe the named Settings behavior in a live Extension Development Host.',
          'x'.repeat(501),
        ),
      ),
    /exceeds 500 characters/,
  );
  const promoted = valid.replace('Verdict: ENVIRONMENT BLOCKED', 'Verdict: PASS');
  assert.throws(() => validate(promoted), /live verdict needs direct evidence/);
});
