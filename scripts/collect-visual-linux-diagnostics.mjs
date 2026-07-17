#!/usr/bin/env node
/**
 * Collect platform/font diagnostics from inside the pinned Playwright image.
 * Invoked by scripts/run-visual-baselines.mjs after compare/update runs.
 *
 * Usage:
 *   node scripts/collect-visual-linux-diagnostics.mjs [outPath]
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function safe(cmd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
  } catch (err) {
    return 'error: ' + (err?.message ?? String(err));
  }
}

function listFontFamilies() {
  const raw = safe('fc-list : family 2>/dev/null | sort -u');
  if (raw.startsWith('error:')) {
    return { error: raw, families: [] };
  }
  const families = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { families, count: families.length };
}

function main(argv = process.argv.slice(2)) {
  const outPath = path.resolve(
    REPO_ROOT,
    argv[0] || 'test-results/visual-linux-diagnostics.container.json',
  );

  const payload = {
    capturedAt: new Date().toISOString(),
    container: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      uname: safe('uname -a'),
      locale: safe('locale'),
      timezone: safe(
        'cat /etc/timezone 2>/dev/null || readlink -f /etc/localtime || date +%Z',
      ),
      playwright: safe('npx playwright --version'),
      chromium: safe(
        'ls /ms-playwright 2>/dev/null | head -20 || ls ~/.cache/ms-playwright 2>/dev/null | head -20',
      ),
      fonts: listFontFamilies(),
    },
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log('Wrote container diagnostics: ' + outPath);
  return 0;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  process.exitCode = main();
}

export { main };
