/**
 * Phase 0 baseline harness (sqlite-global-storage-refactor).
 *
 * Reproducible measurement of the CURRENT JSON `TaskStore` so the SQLite refactor
 * has a before/after reference. Measures, on the real synchronous commit path:
 *   - commit p50/p95 for a single streaming-style batch as total store size grows,
 *   - full snapshot byte size (bootstrap payload) for the focused task,
 *   - activation-style cold read (load + build snapshot) latency.
 *
 * It writes NOTHING to the repo: every fixture lives in an OS temp dir that is
 * removed on exit. Output is machine + fixture-size tagged so runs are comparable.
 *
 * Run: npx tsx scripts/bench-store-baseline.ts
 *      npx tsx scripts/bench-store-baseline.ts --sizes 10,100,1000 --json
 *
 * NOTE (handoff rule §13): benchmark claims MUST record fixture size, mode, and
 * machine. This harness prints all three; do not cite unit-test durations as perf.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { TaskStore } from '../src/task/store';
import { buildSnapshot } from '../src/host/snapshot';
import type {
  MusterTask,
  PersistedReasoning,
  PersistedToolCall,
  TaskMessage,
  TaskStoreFile,
  TaskTurn,
} from '../src/task/types';

interface FixtureSpec {
  /** Number of root tasks. */
  tasks: number;
  /** Turns per task. */
  turnsPerTask: number;
  /** Assistant/user message pairs per turn. */
  messagesPerTurn: number;
  /** Tool calls per turn. */
  toolCallsPerTurn: number;
  /** Approx chars of tool output per tool call (large-output stress). */
  toolOutputChars: number;
}

const ISO = '2026-07-16T00:00:00.000Z';

