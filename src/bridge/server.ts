import { randomUUID } from 'crypto';
import * as http from 'http';
import * as path from 'path';
import type * as McpServerModule from '@modelcontextprotocol/sdk/server/index.js';
import type * as McpExpressModule from '@modelcontextprotocol/sdk/server/express.js';
import type * as McpStreamableHttpModule from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type * as McpTypesModule from '@modelcontextprotocol/sdk/types.js';
import type { CredentialRegistry, CredentialVerification } from './credentials';
import {
  isPublicMcpToolAction,
  PUBLIC_MCP_TOOL_ACTIONS,
  type PublicMcpToolAction,
} from '../task/capabilities';
import {
  dispatch,
  PRESENTATION_ID_MAX_LENGTH,
  PRESENTATION_MARKDOWN_MAX_LENGTH,
  PRESENTATION_TITLE_MAX_LENGTH,
} from '../task/coordinator-tools';
import { DEFAULT_WORKFLOW_POLICY } from '../task/workflow-codec';

// VS Code's Extension Host resolver does not consistently honor this package's
// wildcard exports (for example `./server/index.js`) in a packaged VSIX. Resolve
// the SDK's explicit `./server` export once, then load its CommonJS siblings by
// absolute paths so desktop and remote hosts use the same deterministic files.
// The package's `.` require export points to a file absent in SDK 1.29.0.
const mcpCjsRoot = path.dirname(path.dirname(require.resolve('@modelcontextprotocol/sdk/server')));
const { Server } = require(path.join(mcpCjsRoot, 'server', 'index.js')) as typeof McpServerModule;
const { createMcpExpressApp } = require(
  path.join(mcpCjsRoot, 'server', 'express.js'),
) as typeof McpExpressModule;
const { StreamableHTTPServerTransport } = require(
  path.join(mcpCjsRoot, 'server', 'streamableHttp.js'),
) as typeof McpStreamableHttpModule;
const { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } = require(
  path.join(mcpCjsRoot, 'types.js'),
) as typeof McpTypesModule;

type McpServer = InstanceType<typeof Server>;
type McpStreamableHttpTransport = InstanceType<typeof StreamableHTTPServerTransport>;

