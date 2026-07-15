import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createInterface, Interface } from 'readline';
import { McpServerConfig } from '../types';
import type {
  AgentQuestion,
  ElicitationAction,
  ParsedFormElicitation,
  ParsedUrlElicitation,
  QuestionAnswers,
} from './elicitation';
import {
  answersNonEmpty,
  encodeElicitationContentFromQuestions,
  encodeGrokAnswers,
  formToAgentQuestions,
  isAskLikeForm,
  normalizeAgentQuestions,
  parseElicitationCreate,
  parseUrlElicitationRequiredEntries,
  URL_ELICITATION_REQUIRED_CODE,
} from './elicitation';
import {
  classifyPermission,
  pickOption,
  resolvePolicy,
  type PermissionAuditEntry,
  type PermissionAuditSource,
  type PermissionClass,
  type PermissionMode,
  type PermissionOption,
  type PermissionToolCall,
} from './permission-policy';

export type { AgentQuestion, QuestionAnswers } from './elicitation';
export {
  encodeElicitationContentFromQuestions as encodeElicitationContent,
  encodeGrokAnswers,
  formToAgentQuestions,
  isAskLikeForm,
  normalizeAgentQuestions,
  parseElicitationCreate,
} from './elicitation';

/**
 * A permission request handed to {@link PermissionController.prompt} when the
 * gate needs an explicit user decision.
 */
export interface PermissionPromptRequest {
  sessionId: string;
  title: string;
  kind: string;
  classification: PermissionClass;
  options: PermissionOption[];
}

/**
 * Host-side controller consulted by the ACP permission gate. Injected via
 * {@link setPermissionController}. When absent, the client keeps its legacy
 * blind auto-allow behavior (backward compatible).
 */
export interface PermissionController {
  /** Current mode, read live so config changes take effect immediately. */
  mode(): PermissionMode;
  isAllowlisted(sessionId: string, key: string): boolean;
  remember(sessionId: string, key: string): void;
  audit(entry: PermissionAuditEntry): void;
  /** Prompt the user for a decision (write/unknown actions in ask mode). */
  prompt(
    req: PermissionPromptRequest,
  ): Promise<{ allow: boolean; remember: boolean; timedOut?: boolean }>;
}

export interface QuestionPromptRequest {
  sessionId: string;
  questions: AgentQuestion[];
}

export interface QuestionPromptResult {
  outcome: 'accepted' | 'cancelled' | 'declined';
  answers?: QuestionAnswers;
}

/** Host controller for Grok vendor ask_user_question (AskCard). */
export interface QuestionController {
  prompt(req: QuestionPromptRequest): Promise<QuestionPromptResult>;
}

/** Host controller for full RFD elicitation form/url. */
export interface ElicitationController {
  /** Prefer per-call clientKey from ACP agent config when provided. */
  clientKey: string;
  promptForm(
    form: ParsedFormElicitation,
    clientKey?: string,
  ): Promise<{ action: ElicitationAction; content?: Record<string, unknown> }>;
  promptUrl(
    url: ParsedUrlElicitation,
    clientKey?: string,
  ): Promise<{ action: ElicitationAction }>;
  onUrlComplete(clientKey: string, elicitationId: string): void;
}

let permissionController: PermissionController | null = null;
let questionController: QuestionController | null = null;
let elicitationController: ElicitationController | null = null;
let acpDebugLogger: ((event: string, details: Record<string, unknown>) => void) | null = null;

/** Inject a host-owned diagnostic sink without coupling the ACP transport to VS Code. */
export function setAcpDebugLogger(
  logger: ((event: string, details: Record<string, unknown>) => void) | null,
): void {
  acpDebugLogger = logger;
}

function debugAcp(event: string, details: Record<string, unknown>): void {
  try {
    acpDebugLogger?.(event, details);
  } catch {
    // Diagnostics must never affect protocol handling.
  }
}

/** Inject (or clear) the global permission controller for the ACP gate. */
export function setPermissionController(controller: PermissionController | null): void {
  permissionController = controller;
}

/** Inject (or clear) the global Grok question controller. */
export function setQuestionController(controller: QuestionController | null): void {
  questionController = controller;
}

/** Inject (or clear) the RFD elicitation controller. */
export function setElicitationController(controller: ElicitationController | null): void {
  elicitationController = controller;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  method?: string;
  params?: unknown;
  retried32042?: boolean;
};

export type SessionUpdate = Record<string, unknown>;

