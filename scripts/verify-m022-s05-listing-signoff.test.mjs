/**
 * M022/S05 T04 — marketplace listing human sign-off ledger contract.
 *
 * Enforces D071's thin recorded human judgement: per-item verdict from
 * {PASS, FAIL, AWAITING-HUMAN} for icon / README / CHANGELOG with a named
 * reviewer field. Rejects placeholders (TODO/TBD/FIXME), secret-like text,
 * and absolute machine paths. Autonomous execution may leave AWAITING-HUMAN;
 * that is an explicit recorded state, not a silent absence.
 *
 * Fixture-backed node:test — never launches VS Code or reads secrets.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const SIGNOFF_PATH = new URL('../docs/uat/m022-s05/marketplace-listing-signoff.md', import.meta.url);

/** @type {readonly string[]} */
export const LISTING_ITEMS = Object.freeze(['Icon', 'README', 'CHANGELOG']);

/** @type {readonly string[]} */
export const ALLOWED_VERDICTS = Object.freeze(['PASS', 'FAIL', 'AWAITING-HUMAN']);

const REQUIRED_HEADINGS = [
  '# M022 S05 Marketplace Listing Sign-off',
  '## Purpose',
  '## Reviewer',
  '## Items',
  '## Redaction Rules',
  '## Failure Modes',
  '## Load Profile',
  '## Negative Tests',
];

const FORBIDDEN = [
  { label: 'placeholder TODO/TBD/FIXME/PENDING', pattern: /\b(?:TODO|TBD|FIXME|PENDING)\b/i },
  {
    label: 'secret-like env key',
    pattern: /(?:ANTHROPIC|OPENAI|GITHUB|AZURE|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)/i,
  },
  { label: 'bearer token', pattern: /Bearer\s+[A-Za-z0-9._-]+/i },
  { label: 'sk- style token', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/i },
  {
    label: 'absolute machine path',
    pattern: /(?:[A-Za-z]:[\\/]|\\\\|\bfile:\/\/|\/home\/|\/Users\/|\/tmp\/|\/var\/)/,
  },
];

/**
 * Extract a ### Item section body.
 * @param {string} text
 * @param {string} item
 */
