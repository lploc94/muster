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
  PRESENTATION_REF_PATTERN,
  PRESENTATION_TITLE_MAX_LENGTH,
  WORKFLOW_REF_PATTERN,
} from '../task/coordinator-tools';
import {
  MCP_JSON_BODY_MAX_BYTES,
  TASK_ERROR_MAX_BYTES,
  TASK_RESULT_MAX_BYTES,
  WORKFLOW_FEEDBACK_MAX_BYTES,
} from '../task/content-limits';
import {
  WORKFLOW_CHILD_BINDINGS_MAX,
  WORKFLOW_ENTRY_CONTRACTS_MAX,
  WORKFLOW_GRAPH_MAX_EDGES,
  WORKFLOW_GRAPH_MAX_NODES,
  WORKFLOW_NODE_LABEL_MAX_LENGTH,
  WORKFLOW_RUN_GOAL_MAX_LENGTH,
} from '../task/workflow-types';

// VS Code's Extension Host resolver does not consistently honor this package's
// wildcard exports (for example `./server/index.js`) in a packaged VSIX. Resolve
// the SDK's explicit `./server` export once, then load its CommonJS siblings by
// absolute paths so desktop and remote hosts use the same deterministic files.
// The package's `.` require export points to a file absent in SDK 1.29.0.
const mcpCjsRoot = path.dirname(path.dirname(require.resolve('@modelcontextprotocol/sdk/server')));
const { Server } = require(path.join(mcpCjsRoot, 'server', 'index.js')) as typeof McpServerModule;
const { StreamableHTTPServerTransport } = require(
  path.join(mcpCjsRoot, 'server', 'streamableHttp.js'),
) as typeof McpStreamableHttpModule;
const { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } = require(
  path.join(mcpCjsRoot, 'types.js'),
) as typeof McpTypesModule;

type McpServer = InstanceType<typeof Server>;
type McpStreamableHttpTransport = InstanceType<typeof StreamableHTTPServerTransport>;
type McpExpressApp = ReturnType<typeof McpExpressModule.createMcpExpressApp>;
const expressFactory = require(require.resolve('express', { paths: [mcpCjsRoot] })) as {
  (): McpExpressApp;
  json(options: { limit: number }): Parameters<McpExpressApp['use']>[0];
};

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
const PRESENTATION_REF = {
  type: 'string',
  minLength: 1,
  maxLength: PRESENTATION_ID_MAX_LENGTH,
  pattern: PRESENTATION_REF_PATTERN,
};
const WORKFLOW_REF = {
  type: 'string',
  minLength: 1,
  pattern: WORKFLOW_REF_PATTERN,
};

const DEFINE_WORKFLOW_DESCRIPTION = [
  'Define a reusable immutable workflow after selecting exact taskType ids from list_task_types.',
  'Use only this public shape: {"name":"...","nodes":[{"nodeKey":"...","taskType":"...","label":"..."}],"edges":[{"from":"...","to":"...","as":"..."}],"inputs":[{"to":"...","name":"..."}]}. Omit edges for a one-node workflow. Omit inputs when the run needs no caller-supplied values. Never send internal fields such as workflowKey, definitionId, version, topology, entryContracts, policy, backend, model, role, capabilities, opId, or task ids.',
  'The engine generates a stable workflowRef from the immutable semantic content and returns it. Do not invent a workflow identity. Repeating the exact same definition is idempotent; changing the content creates a distinct generated workflowRef.',
  'Topology rules: one node is valid. Multi-node workflows must be converging DAGs. Parallel source nodes may fan in, but fan-out and cycles are invalid. Every non-terminal node has exactly one outgoing edge; branches may end at one or more terminal sinks whose reports are combined in topology order. edges use producer-to-consumer direction. Each from node may appear only once. Each as value is the input name seen by the consumer and must be unique for that consumer.',
  'Input rules: inputs declare runtime values that start_workflow must later supply. Each input has exactly {"to":"source-nodeKey","name":"input-name"}. The to node must have no incoming edge. Do not put objectives or instructions in inputs; put the workflow name in name and each step objective in nodes[].label.',
  'CORRECT one-node: {"name":"Inspect scheduling","nodes":[{"nodeKey":"inspect","taskType":"explore","label":"Trace scheduling architecture, persistence, tests, and limitations."}],"inputs":[{"to":"inspect","name":"question"}]}',
  'CORRECT parallel fan-in: {"name":"Parallel review","nodes":[{"nodeKey":"code","taskType":"explore","label":"Inspect implementation."},{"nodeKey":"tests","taskType":"verify","label":"Inspect coverage."},{"nodeKey":"synthesize","taskType":"research","label":"Combine findings."}],"edges":[{"from":"code","to":"synthesize","as":"codeFindings"},{"from":"tests","to":"synthesize","as":"testFindings"}],"inputs":[{"to":"code","name":"request"},{"to":"tests","name":"request"}]}',
  'INCORRECT internal parameters: {"definitionId":"review","version":1,"topology":{...}}. Use name/nodes/edges/inputs instead.',
  'INCORRECT fan-out: edges [{"from":"intake","to":"code","as":"request"},{"from":"intake","to":"tests","as":"request"}]. Replace intake with independent source nodes that converge downstream.',
  'INCORRECT downstream input: if research -> review, inputs [{"to":"review","name":"request"}] is invalid because review has an incoming edge; declare the input on research.',
].join('\n');

