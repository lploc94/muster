import { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { AcpAgentConfig, disposeSharedAcpClient } from './acp-client';
import { ACP_CAPABILITIES, AcpAdapterSpec, runAcpTurn } from './acp-run';

export { disposeSharedAcpClient };

const FAILURE_STOP_REASONS = new Set(['refusal', 'error', 'max_tokens']);

/** Shared ACP agent configuration for the Grok CLI (`grok agent stdio`). */
export const GROK_AGENT_CONFIG: AcpAgentConfig = {
  key: 'grok',
  label: 'Grok',
  command: 'grok',
  args: ['--no-auto-update', 'agent', 'stdio'],
  resolveAuth: (init, env) => {
    const authMethods = new Set((init.authMethods ?? []).map((m) => m.id));
    const methodId =
      env.XAI_API_KEY && authMethods.has('xai.api_key')
        ? 'xai.api_key'
        : authMethods.has('cached_token')
          ? 'cached_token'
          : null;
    if (!methodId) {
      throw new Error('Run `grok login` first, or set XAI_API_KEY.');
    }
    return { methodId, meta: { headless: true } };
  },
  extensionRequestHandler: (method) => {
    if (method === 'x.ai/ask_user_question' || method === '_x.ai/ask_user_question') {
      return { result: { outcome: 'cancelled' } };
    }
    if (method === 'x.ai/exit_plan_mode' || method === '_x.ai/exit_plan_mode') {
      return { result: { outcome: 'approved' } };
    }
    return undefined;
  },
};

/**
 * Grok's adapter spec. Grok surfaces empty agent chunks as raw, has no
 * `usage_update` case, reads post-turn usage from `result._meta` (no
 * `thoughtTokens`), classifies tool kind from `_meta['x.ai/tool']`, and its
 * FAILURE set omits `max_turn_requests` (a known drift vs the other adapters).
 */
const GROK_SPEC: AcpAdapterSpec = {
  name: 'grok',
  label: 'Grok',
  idPrefix: 'grok:',
  makeConfig: () => GROK_AGENT_CONFIG,
  failureStopReasons: FAILURE_STOP_REASONS,
  emptyChunk: 'raw',
  mapUsageUpdate: false,
  usage: {
    source: 'meta',
    keys: ['totalTokens', 'inputTokens', 'outputTokens', 'cachedReadTokens', 'reasoningTokens', 'modelId'],
  },
  toolKind: (update) => {
    const meta = update._meta as Record<string, unknown> | undefined;
    const toolMeta = meta?.['x.ai/tool'] as { kind?: string } | undefined;
    return toolMeta?.kind === 'mcp' ? 'mcp' : 'builtin';
  },
  errorPassthrough: ['Run `grok login`', 'Failed to start', 'Grok agent exited', 'not running'],
};

export class GrokBackend implements Backend {
  readonly name = 'grok';
  readonly capabilities: BackendCapabilities = ACP_CAPABILITIES;

  run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    return runAcpTurn(GROK_SPEC, options);
  }
}
