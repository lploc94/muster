/**
 * M022/S02 T01 — dependency prune + package script contract.
 *
 * Only @modelcontextprotocol/sdk is a genuine Extension Host runtime dependency.
 * The 10 webview-only packages are bundled by vite into dist/webview and must
 * live under devDependencies so vsce does not stage them into the VSIX.
 *
 * R036 requires a repeatable `npm run package` that invokes `vsce package`
 * without `--no-dependencies` (SDK production closure must still ship).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WEBVIEW_ONLY_PACKAGES = [
  '@tailwindcss/typography',
  '@tanstack/svelte-virtual',
  '@tanstack/virtual-core',
  '@vscode-elements/elements',
  'diff',
  'dompurify',
  'github-markdown-css',
  'highlight.js',
  'marked',
  'mermaid',
];

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
}

describe('M022/S02 T01 packaging dependency shape', () => {
  it('keeps only @modelcontextprotocol/sdk in dependencies', () => {
    const pkg = readPackageJson();
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    assert.deepEqual(
      deps,
      ['@modelcontextprotocol/sdk'],
      `dependencies must contain only the MCP SDK; found: ${deps.join(', ') || '(none)'}`,
    );
  });

  it('moves the 10 webview-only packages into devDependencies', () => {
    const pkg = readPackageJson();
    const dev = pkg.devDependencies ?? {};
    const missing = WEBVIEW_ONLY_PACKAGES.filter((name) => !(name in dev));
    assert.deepEqual(
      missing,
      [],
      `webview-only packages missing from devDependencies: ${missing.join(', ') || '(none)'}`,
    );
    for (const name of WEBVIEW_ONLY_PACKAGES) {
      assert.equal(
        name in (pkg.dependencies ?? {}),
        false,
        `${name} must not remain under dependencies`,
      );
    }
  });

  it('exposes npm run package as vsce package without --no-dependencies', () => {
    const pkg = readPackageJson();
    const script = pkg.scripts?.package;
    assert.equal(typeof script, 'string', 'scripts.package must exist');
    assert.match(
      String(script),
      /\bvsce\s+package\b/,
      `scripts.package must invoke vsce package; got: ${script}`,
    );
    assert.equal(
      /--no-dependencies\b/.test(String(script)),
      false,
      'scripts.package must not pass --no-dependencies (SDK closure must ship)',
    );
  });
});
