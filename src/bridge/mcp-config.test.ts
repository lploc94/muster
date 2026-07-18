import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnMcp, deleteMcpConfigFile } from './mcp-config';
import type { Backend, McpServerConfig } from '../types';

const MCP_CAPS = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

const ACP_BACKENDS = ['claude', 'codex', 'grok', 'kiro', 'opencode'] as const;

function backendNamed(name: string): Backend {
  return { name, capabilities: MCP_CAPS, run: async function* () {} };
}

function isStdioBridge(entry: McpServerConfig | undefined): entry is Extract<McpServerConfig, { type: 'stdio' }> {
  return !!entry && entry.type === 'stdio';
}

describe('buildTurnMcp', () => {
  const prevTransport = process.env.MUSTER_ACP_MCP_TRANSPORT;

  afterEach(() => {
    if (prevTransport === undefined) {
      delete process.env.MUSTER_ACP_MCP_TRANSPORT;
    } else {
      process.env.MUSTER_ACP_MCP_TRANSPORT = prevTransport;
    }
  });

  function expectStdioMusterBridge(
    entry: McpServerConfig | undefined,
    label: string,
  ): asserts entry is Extract<McpServerConfig, { type: 'stdio' }> {
    expect(isStdioBridge(entry), label).toBe(true);
    if (!isStdioBridge(entry)) return;
    expect(entry.name).toBe('muster_bridge');
    expect(entry.command).toBe('node');
    expect(entry.args).toHaveLength(1);
    expect(path.isAbsolute(entry.args[0])).toBe(true);
    expect(entry.args[0].replace(/\\/g, '/')).toMatch(/mcp-stdio-proxy\.(js|ts|mjs)$/);
    // Token must travel only via env (invariant 10) — never argv.
    expect(JSON.stringify(entry.args)).not.toContain('tok-abc');
    expect(entry.env).toEqual([
      { name: 'MUSTER_BRIDGE_URL', value: 'http://127.0.0.1:4321/mcp' },
      { name: 'MUSTER_BRIDGE_TOKEN', value: 'tok-abc' },
    ]);
  }

  it('emits stdio muster_bridge for all five ACP backends', () => {
    delete process.env.MUSTER_ACP_MCP_TRANSPORT;

    for (const name of ACP_BACKENDS) {
      const result = buildTurnMcp(backendNamed(name), { port: 4321 }, 'tok-abc');
      expect(result.mcpServers, name).toHaveLength(1);
      expectStdioMusterBridge(result.mcpServers![0], name);
    }
  });

  it('ignores MUSTER_ACP_MCP_TRANSPORT=http — stdio is the only ACP injection path (M017-S07)', () => {
    process.env.MUSTER_ACP_MCP_TRANSPORT = 'http';
    for (const name of ACP_BACKENDS) {
      const result = buildTurnMcp(backendNamed(name), { port: 4321 }, 'tok-abc');
      expect(result.mcpServers, name).toHaveLength(1);
      const entry = result.mcpServers![0];
      expectStdioMusterBridge(entry, name);
      // No built-in direct-HTTP ACP muster_bridge injection remains.
      expect(entry.type).not.toBe('http');
    }
  });

  it('prepends optional contextEngine and still emits muster_bridge as stdio', () => {
    delete process.env.MUSTER_ACP_MCP_TRANSPORT;
    const contextEngine: McpServerConfig = {
      type: 'http',
      name: 'context_engine',
      url: 'http://127.0.0.1:9/mcp',
    };
    const result = buildTurnMcp(backendNamed('claude'), { port: 4321 }, 'tok-abc', contextEngine);
    expect(result.mcpServers).toHaveLength(2);
    expect(result.mcpServers![0]).toEqual(contextEngine);
    expect(result.mcpServers![1].type).toBe('stdio');
    expect(result.mcpServers![1].name).toBe('muster_bridge');
  });

  it('emits headless mcpConfigPath with headers object', () => {
    // Any backend NOT in the ACP set uses the headless --mcp-config file path.
    const backend: Backend = { name: 'legacy-headless', capabilities: MCP_CAPS, run: async function* () {} };
    const result = buildTurnMcp(backend, { port: 4321 }, 'tok-abc');
    expect(result.mcpConfigPath).toBeDefined();
    const parsed = JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8'));
    expect(parsed.mcpServers.muster_bridge).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4321/mcp',
      headers: { Authorization: 'Bearer tok-abc' },
    });
    deleteMcpConfigFile(result.mcpConfigPath);
  });

  it('writes the headless config to an unpredictable, private, 0600 path and cleans it up', () => {
    const backend: Backend = { name: 'legacy-headless', capabilities: MCP_CAPS, run: async function* () {} };
    const result = buildTurnMcp(backend, { port: 4321 }, 'tok-secret');
    const filePath = result.mcpConfigPath!;
    expect(filePath).toBeDefined();

    // The path is not the old guessable `muster-mcp-<pid>-<ts>.json` form: it
    // lives in a per-turn mkdtemp directory and carries a random-hex filename.
    const dir = path.dirname(filePath);
    expect(path.basename(dir).startsWith('muster-mcp-')).toBe(true);
    expect(path.basename(filePath)).toMatch(/^[0-9a-f]{32}\.json$/);

    // POSIX exposes owner-only mode bits. Windows does not preserve chmod-style
    // permissions in stat(), so its security contract is covered by the
    // unpredictable path and exclusive-creation assertions below.
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }

    // Exclusive creation: re-opening the exact path with O_EXCL must fail
    // (EEXIST), proving a pre-existing path/symlink can't be silently
    // followed or overwritten by the token write.
    const exclFlags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0);
    expect(() => fs.openSync(filePath, exclFlags, 0o600)).toThrow();

    // Cleanup removes both the token file and its private directory.
    deleteMcpConfigFile(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
