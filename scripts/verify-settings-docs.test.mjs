import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SETTINGS_DOC = 'docs/SETTINGS.md';
const README_DOC = 'README.md';
const DOCS_INDEX = 'docs/README.md';
const WEBVIEW_DOC = 'docs/WEBVIEW.md';
const CONTRIBUTING_DOC = 'CONTRIBUTING.md';
const PACKAGE_JSON = 'package.json';
const CI_WORKFLOW = '.github/workflows/ci.yml';

async function readProjectFile(path) {
  return readFile(path, 'utf8');
}

const requiredSettingsConcepts = [
  {
    name: 'fresh-reader audience and action',
    pattern: /reader:\s*internal contributors[\s\S]*post-read action:\s*add a new setting/i,
  },
  {
    name: 'VS Code contributed configuration backs at least one real settings group',
    pattern: /at least one real settings group[\s\S]*VS Code contributed configuration/i,
  },
  {
    name: 'extension host owns reads and writes',
    pattern: /extension host owns[\s\S]*(reads|read)[\s\S]*(writes|write)/i,
  },
  {
    name: 'webview messages are typed and runtime-guarded',
    pattern: /typed[\s\S]*runtime-guarded/i,
  },
  {
    name: 'invalid updates fail closed with sanitized feedback',
    pattern: /fail closed[\s\S]*sanitized feedback/i,
  },
  {
    name: 'unit and protocol coverage pairs with Playwright harness',
    pattern: /unit[\s\S]*protocol[\s\S]*Playwright/i,
  },
  {
    name: 'App-owned drafts and domain-local feedback',
    pattern: /App-owned drafts[\s\S]*domain-local/i,
  },
  {
    name: 'settings view-state hide/reveal key',
    pattern: /muster\.settingsView\.v1/,
  },
  {
    name: 'workspace-level taskTypes scope honesty',
    pattern: /workspace-level[\s\S]*muster\.taskTypes[\s\S]*Folder-specific resource overrides/i,
  },
  {
    name: 'Settings domain taxonomy',
    pattern:
      /four[- ]domain[\s\S]*Agents[\s\S]*Execution[\s\S]*Connections[\s\S]*Data/i,
  },
  {
    name: 'three rendered actionable domains',
    pattern: /three[\s\S]*(?:tabs|domains)[\s\S]*Agents[\s\S]*Execution[\s\S]*Data/i,
  },
  {
    name: 'Connections reserved and not rendered',
    pattern: /Connections[\s\S]*reserved[\s\S]*not rendered|reserved[\s\S]*Connections/i,
  },
  {
    name: 'no empty or placeholder navigation',
    pattern: /no[\s\S]*(?:empty|placeholder)[\s\S]*navigation|no `?Coming soon`? tab/i,
  },
  {
    name: 'rendered section names',
    pattern: /Task profiles[\s\S]*Run limits[\s\S]*Tool access[\s\S]*History[\s\S]*Outputs/i,
  },
  {
    name: 'cross-domain feedback isolation contract',
    pattern: /(?:cross-domain|across the two domains|owning domain)[\s\S]*(?:leak|bleed|not render|surface only)/i,
  },
  {
    name: 'WAI-ARIA keyboard tablist behavior',
    pattern: /WAI-ARIA[\s\S]*ArrowLeft[\s\S]*ArrowRight[\s\S]*Home[\s\S]*End/i,
  },
  {
    name: '320-pixel equal-width no-scroll row',
    pattern:
      /320[\s\S]*(?:equal[- ]width|same width)[\s\S]*(?:one|single)[- ]row[\s\S]*(?:without|no)[- ]horizontal[- ]scroll/i,
  },
  {
    name: 'saved snapshot versus draft versus navigation state',
    pattern:
      /saved host snapshots[\s\S]*drafts[\s\S]*navigation|snapshot[\s\S]*draft[\s\S]*navigation state/i,
  },
  {
    name: 'permission enum and pending-request isolation',
    pattern:
      /muster\.permissions\.mode[\s\S]*(?:ask|allow|readonly)[\s\S]*pending[\s\S]*(?:stay|remain|isolation)/i,
  },
  {
    name: 'Task Types ship defaults include breakdown',
    pattern:
      /breakdown[\s\S]*(?:coordinate|plan|implement|verify|research)|coordinate[\s\S]*plan[\s\S]*breakdown[\s\S]*implement[\s\S]*verify[\s\S]*research/i,
  },
  {
    name: 'browser-versus-native proof boundary',
    pattern:
      /(?:browser|Playwright)[\s\S]*supportive only[\s\S]*(?:Extension Development Host|native)|proof boundary/i,
  },
  {
    name: 'R008 requirement reference',
    pattern: /\bR008\b/,
  },
  {
    name: 'local documentation verifier command',
    pattern: /(?:node --test scripts\/verify-settings-docs\.test\.mjs|npm run test:settings-docs)/,
  },
  {
    name: 'focused Playwright settings harness command',
    pattern:
      /(?:npx playwright test e2e\/muster-webview-state\.spec\.ts|npm run test:settings-webview|npm run test:webview)/,
  },
  {
    name: 'live-host evidence ledger command',
    pattern: /(?:npm run test:settings-live-evidence|verify-settings-live-host-evidence)/,
  },
];

