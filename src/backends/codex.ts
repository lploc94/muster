import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Backend, BackendCapabilities, McpServerConfig, NormalizedEvent, RunOptions } from '../types';
import {
  AcpAgentConfig,
  PromptResult,
  SessionUpdate,
  disposeSharedAcpClient,
  getSharedAcpClient,
} from './acp-client';

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

function resolveMcpServers(options: RunOptions): McpServerConfig[] {
  return options.mcpServers ?? [];
}

/**
 * Map a Codex (codex-acp) ACP `session/update` to a NormalizedEvent.
 * codex-acp implements standard ACP, so update kinds arrive in snake_case
 * (`agent_message_chunk`, `tool_call`, ...). Unknown/non-normalized shapes fall
 * back to `raw` to preserve debuggability if the wire format evolves.
 */
function mapSessionUpdate(update: SessionUpdate, messageId: string): NormalizedEvent | undefined {
  const kind = update.sessionUpdate as string | undefined;

  switch (kind) {
    case 'agent_thought_chunk': {
      const text = (update.content as { text?: string } | undefined)?.text;
      if (typeof text === 'string' && text.length > 0) {
        return { type: 'reasoningDelta', content: text, messageId };
      }
      return { type: 'raw', line: JSON.stringify(update) };
    }
    case 'agent_message_chunk': {
      const text = (update.content as { text?: string } | undefined)?.text;
      if (typeof text === 'string' && text.length > 0) {
        return { type: 'assistantDelta', content: text, messageId };
      }
      return { type: 'raw', line: JSON.stringify(update) };
    }
    case 'usage_update': {
      const usage: Record<string, unknown> = {};
      if (update.used !== undefined) usage.used = update.used;
      if (update.size !== undefined) usage.size = update.size;
      if (Object.keys(usage).length === 0) return undefined;
      return { type: 'usage', usage };
    }
    case 'user_message_chunk':
    case 'available_commands_update':
      // Echo / static command-list noise (matches the Grok/Kiro reference
      // ignore list). All other non-normalized updates fall through to `raw`.
      return undefined;
    case 'tool_call': {
      const toolCallId = typeof update.toolCallId === 'string' ? `codex:${update.toolCallId}` : undefined;
      const name = typeof update.title === 'string' ? update.title : 'tool';
      if (!toolCallId) return { type: 'raw', line: JSON.stringify(update) };
      const meta = update._meta as Record<string, unknown> | undefined;
      return {
        type: 'toolStarted',
        toolCallId,
        name,
        kind: update.kind === 'mcp' ? 'mcp' : 'builtin',
        input: update.rawInput,
        meta,
      };
    }
    case 'tool_call_update': {
      const toolCallId = typeof update.toolCallId === 'string' ? `codex:${update.toolCallId}` : undefined;
      if (!toolCallId) return { type: 'raw', line: JSON.stringify(update) };
      const meta = update._meta as Record<string, unknown> | undefined;
      const statusRaw =
        typeof update.status === 'string'
          ? update.status
          : (meta?.updateParams as { status?: string } | undefined)?.status;
      const status = statusRaw?.toLowerCase();
      if (status === 'completed' || status === 'failed') {
        const outputText = extractToolOutput(update.content);
        if (status === 'failed') {
          return {
            type: 'toolCompleted',
            toolCallId,
            outcome: 'error',
            error: outputText ?? 'Tool failed',
            meta,
          };
        }
        return {
          type: 'toolCompleted',
          toolCallId,
          outcome: 'success',
          output: outputText,
          meta,
        };
      }
      return {
        type: 'toolUpdated',
        toolCallId,
        input: update.rawInput,
        meta,
      };
    }
    default:
      return { type: 'raw', line: JSON.stringify(update) };
  }
}

/** Pull the first text block out of an ACP tool_call_update `content` array. */
function extractToolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textBlock = content.find((c) => (c as { type?: string }).type === 'content') as
    | { content?: { type?: string; text?: string } }
    | undefined;
  return textBlock?.content?.text;
}

/**
 * Build a usage event from the prompt result. codex-acp reports token usage on
 * the `session/prompt` result (`usage`) and in `_meta.quota`.
 */
function usageFromResult(result: PromptResult): NormalizedEvent | undefined {
  const usage: Record<string, unknown> = {};
  const src = (result.usage ?? {}) as Record<string, unknown>;
  for (const key of [
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cachedReadTokens',
    'reasoningTokens',
    'thoughtTokens',
    'modelId',
  ]) {
    if (src[key] !== undefined) usage[key] = src[key];
  }
  if (Object.keys(usage).length === 0) return undefined;
  return { type: 'usage', usage, meta: result._meta };
}

