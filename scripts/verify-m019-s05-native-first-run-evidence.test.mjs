/**
 * Fail-closed contract for the M019/S05 native first-run evidence ledger.
 * Fixture-backed node:test — never inspects live hosts, secrets, or gitignored paths.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidencePath = new URL(
  '../docs/uat/m019-s05/native-first-run-evidence.md',
  import.meta.url,
);

const scenarioIds = [
  'NATIVE-HOST-ACTIVATE',
  'NATIVE-CLAUDE-FIRST-RUN',
  'NATIVE-GROK-FIRST-RUN',
  'NATIVE-KIRO-FIRST-RUN',
  'NATIVE-CODEX-FIRST-RUN',
  'NATIVE-OPENCODE-FIRST-RUN',
  'NATIVE-DOCTOR',
  'NATIVE-FIRST-TASK-ACCEPTANCE',
  'NATIVE-FINAL-CLEANUP',
];

const requiredHeadings = [
  '# M019 S05 Native First Run Evidence',
  '## Environment and Preconditions',
  '## Proof Boundary',
  '## Scenario Evidence',
  '## Redaction Rules',
  '## Failure Modes',
  '## Load Profile',
  '## Negative Tests',
];

const forbiddenPatterns = [
  // Whole-field placeholders only so Negative Tests prose may mention the rule name.
  {
    pattern: /^- [^:\n]+: (?:PENDING|TODO|TBD|FIXME)\s*$/im,
    rule: 'pending placeholders are forbidden',
  },
  {
    pattern: /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|Bearer\s+sk-|sk-ant-|sk-proj-)\b/i,
    rule: 'secret-like text is forbidden',
  },
  {
    pattern: /(?:[A-Za-z]:[\\/]|\\\\|\bfile:\/\/|\/home\/|\/Users\/|\/tmp\/)/,
    rule: 'absolute machine paths are forbidden',
  },
  {
    pattern:
      /(?:included|copied|dumped|attached)\s+(?:the\s+)?(?:raw|full|unredacted)\s+(?:task[- ]store|transcript|prompt|assistant payload|session dump|stderr)/i,
    rule: 'transcript, raw task-store, prompt, and stderr payloads are forbidden',
  },
  {
    pattern: /(?:all scenarios|every scenario).{0,30}(?:inherit|share|use).{0,30}(?:verdict|result)/i,
    rule: 'blanket inherited verdicts are forbidden',
  },
  {
    pattern:
      /(?:Playwright|mocked browser|browser test|injected host suite).{0,50}(?:proves|is|counts as).{0,30}(?:live|native|Extension Development Host|packaged)/i,
    rule: 'mocked browser or injected-host evidence cannot be presented as native proof',
  },
];

function section(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing heading: ${heading}`);
  const bodyStart = start + heading.length;
  const next = text.indexOf('\n## ', bodyStart);
  return text.slice(bodyStart, next === -1 ? text.length : next);
}

function scenarioBlock(text, scenarioId) {
  const evidence = section(text, '## Scenario Evidence');
  const heading = `### ${scenarioId}`;
  const matches = [...evidence.matchAll(new RegExp(`^${heading}$`, 'gm'))];
  assert.equal(matches.length, 1, `${scenarioId}: expected exactly one scenario section`);
  const start = matches[0].index;
  const bodyStart = start + heading.length;
  const next = evidence.indexOf('\n### ', bodyStart);
  return evidence.slice(bodyStart, next === -1 ? evidence.length : next);
}

function field(block, scenarioId, name) {
  const matches = [...block.matchAll(new RegExp(`^- ${name}:\\s*(.+)$`, 'gmi'))];
  assert.equal(matches.length, 1, `${scenarioId}: expected exactly one ${name} field`);
  const value = matches[0][1].trim();
  assert.ok(value.length >= 1, `${scenarioId}: ${name} is empty`);
  assert.ok(value.length <= 500, `${scenarioId}: ${name} exceeds 500 characters`);
  assert.notEqual(value, 'N/A', `${scenarioId}: ${name} must not be N/A`);
  assert.notEqual(value, 'None', `${scenarioId}: ${name} must not be None`);
  return value;
}

export function validateEvidence(text) {
  assert.ok(text.trim(), 'evidence ledger must be non-empty');
  for (const heading of requiredHeadings) {
    assert.ok(text.includes(heading), `missing heading: ${heading}`);
  }
  for (const { pattern, rule } of forbiddenPatterns) {
    assert.ok(!pattern.test(text), rule);
  }

  assert.match(
    text,
    /Playwright and local integration gates are supportive only/i,
    'missing local/browser proof boundary',
  );
  assert.match(
    text,
    /actual (?:VS Code )?Extension Development Host|packaged Extension Host/i,
    'missing actual host proof boundary',
  );
  assert.match(
    text,
    /(?:does not claim|cannot establish|cannot replace).{0,40}(?:native|PASS)/i,
    'missing explicit non-overclaim boundary',
  );

  for (const scenarioId of scenarioIds) {
    const block = scenarioBlock(text, scenarioId);
    const verdict = field(block, scenarioId, 'Verdict');
    assert.match(
      verdict,
      /^(?:PASS|FAIL|ENVIRONMENT BLOCKED)$/,
      `${scenarioId}: invalid verdict`,
    );
    assert.match(
      field(block, scenarioId, 'Timestamp'),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      `${scenarioId}: invalid UTC timestamp`,
    );
    assert.ok(
      field(block, scenarioId, 'Observation').length >= 20,
      `${scenarioId}: observation is not bounded and informative`,
    );
    const evidence = field(block, scenarioId, 'Evidence');
    if (verdict === 'ENVIRONMENT BLOCKED') {
      assert.match(
        evidence,
        /attempted:/i,
        `${scenarioId}: blocked evidence must name the attempted step`,
      );
      assert.match(
        evidence,
        /blocker:/i,
        `${scenarioId}: blocked evidence must name the concrete blocker`,
      );
    } else {
      assert.match(
        evidence,
        /(?:EDH-|screenshot:|log:|reproduction:|runner:|observation:)/i,
        `${scenarioId}: PASS or FAIL requires a live evidence reference or reproduction`,
      );
      assert.doesNotMatch(
        evidence,
        /^supportive-only:/i,
        `${scenarioId}: live verdict cannot cite supportive-only evidence alone`,
      );
    }
  }

  const cleanup = scenarioBlock(text, 'NATIVE-FINAL-CLEANUP');
  assert.match(
    field(cleanup, 'NATIVE-FINAL-CLEANUP', 'Observation'),
    /cleanup|closed|disposed|no residual|no disposable/i,
    'NATIVE-FINAL-CLEANUP: cleanup state is absent',
  );

  // Provider coverage: five allowlisted backends must appear as first-run scenarios.
  for (const provider of ['claude', 'grok', 'kiro', 'codex', 'opencode']) {
    assert.ok(
      text.includes(`### NATIVE-${provider.toUpperCase()}-FIRST-RUN`),
      `missing provider scenario for ${provider}`,
    );
  }
}

function fixture(overrides = {}) {
  const scenarios = scenarioIds
    .map((id) => {
      const verdict = overrides[id]?.verdict ?? 'ENVIRONMENT BLOCKED';
      const evidence =
        overrides[id]?.evidence ??
        'Attempted: launch the packaged Extension Development Host native first-run runner. Blocker: host execution is deferred to the execute-matrix task and was not performed in this structural-contract task.';
      const observation =
        overrides[id]?.observation ??
        (id === 'NATIVE-FINAL-CLEANUP'
          ? 'Cleanup could not be observed because no disposable host profile, workspace, probe, or first-task was started.'
          : 'No live native first-run behavior was inferred from browser, injected, or mocked coverage.');
      return `### ${id}\n- Verdict: ${verdict}\n- Timestamp: 2026-07-26T00:00:00Z\n- Observation: ${observation}\n- Evidence: ${evidence}`;
    })
    .join('\n\n');
  return `# M019 S05 Native First Run Evidence
## Environment and Preconditions
Environment metadata is bounded and repository-relative only.
## Proof Boundary
Playwright and local integration gates are supportive only. PASS requires actual VS Code Extension Development Host observation through the packaged Extension Host runner. Browser fixtures cannot replace native proof and do not claim native PASS.
## Scenario Evidence
${scenarios}
## Redaction Rules
Record no credentials, prompts, raw stderr, absolute paths, or store bodies.
## Failure Modes
Diagnostics identify scenario and rule.
## Load Profile
One bounded ledger with fixed scenario cardinality.
## Negative Tests
Malformed fixtures fail closed.
`;
}

test('tracked native first-run evidence satisfies the complete contract', async () => {
  let text;
  try {
    text = await readFile(evidencePath, 'utf8');
  } catch (error) {
    assert.fail(
      `missing native first-run evidence ledger (${error.code ?? error.message})`,
    );
  }
  validateEvidence(text);
});

test('accepts a complete explicit fixture', () => {
  validateEvidence(fixture());
});

test('rejects omitted scenario and invalid verdict', () => {
  assert.throws(
    () =>
      validateEvidence(
        fixture().replace(/### NATIVE-HOST-ACTIVATE[\s\S]*?(?=\n### )/, ''),
      ),
    /NATIVE-HOST-ACTIVATE: expected exactly one scenario section/,
  );
  assert.throws(
    () =>
      validateEvidence(
        fixture({ 'NATIVE-HOST-ACTIVATE': { verdict: 'BLOCKED' } }),
      ),
    /NATIVE-HOST-ACTIVATE: invalid verdict/,
  );
});

test('rejects missing blocker detail and absent cleanup', () => {
  assert.throws(
    () =>
      validateEvidence(
        fixture({
          'NATIVE-HOST-ACTIVATE': { evidence: 'Host unavailable.' },
        }),
      ),
    /NATIVE-HOST-ACTIVATE: blocked evidence must name the attempted step/,
  );
  assert.throws(
    () =>
      validateEvidence(
        fixture({
          'NATIVE-FINAL-CLEANUP': {
            observation: 'Nothing was observed in this structural task.',
          },
        }),
      ),
    /cleanup state is absent/,
  );
});

test('rejects absolute paths, secret-like text, pending placeholders, and mocked-live overclaim', () => {
  const valid = fixture();
  assert.throws(
    () => validateEvidence(`${valid}\nD:/private/workspace`),
    /absolute machine paths/,
  );
  assert.throws(
    () => validateEvidence(`${valid}\nOPENAI_API_KEY`),
    /secret-like text/,
  );
  // Whole-field placeholder on a scenario observation line.
  assert.throws(
    () =>
      validateEvidence(
        fixture().replace(
          /^- Observation: No live native first-run behavior was inferred from browser, injected, or mocked coverage\.$/m,
          '- Observation: PENDING',
        ),
      ),
    /pending placeholders/,
  );
  assert.throws(
    () =>
      validateEvidence(
        `${valid}\nPlaywright proves live Extension Development Host behavior.`,
      ),
    /mocked browser or injected-host evidence/,
  );
});

test('rejects transcript, raw store, stderr payload claims, and blanket verdicts', () => {
  assert.throws(
    () => validateEvidence(`${fixture()}\nIncluded raw transcript`),
    /transcript, raw task-store, prompt, and stderr payloads/,
  );
  assert.throws(
    () => validateEvidence(`${fixture()}\nCopied full task-store`),
    /transcript, raw task-store, prompt, and stderr payloads/,
  );
  assert.throws(
    () => validateEvidence(`${fixture()}\nAttached unredacted stderr`),
    /transcript, raw task-store, prompt, and stderr payloads/,
  );
  assert.throws(
    () => validateEvidence(`${fixture()}\nAll scenarios inherit the same verdict`),
    /blanket inherited verdicts/,
  );
});

test('rejects live verdict that cites only supportive-only evidence', () => {
  assert.throws(
    () =>
      validateEvidence(
        fixture({
          'NATIVE-HOST-ACTIVATE': {
            verdict: 'PASS',
            evidence: 'supportive-only: scripts/verify-m019-s05-native-first-run-evidence.test.mjs',
            observation:
              'Extension Host activation was inferred from local unit coverage without a packaged host run.',
          },
        }),
      ),
    /live evidence reference|supportive-only/,
  );
});
