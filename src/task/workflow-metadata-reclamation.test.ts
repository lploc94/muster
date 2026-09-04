import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { DbClient, DbWorkerError } from './sqlite/client';
import type { TaskTurn, TurnDisposition } from './types';
import { DEFAULT_WORKFLOW_POLICY } from './workflow';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const WORKSPACE_ID = 'ws';
const NOW = '2026-07-28T00:00:00.000Z';
const clients: DbClient[] = [];
const tempDirs: string[] = [];

type StartEntry = { nodeId: string; taskId: string; activationTurnId: string };
type StartPayload = { runId: string; entries: StartEntry[] };
type Opened = { dir: string; dbPath: string; client: DbClient; repository: SqliteTaskRepository };

const OUTCOME = {
  kind: 'agent' as const,
  requireExplicitDisposition: true as const,
  next: { when: 'The result is complete.' },
  fail: { when: 'The result cannot be produced.' },
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeClient(options: {
  faultCapability?: boolean;
  faultPlan?: { code: 'full' | 'io' | 'busy' | 'readonly'; operation: 'transaction'; remaining: number };
} = {}): DbClient {
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
    ...(options.faultCapability ? { faultCapability: true } : {}),
    ...(options.faultPlan ? { faultPlan: options.faultPlan } : {}),
  });
  clients.push(client);
  return client;
}

async function openRepo(label: string, client = makeClient()): Promise<Opened> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-workflow-reclamation-${label}-`));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'muster.sqlite3');
  await client.open(dbPath);
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?)`,
    [WORKSPACE_ID, label, label, NOW, NOW],
  );
  return { dir, dbPath, client, repository: new SqliteTaskRepository(client, WORKSPACE_ID) };
}

function definition(definitionId: string) {
  return {
    definitionId,
    version: 1,
    name: `Reclamation ${definitionId}`,
    topology: {
      kind: 'workflow' as const,
      inputs: [],
      outputs: [{ name: 'result', semanticKind: 'result', sourceNodeId: 'node' }],
      nodes: [{ nodeId: 'node', title: 'Reclamation node', outcome: OUTCOME }],
      edges: [],
    },
    entryContracts: [],
    policy: DEFAULT_WORKFLOW_POLICY,
    createdAt: NOW,
  };
}

async function startRun(
  repository: SqliteTaskRepository,
  definitionId: string,
  key: string,
): Promise<{ runId: string; entry: StartEntry }> {
  const source = definition(definitionId);
  await expect(repository.execute({
    kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, ...source,
  })).resolves.toMatchObject({ ok: true, changed: true });
  const started = await repository.execute({
    kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID,
    definitionId, version: 1, startIdempotencyKey: key, createdAt: NOW,
    goal: 'reclamation fixture', backend: 'grok',
  });
  expect(started).toMatchObject({ ok: true, changed: true });
  const data = started.operation?.result?.data as StartPayload;
  expect(data.entries).toHaveLength(1);
  return { runId: data.runId, entry: data.entries[0]! };
}

async function markRunning(client: DbClient, entry: StartEntry): Promise<void> {
  await client.transaction([
    {
      sql: `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL
             WHERE workspace_id = ? AND id = ?`,
      params: ['2026-07-28T00:00:01.000Z', WORKSPACE_ID, entry.activationTurnId],
    },
    {
      sql: `UPDATE workflow_activations SET status = 'running', updated_at = ?
             WHERE workspace_id = ? AND execution_turn_id = ?`,
      params: ['2026-07-28T00:00:01.000Z', WORKSPACE_ID, entry.activationTurnId],
    },
  ]);
}

async function closeWithFailure(
  ctx: Opened,
  run: { runId: string; entry: StartEntry },
  reason: string,
): Promise<void> {
  await markRunning(ctx.client, run.entry);
  const task = await ctx.repository.getTask(run.entry.taskId);
  const turn = await ctx.repository.getTurn(run.entry.activationTurnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  const disposition: TurnDisposition = { kind: 'workflow_fail', reason };
  await expect(stageDispositionForSettlement(
    ctx.repository, turn!, disposition, `reclamation:${run.runId}`,
  )).resolves.toMatchObject({ changed: true });
  await expect(ctx.repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: WORKSPACE_ID,
    expectedTaskRevision: task!.revision,
    task: { ...task!, updatedAt: NOW },
    turn: { ...turn!, status: 'succeeded', finishedAt: NOW, disposition },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  })).resolves.toMatchObject({ changed: true });
}

async function addTransportBody(client: DbClient, runId: string, messageId: string, body: string): Promise<void> {
  await client.run(
    `INSERT INTO workflow_routed_messages (
       workspace_id, run_id, message_id, source_node_id, destination_node_id,
       kind, body_json, created_at
     ) VALUES (?, ?, ?, 'node', 'node', 'terminal_next', ?, ?)`,
    [WORKSPACE_ID, runId, messageId, body, NOW],
  );
}

