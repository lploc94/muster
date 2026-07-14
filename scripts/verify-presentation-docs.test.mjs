import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = {
  root: new URL('../README.md', import.meta.url),
  index: new URL('../docs/README.md', import.meta.url),
  webview: new URL('../docs/WEBVIEW.md', import.meta.url),
  contributing: new URL('../CONTRIBUTING.md', import.meta.url),
};

const forbiddenClaims = [
  { pattern: /presentation(?:s)? (?:provide|open|include) (?:a )?(?:second|separate|alternate) (?:chat|conversation) channel/i, label: 'second conversation channel' },
  { pattern: /presentation(?:s)? (?:are|is) (?:directly )?editable/i, label: 'editable document' },
  { pattern: /presentation(?:s)? (?:can|may) (?:create|edit|delete|rename|manage) arbitrary files/i, label: 'arbitrary file management' },
  { pattern: /(?:local|Playwright|integration) (?:tests?|gates?).{0,40}(?:prove|guarantee) (?:the )?live[- ]host/i, label: 'unconditional live-host success' },
];

export function validatePresentationDocs({ root, index, webview, contributing }) {
  assert.match(root, /\[docs\/WEBVIEW\.md\]\(docs\/WEBVIEW\.md\)/, 'README must link the presentation guide');
  assert.match(root, /read-only presentation/i, 'README must identify read-only presentations');
  assert.match(index, /\[WEBVIEW\.md\]\(WEBVIEW\.md\)/, 'docs index must link WEBVIEW');
  assert.match(index, /presentation/i, 'docs index must advertise presentation guidance');

  for (const phrase of [
    /coordinator-triggered dedicated tab/i,
    /stable presentation ID/i,
    /monotonic revision/i,
    /multiple tabs/i,
    /Markdown/i,
    /table/i,
    /code/i,
    /link/i,
    /Mermaid/i,
    /visible fallback/i,
    /linked chat/i,
    /existing task/i,
    /restore/i,
    /dispose/i,
    /data-mermaid-state/i,
    /data-mermaid-reason/i,
    /read-only/i,
  ]) assert.match(webview, phrase, `WEBVIEW presentation guide missing ${phrase}`);

  for (const phrase of [
    /npm run test:presentation-integration/,
    /npm run compile/,
    /npm run test:webview -- e2e\/muster-presentation\.spec\.ts/,
    /F5/,
    /Extension Development Host/,
    /presentation-live-host-evidence\.md/,
    /PASS/,
    /FAIL/,
    /ENVIRONMENT BLOCKED/,
    /supportive only/i,
    /cleanup/i,
    /credentials|secrets/i,
    /absolute local paths/i,
  ]) assert.match(contributing, phrase, `contributor proof guide missing ${phrase}`);

  const combined = [root, index, webview, contributing].join('\n');
  for (const { pattern, label } of forbiddenClaims) assert.ok(!pattern.test(combined), `forbidden presentation claim: ${label}`);
}

const valid = {
  root: 'Read-only presentation guide: [docs/WEBVIEW.md](docs/WEBVIEW.md)',
  index: '[WEBVIEW.md](WEBVIEW.md) — chat and presentation guidance',
  webview: 'A coordinator-triggered dedicated tab uses a stable presentation ID and monotonic revision. Multiple tabs isolate Markdown, table, code, and link content. Mermaid has a visible fallback. Linked chat continues the existing task. Restore and dispose preserve lifecycle rules. Inspect data-mermaid-state and data-mermaid-reason. This is read-only.',
  contributing: 'Run npm run test:presentation-integration, npm run compile, and npm run test:webview -- e2e/muster-presentation.spec.ts. Then press F5 for the Extension Development Host. Update presentation-live-host-evidence.md with PASS, FAIL, or ENVIRONMENT BLOCKED. Local results are supportive only. Record cleanup; omit credentials, secrets, and absolute local paths.',
};

test('tracked presentation documentation satisfies the operating and proof contract', async () => {
  const entries = await Promise.all(Object.entries(paths).map(async ([key, url]) => [key, await readFile(url, 'utf8')]));
  validatePresentationDocs(Object.fromEntries(entries));
});

test('accepts a complete bounded fixture', () => validatePresentationDocs(valid));

test('rejects alternate chat and editable-document claims', () => {
  assert.throws(() => validatePresentationDocs({ ...valid, webview: `${valid.webview} Presentations provide a second chat channel.` }), /second conversation channel/);
  assert.throws(() => validatePresentationDocs({ ...valid, webview: `${valid.webview} Presentations are directly editable.` }), /editable document/);
});

test('rejects arbitrary file management and local-as-live overclaim', () => {
  assert.throws(() => validatePresentationDocs({ ...valid, webview: `${valid.webview} Presentations can manage arbitrary files.` }), /arbitrary file management/);
  assert.throws(() => validatePresentationDocs({ ...valid, contributing: `${valid.contributing} Local tests prove live-host behavior.` }), /unconditional live-host success/);
});
