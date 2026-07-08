#!/usr/bin/env node
/**
 * Vendor the self-contained codex-acp ACP adapter bundle into
 * `resources/codex-acp/index.mjs`.
 *
 * codex-acp ships `dist/index.js` as a single self-contained esbuild bundle
 * (type: module). We spawn it under Node with CODEX_PATH pointing at the user's
 * installed `codex`, so we only need this one ~1MB file — never the heavy
 * bundled `@openai/codex` platform binary.
 *
 * This uses `npm pack` (downloads only the codex-acp tarball, not its deps) so
 * regeneration never pulls the 242MB codex binary.
 *
 *   node scripts/vendor-codex-acp.mjs [version]   # default: pinned VENDORED_VERSION
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const pkg = '@agentclientprotocol/codex-acp';
/** Pinned version currently vendored into resources/codex-acp/index.mjs. */
const VENDORED_VERSION = '1.1.0';
const version = process.argv[2] || VENDORED_VERSION;
const spec = `${pkg}@${version}`;

const work = mkdtempSync(path.join(tmpdir(), 'codex-acp-vendor-'));
try {
  console.log(`Packing ${spec} ...`);
  execFileSync('npm', ['pack', spec], { cwd: work, stdio: ['ignore', 'inherit', 'inherit'] });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['-xzf', tgz], { cwd: work, stdio: 'inherit' });

  const src = path.join(work, 'package', 'dist', 'index.js');
  if (!existsSync(src)) throw new Error(`bundle not found at ${src}`);

  const destDir = path.join(repoRoot, 'resources', 'codex-acp');
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'index.mjs');
  copyFileSync(src, dest);
  console.log(`Vendored ${spec} -> ${path.relative(repoRoot, dest)}`);

  // Apache-2.0 requires retaining the license (and NOTICE, if any) when
  // redistributing the bundle inside the .vsix.
  for (const name of ['LICENSE', 'NOTICE']) {
    const from = path.join(work, 'package', name);
    if (existsSync(from)) {
      copyFileSync(from, path.join(destDir, name));
      console.log(`  + ${name}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
