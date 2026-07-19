import { spawn } from 'child_process';
import * as path from 'path';
import { AskBridge } from '../src/bridge/ask-bridge';
import { CredentialRegistry } from '../src/bridge/credentials';
import { MusterBridgeServer } from '../src/bridge/server';
import { deriveEntityId } from '../src/task/engine-graph';
import { TaskEngine } from '../src/task/engine';
import { parseTaskTypeRegistry } from '../src/task/task-types';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../src/types';
import { openScriptEngine } from './sqlite-engine-harness';

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

async function runBridgeToolAgent(url: string, token: string, script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(__dirname, 'fixtures/bridge-tool-agent.ts')],
      {
        env: {
          ...process.env,
          MUSTER_BRIDGE_URL: url,
          MUSTER_BRIDGE_TOKEN: token,
          MUSTER_TOOL_SCRIPT: script,
        },
        stdio: 'inherit',
      },
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`agent exit ${code}`))));
  });
}

async function main(): Promise<void> {
  const credentials = new CredentialRegistry();
  const askBridge = new AskBridge({
    onRegister: (ref) => {
      setTimeout(() => {
        askBridge.submit(ref, { '0': { selected: ['yes'], freeText: null } });
      }, 50);
    },
  });

  let injectedMcp = false;
  let coordInitialRan = false;
  let coordContinuationRan = false;
  let childAgentRan = false;

  const backend: Backend = {
    name: 'grok',
    capabilities: MCP_CAPS,
    async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
      const bridgeEntry = options.mcpServers?.find((s) => s.name === 'muster_bridge');
      // ACP injection is stdio-only (M017-S07): secrets travel only via env.
      let bridgeUrl: string | undefined;
      let token: string | undefined;
      if (bridgeEntry?.type === 'stdio') {
        const envPairs = bridgeEntry.env ?? [];
        bridgeUrl = envPairs.find((e) => e.name === 'MUSTER_BRIDGE_URL')?.value;
        token = envPairs.find((e) => e.name === 'MUSTER_BRIDGE_TOKEN')?.value;
        // Invariant 10: argv of the emitted spawn must not carry the token.
        if (token && JSON.stringify(bridgeEntry.args ?? []).includes(token)) {
          throw new Error('stdio muster_bridge argv leaked MUSTER_BRIDGE_TOKEN');
        }
      } else if (bridgeEntry) {
        throw new Error(
          `expected stdio muster_bridge after M017-S07, got type=${bridgeEntry.type}`,
        );
      }

      if (bridgeUrl && token) {
        injectedMcp = true;
        const isChild = options.prompt.includes('child work');
        const isContinuation = options.prompt.includes('[child_results]');
        // Smoke fixture talks HTTP to the bridge with the same env the stdio
        // proxy would receive; full proxy-process spawn is covered by the D037
        // provider contract suite (mcp-provider-contract.test.ts).
        if (isChild) {
          await runBridgeToolAgent(
            bridgeUrl,
            token,
            JSON.stringify([
              { tool: 'complete_task', args: { opId: 'c1', result: 'child done' } },
            ]),
          );
          childAgentRan = true;
        } else if (isContinuation) {
          await runBridgeToolAgent(bridgeUrl, token, 'coord-continuation');
          coordContinuationRan = true;
        } else {
          await runBridgeToolAgent(bridgeUrl, token, 'coord-initial');
          coordInitialRan = true;
        }
      }
      yield { type: 'sessionStarted', sessionId: 'bridge-sess' };
      yield { type: 'assistantDelta', content: 'bridge path', messageId: 'm1' };
      yield { type: 'turnCompleted' };
    },
  };

  let engine!: TaskEngine;
  const server = new MusterBridgeServer({
    credentials,
    toolHandler: {
      handleToolCall: (ctx, tool, command) => engine.handleToolCall(ctx, tool, command),
    },
  });
  const { port } = await server.listen();

  const taskTypes = parseTaskTypeRegistry({
    worker: { backend: 'grok', role: 'worker', briefKind: 'generic' },
  });
  const harness = await openScriptEngine('muster-bridge-e2e-', {
    makeBackend: () => backend,
    askBridge,
    credentialRegistry: credentials,
    bridgePort: port,
    getTaskTypeRegistry: () => taskTypes,
  });
  engine = harness.engine;

  const started = await engine.startNewTask({
    goal: 'Bridge e2e',
    message: 'run bridge smoke',
    backend: 'grok',
    role: 'coordinator',
  });
  if (!started.ok) throw new Error(started.reason);
  const { taskId: coordTaskId, turnId: coordTurnId } = started.value;
  const childId = deriveEntityId(coordTurnId, 'd1', 'task');
  const continuationId = `${coordTurnId}-continuation`;

  async function waitForGraph(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await engine.whenIdle();
      const child = await harness.repository.getTask(childId);
      const continuation = await harness.repository.getTurn(continuationId);
      if (child?.lifecycle === 'succeeded' && continuation?.status === 'succeeded') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('timed out waiting for child + continuation');
  }

  await waitForGraph();

  const child = await harness.repository.getTask(childId);
  const continuation = await harness.repository.getTurn(continuationId);

  const badRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: 'Bearer bad-token', Host: `127.0.0.1:${port}` },
    body: '{}',
  });

  console.log('injectedMcp:', injectedMcp);
  console.log('coordInitialRan:', coordInitialRan);
  console.log('coordContinuationRan:', coordContinuationRan);
  console.log('childAgentRan:', childAgentRan);
  console.log('child lifecycle:', child?.lifecycle);
  console.log('continuation status:', continuation?.status);
  console.log('bad-token status:', badRes.status);

  await server.close();
  await harness.close();

  if (!injectedMcp) throw new Error('MCP injection not verified');
  if (!coordInitialRan) throw new Error('coordinator initial bridge agent did not run');
  if (!coordContinuationRan) throw new Error('coordinator continuation bridge agent did not run');
  if (!childAgentRan) throw new Error('child bridge agent did not run');
  if (child?.lifecycle !== 'succeeded') throw new Error(`child not succeeded: ${child?.lifecycle}`);
  if (!continuation || continuation.status !== 'succeeded') {
    throw new Error(`continuation not succeeded: ${continuation?.status}`);
  }
  if (badRes.status === 200) throw new Error('bad token should be rejected');
  console.log('\n=== bridge smoke OK ===');
  void coordTaskId;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
