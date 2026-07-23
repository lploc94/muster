// Shared fault-injection fixture for MCP bridge/proxy characterization tests.
//
// This is NOT a test file — it is excluded from `tsc` (via the `**/*.testkit.ts`
// pattern in tsconfig) and from vitest's `*.test.ts` include glob. It is
// deliberately free of any `vitest` import so it stays a plain, dependency-light
// module matching the acp-test-harness.testkit.ts convention.
//
// Models the wire shape used by scripts/fixtures/bridge-tool-agent.ts against
// MusterBridgeServer JSON-RPC responses (initialize → tools/list → tools/call),
// without a real HTTP server or child process. Later slices (S04–S06) script
// per-attempt failures to assert bounded recovery.

/** MCP method phases that can be scripted to fail. */
export type McpFaultPhase = 'initialize' | 'tools/list' | 'tools/call' | 'connection';

/** Connection-level errno-style failure codes. */
export type ConnectionFaultCode = 'ECONNREFUSED' | 'ECONNRESET' | 'socket_reset';

/** Minimal tool catalog entry matching MusterBridgeServer listTools shape. */
export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Per-attempt failure script entry. Attempts are 1-based per phase. */
export interface McpFaultScript {
  phase: McpFaultPhase;
  /** 1-based attempt index for this phase that should fail. */
  attempt: number;
  /** Required for phase === 'connection'; ignored otherwise. */
  code?: ConnectionFaultCode;
  /** Optional JSON-RPC error payload for method-level failures. */
  error?: { code: number; message: string };
  /** When true (default for tools/call), return MCP isError content instead of JSON-RPC error. */
  asToolError?: boolean;
}

export interface McpJsonRpcRequest {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface McpJsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type McpJsonRpcResponse = McpJsonRpcSuccess | McpJsonRpcFailure;

/** HTTP-shaped result mirroring bridge-tool-agent's mcpPost return. */
export interface FakeMcpPostResult {
  status: number;
  json: unknown;
  sessionId?: string;
  headers: Record<string, string>;
}

/** Error thrown for connection-phase faults (no HTTP response produced). */
export class FakeMcpConnectionError extends Error {
  readonly code: ConnectionFaultCode;
  readonly errno?: number;
  readonly syscall: string;
  readonly address: string;
  readonly port: number;

