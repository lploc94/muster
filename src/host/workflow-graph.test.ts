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
      runStatus: 'running',
      nodes: [
        {
          nodeId: 'reused-producer', workflowNodeStatus: 'reused', executionActivity: 'none',
          displayState: 'reused', progressBucket: 'completed',
        },
        {
          nodeId: 'live-consumer', workflowNodeStatus: 'active', executionActivity: 'executing',
          displayState: 'executing', progressBucket: 'executing',
        },
      ],
      edges: [
        {
          fromNodeId: 'reused-producer', toNodeId: 'live-consumer', inputRef: 'source',
          contributionState: 'supplied_reused',
        },
      ],
      gates: [{
        consumerNodeId: 'live-consumer', status: 'satisfied',
        required: 1, satisfied: 1,
        inputs: [{ inputRef: 'source', producerNodeId: 'reused-producer', state: 'supplied_reused' }],
      }],
      activeGate: {
        consumerNodeId: 'live-consumer', status: 'satisfied',
        required: 1, satisfied: 1,
        inputs: [{ inputRef: 'source', producerNodeId: 'reused-producer', state: 'supplied_reused' }],
      },
      progress: {
        total: 2, completed: 1, queued: 0, executing: 1, waiting: 0,
        blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
        frontierNodeIds: ['live-consumer'], activeNodeIds: ['live-consumer'],
      },
      feedbackRounds: [],
      reuse: { nodeCount: 1, edgeCount: 1 },
      diagnostics: [{ code: 'workflow_graph_nodes_truncated' }],
    });

    await expect(buildWorkflowGraphView(repository, 'task-1')).resolves.toMatchObject({
      runStatus: 'running',
      nodes: [
        {
          nodeId: 'reused-producer', workflowNodeStatus: 'reused', executionActivity: 'none',
          displayState: 'reused', progressBucket: 'completed', reused: true,
        },
        {
          nodeId: 'live-consumer', workflowNodeStatus: 'active', executionActivity: 'executing',
          displayState: 'executing', progressBucket: 'executing', reused: false,
        },
      ],
      edges: [
        {
          fromNodeId: 'reused-producer',
          toNodeId: 'live-consumer',
          inputRef: 'source',
          contributionState: 'supplied_reused',
          reused: true,
        },
      ],
      gates: [{
        consumerNodeId: 'live-consumer', status: 'satisfied',
        required: 1, satisfied: 1,
        inputs: [{ inputRef: 'source', producerNodeId: 'reused-producer', state: 'supplied_reused' }],
      }],
      activeGate: {
        consumerNodeId: 'live-consumer', status: 'satisfied',
        required: 1, satisfied: 1,
        inputs: [{ inputRef: 'source', producerNodeId: 'reused-producer', state: 'supplied_reused' }],
      },
      progress: {
        total: 2, completed: 1, queued: 0, executing: 1, waiting: 0,
        blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
        frontierNodeIds: ['live-consumer'], activeNodeIds: ['live-consumer'],
      },
      feedbackRounds: [],
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
