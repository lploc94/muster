import { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { AcpAgentConfig, SessionUpdate, disposeSharedAcpClient } from './acp-client';
import { ACP_CAPABILITIES, AcpAdapterSpec, runAcpTurn } from './acp-run';

export { disposeSharedAcpClient };

/** stopReasons that represent a failed (non-cancellation) turn. */
const FAILURE_STOP_REASONS = new Set(['refusal', 'error', 'max_tokens', 'max_turn_requests']);

/**
 * Shared ACP agent configuration for the Kiro CLI (`kiro-cli acp`).
 *
 * Kiro authenticates transparently using cached login credentials
 * (`kiro-cli login`) or `KIRO_API_KEY`, so it typically advertises no ACP
 * `authMethods` and no explicit `authenticate` step is required. If a future
 * Kiro build does advertise auth methods, we pick a sensible one.
 */
export const KIRO_AGENT_CONFIG: AcpAgentConfig = {
  key: 'kiro',
  label: 'Kiro',
  command: 'kiro-cli',
  args: ['acp'],
  resolveAuth: (init, env) => {
    const methods = init.authMethods ?? [];
    if (methods.length === 0) {
      // No auth handshake needed — Kiro uses cached credentials / KIRO_API_KEY.
      return null;
    }
    const ids = methods.map((m) => m.id);
    const apiKeyMethod = ids.find((id) => /api[_-]?key/i.test(id));
    if (env.KIRO_API_KEY && apiKeyMethod) {
      return { methodId: apiKeyMethod, meta: { headless: true } };
    }
    const cachedMethod = ids.find((id) => /cached|token|login|sso|builder/i.test(id));
    return { methodId: cachedMethod ?? ids[0], meta: { headless: true } };
  },
};

/** Best-effort MCP-vs-builtin classification for a Kiro tool call. */
function isMcpTool(update: SessionUpdate): boolean {
  const meta = update._meta as Record<string, unknown> | undefined;
  const metaKind = (meta?.['kiro.dev/tool'] as { kind?: string } | undefined)?.kind;
  if (metaKind === 'mcp') return true;
  // ACP tool `kind` is a category (read/edit/execute/...), not the provider.
  // Kiro MCP tools are conventionally named "<server>___<tool>".
  const rawName = typeof update.toolName === 'string' ? update.toolName : undefined;
  return typeof rawName === 'string' && rawName.includes('___');
}

const KIRO_SPEC: AcpAdapterSpec = {
  name: 'kiro',
  label: 'Kiro',
  idPrefix: 'kiro:',
  makeConfig: () => KIRO_AGENT_CONFIG,
  failureStopReasons: FAILURE_STOP_REASONS,
  emptyChunk: 'raw',
  mapUsageUpdate: false,
  usage: {
    source: 'meta',
    keys: ['totalTokens', 'inputTokens', 'outputTokens', 'cachedReadTokens', 'reasoningTokens', 'modelId'],
  },
  toolKind: (update) => (isMcpTool(update) ? 'mcp' : 'builtin'),
  errorPassthrough: ['Run `kiro-cli login`', 'Failed to start', 'Kiro agent exited', 'not running'],
};

export class KiroBackend implements Backend {
  readonly name = 'kiro';
  readonly capabilities: BackendCapabilities = ACP_CAPABILITIES;

  run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    return runAcpTurn(KIRO_SPEC, options);
  }
}
