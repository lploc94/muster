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

function resolveMcpServers(options: RunOptions): McpServerConfig[] {
  return options.mcpServers ?? [];
}

/**
 * Map a Kiro ACP `session/update` to a NormalizedEvent.
 * Kiro implements standard ACP, so update kinds arrive in snake_case
 * (`agent_message_chunk`, `tool_call`, ...). Unknown shapes fall back to
 * `raw` to preserve debuggability if the wire format evolves.
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
    case 'user_message_chunk':
    case 'available_commands_update':
      // Echo/noise with no diagnostic value (matches the Grok reference).
      return undefined;
    case 'tool_call': {
      const toolCallId = typeof update.toolCallId === 'string' ? `kiro:${update.toolCallId}` : undefined;
      const name = typeof update.title === 'string' ? update.title : 'tool';
      if (!toolCallId) return { type: 'raw', line: JSON.stringify(update) };
      const meta = update._meta as Record<string, unknown> | undefined;
      return {
        type: 'toolStarted',
        toolCallId,
        name,
        kind: isMcpTool(update) ? 'mcp' : 'builtin',
        input: update.rawInput,
        meta,
      };
    }
    case 'tool_call_update': {
      const toolCallId = typeof update.toolCallId === 'string' ? `kiro:${update.toolCallId}` : undefined;
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

/** Pull the first text block out of an ACP tool_call_update `content` array. */
function extractToolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textBlock = content.find((c) => (c as { type?: string }).type === 'content') as
    | { content?: { type?: string; text?: string } }
    | undefined;
  return textBlock?.content?.text;
}

function usageFromMeta(meta?: Record<string, unknown>): NormalizedEvent | undefined {
  if (!meta) return undefined;
  const usage: Record<string, unknown> = {};
  for (const key of [
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cachedReadTokens',
    'reasoningTokens',
    'modelId',
  ]) {
    if (meta[key] !== undefined) usage[key] = meta[key];
  }
  if (Object.keys(usage).length === 0) return undefined;
  return { type: 'usage', usage, meta };
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
    return { type: 'error', message: 'Kiro prompt ended without a stopReason' };
  }
  if (FAILURE_STOP_REASONS.has(stopReason)) {
    return { type: 'error', message: `Kiro stopped: ${stopReason}` };
  }
  if (stopReason !== 'end_turn') {
    return { type: 'error', message: `Kiro stopped: ${stopReason}`, meta: { stopReason } };
  }
  return { type: 'turnCompleted', meta: { stopReason } };
}

function cancellationTerminal(): NormalizedEvent {
  return { type: 'error', message: 'Turn cancelled', isCancellation: true };
}

export class KiroBackend implements Backend {
  readonly name = 'kiro';
  readonly capabilities: BackendCapabilities = {
    supportsReasoning: true,
    supportsDetailedToolEvents: true,
    supportsMCP: true,
  };

  async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    const messageId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const mcpServers = resolveMcpServers(options);
    const client = getSharedAcpClient(KIRO_AGENT_CONFIG);

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
          yield { type: 'error', message: 'Kiro agent does not support session resume' };
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

        const usageEvent = usageFromMeta(race.result._meta);
        if (usageEvent) yield usageEvent;
        yield terminalFromPrompt(race.result, isAborted());
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAborted()) {
        yield cancellationTerminal();
      } else if (message.includes('Run `kiro-cli login`') || message.includes('Failed to start')) {
        yield { type: 'error', message };
      } else if (message.includes('Kiro agent exited') || message.includes('not running')) {
        yield { type: 'error', message };
      } else {
        yield { type: 'error', message: `Kiro ACP error: ${message}` };
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      unregister?.();
      unregisterConnection?.();
    }
  }
}
