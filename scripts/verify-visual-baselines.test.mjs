import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'e2e/visual/visual-cases.manifest.json');
const VISUAL_ENV_PATH = path.join(REPO_ROOT, 'e2e/fixtures/visual-environment.ts');
const FLOWS_SPEC_PATH = path.join(REPO_ROOT, 'e2e/visual/m014-slice-flows.spec.ts');
const DOCS_PATH = path.join(REPO_ROOT, 'docs/UI-VISUAL-REGRESSION.md');
const CASES_TS_PATH = path.join(REPO_ROOT, 'e2e/visual/visual-cases.ts');

const REQUIRED_CASE_FIELDS = [
  'id',
  'owner',
  'entrypoint',
  'state',
  'layout',
  'viewport',
  'theme',
  'requirements',
  'snapshotPath',
  'fixtureFactory',
];

const FORBIDDEN_ASCII = [
  { name: 'openai-style-secret', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: 'github-pat', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'absolute-windows-path', re: /[A-Za-z]:\\Users\\/ },
  { name: 'absolute-unix-home', re: /\/(?:Users|home)\/[^/\s]+/ },
];

function loadManifest(filePath = MANIFEST_PATH) {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Pure validator used by positive + negative tests.
 * Returns { ok: true } or { ok: false, errors: string[] }.
 */
export function validateVisualManifest(manifest, options = {}) {
  const {
    repoRoot = REPO_ROOT,
    checkSnapshots = true,
    checkFixtureFactories = true,
    fixtureSource = null,
  } = options;
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest must be an object'] };
  }
  if (typeof manifest.maxCases !== 'number' || manifest.maxCases < 1) {
    errors.push('maxCases must be a positive number');
  }
  if (manifest.maxCases > 8) {
    errors.push(`maxCases ${manifest.maxCases} exceeds hard cap of 8`);
  }
  if (manifest.flowTitle !== 'M014 S02 flow: representative visual matrix') {
    errors.push(
      `flowTitle must be exactly "M014 S02 flow: representative visual matrix" (got ${JSON.stringify(manifest.flowTitle)})`,
    );
  }
  if (!Array.isArray(manifest.cases)) {
    errors.push('cases must be an array');
    return { ok: false, errors };
  }
  if (manifest.cases.length === 0) {
    errors.push('cases must not be empty');
  }
  if (manifest.cases.length > (manifest.maxCases ?? 8)) {
    errors.push(
      `case count ${manifest.cases.length} exceeds maxCases ${manifest.maxCases}`,
    );
  }
  if (manifest.cases.length > 8) {
    errors.push(`case count ${manifest.cases.length} exceeds hard cap of 8`);
  }

  const ids = new Set();
  const entrypoints = new Set();
  const themes = new Set();
  const layouts = new Set();

  for (const [index, c] of manifest.cases.entries()) {
    const prefix = `cases[${index}]`;
    if (!c || typeof c !== 'object') {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of REQUIRED_CASE_FIELDS) {
      if (c[field] === undefined || c[field] === null || c[field] === '') {
        errors.push(`${prefix}.${field} is required`);
      }
    }
    if (typeof c.id === 'string') {
      if (ids.has(c.id)) errors.push(`duplicate case id: ${c.id}`);
      ids.add(c.id);
      if (!/^V\d{2}-[a-z0-9-]+$/i.test(c.id)) {
        errors.push(`${prefix}.id must match V##-slug form (got ${c.id})`);
      }
    }
    if (c.entrypoint !== 'webview' && c.entrypoint !== 'presentation') {
      errors.push(`${prefix}.entrypoint must be webview|presentation`);
    } else {
      entrypoints.add(c.entrypoint);
    }
    if (!['dark', 'light', 'high-contrast'].includes(c.theme)) {
      errors.push(`${prefix}.theme must be dark|light|high-contrast`);
    } else {
      themes.add(c.theme);
    }
    if (!['compact', 'narrow', 'standard'].includes(c.layout)) {
      errors.push(`${prefix}.layout must be compact|narrow|standard`);
    } else {
      layouts.add(c.layout);
    }
    if (
      !c.viewport ||
      typeof c.viewport.width !== 'number' ||
      typeof c.viewport.height !== 'number'
    ) {
      errors.push(`${prefix}.viewport must be {width,height} numbers`);
    }
    if (!Array.isArray(c.requirements) || c.requirements.length === 0) {
      errors.push(`${prefix}.requirements must be a non-empty array`);
    }
    if (typeof c.owner !== 'string' || c.owner.trim().length < 2) {
      errors.push(`${prefix}.owner must be a stable non-empty string`);
    }
    if (typeof c.snapshotPath === 'string') {
      if (!c.snapshotPath.startsWith('e2e/visual/')) {
        errors.push(`${prefix}.snapshotPath must be under e2e/visual/`);
      }
      if (!c.snapshotPath.endsWith('.png')) {
        errors.push(`${prefix}.snapshotPath must end with .png`);
      }
      if (checkSnapshots) {
        const abs = path.join(repoRoot, c.snapshotPath);
        if (!existsSync(abs)) {
          errors.push(`${prefix}.snapshotPath missing on disk: ${c.snapshotPath}`);
        } else {
          const size = statSync(abs).size;
          if (size < 256) {
            errors.push(
              `${prefix}.snapshotPath too small (${size} bytes): ${c.snapshotPath}`,
            );
          }
          try {
            const buf = readFileSync(abs);
            const ascii = buf.toString('latin1');
            for (const rule of FORBIDDEN_ASCII) {
              if (rule.re.test(ascii)) {
                errors.push(
                  `${prefix}.snapshotPath embeds forbidden ${rule.name}`,
                );
              }
            }
          } catch (err) {
            errors.push(`${prefix}.snapshotPath unreadable: ${err.message}`);
          }
        }
      }
    }
    if (typeof c.fixtureFactory === 'string' && checkFixtureFactories) {
      const source =
        fixtureSource ??
        (existsSync(VISUAL_ENV_PATH)
          ? readFileSync(VISUAL_ENV_PATH, 'utf8')
          : '');
      if (!source.includes(`export function ${c.fixtureFactory}`)) {
        errors.push(
          `${prefix}.fixtureFactory ${c.fixtureFactory} not exported from visual-environment.ts`,
        );
      }
    }
  }

  if (!entrypoints.has('webview') || !entrypoints.has('presentation')) {
    errors.push('matrix must cover both webview and presentation entrypoints');
  }
  for (const theme of ['dark', 'light', 'high-contrast']) {
    if (!themes.has(theme)) {
      errors.push(`matrix must include theme: ${theme}`);
    }
  }
  if (!layouts.has('compact')) {
    errors.push('matrix must include compact layout (320px main webview)');
  }
  if (!layouts.has('narrow')) {
    errors.push('matrix must include narrow layout (Presentation containment)');
  }

  const compactCases = (manifest.cases || []).filter((c) => c.layout === 'compact');
  for (const c of compactCases) {
    if (c.viewport?.width !== 320) {
      errors.push(`${c.id}: compact layout requires viewport.width === 320`);
    }
  }
  const narrowCases = (manifest.cases || []).filter((c) => c.layout === 'narrow');
  for (const c of narrowCases) {
    if (!c.viewport || c.viewport.width > 400) {
      errors.push(`${c.id}: narrow layout requires viewport.width ≤ 400`);
    }
  }

  return { ok: errors.length === 0, errors };
}

