import * as fs from 'fs';
import * as path from 'path';
import { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { AcpAgentConfig, disposeSharedAcpClient } from './acp-client';
import { ACP_CAPABILITIES, AcpAdapterSpec, runAcpTurn } from './acp-run';

export { disposeSharedAcpClient };

/** stopReasons that represent a failed (non-cancellation) turn. */
const FAILURE_STOP_REASONS = new Set(['refusal', 'error', 'max_tokens', 'max_turn_requests']);

/**
 * Resolve the bundled claude-agent-acp ESM entry
 * (`resources/claude-acp/index.mjs`). It is a single self-contained esbuild
 * bundle vendored into the extension, so no node_modules are required at
 * runtime. Falls back to the installed package during development.
 */
function resolveClaudeAcpEntry(): string {
  const candidates = [
    // Compiled layout: dist/src/backends/claude.js -> <root>/resources/...
    path.join(__dirname, '..', '..', '..', 'resources', 'claude-acp', 'index.mjs'),
    // tsx / source layout: src/backends/claude.ts -> <root>/resources/...
    path.join(__dirname, '..', '..', 'resources', 'claude-acp', 'index.mjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Dev fallback: resolve from node_modules (not shipped in the .vsix).
  try {
    return require.resolve('@agentclientprotocol/claude-agent-acp');
  } catch {
    // Return the primary expected path; spawn will surface a clear ENOENT.
    return candidates[0];
  }
}

/**
 * Shared ACP agent configuration for Claude, via the bundled
 * `claude-agent-acp` adapter (https://github.com/agentclientprotocol/claude-agent-acp).
 * The adapter drives Claude Code through the official Claude Agent SDK and
 * translates its events to ACP.
 *
 * We run the vendored ESM bundle under the current Node runtime. In the VS Code
 * extension host `process.execPath` is Electron; `ELECTRON_RUN_AS_NODE=1` makes
 * it behave as Node. Under plain Node (tests/CLI) the flag is ignored.
 *
 * `CLAUDE_CODE_EXECUTABLE` points the adapter at the user's installed `claude`,
 * so we never need the heavy bundled `@anthropic-ai/claude-agent-sdk` platform
 * binary.
 */
export function claudeAgentConfig(): AcpAgentConfig {
  return {
    key: 'claude',
    label: 'Claude',
    command: process.execPath,
    args: [resolveClaudeAcpEntry()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE || 'claude',
    },
    resolveAuth: (init, env) => {
      const ids = (init.authMethods ?? []).map((m) => m.id);
      const apiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY;
      const apiKeyMethod = ids.find((id) => /api[-_]?key/i.test(id));
      if (apiKey && apiKeyMethod) {
        return { methodId: apiKeyMethod, meta: { headless: true } };
      }
      // Otherwise rely on Claude's own auth (cached login or ANTHROPIC_API_KEY
      // consumed directly by the CLI/SDK). claude-agent-acp advertises no ACP
      // auth methods, so no `authenticate` step is required.
      return null;
    },
  };
}

/**
 * Claude's adapter spec. Claude drops empty agent chunks, reads post-turn usage
 * from `result.usage` (including `thoughtTokens`), maps `usage_update`, and
 * classifies tool kind from the top-level `kind` field.
 */
const CLAUDE_SPEC: AcpAdapterSpec = {
  name: 'claude',
  label: 'Claude',
  idPrefix: 'claude:',
  makeConfig: claudeAgentConfig,
  failureStopReasons: FAILURE_STOP_REASONS,
  emptyChunk: 'drop',
  mapUsageUpdate: true,
  usage: {
    source: 'result',
    keys: [
      'totalTokens',
      'inputTokens',
      'outputTokens',
      'cachedReadTokens',
      'reasoningTokens',
      'thoughtTokens',
      'modelId',
    ],
  },
  toolKind: (update) => (update.kind === 'mcp' ? 'mcp' : 'builtin'),
  errorPassthrough: ['Claude agent exited', 'not running'],
};

export class ClaudeBackend implements Backend {
  readonly name = 'claude';
  readonly capabilities: BackendCapabilities = ACP_CAPABILITIES;

  run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    return runAcpTurn(CLAUDE_SPEC, options);
  }
}
