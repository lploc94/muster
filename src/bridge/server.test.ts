import { describe, expect, it, afterEach } from 'vitest';
import { CredentialRegistry } from './credentials';
import { formatToolError, MusterBridgeServer } from './server';
import { DEFAULT_WORKFLOW_POLICY } from '../task/workflow';

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
      allowedActions: new Set(['complete_task']),
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
    const names = (listed.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['define_workflow', 'start_workflow']));

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
      allowedActions: new Set(['complete_task']),
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

  it('exposes batch tools only to create_child coordinators and rejects malformed batches', async () => {
    const credentials = new CredentialRegistry();
    const handled: Array<{ tool: string; command: unknown }> = [];
    server = new MusterBridgeServer({
      credentials,
      toolHandler: {
        handleToolCall: async (_ctx, tool, command) => {
          handled.push({ tool, command });
          return { ok: true, result: { taskIds: ['task-a'], turnIds: [] } };
        },
      },
    });
    const { port } = await server.listen();
    const coordinatorToken = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-coordinator',
      attemptId: 'a0',
      allowedActions: new Set(['create_tasks', 'delegate_tasks']),
      ttlMs: 60_000,
    });
    const coordinator = await openMcpSession(port, coordinatorToken);

    const listed = await coordinator.request('tools/list');
    const tools = (listed.result as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    }).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('create_tasks');
    expect(names).toContain('delegate_tasks');
    const batchSchema = tools.find((tool) => tool.name === 'create_tasks')!.inputSchema;
    expect(batchSchema).toMatchObject({
      required: ['opId', 'tasks'],
      additionalProperties: false,
    });
    expect((batchSchema.properties as { tasks: { maxItems: number } }).tasks.maxItems).toBe(16);

    // Valid single-item batch reaches the handler.
    const ok = await coordinator.request('tools/call', {
      name: 'create_tasks',
      arguments: {
        opId: 'op-1',
        tasks: [{ localId: 'a', goal: 'child', taskType: 'worker' }],
      },
    });
    expect(ok.result).not.toHaveProperty('isError', true);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ tool: 'create_tasks', command: { kind: 'create_tasks' } });

    // Over-cap batch is rejected in dispatch before ever reaching the handler.
    const overCap = await coordinator.request('tools/call', {
      name: 'create_tasks',
      arguments: {
        opId: 'op-2',
        tasks: Array.from({ length: 17 }, (_, i) => ({
          localId: `t${i}`,
          goal: 'x',
          taskType: 'worker',
        })),
      },
    });
    expect(overCap.result).toMatchObject({ isError: true });
    expect(handled).toHaveLength(1);

    // Workers never see the batch tools.
    const workerToken = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'worker-1',
      turnId: 'turn-worker',
      attemptId: 'a0',
      allowedActions: new Set(['complete_task']),
      ttlMs: 60_000,
    });
    const worker = await openMcpSession(port, workerToken);
    const workerListed = await worker.request('tools/list');
    const workerNames = (workerListed.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(workerNames).not.toContain('create_tasks');
    expect(workerNames).not.toContain('delegate_tasks');
  });

  it('round-trips brief.skills through create_task and create_tasks child specs', async () => {
    const credentials = new CredentialRegistry();
    const handled: Array<{ tool: string; command: unknown }> = [];
    server = new MusterBridgeServer({
      credentials,
      toolHandler: {
        handleToolCall: async (_ctx, tool, command) => {
          handled.push({ tool, command });
          return {
            ok: true,
            result: { taskId: 'task-a', turnId: 't1', taskIds: ['task-a'], turnIds: [] },
          };
        },
      },
    });
    const { port } = await server.listen();
    const token = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-coordinator',
      attemptId: 'a0',
      allowedActions: new Set(['create_task', 'create_tasks']),
      ttlMs: 60_000,
    });
    const coordinator = await openMcpSession(port, token);

    // Schema advertises `skills` under the brief object.
    const listed = await coordinator.request('tools/list');
    const tools = (listed.result as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    }).tools;
    const createSchema = tools.find((tool) => tool.name === 'create_task')!.inputSchema;
    const briefProps = (
      (createSchema.properties as { brief: { properties: Record<string, unknown> } }).brief
    ).properties;
    expect(briefProps).toHaveProperty('skills');

    const created = await coordinator.request('tools/call', {
      name: 'create_task',
      arguments: {
        opId: 'op-1',
        goal: 'implement',
        taskType: 'worker',
        brief: { kind: 'implement', skills: ['plan', 'review'] },
      },
    });
    expect(created.result).not.toHaveProperty('isError', true);
    expect(handled[0]).toMatchObject({
      tool: 'create_task',
      command: { kind: 'create_task', spec: { brief: { skills: ['plan', 'review'] } } },
    });

    const batch = await coordinator.request('tools/call', {
      name: 'create_tasks',
      arguments: {
        opId: 'op-2',
        tasks: [{ localId: 'a', goal: 'child', taskType: 'worker', brief: { skills: ['plan'] } }],
      },
    });
    expect(batch.result).not.toHaveProperty('isError', true);
    expect(handled[1]).toMatchObject({
      tool: 'create_tasks',
      command: { kind: 'create_tasks', specs: [{ brief: { skills: ['plan'] } }] },
    });
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
      allowedActions: new Set(['ask_user']),
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
      allowedActions: new Set(['complete_task', 'fail_task']),
      ttlMs: 60_000,
    });
    const verified = credentials.verify(token)!;
    const session = await openMcpSession(port, token);
    const listed = await session.request('tools/list');
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['complete_task', 'fail_task']);

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
    expect((last.toolNames as string[]).slice().sort()).toEqual(['complete_task', 'fail_task']);
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
        allowedActions: new Set(['get_task_status']),
        ttlMs: 60_000,
      });
      const session = await openMcpSession(port, token);
      const listed = await session.request('tools/list');
      const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toEqual(['get_task_status']);
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
      expect(tools.map((t) => t.name)).toEqual(['get_task_status']);
    }
  });
});
