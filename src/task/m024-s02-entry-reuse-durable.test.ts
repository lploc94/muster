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
    goal: 'coordinate named workflow outputs', parentId: null, prerequisites: [],
    backend: 'grok', capabilities: [],
    executionPolicy: { maxTurns: 20, maxAutomaticRetries: 1 }, revision: 0,
    createdAt: NOW, updatedAt: NOW, releasedAt: NOW,
  };
}

describe('M024 S02 durable named output composition', () => {
  it('selects each declared terminal artifact instead of the multi-sink aggregate and pins its provenance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-m024-s02-named-output-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        [WORKSPACE_ID, 'm024-s02-named-output', 'M024 S02 named output', NOW, NOW],
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
      await expect(repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID,
        definitionId: 'wf-producer', version: 1, name: 'producer',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [
            { name: 'leftSourceResult', semanticKind: 'checkpoint.leftSource', sourceNodeId: 'leftSource' },
            { name: 'leftPlan', semanticKind: 'plan', sourceNodeId: 'left' },
            { name: 'rightSourceResult', semanticKind: 'checkpoint.rightSource', sourceNodeId: 'rightSource' },
            { name: 'rightPlan', semanticKind: 'plan', sourceNodeId: 'right' },
          ],
          nodes: [
            {
              nodeId: 'leftSource',
              outcome: {
                kind: 'agent',
                requireExplicitDisposition: true,
                next: { when: 'The left seed is ready.' },
                fail: { when: 'The left seed cannot be produced.' },
              },
            },
            {
              nodeId: 'left',
              outcome: {
                kind: 'agent',
                requireExplicitDisposition: true,
                next: { when: 'The left plan is ready.' },
                fail: { when: 'The left plan cannot be produced.' },
              },
            },
            {
              nodeId: 'rightSource',
              outcome: {
                kind: 'agent',
                requireExplicitDisposition: true,
                next: { when: 'The right seed is ready.' },
                fail: { when: 'The right seed cannot be produced.' },
              },
            },
            {
              nodeId: 'right',
              outcome: {
                kind: 'agent',
                requireExplicitDisposition: true,
                next: { when: 'The right plan is ready.' },
                fail: { when: 'The right plan cannot be produced.' },
              },
            },
          ],
          edges: [
            { fromNodeId: 'leftSource', toNodeId: 'left', inputRef: 'leftSeed' },
            { fromNodeId: 'rightSource', toNodeId: 'right', inputRef: 'rightSeed' },
          ],
        },
        createdAt: NOW,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: WORKSPACE_ID,
        definitionId: 'wf-consumer', version: 1, name: 'consumer',
        topology: {
          kind: 'workflow',
          inputs: [{ name: 'plan', semanticKind: 'plan', entryNodeId: 'entry', inputRef: 'plan' }],
          outputs: [{ name: 'result', semanticKind: 'result', sourceNodeId: 'entry' }],
          nodes: [{
            nodeId: 'entry',
            outcome: {
              kind: 'agent',
              requireExplicitDisposition: true,
              next: { when: 'The consumer result is ready.' },
              fail: { when: 'The consumer cannot complete.' },
            },
          }],
          edges: [],
        },
        entryContracts: [{ entryNodeId: 'entry', inputRef: 'plan', expectedArtifactKind: 'workflow_input' }],
        createdAt: NOW,
      })).resolves.toMatchObject({ ok: true, changed: true });

      const producerStart = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID,
        definitionId: 'wf-producer', version: 1,
        startIdempotencyKey: 'producer', createdAt: NOW,
        ownerRootTaskId: 'root-task', callerTaskId: 'root-task', callerTurnId: 'root-turn',
      });
      expect(producerStart).toMatchObject({ ok: true, changed: true });
      const producer = producerStart.operation!.result.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
      };
      const settle = async (taskId: string, turnId: string, result: string, index: number) => {
        await client.run(
          `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
          [`2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`, WORKSPACE_ID, turnId],
        );
        const turn = await repository.getTurn(turnId);
        const task = await repository.getTask(taskId);
        const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result };
        await stageDispositionForSettlement(repository, turn!, disposition);
        await expect(repository.execute({
          kind: 'settleTurnAndApplyEffects', workspaceId: WORKSPACE_ID,
          expectedTaskRevision: task!.revision,
          task: { ...task!, updatedAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.500Z` },
          turn: {
            ...turn!, status: 'succeeded', disposition,
            finishedAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.500Z`,
          },
          expectedStatuses: ['running'], relatedTurns: [], messages: [],
        })).resolves.toMatchObject({ ok: true, changed: true });
      };
      const entriesByNode = new Map(producer.entries.map((entry) => [entry.nodeId, entry] as const));
      await settle(
        entriesByNode.get('leftSource')!.taskId,
        entriesByNode.get('leftSource')!.activationTurnId,
        'left seed',
        1,
      );
      await settle(
        entriesByNode.get('rightSource')!.taskId,
        entriesByNode.get('rightSource')!.activationTurnId,
        'right seed',
        2,
      );
      const terminals = await client.all<{ node_id: string; task_id: string }>(
        `SELECT node_id, task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id IN ('left', 'right')
          ORDER BY node_id`,
        [WORKSPACE_ID, producer.runId],
      );
      const terminalByNode = new Map(terminals.map((node) => [node.node_id, node.task_id] as const));
      const rightTurn = (await repository.listTurns(terminalByNode.get('right')!))[0]!;
      const leftTurn = (await repository.listTurns(terminalByNode.get('left')!))[0]!;
      // Reverse completion order is deliberate: output names, not last completion, select authority.
      await settle(terminalByNode.get('right')!, rightTurn.id, 'RIGHT terminal value', 3);
      await settle(terminalByNode.get('left')!, leftTurn.id, 'LEFT terminal value', 4);

      const terminalPointer = await client.get<{
        terminal_result_artifact_id: string;
        terminal_result_artifact_revision: number;
      }>(
        `SELECT terminal_result_artifact_id, terminal_result_artifact_revision
           FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, producer.runId],
      );
      const terminalArtifacts = await client.all<{
        producer_node_id: string;
        artifact_id: string;
        revision: number;
        payload_json: string;
      }>(
         `SELECT producer_node_id, artifact_id, revision, payload_json
            FROM workflow_artifacts
           WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'
             AND logical_name = 'next_result' AND producer_node_id IN ('left', 'right')
          ORDER BY producer_node_id`,
        [WORKSPACE_ID, producer.runId],
      );
      expect(terminalArtifacts.map((artifact) => ({
        nodeId: artifact.producer_node_id,
        value: (JSON.parse(artifact.payload_json) as { result: string }).result,
      }))).toEqual([
        { nodeId: 'left', value: 'LEFT terminal value' },
        { nodeId: 'right', value: 'RIGHT terminal value' },
      ]);
      expect(terminalArtifacts.map((artifact) => artifact.artifact_id))
        .not.toContain(terminalPointer!.terminal_result_artifact_id);

      const starts = [] as Array<{
        output: string;
        value: string;
        runId: string;
        gateId: string;
        messageId: string;
      }>;
      for (const [index, output, value] of [
        [0, 'leftPlan', 'LEFT terminal value'],
        [1, 'rightPlan', 'RIGHT terminal value'],
      ] as const) {
        const started = await repository.execute({
          kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID,
          definitionId: 'wf-consumer', version: 1,
          startIdempotencyKey: `consumer-${index}`, createdAt: `2026-08-01T00:00:1${index}.000Z`,
          inputs: [{ name: 'plan', fromRun: producer.runId, output }],
          ownerRootTaskId: 'root-task', callerTaskId: 'root-task', callerTurnId: 'root-turn',
        });
        expect(started).toMatchObject({ ok: true, changed: true });
        const data = started.operation!.result.data as {
          runId: string; entryGateId: string; entryMessageId: string;
        };
        starts.push({ output, value, runId: data.runId, gateId: data.entryGateId, messageId: data.entryMessageId });
      }

      for (const started of starts) {
        const fill = await client.get<{
          artifact_run_id: string | null;
          artifact_id: string;
          artifact_revision: number;
          kind: string;
          payload_json: string;
          source_kind: string;
          source_artifact_run_id: string;
          source_artifact_id: string;
          source_artifact_revision: number;
          producer_run_id: string;
          producer_node_id: string;
        }>(
          `SELECT fill.artifact_run_id, fill.artifact_id, fill.artifact_revision,
                   artifact.kind, artifact.payload_json, source.source_kind,
                   source.source_artifact_run_id, source.source_artifact_id,
                   source.source_artifact_revision,
                   original_source.producer_run_id, original_source.producer_node_id
             FROM workflow_gate_fills fill
             JOIN workflow_artifacts artifact
               ON artifact.workspace_id = fill.workspace_id
              AND artifact.run_id = COALESCE(fill.artifact_run_id, fill.run_id)
              AND artifact.artifact_id = fill.artifact_id
              AND artifact.revision = fill.artifact_revision
             JOIN workflow_artifact_sources source
               ON source.workspace_id = artifact.workspace_id
              AND source.run_id = artifact.run_id
               AND source.artifact_id = artifact.artifact_id
               AND source.artifact_revision = artifact.revision
             JOIN workflow_artifacts source_artifact
               ON source_artifact.workspace_id = source.workspace_id
              AND source_artifact.run_id = source.source_artifact_run_id
              AND source_artifact.artifact_id = source.source_artifact_id
              AND source_artifact.revision = source.source_artifact_revision
             JOIN workflow_artifact_sources original_source
               ON original_source.workspace_id = source_artifact.workspace_id
              AND original_source.run_id = source_artifact.run_id
              AND original_source.artifact_id = source_artifact.artifact_id
              AND original_source.artifact_revision = source_artifact.revision
            WHERE fill.workspace_id = ? AND fill.run_id = ? AND fill.gate_id = ? AND fill.input_ref = 'plan'`,
          [WORKSPACE_ID, started.runId, started.gateId],
        );
        expect(fill).toMatchObject({
          artifact_run_id: null,
          kind: 'workflow_input',
          source_kind: 'workflow_artifact',
          source_artifact_run_id: producer.runId,
          source_artifact_id: terminalArtifacts.find((artifact) =>
            artifact.producer_node_id === (started.output === 'leftPlan' ? 'left' : 'right'))!.artifact_id,
          source_artifact_revision: 1,
          producer_run_id: producer.runId,
          producer_node_id: started.output === 'leftPlan' ? 'left' : 'right',
        });
        expect(JSON.parse(fill!.payload_json)).toMatchObject({ value: started.value, semanticKind: 'plan' });
        await expect(client.get<{ content: string }>(
          `SELECT content FROM messages WHERE workspace_id = ? AND id = ?`,
          [WORKSPACE_ID, started.messageId],
        )).resolves.toEqual({
          content: `[workflow-entry]\ninputRef="plan" utf8Bytes=${Buffer.byteLength(started.value, 'utf8')}\n${started.value}`,
        });
      }

      const replay = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID,
        definitionId: 'wf-consumer', version: 1,
        startIdempotencyKey: 'consumer-0', createdAt: '2026-08-01T00:00:10.000Z',
        inputs: [{ name: 'plan', fromRun: producer.runId, output: 'leftPlan' }],
        ownerRootTaskId: 'root-task', callerTaskId: 'root-task', callerTurnId: 'root-turn',
      });
      expect(replay).toMatchObject({ ok: true, changed: false });
      await expect(repository.execute({
        kind: 'startWorkflowRun', workspaceId: WORKSPACE_ID,
        definitionId: 'wf-consumer', version: 1,
        startIdempotencyKey: 'consumer-0', createdAt: '2026-08-01T00:00:10.000Z',
        inputs: [{ name: 'plan', fromRun: producer.runId, output: 'rightPlan' }],
        ownerRootTaskId: 'root-task', callerTaskId: 'root-task', callerTurnId: 'root-turn',
      })).resolves.toMatchObject({ ok: false, conflict: true, reason: 'start fingerprint conflict' });

      await expect(repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata', workspaceId: WORKSPACE_ID,
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [WORKSPACE_ID, producer.runId],
      )).resolves.toEqual({ run_id: producer.runId });
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
