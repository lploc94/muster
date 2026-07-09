import { randomUUID } from 'crypto';
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

function resolveMcpServers(options: RunOptions): McpServerConfig[] {
  return options.mcpServers ?? [];
}

/**
 * Map an OpenCode (`opencode acp`) ACP `session/update` to a NormalizedEvent.
 * OpenCode implements standard ACP, so update kinds arrive in snake_case
 * (`agent_message_chunk`, `tool_call`, ...). Unknown/non-normalized shapes fall
 * back to `raw` to preserve debuggability if the wire format evolves.
 */
function mapSessionUpdate(update: SessionUpdate, messageId: string): NormalizedEvent | undefined {
  const kind = update.sessionUpdate as string | undefined;

  switch (kind) {
    case 'agent_thought_chunk': {
      const text = (update.content as { text?: string } | undefined)?.text;
      if (typeof text === 'string') {
        // Recognized reasoning chunk: stream non-empty text, skip empties.
        return text.length > 0 ? { type: 'reasoningDelta', content: text, messageId } : undefined;
      }
      // Unexpected shape for a recognized kind — preserve as raw.
      return { type: 'raw', line: JSON.stringify(update) };
    }
    case 'agent_message_chunk': {
      const text = (update.content as { text?: string } | undefined)?.text;
      if (typeof text === 'string') {
        // Recognized assistant chunk: stream non-empty text, skip empties.
        return text.length > 0 ? { type: 'assistantDelta', content: text, messageId } : undefined;
      }
      // Unexpected shape for a recognized kind — preserve as raw.
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
      // Echo / static command-list noise (matches the Grok/Kiro/Codex reference
      // ignore list). All other non-normalized updates fall through to `raw`.
      return undefined;
    case 'tool_call': {
      const toolCallId =
        typeof update.toolCallId === 'string' ? `opencode:${update.toolCallId}` : undefined;
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
      const toolCallId =
        typeof update.toolCallId === 'string' ? `opencode:${update.toolCallId}` : undefined;
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
 * Build a usage event from the prompt result. OpenCode reports token usage on
 * the `session/prompt` result (`usage`).
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
    return { type: 'error', message: 'OpenCode prompt ended without a stopReason' };
  }
  if (FAILURE_STOP_REASONS.has(stopReason)) {
    return { type: 'error', message: `OpenCode stopped: ${stopReason}` };
  }
  if (stopReason !== 'end_turn') {
    return { type: 'error', message: `OpenCode stopped: ${stopReason}`, meta: { stopReason } };
  }
  return { type: 'turnCompleted', meta: { stopReason } };
}

function cancellationTerminal(): NormalizedEvent {
  return { type: 'error', message: 'Turn cancelled', isCancellation: true };
}

export class OpenCodeBackend implements Backend {
  readonly name = 'opencode';
  readonly capabilities: BackendCapabilities = {
    supportsReasoning: true,
    supportsDetailedToolEvents: true,
    supportsMCP: true,
  };

  async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    const messageId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const mcpServers = resolveMcpServers(options);
    const client = getSharedAcpClient(OPENCODE_AGENT_CONFIG);

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
          yield { type: 'error', message: 'OpenCode agent does not support session resume' };
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
      } else if (message.includes('OpenCode agent exited') || message.includes('not running')) {
        yield { type: 'error', message };
      } else {
        yield { type: 'error', message: `OpenCode ACP error: ${message}` };
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      unregister?.();
      unregisterConnection?.();
    }
  }
}