function terminalFromPrompt(result: PromptResult, cancelled: boolean): NormalizedEvent {
  if (cancelled) {
    return { type: 'error', message: 'Turn cancelled', isCancellation: true };
  }

  const stopReason = result.stopReason;
  if (stopReason === 'cancelled') {
    return { type: 'error', message: 'Turn cancelled', isCancellation: true };
  }
  if (typeof stopReason !== 'string' || stopReason.length === 0) {
    return { type: 'error', message: 'Codex prompt ended without a stopReason' };
  }
  if (FAILURE_STOP_REASONS.has(stopReason)) {
    return { type: 'error', message: `Codex stopped: ${stopReason}` };
  }
  if (stopReason !== 'end_turn') {
    return { type: 'error', message: `Codex stopped: ${stopReason}`, meta: { stopReason } };
  }
  return { type: 'turnCompleted', meta: { stopReason } };
}

function cancellationTerminal(): NormalizedEvent {
  return { type: 'error', message: 'Turn cancelled', isCancellation: true };
}

export class CodexBackend implements Backend {
  readonly name = 'codex';
  readonly capabilities: BackendCapabilities = {
    supportsReasoning: true,
    supportsDetailedToolEvents: true,
    supportsMCP: true,
  };

  async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    const messageId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const mcpServers = resolveMcpServers(options);
    const client = getSharedAcpClient(codexAgentConfig());

    let activeSessionId: string | undefined;
    let unregister: (() => void) | undefined;
    let unregisterConnection: (() => void) | undefined;
    let cancelled = false;

    const isAborted = () => cancelled || !!options.signal?.aborted;

    const onAbort = () => {
      cancelled = true;
      if (activeSessionId) client.cancel(activeSessionId);
    };

    if (isAborted()) {
      yield cancellationTerminal();
      return;
    }

    options.signal?.addEventListener('abort', onAbort);

    const pendingUpdates: NormalizedEvent[] = [];
    const bufferUpdate = (update: SessionUpdate) => {
      const mapped = mapSessionUpdate(update, messageId);
      if (mapped) pendingUpdates.push(mapped);
    };
    const bufferConnectionLine = (line: string, source: 'stderr' | 'non-json') => {
      const prefix = source === 'stderr' ? '[stderr] ' : '[acp] ';
      pendingUpdates.push({ type: 'raw', line: prefix + line });
    };

    try {
      unregisterConnection = client.registerConnectionSink(bufferConnectionLine);

      await client.ensureConnected(options.extraEnv);
      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }

      if (options.resumeId) {
        if (!client.loadSessionSupported) {
          yield { type: 'error', message: 'Codex agent does not support session resume' };
          return;
        }
        const loaded = await client.loadSession(options.resumeId, cwd, mcpServers);
        activeSessionId = loaded.sessionId;
        if (isAborted()) {
          yield cancellationTerminal();
          return;
        }
        yield { type: 'sessionStarted', sessionId: activeSessionId };
        unregister = client.registerSessionSink(activeSessionId, bufferUpdate);
      } else {
        const created = await client.newSession(cwd, mcpServers);
        activeSessionId = created.sessionId;
        if (isAborted()) {
          yield cancellationTerminal();
          return;
        }
        yield { type: 'sessionStarted', sessionId: activeSessionId };
        unregister = client.registerSessionSink(activeSessionId, bufferUpdate);
      }

      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }

      const promptPromise = client.prompt(activeSessionId, options.prompt, options.signal);

      while (true) {
        while (pendingUpdates.length > 0) {
          yield pendingUpdates.shift()!;
        }

        const race = await Promise.race([
          promptPromise.then((r) => ({ kind: 'done' as const, result: r })),
          new Promise<{ kind: 'tick' }>((resolve) => setTimeout(() => resolve({ kind: 'tick' }), 50)),
        ]);

        if (race.kind === 'tick') continue;

        while (pendingUpdates.length > 0) {
          yield pendingUpdates.shift()!;
        }

        const usageEvent = usageFromResult(race.result);
        if (usageEvent) yield usageEvent;
        yield terminalFromPrompt(race.result, isAborted());
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAborted()) {
        yield cancellationTerminal();
      } else if (message.includes('Codex agent exited') || message.includes('not running')) {
        yield { type: 'error', message };
      } else {
        yield { type: 'error', message: `Codex ACP error: ${message}` };
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      unregister?.();
      unregisterConnection?.();
    }
  }
}
