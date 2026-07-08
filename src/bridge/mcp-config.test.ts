import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { buildTurnMcp, deleteMcpConfigFile } from './mcp-config';
import type { Backend } from '../types';

const MCP_CAPS = { supportsMCP: true, supportsReasoning: false, supportsDetailedToolEvents: false };

describe('buildTurnMcp', () => {
  it('emits ACP mcpServers array with header objects', () => {
    const backend: Backend = { name: 'grok', capabilities: MCP_CAPS, run: async function* () {} };
    const result = buildTurnMcp(backend, { port: 4321 }, 'tok-abc');
    expect(result.mcpServers).toEqual([
      {
        type: 'http',
        name: 'muster_bridge',
        url: 'http://127.0.0.1:4321/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer tok-abc' }],
      },
    ]);
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
});