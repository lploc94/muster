import { describe, expect, it, afterEach } from 'vitest';
import { CredentialRegistry } from './credentials';
import { MusterBridgeServer } from './server';

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
      allowedActions: new Set(['upsert_presentation']),
      ttlMs: 60_000,
    });
    const coordinator = await openMcpSession(port, coordinatorToken);

    const listed = await coordinator.request('tools/list');
    const tools = (listed.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['upsert_presentation']);
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