const TOOL_INPUT_SCHEMAS: Record<PublicMcpToolAction, Record<string, unknown>> = {
  list_task_types: {
    type: 'object',
    description: 'No arguments. Returns the current semantic task profiles available for workflow nodes.',
    properties: {},
    additionalProperties: false,
  },
  inspect_workflow_run: {
    type: 'object',
    description: 'Read bounded diagnostic state for one owned workflow run.',
    required: ['runRef'],
    properties: {
      runRef: { ...OP_ID, description: 'Opaque runRef returned by start_workflow.' },
    },
    additionalProperties: false,
  },
  get_host_context: {
    type: 'object',
    description: 'No arguments. Refreshes trusted workspace, caller, rule, tool, and task-type context.',
    properties: {},
    additionalProperties: false,
  },
  workflow_next: {
    type: 'object',
    description: 'Publish the current activation result forward and end the current turn.',
    required: ['message'],
    properties: {
      change: {
        type: 'string',
        enum: ['updated', 'unchanged'],
        description: 'Use updated for new/revised output (default). Use unchanged only for an exact feedback replay.',
      },
      message: { type: 'string', minLength: 1, maxLength: TASK_RESULT_MAX_BYTES, description: 'Final assistant message committed before the turn ends.' },
    },
    additionalProperties: false,
  },
  workflow_prev: {
    type: 'object',
    description: 'Request correction from direct predecessor inputs and end the current turn.',
    required: ['message'],
    properties: {
      targets: {
        description: 'Direct input names to revisit, or all (default). Never use node ids.',
        oneOf: [
          { type: 'string', enum: ['all'] },
          {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1, maxLength: 128 },
          },
        ],
      },
        message: { type: 'string', minLength: 1, maxLength: WORKFLOW_FEEDBACK_MAX_BYTES, description: 'Final assistant message explaining the required correction.' },
    },
    additionalProperties: false,
  },
  workflow_fail: {
    type: 'object',
    description: 'Close the current workflow run as failed when no usable result can be produced.',
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: TASK_ERROR_MAX_BYTES, description: 'Concise diagnostic reason; do not include prompts, paths, or artifact bodies.' },
    },
    additionalProperties: false,
  },
  invoke_child_workflow: {
    type: 'object',
    description: 'Invoke a saved child workflow from the current live activation using semantic input bindings.',
    required: ['workflow', 'bindings'],
    properties: {
      workflow: { ...WORKFLOW_REF, description: 'Immutable workflowRef returned by define_workflow.' },
      bindings: {
        type: 'array',
        minItems: 1,
        maxItems: WORKFLOW_CHILD_BINDINGS_MAX,
        description: 'Bind every required child source input from a named input currently available on this activation.',
        items: {
          type: 'object',
          required: ['toNode', 'input', 'fromInput'],
          properties: {
            toNode: { ...OP_ID, description: 'Child source nodeKey declared by define_workflow.inputs.' },
            input: { type: 'string', minLength: 1, maxLength: 128, description: 'Declared child input name on toNode.' },
            fromInput: { type: 'string', minLength: 1, maxLength: 128, description: 'Exact current-activation input name whose artifact should be bound.' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  upsert_presentation: {
    type: 'object',
    description: 'Create or refresh one user-facing Markdown document in the IDE.',
    required: ['title', 'markdown'],
    properties: {
      presentationRef: { ...PRESENTATION_REF, description: 'Optional opaque ref returned by an earlier upsert when refreshing that same document.' },
      title: { type: 'string', minLength: 1, maxLength: PRESENTATION_TITLE_MAX_LENGTH, description: 'Human-readable tab title.' },
      markdown: { type: 'string', minLength: 1, maxLength: PRESENTATION_MARKDOWN_MAX_LENGTH, description: 'Full document content, not a patch. Mermaid fenced blocks are supported.' },
      kind: { type: 'string', enum: ['plan', 'spec', 'document'], description: 'Optional document classification.' },
      summary: { type: 'string', minLength: 1, maxLength: 600, description: 'Optional concise summary for the host.' },
      changeSummary: { type: 'string', minLength: 1, maxLength: 1000, description: 'Optional concise description of what changed since the prior revision.' },
    },
    additionalProperties: false,
  },
  define_workflow: {
    type: 'object',
    description: 'Exact semantic workflow object. Required: name, nodes. Optional: edges and inputs. One node needs no edges. For parallel work use A -> C and B -> C, with workflow inputs declared on A and B only. Fan-out, cycles, downstream inputs, internal ids, workflow identity, versions, topology objects, policy, backend, model, role, capabilities, and opId are invalid.',
    required: ['name', 'nodes'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200, description: 'Human-readable workflow name.' },
      nodes: {
        type: 'array',
        minItems: 1,
        maxItems: WORKFLOW_GRAPH_MAX_NODES,
        description: 'Unique workflow steps. nodeKey is local identity, taskType is an exact configured id, and label is the step objective. Use independent source nodes for parallel work; do not create a shared node that fans out.',
        items: {
          type: 'object',
          required: ['nodeKey', 'taskType'],
          properties: {
            nodeKey: { ...PRESENTATION_ID, description: 'Stable node key unique within this workflow.' },
            taskType: { ...OP_ID, description: 'Exact task-type id from list_task_types or current host context.' },
            label: { type: 'string', minLength: 1, maxLength: WORKFLOW_NODE_LABEL_MAX_LENGTH, description: 'Specific objective/instruction for this step. Put work instructions here, not in the inputs declaration.' },
          },
          additionalProperties: false,
        },
      },
      edges: {
        type: 'array',
        minItems: 1,
        maxItems: WORKFLOW_GRAPH_MAX_EDGES,
        description: 'Dependencies in producer-to-consumer direction. Fan-in is allowed; each from node may appear at most once. Omit for a one-node workflow.',
        items: {
          type: 'object',
          required: ['from', 'to', 'as'],
          properties: {
            from: { ...PRESENTATION_ID, description: 'Producer nodeKey. A producer may route to only one consumer.' },
            to: { ...PRESENTATION_ID, description: 'Consumer nodeKey.' },
            as: { type: 'string', minLength: 1, maxLength: 128, description: 'Input name under which the consumer receives this producer result; unique per consumer.' },
          },
          additionalProperties: false,
        },
      },
      inputs: {
        type: 'array',
        maxItems: WORKFLOW_ENTRY_CONTRACTS_MAX,
        description: 'Names of runtime values that start_workflow must supply. Declare only {to, name}; no value belongs here. to must be a source node with no incoming edge. Omit inputs entirely when no runtime value is required.',
        items: {
          type: 'object',
          required: ['to', 'name'],
          properties: {
            to: { ...PRESENTATION_ID, description: 'Source nodeKey with no incoming edge.' },
            name: { type: 'string', minLength: 1, maxLength: 128, description: 'Input name unique on that source node.' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  start_workflow: {
    type: 'object',
    description: 'Start a saved workflow and suspend this caller after durable acceptance. Supply exactly one value for every input declared by define_workflow, using the same source nodeKey and input name; omit inputs only when the definition declares none.',
    required: ['workflow'],
    properties: {
      workflow: { ...WORKFLOW_REF, description: 'Immutable workflowRef returned by define_workflow.' },
      goal: { type: 'string', minLength: 1, maxLength: WORKFLOW_RUN_GOAL_MAX_LENGTH, description: 'Optional run-specific objective shared with workflow nodes.' },
      inputs: {
        type: 'array',
        maxItems: WORKFLOW_ENTRY_CONTRACTS_MAX,
        description: 'Complete values for all declared workflow inputs. Node and input names must exactly match define_workflow.inputs.',
        items: {
          type: 'object',
          required: ['node', 'input', 'value'],
          properties: {
            node: { ...PRESENTATION_ID, description: 'Declared source nodeKey.' },
            input: { type: 'string', minLength: 1, maxLength: 128, description: 'Declared input name on that source node.' },
            value: { type: 'string', maxLength: TASK_RESULT_MAX_BYTES, description: 'Input value for this run.' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

const TOOL_DESCRIPTIONS: Record<PublicMcpToolAction, string> = {
  get_host_context: 'Refresh trusted workspace, caller, workflow rules, available tools, and task-type context. Use when the current host block is missing or may be stale. Read-only; takes no arguments.',
  list_task_types: 'List configured semantic task profiles for workflow nodes. Call before define_workflow when the current task-type list is absent or stale. Select an exact returned id; do not invent backend, model, role, capability, or policy fields.',
  inspect_workflow_run: 'Inspect bounded durable state for one owned workflow using the opaque runRef returned by start_workflow. Use only for recovery and diagnosis after uncertainty; do not poll for normal routing or pass task/gate/activation ids.',
  workflow_next: 'Publish the current live workflow activation result to its downstream node or terminal caller. message must be a self-contained final response because the receiver cannot see earlier assistant messages. change defaults to updated; use unchanged only for an exact feedback replay.',
  workflow_prev: 'Request correction from direct predecessor inputs of the current live activation. targets are semantic input names, not node ids, and default to all. message is the final assistant response committed before the host ends the turn.',
  workflow_fail: 'Fail the current live workflow run only when this activation cannot produce a usable result or request a valid correction. Provide an optional concise diagnostic reason. This is a terminal disposition for the current turn.',
  invoke_child_workflow: 'Invoke a saved child workflow from the current live activation using a workflowRef returned by define_workflow. Bind every required child source input to an exact current-activation input name; never provide artifact ids, revisions, or idempotency keys.',
  upsert_presentation: 'Open or refresh a read-only IDE Markdown tab. REQUIRED for user-facing plans/specs. Send the full markdown document (not a patch); Mermaid fenced blocks are supported. The engine generates a presentationRef on create; pass that returned ref to refresh the same document.',
  define_workflow: DEFINE_WORKFLOW_DESCRIPTION,
  start_workflow: 'Start a saved workflow using the workflowRef returned by define_workflow. A successful call returns durable acceptance, then the host suspends this turn and resumes the caller exactly once with the terminal result; do not poll inspect_workflow_run. Supply exactly one value for every input declared by define_workflow. Inside a workflow activation use invoke_child_workflow instead.',
};

function parseBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function workflowErrorHint(code: unknown, message: unknown): string | undefined {
  if (code !== 'invalid_workflow_definition' || typeof message !== 'string') return undefined;
  if (message === 'invalid entry contract') {
    return 'Declare workflow inputs only on source nodes with no incoming edges; downstream nodes receive predecessor results through edges.';
  }
  if (message.startsWith('fan-out not allowed:')) {
    return 'Use independent source nodes that converge by fan-in (for example A -> C and B -> C); one producer cannot route to multiple consumers.';
  }
  if (message.includes('cycle not allowed')) {
    return 'Remove the cycle and keep all edges directed forward toward one terminal node.';
  }
  return undefined;
}

/** Preserve MCP text content while adding stable codes and actionable recovery hints. */
export function formatToolError(error: string): string {
  const conflict = /^disposition conflict: current disposition is ([a-z_]+)$/i.exec(error);
  if (conflict) {
    return JSON.stringify({
      code: 'disposition_conflict',
      currentDisposition: conflict[1],
      message: error,
    });
  }
  if (
    error === 'incomplete entry inputs' ||
    error === 'entry input contract mismatch' ||
    error === 'invalid entry input' ||
    error === 'invalid start_workflow inputs'
  ) {
    return JSON.stringify({
      code: 'invalid_workflow_inputs',
      message: error,
      hint: 'Supply exactly one value for every input declared by define_workflow, using the exact source nodeKey and input name.',
    });
  }
  if (error === 'definition fingerprint conflict') {
    return JSON.stringify({
      code: 'workflow_identity_conflict',
      message: error,
      hint: 'The engine-generated workflow identity collided with different durable content. Retry the exact definition once; if it persists, refresh host context and report the failure.',
    });
  }
  if (error === 'operation fingerprint conflict') {
    return JSON.stringify({
      code: 'workflow_definition_retry_conflict',
      message: error,
      hint: 'This turn already submitted different content for the same generated operation. Retry with identical name/nodes/edges/inputs.',
    });
  }
  try {
    const parsed = JSON.parse(error) as unknown;
    if (!isObject(parsed)) return error;
    const hint = workflowErrorHint(parsed.code, parsed.message);
    return hint ? JSON.stringify({ ...parsed, hint }) : error;
  } catch {
    return error;
  }
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function workflowRef(definitionId: unknown, version: unknown): string | undefined {
  return typeof definitionId === 'string' && Number.isSafeInteger(version)
    ? `${definitionId}@${version}`
    : undefined;
}

function projectPublicToolResult(tool: PublicMcpToolAction, value: unknown): unknown {
  if (!isObject(value)) return value;
  if (tool === 'define_workflow') {
    const ref = workflowRef(value.definitionId, value.version);
    if (!ref) return value;
    return {
      workflowRef: ref,
      revision: value.version,
      changed: value.changed === true,
      replay: value.replay === true || value.changed === false,
    };
  }
  if (tool === 'upsert_presentation') {
    if (typeof value.presentationId !== 'string' || typeof value.code !== 'string') return value;
    return {
      presentationRef: value.presentationId,
      status: value.code,
    };
  }
  if (tool === 'start_workflow') {
    const ref = workflowRef(value.definitionId, value.version);
    if (typeof value.runId !== 'string' || !ref) return value;
    return {
      runRef: value.runId,
      workflowRef: ref,
      replay: value.replay === true || value.changed === false,
      status: 'accepted',
    };
  }
  if (tool === 'inspect_workflow_run') {
    if (typeof value.runId !== 'string') return value;
    const ref = workflowRef(value.definitionId, value.definitionVersion);
    const nodes = Array.isArray(value.nodes)
      ? value.nodes.filter(isObject).map((node) => ({ node: node.nodeId, status: node.status }))
      : [];
    const activations = Array.isArray(value.activations)
      ? value.activations.filter(isObject).map((activation) => ({
          node: activation.nodeId,
          kind: activation.kind,
          status: activation.status,
          ...(typeof activation.feedbackTargetNodeId === 'string'
            ? { feedbackTarget: activation.feedbackTargetNodeId }
            : {}),
        }))
      : [];
    const feedback = Array.isArray(value.feedbackRounds)
      ? value.feedbackRounds.filter(isObject).map((round) => ({
          requester: round.requesterNodeId,
          status: round.status,
          required: round.required,
          responded: round.responded,
        }))
      : [];
    const children = Array.isArray(value.continuations)
      ? value.continuations.filter(isObject).map((continuation) => ({
          status: continuation.status,
          kind: continuation.kind,
          ...(typeof continuation.outcome === 'string' ? { outcome: continuation.outcome } : {}),
          ...(typeof continuation.reasonCode === 'string' ? { reason: continuation.reasonCode } : {}),
        }))
      : [];
    return {
      runRef: value.runId,
      ...(ref ? { workflowRef: ref } : {}),
      status: value.runStatus,
      nodes,
      activations,
      feedback,
      children,
      ...(typeof value.terminalReason === 'string' ? { reason: value.terminalReason } : {}),
      diagnostics: Array.isArray(value.diagnostics)
        ? value.diagnostics.filter(isObject).map((diagnostic) => diagnostic.code)
        : [],
    };
  }
  if (tool === 'list_task_types') {
    const rows = Array.isArray(value.taskTypes) ? value.taskTypes.filter(isObject) : [];
    return {
      taskTypes: rows.map((row) => ({
        id: row.id,
        ...(typeof row.description === 'string' ? { description: row.description } : {}),
        role: row.defaultRole,
        briefKind: row.defaultBriefKind,
        availability: row.availability,
      })),
      diagnostics: Array.isArray(value.diagnostics)
        ? value.diagnostics.filter(isObject).map((diagnostic) => diagnostic.code)
        : [],
    };
  }
  if (tool === 'get_host_context') {
    const self = isObject(value.self) ? value.self : undefined;
    const rows = Array.isArray(value.taskTypes) ? value.taskTypes.filter(isObject) : undefined;
    return {
      version: value.version,
      workspace: value.workspace,
      ...(self
        ? {
            self: {
              taskId: self.taskId,
              role: self.role,
              ...(typeof self.parentTaskId === 'string' ? { parentTaskId: self.parentTaskId } : {}),
              ...(typeof self.goal === 'string' ? { goal: self.goal } : {}),
            },
          }
        : {}),
      rules: value.rules,
      tools: value.tools,
      ...(rows
        ? {
            taskTypes: rows.map((row) => ({
              id: row.id,
              ...(typeof row.description === 'string' ? { description: row.description } : {}),
              role: row.defaultRole,
              briefKind: row.defaultBriefKind,
              availability: row.availability,
            })),
          }
        : {}),
      ...(value.scope !== undefined ? { scope: value.scope } : {}),
    };
  }
  return value;
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
      description: TOOL_DESCRIPTIONS[name],
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
      return { content: [{ type: 'text', text: formatToolError(routed.toolError) }], isError: true };
    }

    const result = await toolHandler.handleToolCall(ctx, name, routed.command);
    if (!result.ok) {
      return { content: [{ type: 'text', text: formatToolError(result.error) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(projectPublicToolResult(name, result.result)) }] };
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
    const app = expressFactory();
    app.use(expressFactory.json({ limit: MCP_JSON_BODY_MAX_BYTES }));

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
