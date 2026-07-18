import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from './credentials';
import {
  McpReadinessSupervisor,
  type McpReadinessResult,
  type ReadinessObservation,
} from './mcp-readiness';
import { MusterBridgeServer } from './server';

function obs(partial: Partial<ReadinessObservation> & Pick<ReadinessObservation, 'turnId' | 'attemptId'>): ReadinessObservation {
  return {
    phase: 'list_tools',
    toolNames: ['create_task', 'complete_task'],
    credentialId: 'cred-1',
    generation: 1,
    timestamp: Date.now(),
    ...partial,
  };
}

function expectReady(
  result: McpReadinessResult,
  expected: { turnId: string; attemptId: string; generation: number; toolNames: string[] },
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.turnId).toBe(expected.turnId);
  expect(result.attemptId).toBe(expected.attemptId);
  expect(result.generation).toBe(expected.generation);
  expect([...result.toolNames].sort()).toEqual([...expected.toolNames].sort());
}

function expectFail(result: McpReadinessResult, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.message.length).toBeGreaterThan(0);
}

describe('McpReadinessSupervisor', () => {
  it('returns ready on exact catalog (order-independent)', () => {
    const sup = new McpReadinessSupervisor();
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a1',
      expectedToolNames: ['complete_task', 'create_task'],
      bridgeGeneration: 1,
    });
    sup.recordObservation(
      obs({
        turnId: 't1',
        attemptId: 'a1',
        // reverse order + duplicate should still exact-match unique set
        toolNames: ['create_task', 'complete_task', 'create_task'],
        generation: 1,
      }),
    );
    const result = sup.evaluate('t1', 'a1', 1);
    expectReady(result, {
      turnId: 't1',
      attemptId: 'a1',
      generation: 1,
      toolNames: ['complete_task', 'create_task'],
    });
  });

  it('rejects wrong_catalog when observed names miss or add tools', () => {
    const sup = new McpReadinessSupervisor();
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a1',
      expectedToolNames: new Set(['create_task', 'complete_task']),
      bridgeGeneration: 1,
    });
    // missing complete_task, extra fail_task
    sup.recordObservation(
      obs({
        turnId: 't1',
        attemptId: 'a1',
        toolNames: ['create_task', 'fail_task'],
        generation: 1,
      }),
    );
    expectFail(sup.evaluate('t1', 'a1', 1), 'wrong_catalog');
  });

  it('rejects stale_attempt for late observation after beginAttempt advanced', () => {
    const sup = new McpReadinessSupervisor();
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a1',
      expectedToolNames: ['create_task'],
      bridgeGeneration: 1,
    });
    // supersede with attempt a2
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a2',
      expectedToolNames: ['create_task', 'complete_task'],
      bridgeGeneration: 1,
    });
    // late report for a1
    sup.recordObservation(
      obs({
        turnId: 't1',
        attemptId: 'a1',
        toolNames: ['create_task'],
        generation: 1,
      }),
    );
    // a1 evaluate is stale
    expectFail(sup.evaluate('t1', 'a1', 1), 'stale_attempt');
    // a2 still missing evidence (late obs ignored)
    expectFail(sup.evaluate('t1', 'a2', 1), 'missing_evidence');
  });

  it('generation bump invalidates prior ready evidence', () => {
    const sup = new McpReadinessSupervisor();
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a1',
      expectedToolNames: ['create_task'],
      bridgeGeneration: 1,
    });
    sup.recordObservation(
      obs({
        turnId: 't1',
        attemptId: 'a1',
        toolNames: ['create_task'],
        generation: 1,
      }),
    );
    expectReady(sup.evaluate('t1', 'a1', 1), {
      turnId: 't1',
      attemptId: 'a1',
      generation: 1,
      toolNames: ['create_task'],
    });

    // bridge restart
    sup.noteBridgeGeneration(2);
    const afterBump = sup.evaluate('t1', 'a1', 2);
    // generation_mismatch or missing_evidence — taxonomy prefers generation_mismatch when evidence exists at old gen
    expect(afterBump.ok).toBe(false);
    if (!afterBump.ok) {
      expect(['generation_mismatch', 'missing_evidence']).toContain(afterBump.code);
    }

    // evaluate with old generation also fails
    expectFail(sup.evaluate('t1', 'a1', 1), 'generation_mismatch');
  });

  it('returns missing_evidence when never listed', () => {
    const sup = new McpReadinessSupervisor();
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a1',
      expectedToolNames: ['create_task'],
      bridgeGeneration: 1,
    });
    expectFail(sup.evaluate('t1', 'a1', 1), 'missing_evidence');
  });

  it('records generation_mismatch on observation with wrong generation', () => {
    const sup = new McpReadinessSupervisor();
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a1',
      expectedToolNames: ['create_task'],
      bridgeGeneration: 2,
    });
    sup.recordObservation(
      obs({
        turnId: 't1',
        attemptId: 'a1',
        toolNames: ['create_task'],
        generation: 1, // stale bridge gen
      }),
    );
    expectFail(sup.evaluate('t1', 'a1', 2), 'generation_mismatch');
  });

  it('returns not_initialized when evaluate called without beginAttempt', () => {
    const sup = new McpReadinessSupervisor();
    expectFail(sup.evaluate('t1', 'a1', 1), 'not_initialized');
  });

  it('initialize observation alone does not satisfy catalog readiness', () => {
    const sup = new McpReadinessSupervisor();
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a1',
      expectedToolNames: ['create_task'],
      bridgeGeneration: 1,
    });
    sup.recordObservation({
      phase: 'initialize',
      credentialId: 'cred-1',
      turnId: 't1',
      attemptId: 'a1',
      generation: 1,
      timestamp: Date.now(),
    });
    expectFail(sup.evaluate('t1', 'a1', 1), 'missing_evidence');
  });

  it('getDebugSnapshot exposes live attempt without tokens', () => {
    const sup = new McpReadinessSupervisor();
    sup.beginAttempt({
      turnId: 't1',
      attemptId: 'a1',
      expectedToolNames: ['create_task'],
      bridgeGeneration: 1,
    });
    const snap = sup.getDebugSnapshot();
    expect(JSON.stringify(snap)).not.toMatch(/Bearer|token/i);
    expect(snap.turns['t1']?.liveAttemptId).toBe('a1');
    expect(snap.bridgeGeneration).toBe(1);
  });
});

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

