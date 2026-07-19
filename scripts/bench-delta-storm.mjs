#!/usr/bin/env node
/**
 * M017 S01 T03 — Delta-storm baseline benchmark (PR0 gate).
 *
 * Documents today's synchronous 1:1 per-delta full-store commit storm:
 * each assistantDelta / reasoningDelta / tool update triggers TaskStore.commit()
 * (clone + stringify + fsync under lock), matching engine.ts streaming path.
 *
 * Usage:
 *   node scripts/bench-delta-storm.mjs
 *   MUSTER_BENCH_CHUNKS=200 node scripts/bench-delta-storm.mjs
 *   node scripts/bench-delta-storm.mjs --chunks=200
 *
 * Prints one JSON line with commitCount, chunkCount, p50/p95 commit latency,
 * and total wall-clock. S03 must beat this baseline (commitCount << chunkCount).
 *
 * Prefers compiled dist/ TaskStore (real onCommit hook). Falls back to requiring
 * a just-in-time `npx tsc -p .` when dist is missing. No vitest/playwright deps.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseChunks(argv) {
  const env = process.env.MUSTER_BENCH_CHUNKS;
  if (env && /^\d+$/.test(env)) return Math.max(1, Number(env));
  for (const arg of argv) {
    const m = /^--chunks=(\d+)$/.exec(arg);
    if (m) return Math.max(1, Number(m[1]));
  }
  // Default keeps the bench under a few seconds on a cold disk while still
  // producing a stable p95 (PR0 baseline, not a stress test).
  return 120;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  // Nearest-rank: ceil(p/100 * n), 1-indexed, clamped.
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

function loadTaskStore() {
  const distStore = path.join(root, 'dist', 'src', 'task', 'store.js');
  if (!fs.existsSync(distStore)) {
    const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    if (!fs.existsSync(tsc) && !fs.existsSync(path.join(root, 'node_modules', 'typescript'))) {
      console.error(
        JSON.stringify({
          error: 'dist_missing',
          detail: 'dist/src/task/store.js not found and typescript is not installed. Run npm install && npx tsc -p .',
        }),
      );
      process.exit(2);
    }
    const compile = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['tsc', '-p', '.'],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    if (compile.status !== 0 || !fs.existsSync(distStore)) {
      console.error(
        JSON.stringify({
          error: 'compile_failed',
          detail: (compile.stderr || compile.stdout || 'tsc failed').slice(0, 500),
        }),
      );
      process.exit(2);
    }
  }
  const mod = require(distStore);
  if (typeof mod.TaskStore?.load !== 'function') {
    console.error(JSON.stringify({ error: 'taskstore_export_missing' }));
    process.exit(2);
  }
  return mod.TaskStore;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Mirror engine.ts per-delta commit mutators for assistant / reasoning / tool.
 * One call => one durable store.commit (today's 1:1 storm).
 */
function applyChunk(store, kind, turnId, taskId, index, segmentId, toolCallId) {
  const content = `Δ${index}`;
  const t0 = performance.now();
  let result;
  if (kind === 'assistantDelta') {
    result = store.commit((draft) => {
      const draftTurn = draft.turns[turnId];
      if (!draftTurn) return { ok: false, reason: 'turn not found' };
      const existing = draft.messages[segmentId];
      if (!existing) {
        draft.messages[segmentId] = {
          id: segmentId,
          taskId,
          role: 'assistant',
          content,
          state: 'partial',
          createdAt: nowIso(),
          turnId,
          order: 0,
        };
      } else {
        draft.messages[segmentId] = {
          ...existing,
          content: existing.content + content,
        };
      }
      return { ok: true };
    });
  } else if (kind === 'reasoningDelta') {
    result = store.commit((draft) => {
      const draftTurn = draft.turns[turnId];
      if (!draftTurn) return { ok: false, reason: 'turn not found' };
      draft.reasoning = draft.reasoning ?? {};
      const now = nowIso();
      const existing = draft.reasoning[turnId];
      draft.reasoning[turnId] = existing
        ? { ...existing, content: existing.content + content, updatedAt: now }
        : {
            id: turnId,
            taskId,
            turnId,
            content,
            createdAt: now,
            updatedAt: now,
          };
      return { ok: true };
    });
  } else if (kind === 'toolUpdated') {
    const compositeId = `${turnId}:${toolCallId}`;
    result = store.commit((draft) => {
      const draftTurn = draft.turns[turnId];
      if (!draftTurn) return { ok: false, reason: 'turn not found' };
      draft.toolCalls = draft.toolCalls ?? {};
      const now = nowIso();
      const existing = draft.toolCalls[compositeId];
      draft.toolCalls[compositeId] = existing
        ? {
            ...existing,
            input: { n: index },
            updatedAt: now,
          }
        : {
            id: compositeId,
            taskId,
            turnId,
            toolCallId,
            order: 1,
            name: 'bench_tool',
            status: 'running',
            input: { n: index },
            createdAt: now,
            updatedAt: now,
          };
      return { ok: true };
    });
  } else {
    throw new Error(`unknown chunk kind: ${kind}`);
  }
  const ms = performance.now() - t0;
  if (!result?.ok) {
    throw new Error(`commit failed for ${kind}#${index}: ${result?.detail ?? result?.reason}`);
  }
  return ms;
}