export interface ToolCallHandler {
  handleToolCall(
    ctx: import('./credentials').CredentialContext,
    tool: string,
    command: import('../task/coordinator-tools').ToolCommand,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
}

/** MCP observation surface for readiness supervisors (no bearer tokens). */
export type BridgeMcpObservationPhase = 'initialize' | 'list_tools';

export interface BridgeMcpObservation {
  phase: BridgeMcpObservationPhase;
  toolNames?: string[];
  credentialId: string;
  turnId: string;
  attemptId: string;
  generation: number;
  timestamp: number;
}

export interface MusterBridgeServerOptions {
  credentials: CredentialRegistry;
  toolHandler: ToolCallHandler;
  /** Optional observer for ListTools/initialize catalogs (T02 readiness surface). */
  onMcpObservation?: (obs: BridgeMcpObservation) => void;
}

export type BridgeHealthStatus = 'ok' | 'stopping';

export interface BridgeHealthResponse {
  status: BridgeHealthStatus;
  generation: number;
  port?: number;
}

const ALL_TOOLS: readonly PublicMcpToolAction[] = PUBLIC_MCP_TOOL_ACTIONS;

const OP_ID = { type: 'string', minLength: 1 };
const PRESENTATION_ID = {
  type: 'string',
  minLength: 1,
  maxLength: PRESENTATION_ID_MAX_LENGTH,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
};

const TOOL_INPUT_SCHEMAS: Record<PublicMcpToolAction, Record<string, unknown>> = {
  list_task_types: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  inspect_workflow_run: {
    type: 'object',
    required: ['runId'],
    properties: {
      runId: OP_ID,
    },
    additionalProperties: false,
  },
  get_host_context: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  workflow_next: {
    type: 'object',
    required: ['opId', 'change'],
    properties: {
      opId: OP_ID,
      change: { type: 'string', enum: ['updated', 'unchanged'] },
      result: { type: 'string' },
    },
    additionalProperties: false,
  },
  workflow_prev: {
    type: 'object',
    required: ['opId', 'targets'],
    properties: {
      opId: OP_ID,
      targets: {
        oneOf: [
          { type: 'string', enum: ['all'] },
          {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1, maxLength: 128 },
          },
        ],
      },
      note: { type: 'string', minLength: 1, maxLength: 512 },
    },
    additionalProperties: false,
  },
  workflow_fail: {
    type: 'object',
    required: ['opId'],
    properties: {
      opId: OP_ID,
      reason: { type: 'string', minLength: 1, maxLength: 512 },
    },
    additionalProperties: false,
  },
  invoke_child_workflow: {
    type: 'object',
    required: ['opId', 'childDefinitionId', 'childDefinitionVersion', 'entryBindings'],
    properties: {
      opId: OP_ID,
      childDefinitionId: OP_ID,
      childDefinitionVersion: { type: 'integer', minimum: 1 },
      entryBindings: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: {
          type: 'object',
          required: ['childEntryNodeId', 'inputRef', 'artifactId', 'artifactRevision'],
          properties: {
            childEntryNodeId: OP_ID,
            inputRef: { type: 'string', minLength: 1, maxLength: 128 },
            artifactId: OP_ID,
            artifactRevision: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },
      },
      childIdempotencyKey: OP_ID,
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
      kind: { type: 'string', enum: ['plan', 'spec', 'document'] },
      summary: { type: 'string', minLength: 1, maxLength: 600 },
      changeSummary: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    additionalProperties: false,
  },
  define_workflow: {
    type: 'object',
    required: ['opId', 'definitionId', 'version', 'name', 'topology', 'entryContracts', 'policy'],
    properties: {
      opId: OP_ID,
      definitionId: OP_ID,
      version: { type: 'integer', minimum: 1 },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      topology: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'entryNodeId', 'nodes'],
            properties: {
              kind: { type: 'string', enum: ['one_node_v1'] },
              entryNodeId: OP_ID,
              nodes: {
                type: 'array',
                minItems: 1,
                maxItems: 1,
                items: {
                  type: 'object',
                  required: ['nodeId'],
                  properties: {
                    nodeId: OP_ID,
                    label: { type: 'string', minLength: 1, maxLength: 200 },
                    role: { type: 'string', enum: ['coordinator', 'worker'] },
                    taskType: OP_ID,
                    backend: { type: 'string', minLength: 1, maxLength: 128 },
                    model: { type: 'string', minLength: 1, maxLength: 128 },
                    capabilities: {
                      type: 'array',
                      maxItems: 16,
                      uniqueItems: true,
                      items: {
                        type: 'string',
                        enum: ['create_child', 'start_child', 'wait_child', 'interrupt_child', 'cancel_child', 'read_subtree'],
                      },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['kind', 'nodes', 'edges'],
            properties: {
              kind: { type: 'string', enum: ['graph_v1'] },
              nodes: {
                type: 'array',
                minItems: 2,
                maxItems: 32,
                items: {
                  type: 'object',
                  required: ['nodeId'],
                  properties: {
                    nodeId: OP_ID,
                    label: { type: 'string', minLength: 1, maxLength: 200 },
                    role: { type: 'string', enum: ['coordinator', 'worker'] },
                    taskType: OP_ID,
                    backend: { type: 'string', minLength: 1, maxLength: 128 },
                    model: { type: 'string', minLength: 1, maxLength: 128 },
                    capabilities: {
                      type: 'array',
                      maxItems: 16,
                      uniqueItems: true,
                      items: {
                        type: 'string',
                        enum: ['create_child', 'start_child', 'wait_child', 'interrupt_child', 'cancel_child', 'read_subtree'],
                      },
                    },
                  },
                  additionalProperties: false,
                },
              },
              edges: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: {
                  type: 'object',
                  required: ['fromNodeId', 'toNodeId', 'inputRef', 'expectedArtifactKind'],
                  properties: {
                    fromNodeId: OP_ID,
                    toNodeId: OP_ID,
                    inputRef: { type: 'string', minLength: 1, maxLength: 128 },
                    expectedArtifactKind: { type: 'string', minLength: 1, maxLength: 128 },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      entryContracts: {
        type: 'array',
        maxItems: 128,
        items: {
          type: 'object',
          required: ['entryNodeId', 'inputRef', 'expectedArtifactKind'],
          properties: {
            entryNodeId: OP_ID,
            inputRef: { type: 'string', minLength: 1, maxLength: 128 },
            expectedArtifactKind: { type: 'string', minLength: 1, maxLength: 128 },
          },
          additionalProperties: false,
        },
      },
      policy: {
        type: 'object',
        required: [
          'maxFeedbackRoundsPerRun', 'maxTurnsPerTask', 'maxWorkflowTurnsPerRun',
          'runTimeoutMs', 'maxDepth', 'maxTaskCount', 'maxConcurrency',
          'maxInputsPerGate', 'maxArtifactBytes', 'maxAggregateBytes', 'failWorkflow',
        ],
        properties: {
          maxFeedbackRoundsPerRun: {
            type: 'integer', minimum: 1, maximum: 32,
            default: DEFAULT_WORKFLOW_POLICY.maxFeedbackRoundsPerRun,
            description: 'Feedback/PREV round budget. Minimum 1; use the default even when no PREV is planned.',
          },
          maxTurnsPerTask: {
            type: 'integer', minimum: 1, maximum: 500,
            default: DEFAULT_WORKFLOW_POLICY.maxTurnsPerTask,
          },
          maxWorkflowTurnsPerRun: {
            type: 'integer', minimum: 1, maximum: 256,
            default: DEFAULT_WORKFLOW_POLICY.maxWorkflowTurnsPerRun,
          },
          runTimeoutMs: {
            type: 'integer', minimum: 1000, maximum: 28800000,
            default: DEFAULT_WORKFLOW_POLICY.runTimeoutMs,
          },
          maxDepth: {
            type: 'integer', minimum: 1, maximum: 8,
            default: DEFAULT_WORKFLOW_POLICY.maxDepth,
          },
          maxTaskCount: {
            type: 'integer', minimum: 1, maximum: 64,
            default: DEFAULT_WORKFLOW_POLICY.maxTaskCount,
          },
          maxConcurrency: {
            type: 'integer', minimum: 1, maximum: 64,
            default: DEFAULT_WORKFLOW_POLICY.maxConcurrency,
            description: 'Must not exceed maxTaskCount.',
          },
          maxInputsPerGate: {
            type: 'integer', minimum: 1, maximum: 64,
            default: DEFAULT_WORKFLOW_POLICY.maxInputsPerGate,
          },
          maxArtifactBytes: {
            type: 'integer', minimum: 1, maximum: 262144,
            default: DEFAULT_WORKFLOW_POLICY.maxArtifactBytes,
            description: 'Maximum UTF-8 bytes in one routed artifact.',
          },
          maxAggregateBytes: {
            type: 'integer', minimum: 1, maximum: 1048576,
            default: DEFAULT_WORKFLOW_POLICY.maxAggregateBytes,
            description: 'Maximum framed gate aggregate. Must cover every maximum-size input plus framing; do not set equal to maxArtifactBytes when an entry has inputs.',
          },
          failWorkflow: { type: 'boolean', default: DEFAULT_WORKFLOW_POLICY.failWorkflow },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  start_workflow: {
    type: 'object',
    required: ['opId', 'definitionId', 'version', 'startIdempotencyKey', 'entryInputs'],
    properties: {
      opId: OP_ID,
      definitionId: OP_ID,
      version: { type: 'integer', minimum: 1 },
      startIdempotencyKey: OP_ID,
      goal: { type: 'string', minLength: 1, maxLength: 512 },
      backend: { type: 'string', minLength: 1, maxLength: 64 },
      entryInputs: {
        type: 'array',
        maxItems: 128,
        items: {
          type: 'object',
          required: ['entryNodeId', 'inputRef', 'kind', 'value'],
          properties: {
            entryNodeId: OP_ID,
            inputRef: { type: 'string', minLength: 1, maxLength: 128 },
            kind: { type: 'string', minLength: 1, maxLength: 128 },
            value: { type: 'string', maxLength: 262144 },
          },
          additionalProperties: false,
        },
      },
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

/** Preserve MCP's text content shape while making disposition conflicts machine-readable. */
export function formatToolError(error: string): string {
  const conflict = /^disposition conflict: current disposition is ([a-z_]+)$/i.exec(error);
  if (!conflict) return error;
  return JSON.stringify({
    code: 'disposition_conflict',
    currentDisposition: conflict[1],
    message: error,
  });
}

function logCredentialRejection(verification: CredentialVerification): void {
  if (verification.ok) return;
  console.info('[muster][bridge] credential.reject', {
    credentialId: verification.credentialId ?? null,
    callerTaskId: verification.callerTaskId ?? null,
    turnId: verification.turnId ?? null,
    reason: verification.reason,
  });
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

interface CreateMcpServerOptions {
  credentials: CredentialRegistry;
  toolHandler: ToolCallHandler;
  getGeneration: () => number;
  onMcpObservation?: (obs: BridgeMcpObservation) => void;
}

function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { credentials, toolHandler, getGeneration, onMcpObservation } = options;
  const server = new Server({ name: 'muster_bridge', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const authHeader = (extra as { authInfo?: { token?: string } }).authInfo?.token;
    const verification = credentials.verifyDetailed(authHeader ?? '');
    if (!verification.ok) logCredentialRejection(verification);
    const ctx = verification.ok ? verification.context : null;
    const allowed = ctx?.allowedActions ?? new Set<PublicMcpToolAction>();
    const tools = ALL_TOOLS.filter((name) => allowed.has(name)).map((name) => ({
      name,
      description:
         name === 'get_host_context'
          ? 'Refresh trusted host env, self ids, task-type registry summary, and role rules (same data as first-turn host block).'
          : name === 'list_task_types'
            ? 'Refresh configured muster.taskTypes (first-turn host context already lists them). Prefer taskType from host snapshot; omit backend/model unless the user named an override.'
            : name === 'inspect_workflow_run'
              ? 'Inspect bounded durable state for an owned workflow run by runId. Returns run/gate/activation/feedback/continuation diagnostics and committed terminal artifact references; never topology, prompts, artifact bodies, paths, or secrets. Use for recovery and diagnosis, not polling.'
            : name === 'upsert_presentation'
                            ? 'Open or refresh a read-only IDE tab with Markdown (```mermaid``` fences supported). REQUIRED when the user asks to plan/spec for review or when a plan is ready: pass the full plan as markdown — do not only paste it in chat. Args: presentationId (stable, e.g. plan-<taskId>), ownerTaskId (must equal self.taskId), opId (unique per call), revision (1 then ++), title, markdown, optional kind (plan|spec|document), optional summary. Never send sourcePath, sourceFolderUri, updatedAt, or rootId (host-owned).'
                            : name === 'workflow_next'
                              ? 'Stage a workflow NEXT disposition on the live turn: routes this node result forward without sealing lifecycle. Provide change=updated|unchanged and optional result body. Engine owns gate/artifact identities. Committed only when the adapter settles the turn successfully.'
                            : name === 'workflow_prev'
                              ? 'Stage a workflow PREV disposition on the live turn: request correction from one or all direct producers without sealing lifecycle. Provide targets="all" or a non-empty inputRef array and optional note. Engine owns round/target/resume identities. Committed only when the adapter settles the turn successfully.'
                            : name === 'workflow_fail'
                              ? 'Stage a workflow FAIL disposition on the live turn: close the current workflow run without sealing task lifecycle. Optional reason is bounded diagnostics only (no prompts/artifacts/paths). Engine owns run/gate/round closure identities. Committed only when the adapter settles the turn successfully.'
                            : name === 'invoke_child_workflow'
                              ? 'Stage a child-workflow NEXT route on the live turn without sealing caller lifecycle. Provide childDefinitionId, childDefinitionVersion, and exact entryBindings (childEntryNodeId, inputRef, artifactId, artifactRevision), plus an optional childIdempotencyKey. Engine owns child run/continuation/return-gate identities. Committed only when the adapter settles the turn successfully.'
                             : name === 'define_workflow'
                               ? 'Persist an immutable workflow definition version (one_node_v1 or graph_v1 fan-in). Start from the advertised policy defaults unless the user requires tighter limits. maxFeedbackRoundsPerRun is at least 1. maxAggregateBytes includes framing plus all maximum-size gate inputs, so it normally must be greater than maxArtifactBytes. Same definitionId+version+fingerprint replays; differing fingerprint fails closed.'
                              : name === 'start_workflow'
                                ? 'Idempotently start a frozen top-level workflow run. Claims startIdempotencyKey and creates exactly one ordinary queued entry turn when the entry gate is satisfied. Agents never supply run/task/turn/gate IDs.'
                          : `Muster coordinator tool: ${name}`,
      inputSchema: TOOL_INPUT_SCHEMAS[name],
    }));
    if (ctx && onMcpObservation) {
      // Exact filtered catalog returned to the client — never include the bearer token.
      onMcpObservation({
        phase: 'list_tools',
        toolNames: tools.map((t) => t.name),
        credentialId: ctx.credentialId,
        turnId: ctx.turnId,
        attemptId: ctx.attemptId,
        generation: getGeneration(),
        timestamp: Date.now(),
      });
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const authHeader = (extra as { authInfo?: { token?: string } }).authInfo?.token;
    const token = authHeader ?? '';
    const verification = credentials.verifyDetailed(token);
    if (!verification.ok) {
      logCredentialRejection(verification);
      return { content: [{ type: 'text', text: 'unauthorized' }], isError: true };
    }
    const ctx = verification.context;

    const name = request.params.name;
    if (!isPublicMcpToolAction(name)) {
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    }
    const args = request.params.arguments ?? {};
    const routed = dispatch(name, args, ctx);
    if (!routed.ok) {
      return { content: [{ type: 'text', text: routed.toolError }], isError: true };
    }

    const result = await toolHandler.handleToolCall(ctx, name, routed.command);
    if (!result.ok) {
      return { content: [{ type: 'text', text: formatToolError(result.error) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.result) }] };
  });

  return server;
}

export class MusterBridgeServer {
  private readonly credentials: CredentialRegistry;
  private readonly toolHandler: ToolCallHandler;
  private readonly onMcpObservation?: (obs: BridgeMcpObservation) => void;
  private httpServer?: http.Server;
  private port = 0;
  /** Monotonic bind generation. Starts at 1; bumps on every re-listen after a prior bind. */
  private generation = 1;
  private hasBoundOnce = false;
  private healthStatus: BridgeHealthStatus = 'ok';
  private readonly transports = new Map<string, McpStreamableHttpTransport>();
  /**
   * Bridge-local setup semaphore (async mutex/queue) for concurrent MCP session
   * transport create+connect. Not storage locking — only serializes first-touch
   * initialize on this process so the session map stays coherent.
   */
  private setupTail: Promise<void> = Promise.resolve();

  constructor(options: MusterBridgeServerOptions) {
    this.credentials = options.credentials;
    this.toolHandler = options.toolHandler;
    this.onMcpObservation = options.onMcpObservation;
  }

  getGeneration(): number {
    return this.generation;
  }

  /**
   * Run `fn` under the bridge-local setup semaphore. Concurrent initialize
   * setups queue here; list/call on existing sessions only await if a setup is
   * already in the critical section (they do not enter the lock themselves).
   */
  private async withSetupLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.setupTail;
    let release!: () => void;
    this.setupTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private emitObservation(obs: BridgeMcpObservation): void {
    try {
      this.onMcpObservation?.(obs);
    } catch {
      // Observer failures must not break MCP request handling.
    }
  }

  async listen(): Promise<{ port: number }> {
    if (this.httpServer) {
      return { port: this.port };
    }

    this.healthStatus = 'ok';
    const app = createMcpExpressApp({ host: '127.0.0.1' });

    // Unauthenticated loopback health — no repository I/O, no credential required.
    app.get(
      '/health',
      (
        _req: http.IncomingMessage,
        res: http.ServerResponse & {
          status: (code: number) => { json: (body: unknown) => void };
        },
      ) => {
        const body: BridgeHealthResponse = {
          status: this.healthStatus,
          generation: this.generation,
        };
        if (this.port > 0) {
          body.port = this.port;
        }
        res.status(200).json(body);
      },
    );

    app.all('/mcp', async (req: http.IncomingMessage & { body?: unknown }, res: http.ServerResponse & { status: (code: number) => { json: (body: unknown) => void } }) => {
      const token = parseBearer(req.headers.authorization);
      const verification = this.credentials.verifyDetailed(token ?? '');
      if (!token || !verification.ok) {
        logCredentialRejection(verification);
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
        let transport: McpStreamableHttpTransport | undefined;
        const body = req.body;

        if (sessionId && this.transports.has(sessionId)) {
          transport = this.transports.get(sessionId);
        } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
          // Serialize concurrent first-touch MCP session setup (bridge-local only).
          transport = await this.withSetupLock(async () => {
            const newTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                this.transports.set(sid, newTransport);
              },
            });
            newTransport.onclose = () => {
              const sid = newTransport.sessionId;
              if (sid) {
                this.transports.delete(sid);
              }
            };
            const mcpServer = createMcpServer({
              credentials: this.credentials,
              toolHandler: this.toolHandler,
              getGeneration: () => this.generation,
              onMcpObservation: this.onMcpObservation
                ? (obs) => this.emitObservation(obs)
                : undefined,
            });
            await mcpServer.connect(newTransport);
            // Initialize is observable at session creation (credential already verified).
            const ctx = verification.context;
            this.emitObservation({
              phase: 'initialize',
              credentialId: ctx.credentialId,
              turnId: ctx.turnId,
              attemptId: ctx.attemptId,
              generation: this.generation,
              timestamp: Date.now(),
            });
            return newTransport;
          });
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
          // First bind keeps generation at 1; every re-listen after close bumps.
          if (this.hasBoundOnce) {
            this.generation += 1;
          }
          this.hasBoundOnce = true;
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
    this.healthStatus = 'stopping';
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
