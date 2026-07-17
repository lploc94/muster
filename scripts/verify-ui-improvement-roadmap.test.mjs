/**
 * M014/S03 deferred UI improvement roadmap contract.
 *
 * Guards a durable, prioritized roadmap that captures product UI work deferred
 * from M014. Each item must carry evidence, priority, user impact, acceptance
 * direction, and a proposed milestone boundary — not vague bullets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ROADMAP_PATH = path.join(REPO_ROOT, 'docs/UI-IMPROVEMENT-ROADMAP.md');
const VISUAL_OPS_PATH = path.join(REPO_ROOT, 'docs/UI-VISUAL-REGRESSION.md');
const ROOT_README_PATH = path.join(REPO_ROOT, 'README.md');
const DOCS_README_PATH = path.join(REPO_ROOT, 'docs/README.md');

/** Required deferred themes from M014/S03 T03. */
export const REQUIRED_ROADMAP_THEMES = [
  { id: 'task-search-rename-a11y', re: /task\s+search|rename\s+accessib/i },
  { id: 'hit-target-policy', re: /hit[- ]target/i },
  { id: 'presentation-reduced-motion', re: /reduced\s+motion/i },
  { id: 'theme-zoom-acceptance', re: /theme|zoom/i },
  { id: 'long-conversation-benchmarks', re: /long[- ]conversation|conversation\s+benchmark/i },
  { id: 'task-profile-density', re: /task[- ]profile|density/i },
  { id: 'ui-primitive-consolidation', re: /primitive\s+consolidat|UI\s+primitive/i },
];

/** Structural fields every roadmap item must expose. */
export const REQUIRED_ITEM_FIELDS = [
  { id: 'evidence', re: /\*\*Evidence\*\*|Evidence:/i },
  { id: 'priority', re: /\*\*Priority\*\*|Priority:/i },
  { id: 'user-impact', re: /\*\*User impact\*\*|User impact:/i },
  { id: 'acceptance-direction', re: /\*\*Acceptance\*\*|Acceptance direction:/i },
  { id: 'milestone-boundary', re: /\*\*Proposed milestone\*\*|Milestone boundary:|Proposed milestone:/i },
];

/**
 * Pure validator used by positive + negative tests.
 * @param {string} markdown
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateUiImprovementRoadmap(markdown) {
  const errors = [];
  const text = String(markdown ?? '');

  if (!text.trim()) {
    return { ok: false, errors: ['docs/UI-IMPROVEMENT-ROADMAP.md is empty or missing'] };
  }

  if (!/^#\s+UI Improvement Roadmap/m.test(text)) {
    errors.push('roadmap must start with "# UI Improvement Roadmap"');
  }

  // Deferred / non-implementation guard for M014.
  if (!/deferred|not implemented in M014|out of scope for M014/i.test(text)) {
    errors.push(
      'roadmap must state that these product UI improvements are deferred / not implemented in M014',
    );
  }

  // Must not claim the improvements already shipped in M014.
  if (/\bshipped in M014\b|\bimplemented in M014\b/i.test(text)) {
    errors.push('roadmap must not claim deferred items shipped/implemented in M014');
  }

  for (const theme of REQUIRED_ROADMAP_THEMES) {
    if (!theme.re.test(text)) {
      errors.push(`roadmap must cover theme: ${theme.id}`);
    }
  }

  for (const field of REQUIRED_ITEM_FIELDS) {
    const matches = text.match(new RegExp(field.re.source, 'gi')) ?? [];
    if (matches.length < REQUIRED_ROADMAP_THEMES.length) {
      errors.push(
        `roadmap must include "${field.id}" on each deferred item (found ${matches.length}, need ≥ ${REQUIRED_ROADMAP_THEMES.length})`,
      );
    }
  }

  // Priority vocabulary: at least one P0/P1/P2 style or High/Medium/Low.
  const priorityHits =
    text.match(/\bP[0-2]\b|\b(?:High|Medium|Low)\s+priority\b|\*\*Priority\*\*:\s*\w+/gi) ?? [];
  if (priorityHits.length < 3) {
    errors.push('roadmap must assign concrete priorities (P0–P2 or High/Medium/Low) to items');
  }

  // Proposed milestone boundaries must name future milestones, not only M014.
  if (!/M01[5-9]|M0[2-9]\d|future milestone|post-M014/i.test(text)) {
    errors.push(
      'roadmap must propose milestone boundaries beyond M014 (e.g. M015+) for deferred work',
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate ops guide sections required by M014/S03 T03.
 * @param {string} markdown
 */
