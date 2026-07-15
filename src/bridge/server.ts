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
import {
  dispatch,
  PRESENTATION_ID_MAX_LENGTH,
  PRESENTATION_MARKDOWN_MAX_LENGTH,
  PRESENTATION_TITLE_MAX_LENGTH,
} from '../task/coordinator-tools';

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
  'create_tasks',
  'delegate_tasks',
  'release_tasks',
  'list_task_types',
  'start_task',
  'interrupt_task',
  'cancel_task',
  'set_task_lifecycle',
  'wait_for_tasks',
  'get_task_status',
  'get_host_context',
  'complete_task',
  'fail_task',
  'report_progress',
  'ask_user',
  'upsert_presentation',
];

const OP_ID = { type: 'string', minLength: 1 };
const PRESENTATION_ID = {
  type: 'string',
  minLength: 1,
  maxLength: PRESENTATION_ID_MAX_LENGTH,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
};

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

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      enum: ['coordinate', 'plan', 'breakdown', 'implement', 'test', 'verify', 'research', 'generic'],
    },
    title: { type: 'string' },
    objective: { type: 'string' },
    context: { type: 'string' },
    nonGoals: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    definitionOfDone: { type: 'array', items: { type: 'string' } },
    readPaths: { type: 'array', items: { type: 'string' } },
    writePaths: { type: 'array', items: { type: 'string' } },
    verification: {
      type: 'object',
      properties: {
        commands: { type: 'array', items: { type: 'string' } },
        manualChecks: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const INPUT_BINDING_SCHEMA = {
  type: 'object',
  required: ['fromTaskId', 'output', 'as'],
  properties: {
    fromTaskId: OP_ID,
    output: { enum: ['summary'] },
    as: { type: 'string', minLength: 1 },
    required: { type: 'boolean' },
  },
  additionalProperties: false,
};

const CREATE_SPEC_PROPERTIES = {
  opId: OP_ID,
  goal: { type: 'string', minLength: 1 },
  /** Required: id from muster.taskTypes (not enum'd — registry changes independently). */
  taskType: { type: 'string', minLength: 1 },
  /** Optional user override only when the user named a backend. */
  backend: { type: 'string', minLength: 1, maxLength: 200 },
  /** ACP model id (config option value or session/set_model id). Optional override. */
  model: { type: 'string', minLength: 1, maxLength: 200 },
  role: { enum: ['coordinator', 'worker'] },
  dependencies: { type: 'array', items: DEPENDENCY_SCHEMA },
  executionPolicy: EXECUTION_POLICY_SCHEMA,
  description: { type: 'string' },
  brief: BRIEF_SCHEMA,
  inputBindings: { type: 'array', items: INPUT_BINDING_SCHEMA },
  claimsGit: { type: 'boolean' },
  writePaths: { type: 'array', items: { type: 'string' } },
  readPaths: { type: 'array', items: { type: 'string' } },
};

const BATCH_INPUT_BINDING_SCHEMA = {
  type: 'object',
  required: ['output', 'as'],
  properties: {
    /** Sibling localId producing the summary (XOR fromTaskId). */
    fromLocalId: { type: 'string', minLength: 1 },
    /** Pre-existing producer task id (XOR fromLocalId). */
    fromTaskId: OP_ID,
    output: { enum: ['summary'] },
    as: { type: 'string', minLength: 1 },
    required: { type: 'boolean' },
  },
  additionalProperties: false,
};

const BATCH_CHILD_SCHEMA = {
  type: 'object',
  required: ['localId', 'goal', 'taskType'],
  properties: {
    /** Unique-within-batch handle (same grammar as task type ids). */
    localId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_-]{0,63}$' },
    goal: { type: 'string', minLength: 1 },
    taskType: { type: 'string', minLength: 1 },
    backend: { type: 'string', minLength: 1, maxLength: 200 },
    model: { type: 'string', minLength: 1, maxLength: 200 },
    role: { enum: ['coordinator', 'worker'] },
    /** Sibling localIds this item waits for (→ succeeded/block dependency). */
    dependsOn: { type: 'array', items: { type: 'string', minLength: 1 } },
    /** Ordering edges onto pre-existing tasks in the same root. */
    dependencies: { type: 'array', items: DEPENDENCY_SCHEMA },
    executionPolicy: EXECUTION_POLICY_SCHEMA,
    description: { type: 'string' },
    brief: BRIEF_SCHEMA,
    inputBindings: { type: 'array', items: BATCH_INPUT_BINDING_SCHEMA },
    claimsGit: { type: 'boolean' },
    writePaths: { type: 'array', items: { type: 'string' } },
    readPaths: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
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
    required: ['opId', 'goal', 'taskType'],
    properties: CREATE_SPEC_PROPERTIES,
    additionalProperties: false,
  },
  delegate_task: {
    type: 'object',
    required: ['opId', 'goal', 'taskType'],
    properties: CREATE_SPEC_PROPERTIES,
    additionalProperties: false,
  },
  create_tasks: {
    type: 'object',
    required: ['opId', 'tasks'],
    properties: {
      opId: OP_ID,
      tasks: { type: 'array', minItems: 1, maxItems: 16, items: BATCH_CHILD_SCHEMA },
    },
    additionalProperties: false,
  },
  delegate_tasks: {
    type: 'object',
    required: ['opId', 'tasks'],
    properties: {
      opId: OP_ID,
      tasks: { type: 'array', minItems: 1, maxItems: 16, items: BATCH_CHILD_SCHEMA },
    },
    additionalProperties: false,
  },
  list_task_types: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  release_tasks: {
    type: 'object',
    required: ['opId', 'taskIds'],
    properties: {
      opId: OP_ID,
      taskIds: { type: 'array', items: OP_ID, minItems: 1 },
      includeDependencies: { type: 'boolean' },
    },
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
  set_task_lifecycle: {
    type: 'object',
    required: ['opId', 'taskId', 'lifecycle'],
    properties: {
      opId: OP_ID,
      taskId: OP_ID,
      lifecycle: { enum: ['succeeded', 'failed', 'cancelled', 'skipped'] },
      result: { type: 'string', minLength: 1 },
      error: { type: 'string', minLength: 1 },
      reason: { type: 'string' },
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
  get_host_context: {
    type: 'object',
    properties: {},
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
  upsert_presentation: {
    type: 'object',
    required: ['presentationId', 'ownerTaskId', 'opId', 'revision', 'title', 'markdown'],
    properties: {
      presentationId: PRESENTATION_ID,
      ownerTaskId: PRESENTATION_ID,
      opId: PRESENTATION_ID,
      revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      title: { type: 'string', minLength: 1, maxLength: PRESENTATION_TITLE_MAX_LENGTH },
      markdown: { type: 'string', minLength: 1, maxLength: PRESENTATION_MARKDOWN_MAX_LENGTH },
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
        description:
          name === 'get_host_context'
            ? 'Refresh trusted host env, self ids, task-type registry summary, and role rules (same data as first-turn host block).'
            : name === 'list_task_types'
              ? 'List configured muster.taskTypes presets (id, backend, model, role, briefKind). Create children by taskType; omit backend/model unless the user named an override.'
              : name === 'create_task' || name === 'delegate_task'
                ? `Create a child by required taskType from muster.taskTypes (backend/model optional user overrides only). Tool: ${name}.`
                : name === 'create_tasks' || name === 'delegate_tasks'
                  ? `Batch-expand a structured checklist into up to 16 children in one atomic step: derives ids, topo-sorts intra-batch dependsOn/inputBindings (each item needs a unique localId), auto-wires a succeeded/block dependency per intra-batch binding. ${name === 'delegate_tasks' ? 'Releases and runs every child immediately.' : 'Leaves every child as a draft to release later.'} Tool: ${name}.`
                : name === 'set_task_lifecycle'
                  ? "Parent-seal a direct child's lifecycle (succeeded/failed/…). Use when child did not complete_task."
                  : `Muster coordinator tool: ${name}`,
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