import { describe, expect, it, vi } from 'vitest';
import {
  routeRequestWorkflowGraph,
  type WorkflowGraphRouteDeps,
} from './workflow-graph-route';

function deps(overrides?: Partial<WorkflowGraphRouteDeps>): WorkflowGraphRouteDeps {
  return {
    getFocused: () => ({ taskId: 'task-1', generation: 1 }),
    buildWorkflowGraph: async () => ({
      runId: 'run-1',
      runStatus: 'running',
      nodes: [{
        nodeId: 'node-1', workflowNodeStatus: 'active', executionActivity: 'executing',
        displayState: 'executing', progressBucket: 'executing', reused: false,
      }],
      edges: [],
      gates: [],
      progress: {
        total: 1, completed: 0, queued: 0, executing: 1, waiting: 0,
        blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
        frontierNodeIds: ['node-1'], activeNodeIds: ['node-1'],
      },
      feedbackRounds: [],
      childRuns: [],
      reuse: { nodeCount: 0, edgeCount: 0 },
      diagnostics: [],
    }),
    ...overrides,
  };
}

describe('routeRequestWorkflowGraph', () => {
  it('silently drops correlation-unsafe requests without graph reads', async () => {
    const buildWorkflowGraph = vi.fn(deps().buildWorkflowGraph);

    await expect(
      routeRequestWorkflowGraph(
        { type: 'requestWorkflowGraph', requestId: '', taskId: 'task-1' },
        deps({ buildWorkflowGraph }),
      ),
    ).resolves.toEqual({ kind: 'silent' });
    expect(buildWorkflowGraph).not.toHaveBeenCalled();
  });

  it('returns invalidRequest for a non-focused task without graph reads', async () => {
    const buildWorkflowGraph = vi.fn(deps().buildWorkflowGraph);

    await expect(
      routeRequestWorkflowGraph(
        { type: 'requestWorkflowGraph', requestId: 'request-1', taskId: 'task-1' },
        deps({ getFocused: () => ({ taskId: 'task-2', generation: 1 }), buildWorkflowGraph }),
      ),
    ).resolves.toEqual({
      kind: 'message',
      message: {
        type: 'workflowGraphResult',
        requestId: 'request-1',
        taskId: 'task-1',
        ok: false,
        code: 'invalidRequest',
      },
    });
    expect(buildWorkflowGraph).not.toHaveBeenCalled();
  });

  it('returns notInWorkflow for a focused non-workflow task', async () => {
    await expect(
      routeRequestWorkflowGraph(
        { type: 'requestWorkflowGraph', requestId: 'request-1', taskId: 'task-1' },
        deps({ buildWorkflowGraph: async () => undefined }),
      ),
    ).resolves.toMatchObject({ kind: 'message', message: { ok: false, code: 'notInWorkflow' } });
  });

  it('maps graph read failures to unavailable without leaking error text', async () => {
    const outcome = await routeRequestWorkflowGraph(
      { type: 'requestWorkflowGraph', requestId: 'request-1', taskId: 'task-1' },
      deps({
        buildWorkflowGraph: async () => {
          throw new Error('SQLite failed at /private/workspace/muster.sqlite3');
        },
      }),
    );

    expect(outcome).toMatchObject({ kind: 'message', message: { ok: false, code: 'unavailable' } });
    expect(JSON.stringify(outcome)).not.toContain('/private/workspace');
  });

  it('does not return a graph after an A to B to A focus generation race', async () => {
    let resolveGraph!: (graph: Awaited<ReturnType<WorkflowGraphRouteDeps['buildWorkflowGraph']>>) => void;
    const graph = new Promise<Awaited<ReturnType<WorkflowGraphRouteDeps['buildWorkflowGraph']>>>((resolve) => {
      resolveGraph = resolve;
    });
    let focus = { taskId: 'task-1' as string | undefined, generation: 1 };
    const route = routeRequestWorkflowGraph(
      { type: 'requestWorkflowGraph', requestId: 'request-1', taskId: 'task-1' },
      deps({ getFocused: () => focus, buildWorkflowGraph: () => graph }),
    );
    focus = { taskId: 'task-2', generation: 2 };
    focus = { taskId: 'task-1', generation: 3 };
    resolveGraph(await deps().buildWorkflowGraph('task-1'));

    await expect(route).resolves.toMatchObject({
      kind: 'message',
      message: { ok: false, code: 'invalidRequest' },
    });
  });

  it('does not forward host diagnostics outside the shared wire allowlist', async () => {
    const outcome = await routeRequestWorkflowGraph(
      { type: 'requestWorkflowGraph', requestId: 'request-1', taskId: 'task-1' },
      deps({
        buildWorkflowGraph: async () => ({
          runId: 'run-1', runStatus: 'running', nodes: [], edges: [], gates: [],
          progress: {
            total: 0, completed: 0, queued: 0, executing: 0, waiting: 0,
            blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
            frontierNodeIds: [], activeNodeIds: [],
          },
          feedbackRounds: [], childRuns: [],
          reuse: { nodeCount: 0, edgeCount: 0 },
          diagnostics: [
            { code: 'workflow_graph_nodes_truncated' },
            { code: 'unexpected_internal_diagnostic' },
          ],
        }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'message',
      message: { ok: true, graph: { diagnostics: [{ code: 'workflow_graph_nodes_truncated' }] } },
    });
  });

  it('returns the bounded host graph for the focused task', async () => {
    const buildWorkflowGraph = vi.fn(deps().buildWorkflowGraph);

    const outcome = await routeRequestWorkflowGraph(
      { type: 'requestWorkflowGraph', requestId: 'request-1', taskId: 'task-1' },
      deps({ buildWorkflowGraph }),
    );

    expect(buildWorkflowGraph).toHaveBeenCalledOnce();
    expect(buildWorkflowGraph).toHaveBeenCalledWith('task-1');
    expect(outcome).toEqual({
      kind: 'message',
      message: {
        type: 'workflowGraphResult',
        requestId: 'request-1',
        taskId: 'task-1',
        ok: true,
        graph: {
          runId: 'run-1',
          runStatus: 'running',
          nodes: [{
            nodeId: 'node-1', workflowNodeStatus: 'active', executionActivity: 'executing',
            displayState: 'executing', progressBucket: 'executing', reused: false,
          }],
          edges: [],
          gates: [],
          progress: {
            total: 1, completed: 0, queued: 0, executing: 1, waiting: 0,
            blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
            frontierNodeIds: ['node-1'], activeNodeIds: ['node-1'],
          },
          feedbackRounds: [],
          childRuns: [],
          reuse: { nodeCount: 0, edgeCount: 0 },
          diagnostics: [],
        },
      },
    });
  });
});
