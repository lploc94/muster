import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { SqliteFaultCode } from './sqlite/errors';
import type { MusterTask } from './types';
import { makeGraphFanInDefinition } from './workflow';

const WORKSPACE_ID = 'ws';
const NOW = '2026-07-28T00:00:00.000Z';

function terminalTask(id: string): MusterTask {
  return {
    id, role: 'worker', lifecycle: 'succeeded', releaseState: 'draft', goal: id,
    parentId: null, prerequisites: [], backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 }, revision: 0,
    createdAt: NOW, updatedAt: NOW,
  };
}

async function rowCounts(client: DbClient): Promise<Record<'tasks' | 'turns' | 'messages' | 'operations', number>> {
  const tables = ['tasks', 'turns', 'messages', 'operations'] as const;
  const entries = await Promise.all(tables.map(async (table) => {
    const row = await client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`, [WORKSPACE_ID],
    );
    return [table, row?.count ?? 0] as const;
  }));
  return Object.fromEntries(entries) as Record<(typeof tables)[number], number>;
}

const PURGE_ROLLBACK_TABLES = [
  'tasks',
  'turns',
  'messages',
  'reasoning_segments',
  'tool_calls',
  'operations',
  'turn_inputs',
  'session_claims',
  'resource_claims',
  'turn_cancel_requests',
  'runtime_claims',
  'workflow_runs',
  'workflow_nodes',
  'workflow_dependency_gates',
  'workflow_gate_bindings',
  'workflow_artifacts',
  'workflow_gate_fills',
  'workflow_feedback_rounds',
  'workflow_feedback_targets',
  'workflow_routed_messages',
  'workflow_continuations',
  'workflow_start_claims',
  'workflow_activations',
  'workflow_decision_repairs',
  'workflow_return_gates',
  'workflow_artifact_sources',
  'turn_disposition_claims',
] as const;

type PurgeRollbackTable = (typeof PURGE_ROLLBACK_TABLES)[number];

async function purgeRollbackTableCounts(client: DbClient): Promise<Record<PurgeRollbackTable, number>> {
  const entries = await Promise.all(PURGE_ROLLBACK_TABLES.map(async (table) => {
    const row = await client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`,
      [WORKSPACE_ID],
    );
    return [table, row?.count ?? 0] as const;
  }));
  return Object.fromEntries(entries) as Record<PurgeRollbackTable, number>;
}

async function startWorkflowRun(repository: SqliteTaskRepository, key: string): Promise<string> {
  const result = await repository.execute({
    kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-fan', version: 1,
    startIdempotencyKey: key, createdAt: NOW, goal: 'metadata reclamation fixture', backend: 'grok',
  });
  expect(result.ok).toBe(true);
  return (result.operation?.result?.data as { runId: string }).runId;
}

async function terminalizeRun(client: DbClient, repository: SqliteTaskRepository, runId: string): Promise<void> {
  await client.transaction([
    {
      sql: `UPDATE turns SET status = 'succeeded', settled_at = ?
              WHERE workspace_id = ? AND task_id IN (
                SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ?
              )`,
      params: [NOW, WORKSPACE_ID, WORKSPACE_ID, runId],
    },
    {
      sql: `UPDATE workflow_activations SET status = 'consumed', updated_at = ?
              WHERE workspace_id = ? AND run_id = ?`,
      params: [NOW, WORKSPACE_ID, runId],
    },
    {
      sql: `UPDATE workflow_dependency_gates SET status = 'failed'
              WHERE workspace_id = ? AND run_id = ?`,
      params: [WORKSPACE_ID, runId],
    },
    {
      sql: `UPDATE workflow_runs SET status = 'failed', terminal_reason_code = 'agent_fail', updated_at = ?
              WHERE workspace_id = ? AND run_id = ?`,
      params: [NOW, WORKSPACE_ID, runId],
    },
  ]);
  const nodes = await client.all<{ task_id: string }>(
    `SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL`,
    [WORKSPACE_ID, runId],
  );
  for (const { task_id } of nodes) {
    const task = await repository.getTask(task_id);
    expect(task).toBeTruthy();
    // Reclamation fixture closes tasks that may include pending workflow shells.
    // Use raw SQL to bypass the shell-protection guard on generic upsertTask, which
    // intentionally fails closed for shell tasks outside the workflow closure path.
    await client.run(
      `UPDATE tasks SET lifecycle = 'succeeded', updated_at = ?, revision = revision + 1 WHERE workspace_id = ? AND id = ?`,
      [NOW, WORKSPACE_ID, task_id],
    );
  }
}

async function seedLegacyChildReturn(
  client: DbClient,
  repository: SqliteTaskRepository,
  suffix: string,
  options: { queued?: boolean; externalCallerTurn?: boolean } = {},
): Promise<{
  runId: string;
  taskId: string;
  turnId: string;
  callerTurnId: string;
  activationId: string;
  continuationId: string;
  returnGateId: string;
}> {
  const queued = options.queued === true;
  const externalCallerTurn = options.externalCallerTurn === true;
  const definition = makeGraphFanInDefinition({ createdAt: NOW });
  await repository.execute({
    kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: definition.definitionId,
    version: definition.version, name: definition.name, topology: definition.topology, createdAt: NOW,
  });
  const runId = await startWorkflowRun(repository, `legacy-${suffix}`);
  await terminalizeRun(client, repository, runId);
  const node = await client.get<{ node_id: string; task_id: string }>(
    `SELECT node_id, task_id FROM workflow_nodes
      WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL
      ORDER BY node_id LIMIT 1`,
    [WORKSPACE_ID, runId],
  );
  expect(node).toBeTruthy();
  const turnId = `legacy-${suffix}-turn`;
  const messageId = `legacy-${suffix}-message`;
  const activationId = `legacy-${suffix}-activation`;
  const continuationId = `legacy-${suffix}-continuation`;
  const returnGateId = `legacy-${suffix}-gate`;
  const callerTurnId = externalCallerTurn ? `legacy-${suffix}-caller-turn` : turnId;
  await client.transaction([
    ...(externalCallerTurn ? [{
      sql: `INSERT INTO turns (
              id, workspace_id, task_id, sequence, status, trigger,
              created_at, started_at, settled_at, payload_json
            ) VALUES (?, ?, ?, 98, 'succeeded', 'user', ?, ?, ?, ?)`,
      params: [
        callerTurnId,
        WORKSPACE_ID,
        node!.task_id,
        NOW,
        NOW,
        NOW,
        JSON.stringify({ payloadVersion: 1 }),
      ] as import('./sqlite/rpc').SqlValue[],
    }] : []),
    {
      sql: `INSERT INTO turns (
              id, workspace_id, task_id, sequence, status, trigger,
              created_at, started_at, settled_at, payload_json
            ) VALUES (?, ?, ?, 99, '${queued ? 'queued' : 'failed'}', 'engine', ?, ?, ?, ?)`,
      params: [
        turnId,
        WORKSPACE_ID,
        node!.task_id,
        NOW,
        queued ? null : NOW,
        queued ? null : NOW,
        JSON.stringify({ payloadVersion: 1 }),
      ],
    },
    {
      sql: `INSERT INTO messages (
              id, workspace_id, task_id, turn_id, role, state, ordering,
              content, created_at, payload_json
            ) VALUES (?, ?, ?, ?, '${queued ? 'user' : 'system'}', '${queued ? 'pending' : 'assigned'}', 0, ?, ?, ?)`,
      params: [messageId, WORKSPACE_ID, node!.task_id, turnId, '[legacy child return]', NOW, '{"payloadVersion":1}'],
    },
    ...(queued ? [{
      sql: `INSERT INTO turn_inputs (workspace_id, turn_id, ordering, kind, payload_json)
              VALUES (?, ?, 0, 'message', ?)`,
      params: [
        WORKSPACE_ID,
        turnId,
        JSON.stringify({ payloadVersion: 1, kind: 'message', messageId }),
      ] as import('./sqlite/rpc').SqlValue[],
    }] : []),
    {
      sql: `INSERT INTO workflow_activations (
              workspace_id, run_id, activation_id, node_id, kind, status,
              source_gate_id, feedback_round_id, feedback_target_node_id,
              continuation_id, return_gate_id, inherited_feedback_round_id,
              inherited_feedback_target_node_id, primary_turn_id, message_id,
              execution_turn_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'child_return', '${queued ? 'queued' : 'failed'}', NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      params: [WORKSPACE_ID, runId, activationId, node!.node_id, continuationId, returnGateId, turnId, messageId, turnId, NOW, NOW],
    },
    {
      sql: `INSERT INTO workflow_continuations (
              workspace_id, run_id, continuation_id,
              caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
              child_run_id, return_gate_id, kind, status,
              payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'child_wait', 'pending', ?, ?, ?)`,
      params: [
        WORKSPACE_ID,
        runId,
        continuationId,
        node!.task_id,
        callerTurnId,
        runId,
        node!.node_id,
        runId,
        returnGateId,
        '{"legacy":true}',
        NOW,
        NOW,
      ],
    },
    {
      sql: `INSERT INTO workflow_return_gates (
              workspace_id, return_gate_id, continuation_run_id, continuation_id,
              caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
              child_run_id, status, return_activation_run_id, return_activation_id,
              return_message_id, execution_turn_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumed', ?, ?, ?, ?, ?, ?)`,
      params: [
        WORKSPACE_ID,
        returnGateId,
        runId,
        continuationId,
        node!.task_id,
        callerTurnId,
        runId,
        node!.node_id,
        runId,
        runId,
        activationId,
        messageId,
        turnId,
        NOW,
        NOW,
      ],
    },
  ]);
  return {
    runId,
    taskId: node!.task_id,
    turnId,
    callerTurnId,
    activationId,
    continuationId,
    returnGateId,
  };
}

function makeFaultClient(code: SqliteFaultCode = 'full'): DbClient {
  return new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
    faultCapability: true,
    faultPlan: { code, operation: 'transaction', remaining: 1 },
  });
}

