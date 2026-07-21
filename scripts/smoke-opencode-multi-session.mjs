#!/usr/bin/env node
/** Live OpenCode multi-session isolation smoke through the production backend path. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (relative) => path.join(root, 'dist', relative);
const count = Number.parseInt(process.env.MUSTER_SMOKE_SESSIONS ?? '8', 10);
const model = process.env.MUSTER_SMOKE_MODEL ?? 'xai/grok-4.5-cli';
const timeoutMs = Number.parseInt(process.env.MUSTER_SMOKE_TIMEOUT_MS ?? '120000', 10);

if (!Number.isInteger(count) || count < 8 || count > 12) {
  throw new Error(`MUSTER_SMOKE_SESSIONS must be an integer from 8 to 12, got ${String(count)}`);
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
  throw new Error(`MUSTER_SMOKE_TIMEOUT_MS must be positive, got ${String(timeoutMs)}`);
}
for (const relative of ['src/backends/acp-run.js', 'src/backends/opencode.js']) {
  if (!fs.existsSync(dist(relative))) {
    throw new Error('dist/ not built — run `npm run compile` first');
  }
}

const { OpenCodeBackend, disposeSharedAcpClient } = require(dist('src/backends/opencode.js'));
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-smoke-oc-sessions-'));
const runs = [];
const startedAt = Date.now();

try {
  console.log(`OpenCode multi-session smoke: sessions=${count} model=${model}`);
  for (let index = 0; index < count; index += 1) {
    const marker = `MUSTER_SESSION_${String(index + 1).padStart(2, '0')}`;
    const cwd = path.join(rootDir, marker.toLowerCase());
    fs.mkdirSync(cwd, { recursive: true });
    const mcpServers = index === 0
      ? [{
          type: 'stdio',
          name: 'intentionally_broken',
          command: '__muster_missing_mcp_binary__',
          args: [],
          env: [],
        }]
      : [];
    runs.push({
      marker,
      isFaultSession: index === 0,
      backend: new OpenCodeBackend(),
      options: {
        cwd,
        model,
        mcpServers,
        promptTimeoutMs: timeoutMs,
        prompt: `Reply with exactly ${marker} and no other text. Do not use tools.`,
      },
    });
  }

  const settled = await Promise.allSettled(runs.map(async (run) => {
    const events = [];
    for await (const event of run.backend.run(run.options)) events.push(event);
    return events;
  }));

  const failures = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const outcome = settled[index];
    if (outcome.status === 'rejected') {
      failures.push(`${run.marker}: backend rejected: ${outcome.reason?.message ?? String(outcome.reason)}`);
      continue;
    }
    const events = outcome.value;
    const text = events
      .filter((event) => event.type === 'assistantDelta')
      .map((event) => event.content)
      .join('')
      .trim();
    const reasoning = events
      .filter((event) => event.type === 'reasoningDelta')
      .map((event) => event.content)
      .join('')
      .trim();
    const terminal = events.at(-1);
    const foreignMarkers = runs
      .filter((other) => other.marker !== run.marker && (text.includes(other.marker) || reasoning.includes(other.marker)))
      .map((other) => other.marker);

    if (!run.isFaultSession && text !== run.marker) {
      failures.push(`${run.marker}: expected exact marker, got ${JSON.stringify(text)}`);
    }
    if (!run.isFaultSession && terminal?.type !== 'turnCompleted') {
      failures.push(`${run.marker}: terminal=${JSON.stringify(terminal)}`);
    }
    if (foreignMarkers.length > 0) {
      failures.push(`${run.marker}: foreign markers leaked: ${foreignMarkers.join(', ')}`);
    }

    const eventKinds = events.map((event) => event.type);
    console.log(
      `${run.marker}${run.isFaultSession ? ' [fault]' : ''}: `
      + `terminal=${JSON.stringify(terminal)} events=${JSON.stringify(eventKinds)} text=${JSON.stringify(text)}`,
    );
  }

  const elapsedMs = Date.now() - startedAt;
  if (failures.length > 0) {
    throw new Error(`multi-session isolation failed (${failures.length}):\n${failures.join('\n')}`);
  }
  console.log(`PASS: ${count} live OpenCode sessions isolated on one shared ACP process in ${elapsedMs}ms`);
} finally {
  disposeSharedAcpClient();
  // Windows releases session cwd handles after the ACP process-tree kill grace.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