const requiredHeadings = [
  '# Settings pattern',
  '## Reader and action',
  '## Non-negotiable invariants',
  '## Settings domain taxonomy',
  '## State ownership and workspace scope',
  '## How to add a setting',
  '## Settings addition checklist',
  '## Failure behavior',
  '## Verification',
  '## Proof boundary',
];

const unsupportedClaimPatterns = [
  {
    name: 'live VS Code Extension Development Host proof',
    pattern:
      /(?:verified|proven|tested|confirmed|validated)\s+(?:in|inside|with|against)\s+(?:a\s+)?(?:live\s+)?VS Code Extension Development Host/i,
  },
  {
    name: 'hosted CI proof',
    pattern: /(?:verified|proven|tested|confirmed|validated)\s+(?:in|by|on|with)\s+(?:hosted\s+)?CI/i,
  },
  {
    name: 'secret handling proof',
    pattern:
      /(?:secret|token|credential|API key)s?\s+(?:are|is)\s+(?:stored|managed|validated|verified|handled)/i,
  },
  {
    name: 'runtime session persistence proof',
    pattern:
      /(?:runtime|live)\s+session\s+(?:persistence|retention|restore|recovery)\s+(?:is|was|has been)\s+(?:verified|proven|tested|confirmed|validated)/i,
  },
  {
    name: 'CI ran native UAT claim',
    pattern:
      /(?:CI|hosted CI|GitHub Actions)\s+(?:ran|runs|proves|proved|validates|validated)\s+(?:native|live[- ]host|Extension Development Host)\s+(?:UAT|proof|scenarios?)/i,
  },
  {
    name: 'browser evidence promoted to native proof',
    pattern:
      /(?:Playwright|browser)\s+(?:results?|tests?|evidence)\s+(?:prove|proves|count as|are)\s+(?:live|native)/i,
  },
];

function missingRequiredConcepts(markdown) {
  return requiredSettingsConcepts
    .filter(({ pattern }) => !pattern.test(markdown))
    .map(({ name }) => name);
}

function unsupportedClaims(markdown) {
  return unsupportedClaimPatterns
    .filter(({ pattern }) => pattern.test(markdown))
    .map(({ name }) => name);
}

