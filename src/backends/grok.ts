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

function resolveMcpServers(options: RunOptions): McpServerConfig[] {
  // Injection point for the future Muster Bridge (Phase C).
  return options.mcpServers ?? [];
}

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
      return undefined;
    case 'tool_call': {
      const toolCallId = typeof update.toolCallId === 'string' ? `grok:${update.toolCallId}` : undefined;
      const name = typeof update.title === 'string' ? update.title : 'tool';
      if (!toolCallId) return { type: 'raw', line: JSON.stringify(update) };
      const meta = update._meta as Record<string, unknown> | undefined;
      const toolMeta = meta?.['x.ai/tool'] as { kind?: string } | undefined;
      const kindHint = toolMeta?.kind;
      return {
        type: 'toolStarted',
        toolCallId,
        name,
        kind: kindHint === 'mcp' ? 'mcp' : 'builtin',
        input: update.rawInput,
        meta,
      };
    }
    case 'tool_call_update': {
      const toolCallId = typeof update.toolCallId === 'string' ? `grok:${update.toolCallId}` : undefined;
      if (!toolCallId) return { type: 'raw', line: JSON.stringify(update) };
      const meta = update._meta as Record<string, unknown> | undefined;
      const statusRaw =
        typeof update.status === 'string'
          ? update.status
          : (meta?.updateParams as { status?: string } | undefined)?.status;
      const status = statusRaw?.toLowerCase();
      if (status === 'completed' || status === 'failed') {
        const content = update.content as unknown[] | undefined;
        const textBlock = Array.isArray(content)
          ? content.find((c) => (c as { type?: string }).type === 'content') as
              | { content?: { type?: string; text?: string } }
              | undefined
          : undefined;
        const outputText = textBlock?.content?.text;
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

function terminalFromPrompt(
  result: PromptResult,
  cancelled: boolean,
): NormalizedEvent {
  if (cancelled) {
    return { type: 'error', message: 'Turn cancelled', isCancellation: true };
  }

  const stopReason = result.stopReason;
  if (stopReason === 'cancelled') {
    return { type: 'error', message: 'Turn cancelled', isCancellation: true };
  }
  if (typeof stopReason !== 'string' || stopReason.length === 0) {
    return { type: 'error', message: 'Grok prompt ended without a stopReason' };
  }
  if (FAILURE_STOP_REASONS.has(stopReason)) {
    return { type: 'error', message: `Grok stopped: ${stopReason}` };
  }
  if (stopReason !== 'end_turn') {
    return { type: 'error', message: `Grok stopped: ${stopReason}`, meta: { stopReason } };
  }
  return { type: 'turnCompleted', meta: { stopReason } };
}

function cancellationTerminal(): NormalizedEvent {
  return { type: 'error', message: 'Turn cancelled', isCancellation: true };
}

export class GrokBackend implements Backend {
  readonly name = 'grok';
  readonly capabilities: BackendCapabilities = {
    supportsReasoning: true,
    supportsDetailedToolEvents: true,
    supportsMCP: true,
  };

  async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    const messageId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const mcpServers = resolveMcpServers(options);
    const client = getSharedAcpClient(GROK_AGENT_CONFIG);

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
          yield { type: 'error', message: 'Grok agent does not support session resume' };
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
      } else if (message.includes('Run `grok login`') || message.includes('Failed to start')) {
        yield { type: 'error', message };
      } else if (message.includes('Grok agent exited') || message.includes('not running')) {
        yield { type: 'error', message };
      } else {
        yield { type: 'error', message: `Grok ACP error: ${message}` };
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      unregister?.();
      unregisterConnection?.();
    }
  }
}