describe('visual matrix baseline contract (M014 S02)', () => {
  it('loads a machine-checkable manifest capped at eight cases with full coverage', () => {
    assert.equal(existsSync(MANIFEST_PATH), true, 'visual-cases.manifest.json must exist');
    const manifest = loadManifest();
    const result = validateVisualManifest(manifest);
    assert.equal(
      result.ok,
      true,
      `manifest validation failed:\n- ${result.errors.join('\n- ')}`,
    );
    assert.ok(manifest.cases.length <= 8, 'hard cap of 8 cases');
    assert.ok(manifest.cases.length >= 2, 'at least one case per entrypoint');
    assert.equal(manifest.maxCases, 8);
  });

  it('exports the same flow title and case ids from visual-cases.ts', () => {
    const casesTs = readFileSync(CASES_TS_PATH, 'utf8');
    const manifest = loadManifest();
    assert.match(casesTs, /visual-cases\.manifest\.json/);
    assert.match(casesTs, /M014_S02_FLOW_TITLE/);
    assert.match(casesTs, /VISUAL_MATRIX_MAX_CASES/);
    for (const c of manifest.cases) {
      assert.ok(c.id.length > 0);
    }
    assert.equal(manifest.flowTitle, 'M014 S02 flow: representative visual matrix');
  });

  it('requires the named S02 flow to exist with the exact Playwright title', () => {
    const flows = readFileSync(FLOWS_SPEC_PATH, 'utf8');
    assert.match(
      flows,
      /M014 S02 flow: representative visual matrix/,
      'm014-slice-flows.spec.ts must contain the exact S02 flow title',
    );
    assert.doesNotMatch(
      flows,
      /test\.skip\([^)]*M014 S02 flow: representative visual matrix/,
    );
  });

  it('documents the S02 matrix, cap, and named flow in UI-VISUAL-REGRESSION.md', () => {
    const docs = readFileSync(DOCS_PATH, 'utf8');
    assert.match(docs, /M014 S02 flow: representative visual matrix/);
    assert.match(docs, /visual-cases\.manifest\.json/);
    assert.match(docs, /verify-visual-baselines/);
    assert.match(docs, /eight|≤\s*8|at most eight|maxCases/i);
    assert.match(docs, /V01-webview-compact-dark/);
    assert.match(docs, /V06-presentation-narrow-light/);
    assert.match(docs, /high-contrast|high contrast/i);
    assert.match(docs, /assertPresentationReadableContrast/);
    assert.match(docs, /black-on-black|unreadable contrast/i);
  });

  it('rejects over-cap and incomplete coverage manifests (negative)', () => {
    const base = loadManifest();
    const overCap = {
      ...base,
      maxCases: 8,
      cases: [
        ...base.cases,
        ...Array.from({ length: 3 }, (_, i) => ({
          ...base.cases[0],
          id: `V9${i}-extra-case`,
          snapshotPath: base.cases[0].snapshotPath,
        })),
      ],
    };
    const over = validateVisualManifest(overCap, {
      checkSnapshots: false,
      checkFixtureFactories: false,
    });
    assert.equal(over.ok, false);
    assert.ok(
      over.errors.some((e) => /exceeds maxCases|hard cap/i.test(e)),
      `expected cap error, got: ${over.errors.join('; ')}`,
    );

    const missingTheme = {
      ...base,
      cases: base.cases.filter((c) => c.theme !== 'high-contrast'),
    };
    const mt = validateVisualManifest(missingTheme, {
      checkSnapshots: false,
      checkFixtureFactories: false,
    });
    assert.equal(mt.ok, false);
    assert.ok(mt.errors.some((e) => /high-contrast/.test(e)));

    const missingEntrypoint = {
      ...base,
      cases: base.cases.filter((c) => c.entrypoint !== 'presentation'),
    };
    const me = validateVisualManifest(missingEntrypoint, {
      checkSnapshots: false,
      checkFixtureFactories: false,
    });
    assert.equal(me.ok, false);
    assert.ok(me.errors.some((e) => /presentation/.test(e)));

    const missingNarrow = {
      ...base,
      cases: base.cases.filter((c) => c.layout !== 'narrow'),
    };
    const mn = validateVisualManifest(missingNarrow, {
      checkSnapshots: false,
      checkFixtureFactories: false,
    });
    assert.equal(mn.ok, false);
    assert.ok(mn.errors.some((e) => /narrow/.test(e)));
  });

  it('rejects missing snapshot paths and unknown fixture factories (negative)', () => {
    const base = loadManifest();
    const missingSnap = {
      ...base,
      cases: base.cases.map((c, i) =>
        i === 0
          ? { ...c, snapshotPath: 'e2e/visual/missing-baseline.png' }
          : c,
      ),
    };
    const ms = validateVisualManifest(missingSnap, { checkFixtureFactories: true });
    assert.equal(ms.ok, false);
    assert.ok(ms.errors.some((e) => /missing on disk/.test(e)));

    const badFactory = {
      ...base,
      cases: base.cases.map((c, i) =>
        i === 0 ? { ...c, fixtureFactory: 'createDoesNotExist' } : c,
      ),
    };
    const bf = validateVisualManifest(badFactory, { checkSnapshots: true });
    assert.equal(bf.ok, false);
    assert.ok(bf.errors.some((e) => /createDoesNotExist/.test(e)));
  });

  it('rejects wrong flowTitle (negative)', () => {
    const base = loadManifest();
    const wrong = { ...base, flowTitle: 'M014 S02 flow: something else' };
    const r = validateVisualManifest(wrong, {
      checkSnapshots: false,
      checkFixtureFactories: false,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /flowTitle/.test(e)));
  });
});
