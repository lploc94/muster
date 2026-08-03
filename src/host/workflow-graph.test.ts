import { describe, expect, it, vi } from 'vitest';
import { buildWorkflowGraphView } from './workflow-graph';
import type { TaskRepository } from '../task/repository';
import type { WorkflowGraphProjection } from '../task/workflow-types';

function repositoryFor(graph: WorkflowGraphProjection | undefined): Pick<TaskRepository, 'getWorkflowGraphForTask'> {
  return {
    getWorkflowGraphForTask: vi.fn().mockResolvedValue(graph),
  };
}

describe('buildWorkflowGraphView', () => {
  it('adapts the bounded host-only graph for a graph viewer and derives reused edges', async () => {
    const repository = repositoryFor({
      runId: 'run-1',
      nodes: [
        { nodeId: 'reused-producer', status: 'reused' },
        { nodeId: 'live-consumer', status: 'running' },
      ],
      edges: [
        { fromNodeId: 'reused-producer', toNodeId: 'live-consumer', inputRef: 'source' },
      ],
      activeGate: { gateId: 'gate-1', status: 'pending', required: 1, satisfied: 0 },
      feedbackRounds: [],
      childRuns: [{ runId: 'child-1', status: 'running' }],
      reuse: { nodeCount: 1, edgeCount: 1 },
      diagnostics: [{ code: 'workflow_graph_nodes_truncated' }],
    });

    await expect(buildWorkflowGraphView(repository, 'task-1')).resolves.toEqual({
      runId: 'run-1',
      nodes: [
        { nodeId: 'reused-producer', status: 'reused', reused: true },
        { nodeId: 'live-consumer', status: 'running', reused: false },
      ],
      edges: [
        {
          fromNodeId: 'reused-producer',
          toNodeId: 'live-consumer',
          inputRef: 'source',
          reused: true,
        },
      ],
      activeGate: { gateId: 'gate-1', status: 'pending', required: 1, satisfied: 0 },
      feedbackRounds: [],
      childRuns: [{ runId: 'child-1', status: 'running' }],
      reuse: { nodeCount: 1, edgeCount: 1 },
      diagnostics: [{ code: 'workflow_graph_nodes_truncated' }],
    });
    expect(repository.getWorkflowGraphForTask).toHaveBeenCalledWith('task-1');
  });

  it('returns undefined for a task without a workflow graph', async () => {
    const repository = repositoryFor(undefined);

    await expect(buildWorkflowGraphView(repository, 'ordinary-task')).resolves.toBeUndefined();
  });

  it('bubbles a repository read failure rather than disguising it as no graph', async () => {
    const repository: Pick<TaskRepository, 'getWorkflowGraphForTask'> = {
      getWorkflowGraphForTask: vi.fn().mockRejectedValue(new Error('SQLite worker unavailable')),
    };

    await expect(buildWorkflowGraphView(repository, 'task-1')).rejects.toThrow(
      'SQLite worker unavailable',
    );
  });
});
