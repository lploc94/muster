import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Backend, McpServerConfig, RunOptions } from '../types';

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
  return backend.name === 'grok' || backend.name === 'kiro' || backend.name === 'codex';
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

  const filePath = path.join(
    os.tmpdir(),
    `muster-mcp-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
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
}