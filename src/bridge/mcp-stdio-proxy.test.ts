import { afterEach, describe, expect, it } from 'vitest';
import { createFakeMcpBridge } from './mcp-fault-fixture.testkit';
import {
  MusterStdioMcpProxy,
  createBridgePostFromFake,
  loadProxyEnvConfig,
  redactSecrets,
  type ProxyDebugSnapshot,
  type ProxyPhase,
} from './mcp-stdio-proxy';
import { MUSTER_BRIDGE_TOKEN_ENV, MUSTER_BRIDGE_URL_ENV } from './mcp-config';
import { CredentialRegistry } from './credentials';
import { MusterBridgeServer } from './server';

const SECRET = 'tok-super-secret-never-log-me';

function snapshotJson(snap: ProxyDebugSnapshot): string {
  return JSON.stringify(snap);
}

describe('loadProxyEnvConfig', () => {
  it('reads MUSTER_BRIDGE_URL and MUSTER_BRIDGE_TOKEN', () => {
    const cfg = loadProxyEnvConfig({
      [MUSTER_BRIDGE_URL_ENV]: 'http://127.0.0.1:9999/mcp',
      [MUSTER_BRIDGE_TOKEN_ENV]: SECRET,
    });
    expect(cfg.bridgeUrl).toBe('http://127.0.0.1:9999/mcp');
    expect(cfg.token).toBe(SECRET);
  });

  it('throws a stable error when env is missing (message has no secret)', () => {
    expect(() => loadProxyEnvConfig({ [MUSTER_BRIDGE_TOKEN_ENV]: SECRET })).toThrow(
      /MUSTER_BRIDGE_URL/,
    );
    expect(() => loadProxyEnvConfig({ [MUSTER_BRIDGE_URL_ENV]: 'http://x/mcp' })).toThrow(
      /MUSTER_BRIDGE_TOKEN/,
    );
  });
});

describe('redactSecrets', () => {
  it('strips bearer token substrings from diagnostic text', () => {
    const raw = `Authorization: Bearer ${SECRET}; failed upstream ${SECRET}`;
    const redacted = redactSecrets(raw, SECRET);
    expect(redacted).not.toContain(SECRET);
    expect(redacted.toLowerCase()).toContain('redacted');
  });
});

describe('MusterStdioMcpProxy against FakeMcpBridge', () => {
  let proxy: MusterStdioMcpProxy | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  it('initialize + tools/list succeed and expose ready debug snapshot without token', async () => {
    const bridge = createFakeMcpBridge({
      tools: [{ name: 'get_host_context', description: 'context' }],
    });
    const logs: string[] = [];
    proxy = new MusterStdioMcpProxy({
      bridgeUrl: 'http://127.0.0.1:0/mcp',
      token: SECRET,
      bridgePost: createBridgePostFromFake(bridge),
      log: (line) => logs.push(line),
      sleep: async () => {},
    });

    await proxy.ensureUpstream();
    const listed = await proxy.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['get_host_context']);

    const snap = proxy.getDebugSnapshot();
    expect(snap.phase).toBe('ready' satisfies ProxyPhase);
    expect(snap.hasSession).toBe(true);
    expect(snapshotJson(snap)).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(snap.bridgeHost).toBe('127.0.0.1');
  });

  it('tools/call forwards to upstream and returns MCP content', async () => {
    const bridge = createFakeMcpBridge({
      tools: [{ name: 'get_host_context' }],
    });
    bridge.setToolResult('get_host_context', { ok: true, trusted: true });
    proxy = new MusterStdioMcpProxy({
      bridgeUrl: 'http://127.0.0.1:0/mcp',
      token: SECRET,
      bridgePost: createBridgePostFromFake(bridge),
      sleep: async () => {},
    });

    await proxy.ensureUpstream();
    const result = await proxy.callTool({ name: 'get_host_context', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text?: string }>)[0]?.text;
    expect(text).toContain('trusted');
  });

  it('mid-run connection flap triggers one coalesced reconnect series then retries', async () => {
    const bridge = createFakeMcpBridge({
      tools: [{ name: 'inspect_workflow_run' }],
    });
    let now = 1_000;
    const basePost = createBridgePostFromFake(bridge);
    let listCalls = 0;

    proxy = new MusterStdioMcpProxy({
      bridgeUrl: 'http://127.0.0.1:0/mcp',
      token: SECRET,
      maxReconnectAttempts: 4,
      reconnectDeadlineMs: 10_000,
      reconnectBaseDelayMs: 1,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      bridgePost: async (req) => {
        if (req.method === 'tools/list') {
          listCalls += 1;
          if (listCalls === 1) {
            const err = new Error('fetch failed: read ECONNRESET') as Error & { code?: string };
            err.code = 'ECONNRESET';
            throw err;
          }
        }
        return basePost(req);
      },
    });

    await proxy.ensureUpstream();
    expect(proxy.getDebugSnapshot().phase).toBe('ready');
    expect(proxy.getDebugSnapshot().reconnectGeneration).toBe(0);

    const listed = await proxy.listTools();
    expect(listed.tools.some((t) => t.name === 'inspect_workflow_run')).toBe(true);

    const snap = proxy.getDebugSnapshot();
    expect(snap.phase).toBe('ready');
    expect(snap.reconnectAttemptCount).toBeGreaterThanOrEqual(1);
    expect(snap.reconnectGeneration).toBe(1);
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(snapshotJson(snap)).not.toContain(SECRET);
  });

  it('concurrent failures share a single reconnect generation (single-flight)', async () => {
    const bridge = createFakeMcpBridge({
      tools: [{ name: 'a' }, { name: 'b' }],
    });
    let now = 5_000;
    let upstreamInits = 0;
    let failRemaining = 2; // first two list ops fail transiently
    const basePost = createBridgePostFromFake(bridge);

    proxy = new MusterStdioMcpProxy({
      bridgeUrl: 'http://127.0.0.1:0/mcp',
      token: SECRET,
      maxReconnectAttempts: 3,
      reconnectDeadlineMs: 10_000,
      reconnectBaseDelayMs: 5,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      bridgePost: async (req) => {
        if (req.method === 'initialize') {
          upstreamInits += 1;
        }
        if (req.method === 'tools/list' && failRemaining > 0) {
          failRemaining -= 1;
          const err = new Error('socket hang up') as Error & { code?: string };
          err.code = 'ECONNRESET';
          throw err;
        }
        return basePost(req);
      },
    });

    await proxy.ensureUpstream();
    const initsAfterReady = upstreamInits;

    const [r1, r2] = await Promise.all([proxy.listTools(), proxy.listTools()]);
    expect(r1.tools.length).toBe(2);
    expect(r2.tools.length).toBe(2);

    const snap = proxy.getDebugSnapshot();
    // One coalesced reconnect series (generation +1), not two independent series.
    expect(snap.reconnectGeneration).toBe(1);
    // initialize once for initial connect + once for the single reconnect series
    expect(upstreamInits - initsAfterReady).toBe(1);
  });

  it('bounded retry exhaustion surfaces stable failed phase without token', async () => {
    let now = 0;
    proxy = new MusterStdioMcpProxy({
      bridgeUrl: 'http://127.0.0.1:0/mcp',
      token: SECRET,
      maxReconnectAttempts: 2,
      reconnectDeadlineMs: 1_000,
      reconnectBaseDelayMs: 1,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      bridgePost: async () => {
        const err = new Error(`connect ECONNREFUSED token=${SECRET}`) as Error & { code?: string };
        err.code = 'ECONNREFUSED';
        throw err;
      },
    });

    await expect(proxy.ensureUpstream()).rejects.toThrow(/reconnect|upstream|exhausted|ECONNREFUSED/i);
    const snap = proxy.getDebugSnapshot();
    expect(snap.phase).toBe('failed');
    expect(snap.reconnectAttemptCount).toBeGreaterThanOrEqual(1);
    expect(snapshotJson(snap)).not.toContain(SECRET);
    if (snap.lastErrorMessage) {
      expect(snap.lastErrorMessage).not.toContain(SECRET);
    }
  });

  it('argv/env contract: token is never read from process.argv', async () => {
    const argv = process.argv.join(' ');
    expect(argv).not.toContain(SECRET);
    proxy = new MusterStdioMcpProxy({
      bridgeUrl: 'http://127.0.0.1:1/mcp',
      token: SECRET,
      bridgePost: createBridgePostFromFake(createFakeMcpBridge()),
      sleep: async () => {},
    });
    expect(process.argv.join(' ')).not.toContain(SECRET);
  });
});

