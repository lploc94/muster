/**
 * Phase 3 row-level transcript benchmark.
 *
 * The fixture grows with unrelated message rows while the measured operation
 * always appends one message to the focused turn through the named repository
 * command. The script reports fixture bytes, p50/p95 and the revision/feed
 * cardinality so a run is evidence rather than an unexplained unit-test time.
 *
 * Run:
 *   npx tsx scripts/bench-sqlite-transcript.ts --sizes 100,1000,10000 --iterations 20
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DbClient } from '../src/task/sqlite/client';
import { SqliteTaskRepository } from '../src/task/repository';
import { TaskStore } from '../src/task/store';
import type { MusterTask, TaskMessage, TaskStoreFile, TaskTurn } from '../src/task/types';

const ISO = '2026-07-17T00:00:00.000Z';
const WORKSPACE = 'bench-workspace';

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))]!;
}

function databaseBytes(dbPath: string): number {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((total, filePath) => {
    try {
      return total + fs.statSync(filePath).size;
    } catch {
      return total;
    }
  }, 0);
}

function taskRow(id: string, goal: string): { sql: string; params: (string | number | null)[] } {
  return {
    sql: `INSERT INTO tasks
      (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
       revision, created_at, updated_at, payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [id, WORKSPACE, null, 'worker', 'open', 'released', goal, 'grok', null,
      0, ISO, ISO, JSON.stringify({ payloadVersion: 1, capabilities: [], executionPolicy: { maxTurns: 100, maxAutomaticRetries: 0 } })],
  };
}

async function seed(client: DbClient, unrelatedMessages: number): Promise<SqliteTaskRepository> {
  const repository = new SqliteTaskRepository(client, WORKSPACE);
  await repository.execute({
    kind: 'upsertWorkspace', workspaceId: WORKSPACE, identityKey: `bench-${unrelatedMessages}`,
    displayName: 'Transcript benchmark', createdAt: ISO, lastOpenedAt: ISO,
  });

  const statements = [taskRow('focus-task', 'focused task'), taskRow('unrelated-task', 'unrelated rows')];
  statements.push({
    sql: `INSERT INTO turns
      (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    params: ['focus-turn', WORKSPACE, 'focus-task', 1, 'running', 'user', ISO, ISO, null, JSON.stringify({ payloadVersion: 1 })],
  });
  for (let i = 0; i < unrelatedMessages; i += 1) {
    statements.push({
      sql: `INSERT INTO messages
        (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        `unrelated-message-${i}`, WORKSPACE, 'unrelated-task', null, 'assistant', 'complete', i,
        `unrelated payload ${'x'.repeat(256)}`, ISO, null, JSON.stringify({ payloadVersion: 1 }),
      ],
    });
  }
  await client.transaction(statements);
  return repository;
}

interface Measurement {
  unrelatedMessages: number;
  dbBytes: number;
  p50Ms: number;
  p95Ms: number;
  feedRevisions: number;
  feedRows: number;
  unrelatedUnchanged: boolean;
  beforeJsonBytes: number;
  beforeJsonP50Ms: number;
  beforeJsonP95Ms: number;
  beforeJsonUnrelatedUnchanged: boolean;
}

interface LegacyMeasurement {
  bytes: number;
  p50Ms: number;
  p95Ms: number;
  unrelatedUnchanged: boolean;
}

function legacyTask(id: string): MusterTask {
  return {
    id, parentId: null, role: 'worker', lifecycle: 'open', goal: id,
    dependencies: [], backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 100, maxAutomaticRetries: 0 },
    revision: 0, createdAt: ISO, updatedAt: ISO,
  };
}

function measureLegacyJson(unrelatedMessages: number, iterations: number): LegacyMeasurement {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-json-transcript-bench-'));
  const filePath = path.join(dir, '.muster-tasks.json');
  try {
    const focusTurn: TaskTurn = {
      id: 'focus-turn', taskId: 'focus-task', sequence: 1, status: 'running',
      trigger: 'user', inputs: [], createdAt: ISO, startedAt: ISO,
    };
    const file: TaskStoreFile = {
      schemaVersion: 6, revision: 0,
      tasks: { 'focus-task': legacyTask('focus-task'), 'unrelated-task': legacyTask('unrelated-task') },
      turns: { [focusTurn.id]: focusTurn }, messages: {}, operations: {}, cancelRequests: {},
      toolCalls: {}, reasoning: {}, sendReceipts: {}, runtimeClaims: {},
    };
    for (let i = 0; i < unrelatedMessages; i += 1) {
      const message: TaskMessage = {
        id: `unrelated-message-${i}`, taskId: 'unrelated-task', role: 'assistant',
        content: `unrelated payload ${'x'.repeat(256)}`, state: 'complete', order: i,
        createdAt: ISO,
      };
      file.messages[message.id] = message;
    }
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8');
    const bytes = fs.statSync(filePath).size;
    const store = TaskStore.load({ filePath });
    const baseline = store.getFile().messages['unrelated-message-0']?.content;
    const beforeRevision = store.getFile().revision;
    const durations: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      const result = store.commit((draft) => {
        const message: TaskMessage = {
          id: `focused-stream-${i}`, taskId: 'focus-task', turnId: focusTurn.id,
          role: 'assistant', content: `focused chunk ${i}`, state: 'partial', order: i,
          createdAt: ISO,
        };
        draft.messages[message.id] = message;
        return { ok: true };
      });
      if (!result.ok) throw new Error(`legacy JSON benchmark commit failed: ${result.reason}`);
      durations.push(performance.now() - started);
    }
    return {
      bytes,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      unrelatedUnchanged:
        store.getFile().messages['unrelated-message-0']?.content === baseline &&
        store.getFile().revision - beforeRevision === iterations,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function measure(unrelatedMessages: number, iterations: number): Promise<Measurement> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-sqlite-bench-'));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({
    workerPath: path.join(__dirname, '../src/task/sqlite/worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  try {
    await client.open(dbPath);
    const repository = await seed(client, unrelatedMessages);
    const revisionBefore = await client.get<{ revision: number }>(
      'SELECT revision FROM workspace_revisions WHERE workspace_id = ?', [WORKSPACE],
    );
    const baseline = await client.get<{ content: string }>(
      'SELECT content FROM messages WHERE workspace_id = ? AND id = ?', [WORKSPACE, 'unrelated-message-0'],
    );
    const durations: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: WORKSPACE, taskId: 'focus-task',
        messages: [{
          id: `focused-stream-${i}`, taskId: 'focus-task', turnId: 'focus-turn', role: 'assistant',
          content: `focused chunk ${i}`, state: 'partial', order: i, createdAt: ISO,
        }],
      });
      durations.push(performance.now() - started);
    }
    const after = await client.get<{ revision: number }>(
      'SELECT revision FROM workspace_revisions WHERE workspace_id = ?', [WORKSPACE],
    );
    const feed = await client.get<{ revisions: number; rows: number }>(
      `SELECT COUNT(DISTINCT revision) AS revisions, COUNT(*) AS rows
         FROM change_log WHERE workspace_id = ? AND revision > ?`,
      [WORKSPACE, revisionBefore?.revision ?? 0],
    );
    const unchanged = await client.get<{ content: string }>(
      'SELECT content FROM messages WHERE workspace_id = ? AND id = ?', [WORKSPACE, 'unrelated-message-0'],
    );
    const legacy = measureLegacyJson(unrelatedMessages, iterations);
    return {
      unrelatedMessages,
      dbBytes: databaseBytes(dbPath),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      feedRevisions: feed?.revisions ?? 0,
      feedRows: feed?.rows ?? 0,
      unrelatedUnchanged: unchanged?.content === baseline?.content && (after?.revision ?? 0) - (revisionBefore?.revision ?? 0) === iterations,
      beforeJsonBytes: legacy.bytes,
      beforeJsonP50Ms: legacy.p50Ms,
      beforeJsonP95Ms: legacy.p95Ms,
      beforeJsonUnrelatedUnchanged: legacy.unrelatedUnchanged,
    };
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sizes = (args.includes('--sizes') ? args[args.indexOf('--sizes') + 1] : '100,1000,10000')
    .split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 0);
  const iterationsArg = args.includes('--iterations') ? Number(args[args.indexOf('--iterations') + 1]) : 20;
  const iterations = Number.isInteger(iterationsArg) && iterationsArg > 0 ? iterationsArg : 20;
  const results = [];
  for (const size of sizes) results.push(await measure(size, iterations));
  const meta = {
    machine: `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? 'unknown-cpu'}`,
    node: process.version,
    mode: 'tsx development benchmark (SQLite TypeScript worker + legacy synchronous JSON TaskStore)',
    iterations,
    timestamp: new Date().toISOString(),
  };
  if (args.includes('--json')) {
    console.log(JSON.stringify({ meta, results }, null, 2));
    return;
  }
  console.log('\n=== Phase 3 SQLite row-level transcript benchmark ===');
  console.log(`machine    : ${meta.machine}`);
  console.log(`node       : ${meta.node}`);
  console.log(`mode       : ${meta.mode}`);
  console.log(`iterations : ${iterations} appends/size`);
  console.log('size       JSON KiB JSON p95  SQLite KiB SQLite p95  feed(rev/rows)  unchanged');
  console.log('--------------------------------------------------------------------------------');
  for (const result of results) {
    console.log(`${String(result.unrelatedMessages).padEnd(10)} ${(result.beforeJsonBytes / 1024).toFixed(1).padStart(8)} ${result.beforeJsonP95Ms.toFixed(2).padStart(8)} ${(result.dbBytes / 1024).toFixed(1).padStart(10)} ${result.p95Ms.toFixed(2).padStart(10)} ${`${result.feedRevisions}/${result.feedRows}`.padStart(15)} ${result.unrelatedUnchanged && result.beforeJsonUnrelatedUnchanged ? 'yes' : 'NO'}`);
  }
  if (results.some((result) => !result.unrelatedUnchanged || !result.beforeJsonUnrelatedUnchanged ||
      result.feedRows !== iterations || result.feedRevisions !== iterations)) {
    throw new Error('row-level benchmark invariant failed: unrelated rows or revision/feed cardinality changed');
  }
}

void main();
