import * as fs from 'fs';
import * as path from 'path';
import { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { AcpAgentConfig, disposeSharedAcpClient } from './acp-client';
import { ACP_CAPABILITIES, AcpAdapterSpec, runAcpTurn } from './acp-run';

export { disposeSharedAcpClient };

/** stopReasons that represent a failed (non-cancellation) turn. */
const FAILURE_STOP_REASONS = new Set(['refusal', 'error', 'max_tokens', 'max_turn_requests']);

/**
 * Resolve the bundled codex-acp ESM entry (`resources/codex-acp/index.mjs`).
 * It is a single self-contained esbuild bundle vendored into the extension, so
 * no node_modules are required at runtime. Falls back to the installed package
 * during development.
 */
function resolveCodexAcpEntry(): string {
  const candidates = [
    // Compiled layout: dist/src/backends/codex.js -> <root>/resources/...
    path.join(__dirname, '..', '..', '..', 'resources', 'codex-acp', 'index.mjs'),
    // tsx / source layout: src/backends/codex.ts -> <root>/resources/...
    path.join(__dirname, '..', '..', 'resources', 'codex-acp', 'index.mjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Dev fallback: resolve from node_modules (not shipped in the .vsix).
  try {
    return require.resolve('@agentclientprotocol/codex-acp');
  } catch {
    // Return the primary expected path; spawn will surface a clear ENOENT.
    return candidates[0];
  }
}

/**
 * Shared ACP agent configuration for Codex, via the bundled `codex-acp` adapter
 * (https://github.com/agentclientprotocol/codex-acp). The adapter starts
 * `<CODEX_PATH> app-server` under the hood and translates Codex events to ACP.
 *
 * We run the vendored ESM bundle under the current Node runtime. In the VS Code
 * extension host `process.execPath` is Electron; `ELECTRON_RUN_AS_NODE=1` makes
 * it behave as Node. Under plain Node (tests/CLI) the flag is ignored.
 *
 * `CODEX_PATH` points the adapter at the user's installed `codex`, so we never
 * need the heavy bundled `@openai/codex` platform binary.
 */
export function codexAgentConfig(): AcpAgentConfig {
  return {
    key: 'codex',
    label: 'Codex',
    command: process.execPath,
    args: [resolveCodexAcpEntry()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      CODEX_PATH: process.env.CODEX_PATH || 'codex',
    },
    resolveAuth: (init, env) => {
      const ids = (init.authMethods ?? []).map((m) => m.id);
      const apiKey = env.CODEX_API_KEY || env.OPENAI_API_KEY;
      const apiKeyMethod = ids.find((id) => /api[-_]?key/i.test(id));
      if (apiKey && apiKeyMethod) {
        return { methodId: apiKeyMethod, meta: { headless: true } };
      }
      // Otherwise rely on Codex's cached login (e.g. ChatGPT) — no authenticate
      // step is required (verified against codex-acp 1.1.0).
      return null;
    },
  };
}

const CODEX_SPEC: AcpAdapterSpec = {
  name: 'codex',
  label: 'Codex',
  idPrefix: 'codex:',
  makeConfig: codexAgentConfig,
  failureStopReasons: FAILURE_STOP_REASONS,
  emptyChunk: 'raw',
  mapUsageUpdate: true,
  usage: {
    source: 'result',
    keys: ['totalTokens', 'inputTokens', 'outputTokens', 'cachedReadTokens', 'reasoningTokens', 'thoughtTokens', 'modelId'],
  },
  toolKind: (update) => (update.kind === 'mcp' ? 'mcp' : 'builtin'),
  errorPassthrough: ['Codex agent exited', 'not running'],
};

export class CodexBackend implements Backend {
  readonly name = 'codex';
  readonly capabilities: BackendCapabilities = ACP_CAPABILITIES;

  run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    return runAcpTurn(CODEX_SPEC, options);
  }
}
