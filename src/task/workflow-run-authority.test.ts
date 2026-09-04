import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../bridge/credentials';
import { TaskEngine } from './engine';
import { SqliteTaskRepository } from './repository';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { DbClient } from './sqlite/client';
import { IncompatibleSchemaError, openStoreDatabase } from './sqlite/connection';
import { resetDatabaseAtPath } from './sqlite/reset';
import { MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './sqlite/schema';
import type { TurnDisposition } from './types';
import { DEFAULT_WORKFLOW_POLICY, makeGraphFanInDefinition, makeOneNodeDefinition } from './workflow';
import { fingerprintWorkflowDefinition } from './workflow-codec';

const tempDirs: string[] = [];
const clients: DbClient[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-authority-'));
  tempDirs.push(dir);
  return path.join(dir, 'muster.sqlite3');
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function tables(db: DatabaseSync): string[] {
  return (db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>)
    .map((row) => row.name);
}

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const WS = 'ws';
const NOW = '2026-07-28T00:00:00.000Z';

type StartEntry = { nodeId: string; taskId: string; activationTurnId: string };
type StartPayload = { runId: string; entries: StartEntry[] };
type OwnedCaller = { taskId: string; turnId: string };

function makeClient(): DbClient {
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  return client;
}

async function openRepo(label: string): Promise<{ dir: string; dbPath: string; client: DbClient; repository: SqliteTaskRepository }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-workflow-authority-${label}-`));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = makeClient();
  await client.open(dbPath);
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
    [WS, label, label, NOW, NOW],
  );
  return { dir, dbPath, client, repository: new SqliteTaskRepository(client, WS) };
}

async function defineAndStart(
  repository: SqliteTaskRepository,
  definitionId: string,
  startKey: string,
  definition = makeOneNodeDefinition({ definitionId, createdAt: NOW }),
  owner?: OwnedCaller,
): Promise<{ runId: string; entry: StartEntry; definitionId: string; owner?: OwnedCaller }> {
  await expect(repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: WS,
    definitionId: definition.definitionId,
    version: definition.version,
    name: definition.name,
    topology: definition.topology,
    createdAt: NOW,
  })).resolves.toMatchObject({ ok: true, changed: true });
  const started = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: WS,
    definitionId: definition.definitionId,
    version: definition.version,
    startIdempotencyKey: startKey,
    createdAt: NOW,
    goal: 'run authority fixture',
    backend: 'grok',
    ...(owner
      ? {
          ownerRootTaskId: owner.taskId,
          callerTaskId: owner.taskId,
          callerTurnId: owner.turnId,
        }
      : {}),
  });
  expect(started).toMatchObject({ ok: true, changed: true });
  const data = started.operation?.result?.data as StartPayload;
  expect(data.entries).toHaveLength(1);
  return { runId: data.runId, entry: data.entries[0]!, definitionId: definition.definitionId, owner };
}

async function createOwnedCaller(repository: SqliteTaskRepository, key: string): Promise<OwnedCaller> {
  const taskId = `authority-owner-${key}`;
  const turnId = `authority-owner-turn-${key}`;
  await repository.execute({
    kind: 'createTask',
    workspaceId: WS,
    task: {
      id: taskId,
      role: 'coordinator',
      lifecycle: 'open',
      releaseState: 'released',
      goal: 'authority owned root',
      parentId: null,
      prerequisites: [],
      backend: 'grok',
      capabilities: ['create_child'],
      executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 },
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      releasedAt: NOW,
    },
  });
  await repository.execute({
    kind: 'createTurn',
    workspaceId: WS,
    turn: {
      id: turnId,
      taskId,
      sequence: 1,
      status: 'running',
      trigger: 'user',
      inputs: [],
      createdAt: NOW,
      startedAt: NOW,
    },
  });
  return { taskId, turnId };
}

async function markRunning(client: DbClient, entry: StartEntry): Promise<void> {
  await client.transaction([
    {
      sql: `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL WHERE workspace_id = ? AND id = ?`,
      params: ['2026-07-28T00:00:01.000Z', WS, entry.activationTurnId],
    },
    {
      sql: `UPDATE workflow_activations SET status = 'running', updated_at = ? WHERE workspace_id = ? AND execution_turn_id = ?`,
      params: ['2026-07-28T00:00:01.000Z', WS, entry.activationTurnId],
    },
  ]);
}

async function closeWithExplicitFail(
  ctx: { client: DbClient; repository: SqliteTaskRepository },
  run: { runId: string; entry: StartEntry },
  reason: string,
): Promise<void> {
  await markRunning(ctx.client, run.entry);
  const task = await ctx.repository.getTask(run.entry.taskId);
  const turn = await ctx.repository.getTurn(run.entry.activationTurnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  const disposition: TurnDisposition = { kind: 'workflow_fail', reason };
  await expect(stageDispositionForSettlement(ctx.repository, turn!, disposition, `authority:${run.runId}`))
    .resolves.toMatchObject({ changed: true });
  await expect(ctx.repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: WS,
    expectedTaskRevision: task!.revision,
    task: { ...task!, updatedAt: NOW },
    turn: { ...turn!, status: 'succeeded', finishedAt: NOW, disposition },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  })).resolves.toMatchObject({ changed: true });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('schema 8 run-owned workflow authority', () => {
  it('creates the run authority tables and removes nested-run authority', () => {
    expect(SQLITE_SCHEMA_VERSION).toBe(8);
    const dbPath = tempDbPath();
    const db = openStoreDatabase({ path: dbPath });
    try {
      expect(tables(db)).toEqual(expect.arrayContaining([
        'workflow_run_components',
        'workflow_run_input_contracts',
        'workflow_run_output_contracts',
        'workflow_run_node_specs',
        'workflow_run_edges',
      ]));
      expect(tables(db)).not.toContain('workflow_return_gates');
      expect(columns(db, 'workflow_runs')).toEqual(expect.arrayContaining([
        'authority_kind',
        'authority_fingerprint',
        'source_definition_id',
        'source_definition_version',
        'closure_id',
      ]));
      expect(columns(db, 'workflow_runs')).not.toEqual(expect.arrayContaining([
        'definition_id',
        'definition_version',
        'origin',
        'parent_run_id',
        'children_reserved',
      ]));
      expect(columns(db, 'workflow_definition_outputs')).toContain('source_node_id');
      expect(columns(db, 'workflow_definition_outputs')).not.toContain('terminal_node_id');
      expect(columns(db, 'workflow_activations')).not.toEqual(expect.arrayContaining([
        'return_gate_id',
        'inherited_feedback_round_id',
        'inherited_feedback_target_node_id',
      ]));
    } finally {
      db.close();
    }
  });

  it('refuses a schema 7 marker until an explicit reset creates schema 8', () => {
    const dbPath = tempDbPath();
    const db = openStoreDatabase({ path: dbPath });
    db.close();
    const stale = new DatabaseSync(dbPath);
    stale.exec(`PRAGMA application_id = ${MUSTER_APPLICATION_ID}`);
    stale.exec('PRAGMA user_version = 7');
    stale.close();
    expect(() => openStoreDatabase({ path: dbPath })).toThrow(IncompatibleSchemaError);
    expect(resetDatabaseAtPath(dbPath)).toEqual({ schemaVersion: 8 });
  });
});

describe('run-owned execution authority', () => {
  it('snapshots complete ordered authority on ordinary start', async () => {
    const ctx = await openRepo('snapshot-complete');
    const definition = makeOneNodeDefinition({ definitionId: 'wf-authority-complete', createdAt: NOW });
    const run = await defineAndStart(ctx.repository, definition.definitionId, 'complete', definition);

    const runRow = await ctx.client.get<{ authority_kind: string; authority_fingerprint: string; source_definition_id: string; source_definition_version: number }>(
      `SELECT authority_kind, authority_fingerprint, source_definition_id, source_definition_version FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
      [WS, run.runId],
    );
    expect(runRow).toMatchObject({ authority_kind: 'definition', source_definition_id: definition.definitionId, source_definition_version: 1 });
    expect(runRow?.authority_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    await expect(ctx.client.all(
      `SELECT component_key, ordinal, source_kind, workflow_ref FROM workflow_run_components WHERE workspace_id = ? AND run_id = ? ORDER BY ordinal`,
      [WS, run.runId],
    )).resolves.toEqual([{
      component_key: 'definition',
      ordinal: 0,
      source_kind: 'workflow',
      workflow_ref: `${definition.definitionId}@1`,
    }]);
    await expect(ctx.client.all(
      `SELECT name, semantic_kind, source_node_id, ordinal FROM workflow_run_output_contracts WHERE workspace_id = ? AND run_id = ? ORDER BY ordinal`,
      [WS, run.runId],
    )).resolves.toEqual([{
      name: 'result',
      semantic_kind: 'result',
      source_node_id: 'entry',
      ordinal: 0,
    }]);
    await expect(ctx.client.all(
      `SELECT COUNT(*) AS count FROM workflow_run_input_contracts WHERE workspace_id = ? AND run_id = ?`,
      [WS, run.runId],
    )).resolves.toEqual([{ count: 0 }]);

    const nodeRows = await ctx.client.all<{ node_id: string; ordinal: number; outcome_kind: string; outcome_json: string }>(
      `SELECT node_id, ordinal, outcome_kind, outcome_json FROM workflow_run_node_specs WHERE workspace_id = ? AND run_id = ? ORDER BY ordinal`,
      [WS, run.runId],
    );
    expect(nodeRows).toHaveLength(1);
    expect(nodeRows[0]).toMatchObject({ node_id: 'entry', ordinal: 0, outcome_kind: 'agent' });
    expect(JSON.parse(nodeRows[0]!.outcome_json)).toMatchObject({
      kind: 'agent',
      requireExplicitDisposition: true,
      next: { when: 'The result is complete.' },
      fail: { when: 'The result cannot be produced.' },
    });
    await expect(ctx.client.all(
      `SELECT COUNT(*) AS count FROM workflow_run_edges WHERE workspace_id = ? AND run_id = ?`,
      [WS, run.runId],
    )).resolves.toEqual([{ count: 0 }]);

    const authority = await ctx.repository.getWorkflowRunAuthority(run.runId);
    expect(authority).toBeTruthy();
    expect(authority?.kind).toBe('definition');
    expect(authority?.fingerprint).toBe(runRow?.authority_fingerprint);
    expect(authority?.definition.topology.nodes).toHaveLength(1);
    expect(authority?.definition.topology.nodes[0]).toMatchObject({
      nodeId: 'entry',
      outcome: {
        kind: 'agent',
        requireExplicitDisposition: true,
        next: { when: 'The result is complete.' },
        fail: { when: 'The result cannot be produced.' },
      },
    });
    expect(authority?.components).toHaveLength(1);
    expect(authority?.nodeProvenance.get('entry')).toEqual({ componentKey: 'definition', localNodeKey: 'entry' });
  });

  it('uses the frozen snapshot after source version change and reload for explicit fail', async () => {
    const ctx = await openRepo('frozen-explicit-fail');
    const v1 = makeOneNodeDefinition({ definitionId: 'wf-authority-frozen', createdAt: NOW });
    const run = await defineAndStart(ctx.repository, v1.definitionId, 'frozen', v1);

    const mutatedBase = makeOneNodeDefinition({ definitionId: v1.definitionId, createdAt: NOW });
    const mutatedTopology = {
      ...mutatedBase.topology,
      nodes: [{
        ...mutatedBase.topology.nodes[0]!,
        outcome: {
          kind: 'agent' as const,
          requireExplicitDisposition: true as const,
          next: { when: 'MUTATED after start must not affect this run.' },
          fail: { when: 'MUTATED fail must not affect this run.' },
        },
      }],
    };
    await expect(ctx.repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: WS,
      definitionId: mutatedBase.definitionId,
      version: 2,
      name: mutatedBase.name,
      topology: mutatedTopology,
      createdAt: NOW,
    })).resolves.toMatchObject({ ok: true, changed: true });

    const dbPath = ctx.dbPath;
    await ctx.client.close();
    const reloadedClient = makeClient();
    await reloadedClient.open(dbPath);
    const reloaded = new SqliteTaskRepository(reloadedClient, WS);

    const authority = await reloaded.getWorkflowRunAuthority(run.runId);
    expect(authority?.definition.topology.nodes[0]).toMatchObject({
      outcome: {
        next: { when: 'The result is complete.' },
        fail: { when: 'The result cannot be produced.' },
      },
    });
    await expect(reloadedClient.get<{ outcome_json: string }>(
      `SELECT outcome_json FROM workflow_run_node_specs WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
      [WS, run.runId],
    )).resolves.toMatchObject({ outcome_json: expect.not.stringContaining('MUTATED') });

    const reason = 'frozen explicit report survives source version change';
    await closeWithExplicitFail({ client: reloadedClient, repository: reloaded }, run, reason);
    const closure = await reloadedClient.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [WS, run.runId],
    );
    expect(closure).toBeTruthy();
    const envelope = JSON.parse(closure!.body_json) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      kind: 'run_closure',
      reasonCode: 'agent_fail',
      terminalStatus: 'failed',
      detail: {
        code: 'agent_fail',
        source: 'workflow_fail',
        nodeKey: 'entry',
        report: { text: reason, truncated: false },
      },
    });
    expect(closure!.body_json).not.toContain('MUTATED');

    const owner = await reloadedClient.get<{ owner_root_task_id: string }>(
      `SELECT owner_root_task_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
      [WS, run.runId],
    );
    if (owner?.owner_root_task_id) {
      const completion = await reloaded.getWorkflowRunCompletion(run.runId, owner.owner_root_task_id);
      expect(completion?.failure).toMatchObject({ code: 'agent_fail', report: { text: reason } });
    }
  });

  it('uses the frozen snapshot for three text-only missing decisions after source mutation', async () => {
    const ctx = await openRepo('frozen-decision-repair');
    let engine: TaskEngine | undefined;
    try {
      const createdAt = new Date().toISOString();
      const v1 = makeOneNodeDefinition({ definitionId: 'wf-authority-decision', createdAt });
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: WS,
        definitionId: v1.definitionId,
        version: v1.version,
        name: v1.name,
        topology: v1.topology,
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await ctx.repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: WS,
        definitionId: v1.definitionId,
        version: v1.version,
        startIdempotencyKey: 'frozen-decision',
        createdAt,
        goal: 'frozen decision fixture',
        backend: 'grok',
      });
      const payload = started.operation?.result?.data as StartPayload & { entryTaskId?: string; activationTurnId?: string };
      const runId = payload.runId;
      expect(runId).toBeTruthy();

      const mutatedBase = makeOneNodeDefinition({ definitionId: v1.definitionId, createdAt });
      const mutatedTopology = {
        ...mutatedBase.topology,
        nodes: [{
          ...mutatedBase.topology.nodes[0]!,
          outcome: {
            kind: 'agent' as const,
            requireExplicitDisposition: true as const,
            next: { when: 'MUTATED decision text must not appear in repair.' },
            fail: { when: 'MUTATED fail must not appear in repair.' },
          },
        }],
      };
      await expect(ctx.repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: WS,
        definitionId: mutatedBase.definitionId,
        version: 2,
        name: mutatedBase.name,
        topology: mutatedTopology,
        createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });

      const calls: Array<{ prompt: string }> = [];
      engine = await TaskEngine.loadAsync({
        repository: ctx.repository,
        workspaceId: WS,
        credentialRegistry: new CredentialRegistry(),
        makeBackend: () => ({
          name: 'grok',
          capabilities: { supportsMCP: true, supportsReasoning: false, supportsDetailedToolEvents: false },
          run: async function* () {},
        }),
        runTurn: async function* (_backend, options) {
          if (options.input.kind !== 'agent') throw new Error('expected agent input');
          calls.push({ prompt: options.input.prompt });
          await options.onBeforePrompt?.();
          yield { type: 'sessionStarted', sessionId: 'frozen-decision-session' };
          yield {
            type: 'assistantDelta',
            messageId: `frozen-decision-response-${calls.length}`,
            content: [
              'I will not perform this request.',
              'Je refuse de poursuivre cette demande.',
              'No puedo continuar; frozen snapshot report.',
            ][calls.length - 1]!,
          };
          yield { type: 'turnCompleted' };
        },
      });

      for (let attempt = 0; attempt < 200; attempt += 1) {
        await engine.whenIdle();
        const row = await ctx.client.get<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
          [WS, runId],
        );
        if (row?.status === 'failed') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      expect(calls).toHaveLength(3);
      expect(calls[0]?.prompt).toContain('The result is complete.');
      expect(calls[0]?.prompt).not.toContain('MUTATED');
      const closure = await ctx.client.get<{ body_json: string }>(
        `SELECT body_json FROM workflow_routed_messages WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
        [WS, runId],
      );
      expect(closure).toBeTruthy();
      expect(JSON.parse(closure!.body_json)).toMatchObject({
        reasonCode: 'decision_missing',
        detail: {
          code: 'decision_missing',
          source: 'decision_exhausted',
          nodeKey: 'entry',
          attempt: { number: 3, limit: 3 },
          report: { text: 'No puedo continuar; frozen snapshot report.' },
        },
      });
      expect(closure!.body_json).not.toContain('MUTATED');
    } finally {
      await engine?.shutdown().catch(() => undefined);
    }
  }, 30_000);

  it('fails closed on independent authority corruption without source fallback', async () => {
    const sourceCtx = await openRepo('source-mutation-keeps-run');
    const sourceRun = await defineAndStart(sourceCtx.repository, 'wf-authority-source', 'source');
    await sourceCtx.client.run('DROP TRIGGER trg_workflow_definition_nodes_immutable_update');
    await sourceCtx.client.run(
      `UPDATE workflow_definition_nodes SET outcome_json = ? WHERE workspace_id = ? AND definition_id = ? AND definition_version = 1`,
      [JSON.stringify({
        kind: 'agent',
        requireExplicitDisposition: true,
        next: { when: 'Corrupted source must not leak into the run.' },
        fail: { when: 'Corrupted source fail.' },
      }), WS, 'wf-authority-source'],
    );
    await expect(sourceCtx.repository.getWorkflowRunAuthority(sourceRun.runId)).resolves.toBeTruthy();
    await expect(sourceCtx.repository.getWorkflowStatusForTask(sourceRun.entry.taskId)).resolves.toMatchObject({
      runStatus: 'running',
    });

    const digestCtx = await openRepo('digest-corruption');
    const digestRun = await defineAndStart(digestCtx.repository, 'wf-authority-digest', 'digest');
    await digestCtx.client.run(
      `UPDATE workflow_runs SET authority_fingerprint = ? WHERE workspace_id = ? AND run_id = ?`,
      ['a'.repeat(64), WS, digestRun.runId],
    );
    await expect(digestCtx.repository.getWorkflowRunAuthority(digestRun.runId)).resolves.toBeUndefined();
    await expect(digestCtx.repository.getWorkflowExecutionContext(digestRun.entry.activationTurnId)).resolves.toBeUndefined();

    const componentCtx = await openRepo('component-corruption');
    const componentRun = await defineAndStart(componentCtx.repository, 'wf-authority-component', 'component');
    await componentCtx.client.run(
      `INSERT INTO workflow_run_components (
         workspace_id, run_id, component_key, ordinal, source_kind, workflow_ref,
         source_definition_id, source_definition_version, source_fingerprint, component_fingerprint
       ) VALUES (?, ?, 'bogus', 5, 'inline', NULL, NULL, NULL, NULL, ?)`,
      [WS, componentRun.runId, 'c'.repeat(64)],
    );
    await expect(componentCtx.repository.getWorkflowRunAuthority(componentRun.runId)).resolves.toBeUndefined();

    const outputCtx = await openRepo('output-corruption');
    const outputRun = await defineAndStart(outputCtx.repository, 'wf-authority-output', 'output');
    await outputCtx.client.run('DROP TRIGGER trg_workflow_run_outputs_immutable_update');
    await outputCtx.client.run(
      `UPDATE workflow_run_output_contracts SET source_node_id = ? WHERE workspace_id = ? AND run_id = ?`,
      ['missing-node', WS, outputRun.runId],
    );
    await expect(outputCtx.repository.getWorkflowRunAuthority(outputRun.runId)).resolves.toBeUndefined();

    const nodeCtx = await openRepo('node-corruption');
    const nodeRun = await defineAndStart(nodeCtx.repository, 'wf-authority-node', 'node');
    await nodeCtx.client.run('DROP TRIGGER trg_workflow_run_nodes_immutable_update');
    await nodeCtx.client.run(
      `UPDATE workflow_run_node_specs SET outcome_json = ? WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
      ['{}', WS, nodeRun.runId],
    );
    await expect(nodeCtx.repository.getWorkflowRunAuthority(nodeRun.runId)).resolves.toBeUndefined();

    const fanCtx = await openRepo('edge-corruption');
    const fanDefinition = makeGraphFanInDefinition({ definitionId: 'wf-authority-edge', createdAt: NOW });
    await expect(fanCtx.repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: WS,
      definitionId: fanDefinition.definitionId,
      version: fanDefinition.version,
      name: fanDefinition.name,
      topology: fanDefinition.topology,
      createdAt: NOW,
    })).resolves.toMatchObject({ ok: true, changed: true });
    const fanStarted = await fanCtx.repository.execute({
      kind: 'startWorkflowRun',
      workspaceId: WS,
      definitionId: fanDefinition.definitionId,
      version: fanDefinition.version,
      startIdempotencyKey: 'edge',
      createdAt: NOW,
      goal: 'edge fixture',
      backend: 'grok',
    });
    const fanRunId = (fanStarted.operation?.result?.data as StartPayload).runId;
    await fanCtx.client.run('DROP TRIGGER trg_workflow_run_edges_immutable_update');
    await fanCtx.client.run(
      `UPDATE workflow_run_edges SET source_node_id = ? WHERE workspace_id = ? AND run_id = ? AND source_node_id = ?`,
      ['missing-producer', WS, fanRunId, 'p1'],
    );
    await expect(fanCtx.repository.getWorkflowRunAuthority(fanRunId)).resolves.toBeUndefined();
  });

  it('contains closure corruption to an unavailable fallback and replays without source reread', async () => {
    const ctx = await openRepo('closure-replay');
    const owner = await createOwnedCaller(ctx.repository, 'closure-replay');
    const run = await defineAndStart(ctx.repository, 'wf-authority-closure', 'closure', undefined, owner);
    const report = 'closure fallback fixture report';
    await closeWithExplicitFail(ctx, run, report);

    const closureId = await ctx.client.get<{ closure_id: string }>(
      `SELECT closure_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
      [WS, run.runId],
    );
    expect(closureId?.closure_id).toBeTruthy();
    await ctx.client.run(
      `UPDATE workflow_routed_messages SET body_json = ? WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      ['{"corrupt":true}', WS, run.runId],
    );

    const status = await ctx.repository.getWorkflowStatusForTask(run.entry.taskId);
    expect(status?.runStatus).toBe('failed');
    expect(JSON.stringify(status)).not.toContain('corrupt');
    const inspection = await ctx.repository.inspectWorkflowRun(run.runId, owner.taskId);
    expect(inspection?.runStatus).toBe('failed');
    expect(inspection?.diagnostics).toContainEqual({ code: 'failure_detail_unavailable' });
    expect(JSON.stringify(inspection)).not.toContain(report);
    expect(JSON.stringify(inspection)).not.toContain('corrupt');
    const completion = await ctx.repository.getWorkflowRunCompletion(run.runId, owner.taskId);
    expect(completion?.failure).toMatchObject({ source: 'engine', code: 'agent_fail' });
    expect(JSON.stringify(completion)).not.toContain(report);
    expect(JSON.stringify(completion)).not.toContain('corrupt');

    await expect(ctx.repository.execute({
      kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WS,
    })).resolves.toMatchObject({ ok: true });
    const replay = await ctx.repository.execute({
      kind: 'startWorkflowRun',
      workspaceId: WS,
      definitionId: 'wf-authority-closure',
      version: 1,
      startIdempotencyKey: 'closure',
      createdAt: NOW,
      goal: 'run authority fixture',
      backend: 'grok',
      ownerRootTaskId: owner.taskId,
      callerTaskId: owner.taskId,
      callerTurnId: owner.turnId,
    });
    expect(replay).toMatchObject({ ok: true, changed: false });
    expect((replay.operation?.result?.data as StartPayload).runId).toBe(run.runId);
    await expect(ctx.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
  });
});

