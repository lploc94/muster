import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createInterface, Interface } from 'readline';
import { McpServerConfig } from '../types';
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

let permissionController: PermissionController | null = null;

/** Inject (or clear) the global permission controller for the ACP gate. */
export function setPermissionController(controller: PermissionController | null): void {
  permissionController = controller;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type SessionUpdate = Record<string, unknown>;

export interface PromptResult {
  stopReason?: string;
  /** Some ACP agents (e.g. codex-acp) return usage on the prompt result. */
  usage?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

type SessionSink = (update: SessionUpdate) => void;
type ConnectionSink = (line: string, source: 'stderr' | 'non-json') => void;

/** Shape of the ACP `initialize` response fields the client relies on. */
export interface AcpInitializeResult {
  authMethods?: { id: string }[];
  agentCapabilities?: { loadSession?: boolean };
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
};

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

/** Dispose every shared ACP client (called on extension deactivate). */
export function disposeSharedAcpClient(): void {
  for (const client of sharedClients.values()) {
    client.dispose();
  }
  sharedClients.clear();
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

  async newSession(cwd: string, mcpServers: McpServerConfig[]): Promise<{ sessionId: string }> {
    await this.ensureConnected();
    const res = (await this.request('session/new', { cwd, mcpServers })) as { sessionId: string };
    return { sessionId: res.sessionId };
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

  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    await this.ensureConnected();
    return (await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })) as PromptResult;
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
    this.rl?.close();
    this.rl = undefined;
    try {
      proc?.kill();
    } catch {
      // already gone
    }
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
    const id = this.nextId++;
    const timeout = timeoutMs ?? (method === 'session/prompt' ? 1_800_000 : 120_000);

    return new Promise((resolve, reject) => {
      const entry: Pending = {
        resolve,
        reject,
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
    this.writeLine({ jsonrpc: '2.0', id, result });
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
        const sinks = this.sessionSinks.get(sessionId);
        if (sinks) {
          for (const sink of sinks) sink(update);
        }
      }
      return;
    }

    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id as number);
      if (p) {
        this.pending.delete(msg.id as number);
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) {
          const err = msg.error as { message?: string };
          p.reject(new Error(err.message ?? JSON.stringify(msg.error)));
        } else {
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

    try {
      if (method === 'session/request_permission') {
        await this.handlePermissionRequest(id, params);
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
