import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const required = {
  'docs/WEBVIEW.md': [
    '## 12. Workspace file-drop mentions',
    '`resolveFileDrop`',
    '`filePicked`',
    'one regular file',
    'current workspace',
    'textual mention',
    'not an attachment',
    'caret',
    'does not change the draft',
    'workspace-relative',
    'bounded, sanitized user-facing error',
    'Local unit and Playwright checks are supportive only',
    'Extension Development Host',
  ],
  'CONTRIBUTING.md': [
    '## File-drop verification and live-host evidence',
    'npm run test:file-drop-docs',
    'npm run test:file-drop-live-evidence',
    'e2e/muster-webview-state.spec.ts',
    'VS Code Explorer',
    'operating-system file manager',
    'ENVIRONMENT BLOCKED',
    'docs/uat/m007-s02/file-drop-live-host-evidence.md',
    'supportive only',
  ],
  'docs/README.md': [
    'workspace file-drop mention contract',
    'File-drop live-host evidence',
  ],
  'package.json': [
    '"test:file-drop-docs": "node --test scripts/verify-file-drop-docs.test.mjs"',
  ],
};

function validate(files) {
  for (const [name, markers] of Object.entries(required)) {
    const text = files[name];
    assert.ok(typeof text === 'string' && text.trim(), `Missing documentation file: ${name}`);
    for (const marker of markers) assert.ok(text.includes(marker), `${name} missing contract marker: ${marker}`);
  }
  const webview = files['docs/WEBVIEW.md'];
  const fileDropSection = webview.slice(webview.indexOf('## 12. Workspace file-drop mentions'), webview.indexOf('## 13. Read-only presentation review'));
  assert.doesNotMatch(fileDropSection, /^A file drop (?:uploads?|attaches?) the file/im, 'File drop must not be documented as file upload/attachment');
  assert.match(fileDropSection, /rejected with a bounded, sanitized user-facing error/i, 'WEBVIEW.md must document bounded error behavior');
  return true;
}

async function trackedFiles() {
  return Object.fromEntries(await Promise.all(Object.keys(required).map(async (name) => [name, await readFile(new URL(name, root), 'utf8')])));
}

test('tracked documentation defines and exposes the complete file-drop contract', async () => {
  assert.equal(validate(await trackedFiles()), true);
});

test('rejects omitted protocol, security, proof-boundary, and operating markers', async () => {
  const files = await trackedFiles();
  for (const marker of ['`resolveFileDrop`', 'not an attachment', 'Local unit and Playwright checks are supportive only', 'ENVIRONMENT BLOCKED']) {
    const owner = Object.keys(required).find((name) => files[name].includes(marker));
    assert.ok(owner, `fixture marker owner missing: ${marker}`);
    assert.throws(() => validate({ ...files, [owner]: files[owner].split(marker).join('') }), /missing contract marker/);
  }
});

test('rejects documentation that promotes file drop to upload or omits bounded errors', async () => {
  const files = await trackedFiles();
  const misleadingUpload = files['docs/WEBVIEW.md'].replace('### Proof boundary', 'A file drop uploads the file.\n\n### Proof boundary');
  assert.throws(() => validate({ ...files, 'docs/WEBVIEW.md': misleadingUpload }), /must not be documented/);
  const withoutErrorContract = files['docs/WEBVIEW.md'].replace('bounded, sanitized user-facing error', 'unbounded raw failure');
  assert.throws(() => validate({ ...files, 'docs/WEBVIEW.md': withoutErrorContract }), /missing contract marker|bounded error behavior/);
});
