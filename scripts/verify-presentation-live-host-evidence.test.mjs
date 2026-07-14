import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidencePath = new URL('../docs/uat/m006-s05/presentation-live-host-evidence.md', import.meta.url);

const scenarioIds = [
  'PRESENTATION-OPENING',
  'PRESENTATION-SAME-ID-UPDATE',
  'PRESENTATION-MULTI-ID-ISOLATION',
  'PRESENTATION-MERMAID-BOUNDS-FALLBACK',
  'PRESENTATION-LINKED-CHAT-REVEAL',
  'PRESENTATION-EXISTING-TASK-REVISION',
  'PRESENTATION-SUPPORTED-RESTORE',
  'PRESENTATION-DISPOSAL',
  'PRESENTATION-FINAL-CLEANUP',
];

const requiredHeadings = [
  '# M006 S05 Presentation Live Host Evidence',
  '## Environment and Preconditions',
  '## Proof Boundary',
  '## Scenario Evidence',
  '## Redaction Rules',
  '## Failure Modes',
  '## Load Profile',
  '## Negative Tests',
];

const forbiddenPatterns = [
  { pattern: /\bPENDING\b/i, rule: 'pending placeholders are forbidden' },
  { pattern: /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|Bearer\s+sk-|sk-ant-|sk-proj-)\b/i, rule: 'secret-like text is forbidden' },
  { pattern: /(?:[A-Za-z]:[\\/]|\\\\|\bfile:\/\/|\/home\/|\/Users\/|\/tmp\/)/, rule: 'absolute machine paths are forbidden' },
  { pattern: /(?:included|copied|dumped|attached)\s+(?:the\s+)?(?:raw|full|unredacted)\s+(?:task[- ]store|transcript|prompt|assistant payload|session dump)/i, rule: 'transcript and raw task-store payloads are forbidden' },
  { pattern: /(?:all scenarios|every scenario).{0,30}(?:inherit|share|use).{0,30}(?:verdict|result)/i, rule: 'blanket inherited verdicts are forbidden' },
  { pattern: /(?:Playwright|mocked browser|browser test).{0,50}(?:proves|is|counts as).{0,30}(?:live|Extension Development Host)/i, rule: 'mocked browser evidence cannot be presented as live proof' },
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
  return matches[0][1].trim();
}

