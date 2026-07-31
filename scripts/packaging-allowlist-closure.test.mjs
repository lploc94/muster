/**
 * M022/S02 T02 — packaging allowlist is enforcing (sdk-closure-only) and
 * the literal allowedNodeModulesPrefixes array matches the real production
 * dependency closure walked from package-lock.json.
 *
 * A webview package creeping back into `dependencies` will either:
 *   1) expand the walked closure so this drift test fails, or
 *   2) stage an unallowed package so evaluateAllowlist reports a violation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PACKAGING_ALLOWLIST,
  REQUIRED_ARCHIVE_ENTRYPOINTS,
} from './packaging-allowlist.mjs';
import {
  buildArchiveCensus,
  evaluateAllowlist,
} from './packaging-archive-census.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Walk the production dependency closure from package-lock.json root
 * `packages[''].dependencies` through each package's own `dependencies`.
 * Mirrors what `vsce package` stages when `--no-dependencies` is not set.
 *
 * @param {string} lockPath
 * @returns {string[]}
 */
export function walkProductionClosureFromLockfile(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const packages = lock.packages ?? {};
  const rootDeps = packages['']?.dependencies ?? {};
  const queue = Object.keys(rootDeps);
  const seen = new Set();

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    for (const key of Object.keys(packages)) {
      if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) {
        const deps = packages[key]?.dependencies ?? {};
        for (const dep of Object.keys(deps)) {
          if (!seen.has(dep)) {
            queue.push(dep);
          }
        }
      }
    }
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
}

describe('M022/S02 T02 packaging allowlist closure', () => {
  it('is enforcing at mode sdk-closure-only', () => {
    assert.equal(
      PACKAGING_ALLOWLIST.mode,
      'sdk-closure-only',
      "PACKAGING_ALLOWLIST.mode must be 'sdk-closure-only' after S02 prune",
    );
  });

  it('keeps @modelcontextprotocol/sdk as the sole sdkClosureRootPackage', () => {
    assert.deepEqual(PACKAGING_ALLOWLIST.sdkClosureRootPackages, [
      '@modelcontextprotocol/sdk',
    ]);
  });

  it('pins allowedNodeModulesPrefixes to the lockfile production closure (incl. express)', () => {
    const walked = walkProductionClosureFromLockfile(
      path.join(REPO_ROOT, 'package-lock.json'),
    );
    assert.ok(
      walked.includes('@modelcontextprotocol/sdk'),
      'production closure must include @modelcontextprotocol/sdk',
    );
    assert.ok(
      walked.includes('express'),
      'production closure must include express (D067 dynamic bridge resolve)',
    );

    const pinned = [...PACKAGING_ALLOWLIST.allowedNodeModulesPrefixes].sort((a, b) =>
      a.localeCompare(b),
    );
    assert.deepEqual(
      pinned,
      walked,
      [
        'allowedNodeModulesPrefixes drifted from the lockfile production closure.',
        `pinned=${pinned.length} walked=${walked.length}`,
        `onlyInPinned=${pinned.filter((p) => !walked.includes(p)).join(',') || '(none)'}`,
        `onlyInWalked=${walked.filter((p) => !pinned.includes(p)).join(',') || '(none)'}`,
      ].join(' '),
    );
    assert.equal(pinned.length, walked.length);
    assert.ok(
      pinned.length >= 50,
      `expected a non-trivial SDK production closure; got ${pinned.length}`,
    );
  });

  it('evaluateAllowlist flags a staged package outside the allowlist', () => {
    const census = buildArchiveCensus([
      'extension/node_modules/@modelcontextprotocol/sdk/package.json',
      'extension/node_modules/express/index.js',
      'extension/node_modules/mermaid/package.json',
    ]);
    const result = evaluateAllowlist(census, PACKAGING_ALLOWLIST);
    assert.equal(result.mode, 'sdk-closure-only');
    assert.equal(result.ok, false);
    assert.ok(
      result.violations.includes('mermaid'),
      `expected mermaid violation; got ${JSON.stringify(result.violations)}`,
    );
    assert.equal(result.violations.includes('@modelcontextprotocol/sdk'), false);
    assert.equal(result.violations.includes('express'), false);
  });

  it('evaluateAllowlist passes when only SDK-closure packages are staged', () => {
    const census = buildArchiveCensus([
      'extension/package.json',
      'extension/dist/src/extension.js',
      'extension/node_modules/@modelcontextprotocol/sdk/package.json',
      'extension/node_modules/express/index.js',
      'extension/node_modules/zod/package.json',
      'extension/node_modules/body-parser/package.json',
    ]);
    const result = evaluateAllowlist(census, PACKAGING_ALLOWLIST);
    assert.equal(result.mode, 'sdk-closure-only');
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  });

  it('still exports the three required archive entrypoints', () => {
    assert.deepEqual(REQUIRED_ARCHIVE_ENTRYPOINTS, [
      'extension/dist/src/extension.js',
      'extension/dist/src/task/sqlite/worker.js',
      'extension/dist/src/bridge/mcp-stdio-proxy.js',
    ]);
  });
});