describe('MusterStdioMcpProxy against loopback MusterBridgeServer', () => {
  let server: MusterBridgeServer | undefined;
  let proxy: MusterStdioMcpProxy | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    await server?.close();
    server = undefined;
  });

  it('initialize/list against real HTTP bridge; mid-run flap reconnects once', async () => {
    const credentials = new CredentialRegistry();
    const token = credentials.issue({
      rootId: 'r1',
      callerTaskId: 't1',
      turnId: 'turn-1',
      attemptId: 'a0',
      allowedActions: new Set(['get_host_context', 'inspect_workflow_run']),
      ttlMs: 60_000,
    });

    server = new MusterBridgeServer({
      credentials,
      toolHandler: {
        handleToolCall: async () => ({ ok: true, result: { ok: true } }),
      },
    });
    const { port } = await server.listen();
    const url = `http://127.0.0.1:${port}/mcp`;

    // Happy path against real bridge.
    proxy = new MusterStdioMcpProxy({
      bridgeUrl: url,
      token,
      maxReconnectAttempts: 5,
      reconnectDeadlineMs: 8_000,
      reconnectBaseDelayMs: 20,
    });

    await proxy.ensureUpstream();
    const first = await proxy.listTools();
    expect(first.tools.map((t) => t.name).sort()).toEqual(
      ['get_host_context', 'inspect_workflow_run'].sort(),
    );
    expect(proxy.getDebugSnapshot().phase).toBe('ready');
    await proxy.close();
    proxy = undefined;

    // Mid-run flap: fail the first tools/list POST, then succeed via real fetch.
    let failedOnce = false;
    const realFetch = globalThis.fetch.bind(globalThis);
    proxy = new MusterStdioMcpProxy({
      bridgeUrl: url,
      token,
      maxReconnectAttempts: 5,
      reconnectDeadlineMs: 8_000,
      reconnectBaseDelayMs: 15,
      fetchImpl: async (input, init) => {
        if (!failedOnce && typeof input === 'string' && init?.method === 'POST') {
          const body = String(init.body ?? '');
          if (body.includes('"method":"tools/list"') || body.includes('"method": "tools/list"')) {
            failedOnce = true;
            throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
          }
        }
        return realFetch(input as RequestInfo, init);
      },
    });

    await proxy.ensureUpstream();
    const listed = await proxy.listTools();
    expect(listed.tools.length).toBeGreaterThan(0);
    const snap = proxy.getDebugSnapshot();
    expect(snap.phase).toBe('ready');
    expect(snap.reconnectAttemptCount).toBeGreaterThanOrEqual(1);
    expect(snap.reconnectGeneration).toBe(1);
    expect(JSON.stringify(snap)).not.toContain(token);
  });
});