export interface PromptResult {
  stopReason?: string;
  /** Some ACP agents (e.g. codex-acp) return usage on the prompt result. */
  usage?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  /**
   * Set by {@link boundedPromptCancel}: `forced` when the grace timer dropped the
   * pending request; omit/`confirmed` when the agent settled the prompt itself.
   * Engine uses this for interrupt-and-send session bind / promote gates.
   */
  cancelConfidence?: 'confirmed' | 'forced';
}

type SessionSink = (update: SessionUpdate) => void;
type ConnectionSink = (line: string, source: 'stderr' | 'non-json') => void;

/**
 * Shape of the ACP `initialize` response fields the client relies on.
 */
export interface AcpInitializeResult {
  authMethods?: { id: string }[];
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    sessionCapabilities?: {
      [key: string]: unknown;
    };
    _meta?: {
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}


/** Auth choice returned by a backend's {@link AcpAgentConfig.resolveAuth}. */
export interface AcpAuthChoice {
  methodId: string;
  meta?: Record<string, unknown>;
}

/**
 * Backend-specific configuration for a shared ACP agent connection.
 * The client itself is backend-agnostic; everything CLI-specific
 * (spawn command, auth strategy, extension handling, labels) lives here.
 */
export interface AcpAgentConfig {
  /** Stable key used to deduplicate shared clients (usually the backend name). */
  key: string;
  /** Human-readable label used in error messages, e.g. 'Grok', 'Kiro'. */
  label: string;
  /** Executable to spawn. */
  command: string;
  /** Arguments for the ACP stdio agent, e.g. ['agent', 'stdio'] or ['acp']. */
  args: string[];
  /**
   * Extra environment variables merged into the spawned agent's env
   * (below process.env, overridable by RunOptions.extraEnv).
   */
  env?: Record<string, string>;
  /** Client capabilities advertised on `initialize` (defaults to fs/terminal off). */
  clientCapabilities?: Record<string, unknown>;
  /**
   * Decide how to authenticate given the `initialize` result and env.
   * Return `null`/`undefined` to skip the `authenticate` step entirely
   * (e.g. agents that use cached login credentials transparently).
   * Throw to fail the connection with a helpful, user-facing message.
   */
  resolveAuth?: (
    init: AcpInitializeResult,
    env: NodeJS.ProcessEnv,
  ) => AcpAuthChoice | null | undefined;
  /**
   * Optional handler for backend-specific server→client requests (ACP
   * extensions). Return `{ result }` to answer the request; return
   * `undefined` to fall through to the default acknowledgement.
   */
  extensionRequestHandler?: (
    method: string,
    params: Record<string, unknown>,
  ) => { result?: unknown } | undefined;
}

const DEFAULT_CLIENT_CAPABILITIES: Record<string, unknown> = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  // RFD elicitation — form + url (Claude AskUserQuestion, OAuth consent, …).
  elicitation: { form: {}, url: {} },
};

/**
 * Grace period after a cooperative `session/cancel` before we force-settle a
 * pending `session/prompt`. Bounds a hung turn to ~this instead of the
 * 30-minute request timeout when an agent ignores cancellation.
 */
export const CANCEL_GRACE_MS = 10_000;

/**
 * Grace period after SIGTERM before escalating to SIGKILL during process-tree
 * teardown, giving the agent (and its grandchild CLI) a chance to exit cleanly.
 */
export const KILL_ESCALATION_MS = 2_000;