function itemSection(text, item) {
  const start = text.indexOf(`### ${item}`);
  assert.ok(start !== -1, `Missing item section: ### ${item}`);
  const rest = text.slice(start);
  const next = rest.search(/\n### /);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * @param {string} text
 */
export function validateListingSignoff(text) {
  assert.ok(typeof text === 'string' && text.trim().length > 0, 'sign-off ledger must be non-empty');

  for (const heading of REQUIRED_HEADINGS) {
    assert.ok(text.includes(heading), `Missing heading: ${heading}`);
  }

  // Placeholder tokens are only forbidden in judgement-bearing sections so the
  // Negative Tests section can name TODO/TBD/FIXME as documentation of what
  // the verifier rejects. Secrets and absolute paths are forbidden everywhere.
  const reviewerStart = text.indexOf('## Reviewer');
  const itemsStart = text.indexOf('## Items');
  const redactionStart = text.indexOf('## Redaction Rules');
  assert.ok(reviewerStart !== -1 && itemsStart !== -1 && redactionStart !== -1, 'Reviewer/Items/Redaction sections required');
  const judgementText = text.slice(reviewerStart, redactionStart);

  for (const { label, pattern } of FORBIDDEN) {
    const scope = label.startsWith('placeholder') ? judgementText : text;
    assert.ok(
      !pattern.test(scope),
      `Forbidden content (${label}) in listing sign-off ledger`,
    );
  }

  const reviewerBlock = text.slice(reviewerStart, itemsStart);
  const reviewerName = reviewerBlock.match(/^- Name:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(
    reviewerName && reviewerName.length > 0,
    'Reviewer Name field must be present and non-empty (use AWAITING-HUMAN when no reviewer is available)',
  );
  // Placeholders that are not the honest autonomous slot are rejected.
  assert.ok(
    !/^(TODO|TBD|FIXME|PENDING|N\/A|None|\.\.\.)$/i.test(reviewerName),
    `Reviewer Name must not be a placeholder (got ${JSON.stringify(reviewerName)})`,
  );

  for (const item of LISTING_ITEMS) {
    const section = itemSection(text, item);
    const verdict = section.match(/^- Verdict:\s*(.+)$/m)?.[1]?.trim();
    assert.ok(verdict, `${item} missing Verdict field`);
    assert.ok(
      ALLOWED_VERDICTS.includes(verdict),
      `${item} verdict must be one of ${ALLOWED_VERDICTS.join('|')}; got ${JSON.stringify(verdict)}`,
    );

    const machineCheck = section.match(/^- Machine check:\s*(.+)$/m)?.[1]?.trim();
    assert.ok(
      machineCheck && machineCheck.length > 0,
      `${item} must ground the human verdict in a Machine check reference`,
    );
    assert.ok(
      !/^(TODO|TBD|FIXME|PENDING|N\/A|None|\.\.\.)$/i.test(machineCheck),
      `${item} Machine check must not be a placeholder`,
    );

    const notes = section.match(/^- Notes:\s*(.+)$/m)?.[1]?.trim();
    assert.ok(notes && notes.length > 0, `${item} must include Notes`);
    assert.ok(notes.length <= 500, `${item} Notes exceeds 500 characters`);
  }

  return true;
}

/**
 * Minimal valid ledger for negative-fixture tests.
 * @param {Partial<{reviewer: string, iconVerdict: string, extra: string}>} [overrides]
 */
export function validSignoffFixture(overrides = {}) {
  const reviewer = overrides.reviewer ?? 'AWAITING-HUMAN';
  const iconVerdict = overrides.iconVerdict ?? 'AWAITING-HUMAN';
  const items = LISTING_ITEMS.map((item) => {
    const verdict = item === 'Icon' ? iconVerdict : 'AWAITING-HUMAN';
    return [
      `### ${item}`,
      `- Verdict: ${verdict}`,
      `- Machine check: packaging-listing-credibility ${item.toLowerCase()} check`,
      `- Notes: Autonomous execution records ${verdict}; human reviewer confirms before release.`,
    ].join('\n');
  }).join('\n\n');

  return [
    '# M022 S05 Marketplace Listing Sign-off',
    '',
    '## Purpose',
    'Record an explicit human judgement of marketplace listing credibility for the icon, README, and CHANGELOG, grounded in the objective machine checks from scripts/packaging-listing-credibility.mjs (D071).',
    '',
    '## Reviewer',
    `- Name: ${reviewer}`,
    '- Date: AWAITING-HUMAN',
    '',
    '## Items',
    '',
    items,
    '',
    '## Redaction Rules',
    'No secrets, tokens, absolute machine paths, or raw session dumps. Verdicts are PASS, FAIL, or AWAITING-HUMAN only.',
    '',
    '## Failure Modes',
    'Missing ledger, placeholder verdicts, secret-like text, or absolute paths fail the verifier closed.',
    '',
    '## Load Profile',
    'Static markdown contract; no runtime load dimension.',
    '',
    '## Negative Tests',
    'scripts/verify-m022-s05-listing-signoff.test.mjs rejects TODO/TBD/FIXME, secret patterns, absolute paths, and invalid verdicts.',
    overrides.extra ?? '',
  ].join('\n');
}

test('tracked marketplace listing sign-off ledger satisfies the complete contract', async () => {
  let text;
  try {
    text = await readFile(SIGNOFF_PATH, 'utf8');
  } catch (error) {
    assert.fail(
      `Missing listing sign-off ledger at docs/uat/m022-s05/marketplace-listing-signoff.md (${error.code ?? error.message})`,
    );
  }
  assert.equal(validateListingSignoff(text), true);
});

test('rejects invalid verdicts, placeholder reviewer, secrets, and absolute paths', () => {
  const valid = validSignoffFixture();
  assert.equal(validateListingSignoff(valid), true);

  assert.throws(
    () => validateListingSignoff(validSignoffFixture({ iconVerdict: 'TODO' })),
    /verdict must be one of|Forbidden content/,
  );

  assert.throws(
    () => validateListingSignoff(validSignoffFixture({ iconVerdict: 'LGTM' })),
    /verdict must be one of/,
  );

  assert.throws(
    () => validateListingSignoff(validSignoffFixture({ reviewer: 'TODO' })),
    /placeholder|Forbidden content/,
  );

  assert.throws(
    () => validateListingSignoff(validSignoffFixture({ extra: '\nOPENAI_API_KEY=sk-ant-secretvaluehere\n' })),
    /Forbidden content/,
  );

  assert.throws(
    () => validateListingSignoff(validSignoffFixture({ extra: '\nSaw /Users/ci/runner/work/muster\n' })),
    /absolute machine path|Forbidden content/,
  );

  assert.throws(
    () => validateListingSignoff(valid.replace('### CHANGELOG', '### Release notes')),
    /Missing item section: ### CHANGELOG/,
  );
});
