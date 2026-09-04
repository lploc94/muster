import { describe, expect, it } from 'vitest';
import {
  defineCanonicalWorkflow,
  defineOneNodeConsumer,
  openNamedWorkflowHarness,
  settleWorkflowTurn,
  startWorkflow,
  startedData,
  type NamedWorkflowHarness,
} from './workflow-named-composition-test-helpers';

async function defineBranchedSource(harness: NamedWorkflowHarness): Promise<void> {
  await defineCanonicalWorkflow(harness, {
    definitionId: 'wf-partial-source',
    topology: {
      kind: 'workflow',
      inputs: [],
      outputs: [
        { name: 'checkpoint', semanticKind: 'plan', sourceNodeId: 'producer' },
        { name: 'final', semanticKind: 'report', sourceNodeId: 'failing' },
      ],
      nodes: [
        { nodeId: 'producer', outcome: { kind: 'agent', requireExplicitDisposition: true, next: { when: 'ready' }, fail: { when: 'failed' } } },
        { nodeId: 'failing', outcome: { kind: 'agent', requireExplicitDisposition: true, next: { when: 'done' }, fail: { when: 'failed' } } },
      ],
      edges: [{ fromNodeId: 'producer', toNodeId: 'failing', inputRef: 'source', expectedArtifactKind: 'next_result' }],
    },
  });
}

describe('terminal workflow result availability and reuse', () => {
  it('advertises a valid checkpoint from a failed run and reuses it without retrying the producer', async () => {
    const harness = await openNamedWorkflowHarness('availability');
    try {
      await defineBranchedSource(harness);
      const source = startedData(await startWorkflow(harness, { definitionId: 'wf-partial-source', key: 'partial-source' }));
      await settleWorkflowTurn(harness, source.entries[0]!.taskId, source.entries[0]!.activationTurnId, {
        kind: 'workflow_next', change: 'updated', result: 'checkpoint-sentinel',
      });
      const failing = await harness.client.get<{ task_id: string; activation_turn_id: string }>(
        `SELECT node.task_id, activation.execution_turn_id AS activation_turn_id
           FROM workflow_nodes node JOIN workflow_activations activation
             ON activation.workspace_id = node.workspace_id AND activation.run_id = node.run_id AND activation.node_id = node.node_id
          WHERE node.workspace_id = ? AND node.run_id = ? AND node.node_id = 'failing'`,
        ['ws', source.runId],
      );
      expect(failing).toBeTruthy();
      await settleWorkflowTurn(harness, failing!.task_id, failing!.activation_turn_id, {
        kind: 'workflow_fail', reason: 'failing-sentinel',
      });
      const inspected = await harness.repository.inspectWorkflowRun(source.runId, 'root-task');
      expect(inspected?.runStatus).toBe('failed');
      expect(inspected?.results).toEqual([
        { name: 'checkpoint', kind: 'plan', role: 'checkpoint', status: 'available' },
        { name: 'final', kind: 'report', role: 'terminal', status: 'unavailable', reason: 'producer_failed' },
      ]);
      expect(inspected?.failure?.report.text).toContain('failing-sentinel');

      await defineOneNodeConsumer(harness, 'wf-partial-consumer', [{ name: 'plan', semanticKind: 'plan' }]);
      const consumer = await startWorkflow(harness, {
        definitionId: 'wf-partial-consumer', key: 'partial-consumer',
        inputs: [{ name: 'plan', fromRun: source.runId, output: 'checkpoint' }],
      });
      expect(consumer).toMatchObject({ ok: true, changed: true });
      expect(await harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM turns WHERE workspace_id = ? AND task_id = ?`,
        ['ws', source.entries[0]!.taskId],
      )).toEqual({ count: 1 });
    } finally {
      await harness.close();
    }
  }, 30_000);
});
