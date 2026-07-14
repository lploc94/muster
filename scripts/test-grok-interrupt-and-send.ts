/**
 * Phase 0 / A11: Grok interrupt-and-send via TaskEngine path.
 *
 * 1. Start long primary turn until session observed
 * 2. interruptAndSend (reserve then interrupt) with marker prompt
 * 3. After confirmed settle, follow-up must resume same session and process marker
 *
 * Usage: npm run mvp:grok-interrupt-and-send
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GrokBackend, disposeSharedAcpClient } from '../src/backends/grok';
import { TaskEngine } from '../src/task/engine';
import { TaskStore } from '../src/task/store';
import type { Backend, NormalizedEvent, RunOptions } from '../src/types';

const injectDelayMs = Number(process.env.INJECT_DELAY_MS ?? 2000);
const minChars = Number(process.env.MIN_CHARS_BEFORE_INJECT ?? 80);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 180_000);
const marker = 'MUSTER_INJECT_ACK';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-ias-'));
  const filePath = path.join(dir, '.muster-tasks.json');
  const store = TaskStore.load({ filePath });

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

  const engine = TaskEngine.load({
    store,
    makeBackend: () => backend,
  });

  const taskId = 'task-grok-ias';
  const primary =
    process.env.PRIMARY_PROMPT ??
    'Count from 1 to 60. One number per line with a short phrase. Do not stop early.';
  // startTask uses task.goal as the first-turn prompt.
  engine.createTask({ id: taskId, goal: primary, backend: 'grok' });
  const started = engine.startTask(taskId, []);
  if (!started.ok) {
    console.error('startTask failed', started.reason);
    process.exitCode = 1;
    return;
  }
  log(`task ${taskId} turn ${started.value.turnId}`);

  // Wait for running + session
  let sessionId: string | undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = store.getFile().turns[started.value.turnId];
    if (turn?.status === 'running' && turn.observedSessionId) {
      sessionId = turn.observedSessionId;
      break;
    }
    if (turn?.status === 'succeeded' || turn?.status === 'failed' || turn?.status === 'interrupted') {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!sessionId) {
    log('FAIL: no session observed on primary turn');
    process.exitCode = 2;
    disposeSharedAcpClient();
    return;
  }
  log(`session observed: ${sessionId}`);

  await new Promise((r) => setTimeout(r, injectDelayMs));

  const instruction =
    process.env.INJECT_PROMPT ??
    `${marker}: stop counting and reply with one line containing ${marker} and 42.`;

  log(`→ interruptAndSend: ${instruction}`);
  const beforeCommit = store.getFile().tasks[taskId]?.committedSessionId;
  const result = engine.interruptAndSend(taskId, instruction);
  log(`← interruptAndSend: ${JSON.stringify(result)}`);
  if (!result.ok) {
    process.exitCode = 1;
    disposeSharedAcpClient();
    return;
  }

  // Wait until follow-up finishes or timeout
  const followUpId = result.value.turnId;
  while (Date.now() < deadline) {
    const file = store.getFile();
    const primaryTurn = file.turns[started.value.turnId];
    const follow = file.turns[followUpId];
    if (
      primaryTurn &&
      (primaryTurn.status === 'interrupted' ||
        primaryTurn.status === 'succeeded' ||
        primaryTurn.status === 'failed') &&
      follow &&
      follow.status !== 'queued' &&
      follow.status !== 'running' &&
      follow.status !== 'waiting_user'
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await engine.whenIdle();

  const file = store.getFile();
  const primaryTurn = file.turns[started.value.turnId];
  const follow = file.turns[followUpId];
  const committed = file.tasks[taskId]?.committedSessionId;
  const secondRun = runOptions[1];

  const assistantText = Object.values(file.messages)
    .filter((m) => m.role === 'assistant' && m.turnId === followUpId)
    .map((m) => m.content)
    .join('');

  console.log('\n========== VERDICT ==========');
  console.log(
    JSON.stringify(
      {
        primaryStatus: primaryTurn?.status,
        interruptConfidence: primaryTurn?.interruptConfidence,
        committedBefore: beforeCommit ?? null,
        committedAfter: committed ?? null,
        followStatus: follow?.status,
        followHold: follow?.holdAutoPromote ?? false,
        secondResumeId: secondRun?.resumeId ?? null,
        sessionId,
        markerInFollowAssistant: assistantText.includes(marker),
        assistantPreview: assistantText.slice(0, 300),
        runCount: runOptions.length,
      },
      null,
      2,
    ),
  );

  disposeSharedAcpClient();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const ok =
    primaryTurn?.interruptConfidence === 'confirmed' &&
    committed === sessionId &&
    secondRun?.resumeId === sessionId &&
    assistantText.includes(marker);

  if (ok) {
    log('PASS: confirmed interrupt, session bound, marker processed on follow-up');
    process.exitCode = 0;
  } else if (primaryTurn?.interruptConfidence === 'forced') {
    log('INCONCLUSIVE: forced interrupt — message should stay queued (A9)');
    process.exitCode = 3;
  } else {
    log('FAIL: expected confirmed bind + marker on follow-up');
    process.exitCode = 4;
  }

  void minChars;
  void primary;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  try {
    disposeSharedAcpClient();
  } catch {
    /* ignore */
  }
});
