/**
 * M017-S05 / D037 — ACP stdio proxy and provider contract matrix.
 *
 * Named, independently executable flow for this slice's runtime boundary.
 * Drives each ACP backend's emitted buildTurnMcp wire shape through the real
 * Muster stdio proxy module against FakeMcpBridge:
 *   - initialize / tools/list succeed
 *   - mid-run bridge restart → one coalesced reconnect + retry
 *   - secret scan of proxy argv / diagnostics finds no token
 *
 * Live VSIX/Remote packaging smoke remains BLOCKED per D036 and is never
 * substituted by mocks (documented in slice UAT notes).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import { buildTurnMcp, MUSTER_BRIDGE_TOKEN_ENV, MUSTER_BRIDGE_URL_ENV } from './mcp-config';
import {
  MusterStdioMcpProxy,
  createBridgePostFromFake,
  type ProxyDebugSnapshot,
} from './mcp-stdio-proxy';
import { createFakeMcpBridge } from './mcp-fault-fixture.testkit';
import type { Backend, McpServerConfig } from '../types';

const ACP_BACKENDS = ['claude', 'codex', 'grok', 'kiro', 'opencode'] as const;
type AcpBackendName = (typeof ACP_BACKENDS)[number];

const MCP_CAPS = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

/** Distinct secret used only for leak scans in this contract suite. */
const SECRET_TOKEN = 'contract-secret-token-NEVER-LEAK';

function backendNamed(name: AcpBackendName): Backend {
  return { name, capabilities: MCP_CAPS, run: async function* () {} };
}

function isStdioBridge(
  entry: McpServerConfig | undefined,
): entry is Extract<McpServerConfig, { type: 'stdio' }> {
  return !!entry && entry.type === 'stdio';
}

function envMap(
  env: Array<{ name: string; value: string }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of env ?? []) out[e.name] = e.value;
  return out;
}

function snapshotJson(snap: ProxyDebugSnapshot): string {
  return JSON.stringify(snap);
}

function assertNoSecret(haystack: string, label: string): void {
  expect(haystack, label).not.toContain(SECRET_TOKEN);
  expect(haystack.toLowerCase(), label).not.toContain(`bearer ${SECRET_TOKEN}`.toLowerCase());
}

function emitStdioWire(name: AcpBackendName): Extract<McpServerConfig, { type: 'stdio' }> {
  const result = buildTurnMcp(backendNamed(name), { port: 8765 }, SECRET_TOKEN);
  expect(result.mcpServers, name).toHaveLength(1);
  const entry = result.mcpServers![0];
  expect(isStdioBridge(entry), `${name} should emit stdio muster_bridge`).toBe(true);
  if (!isStdioBridge(entry)) {
    throw new Error(`expected stdio muster_bridge for ${name}`);
  }
  return entry;
}