/** Minimal ChildProcess surface the kill helpers need (test-injectable). */
export interface KillableProcess {
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** {@link KillableProcess} plus the `exit` hook used to cancel escalation. */
export interface SupervisableProcess extends KillableProcess {
  once(event: 'exit', listener: () => void): unknown;
}

/**
 * Signal an entire process tree cross-platform. On POSIX we signal the child's
 * process GROUP (`-pid`) so the spawned Node adapter AND the real CLI binary it
 * spawned are reaped together; the child must have been spawned `detached` to be
 * a group leader. On Windows (no POSIX groups) — or if the group signal fails
 * with EPERM/ESRCH — we fall back to signalling the child directly. Never
 * throws. Guards against an unstarted (`pid == null`) or already-exited process.
 */
export function killProcessTree(
  proc: KillableProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  processKill: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) => {
    process.kill(pid, sig);
  },
): void {
  const pid = proc.pid;
  if (pid == null || proc.exitCode !== null) return;

  if (platform === 'win32') {
    try {
      proc.kill(signal);
    } catch {
      // already gone
    }
    return;
  }

  try {
    // Negative pid targets the whole process group (the detached leader and all
    // descendants), reaping grandchild CLI processes the adapter spawned.
    processKill(-pid, signal);
  } catch {
    // EPERM/ESRCH: the group is gone or the child was not a group leader —
    // fall back to signalling the child process directly.
    try {
      proc.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Best-effort process-tree teardown with SIGTERM→SIGKILL escalation. Sends
 * SIGTERM to the group, then if the process is still alive after `escalationMs`
 * sends SIGKILL to the group. The escalation timer is cleared on the process
 * `exit` and is `.unref()`ed so it never keeps the host alive. Never throws.
 */
export function terminateProcessTree(
  proc: SupervisableProcess,
  escalationMs: number = KILL_ESCALATION_MS,
  kill: (p: KillableProcess, signal: NodeJS.Signals) => void = killProcessTree,
): void {
  try {
    if (proc.pid == null || proc.exitCode !== null) return;
    kill(proc, 'SIGTERM');

    const timer = setTimeout(() => {
      // Still running after the grace — force-kill the whole tree.
      if (proc.exitCode === null) kill(proc, 'SIGKILL');
    }, escalationMs);
    if (typeof timer.unref === 'function') timer.unref();

    proc.once('exit', () => clearTimeout(timer));
  } catch {
    // Teardown must never throw.
  }
}

/**
 * Bounded cancellation wrapper around a pending `session/prompt` promise. When
 * `signal` aborts, invoke `onCancel` (send the ACP `session/cancel`
 * notification) and start a grace timer; if `pending` has not settled within
 * `graceMs`, call `onForceSettle` (drop the pending request so its long timeout
 * does not leak) and RESOLVE with a cancelled {@link PromptResult}. That lets
 * the adapter run loop emit a cancellation terminal so the engine's `for await`
 * unblocks in ~grace instead of the 30-minute request timeout. The grace timer
 * and abort listener are always cleaned up on settle.
 *
 * SCOPE: this never kills the shared agent process. {@link AcpClient} is a
 * singleton shared across sessions, so terminating it on a per-turn cancel would
 * abort concurrent sessions (cross-session blast radius). Force-terminating a
 * genuinely hung agent process is coupled to per-session process isolation — a
 * deliberate future follow-up. Exported for unit testing.
 */
export function boundedPromptCancel(
  pending: Promise<PromptResult>,
  signal: AbortSignal | undefined,
  hooks: { onCancel: () => void; onForceSettle: () => void },
  graceMs: number = CANCEL_GRACE_MS,
): Promise<PromptResult> {
  if (!signal) return pending;

  return new Promise<PromptResult>((resolve, reject) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      // Cooperative cancel first (existing ACP notification).
      hooks.onCancel();
      // Bound the wait: force-settle if the agent ignores cancel.
      graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        hooks.onForceSettle();
        resolve({ stopReason: 'cancelled', cancelConfidence: 'forced' });
      }, graceMs);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
    };

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort);

    pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

const sharedClients = new Map<string, AcpClient>();

/** Get (or lazily create) the shared ACP client for a backend config. */
export function getSharedAcpClient(config: AcpAgentConfig): AcpClient {
  let client = sharedClients.get(config.key);
  if (!client) {
    client = new AcpClient(config);
    sharedClients.set(config.key, client);
  }
  return client;
}

/**
 * Return an already-constructed shared client for this backend key, or undefined.
 * Never spawns a connection — for read-only queries such as advertised commands.
 */
export function peekSharedAcpClient(key: string): AcpClient | undefined {
  return sharedClients.get(key);
}

/**
 * Defensively extract command/skill names from an ACP `available_commands_update`.
 * The notification field is `commands`; each item is `{ name, description?, input? }`
 * per the ACP spec, though some agents may send bare strings. A non-object update,
 * a missing/non-array field, or unrecognized items yield [] (recorded as a
 * KNOWN-but-empty advertisement). Never throws on arbitrary `unknown` input.
 */
export function extractCommandNames(update: unknown): string[] {
  if (!update || typeof update !== 'object') return [];
  const cmds = (update as { commands?: unknown }).commands;
  if (!Array.isArray(cmds)) return [];
  const out: string[] = [];
  for (const c of cmds) {
    const name =
      typeof c === 'string'
        ? c
        : c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string'
          ? (c as { name: string }).name
          : undefined;
    if (name) out.push(name);
  }
  return out;
}

/** Dispose every shared ACP client (called on extension deactivate). */
export function disposeSharedAcpClient(): void {
  for (const client of sharedClients.values()) {
    client.dispose();
  }
  sharedClients.clear();
}

/** One selectable value of an ACP `select` config option. */
export interface AcpConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
}