  constructor(code: ConnectionFaultCode) {
    super(connectionMessage(code));
    this.name = 'FakeMcpConnectionError';
    this.code = code;
    this.syscall = 'connect';
    this.address = '127.0.0.1';
    this.port = 0;
    if (code === 'ECONNREFUSED') this.errno = -111;
    if (code === 'ECONNRESET') this.errno = -104;
  }
}

function connectionMessage(code: ConnectionFaultCode): string {
  switch (code) {
    case 'ECONNREFUSED':
      return 'connect ECONNREFUSED 127.0.0.1:0';
    case 'ECONNRESET':
      return 'read ECONNRESET';
    case 'socket_reset':
      return 'socket hang up';
  }
}

/** Exact workflow-only tool names advertised by the real bridge. */
export const DEFAULT_MUSTER_TOOLS: readonly string[] = [
  'list_task_types',
  'inspect_workflow_run',
  'get_host_context',
  'upsert_presentation',
  'define_workflow',
  'start_workflow',
  'workflow_next',
  'workflow_prev',
  'workflow_fail',
  'invoke_child_workflow',
] as const;

export function defaultMusterToolCatalog(): FakeMcpTool[] {
  return DEFAULT_MUSTER_TOOLS.map((name) => ({
    name,
    description: `Muster coordinator tool: ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  }));
}

export interface FakeMcpBridgeOptions {
  /** Initial tool catalog (defaults to full Muster catalog). */
  tools?: FakeMcpTool[];
  /** Fixed session id; otherwise a deterministic fake id is generated. */
  sessionId?: string;
  /** Protocol version returned from initialize. */
  protocolVersion?: string;
  /** Server info returned from initialize. */
  serverInfo?: { name: string; version: string };
}

export interface FakeMcpCallRecord {
  phase: McpFaultPhase | 'other';
  method: string;
  attempt: number;
  params?: Record<string, unknown>;
  sessionId?: string;
  faulted: boolean;
  faultCode?: ConnectionFaultCode | 'jsonrpc' | 'tool_error';
}

/**
 * Controllable in-process MCP bridge/proxy for fault-injection tests.
 *
 * Script failures with {@link FakeMcpBridge.failOn} using 1-based attempt indexes
 * so recovery loops can assert "fails once then succeeds" (bounded recovery).
 */
export interface FakeMcpBridge {
  /** Current session id after a successful initialize (undefined before). */
  readonly sessionId: string | undefined;
  /** Per-phase attempt counters (incremented before fault check). */
  readonly attempts: Readonly<Record<McpFaultPhase, number>>;
  /** Ordered request log for assertions. */
  readonly calls: readonly FakeMcpCallRecord[];
  /** Active fault scripts. */
  readonly scripts: readonly McpFaultScript[];

  /** Replace the tool catalog returned by tools/list. */
  setTools(tools: FakeMcpTool[]): void;
  /** Current tool catalog (copy). */
  getTools(): FakeMcpTool[];

  /**
   * Register one or more per-attempt failures.
   * Example: failOn({ phase: 'initialize', attempt: 1 }) fails the first
   * initialize then succeeds on attempt 2+.
   */
  failOn(script: McpFaultScript | McpFaultScript[]): void;
  /** Remove all fault scripts (does not reset attempt counters). */
  clearFaults(): void;

  /**
   * Configure tools/call success payload for a tool name.
   * Value may be a static object or a function of the call arguments.
   */
  setToolResult(
    name: string,
    result:
      | unknown
      | ((args: Record<string, unknown>) => unknown | Promise<unknown>),
  ): void;

  /**
   * Connection open (phase: connection). Throws FakeMcpConnectionError when
   * a connection fault is scripted for the current attempt; otherwise no-ops.
   * Call this before initialize when modeling transport-level failure.
   */
  connect(): Promise<void>;

  /**
   * Handle a JSON-RPC request the way bridge-tool-agent posts to /mcp.
   * Returns HTTP-shaped status + body + mcp-session-id header.
   * Throws FakeMcpConnectionError when a connection fault is armed for this
   * attempt (and the request is treated as a new connection attempt when
   * method is initialize or when session is missing).
   */
  handle(
    request: McpJsonRpcRequest,
    opts?: { sessionId?: string; authorization?: string },
  ): Promise<FakeMcpPostResult>;

  /**
   * Convenience: run initialize → tools/list → tools/call like bridge-tool-agent.
   * Stops and rethrows on the first fault.
   */
  runHappyPath(tool?: { name: string; arguments?: Record<string, unknown> }): Promise<{
    sessionId: string;
    tools: FakeMcpTool[];
    call?: FakeMcpPostResult;
  }>;

  /** Reset attempt counters, call log, session, scripts, and tool results. */
  reset(opts?: FakeMcpBridgeOptions): void;
}

let sessionSeq = 0;

function nextSessionId(prefix = 'mcp-fake'): string {
  sessionSeq += 1;
  return `${prefix}-${sessionSeq}`;
}

function isJsonRpcFailure(json: unknown): json is McpJsonRpcFailure {
  return (
    !!json &&
    typeof json === 'object' &&
    'error' in (json as object) &&
    !!(json as McpJsonRpcFailure).error
  );
}

/**
 * Create a FakeMcpBridge control surface.
 *
 * @example
 * ```ts
 * const bridge = createFakeMcpBridge();
 * bridge.failOn({ phase: 'initialize', attempt: 1 });
 * await expect(bridge.handle({ method: 'initialize', id: 1 })).rejects...
 * // attempt 2 succeeds
 * const ok = await bridge.handle({ method: 'initialize', id: 2 });
 * ```
 */
export function createFakeMcpBridge(options: FakeMcpBridgeOptions = {}): FakeMcpBridge {
  let tools: FakeMcpTool[] = (options.tools ?? defaultMusterToolCatalog()).map((t) => ({ ...t }));
  let fixedSessionId = options.sessionId;
  let protocolVersion = options.protocolVersion ?? '2025-03-26';
  let serverInfo = options.serverInfo ?? { name: 'muster_bridge', version: '0.1.0' };

  let sessionId: string | undefined;
  /** True after a successful connect() or initialize (transport is open). */
  let connected = false;
  let scripts: McpFaultScript[] = [];
  const attempts: Record<McpFaultPhase, number> = {
    initialize: 0,
    'tools/list': 0,
    'tools/call': 0,
    connection: 0,
  };
  const calls: FakeMcpCallRecord[] = [];
  const toolResults = new Map<
    string,
    unknown | ((args: Record<string, unknown>) => unknown | Promise<unknown>)
  >();

  function findScript(phase: McpFaultPhase, attempt: number): McpFaultScript | undefined {
    return scripts.find((s) => s.phase === phase && s.attempt === attempt);
  }

  function record(
    phase: McpFaultPhase | 'other',
    method: string,
    attempt: number,
    faulted: boolean,
    faultCode?: FakeMcpCallRecord['faultCode'],
    params?: Record<string, unknown>,
    sid?: string,
  ): void {
    calls.push({ phase, method, attempt, params, sessionId: sid, faulted, faultCode });
  }

  function throwConnection(code: ConnectionFaultCode, method: string, attempt: number): never {
    record('connection', method, attempt, true, code, undefined, sessionId);
    throw new FakeMcpConnectionError(code);
  }

  /**
   * Apply a connection-phase script once per transport open.
   * Skips when already connected so connect()+initialize do not double-count.
   */
  function ensureConnected(method: string): void {
    if (connected) return;
    attempts.connection += 1;
    const attempt = attempts.connection;
    const script = findScript('connection', attempt);
    if (script) {
      throwConnection(script.code ?? 'ECONNREFUSED', method, attempt);
    }
    connected = true;
    record('connection', method, attempt, false, undefined, undefined, sessionId);
  }

  async function handleInitialize(
    request: McpJsonRpcRequest,
    opts?: { sessionId?: string },
  ): Promise<FakeMcpPostResult> {
    // First initialize models opening the HTTP connection when connect() was not called.
    ensureConnected('initialize');

    attempts.initialize += 1;
    const attempt = attempts.initialize;
    const script = findScript('initialize', attempt);
    const id = request.id ?? null;

    if (script) {
      const err = script.error ?? { code: -32000, message: 'initialize failed (scripted)' };
      record('initialize', 'initialize', attempt, true, 'jsonrpc', request.params, sessionId);
      return {
        status: 200,
        json: { jsonrpc: '2.0', id, error: err } satisfies McpJsonRpcFailure,
        sessionId: undefined,
        headers: {},
      };
    }

    const sid = fixedSessionId ?? nextSessionId();
    sessionId = sid;
    record('initialize', 'initialize', attempt, false, undefined, request.params, sid);

    const result = {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo,
    };
    return {
      status: 200,
      json: { jsonrpc: '2.0', id, result } satisfies McpJsonRpcSuccess,
      sessionId: sid,
      headers: { 'mcp-session-id': sid },
    };
  }

  async function handleListTools(
    request: McpJsonRpcRequest,
    opts?: { sessionId?: string },
  ): Promise<FakeMcpPostResult> {
    attempts['tools/list'] += 1;
    const attempt = attempts['tools/list'];
    const script = findScript('tools/list', attempt);
    const id = request.id ?? null;
    const sid = opts?.sessionId ?? sessionId;

    if (script) {
      const err = script.error ?? { code: -32001, message: 'tools/list failed (scripted)' };
      record('tools/list', 'tools/list', attempt, true, 'jsonrpc', request.params, sid);
      return {
        status: 200,
        json: { jsonrpc: '2.0', id, error: err } satisfies McpJsonRpcFailure,
        sessionId: sid,
        headers: sid ? { 'mcp-session-id': sid } : {},
      };
    }

    record('tools/list', 'tools/list', attempt, false, undefined, request.params, sid);
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: { tools: tools.map((t) => ({ ...t })) },
      } satisfies McpJsonRpcSuccess,
      sessionId: sid,
      headers: sid ? { 'mcp-session-id': sid } : {},
    };
  }

  async function handleCallTool(
    request: McpJsonRpcRequest,
    opts?: { sessionId?: string },
  ): Promise<FakeMcpPostResult> {
    attempts['tools/call'] += 1;
    const attempt = attempts['tools/call'];
    const script = findScript('tools/call', attempt);
    const id = request.id ?? null;
    const sid = opts?.sessionId ?? sessionId;
    const params = (request.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const toolName = params.name ?? '';
    const args = params.arguments ?? {};

    if (script) {
      const asToolError = script.asToolError !== false;
      if (asToolError) {
        const message = script.error?.message ?? 'tools/call failed (scripted)';
        record('tools/call', 'tools/call', attempt, true, 'tool_error', request.params, sid);
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: message }],
              isError: true,
            },
          } satisfies McpJsonRpcSuccess,
          sessionId: sid,
          headers: sid ? { 'mcp-session-id': sid } : {},
        };
      }
      const err = script.error ?? { code: -32002, message: 'tools/call failed (scripted)' };
      record('tools/call', 'tools/call', attempt, true, 'jsonrpc', request.params, sid);
      return {
        status: 200,
        json: { jsonrpc: '2.0', id, error: err } satisfies McpJsonRpcFailure,
        sessionId: sid,
        headers: sid ? { 'mcp-session-id': sid } : {},
      };
    }

    const configured = toolResults.get(toolName);
    let payload: unknown;
    if (typeof configured === 'function') {
      payload = await configured(args);
    } else if (configured !== undefined) {
      payload = configured;
    } else {
      payload = { ok: true, tool: toolName, arguments: args };
    }

    record('tools/call', 'tools/call', attempt, false, undefined, request.params, sid);
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        },
      } satisfies McpJsonRpcSuccess,
      sessionId: sid,
      headers: sid ? { 'mcp-session-id': sid } : {},
    };
  }

  const bridge: FakeMcpBridge = {
    get sessionId() {
      return sessionId;
    },
    get attempts() {
      return { ...attempts };
    },
    get calls() {
      return calls.slice();
    },
    get scripts() {
      return scripts.slice();
    },

    setTools(next) {
      tools = next.map((t) => ({ ...t }));
    },
    getTools() {
      return tools.map((t) => ({ ...t }));
    },

    failOn(script) {
      const list = Array.isArray(script) ? script : [script];
      for (const s of list) {
        if (!Number.isInteger(s.attempt) || s.attempt < 1) {
          throw new Error(`failOn: attempt must be a 1-based integer, got ${s.attempt}`);
        }
        if (s.phase === 'connection' && !s.code) {
          // default filled at throw time; still accept
        }
        scripts.push({ ...s });
      }
    },
    clearFaults() {
      scripts = [];
    },

    setToolResult(name, result) {
      toolResults.set(name, result);
    },

    async connect() {
      ensureConnected('connect');
    },

    async handle(request, opts) {
      const method = request.method;

      // Explicit connection probe: if caller only opened a socket via connect(),
      // faults already applied. For initialize without prior connect, we also
      // check connection scripts inside handleInitialize.

      if (method === 'initialize') {
        return handleInitialize(request, opts);
      }
      if (method === 'tools/list') {
        return handleListTools(request, opts);
      }
      if (method === 'tools/call') {
        return handleCallTool(request, opts);
      }

      // Unknown method — record and return method-not-found.
      record('other', method, 0, true, 'jsonrpc', request.params, opts?.sessionId ?? sessionId);
      return {
        status: 200,
        json: {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` },
        } satisfies McpJsonRpcFailure,
        sessionId: opts?.sessionId ?? sessionId,
        headers:
          opts?.sessionId || sessionId
            ? { 'mcp-session-id': (opts?.sessionId ?? sessionId) as string }
            : {},
      };
    },

