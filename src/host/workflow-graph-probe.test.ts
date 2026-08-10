import { describe, expect, it, vi } from 'vitest';
import {
  createWorkflowGraphProbeCoordinator,
  type WorkflowGraphProbeObservation,
} from './workflow-graph-probe';
import type { WorkflowGraphWireGraph } from '../shared/workflow-graph-wire';

const TASK_ID = 'wft-live-node';
const REQUEST_ID = 'workflow-graph-1-1700000000000';

function graph(overrides: Partial<WorkflowGraphWireGraph> = {}): WorkflowGraphWireGraph {
  return {
    runId: 'wfr-1',
    nodes: [
      { nodeId: 'one', status: 'reused', reused: true },
      { nodeId: 'two', status: 'reused', reused: true },
      { nodeId: 'five', status: 'active', reused: false },
    ],
    edges: [
      { fromNodeId: 'one', toNodeId: 'two', inputRef: 'one_result', reused: true },
      { fromNodeId: 'four', toNodeId: 'five', inputRef: 'four_result', reused: false },
    ],
    feedbackRounds: [],
    childRuns: [],
    reuse: { nodeCount: 2, edgeCount: 1 },
    diagnostics: [],
    ...overrides,
  };
}

function okResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'workflowGraphResult',
    requestId: REQUEST_ID,
    taskId: TASK_ID,
    ok: true,
    graph: graph(),
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return { type: 'requestWorkflowGraph', requestId: REQUEST_ID, taskId: TASK_ID, ...overrides };
}

describe('workflow graph probe coordinator', () => {
  it('settles only after a correlated request and result round trip', async () => {
    const coordinator = createWorkflowGraphProbeCoordinator();
    const observed = coordinator.expect(TASK_ID);

    // A result arriving before the webview request must not settle anything:
    // that would let a synthesized reply forge native-host proof.
    expect(coordinator.noteResult(okResult())).toBe(false);

    coordinator.noteRequest(request());
    expect(coordinator.noteResult(okResult())).toBe(true);

    const observation = await observed;
    expect(observation).toEqual<WorkflowGraphProbeObservation>({
      requestId: REQUEST_ID,
      taskId: TASK_ID,
      ok: true,
      graph: {
        hasRunId: true,
        nodeCount: 3,
        edgeCount: 2,
        reusedNodeCount: 2,
        reusedEdgeCount: 1,
        reuseNodeCount: 2,
        reuseEdgeCount: 1,
        nodeStatuses: ['active', 'reused'],
        childRunCount: 0,
        feedbackRoundCount: 0,
        diagnostics: [],
      },
    });
    coordinator.dispose();
  });

  it('ignores requests and results for a different task or request id', async () => {
    const coordinator = createWorkflowGraphProbeCoordinator();
    const observed = coordinator.expect(TASK_ID);

    coordinator.noteRequest(request({ taskId: 'wft-other' }));
    // Still unarmed, so even a well-formed matching result cannot settle.
    expect(coordinator.noteResult(okResult())).toBe(false);

    coordinator.noteRequest(request());
    expect(coordinator.noteResult(okResult({ requestId: 'workflow-graph-9-1' }))).toBe(false);
    expect(coordinator.noteResult(okResult({ taskId: 'wft-other' }))).toBe(false);
    expect(coordinator.noteResult(okResult())).toBe(true);

    await expect(observed).resolves.toMatchObject({ ok: true });
    coordinator.dispose();
  });

  it('keeps the first observed request id when the webview retries', async () => {
    const coordinator = createWorkflowGraphProbeCoordinator();
    const observed = coordinator.expect(TASK_ID);

    coordinator.noteRequest(request());
    coordinator.noteRequest(request({ requestId: 'workflow-graph-2-1700000000001' }));
    // Single-flight: the later id must not hijack the armed correlation.
    expect(coordinator.noteResult(okResult({ requestId: 'workflow-graph-2-1700000000001' }))).toBe(
      false,
    );
    expect(coordinator.noteResult(okResult())).toBe(true);
    await expect(observed).resolves.toMatchObject({ requestId: REQUEST_ID });
    coordinator.dispose();
  });

  it('rejects malformed results rather than reporting a partial graph', async () => {
    const coordinator = createWorkflowGraphProbeCoordinator();
    const observed = coordinator.expect(TASK_ID);
    coordinator.noteRequest(request());

    expect(coordinator.noteResult({ type: 'somethingElse' })).toBe(false);
    // An error code outside the wire contract must not settle the observation.
    expect(
      coordinator.noteResult({
        type: 'workflowGraphResult',
        requestId: REQUEST_ID,
        taskId: TASK_ID,
        ok: false,
        code: 'not_workflow_task',
      }),
    ).toBe(false);
    expect(coordinator.noteResult(okResult({ graph: { runId: 'wfr-1' } }))).toBe(false);
    // Extra field: fail-closed parser rejects the whole payload.
    expect(coordinator.noteResult(okResult({ extra: true }))).toBe(false);
    expect(coordinator.noteResult(okResult())).toBe(true);

    await expect(observed).resolves.toMatchObject({ ok: true });
    coordinator.dispose();
  });

  it('surfaces an error result verdict with its code and no graph', async () => {
    const coordinator = createWorkflowGraphProbeCoordinator();
    const observed = coordinator.expect(TASK_ID);
    coordinator.noteRequest(request());
    expect(
      coordinator.noteResult({
        type: 'workflowGraphResult',
        requestId: REQUEST_ID,
        taskId: TASK_ID,
        ok: false,
        code: 'notInWorkflow',
      }),
    ).toBe(true);

    const observation = await observed;
    expect(observation.ok).toBe(false);
    expect(observation.code).toBe('notInWorkflow');
    expect(observation.graph).toBeUndefined();
    coordinator.dispose();
  });

  it('reports a distinct timeout reason depending on how far the round trip got', async () => {
    vi.useFakeTimers();
    try {
      const noRequest = createWorkflowGraphProbeCoordinator({ timeoutMs: 50 });
      const first = noRequest.expect(TASK_ID);
      const firstAssertion = expect(first).rejects.toThrow(
        /timed out before the webview requested a graph/,
      );
      await vi.advanceTimersByTimeAsync(50);
      await firstAssertion;
      noRequest.dispose();

      const withRequest = createWorkflowGraphProbeCoordinator({ timeoutMs: 50 });
      const second = withRequest.expect(TASK_ID);
      withRequest.noteRequest(request());
      const secondAssertion = expect(second).rejects.toThrow(
        /observed the webview request but no correlated result/,
      );
      await vi.advanceTimersByTimeAsync(50);
      await secondAssertion;
      withRequest.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses concurrent observations and rejects after dispose', async () => {
    const coordinator = createWorkflowGraphProbeCoordinator();
    const first = coordinator.expect(TASK_ID);
    await expect(coordinator.expect(TASK_ID)).rejects.toThrow(/already pending/);
    await expect(coordinator.expect('')).rejects.toThrow(/already pending/);

    coordinator.dispose();
    await expect(first).rejects.toThrow(/disposed/);
    await expect(coordinator.expect(TASK_ID)).rejects.toThrow(/disposed/);
  });

  it('requires a task id and tolerates taps while idle', async () => {
    const coordinator = createWorkflowGraphProbeCoordinator();
    expect(() => coordinator.noteRequest(request())).not.toThrow();
    expect(coordinator.noteResult(okResult())).toBe(false);
    await expect(coordinator.expect('')).rejects.toThrow(/taskId is required/);
    coordinator.dispose();
  });
});
