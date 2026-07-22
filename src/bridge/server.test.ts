import { describe, expect, it, afterEach } from 'vitest';
import { CredentialRegistry } from './credentials';
import { formatToolError, MusterBridgeServer } from './server';
import { DEFAULT_WORKFLOW_POLICY } from '../task/workflow';
import { PUBLIC_MCP_TOOL_ACTIONS } from '../task/capabilities';

const REMOVED_MCP_TOOLS = [
  'create_task',
  'delegate_task',
  'create_tasks',
  'delegate_tasks',
  'release_tasks',
  'interrupt_task',
  'cancel_task',
  'cancel_tasks',
  'continue_child',
  'set_task_lifecycle',
  'wait_for_tasks',
  'complete_task',
  'fail_task',
  'get_task_status',
  'report_progress',
  'ask_parent',
  'answer_child_question',
] as const;

async function readJsonRpc(res: Response): Promise<Record<string, unknown> | undefined> {
  const text = await res.text();
  if (!text) return undefined;
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice('data:'.length)
    .trim();
  if (data) {
    return JSON.parse(data) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function openMcpSession(port: number, token: string): Promise<{
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  const initialized = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    }),
  });
  const sessionId = initialized.headers.get('mcp-session-id');
  expect(initialized.ok).toBe(true);
  expect(sessionId).toBeTruthy();
  await readJsonRpc(initialized);

  await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId! },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  let requestId = 1;
  return {
    request: async (method, params = {}) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sessionId! },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      });
      expect(res.ok).toBe(true);
      const body = await readJsonRpc(res);
      expect(body).toBeDefined();
      return body!;
    },
  };
}

describe('formatToolError', () => {
  it('projects disposition conflicts with a stable code and current kind', () => {
    expect(JSON.parse(formatToolError('disposition conflict: current disposition is complete')))
      .toEqual({
        code: 'disposition_conflict',
        currentDisposition: 'complete',
        message: 'disposition conflict: current disposition is complete',
      });
    expect(formatToolError('task not found')).toBe('task not found');
  });
});

