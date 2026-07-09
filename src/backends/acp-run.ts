import { randomUUID } from 'crypto';
import { BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { AcpAgentConfig, PromptResult, SessionUpdate, getSharedAcpClient } from './acp-client';

/**
 * Shared ACP turn runner.
 *
 * The five backend adapters (claude/grok/kiro/codex/opencode) drive the same
 * ACP session/prompt loop; they differ only at a small, enumerable set of
 * points. This module extracts the common loop and mapping, parameterized by an
 * {@link AcpAdapterSpec} that makes every one of those historical divergences
 * ("drifts") explicit and centralized instead of implicit and copy-pasted.
 *
 * This extraction is behavior-preserving: each spec reproduces its adapter's
 * current observable `NormalizedEvent` stream exactly (pinned by the per-adapter
 * characterization tests). Normalizing the drifts is a separate, deliberate step.
 */

/** How an adapter treats an empty-string agent chunk. */
export type EmptyChunkMode = 'drop' | 'raw';

/** Where an adapter reads post-turn token usage from. */
export type UsageSource = 'result' | 'meta';

/** The per-adapter configuration that parameterizes the shared ACP turn runner. */
export interface AcpAdapterSpec {
  /** Backend id, e.g. `'claude'`. */
  readonly name: string;
  /** Human label used in terminal/error messages, e.g. `'Claude'`. */
  readonly label: string;
  /** Namespace prefix for tool-call ids, e.g. `'claude:'`. */
  readonly idPrefix: string;
  /**
   * Produce the ACP agent connection config. Evaluated once per run so
   * function-based configs (claude/codex) re-resolve env/paths at call time,
   * matching the previous per-adapter behavior.
   */
  readonly makeConfig: () => AcpAgentConfig;
  /** stopReasons that represent a failed (non-cancellation) turn. */
  readonly failureStopReasons: ReadonlySet<string>;
  /** Empty `agent_message_chunk`/`agent_thought_chunk`: `'drop'` skips it, `'raw'` emits a raw event. */
  readonly emptyChunk: EmptyChunkMode;
  /** Whether a `usage_update` session update maps to a usage event (else it falls through to `raw`). */
  readonly mapUsageUpdate: boolean;
  /** Post-turn usage: which result field to read the keys from, and which keys to surface. */
  readonly usage: { readonly source: UsageSource; readonly keys: readonly string[] };
  /** Classify a `tool_call`'s mcp/builtin kind from the update. */
  readonly toolKind: (update: SessionUpdate) => 'mcp' | 'builtin';
  /** Error messages containing any of these substrings pass through the catch unwrapped (no `<Label> ACP error:` prefix). */
  readonly errorPassthrough: readonly string[];
}

/** Every ACP adapter advertises the same capabilities. */
export const ACP_CAPABILITIES: BackendCapabilities = {
  supportsReasoning: true,
  supportsDetailedToolEvents: true,
  supportsMCP: true,
};

function cancellationTerminal(): NormalizedEvent {
  return { type: 'error', message: 'Turn cancelled', isCancellation: true };
}

/** Pull the first text block out of an ACP `tool_call_update` `content` array. */
function extractToolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textBlock = content.find((c) => (c as { type?: string }).type === 'content') as
    | { content?: { type?: string; text?: string } }
    | undefined;
  return textBlock?.content?.text;
}

/** Map an `agent_message_chunk` / `agent_thought_chunk` to its delta (or raw / dropped). */
function chunkEvent(
  update: SessionUpdate,
  messageId: string,
  spec: AcpAdapterSpec,
  type: 'assistantDelta' | 'reasoningDelta',
): NormalizedEvent | undefined {
  const text = (update.content as { text?: string } | undefined)?.text;
  if (typeof text === 'string') {
    if (text.length > 0) return { type, content: text, messageId };
    // Empty string: some adapters drop it, others surface it as raw noise.
    return spec.emptyChunk === 'drop' ? undefined : { type: 'raw', line: JSON.stringify(update) };
  }
  // Unexpected shape for a recognized kind — preserve as raw.
  return { type: 'raw', line: JSON.stringify(update) };
}

/**
 * Map an ACP `session/update` to a NormalizedEvent. Update kinds arrive in
 * snake_case (`agent_message_chunk`, `tool_call`, ...). Unknown/non-normalized
 * shapes fall back to `raw` to preserve debuggability if the wire format evolves.
 */
