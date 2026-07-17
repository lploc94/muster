/**
 * Phase 4 release-oriented performance gate (P4-W11).
 *
 * Measures compiled-path repository contracts (not HMR/dev-only unit duration):
 * - focus latest 100
 * - load older page 100
 * - bootstrap snapshot wire bytes
 * - streaming batch commit p50/p95
 * - materialized DTO/row bounds
 *
 * Usage:
 *   npx tsx scripts/bench-phase4-release.ts --iterations 20
 *   npx tsx scripts/bench-phase4-release.ts --assert
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DbClient } from '../src/task/sqlite/client';
import { SqliteTaskRepository } from '../src/task/repository';
import { buildRepositorySnapshot } from '../src/host/repository-snapshot';
import { CHANGE_FEED_RETAIN_REVISIONS, SQLITE_SCHEMA_VERSION } from '../src/task/sqlite/schema';

const ISO = '2026-07-17T00:00:00.000Z';
const WORKSPACE = 'phase4-bench';
const assertMode = process.argv.includes('--assert');
const iterationsArg = process.argv.find((a) => a.startsWith('--iterations='));
const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : 12;

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
        createdAt: `2026-07-17T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`,
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

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-phase4-bench-'));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({
    workerPath: path.join(__dirname, '../src/task/sqlite/worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  try {
    await client.open(dbPath);
    const repo = new SqliteTaskRepository(client, WORKSPACE);
    await seedFocusedTranscript(repo, client, 10_000);

    // Warm-up
    await repo.getTranscriptPage('focus', undefined, 100);
    await buildRepositorySnapshot(repo, WORKSPACE, 'focus', new Map());

    const focusMs: number[] = [];
    const pageMs: number[] = [];
    const streamMs: number[] = [];
    let bootstrapBytes = 0;
    let focusItems = 0;

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

    const report = {
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        model: os.cpus()[0]?.model,
        node: process.version,
        schemaVersion: SQLITE_SCHEMA_VERSION,
        changeFeedRetain: CHANGE_FEED_RETAIN_REVISIONS,
        mode: 'tsx-worker-release-contract',
      },
      fixture: { focusedTranscriptItems: 10_000, iterations },
      results: {
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
      },
      budgets: {
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
      if (report.results.focusLatest100.p95Ms > 100) failures.push('focus p95');
      if (report.results.loadOlderPage100.p95Ms > 100) failures.push('page p95');
      if (report.results.streamBatchCommit.p95Ms > 20) failures.push('stream p95');
      if (report.results.bootstrapKiB > 500) failures.push('bootstrap size');
      if (!report.results.materializedRowsBounded) failures.push('materialized rows');
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