/**
 * How the client applies a model selection for this agent:
 * - `config_option` — Claude/Codex/OpenCode style: `session/set_config_option`
 * - `session_set_model` — Grok/Kiro style: `session/set_model` with `{ modelId }`
 */
export type AcpModelApplyVia = 'config_option' | 'session_set_model';

/** The model config advertised by an agent in the `session/new` response. */
export interface AcpModelConfig {
  /**
   * Config option id for `session/set_config_option` (usually `"model"`).
   * Unused when `applyVia === 'session_set_model'`.
   */
  id: string;
  applyVia?: AcpModelApplyVia;
  currentValue?: string;
  options: AcpConfigOptionChoice[];
}

/** Pull the `category: 'model'` config option out of a `session/new` configOptions array. */
export function extractModelConfigFromOptions(configOptions: unknown): AcpModelConfig | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const opt of configOptions) {
    if (!opt || typeof opt !== 'object') continue;
    const o = opt as Record<string, unknown>;
    if (o.category !== 'model' || typeof o.id !== 'string' || !Array.isArray(o.options)) continue;
    const choices: AcpConfigOptionChoice[] = [];
    for (const choice of o.options as unknown[]) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      if (typeof c.value === 'string' && typeof c.name === 'string') {
        choices.push({
          value: c.value,
          name: c.name,
          description: typeof c.description === 'string' ? c.description : undefined,
        });
      }
    }
    if (choices.length > 0) {
      return {
        id: o.id,
        applyVia: 'config_option',
        currentValue: typeof o.currentValue === 'string' ? o.currentValue : undefined,
        options: choices,
      };
    }
  }
  return undefined;
}

/**
 * Grok / Kiro (and other agents) advertise models as:
 * `{ currentModelId, availableModels: [{ modelId, name, description? }] }`
 * on `session/new` (or initialize `_meta.modelState`) — not as configOptions.
 */
export function extractModelConfigFromSessionModels(models: unknown): AcpModelConfig | undefined {
  if (!models || typeof models !== 'object') return undefined;
  const m = models as Record<string, unknown>;
  const available = m.availableModels;
  if (!Array.isArray(available)) return undefined;

  const choices: AcpConfigOptionChoice[] = [];
  for (const item of available) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const value =
      typeof o.modelId === 'string'
        ? o.modelId
        : typeof o.id === 'string'
          ? o.id
          : typeof o.value === 'string'
            ? o.value
            : undefined;
    if (!value) continue;
    const name = typeof o.name === 'string' && o.name ? o.name : value;
    choices.push({
      value,
      name,
      description: typeof o.description === 'string' ? o.description : undefined,
    });
  }
  if (choices.length === 0) return undefined;

  return {
    id: 'model',
    applyVia: 'session_set_model',
    currentValue: typeof m.currentModelId === 'string' ? m.currentModelId : undefined,
    options: choices,
  };
}

/**
 * Prefer configOptions (Claude/Codex/OpenCode); fall back to session.models (Grok/Kiro).
 * @deprecated Prefer the two extractors above; kept as the combined entry point.
 */
export function extractModelConfig(configOptions: unknown, sessionModels?: unknown): AcpModelConfig | undefined {
  return (
    extractModelConfigFromOptions(configOptions) ?? extractModelConfigFromSessionModels(sessionModels)
  );
}

export class AcpClient {
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionSinks = new Map<string, Set<SessionSink>>();
  private connectionSinks = new Set<ConnectionSink>();
  private connectPromise?: Promise<void>;
  private extraEnv?: Record<string, string>;
  private authenticated = false;
  loadSessionSupported = false;
  /**
   * Agent-advertised command/skill names (ACP available_commands_update).
   * Tri-state: undefined = the backend has NEVER advertised (UNKNOWN); a Set
   * (even empty) = the list has been received at least once (KNOWN) and is the
   * fail-closed source of truth for first-turn skill injection.
   */
  private advertisedCommands: Set<string> | undefined = undefined;

  constructor(private readonly config: AcpAgentConfig) {}

  registerSessionSink(sessionId: string, sink: SessionSink): () => void {
    let sinks = this.sessionSinks.get(sessionId);
    if (!sinks) {
      sinks = new Set();
      this.sessionSinks.set(sessionId, sinks);
    }
    sinks.add(sink);
    return () => {
      sinks!.delete(sink);
      if (sinks!.size === 0) this.sessionSinks.delete(sessionId);
    };
  }

