import { randomUUID } from 'crypto';
import * as http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { CredentialRegistry } from './credentials';
import type { ToolAction } from '../task/capabilities';
import { dispatch } from '../task/coordinator-tools';

export interface ToolCallHandler {
  handleToolCall(
    ctx: import('./credentials').CredentialContext,
    tool: string,
    command: import('../task/coordinator-tools').ToolCommand,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
}

export interface MusterBridgeServerOptions {
  credentials: CredentialRegistry;
  toolHandler: ToolCallHandler;
}

const ALL_TOOLS: ToolAction[] = [
  'create_task',
  'delegate_task',
  'start_task',
  'interrupt_task',
  'cancel_task',
  'wait_for_tasks',
  'get_task_status',
  'complete_task',
  'fail_task',
  'report_progress',
  'ask_user',
  'submit_decision_brief',
  'submit_plan_artifact',
];

const OP_ID = { type: 'string', minLength: 1 };

const DEPENDENCY_SCHEMA = {
  type: 'object',
  required: ['taskId', 'requiredOutcome', 'onUnsatisfied'],
  properties: {
    taskId: OP_ID,
    requiredOutcome: { enum: ['succeeded', 'settled'] },
    onUnsatisfied: { enum: ['block', 'fail', 'skip'] },
  },
  additionalProperties: false,
};

const EXECUTION_POLICY_SCHEMA = {
  type: 'object',
  properties: {
    maxTurns: { type: 'integer', minimum: 1 },
    maxAutomaticRetries: { type: 'integer', minimum: 0 },
    turnTimeoutMs: { type: 'integer', minimum: 1 },
    taskTimeoutMs: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

const CREATE_SPEC_PROPERTIES = {
  opId: OP_ID,
  goal: { type: 'string', minLength: 1 },
  backend: { type: 'string', minLength: 1 },
  role: { enum: ['coordinator', 'worker'] },
  dependencies: { type: 'array', items: DEPENDENCY_SCHEMA },
  executionPolicy: EXECUTION_POLICY_SCHEMA,
};

const QUESTION_SCHEMA = {
  type: 'object',
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1 },
    options: { type: 'array', items: { type: 'string' } },
    allowFreeText: { type: 'boolean' },
  },
  additionalProperties: false,
};

const TOOL_INPUT_SCHEMAS: Record<ToolAction, Record<string, unknown>> = {
  create_task: {
    type: 'object',
    required: ['opId', 'goal', 'backend'],
    properties: CREATE_SPEC_PROPERTIES,
    additionalProperties: false,
  },
  delegate_task: {
    type: 'object',
    required: ['opId', 'goal', 'backend'],
    properties: CREATE_SPEC_PROPERTIES,
    additionalProperties: false,
  },
  start_task: {
    type: 'object',
    required: ['opId', 'childId'],
    properties: {
      opId: OP_ID,
      childId: OP_ID,
      taskId: OP_ID,
    },
    additionalProperties: false,
  },
  interrupt_task: {
    type: 'object',
    required: ['opId', 'childId'],
    properties: {
      opId: OP_ID,
      childId: OP_ID,
      taskId: OP_ID,
    },
    additionalProperties: false,
  },
  cancel_task: {
    type: 'object',
    required: ['opId', 'childId'],
    properties: {
      opId: OP_ID,
      childId: OP_ID,
      taskId: OP_ID,
    },
    additionalProperties: false,
  },
  wait_for_tasks: {
    type: 'object',
    required: ['opId', 'taskIds'],
    properties: {
      opId: OP_ID,
      taskIds: { type: 'array', items: OP_ID, minItems: 1 },
    },
    additionalProperties: false,
  },
  get_task_status: {
    type: 'object',
    properties: {
      taskId: OP_ID,
    },
    additionalProperties: false,
  },
  complete_task: {
    type: 'object',
    required: ['opId', 'result'],
    properties: {
      opId: OP_ID,
      result: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
  fail_task: {
    type: 'object',
    required: ['opId', 'error'],
    properties: {
      opId: OP_ID,
      error: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
  report_progress: {
    type: 'object',
    required: ['opId', 'note'],
    properties: {
      opId: OP_ID,
      note: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
  ask_user: {
    type: 'object',
    required: ['opId', 'questions'],
    properties: {
      opId: OP_ID,
      questions: { type: 'array', items: QUESTION_SCHEMA, minItems: 1 },
    },
    additionalProperties: false,
  },
  submit_decision_brief: {
    type: 'object',
    required: ['opId', 'artifact'],
    properties: {
      opId: OP_ID,
      artifact: { type: 'object' },
    },
    additionalProperties: false,
  },
  submit_plan_artifact: {
    type: 'object',
    required: ['opId', 'artifact'],
    properties: {
      opId: OP_ID,
      artifact: { type: 'object' },
    },
    additionalProperties: false,
  },
};

function parseBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) {
    return false;
  }
  const normalized = host.toLowerCase();
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === '127.0.0.1' ||
    normalized === 'localhost'
  );
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

function createMcpServer(
  credentials: CredentialRegistry,
  toolHandler: ToolCallHandler,
): Server {
  const server = new Server({ name: 'muster_bridge', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const authHeader = (extra as { authInfo?: { token?: string } }).authInfo?.token;
    const ctx = authHeader ? credentials.verify(authHeader) : null;
    const allowed = ctx?.allowedActions ?? new Set<ToolAction>();
    return {
      tools: ALL_TOOLS.filter((name) => allowed.has(name)).map((name) => ({
        name,
        description: `Muster coordinator tool: ${name}`,
        inputSchema: TOOL_INPUT_SCHEMAS[name],
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const authHeader = (extra as { authInfo?: { token?: string } }).authInfo?.token;
    const token = authHeader ?? '';
    const ctx = credentials.verify(token);
    if (!ctx) {
      return { content: [{ type: 'text', text: 'unauthorized' }], isError: true };
    }

    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const routed = dispatch(name, args, ctx);
    if (!routed.ok) {
      return { content: [{ type: 'text', text: routed.toolError }], isError: true };
    }

    const result = await toolHandler.handleToolCall(ctx, name, routed.command);
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.result) }] };
  });

  return server;
}

export class MusterBridgeServer {
  private readonly credentials: CredentialRegistry;
  private readonly toolHandler: ToolCallHandler;
  private httpServer?: http.Server;
  private port = 0;
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(options: MusterBridgeServerOptions) {
    this.credentials = options.credentials;
    this.toolHandler = options.toolHandler;
  }

  async listen(): Promise<{ port: number }> {
    if (this.httpServer) {
      return { port: this.port };
    }

    const app = createMcpExpressApp({ host: '127.0.0.1' });

    app.all('/mcp', async (req: http.IncomingMessage & { body?: unknown }, res: http.ServerResponse & { status: (code: number) => { json: (body: unknown) => void } }) => {
      const token = parseBearer(req.headers.authorization);
      if (!token || !this.credentials.verify(token)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (!isLoopbackHost(req.headers.host, this.port)) {
        res.status(403).json({ error: 'forbidden host' });
        return;
      }
      if (!isLoopbackOrigin(req.headers.origin as string | undefined)) {
        res.status(403).json({ error: 'forbidden origin' });
        return;
      }

      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport | undefined;
        const body = req.body;

        if (sessionId && this.transports.has(sessionId)) {
          transport = this.transports.get(sessionId);
        } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              if (transport) {
                this.transports.set(sid, transport);
              }
            },
          });
          transport.onclose = () => {
            const sid = transport?.sessionId;
            if (sid) {
              this.transports.delete(sid);
            }
          };
          const mcpServer = createMcpServer(this.credentials, this.toolHandler);
          await mcpServer.connect(transport);
        } else {
          res.status(400).json({ error: 'invalid session' });
          return;
        }

        (req as http.IncomingMessage & { auth?: { token: string } }).auth = { token };
        await transport!.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) {
          res.status(500).json({ error: 'internal error' });
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          this.port = addr.port;
          this.httpServer = server;
          resolve();
        } else {
          reject(new Error('failed to bind bridge server'));
        }
      });
      server.on('error', reject);
    });

    return { port: this.port };
  }

  getPort(): number {
    return this.port;
  }

  async close(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close();
    }
    this.transports.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    this.httpServer = undefined;
    this.port = 0;
  }
}