import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildTurnMcp, deleteMcpConfigFile } from './mcp-config';
import type { Backend } from '../types';

const MCP_CAPS = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsLiveInput: false,
};

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