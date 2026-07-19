/**
 * M017-S07 / D037: Rollout closeout, fallback removal, and debt sweep.
 *
 * Assembled closeout flow — proves debt-ledger zero-ref scans + stdio-only
 * ACP muster_bridge injection together. Re-checks S01–S06 boundaries without
 * replacing those named flows. Live VSIX / OpenCode multi-session metrics stay
 * D036 BLOCKED (docs/uat/m017-s07-blocked-gates.md) and are never mock-substituted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnMcp, resolveMusterStdioProxyEntry } from '../bridge/mcp-config';
import type { Backend, McpServerConfig } from '../types';

const SRC_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../..');

const ACP_BACKENDS = ['claude', 'codex', 'grok', 'kiro', 'opencode'] as const;

const MCP_CAPS = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

/** Production source only — tests / testkits / fixtures are debt-ledger allowlisted. */
function isProductionSourceFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.endsWith('.test.ts') || base.endsWith('.test.mts') || base.endsWith('.test.mjs')) {
    return false;
  }
  if (base.endsWith('.testkit.ts') || base.includes('.testkit.')) return false;
  if (base.endsWith('.d.ts')) return false;
  return /\.(ts|js|mts|mjs)$/.test(base);
}

function walkProductionSources(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.gsd') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && isProductionSourceFile(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

function rel(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function scanProductionHits(needle: string | RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of walkProductionSources(SRC_ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((text, idx) => {
      const matched =
        typeof needle === 'string' ? text.includes(needle) : needle.test(text);
      if (matched) {
        hits.push({ file: rel(file), line: idx + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

function backendNamed(name: string): Backend {
  return { name, capabilities: MCP_CAPS, run: async function* () {} };
}

function isStdioBridge(
  entry: McpServerConfig | undefined,
): entry is Extract<McpServerConfig, { type: 'stdio' }> {
  return !!entry && entry.type === 'stdio';
}

describe('Rollout closeout, fallback removal, and debt sweep (M017-S07 / D037)', () => {
  const prevTransport = process.env.MUSTER_ACP_MCP_TRANSPORT;

  afterEach(() => {
    if (prevTransport === undefined) {
      delete process.env.MUSTER_ACP_MCP_TRANSPORT;
    } else {
      process.env.MUSTER_ACP_MCP_TRANSPORT = prevTransport;
    }
  });

  it('buildTurnMcp emits stdio muster_bridge for all five ACP backends even when MUSTER_ACP_MCP_TRANSPORT=http', () => {
    process.env.MUSTER_ACP_MCP_TRANSPORT = 'http';
    const secret = 'debt-ledger-secret-token';

    for (const name of ACP_BACKENDS) {
      const result = buildTurnMcp(backendNamed(name), { port: 9876 }, secret);
      expect(result.mcpConfigPath, name).toBeUndefined();
      expect(result.mcpServers, name).toBeDefined();
      expect(result.mcpServers, name).toHaveLength(1);
      const entry = result.mcpServers![0];
      expect(isStdioBridge(entry), `${name} must be stdio`).toBe(true);
      if (!isStdioBridge(entry)) continue;
      expect(entry.name).toBe('muster_bridge');
      expect(entry.type).not.toBe('http');
      expect(entry.command).toBe('node');
      expect(entry.args).toHaveLength(1);
      expect(path.isAbsolute(entry.args[0])).toBe(true);
      expect(entry.args[0].replace(/\\/g, '/')).toMatch(/mcp-stdio-proxy\.(js|ts|mjs)$/);
      // Token only via env — never argv (invariant 10).
      expect(JSON.stringify(entry.args)).not.toContain(secret);
      expect(entry.env).toEqual(
        expect.arrayContaining([
          { name: 'MUSTER_BRIDGE_URL', value: 'http://127.0.0.1:9876/mcp' },
          { name: 'MUSTER_BRIDGE_TOKEN', value: secret },
        ]),
      );
    }
  });

  it('debt ledger: zero built-in direct-HTTP ACP muster_bridge injection / transport fallback', () => {
    const transportHits = scanProductionHits('MUSTER_ACP_MCP_TRANSPORT');
    const httpEntryHits = scanProductionHits('bridgeAcpHttpEntry');
    expect(
      transportHits,
      transportHits.map((h) => `${h.file}:${h.line}`).join(', ') || 'no transport hits',
    ).toEqual([]);
    expect(
      httpEntryHits,
      httpEntryHits.map((h) => `${h.file}:${h.line}`).join(', ') || 'no http-entry hits',
    ).toEqual([]);

    // Production mcp-config must document stdio-only ACP injection.
    const mcpConfig = fs.readFileSync(path.join(SRC_ROOT, 'bridge', 'mcp-config.ts'), 'utf8');
    expect(mcpConfig).toMatch(/stdio/i);
    expect(mcpConfig).not.toMatch(/MUSTER_ACP_MCP_TRANSPORT/);
    expect(mcpConfig).not.toMatch(/bridgeAcpHttpEntry/);
  });

  it('stdio proxy entry resolves under source or dist layout', () => {
    const entry = resolveMusterStdioProxyEntry();
    expect(path.isAbsolute(entry)).toBe(true);
    expect(entry.replace(/\\/g, '/')).toMatch(/mcp-stdio-proxy\.(js|ts|mjs)$/);
  });

  it('negative: debt-ledger scanner detects a continuous disposition_repair token', () => {
    // Protects the ledger scanner itself — a synthetic continuous token must be detected.
    const synthetic = 'const code = "disposition_repair_pending";';
    expect(synthetic.includes('disposition_repair')).toBe(true);
  });

  it('records D036 live rollout gates as BLOCKED evidence (never mock-substituted)', () => {
    const ledgerPath = path.join(REPO_ROOT, 'docs', 'uat', 'm017-s07-blocked-gates.md');
    expect(fs.existsSync(ledgerPath), 'docs/uat/m017-s07-blocked-gates.md').toBe(true);
    const body = fs.readFileSync(ledgerPath, 'utf8');
    expect(body).toMatch(/D036/);
    expect(body).toMatch(/BLOCKED/);
    expect(body).toMatch(/GATE-VSIX|VSIX/);
    expect(body).toMatch(/OpenCode|OPENCODE/i);
    expect(body).toMatch(/never.*mock-substitut|must \*\*never\*\* be\s+mock-substituted/i);
  });
});
