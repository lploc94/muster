/**
 * Live Grok smoke: start a long turn, inject mid-flight via sendLiveInput,
 * observe whether the agent processes the inject (stream after inject) or only
 * returns a transport-level "delivered" ack.
 *
 * Usage:
 *   npx tsx scripts/test-grok-live-inject.ts
 *   INJECT_DELAY_MS=2500 npx tsx scripts/test-grok-live-inject.ts
 *   npm run mvp:grok-live-inject
 *
 * Env:
 *   INJECT_DELAY_MS   — wait after sessionStarted before inject (default 2000)
 *   PRIMARY_PROMPT    — override primary prompt
 *   INJECT_PROMPT     — override inject text (must be distinctive for matching)
 *   TIMEOUT_MS        — overall abort (default 120000)
 */
import { GrokBackend, disposeSharedAcpClient } from '../src/backends/grok';
import { runTurn } from '../src/runner';
import type { LiveInputResult, NormalizedEvent } from '../src/types';

const injectDelayMs = Number(process.env.INJECT_DELAY_MS ?? 2000);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 120_000);
const primaryPrompt =
  process.env.PRIMARY_PROMPT ??
  [
    'You are in a live mid-turn inject test.',
    'Count slowly from 1 to 40, one number per line.',
    'After each number, write a short phrase.',
    'Do not stop early. Do not mention inject unless you receive a later instruction.',
  ].join(' ');
const injectPrompt =
  process.env.INJECT_PROMPT ??
  'LIVE_INJECT_MARKER_42: stop counting and reply with exactly one line containing the words MUSTER_INJECT_ACK and the number 42.';

function now() {
  return new Date().toISOString();
}

function log(line: string) {
  console.log(`[${now()}] ${line}`);
}

