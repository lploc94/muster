/**
 * Phase 4 release-oriented performance gate (P4-W11).
 *
 * Measures compiled-path repository contracts (not HMR/dev-only unit duration):
 * - focus latest 100
 * - load older page 100
 * - bootstrap snapshot wire bytes
 * - streaming batch commit p50/p95
 * - activation latency + retained heap delta with 100k persisted messages
 * - materialized DTO/row bounds
 *
 * Usage:
 *   npm run bench:phase4-release
 *   npm run bench:phase4-release:assert
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DbClient, resolveWorkerPath } from '../src/task/sqlite/client';
import { SqliteTaskRepository } from '../src/task/repository';
import { RepositoryProjection } from '../src/task/repository-projection';
import { buildRepositorySnapshot } from '../src/host/repository-snapshot';
import { CHANGE_FEED_RETAIN_REVISIONS, SQLITE_SCHEMA_VERSION } from '../src/task/sqlite/schema';

const ISO = '2026-07-17T00:00:00.000Z';
const WORKSPACE = 'phase4-bench';
const assertMode = process.argv.includes('--assert');
const iterationsArg = process.argv.find((a) => a.startsWith('--iterations='));
const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : 12;
const ACTIVATION_MESSAGES = 100_000;
const ACTIVATION_HEAP_BUDGET_MIB = 64;

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
}

async function seedFocusedTranscript(
  repo: SqliteTaskRepository,
  client: DbClient,
  itemCount: number,
): Promise<void> {
  await repo.execute({
    kind: 'upsertWorkspace',
    workspaceId: WORKSPACE,
    identityKey: 'phase4-bench',
    displayName: 'Phase4',
    createdAt: ISO,
    lastOpenedAt: ISO,
  });
  await repo.execute({
    kind: 'createTask',
    workspaceId: WORKSPACE,
    task: {
      id: 'focus',
      role: 'worker',
      lifecycle: 'open',
      releaseState: 'released',
      goal: 'bench',
      parentId: null,
      dependencies: [],
      backend: 'grok',
      capabilities: [],
      executionPolicy: { maxTurns: 100, maxAutomaticRetries: 0 },
      revision: 0,
      createdAt: ISO,
      updatedAt: ISO,
    },
  });
  // Batch seed outside measurement window.
  const batch = 100;
  for (let i = 0; i < itemCount; i += batch) {
    const messages = Array.from({ length: Math.min(batch, itemCount - i) }, (_, j) => {
      const n = i + j;
      return {
        id: `m-${n}`,
        taskId: 'focus',
        role: 'assistant' as const,
        content: `msg ${n} ${'x'.repeat(32)}`,
        state: 'complete' as const,
        order: n,
        createdAt: new Date(Date.parse(ISO) + n).toISOString(),
      };
    });
    await repo.execute({
      kind: 'appendTranscriptBatch',
      workspaceId: WORKSPACE,
      taskId: 'focus',
      messages,
    });
  }
  void client;
}

async function seedActivationHistory(
  repo: SqliteTaskRepository,
  client: DbClient,
  count: number,
): Promise<void> {
  await repo.execute({
    kind: 'createTask',
    workspaceId: WORKSPACE,
    task: {
      id: 'activation-history',
      role: 'worker',
      lifecycle: 'succeeded',
      releaseState: 'released',
      goal: 'activation history',
      parentId: null,
      dependencies: [],
      backend: 'grok',
      capabilities: [],
      executionPolicy: { maxTurns: 100, maxAutomaticRetries: 0 },
      revision: 0,
      createdAt: ISO,
      updatedAt: ISO,
    },
  });
  // Release fixture seeding is intentionally outside the measured named-command
  // path. A five-digit cross product inserts up to 100k historical rows in one
  // worker statement without allocating 100k JS DTOs.
  await client.run(
    `WITH d(v) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
          nums(n) AS (
            SELECT a.v + 10*b.v + 100*c.v + 1000*e.v + 10000*f.v
              FROM d a CROSS JOIN d b CROSS JOIN d c CROSS JOIN d e CROSS JOIN d f
          )
     INSERT INTO messages
       (id, workspace_id, task_id, turn_id, role, state, ordering, content,
        created_at, updated_at, payload_json)
     SELECT 'activation-' || n, ?, 'activation-history', NULL, 'assistant', 'complete', n,
            'historical message ' || n, ?, NULL, '{"payloadVersion":1}'
       FROM nums
      WHERE n < ?`,
    [WORKSPACE, ISO, count],
  );
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-phase4-bench-'));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const sqliteDir = path.resolve(__dirname, '../src/task/sqlite');
  const workerPath = resolveWorkerPath(sqliteDir);
  const client = new DbClient({
    workerPath,
    ...(workerPath.endsWith('.ts') ? { execArgv: ['--import', 'tsx'] } : {}),
  });
  try {
    await client.open(dbPath);
    const repo = new SqliteTaskRepository(client, WORKSPACE);
    await seedFocusedTranscript(repo, client, 10_000);
    await seedActivationHistory(repo, client, ACTIVATION_MESSAGES - 10_000);

    const countRow = await client.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM messages WHERE workspace_id = ?',
      [WORKSPACE],
    );
    const fixtureMessages = countRow?.count ?? 0;

    // Warm-up
    await repo.getTranscriptPage('focus', undefined, 100);
    await buildRepositorySnapshot(repo, WORKSPACE, 'focus', new Map());

    const focusMs: number[] = [];
    const pageMs: number[] = [];
    const streamMs: number[] = [];
    const activationMs: number[] = [];
    const activationHeapMiB: number[] = [];
    let bootstrapBytes = 0;
    let focusItems = 0;

    // Warm and measure the repository-backed activation projection before any
    // backend discovery. It must load only task/activity/current-input metadata,
    // independent of the 100k historical message rows.
    await RepositoryProjection.load(repo, WORKSPACE);
    for (let i = 0; i < iterations; i += 1) {
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const projection = await RepositoryProjection.load(repo, WORKSPACE);
      activationMs.push(performance.now() - started);
      if (
        Object.keys(projection.getFile().messages).length !== 0 ||
        Object.keys(projection.getFile().toolCalls ?? {}).length !== 0 ||
        Object.keys(projection.getFile().reasoning ?? {}).length !== 0
      ) {
        throw new Error('activation projection materialized historical transcript rows');
      }
      // Measure retained projection state, not temporary allocation churn from
      // query/codec execution. `projection` remains live through the sample.
      gc?.();
      activationHeapMiB.push(
        Math.max(0, process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024,
      );
      void projection.getFile().revision;
    }

    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      const page = await repo.getTranscriptPage('focus', undefined, 100);
      focusMs.push(performance.now() - t0);
      focusItems = page.items.length;

      if (page.beforeCursor) {
        const t1 = performance.now();
        await repo.getTranscriptPage('focus', page.beforeCursor, 100);
        pageMs.push(performance.now() - t1);
      }

      const snap = await buildRepositorySnapshot(repo, WORKSPACE, 'focus', new Map());
      bootstrapBytes = Buffer.byteLength(JSON.stringify(snap.snapshot), 'utf8');

      const t2 = performance.now();
      await repo.execute({
        kind: 'appendTranscriptBatch',
        workspaceId: WORKSPACE,
        taskId: 'focus',
        messages: [{
          id: `stream-${i}`,
          taskId: 'focus',
          role: 'assistant',
          content: `stream ${i}`,
          state: 'partial',
          order: 10_000 + i,
          createdAt: new Date().toISOString(),
        }],
      });
      streamMs.push(performance.now() - t2);
    }

    const concurrentTasks = Array.from({ length: 10 }, (_, index) => `concurrent-${index}`);
    for (const taskId of concurrentTasks) {
      await repo.execute({
        kind: 'createTask',
        workspaceId: WORKSPACE,
        task: {
          id: taskId,
          role: 'worker', lifecycle: 'open', releaseState: 'released', goal: taskId,
          parentId: null, dependencies: [], backend: 'grok', capabilities: [],
          executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 }, revision: 0,
          createdAt: ISO, updatedAt: ISO,
        },
      });
    }
    const concurrentStarted = performance.now();
    await Promise.all(concurrentTasks.map((taskId, index) => repo.execute({
      kind: 'appendTranscriptBatch',
      workspaceId: WORKSPACE,
      taskId,
      messages: [{
        id: `${taskId}-stream`, taskId, role: 'assistant', content: `stream ${index}`,
        state: 'partial', order: 0, createdAt: ISO,
      }],
    })));
    const concurrentStreams10Ms = performance.now() - concurrentStarted;
    const concurrentRow = await client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM messages
        WHERE workspace_id = ? AND id GLOB 'concurrent-*-stream'`,
      [WORKSPACE],
    );

    const report = {
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        model: os.cpus()[0]?.model,
        node: process.version,
        schemaVersion: SQLITE_SCHEMA_VERSION,
        changeFeedRetain: CHANGE_FEED_RETAIN_REVISIONS,
        mode: workerPath.endsWith('.js') ? 'compiled-js-worker-release-contract' : 'tsx-source-fallback',
        timestamp: new Date().toISOString(),
      },
      fixture: { focusedTranscriptItems: 10_000, totalMessages: fixtureMessages, iterations },
      results: {
        activation100k: {
          p50Ms: percentile(activationMs, 50),
          p95Ms: percentile(activationMs, 95),
          retainedHeapDeltaMiB: Math.max(...activationHeapMiB),
        },
        focusLatest100: {
          p50Ms: percentile(focusMs, 50),
          p95Ms: percentile(focusMs, 95),
          items: focusItems,
        },
        loadOlderPage100: {
          p50Ms: percentile(pageMs, 50),
          p95Ms: percentile(pageMs, 95),
        },
        streamBatchCommit: {
          p50Ms: percentile(streamMs, 50),
          p95Ms: percentile(streamMs, 95),
        },
        bootstrapWireBytes: bootstrapBytes,
        bootstrapKiB: bootstrapBytes / 1024,
        materializedRowsBounded: focusItems <= 100,
        concurrentStreams10Ms,
        concurrentStreamsPersisted: concurrentRow?.count ?? 0,
      },
      budgets: {
        activation100kP95Ms: 300,
        activationHeapDeltaMiB: ACTIVATION_HEAP_BUDGET_MIB,
        focusLatest100P95Ms: 100,
        loadOlderPage100P95Ms: 100,
        streamBatchCommitP95Ms: 20,
        bootstrapKiB: 500,
      },
    };

    console.log(JSON.stringify(report, null, 2));
    console.log('\nPhase 4 release bench');
    console.log(
      `| metric | p50 | p95 | budget |`,
    );
    console.log(
      `| activation @100k | ${report.results.activation100k.p50Ms.toFixed(2)}ms | ${report.results.activation100k.p95Ms.toFixed(2)}ms | <300ms |`,
    );
    console.log(
      `| activation retained heap | ${report.results.activation100k.retainedHeapDeltaMiB.toFixed(2)} MiB | — | <${ACTIVATION_HEAP_BUDGET_MIB} MiB |`,
    );
    console.log(
      `| focus latest 100 | ${report.results.focusLatest100.p50Ms.toFixed(2)}ms | ${report.results.focusLatest100.p95Ms.toFixed(2)}ms | <100ms |`,
    );
    console.log(
      `| page 100 | ${report.results.loadOlderPage100.p50Ms.toFixed(2)}ms | ${report.results.loadOlderPage100.p95Ms.toFixed(2)}ms | <100ms |`,
    );
    console.log(
      `| stream batch | ${report.results.streamBatchCommit.p50Ms.toFixed(2)}ms | ${report.results.streamBatchCommit.p95Ms.toFixed(2)}ms | <20ms |`,
    );
    console.log(
      `| bootstrap | ${report.results.bootstrapKiB.toFixed(1)} KiB | — | <500 KiB |`,
    );

    if (assertMode) {
      const failures: string[] = [];
      if (report.machine.mode !== 'compiled-js-worker-release-contract') failures.push('not compiled release path');
      if (report.fixture.totalMessages < ACTIVATION_MESSAGES) failures.push('100k fixture');
      if (report.results.activation100k.p95Ms > 300) failures.push('activation p95');
      if (report.results.activation100k.retainedHeapDeltaMiB > ACTIVATION_HEAP_BUDGET_MIB) failures.push('activation heap');
      if (report.results.focusLatest100.p95Ms > 100) failures.push('focus p95');
      if (report.results.loadOlderPage100.p95Ms > 100) failures.push('page p95');
      if (report.results.streamBatchCommit.p95Ms > 20) failures.push('stream p95');
      if (report.results.bootstrapKiB > 500) failures.push('bootstrap size');
      if (!report.results.materializedRowsBounded) failures.push('materialized rows');
      if (report.results.concurrentStreamsPersisted !== 10) failures.push('10 concurrent streams');
      if (failures.length > 0) {
        console.error(`BUDGET FAIL: ${failures.join(', ')}`);
        process.exitCode = 1;
      } else {
        console.log('BUDGET PASS');
      }
    }
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main();