function main() {
  const chunkCount = parseChunks(process.argv.slice(2));
  const TaskStore = loadTaskStore();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-delta-storm-'));
  const filePath = path.join(dir, '.muster-tasks.json');

  let commitCount = 0;
  const store = TaskStore.load({
    filePath,
    onCommit: () => {
      // Counts durable writes after lock release — the PR0 signal S03 must reduce.
      commitCount += 1;
    },
  });

  const taskId = 'bench-task';
  const turnId = 'bench-turn';
  const seed = store.commit((draft) => {
    draft.tasks[taskId] = {
      id: taskId,
      role: 'worker',
      lifecycle: 'open',
      goal: 'delta-storm baseline',
      parentId: null,
      dependencies: [],
      backend: 'fake',
      capabilities: [],
      executionPolicy: {
        maxTurns: 20,
        maxAutomaticRetries: 0,
        turnTimeoutMs: 60_000,
        taskTimeoutMs: 300_000,
      },
      releaseState: 'released',
      revision: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    draft.turns[turnId] = {
      id: turnId,
      taskId,
      sequence: 1,
      trigger: 'user',
      status: 'running',
      inputs: [],
      createdAt: nowIso(),
      startedAt: nowIso(),
      runtimeEpoch: 1,
    };
    return { ok: true };
  });
  if (!seed.ok) {
    console.error(JSON.stringify({ error: 'seed_failed', detail: seed.detail ?? seed.reason }));
    process.exit(1);
  }
  // Seed used onCommit once; reset counters so the storm is pure.
  commitCount = 0;

  const segmentId = `${turnId}:0`;
  const toolCallId = 'tool-1';
  const kinds = ['assistantDelta', 'reasoningDelta', 'toolUpdated'];
  const latenciesMs = [];

  const wallStart = performance.now();
  for (let i = 0; i < chunkCount; i++) {
    const kind = kinds[i % kinds.length];
    const ms = applyChunk(store, kind, turnId, taskId, i, segmentId, toolCallId);
    latenciesMs.push(ms);
  }
  const totalWallMs = performance.now() - wallStart;

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const sum = latenciesMs.reduce((a, b) => a + b, 0);

  const report = {
    name: 'delta-storm',
    commitCount,
    chunkCount,
    // Explicit PR0 signal: today commitCount ≈ chunkCount (1:1 storm).
    commitPerChunk: chunkCount === 0 ? 0 : commitCount / chunkCount,
    p50Ms: Number(p50.toFixed(3)),
    p95Ms: Number(p95.toFixed(3)),
    meanMs: Number((sum / Math.max(1, latenciesMs.length)).toFixed(3)),
    totalWallMs: Number(totalWallMs.toFixed(3)),
    // Aliases for plan wording ("prints a JSON line containing commitCount and p95").
    p50,
    p95,
    storePath: filePath,
    schemaNote:
      'Each assistantDelta/reasoningDelta/toolUpdated maps to one TaskStore.commit (engine.ts streaming path).',
  };

  // Single JSON line for easy capture into docs/uat/m017-s01/delta-storm-baseline.md
  console.log(JSON.stringify(report));

  // Best-effort cleanup (Windows may hold the lock briefly).
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Soft assertion for local sanity: 1:1 storm (allow ±1 for any residual hook).
  if (Math.abs(commitCount - chunkCount) > 1) {
    console.error(
      JSON.stringify({
        error: 'unexpected_commit_ratio',
        detail: `expected commitCount≈chunkCount, got commitCount=${commitCount} chunkCount=${chunkCount}`,
      }),
    );
    process.exit(1);
  }
}

main();
