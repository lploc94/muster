import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const reportUrl = new URL('../docs/MUSTER-AUDIT-ROADMAP.vi.md', import.meta.url);

const requiredDomains = [
  { name: 'architecture', pattern: /ki\u1ebfn tr\u00fac|architecture/i },
  { name: 'security', pattern: /b\u1ea3o m\u1eadt|security/i },
  { name: 'testing', pattern: /ki\u1ec3m th\u1eed|test/i },
  { name: 'operability', pattern: /v\u1eadn h\u00e0nh|operability|observability/i },
  { name: 'documentation', pattern: /t\u00e0i li\u1ec7u|documentation/i },
];

const confidenceLabels = [
  { name: 'evidence', pattern: /\[\s*B\u1eb1ng ch\u1ee9ng\s*\]|\[\s*Evidence\s*\]/i },
  { name: 'inferred', pattern: /\[\s*Suy lu\u1eadn\s*\]|\[\s*Inferred\s*\]/i },
  { name: 'research', pattern: /\[\s*Nghi\u00ean c\u1ee9u\s*\]|\[\s*Research\s*\]/i },
  { name: 'unknown', pattern: /\[\s*Ch\u01b0a r\u00f5\s*\]|\[\s*Unknown\s*\]/i },
];

async function readReport() {
  let report;

  try {
    report = await readFile(reportUrl, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      assert.fail('Missing docs/MUSTER-AUDIT-ROADMAP.vi.md; create the Vietnamese audit roadmap report before running this verifier.');
    }

    throw error;
  }

  assert.ok(report.trim().length > 0, 'docs/MUSTER-AUDIT-ROADMAP.vi.md must not be empty.');
  return report;
}

function headingSections(report, headingPattern) {
  const headingRegex = /^#{2,3}\s+.*$/gm;
  const matches = [...report.matchAll(headingRegex)];

  return matches
    .filter((match) => headingPattern.test(match[0]))
    .map((match) => {
      const currentLevel = match[0].match(/^#+/)?.[0].length ?? 0;
      const nextPeerOrParent = matches.find((candidate) => {
        const candidateLevel = candidate[0].match(/^#+/)?.[0].length ?? 0;
        return candidate.index > match.index && candidateLevel <= currentLevel;
      });

      return report.slice(match.index, nextPeerOrParent?.index ?? report.length);
    });
}

test('negative: missing report fails; otherwise report has a Vietnamese title and summary', async () => {
  const report = await readReport();

  assert.match(report, /^#\s+.*(Muster|MUSTER).*(ki\u1ec3m to\u00e1n|audit|l\u1ed9 tr\u00ecnh|roadmap)/im, 'Top-level heading must identify the Muster Vietnamese audit roadmap.');
  assert.match(report, /^#{2,3}\s+.*(T\u00f3m t\u1eaft|Executive summary|T\u1ed5ng quan)/im, 'Missing Vietnamese summary/overview section.');
});

test('negative: missing legend fails; confidence labels cover evidence, inferred, research, and unknown behavior', async () => {
  const report = await readReport();

  assert.match(report, /^#{2,3}\s+.*(Ch\u00fa gi\u1ea3i|Legend|Nh\u00e3n tin c\u1eady|m\u1ee9c \u0111\u1ed9 tin c\u1eady)/im, 'Missing confidence-label legend section.');

  for (const { name, pattern } of confidenceLabels) {
    assert.match(report, pattern, `Missing ${name} confidence label.`);
  }
});

test('required improvement domains are covered structurally', async () => {
  const report = await readReport();

  for (const { name, pattern } of requiredDomains) {
    assert.match(report, pattern, `Missing required improvement domain: ${name}.`);
  }
});

test('negative: incomplete milestones fail without dependency, risk, acceptance, and verification details', async () => {
  const report = await readReport();
  const milestoneSections = headingSections(report, /^#{2,3}\s+(?:milestone|m\u1ed1c)\b/i);

  assert.ok(milestoneSections.length >= 3, 'Expected at least three future milestone sections.');

  milestoneSections.forEach((section, index) => {
    const ordinal = index + 1;

    assert.match(section, /ph\u1ee5 thu\u1ed9c|dependency|depends/i, `Milestone ${ordinal} is missing dependency language.`);
    assert.match(section, /r\u1ee7i ro|risk/i, `Milestone ${ordinal} is missing risk language.`);
    assert.match(section, /ti\u00eau ch\u00ed ch\u1ea5p nh\u1eadn|acceptance/i, `Milestone ${ordinal} is missing acceptance criteria language.`);
    assert.match(section, /x\u00e1c minh|ki\u1ec3m ch\u1ee9ng|verification|verify/i, `Milestone ${ordinal} is missing verification language.`);
  });
});