async function main() {
  const backend = new GrokBackend();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    log(`TIMEOUT ${timeoutMs}ms — aborting`);
    controller.abort();
  }, timeoutMs);

  let sessionId: string | undefined;
  let injectResult: LiveInputResult | undefined;
  let injectError: string | undefined;
  let injectAtMs: number | undefined;
  let primaryCharsBeforeInject = 0;
  let assistantCharsAfterInject = 0;
  let reasoningCharsAfterInject = 0;
  let assistantText = '';
  let postInjectAssistantText = '';
  let turnCompleted = false;
  let errorMessage: string | undefined;
  const eventTimeline: string[] = [];

  const marker = 'MUSTER_INJECT_ACK';
  const markerAlt = 'LIVE_INJECT_MARKER_42';

  log(`=== Grok live-inject smoke ===`);
  log(`PRIMARY: ${primaryPrompt.slice(0, 120)}…`);
  log(`INJECT:  ${injectPrompt}`);
  log(`INJECT_DELAY_MS=${injectDelayMs} TIMEOUT_MS=${timeoutMs}`);

  let injectPromise: Promise<void> | undefined;
  let injectStarted = false;
  const minCharsBeforeInject = Number(process.env.MIN_CHARS_BEFORE_INJECT ?? 80);

  const fireInject = (sid: string) => {
    if (injectStarted) return;
    injectStarted = true;
    injectPromise = (async () => {
      injectAtMs = Date.now();
      primaryCharsBeforeInject = assistantText.length;
      log(`→ sendLiveInput sessionId=${sid} charsSoFar=${primaryCharsBeforeInject}`);
      log(`  instruction=${JSON.stringify(injectPrompt)}`);
      try {
        injectResult = await backend.sendLiveInput({
          sessionId: sid,
          instruction: injectPrompt,
          signal: controller.signal,
        });
        log(`← sendLiveInput result: ${JSON.stringify(injectResult)}`);
      } catch (err) {
        injectError = err instanceof Error ? err.message : String(err);
        log(`← sendLiveInput threw: ${injectError}`);
      }
    })();
  };

  /** Arm inject after delay; if still no assistant text, wait until min chars. */
  const startInject = (sid: string) => {
    setTimeout(() => {
      if (controller.signal.aborted || injectStarted) return;
      if (assistantText.length >= minCharsBeforeInject) {
        fireInject(sid);
        return;
      }
      log(
        `delay elapsed but only ${assistantText.length} chars (need ${minCharsBeforeInject}) — waiting for stream…`,
      );
      const poll = setInterval(() => {
        if (controller.signal.aborted || injectStarted) {
          clearInterval(poll);
          return;
        }
        if (assistantText.length >= minCharsBeforeInject) {
          clearInterval(poll);
          fireInject(sid);
        }
      }, 100);
    }, injectDelayMs);
  };

  try {
    for await (const event of runTurn(backend, {
      prompt: primaryPrompt,
      signal: controller.signal,
    }) as AsyncIterable<NormalizedEvent>) {
      if (event.type === 'sessionStarted') {
        sessionId = event.sessionId;
        eventTimeline.push(`sessionStarted:${sessionId ?? '?'}`);
        log(`[sessionStarted] ${sessionId ?? '(none)'}`);
        if (sessionId) startInject(sessionId);
      } else if (event.type === 'assistantDelta') {
        assistantText += event.content;
        process.stdout.write(event.content);
        if (injectAtMs !== undefined) {
          assistantCharsAfterInject += event.content.length;
          postInjectAssistantText += event.content;
        }
      } else if (event.type === 'reasoningDelta') {
        process.stdout.write(`\x1b[2m${event.content}\x1b[0m`);
        if (injectAtMs !== undefined) reasoningCharsAfterInject += event.content.length;
      } else if (event.type === 'turnCompleted') {
        turnCompleted = true;
        eventTimeline.push(`turnCompleted:${JSON.stringify(event.meta ?? {})}`);
        log(`\n[turnCompleted] ${JSON.stringify(event.meta ?? {})}`);
      } else if (event.type === 'error') {
        errorMessage = event.message;
        eventTimeline.push(`error:${event.message}`);
        log(`\n[error] ${event.message}${event.isCancellation ? ' (cancelled)' : ''}`);
      } else if (event.type === 'raw') {
        if (/inject|prompt|LIVE_INJECT|MUSTER/i.test(event.line)) {
          log(`[raw] ${event.line.slice(0, 200)}`);
        }
      }
    }
    // Primary runner finished (and unregistered its session sink). Wait for inject RPC.
    if (injectPromise) {
      log('primary turn ended — waiting for inject RPC to settle…');
      await Promise.race([
        injectPromise,
        new Promise((r) => setTimeout(r, 30_000)),
      ]);
    }
  } finally {
    clearTimeout(timeout);
    disposeSharedAcpClient();
  }

  const full = assistantText + '\n' + postInjectAssistantText;
  const ackInFull = full.includes(marker) || full.includes(markerAlt);
  const ackInPost = postInjectAssistantText.includes(marker) || postInjectAssistantText.includes(markerAlt);
  const delivered = injectResult?.code === 'delivered';

  console.log('\n========== VERDICT ==========');
  console.log(
    JSON.stringify(
      {
        sessionId: sessionId ?? null,
        injectResult: injectResult ?? null,
        injectError: injectError ?? null,
        injectDelayMs,
        primaryCharsBeforeInject,
        assistantCharsAfterInject,
        reasoningCharsAfterInject,
        turnCompleted,
        errorMessage: errorMessage ?? null,
        ackMarkerInAnyAssistantText: ackInFull,
        ackMarkerInPostInjectStream: ackInPost,
        postInjectPreview: postInjectAssistantText.slice(0, 400),
      },
      null,
      2,
    ),
  );

  /**
   * Interpretation:
   * - delivered + ack in stream  => inject processed (or agent coincidentally echoed)
   * - delivered + no ack + post stream empty/primary-only => silent-accept / queue / sink drop
   * - no-active-turn => race: CLI finished before inject
   * - rejected/unsupported => capability/wire failure
   */
  if (!injectResult && !injectError) {
    log('FAIL: inject never ran (no sessionStarted or aborted early)');
    process.exitCode = 2;
    return;
  }
  if (injectError) {
    log('FAIL: inject threw');
    process.exitCode = 1;
    return;
  }
  if (!delivered) {
    log(`FAIL: inject not delivered (code=${injectResult?.code}) — CLI may have stopped or refused`);
    process.exitCode = 1;
    return;
  }
  if (ackInPost || ackInFull) {
    log('PASS: delivered AND inject marker observed in assistant stream (agent processed inject)');
    process.exitCode = 0;
    return;
  }
  if (assistantCharsAfterInject > 0) {
    log(
      'INCONCLUSIVE: delivered + post-inject stream continued, but no MUSTER_INJECT_ACK marker — agent may have ignored inject content',
    );
    process.exitCode = 3;
    return;
  }
  log(
    'FAIL-PATTERN: delivered but ZERO assistant chars after inject — classic false-delivered / sink-teardown / no processing',
  );
  process.exitCode = 4;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  try {
    disposeSharedAcpClient();
  } catch {
    /* ignore */
  }
});
