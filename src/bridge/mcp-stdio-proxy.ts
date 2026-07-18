/**
 * Muster-owned stdio MCP proxy (M017-S05 / PR4).
 *
 * Speaks MCP over stdio to ACP agents and forwards tools/list + tools/call to
 * the extension-owned HTTP Muster bridge. Bearer credentials travel only via
 * env (MUSTER_BRIDGE_URL / MUSTER_BRIDGE_TOKEN) — never argv or diagnostics.
 *
 * Mid-run bridge flaps trigger a single-flight, bounded reconnect series
 * (count + deadline) before the original request is retried once.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  MUSTER_BRIDGE_TOKEN_ENV,
  MUSTER_BRIDGE_URL_ENV,
} from './mcp-config';

export type ProxyPhase = 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed';

export interface ProxyDebugSnapshot {
  phase: ProxyPhase;
  /** Total reconnect attempts across all series. */
  reconnectAttemptCount: number;
  /** Monotonic single-flight reconnect generation (0 = never reconnected). */
  reconnectGeneration: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  bridgeHost?: string;
  bridgePort?: number;
  hasSession: boolean;
}

export interface BridgePostRequest {
  method: string;
  params?: Record<string, unknown>;
  id?: string | number;
  sessionId?: string;
}

export interface BridgePostResult {
  status: number;
  json: unknown;
  sessionId?: string;
}

export type BridgePostFn = (req: BridgePostRequest) => Promise<BridgePostResult>;

export interface MusterStdioMcpProxyOptions {
  bridgeUrl: string;
  token: string;
  /** Injectable HTTP/JSON-RPC post (tests). Defaults to fetch against bridgeUrl. */
  bridgePost?: BridgePostFn;
  /** Injectable fetch for the default bridgePost. */
  fetchImpl?: typeof fetch;
  maxReconnectAttempts?: number;
  reconnectDeadlineMs?: number;
  reconnectBaseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Structured diagnostic sink (defaults to redacted stderr JSON lines). */
  log?: (line: string) => void;
}

export interface ProxyEnvConfig {
  bridgeUrl: string;
  token: string;
}

const DEFAULT_MAX_RECONNECT = 5;
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_BASE_DELAY_MS = 50;
const PROTOCOL_VERSION = '2025-03-26';

export function loadProxyEnvConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ProxyEnvConfig {
  const bridgeUrl = env[MUSTER_BRIDGE_URL_ENV];
  const token = env[MUSTER_BRIDGE_TOKEN_ENV];
  if (!bridgeUrl) {
    throw new Error(`${MUSTER_BRIDGE_URL_ENV} is required`);
  }
  if (!token) {
    throw new Error(`${MUSTER_BRIDGE_TOKEN_ENV} is required`);
  }
  return { bridgeUrl, token };
}

/** Replace secret substrings so diagnostics never echo the bearer token. */
export function redactSecrets(text: string, token: string): string {
  if (!text) return text;
  let out = text;
  if (token) {
    out = out.split(token).join('[REDACTED]');
  }
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  out = out.replace(/Authorization["']?\s*[:=]\s*["']?Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]');
  return out;
}

function parseBridgeHostPort(url: string): { host?: string; port?: number } {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return { host: u.hostname, port };
  } catch {
    return {};
  }
}

function parseMcpBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to SSE */
    }
  }
  const dataLines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return text;
  const last = dataLines[dataLines.length - 1];
  try {
    return JSON.parse(last);
  } catch {
    return last;
  }
}

export function createDefaultBridgePost(
  bridgeUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): BridgePostFn {
  let nextId = 1;
  return async (req) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (req.sessionId) {
      headers['mcp-session-id'] = req.sessionId;
    }
    const id = req.id ?? nextId++;
    const body =
      req.method.startsWith('notifications/')
        ? { jsonrpc: '2.0', method: req.method, params: req.params ?? {} }
        : { jsonrpc: '2.0', id, method: req.method, params: req.params ?? {} };

    const res = await fetchImpl(bridgeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const sessionHeader = res.headers.get('mcp-session-id') ?? undefined;
    const text = await res.text();
    return {
      status: res.status,
      json: parseMcpBody(text),
      sessionId: sessionHeader ?? req.sessionId,
    };
  };
}

