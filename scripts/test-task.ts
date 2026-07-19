import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../src/types';
import { openScriptEngine } from './sqlite-engine-harness';

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

async function runScenario(label: string, scenario: 'success' | 'cancel'): Promise<void> {
  let resumeSuccess!: () => void;
  const successGate = new Promise<void>((resolve) => { resumeSuccess = resolve; });
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
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'error', message: 'cancelled by harness', isCancellation: true };
    },
  };
  const harness = await openScriptEngine('muster-test-task-', { makeBackend: () => backend });
  try {
    const started = await harness.engine.startNewTask({
      goal: `Headless ${label}`, message: `Run ${label}`, backend: 'fake', role: 'worker',
    });
    if (!started.ok) throw new Error(started.reason);
    const { taskId, turnId } = started.value;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await harness.repository.getTurn(turnId))?.status === 'running') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    if (scenario === 'success') {
      const disposition = await harness.engine.stageDispositionAsync(
        turnId, { kind: 'complete', result: 'ok' }, 'op-1',
      );
      if (!disposition.ok) throw new Error(disposition.reason);
      resumeSuccess();
    } else {
      const interrupted = await harness.engine.interruptTurnAsync(turnId);
      if (!interrupted.ok) throw new Error(interrupted.reason);
    }
    await harness.engine.whenIdle();
    const task = await harness.repository.getTask(taskId);
    const turn = await harness.repository.getTurn(turnId);
    const messages = await harness.repository.listMessages(taskId);
    console.log(`\n=== ${label} ===`);
    console.log('task.lifecycle:', task?.lifecycle);
    console.log('task.committedSessionId:', task?.committedSessionId ?? '(none)');
    console.log('turn.status:', turn?.status);
    console.log('messages:', messages.map((message) => `${message.role}:${message.state}`).join(', '));
  } finally {
    resumeSuccess();
    await harness.close();
  }
}

async function main(): Promise<void> {
  await runScenario('success path', 'success');
  await runScenario('cancel path', 'cancel');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