  registerConnectionSink(sink: ConnectionSink): () => void {
    this.connectionSinks.add(sink);
    return () => {
      this.connectionSinks.delete(sink);
    };
  }

  async ensureConnected(extraEnv?: Record<string, string>): Promise<void> {
    if (extraEnv) this.extraEnv = extraEnv;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.startAndHandshake().catch((err) => {
      this.connectPromise = undefined;
      this.teardownProcess();
      throw err;
    });
    return this.connectPromise;
  }

  async newSession(
    cwd: string,
    mcpServers: McpServerConfig[],
  ): Promise<{ sessionId: string; modelConfig?: AcpModelConfig }> {
    await this.ensureConnected();
    const res = (await this.request('session/new', { cwd, mcpServers })) as {
      sessionId: string;
      configOptions?: unknown;
      models?: unknown;
    };
    return {
      sessionId: res.sessionId,
      modelConfig: extractModelConfig(res.configOptions, res.models),
    };
  }

  /** Set a session config option (e.g. the model) via ACP `session/set_config_option`. */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.ensureConnected();
    await this.request('session/set_config_option', { sessionId, configId, value });
  }

  /**
   * Select a model for agents that advertise `session.models` (Grok/Kiro) via
   * the legacy/stable `session/set_model` method (`{ sessionId, modelId }`).
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureConnected();
    await this.request('session/set_model', { sessionId, modelId });
  }

  /** Best-effort `session/close` — used to release a transient enumeration session. */
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.request('session/close', { sessionId });
    } catch {
      // Not all agents support session/close; leaving the session is harmless.
    }
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServerConfig[],
  ): Promise<{ sessionId: string }> {
    await this.ensureConnected();
    if (!this.loadSessionSupported) {
      throw new Error(`${this.config.label} agent does not support session/load`);
    }
    await this.request('session/load', { sessionId, cwd, mcpServers });
    return { sessionId };
  }

  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<PromptResult> {
    await this.ensureConnected();
    // Keep the request id so bounded cancellation can drop the pending entry
    // (and clear its 30-minute timeout) when force-settling a hung turn.
    const { id, promise } = this.sendRequest('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    return boundedPromptCancel(promise as Promise<PromptResult>, signal, {
      onCancel: () => this.cancel(sessionId),
      onForceSettle: () => this.dropPending(id),
    });
  }

  /**
   * Record the agent-advertised command/skill names (ACP
   * available_commands_update). Replaces the known set — the agent re-advertises
   * the full list on each update. An empty list records a KNOWN-but-empty set.
   */
  recordAdvertisedCommands(names: readonly string[]): void {
    this.advertisedCommands = new Set(names);
  }

  /**
   * Known advertised command names, or undefined when the backend has never
   * advertised (UNKNOWN → first-turn skill injection stays optimistic).
   */
  getAdvertisedCommands(): ReadonlySet<string> | undefined {
    return this.advertisedCommands;
  }

  cancel(sessionId: string): void {
    // ACP defines session/cancel as a notification (no id).
    this.notify('session/cancel', { sessionId });
  }


  dispose(): void {
    this.teardownProcess();
    this.connectPromise = undefined;
    this.rejectAllPending(new Error(`${this.config.label} ACP client disposed`));
    this.sessionSinks.clear();
    this.connectionSinks.clear();
  }

  private mergedEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.config.env, ...this.extraEnv };
  }

  private emitConnectionLine(line: string, source: 'stderr' | 'non-json'): void {
    for (const sink of this.connectionSinks) {
      sink(line, source);
    }
  }

  private teardownProcess(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.authenticated = false;
    // Drop advertised commands with the process: a fresh connection re-advertises,
    // so the cache must not survive teardown (stale → wrong fail-closed decisions).
    this.advertisedCommands = undefined;
    this.rl?.close();
    this.rl = undefined;
    // Group SIGTERM now, escalate to group SIGKILL if the tree is still alive
    // after the grace — reaps the adapter's grandchild CLI, not just the child.
    if (proc) terminateProcessTree(proc);
  }

  private async startAndHandshake(): Promise<void> {
    if (this.authenticated && this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      return;
    }

    this.teardownProcess();

    const env = this.mergedEnv();
    const proc = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      // Become a process-group leader (POSIX) so teardown can signal the whole
      // tree — the spawned Node adapter itself spawns the real CLI binary, and a
      // bare SIGTERM to the adapter would orphan those grandchildren. We keep the
      // stdio pipes and deliberately do NOT unref(): the process stays tracked.
      detached: true,
    });
    this.proc = proc;

    this.rl = createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => this.onLine(line));

    proc.stdin.on('error', () => {
      // Swallow EPIPE after exit — writeLine handles the synchronous path.
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) this.emitConnectionLine(line, 'stderr');
      }
    });

    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.authenticated = false;
      // Stale advertisements must not outlive the process (see teardownProcess).
      this.advertisedCommands = undefined;
      this.connectPromise = undefined;
      this.rejectAllPending(new Error(`${this.config.label} agent exited (code ${code})`));
    });

    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.connectPromise = undefined;
      this.rejectAllPending(err);
    });

    try {
      const init = (await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: this.config.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
      })) as AcpInitializeResult;

      this.loadSessionSupported = !!init.agentCapabilities?.loadSession;

      if (this.config.resolveAuth) {
        const choice = this.config.resolveAuth(init, env);
        if (choice) {
          await this.request('authenticate', {
            methodId: choice.methodId,
            _meta: choice.meta ?? {},
          });
        }
      }
      this.authenticated = true;
    } catch (err) {
      this.teardownProcess();
      throw err;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return this.sendRequest(method, params, timeoutMs).promise;
  }

  /**
   * Like {@link request} but also exposes the JSON-RPC id so callers can drop
   * the pending entry early — e.g. bounded cancellation force-settling a hung
   * `session/prompt` instead of waiting out its long timeout.
   */
  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs?: number,
    opts?: { retried32042?: boolean },
  ): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    const timeout = timeoutMs ?? (method === 'session/prompt' ? 1_800_000 : 120_000);

    const promise = new Promise((resolve, reject) => {
      const entry: Pending = {
        resolve,
        reject,
        method,
        params,
        retried32042: opts?.retried32042 === true,
      };
      this.pending.set(id, entry);

      if (!this.writeLine({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id);
        reject(new Error(`${this.config.label} agent is not running (${method})`));
        return;
      }

      entry.timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`ACP request timed out: ${method}`));
        }
      }, timeout);
    });
    return { id, promise };
  }

  /** Drop a still-pending request and clear its timeout (used by bounded cancel). */
  private dropPending(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
  }

  private notify(method: string, params: unknown): void {
    this.writeLine({ jsonrpc: '2.0', method, params });
  }

  private writeLine(obj: unknown): boolean {
    const proc = this.proc;
    if (!proc || proc.killed || !proc.stdin.writable) return false;
    try {
      proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  private respondOk(id: number | string, result: unknown = {}): void {
    const wrote = this.writeLine({ jsonrpc: '2.0', id, result });
    const summary = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    debugAcp('response.ok', {
      backend: this.config.key,
      id,
      action: summary.action,
      outcome: summary.outcome,
      contentKeys:
        summary.content && typeof summary.content === 'object'
          ? Object.keys(summary.content as Record<string, unknown>)
          : undefined,
      answerKeys:
        summary.answers && typeof summary.answers === 'object'
          ? Object.keys(summary.answers as Record<string, unknown>)
          : undefined,
      wrote,
      stdinWritable: this.proc?.stdin.writable ?? false,
    });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.writeLine({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emitConnectionLine(line, 'non-json');
      return;
    }

    if (msg.method === 'session/update') {
      const params = msg.params as { sessionId?: string; update?: SessionUpdate } | undefined;
      const sessionId = params?.sessionId;
      const update = params?.update;
      if (sessionId && update) {
        // Advertised command/skill lists are backend-scoped and can arrive right
        // after session/new — BEFORE any session sink is registered (see
        // runAcpTurn). Record here at the source so the set is never lost to
        // sink-registration timing; the sink path still drops it (no event).
        if ((update as { sessionUpdate?: unknown }).sessionUpdate === 'available_commands_update') {
          this.recordAdvertisedCommands(extractCommandNames(update));
        }
        const sinks = this.sessionSinks.get(sessionId);
        if (sinks) {
          for (const sink of sinks) sink(update);
        }
      }
      return;
    }

    // RFD elicitation/complete — notification (no id) after URL-mode OOB interaction.
    if (msg.method === 'elicitation/complete' && msg.id == null) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const elicitationId =
        typeof params.elicitationId === 'string' ? params.elicitationId : '';
      if (elicitationId && elicitationController) {
        // Prefer this connection's agent key; controller still receives clientKey arg.
        elicitationController.onUrlComplete(this.config.key, elicitationId);
      }
      return;
    }

    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id as number);
      if (p) {
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) {
          const err = msg.error as { code?: number; message?: string; data?: unknown };
          // RFD -32042 URLElicitationRequiredError: prompt URL consent, then retry once.
          if (
            err.code === URL_ELICITATION_REQUIRED_CODE &&
            !p.retried32042 &&
            elicitationController
          ) {
            const parsed = parseUrlElicitationRequiredEntries(err.data);
            if (parsed.ok) {
              this.pending.delete(msg.id as number);
              void this.handleUrlElicitationRequired(msg.id as number, p, parsed.entries);
              return;
            }
          }
          this.pending.delete(msg.id as number);
          p.reject(new Error(err.message ?? JSON.stringify(msg.error)));
        } else {
          this.pending.delete(msg.id as number);
          p.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method && msg.id != null) {
      void this.handleServerRequest(msg);
    }
  }

  private async handleServerRequest(msg: Record<string, unknown>): Promise<void> {
    const method = msg.method as string;
    const id = msg.id as number | string;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (
      method === 'elicitation/create' ||
      method === 'x.ai/ask_user_question' ||
      method === '_x.ai/ask_user_question'
    ) {
      debugAcp('request.received', {
        backend: this.config.key,
        method,
        id,
        sessionId: params.sessionId,
        questionCount: Array.isArray(params.questions) ? params.questions.length : undefined,
        mode: params.mode,
      });
    }

    try {
      if (method === 'session/request_permission') {
        await this.handlePermissionRequest(id, params);
        return;
      }

      // RFD elicitation (shared path for Claude AskUserQuestion, Codex MCP forms, …)
      if (method === 'elicitation/create') {
        await this.handleElicitationCreate(id, params);
        return;
      }

      // Vendor extension: Grok native ask_user_question
      if (method === 'x.ai/ask_user_question' || method === '_x.ai/ask_user_question') {
        await this.handleGrokAskUserQuestion(id, params);
        return;
      }

      if (method.startsWith('fs/') || method.startsWith('terminal/')) {
        this.respondError(id, -32601, 'Client capability not supported');
        return;
      }

      if (this.config.extensionRequestHandler) {
        const handled = this.config.extensionRequestHandler(method, params);
        if (handled) {
          this.respondOk(id, handled.result ?? {});
          return;
        }
      }

      // Unknown server request — ack so the agent does not hang.
      this.respondOk(id, {});
    } catch (err) {
      this.respondError(id, -32603, (err as Error).message || 'Internal error');
    }
  }

  /**
   * After -32042: run URL consent for each entry; on all accept+complete, retry
   * the original request once. Decline/cancel rejects the parent.
   */
  private async handleUrlElicitationRequired(
    _originalId: number,
    parent: Pending,
    entries: import('./elicitation').ParsedUrlRequiredEntry[],
  ): Promise<void> {
    const controller = elicitationController;
    if (!controller || !parent.method) {
      parent.reject(new Error('URL elicitation required but controller unavailable'));
      return;
    }
    const clientKey = this.config.key;
    try {
      for (const entry of entries) {
        const action = await controller.promptUrl(
          {
            kind: 'url',
            elicitationId: entry.elicitationId,
            url: entry.url,
            message: entry.message,
          },
          clientKey,
        );
        if (action.action !== 'accept') {
          parent.reject(new Error('URL elicitation declined or cancelled'));
          return;
        }
        // Accept only records consent; wait briefly for optional complete notif.
        // Minimal: proceed after accept (OOB may complete async). Full wait can
        // be tightened later via bridge promise on OOB complete.
      }
      // Single retry with retried32042=true so a second -32042 fails closed.
      const { promise } = this.sendRequest(parent.method, parent.params, undefined, {
        retried32042: true,
      });
      parent.resolve(await promise);
    } catch (err) {
      parent.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** ACP RFD elicitation/create — form or url. */
  private async handleElicitationCreate(
    id: number | string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const parsed = parseElicitationCreate(params);
    if (parsed.kind === 'error') {
      debugAcp('elicitation.parse_error', { backend: this.config.key, id, message: parsed.message });
      this.respondError(id, parsed.code, parsed.message);
      return;
    }
    const controller = elicitationController;
    if (!controller) {
      this.respondOk(id, { action: 'cancel' });
      return;
    }
    const clientKey = this.config.key;
    debugAcp('elicitation.prompt_start', {
      backend: this.config.key,
      id,
      kind: parsed.kind,
      sessionId: parsed.sessionId,
      fieldKeys: parsed.kind === 'form' ? parsed.fields.map((field) => field.key) : undefined,
    });
    if (parsed.kind === 'url') {
      const result = await controller.promptUrl(parsed, clientKey);
      this.respondOk(id, { action: result.action });
      return;
    }
    const result = await controller.promptForm(parsed, clientKey);
    debugAcp('elicitation.prompt_resolved', {
      backend: this.config.key,
      id,
      action: result.action,
      contentKeys: result.content ? Object.keys(result.content) : [],
    });
    if (result.action === 'accept') {
      this.respondOk(id, { action: 'accept', content: result.content ?? {} });
      return;
    }
    this.respondOk(id, { action: result.action });
  }

  /** Grok `x.ai/ask_user_question` — vendor extension → AskCard. */
  private async handleGrokAskUserQuestion(
    id: number | string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const questions = normalizeAgentQuestions(params.questions);
    const controller = questionController;
    debugAcp('grok_ask.normalized', {
      backend: this.config.key,
      id,
      sessionId,
      questionCount: questions.length,
    });

    if (!controller || questions.length === 0) {
      this.respondOk(id, { outcome: 'cancelled' });
      return;
    }

    const result = await controller.prompt({ sessionId, questions });
    debugAcp('grok_ask.prompt_resolved', {
      backend: this.config.key,
      id,
      sessionId,
      outcome: result.outcome,
      answeredIndexes: result.answers ? Object.keys(result.answers) : [],
    });
    if (result.outcome === 'accepted' && answersNonEmpty(result.answers, questions.length)) {
      this.respondOk(id, {
        outcome: 'accepted',
        answers: encodeGrokAnswers(questions, result.answers),
        annotations: {},
      });
      return;
    }
    this.respondOk(id, { outcome: 'cancelled' });
  }

  /**
   * Gate an ACP `session/request_permission` through the injected controller.
   * With no controller wired, keeps the legacy blind auto-allow (backward
   * compatible). Otherwise classifies the request, resolves the policy, and
   * either auto-decides or prompts the user — every outcome is audited.
   */
  private async handlePermissionRequest(
    id: number | string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const options = (params.options ?? []) as PermissionOption[];
    const controller = permissionController;

    // Legacy path: no gate installed → auto-allow as before.
    if (!controller) {
      const allow =
        options.find((o) => /allow/i.test(o.kind)) ??
        options.find((o) => o.optionId === 'allow_once') ??
        options[0];
      this.respondOk(id, {
        outcome: { outcome: 'selected', optionId: allow?.optionId ?? 'allow_once' },
      });
      return;
    }

    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const toolCall = params.toolCall as PermissionToolCall | undefined;
    const kind = toolCall?.kind ?? 'other';
    const title = toolCall?.title ?? toolCall?.kind ?? 'tool call';
    const cls = classifyPermission(toolCall, options);
    // Stable per-session allow-list key: kind + title identifies "this action".
    const key = `${kind}:${title}`;

    const emitAudit = (decision: 'allow' | 'deny', source: PermissionAuditSource): void => {
      controller.audit({
        at: new Date().toISOString(),
        sessionId,
        title,
        kind,
        classification: cls,
        decision,
        source,
      });
    };

    const respondAllow = (source: PermissionAuditSource): void => {
      const optionId = pickOption(options, true);
      if (optionId) {
        this.respondOk(id, { outcome: { outcome: 'selected', optionId } });
      } else {
        // No allow option offered — ack so the agent proceeds (legacy fallback).
        this.respondOk(id, {});
      }
      emitAudit('allow', source);
    };

    const respondDeny = (source: PermissionAuditSource): void => {
      const optionId = pickOption(options, false);
      if (optionId) {
        this.respondOk(id, { outcome: { outcome: 'selected', optionId } });
      } else {
        this.respondOk(id, { outcome: { outcome: 'cancelled' } });
      }
      emitAudit('deny', source);
    };

    const mode = controller.mode();
    const allowlisted = controller.isAllowlisted(sessionId, key);
    const { decision } = resolvePolicy(mode, cls, allowlisted);

    if (decision === 'allow') {
      const source: PermissionAuditSource =
        cls === 'read' ? 'read' : mode === 'allow' ? 'mode-allow' : 'allowlist';
      respondAllow(source);
      return;
    }

    if (decision === 'deny') {
      // Only reachable in readonly mode for write/unknown actions.
      respondDeny('mode-readonly');
      return;
    }

    // decision === 'prompt': ask the user (write/unknown in ask mode).
    const result = await controller.prompt({ sessionId, title, kind, classification: cls, options });
    if (result.allow) {
      if (result.remember) controller.remember(sessionId, key);
      respondAllow('user');
    } else {
      respondDeny(result.timedOut ? 'timeout-deny' : 'user');
    }
  }
}