/** Test helper: adapt FakeMcpBridge.handle to BridgePostFn. */
export function createBridgePostFromFake(bridge: {
  handle: (
    request: { jsonrpc?: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> },
    opts?: { sessionId?: string; authorization?: string },
  ) => Promise<{ status: number; json: unknown; sessionId?: string }>;
}): BridgePostFn {
  let nextId = 1;
  return async (req) => {
    const id = req.id ?? nextId++;
    return bridge.handle(
      {
        jsonrpc: '2.0',
        id: req.method.startsWith('notifications/') ? null : id,
        method: req.method,
        params: req.params,
      },
      { sessionId: req.sessionId },
    );
  };
}

function isJsonRpcError(json: unknown): json is { error: { code: number; message: string } } {
  return (
    !!json &&
    typeof json === 'object' &&
    'error' in json &&
    !!(json as { error?: unknown }).error
  );
}

function isTransientUpstreamError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object') {
    const e = err as { code?: string; message?: string; name?: string; status?: number };
    if (e.status === 401 || e.status === 404 || e.status === 503 || e.status === 502) return true;
    const code = (e.code ?? '').toUpperCase();
    if (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'EPIPE' ||
      code === 'ENOTFOUND' ||
      code === 'UND_ERR_SOCKET' ||
      code === 'ECONNABORTED'
    ) {
      return true;
    }
    const msg = (e.message ?? '').toLowerCase();
    if (
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('socket hang up') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('aborted') ||
      msg.includes('session')
    ) {
      return true;
    }
  }
  return false;
}

export class MusterStdioMcpProxy {
  private readonly bridgeUrl: string;
  private readonly token: string;
  private readonly bridgePost: BridgePostFn;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDeadlineMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logLine: (line: string) => void;

  private phase: ProxyPhase = 'connecting';
  private sessionId: string | undefined;
  private reconnectAttemptCount = 0;
  private reconnectGeneration = 0;
  private lastErrorCode?: string;
  private lastErrorMessage?: string;
  private reconnectInFlight: Promise<void> | null = null;
  private stdioServer: Server | undefined;
  private closed = false;
  private rpcId = 1;

  constructor(options: MusterStdioMcpProxyOptions) {
    this.bridgeUrl = options.bridgeUrl;
    this.token = options.token;
    this.bridgePost =
      options.bridgePost ??
      createDefaultBridgePost(options.bridgeUrl, options.token, options.fetchImpl ?? fetch);
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT;
    this.reconnectDeadlineMs = options.reconnectDeadlineMs ?? DEFAULT_DEADLINE_MS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logLine =
      options.log ??
      ((line) => {
        // Never write secrets to stderr.
        process.stderr.write(`${line}\n`);
      });
  }

  getDebugSnapshot(): ProxyDebugSnapshot {
    const { host, port } = parseBridgeHostPort(this.bridgeUrl);
    return {
      phase: this.phase,
      reconnectAttemptCount: this.reconnectAttemptCount,
      reconnectGeneration: this.reconnectGeneration,
      lastErrorCode: this.lastErrorCode,
      lastErrorMessage: this.lastErrorMessage,
      bridgeHost: host,
      bridgePort: port,
      hasSession: Boolean(this.sessionId),
    };
  }

  private diagnose(event: string, extra: Record<string, unknown> = {}): void {
    const snap = this.getDebugSnapshot();
    const payload = {
      event,
      phase: snap.phase,
      reconnectAttemptCount: snap.reconnectAttemptCount,
      reconnectGeneration: snap.reconnectGeneration,
      lastErrorCode: snap.lastErrorCode,
      lastErrorMessage: snap.lastErrorMessage,
      bridgeHost: snap.bridgeHost,
      bridgePort: snap.bridgePort,
      hasSession: snap.hasSession,
      ...extra,
    };
    const line = redactSecrets(JSON.stringify(payload), this.token);
    this.logLine(line);
  }