describe('MCP readiness supervisor and bridge instrumentation (M017-S04 / D037)', () => {
  let server: MusterBridgeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('drives ready, wrong_catalog, stale_attempt, generation invalidation, and /health', async () => {
    const credentials = new CredentialRegistry();
    const supervisor = new McpReadinessSupervisor();
    server = new MusterBridgeServer({
      credentials,
      toolHandler: { handleToolCall: async () => ({ ok: true, result: {} }) },
      onMcpObservation: (obs) => {
        supervisor.recordObservation(obs);
      },
    });
    const { port } = await server.listen();
    supervisor.noteBridgeGeneration(server.getGeneration());

    // --- ready path: matching expected catalog via authenticated tools/list ---
    const expectedReady = ['complete_task', 'fail_task'] as const;
    supervisor.beginAttempt({
      turnId: 'turn-a',
      attemptId: 'attempt-a',
      expectedToolNames: expectedReady,
      bridgeGeneration: server.getGeneration(),
    });
    const tokenA = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-a',
      attemptId: 'attempt-a',
      allowedActions: new Set(expectedReady),
      ttlMs: 60_000,
    });
    const sessionA = await openMcpSession(port, tokenA);
    await sessionA.request('tools/list');
    const ready = supervisor.evaluate('turn-a', 'attempt-a', server.getGeneration());
    expectReady(ready, {
      turnId: 'turn-a',
      attemptId: 'attempt-a',
      generation: server.getGeneration(),
      toolNames: [...expectedReady],
    });

    // --- wrong_catalog: expected set larger than credentialed/observed set ---
    supervisor.beginAttempt({
      turnId: 'turn-wrong',
      attemptId: 'attempt-wrong',
      expectedToolNames: ['complete_task', 'fail_task', 'get_task_status'],
      bridgeGeneration: server.getGeneration(),
    });
    const tokenWrong = credentials.issue({
      rootId: 'root-1',
      callerTaskId: 'task-wrong',
      turnId: 'turn-wrong',
      attemptId: 'attempt-wrong',
      // observed catalog will be only complete_task
      allowedActions: new Set(['complete_task']),
      ttlMs: 60_000,
    });
    const sessionWrong = await openMcpSession(port, tokenWrong);
    await sessionWrong.request('tools/list');
    expectFail(
      supervisor.evaluate('turn-wrong', 'attempt-wrong', server.getGeneration()),
      'wrong_catalog',
    );

    // --- stale_attempt: supersede attempt A, late observation for A is ignored ---
    supervisor.beginAttempt({
      turnId: 'turn-stale',
      attemptId: 'attempt-1',
      expectedToolNames: ['complete_task'],
      bridgeGeneration: server.getGeneration(),
    });
    supervisor.beginAttempt({
      turnId: 'turn-stale',
      attemptId: 'attempt-2',
      expectedToolNames: ['complete_task', 'fail_task'],
      bridgeGeneration: server.getGeneration(),
    });
    // Late observation for superseded attempt-1 (observer injection).
    supervisor.recordObservation({
      phase: 'list_tools',
      toolNames: ['complete_task'],
      credentialId: 'late-cred',
      turnId: 'turn-stale',
      attemptId: 'attempt-1',
      generation: server.getGeneration(),
      timestamp: Date.now(),
    });
    expectFail(
      supervisor.evaluate('turn-stale', 'attempt-1', server.getGeneration()),
      'stale_attempt',
    );
    // Live attempt-2 still missing real list_tools evidence.
    expectFail(
      supervisor.evaluate('turn-stale', 'attempt-2', server.getGeneration()),
      'missing_evidence',
    );

    // --- generation bump invalidates prior ready evidence ---
    const genBefore = server.getGeneration();
    expect(ready.ok).toBe(true);
    await server.close();
    const { port: port2 } = await server.listen();
    expect(server.getGeneration()).toBe(genBefore + 1);
    supervisor.noteBridgeGeneration(server.getGeneration());
    const afterRestart = supervisor.evaluate('turn-a', 'attempt-a', server.getGeneration());
    expect(afterRestart.ok).toBe(false);
    if (!afterRestart.ok) {
      expect(['generation_mismatch', 'missing_evidence']).toContain(afterRestart.code);
    }

    // --- GET /health returns status+generation; no TaskStore I/O path ---
    const healthRes = await fetch(`http://127.0.0.1:${port2}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      status: string;
      generation: number;
      port?: number;
    };
    expect(health).toMatchObject({
      status: 'ok',
      generation: server.getGeneration(),
      port: port2,
    });
    // Health is unauthenticated (no WWW-Authenticate challenge).
    expect(healthRes.headers.get('www-authenticate')).toBeNull();
    // Diagnostics never leak bearer tokens.
    const snap = supervisor.getDebugSnapshot();
    expect(JSON.stringify(snap)).not.toContain(tokenA);
    expect(JSON.stringify(snap)).not.toMatch(/Bearer/i);
  });
});