describe('MusterBridgeServer auth', () => {
  let server: MusterBridgeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('rejects missing bearer with 401', async () => {
    const credentials = new CredentialRegistry();
    server = new MusterBridgeServer({
      credentials,
      toolHandler: { handleToolCall: async () => ({ ok: true, result: {} }) },
    });
    const { port } = await server.listen();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('exposes and invokes presentation upserts only for authorized coordinators', async () => {
    const credentials = new CredentialRegistry();
    const handled: Array<{ tool: string; command: unknown }> = [];
    server = new MusterBridgeServer({
      credentials,
      toolHandler: {
        handleToolCall: async (_ctx, tool, command) => {
          handled.push({ tool, command });
          return { ok: true, result: { code: 'opened' } };
        },
      },
    });
    const { port } = await server.listen();
    const coordinatorToken = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-coordinator',
      attemptId: 'a0',
      allowedActions: new Set(['upsert_presentation']),
      ttlMs: 60_000,
    });
    const coordinator = await openMcpSession(port, coordinatorToken);

    const listed = await coordinator.request('tools/list');
    const tools = (listed.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['upsert_presentation']);
    expect(tools[0]).toMatchObject({
      name: 'upsert_presentation',
      description: expect.stringContaining('REQUIRED when the user asks to plan'),
    });
    expect(tools[0].inputSchema).toMatchObject({
      required: ['presentationId', 'ownerTaskId', 'opId', 'revision', 'title', 'markdown'],
      additionalProperties: false,
    });

    const called = await coordinator.request('tools/call', {
      name: 'upsert_presentation',
      arguments: {
        presentationId: 'release-notes',
        ownerTaskId: 'task-1',
        opId: 'op-1',
        revision: 1,
        title: 'Release notes',
        markdown: '# Ready',
      },
    });
    expect(called.result).toMatchObject({
      content: [{ type: 'text', text: '{"code":"opened"}' }],
    });
    expect(called.result).not.toHaveProperty('isError', true);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      tool: 'upsert_presentation',
      command: { kind: 'upsert_presentation', presentationId: 'release-notes' },
    });

    const workerToken = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'worker-1',
      turnId: 'turn-worker',
      attemptId: 'a0',
      allowedActions: new Set(['get_host_context']),
      ttlMs: 60_000,
    });
    const worker = await openMcpSession(port, workerToken);
    const workerListed = await worker.request('tools/list');
    const workerTools = (workerListed.result as { tools: Array<{ name: string }> }).tools;
    expect(workerTools.map((tool) => tool.name)).not.toContain('upsert_presentation');

    const denied = await worker.request('tools/call', {
      name: 'upsert_presentation',
      arguments: {
        presentationId: 'release-notes',
        ownerTaskId: 'worker-1',
        opId: 'op-2',
        revision: 1,
        title: 'Forbidden',
        markdown: '# Must not reach handler',
      },
    });
    expect(denied.result).toMatchObject({ isError: true });
    expect(handled).toHaveLength(1);
  });

  it('exposes define_workflow and start_workflow only when allowed and rejects malformed start', async () => {
    const credentials = new CredentialRegistry();
    const handled: Array<{ tool: string; command: unknown }> = [];
    server = new MusterBridgeServer({
      credentials,
      toolHandler: {
        handleToolCall: async (_ctx, tool, command) => {
          handled.push({ tool, command });
          return { ok: true, result: { ok: true, changed: true } };
        },
      },
    });
    const { port } = await server.listen();
    const token = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-1',
      attemptId: 'a0',
      allowedActions: new Set(['define_workflow', 'start_workflow']),
      ttlMs: 60_000,
    });
    const session = await openMcpSession(port, token);
    const listed = await session.request('tools/list');
    const workflowTools = (listed.result as {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: {
          properties?: Record<string, { properties?: Record<string, unknown> }>;
        };
      }>;
    }).tools;
    const names = workflowTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['define_workflow', 'start_workflow']));
    const defineTool = workflowTools.find((tool) => tool.name === 'define_workflow');
    expect(defineTool?.description).toContain('maxFeedbackRoundsPerRun is at least 1');
    expect(defineTool?.description).toContain('maxAggregateBytes includes framing');
    expect(defineTool?.inputSchema.properties?.policy?.properties).toMatchObject({
      maxFeedbackRoundsPerRun: {
        minimum: 1,
        default: DEFAULT_WORKFLOW_POLICY.maxFeedbackRoundsPerRun,
        description: expect.stringContaining('Minimum 1'),
      },
      maxArtifactBytes: {
        default: DEFAULT_WORKFLOW_POLICY.maxArtifactBytes,
      },
      maxAggregateBytes: {
        default: DEFAULT_WORKFLOW_POLICY.maxAggregateBytes,
        description: expect.stringContaining('do not set equal'),
      },
    });

    const defined = await session.request('tools/call', {
      name: 'define_workflow',
      arguments: {
        opId: 'op-def',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology: { kind: 'one_node_v1', entryNodeId: 'entry', nodes: [{ nodeId: 'entry' }] },
        entryContracts: [],
        policy: DEFAULT_WORKFLOW_POLICY,
      },
    });
    expect(defined.result).not.toHaveProperty('isError', true);
    expect(handled[0]).toMatchObject({ tool: 'define_workflow', command: { kind: 'define_workflow' } });

    const badStart = await session.request('tools/call', {
      name: 'start_workflow',
      arguments: { opId: 'op-start', definitionId: 'wf-one', version: 1 },
    });
    expect(badStart.result).toMatchObject({ isError: true });
    expect(handled).toHaveLength(1);

    const workerToken = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'worker-1',
      turnId: 'turn-worker',
      attemptId: 'a0',
      allowedActions: new Set(['get_host_context']),
      ttlMs: 60_000,
    });
    const worker = await openMcpSession(port, workerToken);
    const workerListed = await worker.request('tools/list');
    const workerNames = (workerListed.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(workerNames).not.toContain('define_workflow');
    expect(workerNames).not.toContain('start_workflow');
  });

  it('exposes the exact workflow catalog and rejects removed delegate-task tools', async () => {
    const credentials = new CredentialRegistry();
    const handled: Array<{ tool: string; command: unknown }> = [];
    server = new MusterBridgeServer({
      credentials,
      toolHandler: {
        handleToolCall: async (_ctx, tool, command) => {
          handled.push({ tool, command });
          return { ok: true, result: {} };
        },
      },
    });
    const { port } = await server.listen();
    const token = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-coordinator',
      attemptId: 'a0',
      allowedActions: new Set([...PUBLIC_MCP_TOOL_ACTIONS, 'delegate_task']),
      ttlMs: 60_000,
    });
    const coordinator = await openMcpSession(port, token);

    const listed = await coordinator.request('tools/list');
    const tools = (listed.result as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    }).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(PUBLIC_MCP_TOOL_ACTIONS);
    expect(tools.find((tool) => tool.name === 'inspect_workflow_run')).toMatchObject({
      description: expect.stringContaining('recovery and diagnosis'),
      inputSchema: {
        required: ['runId'],
        additionalProperties: false,
      },
    });
    const inspected = await coordinator.request('tools/call', {
      name: 'inspect_workflow_run',
      arguments: { runId: 'wfr-1' },
    });
    expect(inspected.result).not.toHaveProperty('isError', true);
    expect(handled).toEqual([
      {
        tool: 'inspect_workflow_run',
        command: { kind: 'inspect_workflow_run', runId: 'wfr-1' },
      },
    ]);
    for (const name of REMOVED_MCP_TOOLS) {
      expect(names).not.toContain(name);
      const removed = await coordinator.request('tools/call', {
        name,
        arguments: { opId: 'legacy-op', goal: 'legacy child', taskType: 'implement' },
      });
      expect(removed.result).toMatchObject({
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      });
    }
    expect(handled).toHaveLength(1);
  });

  it('accepts valid token with loopback host and absent origin on initialize', async () => {
    const credentials = new CredentialRegistry();
    server = new MusterBridgeServer({
      credentials,
      toolHandler: { handleToolCall: async () => ({ ok: true, result: {} }) },
    });
    const { port } = await server.listen();
    const token = credentials.issue({
      rootId: 'r',
      callerTaskId: 't',
      turnId: 'turn-1',
      attemptId: 'a0',
      allowedActions: new Set(['get_host_context']),
      ttlMs: 60_000,
    });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('MusterBridgeServer generation, /health, and observers', () => {
  let server: MusterBridgeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('GET /health returns status+generation without auth and getGeneration matches', async () => {
    const credentials = new CredentialRegistry();
    server = new MusterBridgeServer({
      credentials,
      toolHandler: { handleToolCall: async () => ({ ok: true, result: {} }) },
    });
    expect(server.getGeneration()).toBe(1);
    const { port } = await server.listen();
    expect(server.getGeneration()).toBe(1);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      generation: number;
      port?: number;
    };
    expect(body).toMatchObject({
      status: 'ok',
      generation: 1,
      port,
    });
    // Health must not require Authorization and must not touch the task repository.
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('close+listen bumps generation and /health reports the new generation', async () => {
    const credentials = new CredentialRegistry();
    server = new MusterBridgeServer({
      credentials,
      toolHandler: { handleToolCall: async () => ({ ok: true, result: {} }) },
    });
    const first = await server.listen();
    expect(server.getGeneration()).toBe(1);
    await server.close();

    const second = await server.listen();
    expect(server.getGeneration()).toBe(2);
    expect(second.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${second.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; generation: number; port?: number };
    expect(body.generation).toBe(2);
    expect(body.status).toBe('ok');
    expect(body.port).toBe(second.port);
    // First port is gone after restart — only assert generation monotonicity vs first listen.
    void first;
  });

  it('ListTools fires onMcpObservation with exact credentialed catalog (no token)', async () => {
    const credentials = new CredentialRegistry();
    const observations: Array<Record<string, unknown>> = [];
    server = new MusterBridgeServer({
      credentials,
      toolHandler: { handleToolCall: async () => ({ ok: true, result: {} }) },
      onMcpObservation: (obs) => {
        observations.push({ ...obs });
      },
    });
    const { port } = await server.listen();
    const token = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-obs',
      attemptId: 'attempt-1',
      allowedActions: new Set(['workflow_next', 'workflow_fail']),
      ttlMs: 60_000,
    });
    const verified = credentials.verify(token)!;
    const session = await openMcpSession(port, token);
    const listed = await session.request('tools/list');
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['workflow_fail', 'workflow_next']);

    const listObs = observations.filter((o) => o.phase === 'list_tools');
    expect(listObs.length).toBeGreaterThanOrEqual(1);
    const last = listObs[listObs.length - 1]!;
    expect(last).toMatchObject({
      phase: 'list_tools',
      credentialId: verified.credentialId,
      turnId: 'turn-obs',
      attemptId: 'attempt-1',
      generation: 1,
    });
    expect((last.toolNames as string[]).slice().sort()).toEqual(['workflow_fail', 'workflow_next']);
    // Never leak bearer token into observation.
    const serialized = JSON.stringify(last);
    expect(serialized).not.toContain(token);
    expect(last).not.toHaveProperty('token');
  });

  it('concurrent initialize stress does not corrupt the session map', async () => {
    const credentials = new CredentialRegistry();
    server = new MusterBridgeServer({
      credentials,
      toolHandler: { handleToolCall: async () => ({ ok: true, result: {} }) },
    });
    const { port } = await server.listen();

    const openOne = async (turnId: string) => {
      const token = credentials.issue({
        rootId: 'root-1',
        callerTaskId: `task-${turnId}`,
        turnId,
        attemptId: 'a0',
        allowedActions: new Set(['inspect_workflow_run']),
        ttlMs: 60_000,
      });
      const session = await openMcpSession(port, token);
      const listed = await session.request('tools/list');
      const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toEqual(['inspect_workflow_run']);
      return session;
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => openOne(`turn-race-${i}`)),
    );
    expect(results).toHaveLength(8);

    // Existing sessions still work after concurrent setup.
    for (const session of results) {
      const listed = await session.request('tools/list');
      const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toEqual(['inspect_workflow_run']);
    }
  });
});