    async runHappyPath(tool) {
      await bridge.connect();
      const init = await bridge.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'fake-mcp-client', version: '0.1.0' },
        },
      });
      if (init.status >= 400 || isJsonRpcFailure(init.json)) {
        throw new Error(`initialize failed: ${JSON.stringify(init.json)}`);
      }
      const sid = init.sessionId;
      if (!sid) throw new Error('initialize missing session id');

      const list = await bridge.handle(
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { sessionId: sid },
      );
      if (list.status >= 400 || isJsonRpcFailure(list.json)) {
        throw new Error(`tools/list failed: ${JSON.stringify(list.json)}`);
      }
      const listed =
        ((list.json as McpJsonRpcSuccess).result as { tools?: FakeMcpTool[] })?.tools ?? [];

      if (!tool) {
        return { sessionId: sid, tools: listed };
      }

      const call = await bridge.handle(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: tool.name, arguments: tool.arguments ?? {} },
        },
        { sessionId: sid },
      );
      return { sessionId: sid, tools: listed, call };
    },

    reset(opts) {
      tools = (opts?.tools ?? options.tools ?? defaultMusterToolCatalog()).map((t) => ({ ...t }));
      fixedSessionId = opts?.sessionId ?? options.sessionId;
      protocolVersion = opts?.protocolVersion ?? options.protocolVersion ?? '2025-03-26';
      serverInfo =
        opts?.serverInfo ?? options.serverInfo ?? { name: 'muster_bridge', version: '0.1.0' };
      sessionId = undefined;
      connected = false;
      scripts = [];
      attempts.initialize = 0;
      attempts['tools/list'] = 0;
      attempts['tools/call'] = 0;
      attempts.connection = 0;
      calls.length = 0;
      toolResults.clear();
    },
  };

  return bridge;
}

/** Type guard helpers for consumers asserting fault outcomes. */
export function isFakeMcpConnectionError(err: unknown): err is FakeMcpConnectionError {
  return err instanceof FakeMcpConnectionError;
}

export function getJsonRpcError(
  result: FakeMcpPostResult,
): { code: number; message: string } | undefined {
  if (isJsonRpcFailure(result.json)) return result.json.error;
  return undefined;
}

export function getToolCallIsError(result: FakeMcpPostResult): boolean {
  if (!result.json || typeof result.json !== 'object') return false;
  const payload = result.json as McpJsonRpcSuccess;
  if (!('result' in payload) || !payload.result || typeof payload.result !== 'object') return false;
  return (payload.result as { isError?: boolean }).isError === true;
}
