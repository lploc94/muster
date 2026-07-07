#!/usr/bin/env node
/**
 * Vendor the claude-agent-acp ACP adapter into `resources/claude-acp/index.mjs`
 * as a single self-contained esbuild bundle.
 *
 * Unlike codex-acp (which already ships a self-contained bundle), the
 * `@agentclientprotocol/claude-agent-acp` package is published unbundled
 * (multiple dist files + runtime deps @agentclientprotocol/sdk,
 * @anthropic-ai/claude-agent-sdk, zod). We therefore install it into a temp
 * dir and bundle its bin entry (dist/index.js) into one ESM file with esbuild.
 *
 * We install with `--omit=optional` to skip the ~221MB
 * `@anthropic-ai/claude-agent-sdk-<platform>` binary, and mark those platform
 * packages `external` so esbuild never tries to inline them. At runtime the
 * adapter is pointed at the user's installed `claude` via CLAUDE_CODE_EXECUTABLE
 * (set by src/backends/claude.ts), so the bundled platform binary is never
 * needed.
 *
 *   node scripts/vendor-claude-acp.mjs [version]   # default: pinned VENDORED_VERSION
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const pkg = '@agentclientprotocol/claude-agent-acp';
/** Pinned version currently vendored into resources/claude-acp/index.mjs. */
const VENDORED_VERSION = '0.56.0';
const version = process.argv[2] || VENDORED_VERSION;
const spec = `${pkg}@${version}`;

// esbuild is resolved from the repo's own (pinned) dependency tree for
// deterministic output across regenerations.
const esbuild = await import('esbuild');

const work = mkdtempSync(path.join(tmpdir(), 'claude-acp-vendor-'));
try {
  console.log(`Installing ${spec} (esbuild ${esbuild.version}) ...`);
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'vendor-tmp', private: true }));
  execFileSync('npm', ['install', '--omit=optional', '--no-audit', '--no-fund', spec], {
    cwd: work,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const entry = path.join(work, 'node_modules', pkg, 'dist', 'index.js');
  if (!existsSync(entry)) throw new Error(`adapter entry not found at ${entry}`);

  const destDir = path.join(repoRoot, 'resources', 'claude-acp');
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'index.mjs');

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: dest,
    absWorkingDir: work,
    // Platform-specific claude binaries are resolved at runtime only when
    // CLAUDE_CODE_EXECUTABLE is unset (never, in our case) — keep them external.
    external: ['@anthropic-ai/claude-agent-sdk-*'],
    // ESM output needs a require() shim for the adapter's CJS interop.
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });

  console.log(`Vendored ${spec} -> ${path.relative(repoRoot, dest)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