function mapSessionUpdate(
  update: SessionUpdate,
  messageId: string,
  spec: AcpAdapterSpec,
): NormalizedEvent | undefined {
  const kind = update.sessionUpdate as string | undefined;

  switch (kind) {
    case 'agent_thought_chunk':
      return chunkEvent(update, messageId, spec, 'reasoningDelta');
    case 'agent_message_chunk':
      return chunkEvent(update, messageId, spec, 'assistantDelta');
    case 'usage_update': {
      if (!spec.mapUsageUpdate) return { type: 'raw', line: JSON.stringify(update) };
      const usage: Record<string, unknown> = {};
      if (update.used !== undefined) usage.used = update.used;
      if (update.size !== undefined) usage.size = update.size;
      if (Object.keys(usage).length === 0) return undefined;
      return { type: 'usage', usage };
    }
    case 'user_message_chunk':
    case 'available_commands_update':
      // Echo / static command-list noise. All other non-normalized updates fall through to `raw`.
      return undefined;
    case 'tool_call': {
      const toolCallId =
        typeof update.toolCallId === 'string' ? `${spec.idPrefix}${update.toolCallId}` : undefined;
      const name = typeof update.title === 'string' ? update.title : 'tool';
      if (!toolCallId) return { type: 'raw', line: JSON.stringify(update) };
      const meta = update._meta as Record<string, unknown> | undefined;
      return {
        type: 'toolStarted',
        toolCallId,
        name,
        kind: spec.toolKind(update),
        input: update.rawInput,
        meta,
      };
    }
    case 'tool_call_update': {
      const toolCallId =
        typeof update.toolCallId === 'string' ? `${spec.idPrefix}${update.toolCallId}` : undefined;
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
          return { type: 'toolCompleted', toolCallId, outcome: 'error', error: outputText ?? 'Tool failed', meta };
        }
        return { type: 'toolCompleted', toolCallId, outcome: 'success', output: outputText, meta };
      }
      return { type: 'toolUpdated', toolCallId, input: update.rawInput, meta };
    }
    default:
      return { type: 'raw', line: JSON.stringify(update) };
  }
}

/** Build a usage event from the prompt result, reading from the spec-configured source. */
function usageFromResult(result: PromptResult, spec: AcpAdapterSpec): NormalizedEvent | undefined {
  const src = (spec.usage.source === 'meta' ? result._meta : result.usage) as
    | Record<string, unknown>
    | undefined;
  // Meta-sourced adapters (grok/kiro) emit nothing when `_meta` is absent.
  if (spec.usage.source === 'meta' && !src) return undefined;
  const usage: Record<string, unknown> = {};
  const from = src ?? {};
  for (const key of spec.usage.keys) {
    if (from[key] !== undefined) usage[key] = from[key];
  }
  if (Object.keys(usage).length === 0) return undefined;
  return { type: 'usage', usage, meta: result._meta };
}

function terminalFromPrompt(result: PromptResult, cancelled: boolean, spec: AcpAdapterSpec): NormalizedEvent {
  if (cancelled) {
    return { type: 'error', message: 'Turn cancelled', isCancellation: true };
  }
  const stopReason = result.stopReason;
  if (stopReason === 'cancelled') {
    return { type: 'error', message: 'Turn cancelled', isCancellation: true };
  }
  if (typeof stopReason !== 'string' || stopReason.length === 0) {
    return { type: 'error', message: `${spec.label} prompt ended without a stopReason` };
  }
  if (spec.failureStopReasons.has(stopReason)) {
    return { type: 'error', message: `${spec.label} stopped: ${stopReason}` };
  }
  if (stopReason !== 'end_turn') {
    return { type: 'error', message: `${spec.label} stopped: ${stopReason}`, meta: { stopReason } };
  }
  return { type: 'turnCompleted', meta: { stopReason } };
}

/**
 * Run one ACP turn for the given adapter spec and emit its NormalizedEvent
 * stream. This is the single, shared implementation of every adapter's `run()`.
 */
export async function* runAcpTurn(
  spec: AcpAdapterSpec,
  options: RunOptions,
): AsyncIterable<NormalizedEvent> {
  const messageId = randomUUID();
  const cwd = options.cwd || process.cwd();
  const mcpServers = options.mcpServers ?? [];
  const client = getSharedAcpClient(spec.makeConfig());

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
    const mapped = mapSessionUpdate(update, messageId, spec);
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
        yield { type: 'error', message: `${spec.label} agent does not support session resume` };
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

      const usageEvent = usageFromResult(race.result, spec);
      if (usageEvent) yield usageEvent;
      yield terminalFromPrompt(race.result, isAborted(), spec);
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAborted()) {
      yield cancellationTerminal();
    } else if (spec.errorPassthrough.some((pattern) => message.includes(pattern))) {
      yield { type: 'error', message };
    } else {
      yield { type: 'error', message: `${spec.label} ACP error: ${message}` };
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    unregister?.();
    unregisterConnection?.();
  }
}
