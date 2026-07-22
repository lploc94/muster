import { randomUUID } from 'crypto';
import {
  BackendCapabilities,
  McpSetupAttemptContext,
  McpSetupPrepareResult,
  McpSetupRecoveryMode,
  NormalizedEvent,
  RunOptions,
} from '../types';
import {
  AcpAgentConfig,
  type AcpModelConfig,
  PromptResult,
  SessionUpdate,
  getSharedAcpClient,
} from './acp-client';

/** Strip secrets from setup failure messages (never leak bearer tokens). */
function redactSetupMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/MUSTER_BRIDGE_TOKEN[=:]\S*/gi, 'MUSTER_BRIDGE_TOKEN=[REDACTED]')
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]');
}

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
  /** Config option id used for model selection (default `'model'`); passed as `configId` to `session/set_config_option`. */
  readonly modelConfigId?: string;
  /**
   * OpenCode can flush session/update notifications after the session/prompt
   * response. Wait for a bounded quiet window before emitting the terminal.
   */
  readonly lateUpdateDrainMs?: number;
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

/** Pull displayable output from an ACP `tool_call_update`. */
function extractToolOutput(update: SessionUpdate): unknown {
  const content = update.content;
  if (!Array.isArray(content)) return update.rawOutput;
  const textBlock = content.find((c) => (c as { type?: string }).type === 'content') as
    | { content?: { type?: string; text?: string } }
    | undefined;
  return textBlock?.content?.text ?? update.rawOutput;
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
        const output = extractToolOutput(update);
        if (status === 'failed') {
          const error = typeof output === 'string'
            ? output
            : output === undefined
              ? 'Tool failed'
              : JSON.stringify(output);
          return { type: 'toolCompleted', toolCallId, outcome: 'error', error, meta };
        }
        return { type: 'toolCompleted', toolCallId, outcome: 'success', output, meta };
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
  const interruptConfidence: 'confirmed' | 'forced' =
    result.cancelConfidence === 'forced' ? 'forced' : 'confirmed';
  if (cancelled) {
    return {
      type: 'error',
      message: 'Turn cancelled',
      isCancellation: true,
      meta: { interruptConfidence },
    };
  }
  const stopReason = result.stopReason;
  if (stopReason === 'cancelled') {
    return {
      type: 'error',
      message: 'Turn cancelled',
      isCancellation: true,
      meta: { interruptConfidence },
    };
  }
  // Prompt returned a terminal result — Phase B session-bind evidence.
  const terminalMeta = { failureClass: 'terminal_received' as const };
  if (typeof stopReason !== 'string' || stopReason.length === 0) {
    return {
      type: 'error',
      message: `${spec.label} prompt ended without a stopReason`,
      meta: terminalMeta,
    };
  }
  if (spec.failureStopReasons.has(stopReason)) {
    return {
      type: 'error',
      message: `${spec.label} stopped: ${stopReason}`,
      meta: terminalMeta,
    };
  }
  if (stopReason !== 'end_turn') {
    return {
      type: 'error',
      message: `${spec.label} stopped: ${stopReason}`,
      meta: { ...terminalMeta, stopReason },
    };
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
  let modelConfig: AcpModelConfig | undefined;
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
  let updateVersion = 0;
  const bufferUpdate = (update: SessionUpdate) => {
    updateVersion += 1;
    const mapped = mapSessionUpdate(update, messageId, spec);
    if (mapped) pendingUpdates.push(mapped);
  };
  const bufferConnectionLine = (line: string, source: 'stderr' | 'non-json') => {
    const prefix = source === 'stderr' ? '[stderr] ' : '[acp] ';
    pendingUpdates.push({ type: 'raw', line: prefix + line });
  };

  try {
    unregisterConnection = client.registerConnectionSink(bufferConnectionLine);

    // One absolute setup deadline from remaining run budget; recompute per request.
    const setupDeadlineAt =
      options.setupTimeoutMs !== undefined
        ? Date.now() + Math.max(1, options.setupTimeoutMs)
        : undefined;
    const remainingSetupMs = (): number | undefined => {
      if (setupDeadlineAt === undefined) return undefined;
      return Math.max(1, setupDeadlineAt - Date.now());
    };
    const raceSetup = async <T>(work: Promise<T>): Promise<T> => {
      if (isAborted()) throw new Error('Turn cancelled');
      const remaining = remainingSetupMs();
      if (remaining === undefined) return work;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      try {
        return await Promise.race([
          work,
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('ACP setup timed out before run deadline')),
              remaining,
            );
            if (isAborted()) {
              reject(new Error('Turn cancelled'));
              return;
            }
            const abortReject = () => reject(new Error('Turn cancelled'));
            options.signal?.addEventListener('abort', abortReject, { once: true });
            // Handled cleanup — do not use work.finally() (unhandled rejection on reject).
            void work.then(
              () => options.signal?.removeEventListener('abort', abortReject),
              () => options.signal?.removeEventListener('abort', abortReject),
            );
          }),
        ]);
      } finally {
        cleanup();
      }
    };

    await raceSetup(client.ensureConnected(options.extraEnv));
    if (isAborted()) {
      yield cancellationTerminal();
      return;
    }

    const applyModel = async (sessionId: string): Promise<'ok' | 'cancel'> => {
      if (!options.model) return 'ok';
      try {
        const setupMs = remainingSetupMs();
        if (modelConfig?.applyVia === 'session_set_model') {
          await raceSetup(
            setupMs === undefined
              ? client.setSessionModel(sessionId, options.model)
              : client.setSessionModel(sessionId, options.model, setupMs),
          );
        } else {
          const configId = modelConfig?.id ?? spec.modelConfigId ?? 'model';
          await raceSetup(
            setupMs === undefined
              ? client.setConfigOption(sessionId, configId, options.model)
              : client.setConfigOption(sessionId, configId, options.model, setupMs),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message === 'Turn cancelled' ||
          message === 'ACP setup timed out before run deadline' ||
          isAborted()
        ) {
          return 'cancel';
        }
        // Non-fatal model option failure — continue with agent default.
      }
      return 'ok';
    };

    const openSession = async (
      resumeTarget: string | undefined,
    ): Promise<{ sessionId: string } | { error: NormalizedEvent }> => {
      if (resumeTarget) {
        if (!client.loadSessionSupported) {
          return {
            error: {
              type: 'error',
              message: `${spec.label} agent does not support session resume`,
            },
          };
        }
        const setupMs = remainingSetupMs();
        const loaded = await raceSetup(
          setupMs === undefined
            ? client.loadSession(resumeTarget, cwd, mcpServers)
            : client.loadSession(resumeTarget, cwd, mcpServers, setupMs),
        );
        return { sessionId: loaded.sessionId };
      }
      const setupMs = remainingSetupMs();
      const created = await raceSetup(
        setupMs === undefined
          ? client.newSession(cwd, mcpServers)
          : client.newSession(cwd, mcpServers, setupMs),
      );
      modelConfig = created.modelConfig;
      return { sessionId: created.sessionId };
    };

    const drainPrompt = async function* (
      sessionId: string,
      promptText: string,
    ): AsyncGenerator<NormalizedEvent, void, unknown> {
      if (options.onBeforePrompt) {
        await options.onBeforePrompt();
      }
      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }

      const promptPromise = client.prompt(
        sessionId,
        promptText,
        options.signal,
        options.promptTimeoutMs,
      );

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

        // OpenCode 1.2.x can resolve session/prompt before its final
        // session/update notifications are flushed (upstream #17505). Keep
        // the session sink registered through a bounded quiet window so late
        // assistant chunks are not orphaned behind the terminal event.
        const lateUpdateDrainMs = spec.lateUpdateDrainMs;
        if (lateUpdateDrainMs !== undefined && lateUpdateDrainMs > 0) {
          const waitForDrainTick = (): Promise<void> =>
            new Promise((resolve) => {
              let settled = false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const finish = () => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                options.signal?.removeEventListener('abort', finish);
                resolve();
              };
              timer = setTimeout(finish, lateUpdateDrainMs);
              if (isAborted()) finish();
              else options.signal?.addEventListener('abort', finish, { once: true });
            });
          const deadline = Date.now() + lateUpdateDrainMs * 5;
          let quietVersion = updateVersion;
          while (Date.now() < deadline && !isAborted()) {
            await waitForDrainTick();
            if (isAborted() || updateVersion === quietVersion) break;
            quietVersion = updateVersion;
            while (pendingUpdates.length > 0) {
              yield pendingUpdates.shift()!;
            }
          }
        }

        while (pendingUpdates.length > 0) {
          yield pendingUpdates.shift()!;
        }

        const usageEvent = usageFromResult(race.result, spec);
        if (usageEvent) yield usageEvent;
        yield terminalFromPrompt(race.result, isAborted(), spec);
        return;
      }
    };

    // ── Legacy path (no mcpSetup): session → onBeforePrompt → prompt ─────────
    if (!options.mcpSetup) {
      const opened = await openSession(options.resumeId);
      if ('error' in opened) {
        yield opened.error;
        return;
      }
      activeSessionId = opened.sessionId;
      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }
      yield { type: 'sessionStarted', sessionId: activeSessionId };
      unregister = client.registerSessionSink(activeSessionId, bufferUpdate);

      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }

      // Only await model selection when a model is requested — a no-op await
      // introduces a microtask that races mid-turn abort characterization tests.
      if (options.model) {
        const modelResult = await applyModel(activeSessionId);
        if (modelResult === 'cancel') {
          yield cancellationTerminal();
          return;
        }
      }

      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }

      yield* drainPrompt(activeSessionId, options.prompt);
      return;
    }

    // ── M017-S06: bounded pre-dispatch MCP setup loop (max 2 attempts) ───────
    const mcpSetup = options.mcpSetup;
    const maxAttempts = Math.max(1, Math.min(2, mcpSetup.maxAttempts ?? 2));
    let forceFreshSession = false;
    let previousFailure: { code: string; message: string } | undefined;
    let activePrompt = options.prompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }

      const recoveryMode: McpSetupRecoveryMode = forceFreshSession
        ? 'fresh_after_sticky'
        : options.resumeId && !forceFreshSession
          ? 'load'
          : 'new';
      // Refine recoveryMode after prepareAttempt may override resume.
      let ctx: McpSetupAttemptContext = {
        attempt,
        maxAttempts,
        recoveryMode,
        forceFreshSession,
        previousFailure,
      };

      const preparedRaw = await mcpSetup.prepareAttempt(ctx);
      const prepared: McpSetupPrepareResult =
        preparedRaw && typeof preparedRaw === 'object' ? preparedRaw : {};

      if (typeof prepared.prompt === 'string') {
        activePrompt = prepared.prompt;
      }

      let resumeTarget: string | undefined;
      if (forceFreshSession || prepared.resumeId === null) {
        resumeTarget = undefined;
        ctx = { ...ctx, recoveryMode: forceFreshSession ? 'fresh_after_sticky' : 'new' };
      } else if (typeof prepared.resumeId === 'string') {
        resumeTarget = prepared.resumeId;
        ctx = { ...ctx, recoveryMode: 'load' };
      } else if (options.resumeId && !forceFreshSession) {
        resumeTarget = options.resumeId;
        ctx = { ...ctx, recoveryMode: 'load' };
      } else {
        resumeTarget = undefined;
        ctx = { ...ctx, recoveryMode: forceFreshSession ? 'fresh_after_sticky' : 'new' };
      }

      // Drop any prior attempt's sink before opening a replacement session.
      unregister?.();
      unregister = undefined;
      activeSessionId = undefined;

      let sessionId: string;
      try {
        const opened = await openSession(resumeTarget);
        if ('error' in opened) {
          // Non-retriable capability error (e.g. load unsupported).
          yield opened.error;
          return;
        }
        sessionId = opened.sessionId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'Turn cancelled' || isAborted()) {
          yield cancellationTerminal();
          return;
        }
        const code =
          message === 'ACP setup timed out before run deadline' ? 'setup_timeout' : 'missing_evidence';
        const failure = { code, message: redactSetupMessage(message) };
        previousFailure = failure;
        await mcpSetup.disposeAttempt?.({ ...ctx, failure });
        if (attempt >= maxAttempts || code === 'setup_timeout') {
          yield {
            type: 'error',
            message: `mcp setup exhausted (attempts_exhausted): ${code} after ${attempt} attempts`,
            meta: {
              mcpSetupCode: 'attempts_exhausted',
              readinessCode: code,
              attemptCount: attempt,
            },
          };
          return;
        }
        continue;
      }

      activeSessionId = sessionId;
      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }
      yield { type: 'sessionStarted', sessionId };
      unregister = client.registerSessionSink(sessionId, bufferUpdate);

      if (options.model) {
        const modelResult = await applyModel(sessionId);
        if (modelResult === 'cancel') {
          yield cancellationTerminal();
          return;
        }
      }
      if (isAborted()) {
        yield cancellationTerminal();
        return;
      }

      const ready = await mcpSetup.awaitReady({ ...ctx, sessionId });
      if (ready.ok) {
        // Ready: at-most-once dispatch for this turn.
        yield* drainPrompt(sessionId, activePrompt);
        return;
      }

      const failure = {
        code: String(ready.code),
        message: redactSetupMessage(ready.message),
      };
      previousFailure = failure;

      // Close only the failed session — never the shared process.
      unregister?.();
      unregister = undefined;
      try {
        await client.closeSession(sessionId);
      } catch {
        // Best-effort session/close.
      }
      activeSessionId = undefined;

      await mcpSetup.disposeAttempt?.({
        ...ctx,
        sessionId,
        failure,
      });

      const sticky =
        ready.sticky === true ||
        ready.code === 'session_registry_sticky';
      const retriable = ready.retriable !== false && attempt < maxAttempts;

      if (sticky) {
        forceFreshSession = true;
        if (mcpSetup.buildFreshSessionPrompt) {
          try {
            const recoveryPrompt = await mcpSetup.buildFreshSessionPrompt({
              ...ctx,
              forceFreshSession: true,
              recoveryMode: 'fresh_after_sticky',
              sessionId,
              previousFailure: failure,
            });
            // Reject empty/whitespace recovery prompts — never dispatch a
            // context-less prompt after sticky load failure (Design §9.3).
            if (typeof recoveryPrompt !== 'string' || recoveryPrompt.trim().length === 0) {
              yield {
                type: 'error',
                message: 'recovery prompt empty after sticky session failure',
                meta: {
                  mcpSetupCode: 'session_registry_sticky',
                  readinessCode: failure.code,
                  attemptCount: attempt,
                },
              };
              return;
            }
            activePrompt = recoveryPrompt;
          } catch (budgetErr) {
            const budgetMessage =
              budgetErr instanceof Error ? budgetErr.message : String(budgetErr);
            yield {
              type: 'error',
              message: redactSetupMessage(
                budgetMessage.includes('budget') || /recovery prompt/i.test(budgetMessage)
                  ? budgetMessage
                  : `recovery prompt failed: ${budgetMessage}`,
              ),
              meta: {
                mcpSetupCode: 'session_registry_sticky',
                readinessCode: failure.code,
                attemptCount: attempt,
              },
            };
            return;
          }
        }
      }

      if (!retriable) {
        yield {
          type: 'error',
          message: `mcp setup exhausted (attempts_exhausted): ${failure.code} after ${attempt} attempts`,
          meta: {
            mcpSetupCode: 'attempts_exhausted',
            readinessCode: failure.code,
            attemptCount: attempt,
          },
        };
        return;
      }
    }

    // Loop completed without ready — should only happen if maxAttempts exhausted.
    yield {
      type: 'error',
      message: `mcp setup exhausted (attempts_exhausted): ${previousFailure?.code ?? 'unknown'} after ${maxAttempts} attempts`,
      meta: {
        mcpSetupCode: 'attempts_exhausted',
        readinessCode: previousFailure?.code ?? 'attempts_exhausted',
        attemptCount: maxAttempts,
      },
    };
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