export function validateEvidence(text) {
  assert.ok(text.trim(), 'evidence ledger must be non-empty');
  for (const heading of requiredHeadings) assert.ok(text.includes(heading), `missing heading: ${heading}`);
  for (const { pattern, rule } of forbiddenPatterns) assert.ok(!pattern.test(text), rule);

  assert.match(text, /Playwright and local integration gates are supportive only/i, 'missing local/browser proof boundary');
  assert.match(text, /actual VS Code Extension Development Host observation/i, 'missing actual host proof boundary');

  for (const scenarioId of scenarioIds) {
    const block = scenarioBlock(text, scenarioId);
    const verdict = field(block, scenarioId, 'Verdict');
    assert.match(verdict, /^(?:PASS|FAIL|ENVIRONMENT BLOCKED)$/, `${scenarioId}: invalid verdict`);
    assert.match(field(block, scenarioId, 'Timestamp'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${scenarioId}: invalid UTC timestamp`);
    assert.ok(field(block, scenarioId, 'Observation').length >= 20, `${scenarioId}: observation is not bounded and informative`);
    const evidence = field(block, scenarioId, 'Evidence');
    if (verdict === 'ENVIRONMENT BLOCKED') {
      assert.match(evidence, /attempted:/i, `${scenarioId}: blocked evidence must name the attempted step`);
      assert.match(evidence, /blocker:/i, `${scenarioId}: blocked evidence must name the concrete blocker`);
    } else {
      assert.match(evidence, /(?:EDH-|screenshot:|log:|reproduction:)/i, `${scenarioId}: PASS or FAIL requires a live evidence reference or reproduction`);
    }
  }

  const cleanup = scenarioBlock(text, 'PRESENTATION-FINAL-CLEANUP');
  assert.match(field(cleanup, 'PRESENTATION-FINAL-CLEANUP', 'Observation'), /cleanup|closed|disposed|no resurrection/i, 'PRESENTATION-FINAL-CLEANUP: cleanup state is absent');
}

function fixture(overrides = {}) {
  const scenarios = scenarioIds.map((id) => {
    const verdict = overrides[id]?.verdict ?? 'ENVIRONMENT BLOCKED';
    const evidence = overrides[id]?.evidence ?? 'Attempted: launch the scenario in F5 host. Blocker: host execution is unavailable in this structural-contract task.';
    const observation = overrides[id]?.observation ?? (id === 'PRESENTATION-FINAL-CLEANUP' ? 'Cleanup could not be observed because no live host session was started.' : 'No live behavior was inferred from local or mocked browser coverage.');
    return `### ${id}\n- Verdict: ${verdict}\n- Timestamp: 2026-07-10T00:00:00Z\n- Observation: ${observation}\n- Evidence: ${evidence}`;
  }).join('\n\n');
  return `# M006 S05 Presentation Live Host Evidence\n## Environment and Preconditions\nEnvironment metadata is bounded.\n## Proof Boundary\nPlaywright and local integration gates are supportive only. PASS requires actual VS Code Extension Development Host observation.\n## Scenario Evidence\n${scenarios}\n## Redaction Rules\nRecord no sensitive payloads.\n## Failure Modes\nDiagnostics identify scenario and rule.\n## Load Profile\nOne bounded ledger.\n## Negative Tests\nMalformed fixtures fail closed.`;
}

test('tracked presentation live-host evidence satisfies the complete contract', async () => {
  let text;
  try { text = await readFile(evidencePath, 'utf8'); }
  catch (error) { assert.fail(`missing presentation evidence ledger (${error.code ?? error.message})`); }
  validateEvidence(text);
});

test('accepts a complete explicit fixture', () => validateEvidence(fixture()));

test('rejects omitted scenario and invalid verdict', () => {
  assert.throws(() => validateEvidence(fixture().replace(/### PRESENTATION-OPENING[\s\S]*?(?=\n### )/, '')), /PRESENTATION-OPENING: expected exactly one scenario section/);
  assert.throws(() => validateEvidence(fixture({ 'PRESENTATION-OPENING': { verdict: 'BLOCKED' } })), /PRESENTATION-OPENING: invalid verdict/);
});

test('rejects missing blocker detail and absent cleanup', () => {
  assert.throws(() => validateEvidence(fixture({ 'PRESENTATION-OPENING': { evidence: 'Host unavailable.' } })), /PRESENTATION-OPENING: blocked evidence must name the attempted step/);
  assert.throws(() => validateEvidence(fixture({ 'PRESENTATION-FINAL-CLEANUP': { observation: 'Nothing was observed in this structural task.' } })), /cleanup state is absent/);
});

test('rejects absolute paths, secret-like text, pending placeholders, and mocked-live overclaim', () => {
  const valid = fixture();
  assert.throws(() => validateEvidence(`${valid}\nD:/private/workspace`), /absolute machine paths/);
  assert.throws(() => validateEvidence(`${valid}\nOPENAI_API_KEY`), /secret-like text/);
  assert.throws(() => validateEvidence(`${valid}\nPENDING`), /pending placeholders/);
  assert.throws(() => validateEvidence(`${valid}\nPlaywright proves live Extension Development Host behavior.`), /mocked browser evidence/);
});

test('rejects transcript and raw task-store payload claims', () => {
  assert.throws(() => validateEvidence(`${fixture()}\nIncluded raw transcript`), /transcript and raw task-store payloads/);
  assert.throws(() => validateEvidence(`${fixture()}\nCopied full task-store`), /transcript and raw task-store payloads/);
  assert.throws(() => validateEvidence(`${fixture()}\nAll scenarios inherit the same verdict`), /blanket inherited verdicts/);
});