describe('ACP stdio proxy and provider contract matrix (M017-S05 / D037)', () => {
  let proxy: MusterStdioMcpProxy | undefined;

  afterEach(async () => {
    await proxy?.close().catch(() => undefined);
    proxy = undefined;
  });

  it('still emits stdio when MUSTER_ACP_MCP_TRANSPORT=http is set (fallback removed M017-S07)', () => {
    const prev = process.env.MUSTER_ACP_MCP_TRANSPORT;
    process.env.MUSTER_ACP_MCP_TRANSPORT = 'http';
    try {
      for (const name of ACP_BACKENDS) {
        const entry = emitStdioWire(name);
        expect(entry.type).toBe('stdio');
      }
    } finally {
      if (prev === undefined) delete process.env.MUSTER_ACP_MCP_TRANSPORT;
      else process.env.MUSTER_ACP_MCP_TRANSPORT = prev;
    }
  });

  it('emits stdio muster_bridge for all five ACP backends with env-only secrets', () => {
    for (const name of ACP_BACKENDS) {
      const entry = emitStdioWire(name);

      expect(entry.name).toBe('muster_bridge');
      expect(entry.command).toBe('node');
      expect(entry.args).toHaveLength(1);
      expect(path.isAbsolute(entry.args[0])).toBe(true);
      expect(entry.args[0].replace(/\\/g, '/')).toMatch(/mcp-stdio-proxy\.(js|ts|mjs)$/);

      // Invariant 10: token never in argv.
      assertNoSecret(JSON.stringify(entry.args), `${name} argv`);

      const env = envMap(entry.env);
      expect(env[MUSTER_BRIDGE_URL_ENV]).toBe('http://127.0.0.1:8765/mcp');
      expect(env[MUSTER_BRIDGE_TOKEN_ENV]).toBe(SECRET_TOKEN);
    }
  });

  it.each(ACP_BACKENDS)(
    '%s: initialize + tools/list succeed through stdio proxy against FakeMcpBridge',
    async (name) => {
      const entry = emitStdioWire(name);
      const env = envMap(entry.env);
      const bridge = createFakeMcpBridge({
        tools: [
          {
            name: 'complete_task',
            description: 'contract tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
      const logs: string[] = [];

      proxy = new MusterStdioMcpProxy({
        bridgeUrl: env[MUSTER_BRIDGE_URL_ENV]!,
        token: env[MUSTER_BRIDGE_TOKEN_ENV]!,
        bridgePost: createBridgePostFromFake(bridge),
        log: (line) => logs.push(line),
        sleep: async () => {},
      });

      await proxy.ensureUpstream();
      const listed = await proxy.listTools();
      expect(listed.tools.map((t) => t.name)).toContain('complete_task');

      const snap = proxy.getDebugSnapshot();
      expect(snap.phase).toBe('ready');
      expect(snap.hasSession).toBe(true);
      assertNoSecret(snapshotJson(snap), `${name} snapshot`);
      assertNoSecret(logs.join('\n'), `${name} logs`);
      assertNoSecret(JSON.stringify(entry.args), `${name} argv`);
    },
  );

  it.each(ACP_BACKENDS)(
    '%s: mid-run bridge restart triggers one coalesced reconnect + retry (no token leak)',
    async (name) => {
      const entry = emitStdioWire(name);
      const env = envMap(entry.env);
      const bridge = createFakeMcpBridge({
        tools: [
          {
            name: 'complete_task',
            description: 'contract tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      let now = 1_000;
      const basePost = createBridgePostFromFake(bridge);
      let listCalls = 0;
      let upstreamInits = 0;
      const logs: string[] = [];

      proxy = new MusterStdioMcpProxy({
        bridgeUrl: env[MUSTER_BRIDGE_URL_ENV]!,
        token: env[MUSTER_BRIDGE_TOKEN_ENV]!,
        maxReconnectAttempts: 4,
        reconnectDeadlineMs: 10_000,
        reconnectBaseDelayMs: 1,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        log: (line) => logs.push(line),
        bridgePost: async (req) => {
          if (req.method === 'initialize') {
            upstreamInits += 1;
          }
          if (req.method === 'tools/list') {
            listCalls += 1;
            // First tools/list (after ready) fails once to force mid-run reconnect.
            if (listCalls === 1) {
              const err = new Error('fetch failed: read ECONNRESET') as Error & { code?: string };
              err.code = 'ECONNRESET';
              throw err;
            }
          }
          return basePost(req);
        },
      });

      await proxy.ensureUpstream();
      const initsAfterReady = upstreamInits;
      expect(proxy.getDebugSnapshot().phase).toBe('ready');
      expect(proxy.getDebugSnapshot().reconnectGeneration).toBe(0);

      const listed = await proxy.listTools();
      expect(listed.tools.map((t) => t.name)).toContain('complete_task');

      const snap = proxy.getDebugSnapshot();
      expect(snap.phase).toBe('ready');
      expect(snap.reconnectGeneration).toBe(1);
      expect(snap.reconnectAttemptCount).toBeGreaterThanOrEqual(1);
      // Exactly one re-initialize for the single coalesced reconnect series.
      expect(upstreamInits - initsAfterReady).toBe(1);
      expect(listCalls).toBeGreaterThanOrEqual(2);

      assertNoSecret(snapshotJson(snap), `${name} snapshot`);
      assertNoSecret(logs.join('\n'), `${name} logs`);
      assertNoSecret(JSON.stringify(entry.args), `${name} argv`);
    },
  );

  it('documents D036: live VSIX/Remote packaging smoke is BLOCKED (not mock-substituted)', () => {
    // Contract proof is in-process + FakeMcpBridge only. Packaging smoke against
    // a real VSIX / Remote host remains blocked per D036 and must not be claimed
    // by this suite.
    const packagingSmokeStatus = 'BLOCKED_D036_VSIX_REMOTE_PACKAGING_SMOKE' as const;
    expect(packagingSmokeStatus).toMatch(/^BLOCKED/);
  });
});
