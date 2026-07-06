import { GrokBackend } from '../src/backends/grok';
import { runTurn } from '../src/runner';

async function main() {
  const backend = new GrokBackend();
  const prompt = process.argv.slice(2).join(' ') || 'Say hello in one sentence.';
  const resumeId = process.env.RESUME_ID;

  console.log(`\n=== Running ${backend.name} ===`);
  console.log(`Prompt: ${prompt}`);
  if (resumeId) console.log(`Resuming: ${resumeId}`);

  const controller = new AbortController();
  const abortMs = process.env.ABORT_MS ? Number(process.env.ABORT_MS) : undefined;
  if (abortMs) {
    setTimeout(() => controller.abort(), abortMs);
    console.log(`Abort scheduled in ${abortMs}ms`);
  }

  const options = {
    prompt,
    resumeId,
    signal: controller.signal,
  };

  let failed = false;

  for await (const event of runTurn(backend, options)) {
    if (event.type === 'reasoningDelta') {
      process.stdout.write(`\x1b[2m${event.content}\x1b[0m`);
    } else if (event.type === 'assistantDelta') {
      process.stdout.write(event.content);
    } else if (event.type === 'sessionStarted') {
      console.log(`\n[sessionStarted] ${event.sessionId ?? '(no id)'}`);
    } else if (event.type === 'turnCompleted') {
      console.log('\n[turnCompleted]', event.meta ?? '');
    } else if (event.type === 'error') {
      const expectedCancellation = event.isCancellation && abortMs !== undefined;
      if (!expectedCancellation) {
        failed = true;
      }
      console.error('\n[error]', event.message, event.isCancellation ? '(cancelled)' : '');
    } else if (event.type === 'raw') {
      console.log(`\n[raw] ${event.line}`);
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});