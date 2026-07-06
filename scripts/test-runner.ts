import { ClaudeBackend } from '../src/backends/claude';
import { runTurn } from '../src/runner';

async function main() {
  const backend = new ClaudeBackend();
  const prompt = process.argv.slice(2).join(' ') || 'Say hello in one sentence.';
  const resumeId = process.env.RESUME_ID;

  console.log(`\n=== Running ${backend.name} ===`);
  console.log(`Prompt: ${prompt}`);
  if (resumeId) console.log(`Resuming: ${resumeId}`);

  const options = {
    prompt,
    resumeId,
    mcpConfigPath: process.env.MCP_CONFIG,
  };

  for await (const event of runTurn(backend, options)) {
    if (event.type === 'assistantDelta') {
      process.stdout.write(event.content);
    } else if (event.type === 'turnCompleted') {
      console.log('\n[turnCompleted]');
    } else if (event.type === 'error') {
      console.error('\n[error]', event.message);
    }
  }
}

main().catch(console.error);
