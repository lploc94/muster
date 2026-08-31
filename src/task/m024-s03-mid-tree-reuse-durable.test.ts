import { describe, expect, it } from 'vitest';
import {
  defineOneNodeConsumer,
  defineOneNodeProducer,
  NAMED_WORKSPACE_ID,
  openNamedWorkflowHarness,
  produceNamedOutput,
  reopenNamedWorkflowHarness,
  settleWorkflowTurn,
  startWorkflow,
  startedData,
  workflowRowCount,
} from './workflow-named-composition-test-helpers';

describe('M024 S03 durable named output reload', () => {
  it('resolves an exact retained output after process reload and rejects a failed source atomically', async () => {
    const harness = await openNamedWorkflowHarness('reload');
    try {
      await defineOneNodeProducer(harness, 'wf-reload-source', 'plan', 'approvedPlan');
      await defineOneNodeProducer(harness, 'wf-failed-source', 'plan', 'approvedPlan');
      await defineOneNodeConsumer(harness, 'wf-reload-consumer', [
        { name: 'plan', semanticKind: 'plan', inputRef: 'planInput' },
      ]);
      const source = await produceNamedOutput(
        harness,
        'wf-reload-source',
        'reload-source',
        'VALUE persisted before reload',
      );
      const failed = startedData(await startWorkflow(harness, {
        definitionId: 'wf-failed-source',
        key: 'failed-source',
      }));
      await settleWorkflowTurn(
        harness,
        failed.entries[0]!.taskId,
        failed.entries[0]!.activationTurnId,
        { kind: 'workflow_fail', reason: 'failed before composition' },
      );

      await reopenNamedWorkflowHarness(harness);
      const composed = await startWorkflow(harness, {
        definitionId: 'wf-reload-consumer',
        key: 'reload-consumer',
        inputs: [{ name: 'plan', fromRun: source.runId, output: 'approvedPlan' }],
      });
      expect(composed).toMatchObject({ ok: true, changed: true });
      const consumerRunId = (composed.operation!.result.data as { runId: string }).runId;
      const adapted = await harness.client.get<{
        payload_json: string;
        source_artifact_run_id: string;
        source_artifact_id: string;
        source_artifact_revision: number;
      }>(
        `SELECT artifact.payload_json, source.source_artifact_run_id,
                source.source_artifact_id, source.source_artifact_revision
           FROM workflow_gate_fills fill
           JOIN workflow_artifacts artifact
             ON artifact.workspace_id = fill.workspace_id
            AND artifact.run_id = fill.run_id
            AND artifact.artifact_id = fill.artifact_id
            AND artifact.revision = fill.artifact_revision
           JOIN workflow_artifact_sources source
             ON source.workspace_id = artifact.workspace_id
            AND source.run_id = artifact.run_id
            AND source.artifact_id = artifact.artifact_id
            AND source.artifact_revision = artifact.revision
          WHERE fill.workspace_id = ? AND fill.run_id = ? AND fill.input_ref = 'planInput'`,
        [NAMED_WORKSPACE_ID, consumerRunId],
      );
      expect(JSON.parse(adapted!.payload_json)).toEqual({
        payloadVersion: 1,
        value: 'VALUE persisted before reload',
        semanticKind: 'plan',
      });
      expect(adapted).toMatchObject({
        source_artifact_run_id: source.runId,
        source_artifact_revision: 1,
      });

      const rejected = await startWorkflow(harness, {
        definitionId: 'wf-reload-consumer',
        key: 'failed-consumer',
        inputs: [{ name: 'plan', fromRun: failed.runId, output: 'approvedPlan' }],
      });
      expect(rejected).toMatchObject({
        ok: false,
        changed: false,
        reason: 'workflow input reference unresolved',
      });
      expect(await workflowRowCount(harness, 'wf-reload-consumer')).toBe(1);

      await expect(harness.repository.execute({
        kind: 'reclaimTerminalWorkflowMetadata',
        workspaceId: NAMED_WORKSPACE_ID,
      })).resolves.toMatchObject({ ok: true });
      await expect(harness.client.get(
        `SELECT run_id FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        [NAMED_WORKSPACE_ID, source.runId],
      )).resolves.toEqual({ run_id: source.runId });
      await expect(harness.client.get(
        `SELECT artifact_id, revision FROM workflow_artifacts
          WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'`,
        [NAMED_WORKSPACE_ID, source.runId],
      )).resolves.toMatchObject({ revision: 1 });
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
