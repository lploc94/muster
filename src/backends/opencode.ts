import { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { AcpAgentConfig, disposeSharedAcpClient } from './acp-client';
import { ACP_CAPABILITIES, AcpAdapterSpec, runAcpTurn } from './acp-run';

export { disposeSharedAcpClient };

/** stopReasons that represent a failed (non-cancellation) turn. */
const FAILURE_STOP_REASONS = new Set(['refusal', 'error', 'max_tokens', 'max_turn_requests']);

/**
 * Shared ACP agent configuration for the OpenCode CLI (`opencode acp`).
 *
 * OpenCode is ACP-native — no adapter or bundle is required; we spawn the
 * user's installed `opencode` directly. It authenticates transparently using
 * cached credentials (`opencode auth login`, stored in auth.json) or
 * `OPENCODE_API_KEY` (already inherited via the process env). Although it
 * advertises an `opencode-login` auth method on `initialize`, that method
 * triggers an interactive login flow and is NOT needed when credentials are
 * cached (verified against opencode 1.15.12), so we skip the `authenticate`
 * step entirely.
 */
export const OPENCODE_AGENT_CONFIG: AcpAgentConfig = {
  key: 'opencode',
  label: 'OpenCode',
  command: 'opencode',
  args: ['acp'],
  resolveAuth: () => {
    // Rely on OpenCode's own cached login / OPENCODE_API_KEY. The advertised
    // `opencode-login` method is interactive and unnecessary here.
    return null;
  },
};

const OPENCODE_SPEC: AcpAdapterSpec = {
  name: 'opencode',
  label: 'OpenCode',
  idPrefix: 'opencode:',
  makeConfig: () => OPENCODE_AGENT_CONFIG,
  failureStopReasons: FAILURE_STOP_REASONS,
  emptyChunk: 'drop',
  mapUsageUpdate: true,
  usage: {
    source: 'result',
    keys: ['totalTokens', 'inputTokens', 'outputTokens', 'cachedReadTokens', 'reasoningTokens', 'thoughtTokens', 'modelId'],
  },
  toolKind: (update) => (update.kind === 'mcp' ? 'mcp' : 'builtin'),
  errorPassthrough: ['OpenCode agent exited', 'not running'],
};

export class OpenCodeBackend implements Backend {
  readonly name = 'opencode';
  readonly capabilities: BackendCapabilities = ACP_CAPABILITIES;

  run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    return runAcpTurn(OPENCODE_SPEC, options);
  }
}
