import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import {
  addRootAuthority,
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

describe('M024 S03 named output failure atomicity', () => {
  it('rejects unknown outputs, semantic mismatches, and non-succeeded sources without partial consumer state', async () => {
    const harness = await openNamedWorkflowHarness('failure-atomicity');
    try {
      await defineOneNodeProducer(harness, 'wf-plan-source', 'plan', 'approvedPlan');
      await defineOneNodeProducer(harness, 'wf-running-source', 'plan', 'approvedPlan');
      await defineOneNodeProducer(harness, 'wf-failed-source', 'plan', 'approvedPlan');
      await defineOneNodeConsumer(harness, 'wf-plan-consumer', [
        { name: 'plan', semanticKind: 'plan' },
      ]);
      await defineOneNodeConsumer(harness, 'wf-report-consumer', [
        { name: 'report', semanticKind: 'report' },
      ]);

      const succeeded = await produceNamedOutput(
        harness,
        'wf-plan-source',
        'source-succeeded',
        'approved source value',
      );
      const running = startedData(await startWorkflow(harness, {
        definitionId: 'wf-running-source',
        key: 'source-running',
      }));
      const failed = startedData(await startWorkflow(harness, {
        definitionId: 'wf-failed-source',
        key: 'source-failed',
      }));
      await settleWorkflowTurn(
        harness,
        failed.entries[0]!.taskId,
        failed.entries[0]!.activationTurnId,
        { kind: 'workflow_fail', reason: 'deliberate source failure' },
      );

      const failures = [
        {
          result: await startWorkflow(harness, {
            definitionId: 'wf-plan-consumer',
            key: 'unknown-output',
            inputs: [{ name: 'plan', fromRun: succeeded.runId, output: 'missing' }],
          }),
          reason: 'workflow input reference unresolved',
        },
        {
          result: await startWorkflow(harness, {
            definitionId: 'wf-report-consumer',
            key: 'kind-mismatch',
            inputs: [{ name: 'report', fromRun: succeeded.runId, output: 'approvedPlan' }],
          }),
          reason: 'workflow semantic kind mismatch',
        },
        {
          result: await startWorkflow(harness, {
            definitionId: 'wf-plan-consumer',
            key: 'running-source',
            inputs: [{ name: 'plan', fromRun: running.runId, output: 'approvedPlan' }],
          }),
          reason: 'workflow input reference unresolved',
        },
        {
          result: await startWorkflow(harness, {
            definitionId: 'wf-plan-consumer',
            key: 'failed-source',
            inputs: [{ name: 'plan', fromRun: failed.runId, output: 'approvedPlan' }],
          }),
          reason: 'workflow input reference unresolved',
        },
      ];
      for (const failure of failures) {
        expect(failure.result).toMatchObject({
          ok: false,
          changed: false,
          conflict: true,
          reason: failure.reason,
        });
      }

      expect(await workflowRowCount(harness, 'wf-plan-consumer')).toBe(0);
      expect(await workflowRowCount(harness, 'wf-report-consumer')).toBe(0);
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM workflow_artifact_sources
          WHERE workspace_id = ? AND source_kind = 'workflow_artifact'`,
        [NAMED_WORKSPACE_ID],
      )).resolves.toEqual({ count: 0 });
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('rejects an otherwise valid output owned by another root authority', async () => {
    const harness = await openNamedWorkflowHarness('foreign-root');
    try {
      await addRootAuthority(harness, 'foreign-root', 'foreign-turn');
      await defineOneNodeProducer(harness, 'wf-owned-source', 'plan', 'approvedPlan');
      await defineOneNodeConsumer(harness, 'wf-owned-consumer', [
        { name: 'plan', semanticKind: 'plan' },
      ]);
      const source = await produceNamedOutput(
        harness,
        'wf-owned-source',
        'owned-source',
        'root-private value',
      );

      const rejected = await startWorkflow(harness, {
        definitionId: 'wf-owned-consumer',
        key: 'foreign-consumer',
        inputs: [{ name: 'plan', fromRun: source.runId, output: 'approvedPlan' }],
        ownerRootTaskId: 'foreign-root',
        callerTaskId: 'foreign-root',
        callerTurnId: 'foreign-turn',
      });
      expect(rejected).toMatchObject({
        ok: false,
        changed: false,
        reason: 'workflow input reference unresolved',
      });
      expect(await workflowRowCount(harness, 'wf-owned-consumer')).toBe(0);
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('rolls back the operation claim, adapted artifact, gate fill, and run on a transaction fault', async () => {
    const harness = await openNamedWorkflowHarness('fault-rollback');
    try {
      await defineOneNodeProducer(harness, 'wf-fault-source', 'plan', 'approvedPlan');
      await defineOneNodeConsumer(harness, 'wf-fault-consumer', [
        { name: 'plan', semanticKind: 'plan' },
      ]);
      const source = await produceNamedOutput(
        harness,
        'wf-fault-source',
        'fault-source',
        'source survives consumer rollback',
      );

      await harness.client.close();
      const faultyClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
        faultCapability: true,
        faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
      });
      await faultyClient.open(harness.dbPath);
      harness.client = faultyClient;
      harness.repository = new SqliteTaskRepository(faultyClient, NAMED_WORKSPACE_ID);

      await expect(startWorkflow(harness, {
        definitionId: 'wf-fault-consumer',
        key: 'fault-consumer',
        inputs: [{ name: 'plan', fromRun: source.runId, output: 'approvedPlan' }],
      })).rejects.toMatchObject({ code: 'full' });

      await reopenNamedWorkflowHarness(harness);
      expect(await workflowRowCount(harness, 'wf-fault-consumer')).toBe(0);
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_artifact_sources
          WHERE workspace_id = ? AND source_kind = 'workflow_artifact'`,
        [NAMED_WORKSPACE_ID],
      )).resolves.toEqual({ count: 0 });
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_gate_fills fill
          JOIN workflow_runs run
            ON run.workspace_id = fill.workspace_id AND run.run_id = fill.run_id
          WHERE fill.workspace_id = ? AND run.definition_id = 'wf-fault-consumer'`,
        [NAMED_WORKSPACE_ID],
      )).resolves.toEqual({ count: 0 });

      await expect(startWorkflow(harness, {
        definitionId: 'wf-fault-consumer',
        key: 'fault-consumer',
        inputs: [{ name: 'plan', fromRun: source.runId, output: 'approvedPlan' }],
      })).resolves.toMatchObject({ ok: true, changed: true });
      expect(await workflowRowCount(harness, 'wf-fault-consumer')).toBe(1);
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
