#!/usr/bin/env node
/**
 * Collect Linux container diagnostics for visual baseline rasterization context.
 * Intended to run inside mcr.microsoft.com/playwright:v*-jammy.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch (e) {
    return String(e.stdout || e.stderr || e.message || e).trim();
  }
}

const outArg = process.argv[2];
const diagnostics = {
  capturedAt: new Date().toISOString(),
  container: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    osType: os.type(),
    osRelease: os.release(),
    uname: sh('uname -a'),
    playwrightVersion: sh('npx playwright --version'),
    chromium: sh('ls /ms-playwright 2>/dev/null || true'),
    locale: process.env.LANG || process.env.LC_ALL || null,
    timezone: sh('date +%Z'),
    fontFamilies: sh('fc-list : family | sort -u | head -80')
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

const text = `${JSON.stringify(diagnostics, null, 2)}\n`;
if (outArg) {
  const outPath = path.resolve(outArg);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, 'utf8');
  console.log(`Wrote ${outPath}`);
} else {
  process.stdout.write(text);
}
