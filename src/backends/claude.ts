import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';

export class ClaudeBackend implements Backend {
  readonly name = 'claude';
  readonly capabilities: BackendCapabilities = {
    supportsReasoning: false,
    supportsDetailedToolEvents: false,
    supportsMCP: true,
  };

  async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    const messageId = randomUUID();
    const args: string[] = ['-p', options.prompt];

    if (options.resumeId) {
      args.push('--resume', options.resumeId);
    }

    // stream-json in print mode requires --verbose
    args.push('--output-format', 'stream-json');
    args.push('--include-partial-messages');
    args.push('--verbose');

    if (options.mcpConfigPath) {
      args.push('--mcp-config', options.mcpConfigPath);
      args.push('--strict-mcp-config');
    }

    const cwd = options.cwd || process.cwd();
    const env = { ...process.env, ...options.extraEnv };

    const child = spawn('claude', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort);

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout! });

    let currentSessionId: string | undefined;

    try {
      for await (const line of rl) {
        if (cancelled) break;
        if (!line.trim()) continue;

        try {
          const obj = JSON.parse(line);

          if (obj.session_id && !currentSessionId) {
            currentSessionId = obj.session_id;
            yield { type: 'sessionStarted', sessionId: currentSessionId };
          }

          if (obj.type === 'stream_event') {
            const ev = obj.event;
            if (ev?.delta?.text) {
              yield { type: 'assistantDelta', content: ev.delta.text, messageId };
            } else if (ev?.type === 'content_block_delta' && ev.delta?.text) {
              yield { type: 'assistantDelta', content: ev.delta.text, messageId };
            }
          } else if (obj.type === 'result' && obj.result) {
            if (typeof obj.result === 'string') {
              yield { type: 'assistantDelta', content: obj.result, messageId };
            }
          }
        } catch {
          yield { type: 'raw', line };
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }

    const exitCode: number = await new Promise((resolve) => {
      child.on('close', resolve);
    });

    if (stderr.trim()) {
      for (const line of stderr.trim().split('\n')) {
        yield { type: 'raw', line: `[stderr] ${line}` };
      }
    }

    if (cancelled || options.signal?.aborted) {
      yield { type: 'error', message: 'Turn cancelled', isCancellation: true };
      return;
    }

    if (exitCode !== 0) {
      yield { type: 'error', message: `Claude exited with code ${exitCode}` };
    } else {
      yield { type: 'turnCompleted' };
    }
  }

  extractSessionId(rawOutput: string, lastUsedId?: string): string | undefined {
    const match = rawOutput.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : lastUsedId;
  }
}