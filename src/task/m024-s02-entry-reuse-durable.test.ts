import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { stageDispositionForSettlement } from './m018-test-helpers';
import type { MusterTask } from './types';

const WORKSPACE_ID = 'ws';
const NOW = '2026-08-01T00:00:00.000Z';

function rootTask(): MusterTask {
  return {
    id: 'root-task', role: 'coordinator', lifecycle: 'open', releaseState: 'released',
    goal: 'coordinate reusable workflow results', parentId: null, prerequisites: [],
    backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 }, revision: 0,
    createdAt: NOW, updatedAt: NOW, releasedAt: NOW,
  };
}

describe('M024 S02 durable cross-run entry reuse', () => {
  it('fills an entry gate from a prior terminal result, activates with its body, and pins the producer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s02-durable-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'm024-s02-durable', 'M024 S02 durable', NOW, NOW],
      );
      const repository = new SqliteTaskRepository(client, WORKSPACE_ID);
      await repository.execute({ kind: 'createTask', workspaceId: WORKSPACE_ID, task: rootTask() });
      await repository.execute({
        kind: 'createTurn', workspaceId: WORKSPACE_ID,
        turn: {
          id: 'root-turn', taskId: 'root-task', sequence: 1, status: 'running', trigger: 'user',
          inputs: [], createdAt: NOW, startedAt: NOW,
        },
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'wf-producer', version: 1,
        name: 'producer', topology: {
          kind: 'one_node_v1', nodes: [{ nodeId: 'entry' }], entryNodeId: 'entry',
        }, createdAt: NOW,
      });
      await repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID, definitionId: 'wf-consumer', version: 1,
        name: 'consumer', topology: {
          kind: 'one_node_v1', nodes: [{ nodeId: 'entry' }], entryNodeId: 'entry',
        }, entryContracts: [{
          entryNodeId: 'entry', inputRef: 'prior_result', expectedArtifactKind: 'workflow_input',
        }], createdAt: NOW,
      });

      const producerStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-producer', version: 1,
        startIdempotencyKey: 'producer', createdAt: NOW, goal: 'produce a reusable result', backend: 'grok',
        ownerRootTaskId: 'root-task', callerTaskId: 'root-task', callerTurnId: 'root-turn',
      });
      expect(producerStart).toMatchObject({ ok: true, changed: true });
      const producer = producerStart.operation!.result.data as {
        runId: string; entryTaskId: string; activationTurnId: string;
      };
      await client.run(
        `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
        ['2026-08-01T00:00:01.000Z', WORKSPACE_ID, producer.activationTurnId],
      );
      const producerTurn = await repository.getTurn(producer.activationTurnId);
      const producerTask = await repository.getTask(producer.entryTaskId);
      const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result: 'reused terminal body' };
      await stageDispositionForSettlement(repository, producerTurn!, disposition);
      await expect(repository.execute({
        kind: 'settleTurnAndApplyEffects', workspaceId: WORKSPACE_ID,
        expectedTaskRevision: producerTask!.revision,
        task: { ...producerTask!, lifecycle: 'succeeded', updatedAt: '2026-08-01T00:00:02.000Z' },
        turn: {
          ...producerTurn!, status: 'succeeded', finishedAt: '2026-08-01T00:00:02.000Z', disposition,
        }, expectedStatuses: ['running'], relatedTurns: [], messages: [],
      })).resolves.toMatchObject({ ok: true, changed: true });

      const terminal = await client.get<{
        terminal_result_run_id: string; terminal_result_artifact_id: string; terminal_result_artifact_revision: number;
      }>(`SELECT terminal_result_run_id, terminal_result_artifact_id, terminal_result_artifact_revision
            FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`, [WORKSPACE_ID, producer.runId]);
      expect(terminal).toMatchObject({
        terminal_result_run_id: producer.runId,
        terminal_result_artifact_id: expect.any(String),
        terminal_result_artifact_revision: 1,
      });

      const consumerStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID, definitionId: 'wf-consumer', version: 1,
        startIdempotencyKey: 'consumer', createdAt: '2026-08-01T00:00:03.000Z',
        goal: 'consume a reusable result', backend: 'grok',
        entryInputs: [{ entryNodeId: 'entry', inputRef: 'prior_result', fromRun: producer.runId }],
        ownerRootTaskId: 'root-task', callerTaskId: 'root-task', callerTurnId: 'root-turn',
      });
      expect(consumerStart).toMatchObject({ ok: true, changed: true });
      const consumer = consumerStart.operation!.result.data as {
        runId: string; entryGateId: string; entryMessageId: string;
      };

      await expect(client.get(
        `SELECT artifact_run_id, artifact_id, artifact_revision FROM workflow_gate_fills
          WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND input_ref = ?`,
        [WORKSPACE_ID, consumer.runId, consumer.entryGateId, 'prior_result'],
      )).resolves.toEqual({
        artifact_run_id: producer.runId,
        artifact_id: terminal!.terminal_result_artifact_id,
        artifact_revision: 1,
      });
      await expect(client.get(
        `SELECT required_kind FROM workflow_gate_bindings
          WHERE workspace_id = ? AND run_id = ? AND gate_id = ? AND input_ref = ?`,
        [WORKSPACE_ID, consumer.runId, consumer.entryGateId, 'prior_result'],
      )).resolves.toEqual({ required_kind: 'next_result' });
      await expect(client.get(
        `SELECT content FROM messages WHERE workspace_id = ? AND id = ?`,
        [WORKSPACE_ID, consumer.entryMessageId],
      )).resolves.toEqual({
        content: '[workflow-entry]\ninputRef="prior_result" utf8Bytes=20\nreused terminal body',
      });
      // Reclamation no longer deletes workflow_runs (that cascaded start claims and
      // broke idempotent replay); it only strips routed message bodies of terminal,
      // unpinned runs. This producer is pinned by the consumer gate fill above, so the
      // pass must report no change and leave the producer addressable.
      await expect(repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, producer.runId],
      )).resolves.toEqual({ run_id: producer.runId });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