describe('run-authority review hardening (Codex round 1)', () => {
  async function startParams(definitionId: string, key: string) {
    return {
      kind: 'startWorkflowRun' as const,
      workspaceId: WS,
      definitionId,
      version: 1,
      startIdempotencyKey: key,
      createdAt: NOW,
      goal: 'run authority fixture',
      backend: 'grok',
    };
  }

  function publicOperation(rootTaskId: string, callerTurnId: string, opId: string, fingerprint: string) {
    return {
      ledgerKey: `${callerTurnId}:${opId}`,
      fingerprint,
      rootTaskId,
      callerTaskId: rootTaskId,
      callerTurnId,
    };
  }

  async function createPublicCaller(ctx: { repository: SqliteTaskRepository }): Promise<{ taskId: string; turnId: string }> {
    const taskId = 'authority-public-root';
    const turnId = 'authority-public-turn';
    await ctx.repository.execute({
      kind: 'createTask',
      workspaceId: WS,
      task: {
        id: taskId,
        role: 'coordinator',
        lifecycle: 'open',
        releaseState: 'released',
        goal: 'public authority caller',
        parentId: null,
        prerequisites: [],
        backend: 'grok',
        capabilities: ['create_child'],
        executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 },
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
        releasedAt: NOW,
      },
    });
    await ctx.repository.execute({
      kind: 'createTurn',
      workspaceId: WS,
      turn: {
        id: turnId,
        taskId,
        sequence: 1,
        status: 'running',
        trigger: 'user',
        inputs: [],
        createdAt: NOW,
        startedAt: NOW,
      },
    });
    return { taskId, turnId };
  }

  it('ISSUE-1/2: checks the public ledger before liveness/source and preserves fingerprint conflicts', async () => {
    const ctx = await openRepo('public-replay-order');
    const caller = await createPublicCaller(ctx);
    const definition = makeOneNodeDefinition({ definitionId: 'wf-public-replay-order', createdAt: NOW });
    await expect(ctx.repository.execute({
      kind: 'defineWorkflowVersion', workspaceId: WS,
      definitionId: definition.definitionId, version: definition.version,
      name: definition.name, topology: definition.topology, createdAt: NOW,
    })).resolves.toMatchObject({ ok: true, changed: true });
    const op = publicOperation(caller.taskId, caller.turnId, 'start', 'request-fingerprint-a');
    const first = await ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: WS,
      definitionId: definition.definitionId, version: 1,
      startIdempotencyKey: 'public-replay-order', createdAt: NOW,
      goal: 'public replay', backend: 'grok',
      ownerRootTaskId: caller.taskId, callerTaskId: caller.taskId, callerTurnId: caller.turnId,
      publicOperation: op,
    });
    expect(first).toMatchObject({ ok: true, changed: true });

    await ctx.client.run(`UPDATE turns SET status = 'succeeded' WHERE workspace_id = ? AND id = ?`, [WS, caller.turnId]);
    await ctx.client.run('DROP TRIGGER trg_workflow_definition_nodes_immutable_update');
    await ctx.client.run(
      `UPDATE workflow_definition_nodes SET outcome_json = ? WHERE workspace_id = ? AND definition_id = ? AND definition_version = 1`,
      [JSON.stringify({ kind: 'agent', requireExplicitDisposition: true, next: { when: 'source changed' }, fail: { when: 'source changed' } }), WS, definition.definitionId],
    );

    await expect(ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: WS,
      definitionId: definition.definitionId, version: 1,
      startIdempotencyKey: 'public-replay-order', createdAt: NOW,
      goal: 'public replay', backend: 'grok',
      ownerRootTaskId: caller.taskId, callerTaskId: caller.taskId, callerTurnId: caller.turnId,
      publicOperation: op,
    })).resolves.toMatchObject({ ok: true, changed: false });

    await expect(ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: WS,
      definitionId: definition.definitionId, version: 1,
      startIdempotencyKey: 'public-replay-order', createdAt: NOW,
      goal: 'public replay changed', backend: 'grok',
      ownerRootTaskId: caller.taskId, callerTaskId: caller.taskId, callerTurnId: caller.turnId,
      publicOperation: { ...op, fingerprint: 'request-fingerprint-b' },
    })).resolves.toMatchObject({ ok: false, conflict: true, reason: 'operation fingerprint conflict' });
  });

  it('ISSUE-4: rejects mirrored scalar policy corruption', async () => {
    const ctx = await openRepo('policy-mirror-corrupt');
    const run = await defineAndStart(ctx.repository, 'wf-policy-mirror', 'policy-mirror');
    await ctx.client.run('UPDATE workflow_runs SET max_turns_per_task = max_turns_per_task + 1 WHERE workspace_id = ? AND run_id = ?', [WS, run.runId]);
    await expect(ctx.repository.getWorkflowRunAuthority(run.runId)).resolves.toBeUndefined();
  });

  it('ISSUE-7: refuses prior-run inputs when the source authority is corrupt', async () => {
    const ctx = await openRepo('prior-source-authority-corrupt');
    const caller = await createPublicCaller(ctx);
    const sourceDefinition = makeOneNodeDefinition({ definitionId: 'wf-prior-source', createdAt: NOW });
    await expect(ctx.repository.execute({
      kind: 'defineWorkflowVersion', workspaceId: WS,
      definitionId: sourceDefinition.definitionId, version: 1,
      name: sourceDefinition.name, topology: sourceDefinition.topology, createdAt: NOW,
    })).resolves.toMatchObject({ ok: true, changed: true });
    const sourceStarted = await ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: WS,
      definitionId: sourceDefinition.definitionId, version: 1,
      startIdempotencyKey: 'prior-source', createdAt: NOW,
      ownerRootTaskId: caller.taskId, callerTaskId: caller.taskId, callerTurnId: caller.turnId,
    });
    const sourcePayload = sourceStarted.operation?.result?.data as StartPayload & { entryTaskId: string; activationTurnId: string };
    const activation = await ctx.client.get<{ activation_id: string }>(
      `SELECT activation_id FROM workflow_activations WHERE workspace_id = ? AND run_id = ?`, [WS, sourcePayload.runId],
    );
    for (const [statementIndex, statement] of [
      { sql: `UPDATE turns SET status = 'succeeded', settled_at = ? WHERE workspace_id = ? AND id = ?`, params: [NOW, WS, sourcePayload.activationTurnId] },
      { sql: `UPDATE workflow_activations SET status = 'consumed' WHERE workspace_id = ? AND run_id = ?`, params: [WS, sourcePayload.runId] },
      { sql: `UPDATE workflow_nodes SET status = 'succeeded' WHERE workspace_id = ? AND run_id = ?`, params: [WS, sourcePayload.runId] },
      { sql: `UPDATE workflow_runs SET status = 'succeeded' WHERE workspace_id = ? AND run_id = ?`, params: [WS, sourcePayload.runId] },
      { sql: `INSERT INTO workflow_artifacts (workspace_id, run_id, artifact_id, producer_node_id, logical_name, revision, kind, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, params: [WS, sourcePayload.runId, 'prior-result-artifact', 'entry', 'next_result', 1, 'next_result', JSON.stringify({ result: 'prior value' }), NOW] },
      { sql: `INSERT INTO workflow_artifact_sources (workspace_id, run_id, artifact_id, artifact_revision, source_kind, producer_run_id, producer_node_id, producer_task_id, producing_turn_id, producing_activation_id) VALUES (?,?,?,?,?,?,?,?,?,?)`, params: [WS, sourcePayload.runId, 'prior-result-artifact', 1, 'workflow_node', sourcePayload.runId, 'entry', sourcePayload.entryTaskId, sourcePayload.activationTurnId, activation?.activation_id] },
    ].entries()) {
      try {
        await ctx.client.run(statement.sql, statement.params);
      } catch (error) {
        throw new Error(`setup statement ${statementIndex} failed: ${String(error)}`);
      }
    }
    await ctx.client.run(`UPDATE workflow_runs SET authority_fingerprint = ? WHERE workspace_id = ? AND run_id = ?`, ['f'.repeat(64), WS, sourcePayload.runId]);

    const consumerDefinition = makeOneNodeDefinition({ definitionId: 'wf-prior-consumer', createdAt: NOW });
    const consumerTopology = {
      ...consumerDefinition.topology,
      inputs: [{ name: 'request', semanticKind: 'result', entryNodeId: 'entry', inputRef: 'request' }],
    };
    await expect(ctx.repository.execute({
      kind: 'defineWorkflowVersion', workspaceId: WS,
      definitionId: consumerDefinition.definitionId, version: 1,
      name: consumerDefinition.name, topology: consumerTopology,
      entryContracts: [{ entryNodeId: 'entry', inputRef: 'request', expectedArtifactKind: 'workflow_input' }], createdAt: NOW,
    })).resolves.toMatchObject({ ok: true, changed: true });
    await expect(ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: WS,
      definitionId: consumerDefinition.definitionId, version: 1,
      startIdempotencyKey: 'prior-consumer', createdAt: NOW,
      ownerRootTaskId: caller.taskId, callerTaskId: caller.taskId, callerTurnId: caller.turnId,
      inputs: [{ name: 'request', fromRun: sourcePayload.runId, output: 'result' }],
    })).resolves.toMatchObject({ ok: false, conflict: true, reason: 'workflow input reference unresolved' });
  });

  it('ISSUE-8: binds caller identity and deadline to run authority integrity', async () => {
    const ctx = await openRepo('identity-deadline-corrupt');
    const run = await defineAndStart(ctx.repository, 'wf-identity-deadline', 'identity-deadline');
    await ctx.client.run(`UPDATE workflow_runs SET deadline_at = ? WHERE workspace_id = ? AND run_id = ?`, ['2099-01-01T00:00:00.000Z', WS, run.runId]);
    await expect(ctx.repository.getWorkflowRunAuthority(run.runId)).resolves.toBeUndefined();
  });

  it('ISSUE-5: treats duplicate run_closure envelopes as unavailable', async () => {
    const ctx = await openRepo('closure-duplicate');
    const owner = await createOwnedCaller(ctx.repository, 'closure-duplicate');
    const run = await defineAndStart(ctx.repository, 'wf-closure-duplicate', 'closure-duplicate', undefined, owner);
    await closeWithExplicitFail(ctx, run, 'duplicate closure report');
    const closure = await ctx.client.get<Record<string, unknown>>(
      `SELECT * FROM workflow_routed_messages WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [WS, run.runId],
    );
    expect(closure).toBeTruthy();
    await ctx.client.run(
      `INSERT INTO workflow_routed_messages (workspace_id, run_id, message_id, source_node_id, destination_node_id, kind, body_json, created_at)
       SELECT workspace_id, run_id, message_id || '-duplicate', source_node_id, destination_node_id, kind, body_json, created_at
         FROM workflow_routed_messages WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [WS, run.runId],
    );
    const inspection = await ctx.repository.inspectWorkflowRun(run.runId, owner.taskId);
    expect(inspection?.diagnostics).toContainEqual({ code: 'failure_detail_unavailable' });
    expect(JSON.stringify(inspection)).not.toContain('duplicate closure report');
  });

  it('ISSUE-1: replays an accepted start after its source definition is corrupted', async () => {
    const ctx = await openRepo('replay-source-corrupt');
    const definitionId = 'wf-replay-source';
    const run = await defineAndStart(ctx.repository, definitionId, 'replay-source');
    const replayIntact = await ctx.repository.execute(await startParams(definitionId, 'replay-source'));
    expect(replayIntact).toMatchObject({ ok: true, changed: false });
    expect((replayIntact.operation?.result?.data as StartPayload).runId).toBe(run.runId);

    await ctx.client.run('DROP TRIGGER trg_workflow_definition_nodes_immutable_update');
    await ctx.client.run(
      `UPDATE workflow_definition_nodes SET outcome_json = ? WHERE workspace_id = ? AND definition_id = ? AND definition_version = 1`,
      [JSON.stringify({
        kind: 'agent',
        requireExplicitDisposition: true,
        next: { when: 'Corrupted source must not break replay.' },
        fail: { when: 'Corrupted source fail.' },
      }), WS, definitionId],
    );

    const replay = await ctx.repository.execute(await startParams(definitionId, 'replay-source'));
    expect(replay).toMatchObject({ ok: true, changed: false });
    expect((replay.operation?.result?.data as StartPayload).runId).toBe(run.runId);
  });

  it('ISSUE-2: rejects a disposition authorized only by corrupted run-outcome state', async () => {
    const ctx = await openRepo('disposition-corrupt-outcome');
    const run = await defineAndStart(ctx.repository, 'wf-disposition-corrupt', 'disposition-corrupt');
    await markRunning(ctx.client, run.entry);
    await ctx.client.run('DROP TRIGGER trg_workflow_run_nodes_immutable_update');
    await ctx.client.run(
      `UPDATE workflow_run_node_specs SET outcome_json = ? WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
      [JSON.stringify({
        kind: 'agent',
        requireExplicitDisposition: true,
        next: { when: 'The result is complete.' },
        fail: { when: 'The result cannot be produced.' },
        prev: [{ when: 'Corrupted feedback route.', targets: ['all'], feedback: 'required' }],
      }), WS, run.runId],
    );

    const turn = await ctx.repository.getTurn(run.entry.activationTurnId);
    expect(turn).toBeTruthy();
    await expect(ctx.repository.getTurn(run.entry.activationTurnId)).resolves.toMatchObject({
      workflowActivation: { decision: undefined },
    });
    await expect(stageDispositionForSettlement(
      ctx.repository,
      turn!,
      { kind: 'workflow_prev', targets: ['all'], note: 'corrupted feedback route' },
      'corrupt-prev',
    )).resolves.toMatchObject({ changed: false });
  });

  it('ISSUE-3: fails closed when only run provenance fields are corrupted', async () => {
    const ctx = await openRepo('provenance-corruption');
    const run = await defineAndStart(ctx.repository, 'wf-provenance', 'provenance');
    await ctx.client.run('DROP TRIGGER trg_workflow_run_components_immutable_update');
    await ctx.client.run(
      `UPDATE workflow_run_components SET workflow_ref = ? WHERE workspace_id = ? AND run_id = ?`,
      ['other-definition@9', WS, run.runId],
    );
    await expect(ctx.repository.getWorkflowRunAuthority(run.runId)).resolves.toBeUndefined();
    await expect(ctx.repository.getWorkflowStatusForTask(run.entry.taskId)).resolves.toBeUndefined();
  });

  it('ISSUE-3b: fails closed for a composite run whose digest does not match', async () => {
    const ctx = await openRepo('composite-digest');
    const runId = 'wfr_composite_negative';
    await ctx.client.transaction([
      {
        sql: `INSERT INTO workflow_runs (
                workspace_id, run_id, authority_kind, authority_fingerprint, authority_name,
                authority_scope_kind, source_definition_id, source_definition_version,
                status, policy_json, created_at, updated_at
              ) VALUES (?, ?, 'composite', ?, 'composite', 'workspace', NULL, NULL, 'running', ?, ?, ?)`,
        params: [WS, runId, 'd'.repeat(64), JSON.stringify(DEFAULT_WORKFLOW_POLICY), NOW, NOW],
      },
      {
        sql: `INSERT INTO workflow_run_components (
                workspace_id, run_id, component_key, ordinal, source_kind, workflow_ref,
                source_definition_id, source_definition_version, source_fingerprint, component_fingerprint
              ) VALUES (?, ?, 'inline-part', 0, 'inline', NULL, NULL, NULL, NULL, ?)`,
        params: [WS, runId, 'e'.repeat(64)],
      },
      {
        sql: `INSERT INTO workflow_run_output_contracts (
                workspace_id, run_id, name, semantic_kind, source_node_id, ordinal,
                expected_artifact_kind, component_key, local_output_name
              ) VALUES (?, ?, 'result', 'result', 'entry', 0, 'next_result', 'inline-part', 'result')`,
        params: [WS, runId],
      },
      {
        sql: `INSERT INTO workflow_run_node_specs (
                workspace_id, run_id, node_id, ordinal, component_key, local_node_key,
                title, instructions_kind, instructions_file, instructions_content,
                instructions_sha256, instructions_retained, role, task_type, backend, model,
                capabilities_json, execution_kind, script_interpreter, script_file, script_args_json,
                script_source_kind, script_source_scope, script_package_kind,
                script_catalog_root_kind, script_package_path, script_entry_file,
                script_workflow_ref, script_package_sha256, script_sha256,
                outcome_kind, outcome_json
              ) VALUES (?, ?, 'entry', 0, 'inline-part', 'entry', NULL, NULL, NULL, NULL, NULL, 0,
                        NULL, NULL, 'grok', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                        NULL, NULL, NULL, NULL, NULL, NULL, 'agent', ?)`,
        params: [WS, runId, JSON.stringify({
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The result is complete.' },
          fail: { when: 'The result cannot be produced.' },
        })],
      },
    ]);
    await expect(ctx.repository.getWorkflowRunAuthority(runId)).resolves.toBeUndefined();
  });

  it('ISSUE-4: deleting the turn of a safely terminal run cascades the run', async () => {
    const ctx = await openRepo('turn-delete-cascade');
    const run = await defineAndStart(ctx.repository, 'wf-turn-delete', 'turn-delete');
    await closeWithExplicitFail(ctx, run, 'turn delete cascade report');
    await ctx.client.run(`DELETE FROM turns WHERE workspace_id = ? AND id = ?`, [WS, run.entry.activationTurnId]);
    await expect(ctx.client.get(
      `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`, [WS, run.entry.activationTurnId],
    )).resolves.toBeUndefined();
    await expect(ctx.client.get(
      `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`, [WS, run.runId],
    )).resolves.toBeUndefined();
    for (const table of [
      'workflow_run_components', 'workflow_run_input_contracts', 'workflow_run_output_contracts',
      'workflow_run_node_specs', 'workflow_run_edges',
    ]) {
      await expect(ctx.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? AND run_id = ?`, [WS, run.runId],
      )).resolves.toEqual({ count: 0 });
    }
    await expect(ctx.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
  });

  it('ISSUE-5: binds a tampered-valid closure to the unavailable fallback', async () => {
    const ctx = await openRepo('closure-tamper');
    const owner = await createOwnedCaller(ctx.repository, 'closure-tamper');
    const run = await defineAndStart(ctx.repository, 'wf-closure-tamper', 'closure-tamper', undefined, owner);
    await closeWithExplicitFail(ctx, run, 'original bounded report');
    const before = await ctx.client.get<{ body_json: string }>(
      `SELECT body_json FROM workflow_routed_messages WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [WS, run.runId],
    );
    const envelope = JSON.parse(before!.body_json) as Record<string, unknown>;
    const tampered = {
      ...envelope,
      detail: {
        ...((envelope.detail ?? {}) as Record<string, unknown>),
        nodeKey: 'tampered-node',
        report: { text: 'tampered report', truncated: false },
      },
    };
    await ctx.client.run(
      `UPDATE workflow_routed_messages SET body_json = ? WHERE workspace_id = ? AND run_id = ? AND kind = 'run_closure'`,
      [JSON.stringify(tampered), WS, run.runId],
    );
    const inspection = await ctx.repository.inspectWorkflowRun(run.runId, owner.taskId);
    expect(inspection?.runStatus).toBe('failed');
    expect(inspection?.diagnostics).toContainEqual({ code: 'failure_detail_unavailable' });
    expect(JSON.stringify(inspection)).not.toContain('tampered');
    expect(inspection?.failure).toMatchObject({ source: 'engine' });
  });

  it('ISSUE-6: strips terminal executable instructions while keeping authority verifiable', async () => {
    const ctx = await openRepo('instruction-strip');
    const instructionContent = 'Retain only the digest after terminal reclamation.';
    const baseDefinition = makeOneNodeDefinition({ definitionId: 'wf-instruction-strip', createdAt: NOW });
    const instructionDefinition = {
      ...baseDefinition,
      topology: {
        ...baseDefinition.topology,
        nodes: [{
          ...baseDefinition.topology.nodes[0]!,
          instructions: {
            kind: 'inline' as const,
            content: instructionContent,
            sha256: createHash('sha256').update(instructionContent, 'utf8').digest('hex'),
          },
        }],
      },
    };
    const run = await defineAndStart(
      ctx.repository,
      'wf-instruction-strip',
      'instruction-strip',
      instructionDefinition,
    );
    await closeWithExplicitFail(ctx, run, 'instruction strip report');
    await ctx.repository.execute({ kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WS });
    const spec = await ctx.client.get<{ instructions_content: string | null; instructions_retained: number; instructions_sha256: string | null }>(
      `SELECT instructions_content, instructions_retained, instructions_sha256 FROM workflow_run_node_specs WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
      [WS, run.runId],
    );
    expect(spec?.instructions_content).toBeNull();
    expect(spec?.instructions_retained).toBe(1);
    expect(spec?.instructions_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(ctx.repository.getWorkflowRunAuthority(run.runId)).resolves.toBeTruthy();
    const inspection = await ctx.repository.inspectWorkflowRun(run.runId, run.entry.taskId);
    expect(inspection?.diagnostics ?? []).not.toContainEqual({ code: 'failure_detail_unavailable' });
  });

  it('ISSUE-7: records the component digest independently of the run digest', async () => {
    const ctx = await openRepo('component-digest');
    const definition = makeOneNodeDefinition({ definitionId: 'wf-component-digest', createdAt: NOW });
    await expect(ctx.repository.execute({
      kind: 'defineWorkflowVersion', workspaceId: WS,
      definitionId: definition.definitionId, version: definition.version,
      name: definition.name, topology: definition.topology, createdAt: NOW,
    })).resolves.toMatchObject({ ok: true, changed: true });
    const clampedPolicy = { ...DEFAULT_WORKFLOW_POLICY, maxTurnsPerTask: 4 };
    const started = await ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: WS,
      definitionId: definition.definitionId, version: definition.version,
      startIdempotencyKey: 'component-digest', createdAt: NOW,
      goal: 'run authority fixture', backend: 'grok',
      effectivePolicy: clampedPolicy,
    });
    expect(started).toMatchObject({ ok: true, changed: true });
    const runId = (started.operation?.result?.data as StartPayload).runId;
    const row = await ctx.client.get<{
      authority_fingerprint: string; source_fingerprint: string | null; component_fingerprint: string;
    }>(
      `SELECT run.authority_fingerprint, component.source_fingerprint, component.component_fingerprint
         FROM workflow_runs run
         JOIN workflow_run_components component
           ON component.workspace_id = run.workspace_id AND component.run_id = run.run_id
        WHERE run.workspace_id = ? AND run.run_id = ?`,
      [WS, runId],
    );
    expect(row?.source_fingerprint).toBe(fingerprintWorkflowDefinition(definition));
    expect(row?.component_fingerprint).toBe(row?.source_fingerprint);
    expect(row?.authority_fingerprint).not.toBe(row?.source_fingerprint);
  });
});
