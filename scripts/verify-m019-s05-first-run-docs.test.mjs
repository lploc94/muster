/**
 * M019/S05 first-run recovery documentation contract.
 *
 * Fail-closed verifier for user recovery docs (install/auth prerequisites,
 * readiness states, Test Connection, Doctor, troubleshooting codes, privacy,
 * Agents vs Connections, and browser-versus-native proof boundary).
 * Does not claim live Extension Development Host or real-provider proof.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const required = {
  'docs/SETTINGS.md': [
    '## Agents → Backends readiness and recovery',
    'Agents → Backends',
    'Test Connection',
    'Refresh',
    'Muster: Run Diagnostics',
    'BackendReadinessSnapshot',
    'install',
    'login',
    'update',
    'retry',
    'executable_missing',
    'auth_required',
    'session_probe_failed',
    'no model prompt',
    'Connections',
    'supportive only',
    'ENVIRONMENT BLOCKED',
    'npm run test:m019-s05',
    'docs/uat/m019-s05/native-first-run-evidence.md',
  ],
  'docs/WEBVIEW.md': [
    '## 16. Trustworthy first run and backend recovery',
    'first-run journey',
    'Agents → Backends',
    'Test Connection',
    'Open backend setup',
    'Muster: Run Diagnostics',
    'revealBackendDiagnostics',
    'ready',
    'installed_unverified',
    'auth_required',
    'supportive only',
    'ENVIRONMENT BLOCKED',
    'SETTINGS.md',
    'docs/uat/m019-s05/native-first-run-evidence.md',
  ],
  'docs/README.md': [
    'Trustworthy first run',
    'Agents → Backends',
    'Native first-run evidence',
    'm019-s05/native-first-run-evidence.md',
  ],
  'package.json': [
    '"test:m019-s05-docs": "node --test scripts/verify-m019-s05-first-run-docs.test.mjs"',
    '"test:m019-s05":',
  ],
};

const unsupportedClaimPatterns = [
  {
    name: 'browser promoted to native proof',
    pattern:
      /(?:Playwright|browser)\s+(?:results?|tests?|evidence)\s+(?:prove|proves|count as|are)\s+(?:live|native)/i,
  },
  {
    name: 'live host verified claim without ledger',
    pattern:
      /(?:verified|proven|tested|confirmed|validated)\s+(?:in|inside|with|against)\s+(?:a\s+)?(?:live\s+)?VS Code Extension Development Host/i,
  },
  {
    name: 'secret storage claim',
    pattern:
      /(?:secret|token|credential|API key)s?\s+(?:are|is)\s+(?:stored|managed|validated|verified|handled)/i,
  },
];

function validate(files) {
  for (const [name, markers] of Object.entries(required)) {
    const text = files[name];
    assert.ok(typeof text === 'string' && text.trim(), `Missing documentation file: ${name}`);
    for (const marker of markers) {
      assert.ok(text.includes(marker), `${name} missing contract marker: ${marker}`);
    }
  }

  const settings = files['docs/SETTINGS.md'];
  const backendsHeading = settings.indexOf('## Agents → Backends readiness and recovery');
  assert.ok(backendsHeading >= 0, 'SETTINGS.md missing Backends recovery heading');
  const nextHeading = settings.indexOf('\n## ', backendsHeading + 1);
  const backendsSection =
    nextHeading >= 0 ? settings.slice(backendsHeading, nextHeading) : settings.slice(backendsHeading);

  assert.match(
    backendsSection,
    /passive[\s\S]*Refresh|Refresh[\s\S]*passive/i,
    'SETTINGS.md must distinguish passive Refresh from active Test Connection',
  );
  assert.match(
    backendsSection,
    /never\s+(?:sends?|create[sd]?)\s+(?:a\s+)?(?:model\s+)?prompt|no model prompt/i,
    'SETTINGS.md must document that Test Connection sends no model prompt',
  );
  assert.match(
    backendsSection,
    /Agents[\s\S]*task[\s\S]*backend|backend[\s\S]*Agents[\s\S]*Connections/i,
    'SETTINGS.md must document Agents backends vs Connections boundary',
  );
  assert.match(
    backendsSection,
    /sanitized|redact|no\s+(?:raw\s+)?(?:stderr|paths?|secrets?)/i,
    'SETTINGS.md must document privacy/redaction boundaries for readiness diagnostics',
  );
  assert.doesNotMatch(
    backendsSection,
    /(?:Playwright|browser)\s+(?:results?|tests?|evidence)\s+(?:prove|proves|count as|are)\s+(?:live|native)/i,
    'SETTINGS.md must not promote browser evidence to native proof',
  );

  const webview = files['docs/WEBVIEW.md'];
  const webviewHeading = webview.indexOf('## 16. Trustworthy first run and backend recovery');
  assert.ok(webviewHeading >= 0, 'WEBVIEW.md missing first-run recovery heading');
  const webviewNext = webview.indexOf('\n## ', webviewHeading + 1);
  const webviewSection =
    webviewNext >= 0 ? webview.slice(webviewHeading, webviewNext) : webview.slice(webviewHeading);
  assert.match(
    webviewSection,
    /clean workspace|no[- ]task|zero root tasks|first task/i,
    'WEBVIEW.md must document clean-workspace first-task eligibility',
  );
  assert.match(
    webviewSection,
    /supportive only/i,
    'WEBVIEW.md first-run section must restate browser supportive-only boundary',
  );

  for (const doc of ['docs/SETTINGS.md', 'docs/WEBVIEW.md']) {
    const forbidden = unsupportedClaimPatterns
      .filter(({ pattern }) => pattern.test(files[doc]))
      .map(({ name }) => name);
    assert.deepEqual(forbidden, [], `${doc} contains unsupported claims: ${forbidden.join(', ')}`);
  }

  const pkg = JSON.parse(files['package.json']);
  const scripts = pkg.scripts ?? {};
  assert.equal(
    scripts['test:m019-s05-docs'],
    'node --test scripts/verify-m019-s05-first-run-docs.test.mjs',
    'package.json test:m019-s05-docs must point at this verifier',
  );
  assert.ok(
    typeof scripts['test:m019-s05'] === 'string' && scripts['test:m019-s05'].includes('test:m019-s05-docs'),
    'package.json test:m019-s05 aggregate must include the docs verifier',
  );
  assert.ok(
    scripts['test:m019-s05'].includes('test:m019-s05-native-evidence'),
    'package.json test:m019-s05 aggregate must include native evidence verifier',
  );
  assert.ok(
    scripts['test:m019-s05'].includes('M019 S05 Assembled First Run'),
    'package.json test:m019-s05 aggregate must include assembled Playwright first-run proof',
  );

  return true;
}

async function trackedFiles() {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(required).map(async (name) => [name, await readFile(new URL(name, root), 'utf8')]),
    ),
  );
}

test('tracked documentation defines and exposes the complete first-run recovery contract', async () => {
  assert.equal(validate(await trackedFiles()), true);
});

test('rejects omitted recovery, Doctor, proof-boundary, and aggregate-gate markers', async () => {
  const files = await trackedFiles();
  for (const marker of [
    '## Agents → Backends readiness and recovery',
    'Muster: Run Diagnostics',
    'npm run test:m019-s05',
    '## 16. Trustworthy first run and backend recovery',
    'Native first-run evidence',
  ]) {
    const owners = Object.keys(required).filter((name) => files[name].includes(marker));
    assert.ok(owners.length > 0, `fixture marker owner missing: ${marker}`);
    // Strip from every tracked file that carries the marker so shared markers
    // (Doctor, aggregate gate) still fail closed when omitted product-wide.
    const stripped = { ...files };
    for (const owner of owners) {
      stripped[owner] = stripped[owner].split(marker).join('');
    }
    assert.throws(() => validate(stripped), /missing contract marker/);
  }
});

test('rejects documentation that promotes browser results to native proof', async () => {
  const files = await trackedFiles();
  const polluted = files['docs/SETTINGS.md'].replace(
    'supportive only',
    'Playwright results prove native Extension Development Host readiness',
  );
  assert.throws(
    () => validate({ ...files, 'docs/SETTINGS.md': polluted }),
    /must not promote browser|unsupported claims|missing contract marker/,
  );
});

test('rejects aggregate gate that drops docs or evidence coverage', async () => {
  const files = await trackedFiles();
  const pkg = JSON.parse(files['package.json']);
  pkg.scripts['test:m019-s05'] = 'echo ok';
  assert.throws(
    () => validate({ ...files, 'package.json': JSON.stringify(pkg, null, 2) }),
    /aggregate must include/,
  );
});
