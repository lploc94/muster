/**
 * M022/S04 T01 — fail-closed webview bundle contract.
 *
 * The 10 webview-only packages live in devDependencies on the claim that vite
 * bundles them into dist/webview with zero unresolved bare specifiers. This
 * suite asserts that claim against the real tree (positive) and against
 * temp-dir fixtures for both negatives (missing dir, bare mermaid import).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWebviewBundleCheck, WEBVIEW_ONLY_PACKAGES } from './packaging-webview-bundle.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempRoot(build, fn) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'm022-s04-webview-'));
  try {
    await build(rootDir);
    return await fn(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe('M022/S04 T01 packaging webview bundle', () => {
  it('exports the same 10 webview-only package names as the dependency-shape contract', () => {
    assert.deepEqual(
      [...WEBVIEW_ONLY_PACKAGES].sort(),
      [
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
      ],
    );
  });

  it('passes against the real built dist/webview tree', async () => {
    const result = await runWebviewBundleCheck({ rootDir: REPO_ROOT });
    assert.equal(
      result.ok,
      true,
      `expected ok against real tree; failures: ${JSON.stringify(result.failures, null, 2)}`,
    );
    assert.equal(result.failures.length, 0);
    assert.ok(
      result.assetCount > 0,
      `expected assetCount > 0; got ${result.assetCount}`,
    );
  });

  it('fails closed with missing-webview-dir when dist/webview is absent', async () => {
    await withTempRoot(
      async () => {
        /* empty root: no dist/webview */
      },
      async (rootDir) => {
        const result = await runWebviewBundleCheck({ rootDir });
        assert.equal(result.ok, false);
        assert.ok(result.failures.length >= 1);
        const failure = result.failures.find((f) => f.reason === 'missing-webview-dir');
        assert.ok(failure, `expected missing-webview-dir; got ${JSON.stringify(result.failures)}`);
        assert.match(String(failure.path), /dist[\\/]+webview/);
        assert.match(
          String(failure.message ?? failure.path),
          /dist[\\/]+webview/,
          'diagnostic must name the missing dist/webview path',
        );
      },
    );
  });

  it('fails closed with unresolved-bare-specifier naming package and asset file', async () => {
    await withTempRoot(
      async (rootDir) => {
        const assetsDir = path.join(rootDir, 'dist', 'webview', 'assets');
        await mkdir(assetsDir, { recursive: true });
        await writeFile(
          path.join(assetsDir, 'index-bad.js'),
          "import mermaid from 'mermaid';\nexport const x = mermaid;\n",
          'utf8',
        );
      },
      async (rootDir) => {
        const result = await runWebviewBundleCheck({ rootDir });
        assert.equal(result.ok, false);
        const failure = result.failures.find((f) => f.reason === 'unresolved-bare-specifier');
        assert.ok(
          failure,
          `expected unresolved-bare-specifier; got ${JSON.stringify(result.failures)}`,
        );
        assert.equal(failure.package, 'mermaid');
        assert.equal(failure.asset, 'index-bad.js');
        assert.match(
          String(failure.message ?? ''),
          /mermaid/,
          'diagnostic must name the package',
        );
        assert.match(
          String(failure.message ?? failure.asset),
          /index-bad\.js/,
          'diagnostic must name the asset filename',
        );
      },
    );
  });

  it('fails closed with missing-assets-dir when assets/ is absent under dist/webview', async () => {
    await withTempRoot(
      async (rootDir) => {
        await mkdir(path.join(rootDir, 'dist', 'webview'), { recursive: true });
        await writeFile(path.join(rootDir, 'dist', 'webview', 'index.html'), '<html></html>', 'utf8');
      },
      async (rootDir) => {
        const result = await runWebviewBundleCheck({ rootDir });
        assert.equal(result.ok, false);
        const failure = result.failures.find(
          (f) => f.reason === 'missing-assets-dir' || f.reason === 'no-assets',
        );
        assert.ok(
          failure,
          `expected missing-assets-dir or no-assets; got ${JSON.stringify(result.failures)}`,
        );
        assert.match(String(failure.path ?? failure.message ?? ''), /assets/);
      },
    );
  });
});