async function insertUnscopedFaultSentinel(client: DbClient, ledgerKey: string): Promise<void> {
  await client.run(
    `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [WORKSPACE_ID, ledgerKey, `${ledgerKey}-fingerprint`, '{"sentinel":"keep"}', NOW],
  );
}

async function purgeRollbackSnapshot(
  client: DbClient,
  repository: SqliteTaskRepository,
  legacy: Awaited<ReturnType<typeof seedLegacyChildReturn>>,
  sentinelKey: string,
): Promise<{
  revision: number;
  counts: Record<PurgeRollbackTable, number>;
  rows: {
    run: unknown;
    turn: unknown;
    activation: unknown;
    continuation: unknown;
    returnGate: unknown;
    sentinel: unknown;
  };
}> {
  const [revision, counts, run, turn, activation, continuation, returnGate, sentinel] = await Promise.all([
    repository.getWorkspaceRevision(),
    purgeRollbackTableCounts(client),
    client.get(
      `SELECT run_id, status, origin, parent_run_id
         FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
      [WORKSPACE_ID, legacy.runId],
    ),
    client.get(
      `SELECT id, status, task_id, payload_json
         FROM turns WHERE workspace_id = ? AND id = ?`,
      [WORKSPACE_ID, legacy.turnId],
    ),
    client.get(
      `SELECT activation_id, kind, status, primary_turn_id, execution_turn_id
         FROM workflow_activations WHERE workspace_id = ? AND activation_id = ?`,
      [WORKSPACE_ID, legacy.activationId],
    ),
    client.get(
      `SELECT continuation_id, kind, status, child_run_id
         FROM workflow_continuations WHERE workspace_id = ? AND continuation_id = ?`,
      [WORKSPACE_ID, legacy.continuationId],
    ),
    client.get(
      `SELECT return_gate_id, status, caller_turn_id, child_run_id
         FROM workflow_return_gates WHERE workspace_id = ? AND return_gate_id = ?`,
      [WORKSPACE_ID, legacy.returnGateId],
    ),
    client.get(
      `SELECT ledger_key, fingerprint, result_json
         FROM operations WHERE workspace_id = ? AND ledger_key = ?`,
      [WORKSPACE_ID, sentinelKey],
    ),
  ]);
  return {
    revision,
    counts,
    rows: { run, turn, activation, continuation, returnGate, sentinel },
  };
}

