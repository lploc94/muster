/**
 * M022/S04 T01 — fail-closed webview bundle check.
 *
 * D067 pruned the 10 webview-only packages out of production dependencies on
 * the claim that vite already bundles them into dist/webview with zero
 * unresolved bare specifiers. This module asserts that claim.
 *
 * Pure at import time: callers pass `{ rootDir }` (default process.cwd()).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Same 10 packages as scripts/packaging-dependency-shape.test.mjs.
 * Sorted for stable diagnostics.
 */
export const WEBVIEW_ONLY_PACKAGES = Object.freeze([
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
]);

/**
 * @typedef {'missing-webview-dir' | 'missing-assets-dir' | 'no-assets' | 'unresolved-bare-specifier'} WebviewBundleFailureReason
 *
 * @typedef {object} WebviewBundleFailure
 * @property {WebviewBundleFailureReason} reason
 * @property {string} [path]
 * @property {string} [package]
 * @property {string} [asset]
 * @property {string} [specifier]
 * @property {string} message
 *
 * @typedef {object} WebviewBundleCheckResult
 * @property {boolean} ok
 * @property {number} assetCount
 * @property {WebviewBundleFailure[]} failures
 */

/**
 * Match a bare package name (exact or subpath) against WEBVIEW_ONLY_PACKAGES.
 * @param {string} specifier
 * @returns {string | null}
 */
export function matchWebviewOnlyPackage(specifier) {
  if (!specifier || typeof specifier !== 'string') return null;
  // Relative, absolute, protocol, and data URLs are not bare package names.
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.includes(':')
  ) {
    return null;
  }
  for (const pkg of WEBVIEW_ONLY_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
      return pkg;
    }
  }
  return null;
}

/**
 * Extract static/dynamic module specifiers from a JS source string.
 * Covers import/export-from and dynamic import()/require().
 * @param {string} source
 * @returns {string[]}
 */
export function extractModuleSpecifiers(source) {
  if (!source) return [];
  const found = [];
  // import ... from 'x' / export ... from 'x' / export * from 'x'
  const fromRe = /\b(?:import|export)\s+(?:[^'"\n;]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  // bare side-effect import 'x'
  const sideEffectRe = /\bimport\s+['"]([^'"]+)['"]/g;
  // import('x') / require('x')
  const callRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const re of [fromRe, sideEffectRe, callRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      found.push(m[1]);
    }
  }
  return found;
}

/**
 * @param {{ rootDir?: string }} [options]
 * @returns {Promise<WebviewBundleCheckResult>}
 */
export async function runWebviewBundleCheck(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  /** @type {WebviewBundleFailure[]} */
  const failures = [];
  const webviewDir = path.join(rootDir, 'dist', 'webview');
  const assetsDir = path.join(webviewDir, 'assets');

  let webviewStat;
  try {
    webviewStat = await stat(webviewDir);
  } catch {
    webviewStat = null;
  }

  if (!webviewStat || !webviewStat.isDirectory()) {
    failures.push({
      reason: 'missing-webview-dir',
      path: webviewDir,
      message: `missing webview bundle directory: ${webviewDir}`,
    });
    return { ok: false, assetCount: 0, failures };
  }

  let assetsStat;
  try {
    assetsStat = await stat(assetsDir);
  } catch {
    assetsStat = null;
  }

  if (!assetsStat || !assetsStat.isDirectory()) {
    failures.push({
      reason: 'missing-assets-dir',
      path: assetsDir,
      message: `missing webview assets directory: ${assetsDir}`,
    });
    return { ok: false, assetCount: 0, failures };
  }

  const entries = await readdir(assetsDir);
  const jsAssets = entries.filter((name) => name.endsWith('.js'));
  if (jsAssets.length === 0) {
    failures.push({
      reason: 'no-assets',
      path: assetsDir,
      message: `no JavaScript assets under ${assetsDir}`,
    });
    return { ok: false, assetCount: 0, failures };
  }

  for (const asset of jsAssets) {
    const assetPath = path.join(assetsDir, asset);
    let source;
    try {
      source = await readFile(assetPath, 'utf8');
    } catch (err) {
      failures.push({
        reason: 'unresolved-bare-specifier',
        path: assetPath,
        asset,
        message: `failed to read webview asset ${asset}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const seen = new Set();
    for (const specifier of extractModuleSpecifiers(source)) {
      const pkg = matchWebviewOnlyPackage(specifier);
      if (!pkg) continue;
      const key = `${pkg}::${asset}::${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({
        reason: 'unresolved-bare-specifier',
        package: pkg,
        asset,
        specifier,
        path: assetPath,
        message: `unresolved bare specifier for webview-only package "${pkg}" in asset "${asset}" (specifier: "${specifier}")`,
      });
    }
  }

  return {
    ok: failures.length === 0,
    assetCount: jsAssets.length,
    failures,
  };
}
