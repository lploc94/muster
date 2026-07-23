import { describe, expect, it, afterEach } from 'vitest';
import { CredentialRegistry } from './credentials';
import { formatToolError, MusterBridgeServer } from './server';
import { PUBLIC_MCP_TOOL_ACTIONS } from '../task/capabilities';
import { WORKFLOW_NODE_LABEL_MAX_LENGTH } from '../task/workflow-types';

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

  it('adds actionable hints to invalid semantic workflow errors', () => {
    expect(JSON.parse(formatToolError(JSON.stringify({
      code: 'invalid_workflow_definition',
      message: 'invalid entry contract',
    })))).toEqual({
      code: 'invalid_workflow_definition',
      message: 'invalid entry contract',
      hint: expect.stringContaining('source nodes'),
    });
    expect(JSON.parse(formatToolError(JSON.stringify({
      code: 'invalid_workflow_definition',
      message: 'fan-out not allowed: node intake',
    })))).toEqual({
      code: 'invalid_workflow_definition',
      message: 'fan-out not allowed: node intake',
      hint: expect.stringContaining('A -> C and B -> C'),
    });
    expect(JSON.parse(formatToolError('incomplete entry inputs'))).toEqual({
      code: 'invalid_workflow_inputs',
      message: 'incomplete entry inputs',
      hint: expect.stringContaining('exact source nodeKey and input name'),
    });
    expect(JSON.parse(formatToolError('definition fingerprint conflict'))).toEqual({
      code: 'workflow_key_conflict',
      message: 'definition fingerprint conflict',
      hint: expect.stringContaining('new unique workflowKey'),
    });
    expect(JSON.parse(formatToolError('operation fingerprint conflict'))).toEqual({
      code: 'workflow_definition_retry_conflict',
      message: 'operation fingerprint conflict',
      hint: expect.stringContaining('identical name/nodes/edges/inputs'),
    });
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
      description: expect.stringContaining('REQUIRED for user-facing plans'),
    });
    expect(tools[0].inputSchema).toMatchObject({
      required: ['documentKey', 'title', 'markdown'],
      additionalProperties: false,
    });

    const called = await coordinator.request('tools/call', {
      name: 'upsert_presentation',
      arguments: {
        documentKey: 'release-notes',
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
      command: {
        kind: 'upsert_presentation',
        presentationId: expect.stringMatching(/^presentation-/),
        ownerTaskId: 'task-1',
      },
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
          if (tool === 'define_workflow') {
            return {
              ok: true,
              result: {
                ok: true,
                changed: true,
                definitionId: 'wf-one',
                version: 3,
                fingerprint: 'internal-definition-fingerprint',
              },
            };
          }
          return {
            ok: true,
            result: {
              ok: true,
              changed: true,
              definitionId: 'wf-one',
               version: 3,
               runId: 'run-secret-coordinates-hidden',
               entryTaskId: 'task-internal',
               entryGateId: 'gate-internal',
             },
          };
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
          description?: string;
          properties?: Record<string, { description?: string; properties?: Record<string, unknown> }>;
        };
      }>;
    }).tools;
    const names = workflowTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['define_workflow', 'start_workflow']));
    const defineTool = workflowTools.find((tool) => tool.name === 'define_workflow');
    expect(defineTool?.description).toContain('Use only this public shape');
    expect(defineTool?.description).toContain('CORRECT one-node');
    expect(defineTool?.description).toContain('CORRECT parallel fan-in');
    expect(defineTool?.description).toContain('INCORRECT internal parameters');
    expect(defineTool?.description).toContain('INCORRECT fan-out');
    expect(defineTool?.description).toContain('INCORRECT downstream input');
    expect(defineTool?.description).toContain('Retries for the same key in one turn must repeat identical');
    expect(defineTool?.description).toContain('Never send internal fields');
    expect(defineTool?.inputSchema).toMatchObject({
      required: ['workflowKey', 'name', 'nodes'],
      additionalProperties: false,
      properties: {
        nodes: {
          items: {
            properties: {
              label: { maxLength: WORKFLOW_NODE_LABEL_MAX_LENGTH },
            },
          },
        },
      },
    });
    expect(defineTool?.inputSchema.description).toContain('A -> C and B -> C');
    expect(defineTool?.inputSchema.description).toContain('Required: workflowKey, name, nodes');
    expect(defineTool?.inputSchema.properties?.edges?.description).toContain('each from node may appear at most once');
    expect(defineTool?.inputSchema.properties?.inputs?.description).toContain('no value belongs here');
    expect(defineTool?.inputSchema.properties).not.toHaveProperty('policy');
    expect(defineTool?.inputSchema.properties).not.toHaveProperty('opId');
     const startTool = workflowTools.find((tool) => tool.name === 'start_workflow');
     expect(startTool?.description).toContain('exactly one value for every input');
     expect(startTool?.description).toContain('resumes the caller exactly once');
    expect(startTool?.inputSchema.properties?.inputs?.description).toContain('exactly match');

    const defined = await session.request('tools/call', {
      name: 'define_workflow',
      arguments: {
        workflowKey: 'wf-one',
        name: 'one-node',
        nodes: [{ nodeKey: 'entry', taskType: 'implement' }],
      },
    });
    expect(defined.result).not.toHaveProperty('isError', true);
    expect(defined.result).toMatchObject({
      content: [{
        type: 'text',
        text: JSON.stringify({
          workflowRef: 'wf-one@3',
          workflowKey: 'wf-one',
          revision: 3,
          changed: true,
          replay: false,
        }),
      }],
    });
    expect(handled[0]).toMatchObject({ tool: 'define_workflow', command: { kind: 'define_workflow' } });

    const badStart = await session.request('tools/call', {
      name: 'start_workflow',
      arguments: { opId: 'op-start', definitionId: 'wf-one', version: 1 },
    });
    expect(badStart.result).toMatchObject({ isError: true });
    expect(handled).toHaveLength(1);

    const started = await session.request('tools/call', {
      name: 'start_workflow',
      arguments: { workflow: 'wf-one@3', inputs: [] },
    });
    expect(started.result).toMatchObject({
      content: [{
        type: 'text',
        text: JSON.stringify({
          runRef: 'run-secret-coordinates-hidden',
           workflowRef: 'wf-one@3',
           replay: false,
           status: 'accepted',
         }),
      }],
    });
    expect((started.result as { content: Array<{ text: string }> }).content[0]!.text)
      .not.toContain('entryTaskId');

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
          if (tool === 'inspect_workflow_run') {
            return {
              ok: true,
              result: {
                runId: 'wfr-1',
                definitionId: 'review-flow',
                definitionVersion: 2,
                runStatus: 'running',
                policy: { maxDepth: 8 },
                nodes: [{ nodeId: 'review', status: 'running' }],
                gates: [{ gateId: 'gate-internal', status: 'satisfied' }],
                activations: [{
                  activationId: 'activation-internal',
                  nodeId: 'review',
                  kind: 'dependency_gate',
                  status: 'running',
                }],
                feedbackRounds: [],
                continuations: [],
                diagnostics: [],
              },
            };
          }
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
      tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    }).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(PUBLIC_MCP_TOOL_ACTIONS);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.inputSchema).toHaveProperty('description');
    }
    expect(tools.find((tool) => tool.name === 'inspect_workflow_run')).toMatchObject({
      description: expect.stringContaining('recovery and diagnosis'),
      inputSchema: {
        required: ['runRef'],
        additionalProperties: false,
      },
    });
    const inspected = await coordinator.request('tools/call', {
      name: 'inspect_workflow_run',
      arguments: { runRef: 'wfr-1' },
    });
    expect(inspected.result).not.toHaveProperty('isError', true);
    const inspectedText = (inspected.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(inspectedText)).toEqual({
      runRef: 'wfr-1',
      workflowRef: 'review-flow@2',
      status: 'running',
      nodes: [{ node: 'review', status: 'running' }],
      activations: [{ node: 'review', kind: 'dependency_gate', status: 'running' }],
      feedback: [],
      children: [],
      diagnostics: [],
    });
    expect(inspectedText).not.toContain('gate-internal');
    expect(inspectedText).not.toContain('maxDepth');
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

  it('accepts a workflow message larger than the default Express 100 KiB parser limit', async () => {
    const credentials = new CredentialRegistry();
    const handled: unknown[] = [];
    server = new MusterBridgeServer({
      credentials,
      toolHandler: {
        handleToolCall: async (_ctx, _tool, command) => {
          handled.push(command);
          return { ok: true, result: {} };
        },
      },
    });
    const { port } = await server.listen();
    const token = credentials.issue({
      rootId: 'r',
      callerTaskId: 't',
      turnId: 'turn-large',
      attemptId: 'a0',
      allowedActions: new Set(['workflow_next']),
      ttlMs: 60_000,
    });
    const session = await openMcpSession(port, token);
    const message = 'x'.repeat(150_000);
    const response = await session.request('tools/call', {
      name: 'workflow_next',
      arguments: { message },
    });
    expect(response.result).not.toMatchObject({ isError: true });
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ kind: 'workflow_next', message });
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
