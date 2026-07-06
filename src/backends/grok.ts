import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';

// Least-permissive mode verified noninteractively (edit + shell, grok 0.2.87).
// TODO: promote to muster.grok.permissionMode setting.
const GROK_PERMISSION_MODE = 'default';

// Verified: grok honors --session-id with a pre-assigned v4 UUID.
const USE_PREASSIGNED_SESSION_ID = true;

const FAILURE_STOP_REASONS = new Set(['Error', 'Refusal']);

export class GrokBackend implements Backend {
  readonly name = 'grok';
  readonly capabilities: BackendCapabilities = {
    supportsReasoning: true,
    supportsDetailedToolEvents: false,
    supportsMCP: false,
  };

  async *run(options: RunOptions): AsyncIterable<NormalizedEvent> {
    const messageId = randomUUID();
    const args: string[] = [
      '-p',
      options.prompt,
      '--output-format',
      'streaming-json',
      '--permission-mode',
      GROK_PERMISSION_MODE,
    ];

    let expectedSessionId: string | undefined;

    if (options.resumeId) {
      args.push('--resume', options.resumeId);
      expectedSessionId = options.resumeId;
      yield { type: 'sessionStarted', sessionId: options.resumeId };
    } else if (USE_PREASSIGNED_SESSION_ID) {
      const sid = randomUUID();
      args.push('--session-id', sid);
      expectedSessionId = sid;
      yield { type: 'sessionStarted', sessionId: sid };
    }

    const cwd = options.cwd || process.cwd();
    const env = { ...process.env, ...options.extraEnv };

    const child = spawn('grok', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let spawnError: Error | undefined;
    const closed = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(code));
      child.once('error', (e) => {
        spawnError = e;
        resolve(null);
      });
    });

    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort);
    if (options.signal?.aborted) onAbort();

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout! });

    let endSeen = false;
    let stopReason: string | undefined;
    let endSessionId: string | undefined;

    try {
      for await (const line of rl) {
        if (cancelled) break;
        if (!line.trim()) continue;

        try {
          const obj = JSON.parse(line) as {
            type?: string;
            data?: unknown;
            stopReason?: string;
            sessionId?: string;
          };

          if (obj.type === 'thought' && typeof obj.data === 'string') {
            yield { type: 'reasoningDelta', content: obj.data, messageId };
          } else if (obj.type === 'text' && typeof obj.data === 'string') {
            yield { type: 'assistantDelta', content: obj.data, messageId };
          } else if (obj.type === 'end') {
            // A well-formed `end` must carry a string stopReason + sessionId. Anything
            // else is malformed → raw, and we do NOT accept it as a terminal marker: the
            // post-close check then reports an incomplete turn instead of a false success
            // (which would otherwise commit a session Grok never confirmed).
            if (typeof obj.stopReason === 'string' && typeof obj.sessionId === 'string') {
              endSeen = true;
              stopReason = obj.stopReason;
              endSessionId = obj.sessionId;
              if (expectedSessionId && obj.sessionId !== expectedSessionId) {
                yield {
                  type: 'raw',
                  line: `[session-id mismatch] expected ${expectedSessionId}, got ${obj.sessionId}: ${line}`,
                };
              }
              if (obj.stopReason !== 'EndTurn' && !FAILURE_STOP_REASONS.has(obj.stopReason)) {
                yield { type: 'raw', line };
              }
            } else {
              yield { type: 'raw', line };
            }
          } else {
            yield { type: 'raw', line };
          }
        } catch {
          yield { type: 'raw', line };
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }

    const exitCode = await closed;

    if (stderr.trim()) {
      for (const line of stderr.trim().split('\n')) {
        yield { type: 'raw', line: `[stderr] ${line}` };
      }
    }

    if (cancelled || options.signal?.aborted) {
      yield { type: 'error', message: 'Turn cancelled', isCancellation: true };
      return;
    }

    if (spawnError) {
      yield { type: 'error', message: `Failed to start grok: ${spawnError.message}` };
      return;
    }

    if (exitCode !== null && exitCode !== 0) {
      yield { type: 'error', message: `Grok exited with code ${exitCode}` };
      return;
    }

    if (!endSeen) {
      yield { type: 'error', message: 'Grok stream ended without an end event' };
      return;
    }

    if (stopReason && FAILURE_STOP_REASONS.has(stopReason)) {
      yield { type: 'error', message: `Grok stopped: ${stopReason}` };
      return;
    }

    if (!USE_PREASSIGNED_SESSION_ID && !options.resumeId && endSessionId) {
      yield { type: 'sessionStarted', sessionId: endSessionId };
    }

    yield { type: 'turnCompleted', meta: stopReason ? { stopReason } : undefined };
  }

  extractSessionId(rawOutput: string, lastUsedId?: string): string | undefined {
    const matches = [...rawOutput.matchAll(/"sessionId":"([0-9a-f-]+)"/gi)];
    if (matches.length > 0) {
      return matches[matches.length - 1][1];
    }
    return lastUsedId;
  }
}