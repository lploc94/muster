import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Backend, McpServerConfig, RunOptions } from '../types';

// Prefix used for the per-turn private temp directory. Kept as a stable marker
// so cleanup can safely recognise directories this module created.
const TMP_DIR_PREFIX = 'muster-mcp-';

export interface BridgeEndpoint {
  port: number;
}

export interface TurnMcpResult {
  mcpServers?: McpServerConfig[];
  mcpConfigPath?: string;
}

function bridgeUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function bridgeAcpEntry(port: number, token: string): McpServerConfig {
  return {
    type: 'http',
    name: 'muster_bridge',
    url: bridgeUrl(port),
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  };
}

function isAcpBackend(backend: Backend): boolean {
  return (
    backend.name === 'grok' ||
    backend.name === 'kiro' ||
    backend.name === 'codex' ||
    backend.name === 'claude' ||
    backend.name === 'opencode'
  );
}

export function buildTurnMcp(
  backend: Backend,
  bridge: BridgeEndpoint,
  credentialToken: string,
  contextEngine?: McpServerConfig,
): TurnMcpResult {
  const bridgeEntry = bridgeAcpEntry(bridge.port, credentialToken);
  const servers: McpServerConfig[] = contextEngine ? [contextEngine, bridgeEntry] : [bridgeEntry];

  if (isAcpBackend(backend)) {
    return { mcpServers: servers };
  }

  const config = {
    mcpServers: {
      muster_bridge: {
        type: 'http',
        url: bridgeUrl(bridge.port),
        headers: { Authorization: `Bearer ${credentialToken}` },
      },
      ...(contextEngine
        ? {
            context_engine: {
              type: contextEngine.type,
              url: contextEngine.url,
              headers: Object.fromEntries(
                (contextEngine.headers ?? []).map((h) => [h.name, h.value]),
              ),
            },
          }
        : {}),
    },
  };

  // Non-ACP backends consume this config via `--mcp-config <path>`. The file
  // embeds a scoped, per-turn bearer token, so a predictable path on a shared
  // host would let a local attacker pre-create it (a symlink to redirect the
  // write, or a self-owned file to retain read access) and harvest the token
  // within its TTL. Two layers of defence:
  //   1. mkdtempSync creates a uniquely-named directory with 0o700 perms — an
  //      unpredictable path inside a private, owner-only directory.
  //   2. The token file itself is opened with O_CREAT|O_EXCL|O_NOFOLLOW and
  //      mode 0o600 (via a random-hex name), so any pre-existing path or symlink
  //      makes the open fail instead of being followed/overwritten.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_DIR_PREFIX));
  const filePath = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.json`);
  // O_NOFOLLOW may be absent on some platforms (e.g. Windows); fall back to 0
  // there — O_EXCL alone still defeats the pre-create attack.
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  return { mcpConfigPath: filePath };
}

export function mergeRunOptions(base: RunOptions, turnMcp: TurnMcpResult): RunOptions {
  return {
    ...base,
    ...(turnMcp.mcpServers ? { mcpServers: turnMcp.mcpServers } : {}),
    ...(turnMcp.mcpConfigPath ? { mcpConfigPath: turnMcp.mcpConfigPath } : {}),
  };
}

export function deleteMcpConfigFile(mcpConfigPath: string | undefined): void {
  if (!mcpConfigPath) {
    return;
  }
  try {
    fs.unlinkSync(mcpConfigPath);
  } catch {
    // best-effort
  }
  // The token file lives in a dedicated per-turn mkdtemp directory; remove the
  // whole directory so we never leak temp dirs. Guard on the known prefix so an
  // unexpected path can never trigger a recursive delete elsewhere.
  const dir = path.dirname(mcpConfigPath);
  if (path.basename(dir).startsWith(TMP_DIR_PREFIX)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}