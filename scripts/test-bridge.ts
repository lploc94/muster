import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AskBridge } from '../src/bridge/ask-bridge';
import { CredentialRegistry } from '../src/bridge/credentials';
import { MusterBridgeServer } from '../src/bridge/server';
import { deriveEntityId } from '../src/task/engine-graph';
import { TaskEngine } from '../src/task/engine';
import { TaskStore } from '../src/task/store';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../src/types';

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsLiveInput: false,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-bridge-e2e-'));
  const store = TaskStore.load({ filePath: path.join(dir, '.muster-tasks.json') });
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
      if (bridgeEntry?.type === 'http') {
        injectedMcp = true;
        const auth = bridgeEntry.headers?.find((h) => h.name === 'Authorization')?.value ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
        const isChild = options.prompt.includes('child work');
        const isContinuation = options.prompt.includes('[child_results]');
        if (isChild) {
          await runBridgeToolAgent(
            bridgeEntry.url,
            token,
            JSON.stringify([
              { tool: 'complete_task', args: { opId: 'c1', result: 'child done' } },
            ]),
          );
          childAgentRan = true;
        } else if (isContinuation) {
          await runBridgeToolAgent(bridgeEntry.url, token, 'coord-continuation');
          coordContinuationRan = true;
        } else {
          await runBridgeToolAgent(bridgeEntry.url, token, 'coord-initial');
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

  engine = TaskEngine.load({
    store,
    makeBackend: () => backend,
    askBridge,
    credentialRegistry: credentials,
    bridgePort: port,
  });

  const created = engine.createTask({
    id: 'coord',
    goal: 'Bridge e2e',
    backend: 'grok',
    role: 'coordinator',
    capabilities: ['create_child', 'start_child', 'wait_child', 'read_subtree'],
  });
  if (!created.ok) throw new Error(created.reason);

  const sent = engine.send('coord', 'run bridge smoke');
  if (!sent.ok) throw new Error(sent.reason);
  if (!sent.value?.turnId) throw new Error('send did not queue a coordinator turn');
  const coordTurnId = sent.value.turnId;
  const childId = deriveEntityId(coordTurnId, 'd1', 'task');
  const continuationId = `${coordTurnId}-continuation`;

  async function waitForGraph(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await engine.whenIdle();
      const file = store.getFile();
      const child = file.tasks[childId];
      const continuation = file.turns[continuationId];
      if (child?.lifecycle === 'succeeded' && continuation?.status === 'succeeded') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('timed out waiting for child + continuation');
  }

  await waitForGraph();

  const file = store.getFile();
  const child = file.tasks[childId];
  const continuation = file.turns[continuationId];

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});