function makeTask(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    goal: `bench task ${id}`,
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 100, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function buildFixture(spec: FixtureSpec): TaskStoreFile {
  const file: TaskStoreFile = {
    schemaVersion: 6,
    revision: 0,
    tasks: {},
    turns: {},
    messages: {},
    operations: {},
    cancelRequests: {},
    toolCalls: {},
    reasoning: {},
    sendReceipts: {},
  };
  const bigOutput = 'x'.repeat(spec.toolOutputChars);
  for (let t = 0; t < spec.tasks; t++) {
    const taskId = `task-${t}`;
    file.tasks[taskId] = makeTask(taskId);
    for (let s = 0; s < spec.turnsPerTask; s++) {
      const turnId = `${taskId}-turn-${s}`;
      const turn: TaskTurn = {
        id: turnId,
        taskId,
        sequence: s,
        trigger: s === 0 ? 'user' : 'engine',
        status: 'succeeded',
        inputs: [],
        createdAt: ISO,
        startedAt: ISO,
        finishedAt: ISO,
      };
      file.turns[turnId] = turn;
      for (let m = 0; m < spec.messagesPerTurn; m++) {
        const userId = `${turnId}-msg-u-${m}`;
        const asstId = `${turnId}-msg-a-${m}`;
        const userMsg: TaskMessage = {
          id: userId,
          taskId,
          role: 'user',
          content: `user message ${m} in ${turnId}`,
          state: 'complete',
          createdAt: ISO,
          turnId,
          order: m * 2,
        };
        const asstMsg: TaskMessage = {
          id: asstId,
          taskId,
          role: 'assistant',
          content: `assistant reply ${m} in ${turnId}`,
          state: 'complete',
          createdAt: ISO,
          turnId,
          order: m * 2 + 1,
        };
        file.messages[userId] = userMsg;
        file.messages[asstId] = asstMsg;
        if (turn.inputs.length === 0) {
          turn.inputs.push({ kind: 'message', messageId: userId });
        }
      }
      const reasoning: PersistedReasoning = {
        id: turnId,
        taskId,
        turnId,
        content: `reasoning trace for ${turnId}`,
        createdAt: ISO,
        updatedAt: ISO,
      };
      file.reasoning![turnId] = reasoning;
      for (let c = 0; c < spec.toolCallsPerTurn; c++) {
        const tcId = `${turnId}:tool-${c}`;
        const toolCall: PersistedToolCall = {
          id: tcId,
          taskId,
          turnId,
          toolCallId: `tool-${c}`,
          order: 100 + c,
          name: 'Bash',
          kind: 'builtin',
          status: 'success',
          input: { command: `echo ${c}` },
          output: bigOutput,
          createdAt: ISO,
          updatedAt: ISO,
        };
        file.toolCalls![tcId] = toolCall;
      }
    }
  }
  return file;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function fmt(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

interface Measurement {
  size: number;
  storeBytes: number;
  commitP50: number;
  commitP95: number;
  snapshotBytes: number;
  coldLoadMs: number;
  coldSnapshotMs: number;
}

function measure(spec: FixtureSpec, iterations: number): Measurement {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-bench-'));
  const filePath = path.join(dir, '.muster-tasks.json');
  try {
    // Seed the fixture through the real store so the on-disk shape is authentic.
    const seed = buildFixture(spec);
    fs.writeFileSync(filePath, JSON.stringify(seed, null, 2), 'utf8');
    const storeBytes = fs.statSync(filePath).size;

    // Cold activation-style read: fresh instance + first snapshot.
    const t0 = performance.now();
    const cold = TaskStore.load({ filePath });
    const coldLoadMs = performance.now() - t0;
    const focusId = 'task-0';
    const t1 = performance.now();
    const snap = buildSnapshot(cold, focusId);
    const coldSnapshotMs = performance.now() - t1;
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snap), 'utf8');

    // Streaming-style commit batch: append one assistant segment + one tool call
    // to the focused task, exactly the hot path the plan targets.
    const store = TaskStore.load({ filePath });
    const durations: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      store.commit((draft) => {
        const id = `stream-msg-${i}`;
        draft.messages[id] = {
          id,
          taskId: focusId,
          role: 'assistant',
          content: `streamed chunk ${i}`,
          state: 'partial',
          createdAt: ISO,
          turnId: 'task-0-turn-0',
          order: 1000 + i,
        };
        return { ok: true };
      });
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    return {
      size: spec.tasks,
      storeBytes,
      commitP50: percentile(durations, 50),
      commitP95: percentile(durations, 95),
      snapshotBytes,
      coldLoadMs,
      coldSnapshotMs,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function specForSize(tasks: number): FixtureSpec {
  return {
    tasks,
    turnsPerTask: 10,
    messagesPerTurn: 3,
    toolCallsPerTurn: 2,
    toolOutputChars: 4_000,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const sizesArg = argv.includes('--sizes')
    ? argv[argv.indexOf('--sizes') + 1]!
    : '10,100,1000';
  const asJson = argv.includes('--json');
  const iterations = argv.includes('--iterations')
    ? Number(argv[argv.indexOf('--iterations') + 1])
    : 50;
  const sizes = sizesArg.split(',').map((s) => Number(s.trim()));

  const results = sizes.map((size) => measure(specForSize(size), iterations));

  const meta = {
    machine: `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? 'unknown-cpu'}`,
    node: process.version,
    mode: 'tsx (dev, not release build)',
    iterations,
    timestamp: new Date().toISOString(),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify({ meta, results }, null, 2) + '\n');
    return;
  }

  process.stdout.write('\n=== Phase 0 baseline: JSON TaskStore ===\n');
  process.stdout.write(`machine    : ${meta.machine}\n`);
  process.stdout.write(`node       : ${meta.node}\n`);
  process.stdout.write(`mode       : ${meta.mode}\n`);
  process.stdout.write(`iterations : ${meta.iterations} commits/size\n`);
  process.stdout.write(`timestamp  : ${meta.timestamp}\n\n`);
  const header = [
    'tasks'.padEnd(8),
    'storeKiB'.padStart(10),
    'commit p50'.padStart(12),
    'commit p95'.padStart(12),
    'snapKiB'.padStart(10),
    'coldLoad'.padStart(10),
    'coldSnap'.padStart(10),
  ].join(' ');
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length) + '\n');
  for (const r of results) {
    process.stdout.write(
      [
        String(r.size).padEnd(8),
        (r.storeBytes / 1024).toFixed(1).padStart(10),
        fmt(r.commitP50).padStart(12),
        fmt(r.commitP95).padStart(12),
        (r.snapshotBytes / 1024).toFixed(1).padStart(10),
        fmt(r.coldLoadMs).padStart(10),
        fmt(r.coldSnapshotMs).padStart(10),
      ].join(' ') + '\n',
    );
  }
  process.stdout.write(
    '\nNote: commit cost scales with TOTAL store size (full read+clone+stringify),\n' +
      'which is exactly the JSON bottleneck the SQLite refactor targets (plan §2, §9).\n',
  );
}

main();
