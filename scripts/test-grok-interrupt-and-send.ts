/** Live Grok interrupt-and-send smoke through the SQLite-only engine path. */
import { GrokBackend, disposeSharedAcpClient } from '../src/backends/grok';
import type { Backend, NormalizedEvent, RunOptions } from '../src/types';
import { openScriptEngine } from './sqlite-engine-harness';

const injectDelayMs = Number(process.env.INJECT_DELAY_MS ?? 2000);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 180_000);
const marker = 'MUSTER_INJECT_ACK';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main(): Promise<void> {
  const runOptions: RunOptions[] = [];
  const grok = new GrokBackend();
  const backend: Backend = {
    name: 'grok',
    capabilities: grok.capabilities,
    run: async function* (options: RunOptions): AsyncIterable<NormalizedEvent> {
      runOptions.push({ ...options });
      yield* grok.run(options);
    },
  };
  const harness = await openScriptEngine('muster-ias-', { makeBackend: () => backend });
  try {
    const primaryPrompt = process.env.PRIMARY_PROMPT ??
      'Count from 1 to 60. One number per line with a short phrase. Do not stop early.';
    const started = await harness.engine.startNewTask({
      goal: primaryPrompt, message: primaryPrompt, backend: 'grok', role: 'worker',
    });
    if (!started.ok) throw new Error(`startNewTask failed: ${started.reason}`);
    const { taskId, turnId: primaryTurnId } = started.value;
    log(`task ${taskId} turn ${primaryTurnId}`);

    const deadline = Date.now() + timeoutMs;
    let sessionId: string | undefined;
    while (Date.now() < deadline) {
      const turn = await harness.repository.getTurn(primaryTurnId);
      if (turn?.status === 'running' && turn.observedSessionId) {
        sessionId = turn.observedSessionId;
        break;
      }
      if (turn && !['queued', 'running', 'waiting_user'].includes(turn.status)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (!sessionId) throw new Error('no session observed on primary turn');
    log(`session observed: ${sessionId}`);
    await new Promise<void>((resolve) => setTimeout(resolve, injectDelayMs));

    const instruction = process.env.INJECT_PROMPT ??
      `${marker}: stop counting and reply with one line containing ${marker} and 42.`;
    const committedBefore = (await harness.repository.getTask(taskId))?.committedSessionId;
    log(`→ interruptAndSend: ${instruction}`);
    const injected = await harness.engine.interruptAndSendAsync(taskId, instruction);
    if (!injected.ok) throw new Error(injected.reason);
    const followUpId = injected.value.turnId;

    while (Date.now() < deadline) {
      const primary = await harness.repository.getTurn(primaryTurnId);
      const follow = await harness.repository.getTurn(followUpId);
      if (primary && !['queued', 'running', 'waiting_user'].includes(primary.status) &&
          follow && !['queued', 'running', 'waiting_user'].includes(follow.status)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    await harness.engine.whenIdle();

    const primary = await harness.repository.getTurn(primaryTurnId);
    const follow = await harness.repository.getTurn(followUpId);
    const committedAfter = (await harness.repository.getTask(taskId))?.committedSessionId;
    const assistantText = (await harness.repository.listMessages(taskId))
      .filter((message) => message.role === 'assistant' && message.turnId === followUpId)
      .map((message) => message.content)
      .join('');
    const secondRun = runOptions[1];
    console.log(JSON.stringify({
      primaryStatus: primary?.status,
      interruptConfidence: primary?.interruptConfidence,
      committedBefore: committedBefore ?? null,
      committedAfter: committedAfter ?? null,
      followStatus: follow?.status,
      secondResumeId: secondRun?.resumeId ?? null,
      sessionId,
      markerInFollowAssistant: assistantText.includes(marker),
      assistantPreview: assistantText.slice(0, 300),
      runCount: runOptions.length,
    }, null, 2));

    if (primary?.interruptConfidence === 'forced') {
      process.exitCode = 3;
      log('INCONCLUSIVE: forced interrupt; follow-up remains queued');
    } else if (
      primary?.interruptConfidence === 'confirmed' && committedAfter === sessionId &&
      secondRun?.resumeId === sessionId && assistantText.includes(marker)
    ) {
      log('PASS: confirmed interrupt, session bound, marker processed on follow-up');
    } else {
      process.exitCode = 4;
      log('FAIL: expected confirmed bind + marker on follow-up');
    }
  } finally {
    disposeSharedAcpClient();
    await harness.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  disposeSharedAcpClient();
});
