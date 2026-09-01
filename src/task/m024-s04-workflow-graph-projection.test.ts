import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { routeRequestWorkflowGraph } from '../host/workflow-graph-route';
import { buildWorkflowGraphView } from '../host/workflow-graph';
import { parseWorkflowGraphResult } from '../shared/workflow-graph-wire';
import { buildWorkflowGraphPanelView } from '../../webview/src/lib/workflow-graph-view';
import type { MusterTask } from './types';
import { makeOneNodeDefinition } from './workflow';

const WORKSPACE_ID = 'ws';
const NOW = '2026-08-01T00:00:00.000Z';

function rootTask(): MusterTask {
  return {
    id: 'root-1', role: 'coordinator', lifecycle: 'open', releaseState: 'released',
    goal: 'coordinate five-node graph projection', parentId: null, prerequisites: [],
    backend: 'grok', capabilities: [], executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0, createdAt: NOW, updatedAt: NOW, releasedAt: NOW,
  };
}

describe('M024 S04 workflow graph projection', () => {
  it('retries the complete graph read when the workspace revision changes mid-projection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s04-revision-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'],
    });
    const peer = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(dbPath);
      await peer.open(dbPath);
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      const peerRepository = new SqliteTaskRepository(peer, WORKSPACE_ID);
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: WORKSPACE_ID,
        identityKey: 'm024-s04-revision-read', displayName: 'revision read',
        createdAt: NOW, lastOpenedAt: NOW,
      });
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: rootTask() });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: {
          id: 'root-revision-turn', taskId: 'root-1', sequence: 1,
          status: 'running', trigger: 'user', inputs: [], createdAt: NOW, startedAt: NOW,
        },
      });
      const revisionDefinition = makeOneNodeDefinition({
        definitionId: 'wf-revision-read',
        name: 'revision read',
        nodeId: 'only',
        createdAt: NOW,
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID,
        definitionId: revisionDefinition.definitionId, version: 1, name: revisionDefinition.name,
        topology: revisionDefinition.topology,
        createdAt: NOW,
      });
      const started = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID,
        definitionId: 'wf-revision-read', version: 1,
        startIdempotencyKey: 'revision-read', createdAt: NOW,
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-revision-turn',
        goal: 'revision read', backend: 'grok',
      });
      expect(started).toMatchObject({ ok: true, changed: true });

      const originalAll = client.all.bind(client);
      let graphNodeReads = 0;
      let injected = false;
      (client as unknown as { all: typeof client.all }).all = async (sql, params) => {
        if (sql.includes('FROM workflow_nodes node') && sql.includes('ORDER BY node.node_id LIMIT 65')) {
          graphNodeReads += 1;
          if (!injected) {
            injected = true;
            const root = await peerRepository.getTask('root-1');
            await peerRepository.execute({
              kind: 'renameTask', workspaceId: WORKSPACE_ID, taskId: 'root-1',
              goal: 'revision changed during graph read', updatedAt: '2026-08-01T00:00:01.000Z',
              expectedTaskRevision: root!.revision,
            });
          }
        }
        return originalAll(sql, params);
      };

      await expect(repository.getWorkflowGraphForTask('root-1')).resolves.toMatchObject({
        runStatus: 'running',
      });
      expect(graphNodeReads).toBe(2);

      graphNodeReads = 0;
      let forcedRaces = 0;
      (client as unknown as { all: typeof client.all }).all = async (sql, params) => {
        if (sql.includes('FROM workflow_nodes node') && sql.includes('ORDER BY node.node_id LIMIT 65')) {
          graphNodeReads += 1;
          forcedRaces += 1;
          const root = await peerRepository.getTask('root-1');
          await peerRepository.execute({
            kind: 'renameTask', workspaceId: WORKSPACE_ID, taskId: 'root-1',
            goal: `forced revision race ${forcedRaces}`,
            updatedAt: `2026-08-01T00:00:0${forcedRaces + 1}.000Z`,
            expectedTaskRevision: root!.revision,
          });
        }
        return originalAll(sql, params);
      };
      const outcome = await routeRequestWorkflowGraph(
        { type: 'requestWorkflowGraph', requestId: 'unstable-read', taskId: 'root-1' },
        {
          getFocused: () => ({ taskId: 'root-1', generation: 1 }),
          buildWorkflowGraph: () => buildWorkflowGraphView(repository, 'root-1'),
        },
      );
      expect(outcome).toMatchObject({
        kind: 'message',
        message: { ok: false, code: 'unavailable' },
      });
      expect(graphNodeReads).toBe(3);
    } finally {
      await client.close().catch(() => {});
      await peer.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps simultaneous workflow axes independent while redacting seeded private source data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s04-private-axes-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'],
    });
    const promptCanary = 'PRIVATE_PROMPT_CANARY';
    const pathCanary = '/private/PRIVATE_PATH_CANARY';
    const conditionCanary = 'PRIVATE_CONDITION_CANARY';
    const responseCanary = 'PRIVATE_RESPONSE_CANARY';
    const credentialCanary = 'PRIVATE_CREDENTIAL_CANARY';
    const artifactBodyCanary = 'PRIVATE_ARTIFACT_BODY_CANARY';
    const artifactIdCanary = 'wfa_private_artifact_canary';
    const turnIdCanary = 'turn_private_decision_repair_canary';
    const privateValues = [
      promptCanary,
      pathCanary,
      conditionCanary,
      responseCanary,
      credentialCanary,
      artifactBodyCanary,
      artifactIdCanary,
      turnIdCanary,
    ];
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: WORKSPACE_ID,
        identityKey: 'm024-s04-private-axes', displayName: 'private axes',
        createdAt: NOW, lastOpenedAt: NOW,
      });
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: rootTask() });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: {
          id: 'root-private-axes-turn', taskId: 'root-1', sequence: 1,
          status: 'running', trigger: 'user', inputs: [], createdAt: NOW, startedAt: NOW,
        },
      });
      const frozenInstructions = `${promptCanary}\nRead ${pathCanary}`;
      const defined = await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID,
        definitionId: 'wf-private-axes', version: 1, name: 'private axes', createdAt: NOW,
        topology: {
          kind: 'workflow', inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'downstream' }],
          nodes: [
            { nodeId: 'feedback', title: 'Await feedback' },
            {
              nodeId: 'repair',
              title: 'Repair route',
              instructions: {
                kind: 'inline' as const,
                content: frozenInstructions,
                sha256: createHash('sha256').update(frozenInstructions).digest('hex'),
              },
              outcome: {
                kind: 'agent' as const,
                requireExplicitDisposition: true,
                next: { when: conditionCanary },
                fail: { when: 'No bounded route remains.' },
              },
            },
            { nodeId: 'completed', title: 'Completed upstream' },
            { nodeId: 'executing', title: 'Execute now' },
            { nodeId: 'downstream', title: 'Collect results' },
          ],
          edges: [
            { fromNodeId: 'feedback', toNodeId: 'downstream', inputRef: 'feedback_result' },
            { fromNodeId: 'repair', toNodeId: 'downstream', inputRef: 'repair_result' },
            { fromNodeId: 'completed', toNodeId: 'downstream', inputRef: 'completed_result' },
            { fromNodeId: 'executing', toNodeId: 'downstream', inputRef: 'executing_result' },
          ],
        },
      });
      expect(defined).toMatchObject({ ok: true, changed: true });
      const started = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID,
        definitionId: 'wf-private-axes', version: 1,
        startIdempotencyKey: 'private-axes-start', createdAt: NOW,
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-private-axes-turn',
        goal: 'project independent axes without private source data', backend: 'grok',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const data = started.operation!.result.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
      };
      const entry = (nodeId: string) => data.entries.find((candidate) => candidate.nodeId === nodeId)!;
      const feedback = entry('feedback');
      const repair = entry('repair');
      const completed = entry('completed');
      const executing = entry('executing');
      const activation = await client.get<{ activation_id: string }>(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'repair'`,
        [WORKSPACE_ID, data.runId],
      );
      expect(activation).toBeTruthy();

      await client.run(
        `UPDATE turns SET status = 'succeeded', settled_at = ?,
                          payload_json = json_set(payload_json, '$.status', 'succeeded')
          WHERE workspace_id = ? AND id = ?`,
        ['2026-08-01T00:00:01.000Z', WORKSPACE_ID, repair.activationTurnId],
      );
      await expect(repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: {
          id: turnIdCanary, taskId: repair.taskId, sequence: 2,
          status: 'queued', trigger: 'engine', inputs: [],
          createdAt: '2026-08-01T00:00:02.000Z',
        },
      })).resolves.toMatchObject({ ok: true, changed: true });
      await client.transaction([
        {
          sql: `INSERT INTO messages (
                  id, workspace_id, task_id, turn_id, role, state, ordering,
                  content, created_at, payload_json
                ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [
            responseCanary, WORKSPACE_ID, repair.taskId, repair.activationTurnId,
            'assistant', 'complete', 0, responseCanary,
            '2026-08-01T00:00:02.000Z', JSON.stringify({ content: responseCanary }),
          ],
        },
        {
          sql: `INSERT INTO workflow_decision_repairs (
                  workspace_id, run_id, activation_id, status, attempts_used,
                  last_attempt_turn_id, last_error_code, last_response_message_id,
                  next_repair_turn_id, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            WORKSPACE_ID, data.runId, activation!.activation_id, 'open', 1,
            repair.activationTurnId, 'decision_invalid', responseCanary, turnIdCanary,
            '2026-08-01T00:00:02.000Z', '2026-08-01T00:00:02.000Z',
          ],
        },
        {
          sql: `UPDATE workflow_activations
                   SET execution_turn_id = ?, status = 'queued', updated_at = ?
                 WHERE workspace_id = ? AND run_id = ? AND activation_id = ?`,
          params: [
            turnIdCanary, '2026-08-01T00:00:02.000Z',
            WORKSPACE_ID, data.runId, activation!.activation_id,
          ],
        },
        {
          sql: `UPDATE turns SET status = 'waiting_user',
                           payload_json = json_set(payload_json, '$.status', 'waiting_user',
                                                                '$.privateResponse', ?,
                                                                '$.credential', ?)
                 WHERE workspace_id = ? AND id = ?`,
          params: [responseCanary, credentialCanary, WORKSPACE_ID, feedback.activationTurnId],
        },
        {
          sql: `UPDATE turns SET status = 'succeeded', settled_at = ?,
                           payload_json = json_set(payload_json, '$.status', 'succeeded')
                 WHERE workspace_id = ? AND id = ?`,
          params: ['2026-08-01T00:00:02.000Z', WORKSPACE_ID, completed.activationTurnId],
        },
        {
          sql: `UPDATE workflow_nodes SET status = 'succeeded'
                 WHERE workspace_id = ? AND run_id = ? AND node_id = 'completed'`,
          params: [WORKSPACE_ID, data.runId],
        },
        {
          sql: `UPDATE turns SET status = 'running', started_at = ?,
                           payload_json = json_set(payload_json, '$.status', 'running')
                 WHERE workspace_id = ? AND id = ?`,
          params: ['2026-08-01T00:00:02.000Z', WORKSPACE_ID, executing.activationTurnId],
        },
        {
          sql: `INSERT INTO workflow_feedback_rounds (
                  workspace_id, run_id, round_id, requester_node_id, requester_task_id,
                  status, join_mode, created_at
                ) VALUES (?,?,?,?,?,?,?,?)`,
          params: [
            WORKSPACE_ID, data.runId, 'round-private-axes', 'feedback', feedback.taskId,
            'open', 'all', '2026-08-01T00:00:02.000Z',
          ],
        },
        {
          sql: `INSERT INTO workflow_feedback_targets (
                  workspace_id, run_id, round_id, target_node_id, target_task_id, status
                ) VALUES (?,?,?,?,?,?)`,
          params: [
            WORKSPACE_ID, data.runId, 'round-private-axes',
            'completed', completed.taskId, 'responded',
          ],
        },
        {
          sql: `INSERT INTO workflow_feedback_targets (
                  workspace_id, run_id, round_id, target_node_id, target_task_id, status
                ) VALUES (?,?,?,?,?,?)`,
          params: [
            WORKSPACE_ID, data.runId, 'round-private-axes',
            'executing', executing.taskId, 'pending',
          ],
        },
        {
          sql: `INSERT INTO workflow_artifacts (
                  workspace_id, run_id, artifact_id, producer_node_id, logical_name,
                  revision, kind, payload_json, created_at
                ) VALUES (?,?,?,?,?,?,?,?,?)`,
          params: [
            WORKSPACE_ID, data.runId, artifactIdCanary, 'completed', 'completed_result',
            1, 'next_result', JSON.stringify({ result: artifactBodyCanary }),
            '2026-08-01T00:00:02.000Z',
          ],
        },
      ]);

      const graph = await repository.getWorkflowGraphForTask(repair.taskId);
      expect(graph?.nodes).toHaveLength(5);
      expect(graph?.nodes.find((node) => node.nodeId === 'feedback')).toMatchObject({
        displayState: 'waiting', executionActivity: 'waiting_feedback',
      });
      expect(graph?.nodes.find((node) => node.nodeId === 'repair')).toMatchObject({
        decisionGate: 'required',
        decision: { status: 'correcting', attempt: 2, maxAttempts: 3 },
      });
      expect(graph?.nodes.find((node) => node.nodeId === 'completed')).toMatchObject({
        displayState: 'completed', executionActivity: 'completed',
      });
      expect(graph?.nodes.find((node) => node.nodeId === 'executing')).toMatchObject({
        displayState: 'executing', executionActivity: 'executing',
      });
      expect(graph?.feedbackRounds).toEqual([expect.objectContaining({
        requesterNodeId: 'feedback', status: 'open', joinMode: 'all',
      })]);
      expect(graph?.progress).toMatchObject({ completed: 1, queued: 1, executing: 1, waiting: 1 });
      expect(graph).not.toHaveProperty('runId');
      expect(graph?.gates.every((gate) => !('gateId' in gate))).toBe(true);
      expect(graph?.activeGate).not.toHaveProperty('gateId');
      expect(graph?.feedbackRounds.every((round) => !('roundId' in round))).toBe(true);

      const hostGraph = await buildWorkflowGraphView(repository, repair.taskId);
      const outcome = await routeRequestWorkflowGraph(
        { type: 'requestWorkflowGraph', requestId: 'private-axes', taskId: repair.taskId },
        {
          getFocused: () => ({ taskId: repair.taskId, generation: 1 }),
          buildWorkflowGraph: async () => hostGraph,
        },
      );
      expect(outcome.kind).toBe('message');
      const message = (outcome as { message: unknown }).message;
      const parsed = parseWorkflowGraphResult(message);
      expect(parsed, JSON.stringify(message)).toMatchObject({ ok: true });
      const panel = buildWorkflowGraphPanelView(
        (parsed as Extract<typeof parsed, { ok: true }>).graph,
      );
      expect(panel.nodes).toHaveLength(5);
      expect(panel.nodes.find((node) => node.id === 'repair')?.decisionLabel)
        .toBe('Correcting workflow route · attempt 2 of 3');
      expect(panel.nodes.find((node) => node.id === 'feedback')?.statusLabel).toBe('Waiting');
      expect(panel.nodes.find((node) => node.id === 'completed')?.statusLabel).toBe('Completed');
      expect(panel.nodes.find((node) => node.id === 'executing')?.statusLabel).toBe('Executing');
      for (const value of privateValues) {
        expect(JSON.stringify(graph)).not.toContain(value);
        expect(JSON.stringify(outcome)).not.toContain(value);
        expect(JSON.stringify(panel)).not.toContain(value);
      }
    } finally {
      await client.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('reads a canonical titled five-node graph and bounded child-run diagnostics from SQLite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s04-graph-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'm024-s04-graph', 'M024 S04 graph', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: rootTask() });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: { id: 'root-turn', taskId: 'root-1', sequence: 1, status: 'running', trigger: 'user', inputs: [], createdAt: NOW, startedAt: NOW },
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'wf-five-chain', version: 1,
        name: 'five node chain', createdAt: NOW,
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'five' }],
          nodes: ['one', 'two', 'three', 'four', 'five'].map((nodeId) => ({
            nodeId,
            title: `Step ${nodeId}`,
          })),
          edges: [
            { fromNodeId: 'one', toNodeId: 'two', inputRef: 'one_result' },
            { fromNodeId: 'two', toNodeId: 'three', inputRef: 'two_result' },
            { fromNodeId: 'three', toNodeId: 'four', inputRef: 'three_result' },
            { fromNodeId: 'four', toNodeId: 'five', inputRef: 'four_result' },
          ],
        },
      });

      const consumerStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-five-chain', version: 1,
        startIdempotencyKey: 'consumer-five-chain', createdAt: '2026-08-01T00:00:02.000Z',
        ownerRootTaskId: 'root-1', callerTaskId: 'root-1', callerTurnId: 'root-turn',
      });
      expect(consumerStart).toMatchObject({ ok: true, changed: true });
      const consumer = consumerStart.operation!.result.data as { runId: string };
      await client.run(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 65
         ) INSERT INTO workflow_runs (
           workspace_id, run_id, definition_id, definition_version, status, origin,
           parent_run_id, owner_root_task_id, caller_task_id, caller_turn_id,
           continuation_id, policy_json, max_feedback_rounds, max_turns_per_task,
           max_workflow_turns, max_children, max_depth, max_concurrency,
           max_aggregate_bytes, feedback_rounds_reserved, workflow_turns_reserved,
           children_reserved, started_at, deadline_at, created_at, updated_at
         ) SELECT workspace_id, printf('child-run-%03d', sequence.n), definition_id,
                  definition_version, 'running', 'child', run_id, owner_root_task_id,
                  caller_task_id, caller_turn_id, NULL, policy_json,
                  max_feedback_rounds, max_turns_per_task, max_workflow_turns,
                  max_children, max_depth, max_concurrency, max_aggregate_bytes,
                  0, 0, 0, NULL, NULL, '2026-08-01T00:00:03.000Z',
                  '2026-08-01T00:00:03.000Z'
             FROM workflow_runs CROSS JOIN sequence
            WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, consumer.runId],
      );
      const five = await client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'five'`,
        [WORKSPACE_ID, consumer.runId],
      );
      expect(five?.task_id).toEqual(expect.any(String));
      const durableNodes = await client.all<{
        node_id: string;
        task_id: string | null;
        status: string;
        source_run_id: string | null;
        source_node_id: string | null;
        source_task_id: string | null;
        source_artifact_id: string | null;
        source_artifact_revision: number | null;
      }>(
        `SELECT node_id, task_id, status, source_run_id, source_node_id, source_task_id,
                 source_artifact_id, source_artifact_revision
            FROM workflow_nodes
           WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
        [WORKSPACE_ID, consumer.runId],
      );
      expect(durableNodes.map((node) => [node.node_id, node.status])).toEqual([
        ['five', 'pending'],
        ['four', 'pending'],
        ['one', 'active'],
        ['three', 'pending'],
        ['two', 'pending'],
      ]);
      expect(durableNodes.every((node) => typeof node.task_id === 'string')).toBe(true);
      expect(durableNodes.every((node) =>
        node.source_run_id === null
        && node.source_node_id === null
        && node.source_task_id === null
        && node.source_artifact_id === null
        && node.source_artifact_revision === null)).toBe(true);

      const graph = await repository.getWorkflowGraphForTask(five!.task_id);
      expect(graph).toEqual({
        runStatus: 'running',
        nodes: [
          {
            nodeId: 'five', title: 'Step five', workflowNodeStatus: 'pending', executionActivity: 'none',
            displayState: 'blocked', progressBucket: 'blocked', reason: 'waiting_for_inputs',
          },
          {
            nodeId: 'four', title: 'Step four', workflowNodeStatus: 'pending', executionActivity: 'none',
            displayState: 'blocked', progressBucket: 'blocked', reason: 'waiting_for_inputs',
          },
          {
            nodeId: 'one', title: 'Step one', workflowNodeStatus: 'active', executionActivity: 'queued',
            displayState: 'queued', progressBucket: 'queued',
          },
          {
            nodeId: 'three', title: 'Step three', workflowNodeStatus: 'pending', executionActivity: 'none',
            displayState: 'blocked', progressBucket: 'blocked', reason: 'waiting_for_inputs',
          },
          {
            nodeId: 'two', title: 'Step two', workflowNodeStatus: 'pending', executionActivity: 'none',
            displayState: 'blocked', progressBucket: 'blocked', reason: 'waiting_for_inputs',
          },
        ],
        edges: [
          {
            fromNodeId: 'one', toNodeId: 'two', inputRef: 'one_result',
            contributionState: 'pending',
          },
          {
            fromNodeId: 'two', toNodeId: 'three', inputRef: 'two_result',
            contributionState: 'pending',
          },
          {
            fromNodeId: 'three', toNodeId: 'four', inputRef: 'three_result',
            contributionState: 'pending',
          },
          {
            fromNodeId: 'four', toNodeId: 'five', inputRef: 'four_result',
            contributionState: 'pending',
          },
        ],
        gates: expect.arrayContaining([
          expect.objectContaining({
            consumerNodeId: 'five', status: 'open', required: 1, satisfied: 0,
            inputs: [{
              inputRef: 'four_result', producerNodeId: 'four', state: 'pending',
            }],
          }),
        ]),
        activeGate: expect.objectContaining({ status: 'open', required: 1, satisfied: 0 }),
        progress: {
          total: 5, completed: 0, queued: 1, executing: 0, waiting: 0,
          blocked: 4, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
          frontierNodeIds: ['five', 'four', 'one', 'three', 'two'], activeNodeIds: [],
        },
        feedbackRounds: [],
        childRuns: expect.arrayContaining([{ status: 'running' }]),
        reuse: { nodeCount: 0, edgeCount: 0 },
        diagnostics: [{ code: 'workflow_graph_child_runs_truncated' }],
      });
      expect(JSON.stringify(graph)).not.toMatch(/payload_json|body_json|prompt|\/tmp\/|api[_-]?key|secret/i);
      expect(JSON.stringify(graph)).not.toContain(consumer.runId);
      expect(JSON.stringify(graph)).not.toContain('child-run-001');
      expect(graph?.gates.every((gate) => !('gateId' in gate))).toBe(true);
      await expect(repository.getWorkflowGraphForTask('root-1')).resolves.toEqual(graph);
      const hostGraph = await buildWorkflowGraphView(repository, five!.task_id);
      const outcome = await routeRequestWorkflowGraph(
        { type: 'requestWorkflowGraph', requestId: 'graph-request-1', taskId: five!.task_id },
        {
          getFocused: () => ({ taskId: five!.task_id, generation: 1 }),
          buildWorkflowGraph: async () => hostGraph,
        },
      );
      expect(outcome.kind).toBe('message');
      const result = parseWorkflowGraphResult((outcome as { message: unknown }).message);
      expect(result).toMatchObject({ ok: true });
      const panel = buildWorkflowGraphPanelView((result as Extract<typeof result, { ok: true }>).graph);
      expect(panel.nodes.filter((node) => node.reused)).toHaveLength(0);
      expect(panel.nodes.find((node) => node.id === 'five')?.title).toBe('Step five');
      expect(panel.activeGate).toMatchObject({ satisfied: 0, required: 1 });
      expect(panel.childRuns).toHaveLength(64);
      expect(panel.childRuns[0]).toEqual({ label: 'Child workflow 1', status: 'running', statusLabel: 'Running' });
      expect(panel.reuseSummary).toMatchObject({ nodeCount: 0, edgeCount: 0 });
      expect(panel.degradedRead.diagnostics).toEqual(['Child workflow runs were truncated']);

    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