  private recordError(err: unknown): void {
    const e = err as { code?: string; message?: string; name?: string; status?: number };
    this.lastErrorCode = e.code ?? (e.status != null ? `http_${e.status}` : e.name) ?? 'error';
    this.lastErrorMessage = redactSecrets(e.message ?? String(err), this.token);
  }

  private async rawPost(method: string, params?: Record<string, unknown>): Promise<BridgePostResult> {
    const result = await this.bridgePost({
      method,
      params,
      id: this.rpcId++,
      sessionId: this.sessionId,
    });
    if (result.sessionId) {
      this.sessionId = result.sessionId;
    }
    return result;
  }

  private async initializeUpstream(): Promise<void> {
    this.sessionId = undefined;
    const init = await this.rawPost('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'muster-stdio-proxy', version: '0.1.0' },
    });
    if (init.status >= 400 || isJsonRpcError(init.json)) {
      const msg = isJsonRpcError(init.json)
        ? init.json.error.message
        : `HTTP ${init.status}`;
      const err = Object.assign(new Error(`upstream initialize failed: ${msg}`), {
        status: init.status,
        code: isJsonRpcError(init.json) ? `rpc_${init.json.error.code}` : `http_${init.status}`,
      });
      throw err;
    }
    if (init.sessionId) {
      this.sessionId = init.sessionId;
    }
    // Best-effort initialized notification (HTTP bridge accepts it).
    try {
      await this.rawPost('notifications/initialized', {});
    } catch {
      /* optional */
    }
  }

  /**
   * Bounded single-flight reconnect series. Concurrent callers await the same
   * generation. On success phase becomes ready; on exhaustion phase=failed.
   */
  private async coalescedReconnect(reason: string): Promise<void> {
    if (this.closed) {
      throw new Error('proxy closed');
    }
    if (this.reconnectInFlight) {
      return this.reconnectInFlight;
    }

    this.reconnectInFlight = this.runReconnectSeries(reason).finally(() => {
      this.reconnectInFlight = null;
    });
    return this.reconnectInFlight;
  }

  private async runReconnectSeries(reason: string): Promise<void> {
    this.phase = 'reconnecting';
    this.reconnectGeneration += 1;
    const generation = this.reconnectGeneration;
    this.sessionId = undefined;
    this.diagnose('reconnect_start', { reason, generation });

    const deadline = this.now() + this.reconnectDeadlineMs;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < this.maxReconnectAttempts && this.now() < deadline) {
      if (this.closed) throw new Error('proxy closed');
      attempt += 1;
      this.reconnectAttemptCount += 1;
      try {
        await this.initializeUpstream();
        this.phase = 'ready';
        this.diagnose('reconnect_ready', { generation, attempt });
        return;
      } catch (err) {
        lastErr = err;
        this.recordError(err);
        this.diagnose('reconnect_attempt_failed', {
          generation,
          attempt,
          code: this.lastErrorCode,
        });
        const delay = Math.min(
          this.reconnectBaseDelayMs * 2 ** (attempt - 1),
          1_000,
        );
        if (this.now() + delay >= deadline) break;
        await this.sleep(delay);
      }
    }

    this.phase = 'failed';
    this.recordError(lastErr ?? new Error('upstream reconnect exhausted'));
    this.diagnose('reconnect_exhausted', { generation, attempt });
    throw new Error(
      redactSecrets(
        `upstream reconnect exhausted after ${attempt} attempt(s): ${this.lastErrorMessage ?? 'unknown'}`,
        this.token,
      ),
    );
  }

  /**
   * Establish upstream HTTP MCP session (connecting → ready), with bounded
   * retries on transient failures.
   */
  async ensureUpstream(): Promise<void> {
    if (this.closed) throw new Error('proxy closed');
    if (this.phase === 'ready' && this.sessionId) return;
    if (this.phase === 'reconnecting' && this.reconnectInFlight) {
      await this.reconnectInFlight;
      return;
    }

    this.phase = 'connecting';
    this.diagnose('connecting');
    try {
      await this.initializeUpstream();
      this.phase = 'ready';
      this.diagnose('ready');
    } catch (err) {
      this.recordError(err);
      if (isTransientUpstreamError(err)) {
        await this.coalescedReconnect('initial_connect');
        return;
      }
      this.phase = 'failed';
      this.diagnose('connect_failed');
      throw new Error(
        redactSecrets(
          `upstream connect failed: ${(err as Error).message ?? String(err)}`,
          this.token,
        ),
      );
    }
  }

  private async withUpstreamRetry<T>(op: () => Promise<T>): Promise<T> {
    await this.ensureUpstream();
    try {
      return await op();
    } catch (err) {
      this.recordError(err);
      if (!isTransientUpstreamError(err) || this.closed) {
        throw err;
      }
      await this.coalescedReconnect('mid_run_flap');
      // Single retry after a successful reconnect series.
      return await op();
    }
  }

  private assertOkResult(result: BridgePostResult, method: string): unknown {
    if (result.status >= 400) {
      const err = Object.assign(
        new Error(`upstream ${method} HTTP ${result.status}`),
        { status: result.status, code: `http_${result.status}` },
      );
      throw err;
    }
    if (isJsonRpcError(result.json)) {
      const msg = result.json.error.message;
      const code = result.json.error.code;
      // Treat session-ish RPC failures as transient so reconnect can recover.
      const err = Object.assign(new Error(msg), {
        code: `rpc_${code}`,
        status: 200,
      });
      if (
        /session|not found|expired|reset|hang up|econn/i.test(msg) ||
        code === -32000
      ) {
        // leave as transient via message match
      }
      throw err;
    }
    const payload = result.json as { result?: unknown };
    return payload?.result;
  }

  async listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }> {
    return this.withUpstreamRetry(async () => {
      const result = await this.rawPost('tools/list', {});
      const body = this.assertOkResult(result, 'tools/list') as {
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      };
      return { tools: body?.tools ?? [] };
    });
  }

  async callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    return this.withUpstreamRetry(async () => {
      const result = await this.rawPost('tools/call', {
        name: params.name,
        arguments: params.arguments ?? {},
      });
      const body = this.assertOkResult(result, 'tools/call') as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      return {
        content: body?.content ?? [],
        isError: body?.isError,
      };
    });
  }

  /** Wire SDK Server handlers and serve MCP over process stdio. */
  async startStdio(): Promise<void> {
    if (this.closed) throw new Error('proxy closed');
    await this.ensureUpstream();

    const server = new Server(
      { name: 'muster_bridge', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return this.listTools();
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.callTool({
        name: request.params.name,
        arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
      });
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.stdioServer = server;
    this.diagnose('stdio_listening');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.phase = 'closed';
    this.sessionId = undefined;
    try {
      await this.stdioServer?.close();
    } catch {
      /* ignore */
    }
    this.stdioServer = undefined;
    this.diagnose('closed');
  }
}

/** CLI entry: env-only config, serve MCP on stdio. */
export async function runStdioProxyMain(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cfg = loadProxyEnvConfig(env);
  const proxy = new MusterStdioMcpProxy(cfg);
  const shutdown = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  try {
    await proxy.startStdio();
  } catch (err) {
    const message = redactSecrets((err as Error).message ?? String(err), cfg.token);
    process.stderr.write(
      JSON.stringify({ event: 'fatal', message, phase: proxy.getDebugSnapshot().phase }) + '\n',
    );
    process.exit(1);
  }
}

// Node CLI entry when executed directly (compiled .js or tsx .ts).
const entry = process.argv[1];
if (entry && /mcp-stdio-proxy\.(t|j)s$/.test(entry.replace(/\\/g, '/'))) {
  void runStdioProxyMain();
}
