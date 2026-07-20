import { randomUUID } from 'crypto';
import * as http from 'http';
import * as path from 'path';
import type * as McpServerModule from '@modelcontextprotocol/sdk/server/index.js';
import type * as McpExpressModule from '@modelcontextprotocol/sdk/server/express.js';
import type * as McpStreamableHttpModule from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type * as McpTypesModule from '@modelcontextprotocol/sdk/types.js';
import type { CredentialRegistry, CredentialVerification } from './credentials';
import type { ToolAction } from '../task/capabilities';
import {
  dispatch,
  PRESENTATION_ID_MAX_LENGTH,
  PRESENTATION_MARKDOWN_MAX_LENGTH,
  PRESENTATION_TITLE_MAX_LENGTH,
} from '../task/coordinator-tools';

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

const ALL_TOOLS: ToolAction[] = [
  'create_task',
  'delegate_task',
  'create_tasks',
  'delegate_tasks',
  'release_tasks',
  'list_task_types',
  'interrupt_task',
  'cancel_task',
  'cancel_tasks',
  'continue_child',
  'set_task_lifecycle',
  'wait_for_tasks',
  'get_task_status',
  'get_host_context',
  'complete_task',
  'fail_task',
  'report_progress',
  'ask_parent',
  'answer_child_question',
  'upsert_presentation',
  'define_workflow',
  'start_workflow',
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
    // Opt-in verify gate: satisfied only when the producer verdict is `pass`.
    requiredVerdict: { enum: ['pass'] },
  },
  additionalProperties: false,
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { enum: ['pass', 'fail', 'inconclusive'] },
    rationale: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'status'],
        properties: {
          label: { type: 'string' },
          status: { enum: ['pass', 'fail', 'inconclusive'] },
          detail: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const EXECUTION_POLICY_SCHEMA = {
  type: 'object',
  properties: {
    maxTurns: { type: 'integer', minimum: 1 },
    maxAutomaticRetries: { type: 'integer', minimum: 0 },
    runTimeoutOverrideMs: {
      type: 'integer',
      minimum: 1,
      description: 'Optional shorter run budget. The user-configured host limit is always the ceiling.',
    },
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
    skills: { type: 'array', items: { type: 'string' }, maxItems: 8 },
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
    /** Sibling localIds this item waits for (→ succeeded/fail dependency). */
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
    properties: {
      ...CREATE_SPEC_PROPERTIES,
      waitForCompletion: {
        type: 'boolean',
        description:
          'When true, stage wait on this child in the same call. On success the barrier is armed: end the current turn; do not wait or poll again.',
      },
    },
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
      waitForLocalIds: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description: 'Exact batch-local ids to wait on. On success end the current turn; do not wait or poll again.',
      },
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
      waitForTaskIds: {
        type: 'array',
        items: OP_ID,
        minItems: 1,
        description:
          'Exact direct-child ids to wait on after release. On success end the current turn; do not wait or poll again.',
      },
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
  cancel_tasks: {
    type: 'object',
    required: ['opId', 'childIds'],
    properties: {
      opId: OP_ID,
      childIds: { type: 'array', items: OP_ID, minItems: 1 },
      reason: { type: 'string' },
    },
    additionalProperties: false,
  },
  continue_child: {
    type: 'object',
    required: ['opId', 'childId', 'instruction'],
    properties: {
      opId: OP_ID,
      childId: OP_ID,
      taskId: OP_ID,
      instruction: { type: 'string', minLength: 1 },
      waitForCompletion: { type: 'boolean' },
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
      // Optional structured verify verdict (verify tasks). Absent = no verdict.
      verdict: VERDICT_SCHEMA,
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
  ask_parent: {
    type: 'object',
    required: ['opId', 'questions'],
    properties: {
      opId: OP_ID,
      questions: { type: 'array', items: QUESTION_SCHEMA, minItems: 1 },
    },
    additionalProperties: false,
  },
  answer_child_question: {
    type: 'object',
    required: ['opId', 'questionId', 'answers'],
    properties: {
      opId: OP_ID,
      questionId: OP_ID,
      answers: { type: 'array', items: { type: 'string' }, minItems: 1 },
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
    required: ['opId', 'definitionId', 'version', 'name', 'topology'],
    properties: {
      opId: OP_ID,
      definitionId: OP_ID,
      version: { type: 'integer', minimum: 1 },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      topology: {
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
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  start_workflow: {
    type: 'object',
    required: ['opId', 'definitionId', 'version', 'startIdempotencyKey'],
    properties: {
      opId: OP_ID,
      definitionId: OP_ID,
      version: { type: 'integer', minimum: 1 },
      startIdempotencyKey: OP_ID,
      goal: { type: 'string', minLength: 1, maxLength: 512 },
      backend: { type: 'string', minLength: 1, maxLength: 64 },
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
    const allowed = ctx?.allowedActions ?? new Set<ToolAction>();
    const tools = ALL_TOOLS.filter((name) => allowed.has(name)).map((name) => ({
      name,
      description:
        name === 'get_host_context'
          ? 'Refresh trusted host env, self ids, task-type registry summary, and role rules (same data as first-turn host block).'
          : name === 'list_task_types'
            ? 'Refresh configured muster.taskTypes (first-turn host context already lists them). Prefer taskType from host snapshot; omit backend/model unless the user named an override.'
            : name === 'delegate_task'
              ? 'Create a released child by taskType and queue first turn. Prefer waitForCompletion:true for one-shot spawn+wait. A successful compound wait is already armed: end the turn and do not poll. Omit wait fields for fire-and-forget.'
              : name === 'create_task'
                ? 'Create a draft child by taskType (not scheduled until release_tasks). Prefer rich brief.'
                : name === 'delegate_tasks'
                  ? 'Batch create+release up to 16 children. Optional waitForLocalIds arms the barrier; on success end the turn and do not poll.'
                  : name === 'create_tasks'
                    ? 'Batch create draft children (up to 16). Release later with release_tasks({ waitForTaskIds }). Intra-batch dependsOn → succeeded/fail.'
                    : name === 'release_tasks'
                      ? 'Atomically release drafts and queue first turns. Optional waitForTaskIds arms the barrier; on success end the turn and do not poll. No start_task.'
                      : name === 'wait_for_tasks'
                        ? 'Advanced: monotonically add children to the current wait barrier. Redundant calls succeed. After success end the current turn; do not poll get_task_status.'
                        : name === 'set_task_lifecycle'
                          ? "Parent-seal a direct child's lifecycle (succeeded/failed/…). Use when child did not complete_task."
                          : name === 'upsert_presentation'
                            ? 'Open or refresh a read-only IDE tab with Markdown (```mermaid``` fences supported). REQUIRED when the user asks to plan/spec for review or when a plan is ready: pass the full plan as markdown — do not only paste it in chat. Args: presentationId (stable, e.g. plan-<taskId>), ownerTaskId (must equal self.taskId), opId (unique per call), revision (1 then ++), title, markdown, optional kind (plan|spec|document), optional summary. Never send sourcePath, sourceFolderUri, updatedAt, or rootId (host-owned).'
                            : name === 'define_workflow'
                              ? 'Persist an immutable one-node workflow definition version. Same definitionId+version+fingerprint replays; differing fingerprint fails closed. Topology is frozen one_node_v1 only for S01.'
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
   * transport create+connect. Not TaskStore locking — only serializes first-touch
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

    // Unauthenticated loopback health — no TaskStore I/O, no credential required.
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