export function validateVisualOpsGuide(markdown) {
  const errors = [];
  const text = String(markdown ?? '');
  if (!text.trim()) {
    return { ok: false, errors: ['docs/UI-VISUAL-REGRESSION.md is empty or missing'] };
  }

  const required = [
    { id: 'compare', re: /test:visual:linux\b|Authoritative compare/i },
    { id: 'pinned-authoring', re: /test:visual:linux:update|Authoritative author/i },
    { id: 'explicit-update', re: /explicit|never.*--update-snapshots|must never/i },
    { id: 'review', re: /##\s+Review|Inspect the generated goldens|Reject images/i },
    { id: 'ci', re: /##\s+CI policy|visual-regression-failure/i },
    { id: 'artifact-download', re: /CI artifact download|Download the artifact/i },
    { id: 'troubleshooting', re: /##\s+Troubleshooting/i },
    { id: 'playwright-upgrade', re: /##\s+Playwright upgrade|Upgrading Playwright/i },
    { id: 'browser-vs-native', re: /native VS Code|browser.*native|Scope limits/i },
  ];

  for (const req of required) {
    if (!req.re.test(text)) {
      errors.push(`UI-VISUAL-REGRESSION.md missing required section/signal: ${req.id}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate README index links.
 * @param {{ rootReadme?: string, docsReadme?: string }} input
 */
export function validateRoadmapIndexLinks(input = {}) {
  const errors = [];
  const root = String(input.rootReadme ?? '');
  const docs = String(input.docsReadme ?? '');

  if (!/UI-VISUAL-REGRESSION\.md/.test(root) && !/UI-VISUAL-REGRESSION\.md/.test(docs)) {
    errors.push('README or docs/README must link to UI-VISUAL-REGRESSION.md');
  }
  if (!/UI-IMPROVEMENT-ROADMAP\.md/.test(root) && !/UI-IMPROVEMENT-ROADMAP\.md/.test(docs)) {
    errors.push('README or docs/README must link to UI-IMPROVEMENT-ROADMAP.md');
  }

  return { ok: errors.length === 0, errors };
}

function loadRoadmap() {
  if (!existsSync(ROADMAP_PATH)) return '';
  return readFileSync(ROADMAP_PATH, 'utf8');
}

function loadVisualOps() {
  if (!existsSync(VISUAL_OPS_PATH)) return '';
  return readFileSync(VISUAL_OPS_PATH, 'utf8');
}

describe('UI improvement roadmap contract (M014 S03 T03/T04)', () => {
  it('repository roadmap exists and is structurally complete', () => {
    assert.equal(existsSync(ROADMAP_PATH), true, 'docs/UI-IMPROVEMENT-ROADMAP.md must exist');
    const result = validateUiImprovementRoadmap(loadRoadmap());
    assert.equal(
      result.ok,
      true,
      `UI improvement roadmap contract failed:\n- ${result.errors.join('\n- ')}`,
    );
  });

  it('visual ops guide covers compare, update, review, CI, artifacts, troubleshooting, upgrade, proof boundary', () => {
    const result = validateVisualOpsGuide(loadVisualOps());
    assert.equal(
      result.ok,
      true,
      `visual ops guide contract failed:\n- ${result.errors.join('\n- ')}`,
    );
  });

  it('README indexes link the visual ops guide and deferred roadmap', () => {
    const root = existsSync(ROOT_README_PATH) ? readFileSync(ROOT_README_PATH, 'utf8') : '';
    const docs = existsSync(DOCS_README_PATH) ? readFileSync(DOCS_README_PATH, 'utf8') : '';
    const result = validateRoadmapIndexLinks({ rootReadme: root, docsReadme: docs });
    assert.equal(
      result.ok,
      true,
      `index link contract failed:\n- ${result.errors.join('\n- ')}`,
    );
  });

  it('rejects empty or vague roadmap (negative)', () => {
    const vague = `# UI Improvement Roadmap

- Improve search
- Fix a11y
- Make UI better
`;
    const result = validateUiImprovementRoadmap(vague);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 3, `expected multiple structural errors, got: ${result.errors.join('; ')}`);
  });

  it('rejects roadmap missing required themes or fields (negative)', () => {
    const partial = `# UI Improvement Roadmap

Deferred product UI work (not implemented in M014).

## Task search

**Evidence:** audit note
**Priority:** P1
**User impact:** hard to find tasks
**Acceptance:** keyboard search works
**Proposed milestone:** M015

Only one theme present.
`;
    const result = validateUiImprovementRoadmap(partial);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /theme:|each deferred item/i.test(e)));
  });

  it('rejects ops guide missing troubleshooting or Playwright upgrade (negative)', () => {
    const thin = `# UI Visual Regression

npm run test:visual:linux
npm run test:visual:linux:update
never --update-snapshots
## CI policy
visual-regression-failure
## CI artifact download
Download the artifact
## Scope limits
native VS Code
Inspect the generated goldens
Reject images
`;
    const result = validateVisualOpsGuide(thin);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /troubleshooting|playwright-upgrade/i.test(e)));
  });
});