function assertSettingsContract(markdown) {
  assert.ok(markdown.trim().length > 800, 'docs/SETTINGS.md should be a substantive fresh-reader guide');

  const missingHeadings = requiredHeadings.filter((heading) => !markdown.includes(heading));
  assert.deepEqual(missingHeadings, [], `docs/SETTINGS.md is missing headings: ${missingHeadings.join(', ')}`);

  const missingConcepts = missingRequiredConcepts(markdown);
  assert.deepEqual(missingConcepts, [], `docs/SETTINGS.md is missing concepts: ${missingConcepts.join(', ')}`);

  const forbiddenClaims = unsupportedClaims(markdown);
  assert.deepEqual(
    forbiddenClaims,
    [],
    `docs/SETTINGS.md contains unsupported claims: ${forbiddenClaims.join(', ')}`,
  );

  assert.equal(/\.gsd\//.test(markdown), false, 'docs/SETTINGS.md should not depend on .gsd paths');
}

const requiredContributingMarkers = [
  /npm run test:settings-docs/,
  /npm run test:settings-live-evidence/,
  /npm run test:settings-webview/,
  /npm run test:settings-acceptance/,
  /settings-live-host-evidence\.md/,
  /PASS/,
  /FAIL/,
  /ENVIRONMENT BLOCKED/,
  /supportive only/i,
  /Extension Development Host/,
  /F5/,
];

describe('Settings documentation contract', () => {
  it('keeps the host-backed settings guide substantive, local, and bounded', async () => {
    const markdown = await readProjectFile(SETTINGS_DOC);
    assertSettingsContract(markdown);
  });

  it('links the guide from contributor entry points', async () => {
    const [readme, docsIndex, webview, contributing] = await Promise.all([
      readProjectFile(README_DOC),
      readProjectFile(DOCS_INDEX),
      readProjectFile(WEBVIEW_DOC),
      readProjectFile(CONTRIBUTING_DOC),
    ]);

    assert.match(readme, /docs\/SETTINGS\.md/, 'README.md should link docs/SETTINGS.md');
    assert.match(
      readme,
      /SETTINGS-DESIGN\.md[\s\S]*Adopted[\s\S]*three actionable tabs[\s\S]*Connections reserved/i,
      'README.md should describe the adopted Settings design precisely',
    );
    assert.match(docsIndex, /\[`?SETTINGS\.md`?\]\(SETTINGS\.md\)/, 'docs/README.md should link SETTINGS.md');
    assert.match(
      docsIndex,
      /Agents[\s\S]*Execution[\s\S]*Connections[\s\S]*Data|domain shell/i,
      'docs/README.md should advertise the Settings domain surface',
    );
    assert.match(
      docsIndex,
      /m012-s04\/settings-live-host-evidence\.md/,
      'docs/README.md should link the Settings live-host evidence ledger',
    );
    assert.match(webview, /\[`?SETTINGS\.md`?\]\(SETTINGS\.md\)/, 'docs/WEBVIEW.md related docs should link SETTINGS.md');
    assert.match(contributing, /Settings verification/i, 'CONTRIBUTING.md should document Settings verification');
    for (const marker of requiredContributingMarkers) {
      assert.match(contributing, marker, `CONTRIBUTING.md missing Settings proof marker: ${marker}`);
    }
  });

  it('wires focused Settings package scripts and CI gates', async () => {
    const [pkgText, ciText] = await Promise.all([
      readProjectFile(PACKAGE_JSON),
      readProjectFile(CI_WORKFLOW),
    ]);
    const pkg = JSON.parse(pkgText);
    const scripts = pkg.scripts ?? {};

    assert.equal(
      scripts['test:settings-docs'],
      'node --test scripts/verify-settings-docs.test.mjs',
      'test:settings-docs must run the Settings docs verifier',
    );
    assert.equal(
      scripts['test:settings-live-evidence'],
      'node --test scripts/verify-settings-live-host-evidence.test.mjs',
      'test:settings-live-evidence must run the live-host ledger verifier',
    );
    assert.match(
      String(scripts['test:settings-webview'] ?? ''),
      /playwright test e2e\/muster-webview-state\.spec\.ts/,
      'test:settings-webview must run the Settings Playwright suite',
    );
    assert.match(
      String(scripts['test:settings-acceptance'] ?? ''),
      /test:settings-docs/,
      'test:settings-acceptance must include the docs verifier',
    );
    assert.match(
      String(scripts['test:settings-acceptance'] ?? ''),
      /test:settings-live-evidence/,
      'test:settings-acceptance must include the live-evidence verifier',
    );
    assert.match(
      String(scripts['test:settings-acceptance'] ?? ''),
      /test:settings-webview|test:webview/,
      'test:settings-acceptance must include the Settings webview suite',
    );
    assert.match(
      String(scripts['test:settings-acceptance'] ?? ''),
      /compile/,
      'test:settings-acceptance must include compile',
    );
    assert.match(
      String(scripts['test:settings-acceptance'] ?? ''),
      /check:svelte/,
      'test:settings-acceptance must include Svelte check',
    );

    for (const step of [
      'npm test',
      'npm run test:settings-docs',
      'npm run test:settings-live-evidence',
      'npm run compile',
      'npm run check:svelte',
      'npm run test:webview',
    ]) {
      assert.match(ciText, new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `CI must run ${step}`);
    }
    // Only reject affirmative CI claim sentences, not explanatory comments that
    // deny native UAT (e.g. "does not mean ... native UAT").
    assert.doesNotMatch(
      ciText,
      /(?:^|[^\w-])(?:CI|hosted CI|GitHub Actions)\s+(?:ran|runs|proves|proved|validates|validated)\s+(?:native|live[- ]host|Extension Development Host)\s+(?:UAT|proof|scenarios?)/im,
      'CI must not claim native UAT ran',
    );
    // Align with source-boundary: compile is required after npm test (not compile-only).
    assert.match(ciText, /run: npm test[\s\S]*run: npm run compile/, 'CI must run compile after npm test');
  });

  it('rejects fixture docs that omit required host-backed concepts', () => {
    const incompleteGuide = `# Settings pattern\n\n## Reader and action\nReader: internal contributors. Post-read action: add a new setting.\n\n## Verification\nRun node --test scripts/verify-settings-docs.test.mjs.`;

    const missingConcepts = missingRequiredConcepts(incompleteGuide);
    assert.ok(missingConcepts.includes('extension host owns reads and writes'));
    assert.ok(missingConcepts.includes('invalid updates fail closed with sanitized feedback'));
    assert.ok(missingConcepts.includes('unit and protocol coverage pairs with Playwright harness'));
    assert.ok(missingConcepts.includes('Settings domain taxonomy'));
    assert.ok(missingConcepts.includes('WAI-ARIA keyboard tablist behavior'));
    assert.ok(missingConcepts.includes('Task Types ship defaults include breakdown'));
  });

  it('rejects fixture docs that omit taxonomy, accessibility, state, security, placeholder, or proof markers', () => {
    const partialGuide = `# Settings pattern

## Reader and action
Reader: internal contributors who are extending Muster after the retention settings pattern exists.
Post-read action: add a new setting to Muster using the same host-backed pattern.

## Non-negotiable invariants
- At least one real settings group is backed by VS Code contributed configuration.
- The extension host owns reads and writes.
- Webview messages are typed and runtime-guarded.
- Invalid updates fail closed with sanitized feedback.
- Unit and protocol coverage pairs with Playwright harness coverage.
- Settings documentation is part of R008.

## State ownership and workspace scope
- App-owned drafts and domain-local feedback.
- muster.settingsView.v1
- workspace-level muster.taskTypes Folder-specific resource overrides

## How to add a setting
1. Add the setting.

## Settings addition checklist
- Checklist.

## Failure behavior
| Failure | Required behavior |
|---------|-------------------|

## Verification
node --test scripts/verify-settings-docs.test.mjs
npx playwright test e2e/muster-webview-state.spec.ts
`;

    const missing = missingRequiredConcepts(partialGuide);
    for (const name of [
      'Settings domain taxonomy',
      'WAI-ARIA keyboard tablist behavior',
      '320-pixel equal-width no-scroll row',
      'permission enum and pending-request isolation',
      'Connections reserved and not rendered',
      'no empty or placeholder navigation',
      'rendered section names',
      'cross-domain feedback isolation contract',
      'browser-versus-native proof boundary',
      'Task Types ship defaults include breakdown',
    ]) {
      assert.ok(missing.includes(name), `expected missing concept: ${name}`);
    }
  });

  it('rejects fixture docs that overclaim unsupported runtime, hosted CI, secret, session, or native-from-browser proof', () => {
    const overclaimingGuide = `# Settings pattern

This was verified in a live VS Code Extension Development Host.
The settings were validated by hosted CI.
Secrets are handled by this surface.
Runtime session persistence has been verified.
CI ran native UAT for Settings.
Playwright results prove live Extension Development Host behavior.
`;

    const claims = unsupportedClaims(overclaimingGuide);
    assert.deepEqual(claims, [
      'live VS Code Extension Development Host proof',
      'hosted CI proof',
      'secret handling proof',
      'runtime session persistence proof',
      'CI ran native UAT claim',
      'browser evidence promoted to native proof',
    ]);
  });
});
