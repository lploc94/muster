import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskEngine } from '../src/task/engine';
import { TaskStore } from '../src/task/store';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../src/types';

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsLiveInput: false,
};

async function runScenario(label: string, scenario: 'success' | 'cancel'): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-test-task-'));
  const filePath = path.join(dir, '.muster-tasks.json');
  const store = TaskStore.load({ filePath });

  let resumeSuccess: (() => void) | undefined;
  const successGate = new Promise<void>((resolve) => {
    resumeSuccess = resolve;
  });

  const backend: Backend = {
    name: 'fake',
    capabilities: MCP_CAPS,
    async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
      if (scenario === 'success') {
        yield { type: 'sessionStarted', sessionId: 'fake-session-001' };
        yield { type: 'assistantDelta', content: 'Task engine hello.', messageId: 'a1' };
        await successGate;
        yield { type: 'turnCompleted' };
        return;
      }

      yield { type: 'sessionStarted', sessionId: 'fake-session-cancel' };
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'error', message: 'cancelled by harness', isCancellation: true };
    },
  };

  const engine = TaskEngine.load({ store, makeBackend: () => backend });
  const taskId = `task-${scenario}`;

  const created = engine.createTask({
    id: taskId,
    goal: `Headless ${label}`,
    backend: 'fake',
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }

  const sent = engine.send(taskId, `Run ${label}`);
  if (!sent.ok || !sent.value.turnId) {
    throw new Error(sent.ok ? 'missing turn id' : sent.reason);
  }

  if (scenario === 'success') {
    await new Promise((resolve) => setTimeout(resolve, 25));
    engine.stageDisposition(sent.value.turnId, { kind: 'complete', result: 'ok' }, 'op-1');
    resumeSuccess?.();
  } else {
    engine.interruptTurn(sent.value.turnId);
  }

  await engine.whenIdle();

  const task = store.getTask(taskId);
  const turn = store.getFile().turns[sent.value.turnId];
  const messages = store.getMessagesForTask(taskId);

  console.log(`\n=== ${label} ===`);
  console.log('task.lifecycle:', task?.lifecycle);
  console.log('task.committedSessionId:', task?.committedSessionId ?? '(none)');
  console.log('turn.status:', turn?.status);
  console.log('messages:', messages.map((m) => `${m.role}:${m.state}`).join(', '));

  fs.rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  await runScenario('success path', 'success');
  await runScenario('cancel path', 'cancel');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});