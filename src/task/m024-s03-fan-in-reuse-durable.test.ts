import { describe, expect, it } from 'vitest';
import {
  defineOneNodeConsumer,
  defineOneNodeProducer,
  NAMED_WORKSPACE_ID,
  openNamedWorkflowHarness,
  produceNamedOutput,
  startWorkflow,
  workflowRowCount,
} from './workflow-named-composition-test-helpers';

describe('M024 S03 named multi-source fan-in', () => {
  it('atomically composes independent named outputs and a literal under concurrent same-start replay', async () => {
    const harness = await openNamedWorkflowHarness('fan-in');
    try {
      await defineOneNodeProducer(harness, 'wf-plan-a', 'plan', 'approvedPlan');
      await defineOneNodeProducer(harness, 'wf-evidence', 'evidence', 'testEvidence');
      await defineOneNodeProducer(harness, 'wf-plan-b', 'plan', 'approvedPlan');
      await defineOneNodeConsumer(harness, 'wf-fan-in', [
        { name: 'plan', semanticKind: 'plan', inputRef: 'planInput' },
        { name: 'evidence', semanticKind: 'evidence', inputRef: 'evidenceInput' },
        { name: 'note', semanticKind: 'note', inputRef: 'noteInput' },
      ]);

      const planA = await produceNamedOutput(
        harness,
        'wf-plan-a',
        'plan-a',
        'PLAN A exact value',
      );
      const evidence = await produceNamedOutput(
        harness,
        'wf-evidence',
        'evidence',
        'EVIDENCE exact value',
      );
      const planB = await produceNamedOutput(
        harness,
        'wf-plan-b',
        'plan-b',
        'PLAN B different value',
      );

      const createdAt = harness.nextTimestamp();
      const start = () => startWorkflow(harness, {
        definitionId: 'wf-fan-in',
        key: 'fan-in-start',
        createdAt,
        inputs: [
          { name: 'evidence', fromRun: evidence.runId, output: 'testEvidence' },
          { name: 'note', value: 'LITERAL exact value' },
          { name: 'plan', fromRun: planA.runId, output: 'approvedPlan' },
        ],
      });
      const concurrent = await Promise.all([start(), start()]);
      expect(concurrent).toEqual(expect.arrayContaining([
        expect.objectContaining({ ok: true, changed: true }),
        expect.objectContaining({ ok: true, changed: false }),
      ]));
      expect(await workflowRowCount(harness, 'wf-fan-in')).toBe(1);
      const runId = (concurrent.find((result) => result.changed)!.operation!.result.data as {
        runId: string;
      }).runId;

      const adapted = await harness.client.all<{
        input_ref: string;
        payload_json: string;
        source_kind: string;
        source_artifact_run_id: string | null;
      }>(
        `SELECT fill.input_ref, artifact.payload_json, source.source_kind,
                source.source_artifact_run_id
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
          WHERE fill.workspace_id = ? AND fill.run_id = ?
          ORDER BY fill.input_ref`,
        [NAMED_WORKSPACE_ID, runId],
      );
      expect(adapted.map((row) => ({
        inputRef: row.input_ref,
        payload: JSON.parse(row.payload_json),
        sourceKind: row.source_kind,
        sourceRunId: row.source_artifact_run_id,
      }))).toEqual([
        {
          inputRef: 'evidenceInput',
          payload: { payloadVersion: 1, value: 'EVIDENCE exact value', semanticKind: 'evidence' },
          sourceKind: 'workflow_artifact',
          sourceRunId: evidence.runId,
        },
        {
          inputRef: 'noteInput',
          payload: { payloadVersion: 1, value: 'LITERAL exact value', semanticKind: 'note' },
          sourceKind: 'caller_turn',
          sourceRunId: null,
        },
        {
          inputRef: 'planInput',
          payload: { payloadVersion: 1, value: 'PLAN A exact value', semanticKind: 'plan' },
          sourceKind: 'workflow_artifact',
          sourceRunId: planA.runId,
        },
      ]);

      const changedSource = await startWorkflow(harness, {
        definitionId: 'wf-fan-in',
        key: 'fan-in-start',
        createdAt,
        inputs: [
          { name: 'plan', fromRun: planB.runId, output: 'approvedPlan' },
          { name: 'evidence', fromRun: evidence.runId, output: 'testEvidence' },
          { name: 'note', value: 'LITERAL exact value' },
        ],
      });
      expect(changedSource).toMatchObject({
        ok: false,
        changed: false,
        conflict: true,
        reason: 'start fingerprint conflict',
      });
      expect(await workflowRowCount(harness, 'wf-fan-in')).toBe(1);
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