async function openReclamationFixture(label: string): Promise<{
  dir: string;
  client: DbClient;
  repository: SqliteTaskRepository;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-workflow-${label}-`));
  const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
  await client.open(path.join(dir, 'muster.sqlite3'));
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
    [WORKSPACE_ID, label, label, NOW, NOW],
  );
  return { dir, client, repository: new SqliteTaskRepository(client, WORKSPACE_ID) };
}

async function startExternalWorkflowRun(
  client: DbClient,
  repository: SqliteTaskRepository,
  key: string,
): Promise<{ runId: string; nodeId: string; taskId: string }> {
  const runId = await startWorkflowRun(repository, key);
  const node = await client.get<{ node_id: string; task_id: string }>(
    `SELECT node_id, task_id FROM workflow_nodes
      WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL
      ORDER BY node_id LIMIT 1`,
    [WORKSPACE_ID, runId],
  );
  expect(node).toBeTruthy();
  return { runId, nodeId: node!.node_id, taskId: node!.task_id };
}

describe('terminal workflow metadata reclamation', () => {
  it('strips terminal transport payloads and purges obsolete child_return state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-metadata-reclamation-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'workflow-metadata-reclamation', 'Workflow metadata reclamation', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const task = terminalTask('durable-task');
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: { id: 'durable-turn', taskId: task.id, sequence: 1, status: 'succeeded', trigger: 'user', inputs: [], createdAt: NOW, finishedAt: NOW },
      });
      await repository.execute({
        kind: 'appendMessage', workspaceId: WORKSPACE_ID,
        message: { id: 'durable-message', taskId: task.id, turnId: 'durable-turn', role: 'assistant', content: 'durable transcript', state: 'complete', order: 0, createdAt: NOW },
      });
      await repository.execute({
        kind: 'claimOperation', workspaceId: WORKSPACE_ID, ledgerKey: 'durable-operation',
        entry: { fingerprint: 'durable-fingerprint', result: { ok: true, data: {} } }, createdAt: NOW,
      });
      const definition = makeGraphFanInDefinition({ createdAt: NOW });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: definition.definitionId,
        version: definition.version, name: definition.name, topology: definition.topology, createdAt: NOW,
      });
      const safeRunId = await startWorkflowRun(repository, 'safe');
      const secondSafeRunId = await startWorkflowRun(repository, 'safe-second');
      const pinnedProducerRunId = await startWorkflowRun(repository, 'pinned-producer');
      const pinConsumerRunId = await startWorkflowRun(repository, 'pin-consumer');
      const liveGateRunId = await startWorkflowRun(repository, 'live-gate');
      const liveActivationRunId = await startWorkflowRun(repository, 'live-activation');

      // A safely terminal run has no live liveness relation. The gate case represents
      // terminal integrity drift; a queued activation remains on a running run because
      // schema triggers correctly forbid terminal runs with live activations.
      await terminalizeRun(client, repository, safeRunId);
      await terminalizeRun(client, repository, secondSafeRunId);
      await terminalizeRun(client, repository, liveGateRunId);
      const consumerGate = await client.get<{ gate_id: string; input_ref: string }>(
        `SELECT gate.gate_id, binding.input_ref
           FROM workflow_dependency_gates gate
           JOIN workflow_gate_bindings binding
             ON binding.workspace_id = gate.workspace_id AND binding.run_id = gate.run_id
            AND binding.gate_id = gate.gate_id
          WHERE gate.workspace_id = ? AND gate.run_id = ?
            AND binding.producer_node_id = 'p1'
          LIMIT 1`,
        [WORKSPACE_ID, pinConsumerRunId],
      );
      expect(consumerGate).toBeTruthy();
      await client.transaction([
        {
          sql: `INSERT INTO workflow_artifacts (
                  workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                  revision, kind, payload_json, created_at
                ) VALUES (?,?,?,?,?,?,?,?,?)`,
          params: [WORKSPACE_ID, pinnedProducerRunId, 'cross-run-pinned-artifact', 'p1',
            'result', 1, 'next_result', '{}', NOW],
        },
        {
          sql: `INSERT INTO workflow_artifact_sources (
                  workspace_id, run_id, artifact_id, artifact_revision, source_kind,
                  producer_run_id, producer_node_id, producer_task_id, producing_turn_id,
                  producing_activation_id, caller_task_id, caller_turn_id,
                  engine_start_operation_key
                )
                SELECT ?, ?, ?, 1, 'workflow_node', ?, 'p1', node.task_id, activation.execution_turn_id,
                       activation.activation_id, NULL, NULL, NULL
                  FROM workflow_nodes node
                  JOIN workflow_activations activation
                    ON activation.workspace_id = node.workspace_id AND activation.run_id = node.run_id
                 WHERE node.workspace_id = ? AND node.run_id = ? AND node.node_id = 'p1'
                 LIMIT 1`,
          params: [WORKSPACE_ID, pinnedProducerRunId, 'cross-run-pinned-artifact', pinnedProducerRunId,
            WORKSPACE_ID, pinnedProducerRunId],
        },
        {
          sql: `DELETE FROM workflow_nodes
                 WHERE workspace_id = ? AND run_id = ? AND node_id = 'p1'`,
          params: [WORKSPACE_ID, pinConsumerRunId],
        },
        {
          sql: `INSERT INTO workflow_nodes (
                  workspace_id, run_id, node_id, task_id, status,
                  source_run_id, source_node_id, source_task_id,
                  source_artifact_id, source_artifact_revision
                )
                SELECT ?, ?, 'p1', NULL, 'reused', ?, 'p1', source.task_id, ?, 1
                  FROM workflow_nodes source
                 WHERE source.workspace_id = ? AND source.run_id = ? AND source.node_id = 'p1'`,
          params: [
            WORKSPACE_ID, pinConsumerRunId, pinnedProducerRunId,
            'cross-run-pinned-artifact', WORKSPACE_ID, pinnedProducerRunId,
          ],
        },
        {
          sql: `INSERT INTO workflow_gate_fills (
                  workspace_id, run_id, gate_id, input_ref, artifact_run_id,
                  artifact_id, artifact_revision, filled_at
                ) VALUES (?,?,?,?,?,?,?,?)`,
          params: [WORKSPACE_ID, pinConsumerRunId, consumerGate!.gate_id, consumerGate!.input_ref,
            pinnedProducerRunId, 'cross-run-pinned-artifact', 1, NOW],
        },
      ]);
      await terminalizeRun(client, repository, pinnedProducerRunId);
      const liveGate = await client.get<{ gate_id: string }>(
        `SELECT gate_id FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? LIMIT 1`,
        [WORKSPACE_ID, liveGateRunId],
      );
      await client.run(
        `UPDATE workflow_dependency_gates SET status = 'open'
          WHERE workspace_id = ? AND run_id = ? AND gate_id = ?`,
        [WORKSPACE_ID, liveGateRunId, liveGate!.gate_id],
      );

      await client.run(
        `INSERT INTO workflow_routed_messages (
           workspace_id, run_id, message_id, source_node_id, destination_node_id,
           kind, body_json, created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
        [WORKSPACE_ID, safeRunId, 'reclaimable-message', 'source', 'destination', 'terminal_next',
          '{"large":"transport payload"}', NOW],
      );
      const retainedNode = await client.get<{ node_id: string; task_id: string }>(
        `SELECT node_id, task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL
          ORDER BY node_id LIMIT 1`,
        [WORKSPACE_ID, safeRunId],
      );
      expect(retainedNode).toBeTruthy();
      await client.transaction([
        {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, started_at, settled_at, payload_json
                ) VALUES ('retained-child-return-turn', ?, ?, 99, 'queued',
                          'engine', ?, NULL, NULL, '{"payloadVersion":1}')`,
          params: [WORKSPACE_ID, retainedNode!.task_id, NOW],
        },
        {
          sql: `INSERT INTO messages (
                  id, workspace_id, task_id, turn_id, role, state, ordering,
                  content, created_at, payload_json
                ) VALUES ('retained-child-return-message', ?, ?,
                          'retained-child-return-turn', 'system', 'assigned', 0,
                          '[retained child return]', ?, '{"payloadVersion":1}')`,
          params: [WORKSPACE_ID, retainedNode!.task_id, NOW],
        },
        {
          sql: `INSERT INTO workflow_activations (
                  workspace_id, run_id, activation_id, node_id, kind, status,
                  source_gate_id, feedback_round_id, feedback_target_node_id,
                  continuation_id, return_gate_id, inherited_feedback_round_id,
                  inherited_feedback_target_node_id, primary_turn_id, message_id,
                  execution_turn_id, created_at, updated_at
                ) VALUES (?, ?, 'retained-child-return-activation', ?, 'child_return',
                          'queued', NULL, NULL, NULL, 'retained-child-wait',
                          'retained-return-gate', NULL, NULL,
                          'retained-child-return-turn', 'retained-child-return-message',
                          'retained-child-return-turn', ?, ?)`,
          params: [WORKSPACE_ID, safeRunId, retainedNode!.node_id, NOW, NOW],
        },
        {
          sql: `INSERT INTO workflow_continuations (
                  workspace_id, run_id, continuation_id,
                  caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
                  child_run_id, return_gate_id, kind, status,
                  payload_json, created_at, updated_at
                ) VALUES (?, ?, 'retained-child-wait', ?, 'retained-child-return-turn', ?, ?,
                          ?, 'retained-return-gate', 'child_wait', 'pending',
                          '{"retained":true}', ?, ?)`,
          params: [
            WORKSPACE_ID,
            safeRunId,
            retainedNode!.task_id,
            safeRunId,
            retainedNode!.node_id,
            safeRunId,
            NOW,
            NOW,
          ],
        },
        {
          sql: `INSERT INTO workflow_routed_messages (
                  workspace_id, run_id, message_id, source_node_id, source_task_id,
                  source_turn_id, destination_node_id, continuation_id, kind,
                  body_json, created_at
                ) VALUES (?, ?, 'retained-child-return-route', ?, ?, ?, ?, ?,
                          'child_return', '{"retained":"must stay byte exact"}', ?)`,
          params: [
            WORKSPACE_ID,
            safeRunId,
            retainedNode!.node_id,
            retainedNode!.task_id,
            'retained-child-return-turn',
            retainedNode!.node_id,
            'retained-child-wait',
            NOW,
          ],
        },
      ]);
      await client.transaction([
        {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, started_at, settled_at, payload_json
                ) VALUES ('retained-child-return-retry-turn', ?, ?, 100, 'failed',
                          'engine', ?, ?, ?, ?)`,
          params: [
            WORKSPACE_ID,
            retainedNode!.task_id,
            NOW,
            NOW,
            NOW,
            JSON.stringify({ payloadVersion: 1, retryOf: 'retained-child-return-turn' }),
          ],
        },
        {
          sql: `INSERT INTO messages (
                  id, workspace_id, task_id, turn_id, role, state, ordering,
                  content, created_at, payload_json
                ) VALUES ('retained-child-return-retry-message', ?, ?,
                          'retained-child-return-retry-turn', 'assistant', 'complete', 0,
                          'obsolete retry transcript', ?, '{"payloadVersion":1}')`,
          params: [WORKSPACE_ID, retainedNode!.task_id, NOW],
        },
        {
          sql: `UPDATE workflow_activations
                   SET execution_turn_id = ?, updated_at = ?
                 WHERE workspace_id = ? AND activation_id = ?`,
          params: [
            'retained-child-return-retry-turn',
            NOW,
            WORKSPACE_ID,
            'retained-child-return-activation',
          ],
        },
        {
          sql: `INSERT INTO turn_inputs (workspace_id, turn_id, ordering, kind, payload_json)
                VALUES (?, 'retained-child-return-retry-turn', 0, 'message', ?)`,
          params: [
            WORKSPACE_ID,
            JSON.stringify({ payloadVersion: 1, messageId: 'retained-child-return-retry-message' }),
          ],
        },
        {
          sql: `INSERT INTO reasoning_segments (
                  id, workspace_id, task_id, turn_id, ordering, content, created_at, updated_at
                ) VALUES ('retained-child-return-reasoning', ?, ?,
                          'retained-child-return-retry-turn', 0, 'obsolete reasoning', ?, ?)`,
          params: [WORKSPACE_ID, retainedNode!.task_id, NOW, NOW],
        },
        {
          sql: `INSERT INTO tool_calls (
                  id, workspace_id, task_id, turn_id, tool_call_id, ordering, status,
                  name, payload_json, created_at, updated_at
                ) VALUES ('retained-child-return-tool', ?, ?,
                          'retained-child-return-retry-turn', 'obsolete-tool', 0, 'success',
                          'obsolete_tool', '{"payloadVersion":1}', ?, ?)`,
          params: [WORKSPACE_ID, retainedNode!.task_id, NOW, NOW],
        },
        {
          sql: `INSERT INTO session_claims (workspace_id, session_id, turn_id, claimed_at)
                VALUES (?, 'retained-child-return-session', 'retained-child-return-retry-turn', ?)`,
          params: [WORKSPACE_ID, NOW],
        },
        {
          sql: `INSERT INTO resource_claims (
                  workspace_id, resource_key, task_id, turn_id, claimed_at
                ) VALUES (?, 'retained-child-return-resource', ?, 'retained-child-return-retry-turn', ?)`,
          params: [WORKSPACE_ID, retainedNode!.task_id, NOW],
        },
        {
          sql: `INSERT INTO runtime_claims (
                  workspace_id, turn_id, owner_id, claimed_at, heartbeat_at, expires_at
                ) VALUES (?, 'retained-child-return-retry-turn', 'obsolete-owner', ?, ?, ?)`,
          params: [WORKSPACE_ID, NOW, NOW, '2099-01-01T00:00:00.000Z'],
        },
        {
          sql: `INSERT INTO turn_cancel_requests (
                  workspace_id, turn_id, task_id, kind, op_id, requested_by,
                  requested_at, payload_json
                ) VALUES (?, 'retained-child-return-retry-turn', ?, 'cancel',
                          'obsolete-cancel', 'obsolete-worker', ?, '{"payloadVersion":1}')`,
          params: [WORKSPACE_ID, retainedNode!.task_id, NOW],
        },
        {
          sql: `INSERT INTO turn_disposition_claims (
                  workspace_id, turn_id, task_id, runtime_epoch, op_id, family, kind,
                  fingerprint, payload_json, status, created_at, updated_at
                ) VALUES (?, 'retained-child-return-retry-turn', ?, 1, 'obsolete-disposition',
                          'workflow', 'workflow_fail', 'obsolete-claim-fingerprint',
                          '{"payloadVersion":1}', 'consumed', ?, ?)`,
          params: [WORKSPACE_ID, retainedNode!.task_id, NOW, NOW],
        },
        {
          sql: `INSERT INTO workflow_decision_repairs (
                  workspace_id, run_id, activation_id, status, attempts_used,
                  last_attempt_turn_id, last_error_code, last_response_message_id,
                  next_repair_turn_id, created_at, updated_at
                ) VALUES (?, ?, 'retained-child-return-activation', 'exhausted', 3,
                          'retained-child-return-retry-turn', 'decision_missing',
                          'retained-child-return-retry-message', NULL, ?, ?)`,
          params: [WORKSPACE_ID, safeRunId, NOW, NOW],
        },
        {
          sql: `UPDATE workflow_continuations
                   SET child_run_id = ?, updated_at = ?
                 WHERE workspace_id = ? AND continuation_id = 'retained-child-wait'`,
          params: [safeRunId, NOW, WORKSPACE_ID],
        },
        {
          sql: `INSERT INTO workflow_return_gates (
                  workspace_id, return_gate_id, continuation_run_id, continuation_id,
                  caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
                  child_run_id, status, return_activation_run_id, return_activation_id,
                  return_message_id, execution_turn_id, created_at, updated_at
                ) VALUES (?, 'retained-return-gate', ?, 'retained-child-wait',
                          ?, 'retained-child-return-turn', ?, ?, ?, 'consumed',
                          ?, 'retained-child-return-activation',
                          'retained-child-return-message', 'retained-child-return-retry-turn', ?, ?)`,
          params: [
            WORKSPACE_ID,
            safeRunId,
            retainedNode!.task_id,
            safeRunId,
            retainedNode!.node_id,
            safeRunId,
            safeRunId,
            NOW,
            NOW,
          ],
        },
        {
          sql: `INSERT INTO workflow_start_claims (
                  workspace_id, owner_task_id, caller_task_id, caller_turn_id,
                  definition_id, definition_version, idempotency_key, fingerprint,
                  run_id, created_at
                ) VALUES (?, ?, ?, 'retained-child-return-turn', 'wf-fan', 1,
                          'obsolete-child-start', 'obsolete-child-start-fingerprint', ?, ?)`,
          params: [WORKSPACE_ID, retainedNode!.task_id, retainedNode!.task_id, safeRunId, NOW],
        },
        {
          sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
                VALUES (?, 'retained-child-return-turn:obsolete', 'obsolete-primary-operation',
                        '{"payloadVersion":1}', ?)`,
          params: [WORKSPACE_ID, NOW],
        },
        {
          sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
                VALUES (?, 'retained-child-return-retry-turn:obsolete', 'obsolete-retry-operation',
                        '{"payloadVersion":1}', ?)`,
          params: [WORKSPACE_ID, NOW],
        },
        {
          sql: `INSERT INTO operations (workspace_id, ledger_key, fingerprint, result_json, created_at)
                VALUES (?, 'retained-child-return-unscoped', 'keep-unscoped-operation',
                        '{"payloadVersion":1}', ?)`,
          params: [WORKSPACE_ID, NOW],
        },
        {
          sql: `INSERT INTO workflow_routed_messages (
                  workspace_id, run_id, message_id, source_node_id, destination_node_id,
                  kind, body_json, created_at
                ) VALUES (?, ?, 'retained-run-closure', 'engine', 'engine',
                          'run_closure', '{"closure":"keep"}', ?)`,
          params: [WORKSPACE_ID, safeRunId, NOW],
        },
      ]);
      const before = await rowCounts(client);
      const result = await repository.execute({ kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID });

      expect(result).toMatchObject({ ok: true, changed: true, strippedWorkflowMessageBodies: 1 });
      // Reclamation strips the ordinary routed transport body and removes only the
      // obsolete child_return rows. Workflow runs, source pins, and operation
      // replay state remain durable unless their own safe deletion boundary applies.
      await expect(client.all<{ run_id: string }>(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? ORDER BY run_id`, [WORKSPACE_ID],
      )).resolves.toEqual([
        safeRunId, secondSafeRunId, pinnedProducerRunId, pinConsumerRunId,
        liveGateRunId, liveActivationRunId,
      ].sort((left, right) => left.localeCompare(right)).map((run_id) => ({ run_id })));
      await expect(client.get<{ artifact_id: string }>(
        `SELECT artifact_id FROM workflow_artifacts
          WHERE workspace_id = ? AND run_id = ? AND artifact_id = ?`,
        [WORKSPACE_ID, pinnedProducerRunId, 'cross-run-pinned-artifact'],
      )).resolves.toEqual({ artifact_id: 'cross-run-pinned-artifact' });
      // The two turn-owned operation keys are retired with their exact lineage;
      // the unscoped sentinel remains available for replay/diagnostics.
      await expect(client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM operations WHERE workspace_id = ?`,
        [WORKSPACE_ID],
      )).resolves.toEqual({ count: before.operations - 2 });
      await expect(client.get<{ body_json: string }>(
        `SELECT body_json FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
        [WORKSPACE_ID, safeRunId, 'reclaimable-message'],
      )).resolves.toEqual({ body_json: '{"retentionStripped":true}' });
      await expect(client.get<{ body_json: string }>(
        `SELECT body_json FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
        [WORKSPACE_ID, safeRunId, 'retained-child-return-route'],
      )).resolves.toBeUndefined();
      await expect(client.get<{ body_json: string }>(
        `SELECT body_json FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
        [WORKSPACE_ID, safeRunId, 'retained-run-closure'],
      )).resolves.toEqual({ body_json: '{"closure":"keep"}' });
      await expect(rowCounts(client)).resolves.toEqual({
        ...before,
        turns: before.turns - 2,
        messages: before.messages - 2,
        operations: before.operations - 2,
      });
      await expect(client.get<{ ledger_key: string }>(
        `SELECT ledger_key FROM operations
          WHERE workspace_id = ? AND ledger_key = ?`,
        [WORKSPACE_ID, 'retained-child-return-unscoped'],
      )).resolves.toEqual({ ledger_key: 'retained-child-return-unscoped' });
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
      await expect(client.get(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, 'retained-child-return-activation'],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT continuation_id FROM workflow_continuations
          WHERE workspace_id = ? AND continuation_id = ?`,
        [WORKSPACE_ID, 'retained-child-wait'],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT message_id FROM workflow_routed_messages
          WHERE workspace_id = ? AND message_id = ?`,
        [WORKSPACE_ID, 'retained-child-return-route'],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT return_gate_id FROM workflow_return_gates
          WHERE workspace_id = ? AND return_gate_id = ?`,
        [WORKSPACE_ID, 'retained-return-gate'],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT id FROM turns
          WHERE workspace_id = ? AND id IN (?, ?)`,
        [WORKSPACE_ID, 'retained-child-return-turn', 'retained-child-return-retry-turn'],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT ledger_key FROM operations
          WHERE workspace_id = ? AND ledger_key IN (?, ?)`,
        [
          WORKSPACE_ID,
          'retained-child-return-turn:obsolete',
          'retained-child-return-retry-turn:obsolete',
        ],
      )).resolves.toBeUndefined();
      await expect(repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).resolves.toMatchObject({
        ok: true,
        changed: false,
        strippedWorkflowMessageBodies: 0,
      });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rolls back terminal reclamation after an injected commit fault and retries cleanly', async () => {
    const fixture = await openReclamationFixture('faulted-reclamation');
    const sentinelKey = 'faulted-reclamation-unscoped-sentinel';
    let faultClient: DbClient | undefined;
    let retryClient: DbClient | undefined;
    try {
      const legacy = await seedLegacyChildReturn(
        fixture.client,
        fixture.repository,
        'faulted-reclamation',
      );
      await insertUnscopedFaultSentinel(fixture.client, sentinelKey);
      const before = await purgeRollbackSnapshot(
        fixture.client,
        fixture.repository,
        legacy,
        sentinelKey,
      );
      const dbPath = path.join(fixture.dir, 'muster.sqlite3');

      await fixture.client.close();
      faultClient = makeFaultClient();
      await faultClient.open(dbPath);
      const faultRepository = new SqliteTaskRepository(faultClient, WORKSPACE_ID);

      await expect(faultRepository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).rejects.toMatchObject({
        detail: { code: 'full', operation: 'transaction' },
      });
      await expect(
        purgeRollbackSnapshot(faultClient, faultRepository, legacy, sentinelKey),
      ).resolves.toEqual(before);
      await expect(faultClient.all('PRAGMA foreign_key_check')).resolves.toEqual([]);

      await faultClient.close();
      faultClient = undefined;
      retryClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      await retryClient.open(dbPath);
      const retryRepository = new SqliteTaskRepository(retryClient, WORKSPACE_ID);
      await expect(retryRepository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).resolves.toMatchObject({ ok: true, changed: true });

      await expect(retryClient.get(
        `SELECT run_id, status, origin, parent_run_id
           FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, legacy.runId],
      )).resolves.toEqual(before.rows.run);
      await expect(retryClient.get(
        `SELECT activation_id FROM workflow_activations
           WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, legacy.activationId],
      )).resolves.toBeUndefined();
      await expect(retryClient.get(
        `SELECT ledger_key, fingerprint, result_json FROM operations
           WHERE workspace_id = ? AND ledger_key = ?`,
        [WORKSPACE_ID, sentinelKey],
      )).resolves.toEqual(before.rows.sentinel);
      await expect(retryClient.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      await faultClient?.close();
      await retryClient?.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('purges legacy state before a direct turn deletion and preserves the terminal run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-turn-delete-purge-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'workflow-turn-delete-purge', 'Workflow turn delete purge', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const fixture = await seedLegacyChildReturn(client, repository, 'turn-delete');

      await expect(repository.execute({
        kind: 'deleteTurn', workspaceId: WORKSPACE_ID, turnId: fixture.turnId,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(client.get<{ run_id: string }>(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, fixture.runId],
      )).resolves.toEqual({ run_id: fixture.runId });
      await expect(client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`, [WORKSPACE_ID, fixture.turnId],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT activation_id FROM workflow_activations WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, `legacy-turn-delete-activation`],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT continuation_id FROM workflow_continuations WHERE workspace_id = ? AND continuation_id = ?`,
        [WORKSPACE_ID, `legacy-turn-delete-continuation`],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT return_gate_id FROM workflow_return_gates WHERE workspace_id = ? AND return_gate_id = ?`,
        [WORKSPACE_ID, `legacy-turn-delete-gate`],
      )).resolves.toBeUndefined();
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rolls back a direct turn deletion after an injected commit fault and retries cleanly', async () => {
    const fixture = await openReclamationFixture('faulted-turn-delete');
    const sentinelKey = 'faulted-turn-delete-unscoped-sentinel';
    let faultClient: DbClient | undefined;
    let retryClient: DbClient | undefined;
    try {
      const legacy = await seedLegacyChildReturn(
        fixture.client,
        fixture.repository,
        'faulted-turn-delete',
      );
      await insertUnscopedFaultSentinel(fixture.client, sentinelKey);
      const before = await purgeRollbackSnapshot(
        fixture.client,
        fixture.repository,
        legacy,
        sentinelKey,
      );
      const dbPath = path.join(fixture.dir, 'muster.sqlite3');

      await fixture.client.close();
      faultClient = makeFaultClient();
      await faultClient.open(dbPath);
      const faultRepository = new SqliteTaskRepository(faultClient, WORKSPACE_ID);

      await expect(faultRepository.execute({
        kind: 'deleteTurn',
        workspaceId: WORKSPACE_ID,
        turnId: legacy.turnId,
      })).rejects.toMatchObject({
        detail: { code: 'full', operation: 'transaction' },
      });
      await expect(
        purgeRollbackSnapshot(faultClient, faultRepository, legacy, sentinelKey),
      ).resolves.toEqual(before);
      await expect(faultClient.all('PRAGMA foreign_key_check')).resolves.toEqual([]);

      await faultClient.close();
      faultClient = undefined;
      retryClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      await retryClient.open(dbPath);
      const retryRepository = new SqliteTaskRepository(retryClient, WORKSPACE_ID);
      await expect(retryRepository.execute({
        kind: 'deleteTurn',
        workspaceId: WORKSPACE_ID,
        turnId: legacy.turnId,
      })).resolves.toMatchObject({ ok: true, changed: true });

      await expect(retryClient.get(
        `SELECT run_id, status, origin, parent_run_id
           FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, legacy.runId],
      )).resolves.toEqual(before.rows.run);
      await expect(retryClient.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, legacy.turnId],
      )).resolves.toBeUndefined();
      await expect(retryClient.get(
        `SELECT activation_id FROM workflow_activations
           WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, legacy.activationId],
      )).resolves.toBeUndefined();
      await expect(retryClient.get(
        `SELECT ledger_key, fingerprint, result_json FROM operations
           WHERE workspace_id = ? AND ledger_key = ?`,
        [WORKSPACE_ID, sentinelKey],
      )).resolves.toEqual(before.rows.sentinel);
      await expect(retryClient.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      await faultClient?.close();
      await retryClient?.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('purges a valid legacy return gate whose caller turn predates the retired activation', async () => {
    const fixture = await openReclamationFixture('external-caller-turn');
    try {
      const legacy = await seedLegacyChildReturn(
        fixture.client,
        fixture.repository,
        'external-caller-turn',
        { externalCallerTurn: true },
      );

      await expect(fixture.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).resolves.toMatchObject({ ok: true, changed: true });

      await expect(fixture.client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, legacy.callerTurnId],
      )).resolves.toEqual({ id: legacy.callerTurnId });
      await expect(fixture.client.get(
        `SELECT return_gate_id FROM workflow_return_gates
          WHERE workspace_id = ? AND return_gate_id = ?`,
        [WORKSPACE_ID, 'legacy-external-caller-turn-gate'],
      )).resolves.toBeUndefined();
      await expect(fixture.client.get(
        `SELECT continuation_id FROM workflow_continuations
          WHERE workspace_id = ? AND continuation_id = ?`,
        [WORKSPACE_ID, 'legacy-external-caller-turn-continuation'],
      )).resolves.toBeUndefined();
      await expect(fixture.client.get(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, 'legacy-external-caller-turn-activation'],
      )).resolves.toBeUndefined();
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a child_return activation that points at a non-child continuation', async () => {
    const fixture = await openReclamationFixture('malformed-continuation-kind');
    try {
      const legacy = await seedLegacyChildReturn(
        fixture.client,
        fixture.repository,
        'malformed-continuation-kind',
      );
      await fixture.client.run(
        `UPDATE workflow_continuations
            SET kind = 'start_wait'
          WHERE workspace_id = ? AND continuation_id = ?`,
        [WORKSPACE_ID, 'legacy-malformed-continuation-kind-continuation'],
      );
      const before = await rowCounts(fixture.client);

      await expect(fixture.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).rejects.toThrow(/constraint/i);
      await expect(rowCounts(fixture.client)).resolves.toEqual(before);
      await expect(fixture.client.get<{ kind: string }>(
        `SELECT kind FROM workflow_continuations
          WHERE workspace_id = ? AND continuation_id = ?`,
        [WORKSPACE_ID, 'legacy-malformed-continuation-kind-continuation'],
      )).resolves.toEqual({ kind: 'start_wait' });
      await expect(fixture.client.get(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, 'legacy-malformed-continuation-kind-activation'],
      )).resolves.toBeTruthy();
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a child_return activation whose turn and message references belong to another task', async () => {
    const fixture = await openReclamationFixture('malformed-foreign-references');
    try {
      const legacy = await seedLegacyChildReturn(
        fixture.client,
        fixture.repository,
        'malformed-foreign-references',
      );
      const foreignTaskId = 'malformed-foreign-task';
      const foreignTurnId = 'malformed-foreign-turn';
      const foreignMessageId = 'malformed-foreign-message';
      await fixture.repository.execute({
        kind: 'createTask',
        workspaceId: WORKSPACE_ID,
        task: terminalTask(foreignTaskId),
      });
      await fixture.client.transaction([
        {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, started_at, settled_at, payload_json
                ) VALUES (?, ?, ?, 1, 'failed', 'engine', ?, ?, ?, ?)`,
          params: [
            foreignTurnId,
            WORKSPACE_ID,
            foreignTaskId,
            NOW,
            NOW,
            NOW,
            JSON.stringify({ payloadVersion: 1 }),
          ],
        },
        {
          sql: `INSERT INTO messages (
                  id, workspace_id, task_id, turn_id, role, state, ordering,
                  content, created_at, payload_json
                ) VALUES (?, ?, ?, ?, 'system', 'assigned', 0, ?, ?, ?)`,
          params: [
            foreignMessageId,
            WORKSPACE_ID,
            foreignTaskId,
            foreignTurnId,
            '[malformed foreign message]',
            NOW,
            '{"payloadVersion":1}',
          ],
        },
        {
          sql: `UPDATE workflow_activations
                  SET primary_turn_id = ?, message_id = ?, execution_turn_id = ?
                WHERE workspace_id = ? AND activation_id = ?`,
          params: [
            foreignTurnId,
            foreignMessageId,
            foreignTurnId,
            WORKSPACE_ID,
            'legacy-malformed-foreign-references-activation',
          ],
        },
        {
          sql: `UPDATE workflow_return_gates
                  SET caller_task_id = ?, caller_turn_id = ?,
                      return_message_id = ?, execution_turn_id = ?
                WHERE workspace_id = ? AND return_gate_id = ?`,
          params: [
            foreignTaskId,
            foreignTurnId,
            foreignMessageId,
            foreignTurnId,
            WORKSPACE_ID,
            'legacy-malformed-foreign-references-gate',
          ],
        },
      ]);
      const before = await rowCounts(fixture.client);

      await expect(fixture.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).rejects.toThrow(/constraint/i);
      await expect(rowCounts(fixture.client)).resolves.toEqual(before);
      await expect(fixture.client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, foreignTurnId],
      )).resolves.toEqual({ id: foreignTurnId });
      await expect(fixture.client.get(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, 'legacy-malformed-foreign-references-activation'],
      )).resolves.toBeTruthy();
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a child_return activation whose return gate reference is missing', async () => {
    const fixture = await openReclamationFixture('missing-return-gate');
    try {
      const legacy = await seedLegacyChildReturn(
        fixture.client,
        fixture.repository,
        'missing-return-gate',
        { externalCallerTurn: true },
      );
      const unrelatedContinuationId = 'unrelated-missing-gate-continuation';
      await fixture.client.transaction([
        {
          sql: `INSERT INTO workflow_continuations (
                  workspace_id, run_id, continuation_id, kind, status,
                  payload_json, created_at, updated_at
                ) VALUES (?, ?, ?, 'child_wait', 'pending', '{}', ?, ?)`,
          params: [WORKSPACE_ID, legacy.runId, unrelatedContinuationId, NOW, NOW],
        },
        {
          sql: `UPDATE workflow_return_gates
                  SET continuation_id = ?, execution_turn_id = NULL
                WHERE workspace_id = ? AND return_gate_id = ?`,
          params: [unrelatedContinuationId, WORKSPACE_ID, 'legacy-missing-return-gate-gate'],
        },
        {
          sql: `UPDATE workflow_activations
                  SET return_gate_id = ?
                WHERE workspace_id = ? AND activation_id = ?`,
          params: [
            'missing-return-gate-reference',
            WORKSPACE_ID,
            'legacy-missing-return-gate-activation',
          ],
        },
      ]);
      const before = await rowCounts(fixture.client);

      await expect(fixture.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).rejects.toThrow(/constraint/i);
      await expect(rowCounts(fixture.client)).resolves.toEqual(before);
      await expect(fixture.client.get(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, 'legacy-missing-return-gate-activation'],
      )).resolves.toBeTruthy();
      await expect(fixture.client.get(
        `SELECT return_gate_id FROM workflow_return_gates
          WHERE workspace_id = ? AND return_gate_id = ?`,
        [WORKSPACE_ID, 'legacy-missing-return-gate-gate'],
      )).resolves.toEqual({ return_gate_id: 'legacy-missing-return-gate-gate' });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a retired-turn purge that would cascade an unrelated return gate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-external-gate-purge-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'workflow-external-gate-purge', 'Workflow external gate purge', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const fixture = await seedLegacyChildReturn(client, repository, 'external-gate');

      // This gate shares the retired turn as its caller, but its continuation
      // and return-gate identities are not owned by the retired activation. A
      // turn FK cascade must not silently erase it.
      await client.transaction([
        {
          sql: `INSERT INTO workflow_continuations (
                  workspace_id, run_id, continuation_id, kind, status,
                  payload_json, created_at, updated_at
                ) VALUES (?, ?, 'external-continuation', 'child_wait', 'pending', '{}', ?, ?)`,
          params: [WORKSPACE_ID, fixture.runId, NOW, NOW],
        },
        {
          sql: `INSERT INTO workflow_return_gates (
                  workspace_id, return_gate_id, continuation_run_id, continuation_id,
                  caller_task_id, caller_turn_id, caller_run_id, caller_node_id,
                  child_run_id, status, created_at, updated_at
                ) VALUES (?, 'external-return-gate', ?, 'external-continuation',
                          ?, ?, NULL, NULL, ?, 'consumed', ?, ?)`,
          params: [WORKSPACE_ID, fixture.runId, fixture.taskId, fixture.turnId, fixture.runId, NOW, NOW],
        },
      ]);
      const before = await rowCounts(client);

      await expect(repository.execute({
        kind: 'deleteTurn', workspaceId: WORKSPACE_ID, turnId: fixture.turnId,
      })).rejects.toThrow(/constraint/i);
      await expect(rowCounts(client)).resolves.toEqual(before);
      await expect(client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, fixture.turnId],
      )).resolves.toEqual({ id: fixture.turnId });
      await expect(client.get(
        `SELECT return_gate_id FROM workflow_return_gates
          WHERE workspace_id = ? AND return_gate_id = 'external-return-gate'`,
        [WORKSPACE_ID],
      )).resolves.toEqual({ return_gate_id: 'external-return-gate' });
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('deletes only terminal nested child runs reachable from retired state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-nested-run-delete-purge-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'workflow-nested-run-delete-purge', 'Workflow nested run delete purge', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const fixture = await seedLegacyChildReturn(client, repository, 'nested-run-delete');
      const nestedRunId = `${fixture.runId}-nested`;
      await client.transaction([
        {
          sql: `INSERT INTO workflow_runs (
                  workspace_id, run_id, definition_id, definition_version, status,
                  origin, parent_run_id, policy_json, created_at, updated_at
                ) VALUES (?, ?, 'wf-fan', 1, 'failed', 'child', ?, '{}', ?, ?)`,
          params: [WORKSPACE_ID, nestedRunId, fixture.runId, NOW, NOW],
        },
        {
          sql: `UPDATE workflow_continuations
                   SET child_run_id = ?, updated_at = ?
                 WHERE workspace_id = ? AND continuation_id = ?`,
          params: [nestedRunId, NOW, WORKSPACE_ID, 'legacy-nested-run-delete-continuation'],
        },
        {
          sql: `UPDATE workflow_return_gates
                   SET child_run_id = ?, updated_at = ?
                 WHERE workspace_id = ? AND return_gate_id = ?`,
          params: [nestedRunId, NOW, WORKSPACE_ID, 'legacy-nested-run-delete-gate'],
        },
      ]);

      await expect(repository.execute({
        kind: 'deleteTurn', workspaceId: WORKSPACE_ID, turnId: fixture.turnId,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, nestedRunId],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, fixture.runId],
      )).resolves.toEqual({ run_id: fixture.runId });
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('purges legacy state before deleting a task while retaining ordinary workflow ownership rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-task-delete-purge-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'workflow-task-delete-purge', 'Workflow task delete purge', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const fixture = await seedLegacyChildReturn(client, repository, 'task-delete');
      // Model the post-terminal workflow closure: the node is no longer a
      // pending shell and the task no longer carries its shell marker.
      await client.transaction([
        {
          sql: `UPDATE workflow_nodes SET status = 'succeeded'
                 WHERE workspace_id = ? AND run_id = ?`,
          params: [WORKSPACE_ID, fixture.runId],
        },
        {
          sql: `UPDATE tasks
                   SET payload_json = json_remove(payload_json, '$.workflowShell')
                 WHERE workspace_id = ? AND id = ?`,
          params: [WORKSPACE_ID, fixture.taskId],
        },
      ]);

      await expect(repository.execute({
        kind: 'deleteTask', workspaceId: WORKSPACE_ID, taskId: fixture.taskId,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(client.get(
        `SELECT id FROM tasks WHERE workspace_id = ? AND id = ?`, [WORKSPACE_ID, fixture.taskId],
      )).resolves.toBeUndefined();
      await expect(client.get<{ run_id: string }>(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, fixture.runId],
      )).resolves.toEqual({ run_id: fixture.runId });
      await expect(client.get(
        `SELECT activation_id FROM workflow_activations WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, `legacy-task-delete-activation`],
      )).resolves.toBeUndefined();
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('purges legacy state before queued-turn/message deletion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-queued-turn-delete-purge-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'workflow-queued-turn-delete-purge', 'Workflow queued turn delete purge', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const fixture = await seedLegacyChildReturn(client, repository, 'queued-turn-delete', { queued: true });

      await expect(repository.execute({
        kind: 'deleteQueuedTurnAndMessages',
        workspaceId: WORKSPACE_ID,
        taskId: fixture.taskId,
        turnId: fixture.turnId,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, fixture.turnId],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT id FROM messages WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, 'legacy-queued-turn-delete-message'],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT activation_id FROM workflow_activations WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, 'legacy-queued-turn-delete-activation'],
      )).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, fixture.runId],
      )).resolves.toEqual({ run_id: fixture.runId });
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('hides malformed retry descendants from active reads and queue promotion', async () => {
    const fixture = await openReclamationFixture('malformed-retry-visibility');
    try {
      const legacy = await seedLegacyChildReturn(
        fixture.client,
        fixture.repository,
        'malformed-retry-visibility',
      );
      await fixture.client.transaction([
        {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, payload_json
                ) VALUES (?, ?, ?, 1000, 'queued', 'retry', ?, ?)`,
          params: [
            'malformed-missing-predecessor',
            WORKSPACE_ID,
            legacy.taskId,
            NOW,
            JSON.stringify({ payloadVersion: 1, retryOf: 'missing-predecessor' }),
          ],
        },
        {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, payload_json
                ) VALUES (?, ?, ?, 1001, 'queued', 'retry', ?, ?)`,
          params: [
            'malformed-cycle-a',
            WORKSPACE_ID,
            legacy.taskId,
            NOW,
            JSON.stringify({ payloadVersion: 1, retryOf: 'malformed-cycle-b' }),
          ],
        },
        {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, payload_json
                ) VALUES (?, ?, ?, 1002, 'queued', 'retry', ?, ?)`,
          params: [
            'malformed-cycle-b',
            WORKSPACE_ID,
            legacy.taskId,
            NOW,
            JSON.stringify({ payloadVersion: 1, retryOf: 'malformed-cycle-a' }),
          ],
        },
      ]);

      await expect(fixture.repository.getTurn('malformed-missing-predecessor')).resolves.toBeUndefined();
      await expect(fixture.repository.getTurn('malformed-cycle-a')).resolves.toBeUndefined();
      await expect(fixture.repository.getTurn('malformed-cycle-b')).resolves.toBeUndefined();
      await expect(fixture.repository.listQueuedTurns(legacy.taskId)).resolves.toEqual([]);
      await expect(fixture.repository.listTurns(legacy.taskId)).resolves.not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'malformed-missing-predecessor' }),
          expect.objectContaining({ id: 'malformed-cycle-a' }),
          expect.objectContaining({ id: 'malformed-cycle-b' }),
        ]),
      );

      const ordinaryTask: MusterTask = {
        ...terminalTask('ordinary-retry-task'),
        lifecycle: 'open',
        releaseState: 'released',
      };
      await fixture.repository.execute({
        kind: 'createTask',
        workspaceId: WORKSPACE_ID,
        task: ordinaryTask,
      });
      await fixture.repository.execute({
        kind: 'createTurn',
        workspaceId: WORKSPACE_ID,
        turn: {
          id: 'ordinary-retry-base',
          taskId: ordinaryTask.id,
          sequence: 1,
          status: 'failed',
          trigger: 'engine',
          inputs: [],
          createdAt: NOW,
          finishedAt: NOW,
        },
      });
      await fixture.repository.execute({
        kind: 'createTurn',
        workspaceId: WORKSPACE_ID,
        turn: {
          id: 'ordinary-retry-descendant',
          taskId: ordinaryTask.id,
          sequence: 2,
          status: 'queued',
          trigger: 'retry',
          retryOf: 'ordinary-retry-base',
          inputs: [],
          createdAt: NOW,
        },
      });
      await expect(fixture.repository.getTurn('ordinary-retry-descendant')).resolves.toMatchObject({
        id: 'ordinary-retry-descendant',
        retryOf: 'ordinary-retry-base',
      });
      await expect(fixture.repository.listQueuedTurns(ordinaryTask.id)).resolves.toMatchObject([
        { id: 'ordinary-retry-descendant' },
      ]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('hides retry descendants beyond the bounded lineage depth from queue promotion', async () => {
    const fixture = await openReclamationFixture('overflow-retry-visibility');
    try {
      const legacy = await seedLegacyChildReturn(
        fixture.client,
        fixture.repository,
        'overflow-retry-visibility',
      );
      const statements = Array.from({ length: 65 }, (_, index) => {
        const predecessor = index === 0
          ? legacy.turnId
          : `overflow-retry-visibility-${index}`;
        const turnId = `overflow-retry-visibility-${index + 1}`;
        return {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, payload_json
                ) VALUES (?, ?, ?, ?, 'queued', 'retry', ?, ?)`,
          params: [
            turnId,
            WORKSPACE_ID,
            legacy.taskId,
            1100 + index,
            NOW,
            JSON.stringify({ payloadVersion: 1, retryOf: predecessor }),
          ] as import('./sqlite/rpc').SqlValue[],
        };
      });
      await fixture.client.transaction(statements);

      await expect(fixture.repository.getTurn('overflow-retry-visibility-65')).resolves.toBeUndefined();
      await expect(fixture.repository.listQueuedTurns(legacy.taskId)).resolves.toEqual([]);
      await expect(fixture.repository.listTurns(legacy.taskId)).resolves.not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'overflow-retry-visibility-65' }),
        ]),
      );
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not report a graph delete when a hidden child-return target is not purgeable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-workflow-graph-delete-purge-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'workflow-graph-delete-purge', 'Workflow graph delete purge', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const fixture = await seedLegacyChildReturn(client, repository, 'graph-delete');
      await client.run(
        `UPDATE workflow_runs SET status = 'running' WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, fixture.runId],
      );

      await expect(repository.execute({
        kind: 'completeGraphTask',
        workspaceId: WORKSPACE_ID,
        expectedTasks: [],
        tasks: [],
        turns: [],
        deleteTurnIds: [fixture.turnId],
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, fixture.turnId],
      )).resolves.toEqual({ id: fixture.turnId });
      await expect(client.get(
        `SELECT activation_id FROM workflow_activations WHERE workspace_id = ? AND activation_id = ?`,
        [WORKSPACE_ID, 'legacy-graph-delete-activation'],
      )).resolves.toEqual({ activation_id: 'legacy-graph-delete-activation' });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a purge when a retired artifact source is pinned by another run', async () => {
    const fixture = await openReclamationFixture('external-artifact-source');
    try {
      const legacy = await seedLegacyChildReturn(fixture.client, fixture.repository, 'external-artifact-source');
      const external = await startExternalWorkflowRun(fixture.client, fixture.repository, 'external-artifact-consumer');
      const sourceNode = await fixture.client.get<{ node_id: string; task_id: string }>(
        `SELECT node_id, task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL
          ORDER BY node_id LIMIT 1`,
        [WORKSPACE_ID, legacy.runId],
      );
      expect(sourceNode).toBeTruthy();
      await fixture.client.transaction([
        {
          sql: `INSERT INTO workflow_artifacts (
                  workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                  revision, kind, payload_json, created_at
                ) VALUES (?, ?, 'externally-pinned-artifact', ?, 'next_result', 1, 'next_result', '{}', ?)`,
          params: [WORKSPACE_ID, external.runId, sourceNode!.node_id, NOW],
        },
        {
          sql: `INSERT INTO workflow_artifact_sources (
                  workspace_id, run_id, artifact_id, artifact_revision, source_kind,
                  producer_run_id, producer_node_id, producer_task_id, producing_turn_id,
                  producing_activation_id, caller_task_id, caller_turn_id,
                  engine_start_operation_key
                ) VALUES (?, ?, 'externally-pinned-artifact', 1, 'workflow_node',
                          ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
          params: [
            WORKSPACE_ID,
            external.runId,
            legacy.runId,
            sourceNode!.node_id,
            sourceNode!.task_id,
            legacy.turnId,
            `legacy-external-artifact-source-activation`,
          ],
        },
      ]);

      await expect(fixture.repository.execute({
        kind: 'deleteTurn', workspaceId: WORKSPACE_ID, turnId: legacy.turnId,
      })).rejects.toThrow(/constraint/i);
      await expect(fixture.client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, legacy.turnId],
      )).resolves.toEqual({ id: legacy.turnId });
      await expect(fixture.client.get(
        `SELECT artifact_id FROM workflow_artifact_sources
          WHERE workspace_id = ? AND run_id = ? AND artifact_id = 'externally-pinned-artifact'`,
        [WORKSPACE_ID, external.runId],
      )).resolves.toEqual({ artifact_id: 'externally-pinned-artifact' });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a purge when a routed message reuses only a retired source turn ID', async () => {
    const fixture = await openReclamationFixture('external-routed-message');
    try {
      const legacy = await seedLegacyChildReturn(fixture.client, fixture.repository, 'external-routed-message');
      const external = await startExternalWorkflowRun(fixture.client, fixture.repository, 'external-routed-consumer');
      await fixture.client.run(
        `INSERT INTO workflow_routed_messages (
           workspace_id, run_id, message_id, source_node_id, source_task_id,
           source_turn_id, destination_node_id, kind, body_json, created_at
         ) VALUES (?, ?, 'externally-routed-message', 'external-source', ?, ?,
                   'external-destination', 'terminal_next', '{"external":true}', ?)`,
        [WORKSPACE_ID, external.runId, legacy.taskId, legacy.turnId, NOW],
      );

      await expect(fixture.repository.execute({
        kind: 'deleteTurn', workspaceId: WORKSPACE_ID, turnId: legacy.turnId,
      })).rejects.toThrow(/constraint/i);
      await expect(fixture.client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, legacy.turnId],
      )).resolves.toEqual({ id: legacy.turnId });
      await expect(fixture.client.get(
        `SELECT message_id FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND message_id = 'externally-routed-message'`,
        [WORKSPACE_ID, external.runId],
      )).resolves.toEqual({ message_id: 'externally-routed-message' });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a purge when a start claim has a different durable owner', async () => {
    const fixture = await openReclamationFixture('external-start-claim');
    try {
      const legacy = await seedLegacyChildReturn(fixture.client, fixture.repository, 'external-start-claim');
      await fixture.repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: terminalTask('external-claim-owner') });
      await fixture.client.run(
        `INSERT INTO workflow_start_claims (
           workspace_id, owner_task_id, caller_task_id, caller_turn_id,
           definition_id, definition_version, idempotency_key, fingerprint,
           run_id, created_at
         ) VALUES (?, 'external-claim-owner', ?, ?, 'wf-fan', 1,
                   'external-owner-claim', 'external-owner-fingerprint', ?, ?)`,
        [WORKSPACE_ID, legacy.taskId, legacy.turnId, legacy.runId, NOW],
      );

      await expect(fixture.repository.execute({
        kind: 'deleteTurn', workspaceId: WORKSPACE_ID, turnId: legacy.turnId,
      })).rejects.toThrow(/constraint/i);
      await expect(fixture.client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, legacy.turnId],
      )).resolves.toEqual({ id: legacy.turnId });
      await expect(fixture.client.get(
        `SELECT idempotency_key FROM workflow_start_claims
          WHERE workspace_id = ? AND idempotency_key = 'external-owner-claim'`,
        [WORKSPACE_ID],
      )).resolves.toEqual({ idempotency_key: 'external-owner-claim' });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects task deletion when a return gate is owned by another caller turn', async () => {
    const fixture = await openReclamationFixture('external-task-gate');
    try {
      const legacy = await seedLegacyChildReturn(fixture.client, fixture.repository, 'external-task-gate');
      await fixture.client.transaction([
        {
          sql: `UPDATE workflow_nodes SET status = 'succeeded'
                 WHERE workspace_id = ? AND run_id = ?`,
          params: [WORKSPACE_ID, legacy.runId],
        },
        {
          sql: `UPDATE tasks
                   SET payload_json = json_remove(payload_json, '$.workflowShell')
                 WHERE workspace_id = ? AND id = ?`,
          params: [WORKSPACE_ID, legacy.taskId],
        },
        {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, started_at, settled_at, payload_json
                ) VALUES ('external-caller-turn', ?, ?, 1000, 'succeeded', 'user', ?, ?, ?, '{}')`,
          params: [WORKSPACE_ID, legacy.taskId, NOW, NOW, NOW],
        },
        {
          sql: `INSERT INTO workflow_continuations (
                  workspace_id, run_id, continuation_id, kind, status,
                  payload_json, created_at, updated_at
                ) VALUES (?, ?, 'external-task-continuation', 'child_wait', 'resolved', '{}', ?, ?)`,
          params: [WORKSPACE_ID, legacy.runId, NOW, NOW],
        },
        {
          sql: `INSERT INTO workflow_return_gates (
                  workspace_id, return_gate_id, continuation_run_id, continuation_id,
                  caller_task_id, caller_turn_id, child_run_id, status,
                  created_at, updated_at
                ) VALUES (?, 'external-task-return-gate', ?, 'external-task-continuation',
                          ?, 'external-caller-turn', ?, 'consumed', ?, ?)`,
          params: [WORKSPACE_ID, legacy.runId, legacy.taskId, legacy.runId, NOW, NOW],
        },
      ]);
      const before = await rowCounts(fixture.client);

      await expect(fixture.repository.execute({
        kind: 'deleteTask', workspaceId: WORKSPACE_ID, taskId: legacy.taskId,
      })).rejects.toThrow(/constraint/i);
      await expect(rowCounts(fixture.client)).resolves.toEqual(before);
      await expect(fixture.client.get(
        `SELECT return_gate_id FROM workflow_return_gates
          WHERE workspace_id = ? AND return_gate_id = 'external-task-return-gate'`,
        [WORKSPACE_ID],
      )).resolves.toEqual({ return_gate_id: 'external-task-return-gate' });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a purge when a retry descendant crosses the forward depth bound', async () => {
    const fixture = await openReclamationFixture('forward-depth-overflow');
    try {
      const legacy = await seedLegacyChildReturn(fixture.client, fixture.repository, 'forward-depth-overflow');
      const statements = Array.from({ length: 65 }, (_, index) => {
        const predecessor = index === 0 ? legacy.turnId : `forward-depth-overflow-retry-${index}`;
        const turnId = `forward-depth-overflow-retry-${index + 1}`;
        return {
          sql: `INSERT INTO turns (
                  id, workspace_id, task_id, sequence, status, trigger,
                  created_at, started_at, settled_at, payload_json
                ) VALUES (?, ?, ?, ?, 'failed', 'retry', ?, ?, ?, ?)`,
          params: [
            turnId,
            WORKSPACE_ID,
            legacy.taskId,
            1000 + index,
            NOW,
            NOW,
            NOW,
            JSON.stringify({ payloadVersion: 1, retryOf: predecessor }),
          ] as import('./sqlite/rpc').SqlValue[],
        };
      });
      await fixture.client.transaction(statements);

      await expect(fixture.repository.execute({
        kind: 'deleteTurn', workspaceId: WORKSPACE_ID, turnId: legacy.turnId,
      })).rejects.toThrow(/constraint/i);
      await expect(fixture.client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, legacy.turnId],
      )).resolves.toEqual({ id: legacy.turnId });
      await expect(fixture.client.get(
        `SELECT id FROM turns WHERE workspace_id = ? AND id = 'forward-depth-overflow-retry-65'`,
        [WORKSPACE_ID],
      )).resolves.toEqual({ id: 'forward-depth-overflow-retry-65' });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('discovers child_return activations in terminal nested runs without deleting the parent', async () => {
    const fixture = await openReclamationFixture('nested-activation-seed');
    try {
      const parent = await seedLegacyChildReturn(fixture.client, fixture.repository, 'nested-activation-parent');
      const nested = await seedLegacyChildReturn(fixture.client, fixture.repository, 'nested-activation-child');
      await fixture.client.run(
        `UPDATE workflow_runs
            SET origin = 'child', parent_run_id = ?
          WHERE workspace_id = ? AND run_id = ?`,
        [parent.runId, WORKSPACE_ID, nested.runId],
      );

      await expect(fixture.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(fixture.client.get(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND activation_id = 'legacy-nested-activation-child-activation'`,
        [WORKSPACE_ID],
      )).resolves.toBeUndefined();
      await expect(fixture.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, nested.runId],
      )).resolves.toBeUndefined();
      await expect(fixture.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, parent.runId],
      )).resolves.toEqual({ run_id: parent.runId });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps a nested run with an unrelated resolved continuation', async () => {
    const fixture = await openReclamationFixture('nested-run-safety');
    try {
      const parent = await seedLegacyChildReturn(fixture.client, fixture.repository, 'nested-run-safety-parent');
      const nested = await seedLegacyChildReturn(fixture.client, fixture.repository, 'nested-run-safety-child');
      await fixture.client.transaction([
        {
          sql: `UPDATE workflow_runs
                  SET origin = 'child', parent_run_id = ?
                WHERE workspace_id = ? AND run_id = ?`,
          params: [parent.runId, WORKSPACE_ID, nested.runId],
        },
        {
          sql: `INSERT INTO workflow_continuations (
                  workspace_id, run_id, continuation_id, kind, status,
                  payload_json, created_at, updated_at
                ) VALUES (?, ?, 'unrelated-nested-continuation', 'child_wait', 'resolved', '{}', ?, ?)`,
          params: [WORKSPACE_ID, nested.runId, NOW, NOW],
        },
      ]);

      await expect(fixture.repository.execute({
        kind: 'deleteTurn', workspaceId: WORKSPACE_ID, turnId: nested.turnId,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(fixture.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, nested.runId],
      )).resolves.toEqual({ run_id: nested.runId });
      await expect(fixture.client.get(
        `SELECT continuation_id FROM workflow_continuations
          WHERE workspace_id = ? AND continuation_id = 'unrelated-nested-continuation'`,
        [WORKSPACE_ID],
      )).resolves.toEqual({ continuation_id: 'unrelated-nested-continuation' });
      await expect(fixture.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, parent.runId],
      )).resolves.toEqual({ run_id: parent.runId });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps a nested run when an unowned dependency gate remains open', async () => {
    const fixture = await openReclamationFixture('nested-open-gate');
    try {
      const parent = await seedLegacyChildReturn(fixture.client, fixture.repository, 'nested-open-gate-parent');
      const nested = await seedLegacyChildReturn(fixture.client, fixture.repository, 'nested-open-gate-child');
      const gate = await fixture.client.get<{ gate_id: string }>(
        `SELECT gate_id FROM workflow_dependency_gates
          WHERE workspace_id = ? AND run_id = ?
          ORDER BY gate_id LIMIT 1`,
        [WORKSPACE_ID, nested.runId],
      );
      expect(gate).toBeTruthy();
      await fixture.client.transaction([
        {
          sql: `UPDATE workflow_runs
                  SET origin = 'child', parent_run_id = ?
                WHERE workspace_id = ? AND run_id = ?`,
          params: [parent.runId, WORKSPACE_ID, nested.runId],
        },
        {
          sql: `UPDATE workflow_dependency_gates
                  SET status = 'open'
                WHERE workspace_id = ? AND run_id = ? AND gate_id = ?`,
          params: [WORKSPACE_ID, nested.runId, gate!.gate_id],
        },
      ]);

      await expect(fixture.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(fixture.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, nested.runId],
      )).resolves.toEqual({ run_id: nested.runId });
      await expect(fixture.client.get(
        `SELECT status FROM workflow_dependency_gates
          WHERE workspace_id = ? AND run_id = ? AND gate_id = ?`,
        [WORKSPACE_ID, nested.runId, gate!.gate_id],
      )).resolves.toEqual({ status: 'open' });
      await expect(fixture.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, parent.runId],
      )).resolves.toEqual({ run_id: parent.runId });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects purge before deleting a nested run that owns canonical run_closure data', async () => {
    const fixture = await openReclamationFixture('nested-run-closure');
    try {
      const parent = await seedLegacyChildReturn(fixture.client, fixture.repository, 'nested-run-closure-parent');
      const nested = await seedLegacyChildReturn(fixture.client, fixture.repository, 'nested-run-closure-child');
      await fixture.client.transaction([
        {
          sql: `UPDATE workflow_runs
                  SET origin = 'child', parent_run_id = ?
                WHERE workspace_id = ? AND run_id = ?`,
          params: [parent.runId, WORKSPACE_ID, nested.runId],
        },
        {
          sql: `INSERT INTO workflow_routed_messages (
                  workspace_id, run_id, message_id, source_node_id,
                  destination_node_id, kind, body_json, created_at
                ) VALUES (?, ?, 'nested-run-closure-message', 'engine',
                          'engine', 'run_closure', '{"closure":"must-keep"}', ?)`,
          params: [WORKSPACE_ID, nested.runId, NOW],
        },
      ]);
      const before = await rowCounts(fixture.client);

      await expect(fixture.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: WORKSPACE_ID,
      })).rejects.toThrow(/constraint/i);
      await expect(rowCounts(fixture.client)).resolves.toEqual(before);
      await expect(fixture.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, nested.runId],
      )).resolves.toEqual({ run_id: nested.runId });
      await expect(fixture.client.get<{ body_json: string }>(
        `SELECT body_json FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND message_id = ?`,
        [WORKSPACE_ID, nested.runId, 'nested-run-closure-message'],
      )).resolves.toEqual({ body_json: '{"closure":"must-keep"}' });
      await expect(fixture.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await fixture.client.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, 20_000);
});