async function rowCount(client: DbClient, table: string, runId: string): Promise<number> {
  const row = await client.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? AND run_id = ?`,
    [WORKSPACE_ID, runId],
  );
  return row?.count ?? 0;
}

describe('terminal workflow metadata reclamation', () => {
  it('strips terminal transport bodies but preserves closure, authority, and replay state', async () => {
    const ctx = await openRepo('terminal-preserve');
    const run = await startRun(ctx.repository, 'wf-terminal-preserve', 'terminal-preserve');
    await closeWithFailure(ctx, run, 'bounded failure report to retain');
    await addTransportBody(ctx.client, run.runId, 'transport-body', '{"transport":"strip"}');

    const closureBefore = await ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [WORKSPACE_ID, run.runId],
    );
    expect(closureBefore).toBeTruthy();
    const authorityBefore = await Promise.all([
      rowCount(ctx.client, 'workflow_run_components', run.runId),
      rowCount(ctx.client, 'workflow_run_input_contracts', run.runId),
      rowCount(ctx.client, 'workflow_run_output_contracts', run.runId),
      rowCount(ctx.client, 'workflow_run_node_specs', run.runId),
      rowCount(ctx.client, 'workflow_run_edges', run.runId),
    ]);

    await expect(ctx.repository.execute({
      kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
    })).resolves.toMatchObject({ ok: true, changed: true, strippedWorkflowMessageBodies: 1 });
    await expect(ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = 'transport-body'`,
      [WORKSPACE_ID, run.runId],
    )).resolves.toEqual({ body_json: '{"retentionStripped":true}' });
    await expect(ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [WORKSPACE_ID, run.runId],
    )).resolves.toEqual(closureBefore);
    await expect(Promise.all([
      rowCount(ctx.client, 'workflow_run_components', run.runId),
      rowCount(ctx.client, 'workflow_run_input_contracts', run.runId),
      rowCount(ctx.client, 'workflow_run_output_contracts', run.runId),
      rowCount(ctx.client, 'workflow_run_node_specs', run.runId),
      rowCount(ctx.client, 'workflow_run_edges', run.runId),
    ])).resolves.toEqual(authorityBefore);
    await expect(ctx.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);

    await expect(ctx.repository.execute({
      kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
    })).resolves.toMatchObject({ ok: true, changed: false, strippedWorkflowMessageBodies: 0 });
  });

  it('does not strip live runs or runs with a pending root continuation', async () => {
    const ctx = await openRepo('liveness-boundary');
    const live = await startRun(ctx.repository, 'wf-live', 'live');
    await addTransportBody(ctx.client, live.runId, 'live-body', '{"live":true}');

    const waiting = await startRun(ctx.repository, 'wf-waiting', 'waiting');
    await closeWithFailure(ctx, waiting, 'waiting continuation');
    await ctx.client.run(
      `INSERT INTO workflow_continuations (
         workspace_id, run_id, continuation_id, caller_task_id, caller_turn_id,
         kind, status, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, 'start_wait', 'pending', ?, ?, ?)`,
      [WORKSPACE_ID, waiting.runId, 'pending-root-resume', '{"payloadVersion":1}', NOW, NOW],
    );
    await addTransportBody(ctx.client, waiting.runId, 'waiting-body', '{"waiting":true}');

    await expect(ctx.repository.execute({
      kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
    })).resolves.toMatchObject({ ok: true, changed: false, strippedWorkflowMessageBodies: 0 });
    await expect(ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
      [WORKSPACE_ID, live.runId, 'live-body'],
    )).resolves.toEqual({ body_json: '{"live":true}' });
    await expect(ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
      [WORKSPACE_ID, waiting.runId, 'waiting-body'],
    )).resolves.toEqual({ body_json: '{"waiting":true}' });
  });

  it('retains a bounded closure detail while stripping other routed payloads', async () => {
    const ctx = await openRepo('closure-report');
    const run = await startRun(ctx.repository, 'wf-closure-report', 'closure-report');
    const report = 'unique retained node report';
    await closeWithFailure(ctx, run, report);
    await addTransportBody(ctx.client, run.runId, 'ordinary-route', '{"report":"do not retain"}');
    const before = await ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [WORKSPACE_ID, run.runId],
    );
    expect(JSON.parse(before!.body_json)).toMatchObject({
      detail: { report: { text: report, truncated: false } },
    });
    await ctx.repository.execute({ kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID });
    const after = await ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [WORKSPACE_ID, run.runId],
    );
    expect(after).toEqual(before);
    await expect(ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = 'ordinary-route'`,
      [WORKSPACE_ID, run.runId],
    )).resolves.toEqual({ body_json: '{"retentionStripped":true}' });
  });

  it('rolls back a reclamation fault without changing any payload', async () => {
    const setup = await openRepo('fault-setup');
    const run = await startRun(setup.repository, 'wf-fault', 'fault');
    await closeWithFailure(setup, run, 'fault rollback report');
    await addTransportBody(setup.client, run.runId, 'fault-body', '{"must":"remain"}');
    const dbPath = setup.dbPath;
    await setup.client.close();

    const faultClient = makeClient({
      faultCapability: true,
      faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
    });
    await faultClient.open(dbPath);
    const faultRepository = new SqliteTaskRepository(faultClient, WORKSPACE_ID);
    await expect(faultRepository.execute({
      kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
    })).rejects.toBeInstanceOf(DbWorkerError);
    await faultClient.close();

    const retryClient = makeClient();
    await retryClient.open(dbPath);
    const retryRepository = new SqliteTaskRepository(retryClient, WORKSPACE_ID);
    await expect(retryClient.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages
        WHERE workspace_id = ? AND run_id = ? AND message_id = 'fault-body'`,
      [WORKSPACE_ID, run.runId],
    )).resolves.toEqual({ body_json: '{"must":"remain"}' });
    await expect(retryRepository.execute({
      kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
    })).resolves.toMatchObject({ ok: true, changed: true, strippedWorkflowMessageBodies: 1 });
    await expect(retryClient.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
  });
});
