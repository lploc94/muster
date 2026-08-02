import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_GRAPH_DIAGNOSTIC_CODES,
  WORKFLOW_GRAPH_ERROR_CODES,
  parseRequestWorkflowGraph,
  parseWorkflowGraphResult,
  type WorkflowGraphResult,
} from './workflow-graph-wire';

const valid: WorkflowGraphResult = {
  type: 'workflowGraphResult',
  requestId: 'graph-request-1',
  taskId: 'task-1',
  ok: true,
  graph: {
    runId: 'run-1',
    nodes: [
      { nodeId: 'plan', status: 'succeeded', reused: true },
      { nodeId: 'implement', status: 'running', reused: false },
    ],
    edges: [{ fromNodeId: 'plan', toNodeId: 'implement', inputRef: 'plan', reused: true }],
    activeGate: { gateId: 'gate-implement', status: 'waiting', satisfied: 1, required: 2 },
    feedbackRounds: [
      {
        roundId: 'feedback-1',
        requesterNodeId: 'plan',
        status: 'open',
        joinMode: 'all',
        required: 2,
        responded: 1,
      },
    ],
    childRuns: [{ runId: 'run-child-1', status: 'running' }],
    reuse: { nodeCount: 1, edgeCount: 1 },
    diagnostics: [{ code: 'workflow_graph_nodes_truncated' }],
  },
};

describe('workflow graph wire contract', () => {
  it('parses the exact correlated graph request for the host route', () => {
    expect(parseRequestWorkflowGraph({
      type: 'requestWorkflowGraph',
      requestId: 'graph-request-1',
      taskId: 'task-1',
    })).toEqual({ requestId: 'graph-request-1', taskId: 'task-1' });
    expect(parseRequestWorkflowGraph({
      type: 'requestWorkflowGraph',
      requestId: 'graph-request-1',
      taskId: 'task-1',
      unexpected: true,
    })).toBeNull();
    expect(parseRequestWorkflowGraph({ type: 'requestWorkflowGraph', requestId: '', taskId: 'task-1' })).toBeNull();
  });

  it('exposes closed error and diagnostic code taxonomies', () => {
    expect(WORKFLOW_GRAPH_ERROR_CODES).toEqual(['invalidRequest', 'notInWorkflow', 'unavailable']);
    expect(WORKFLOW_GRAPH_DIAGNOSTIC_CODES).toEqual([
      'workflow_graph_topology_undecodable',
      'workflow_graph_nodes_truncated',
      'workflow_graph_edges_truncated',
      'workflow_graph_child_runs_truncated',
    ]);
  });

  it('accepts a bounded successful graph result with graph details', () => {
    expect(parseWorkflowGraphResult(valid)).toEqual(valid);
  });

  it('accepts a bounded correlated failure without a graph', () => {
    const failure: WorkflowGraphResult = {
      type: 'workflowGraphResult',
      requestId: 'graph-request-1',
      taskId: 'task-1',
      ok: false,
      code: 'notInWorkflow',
    };
    expect(parseWorkflowGraphResult(failure)).toEqual(failure);
  });

  it('rejects malformed, correlation-unsafe, and extra-key messages', () => {
    expect(parseWorkflowGraphResult(null)).toBeNull();
    expect(parseWorkflowGraphResult({ ...valid, requestId: '' })).toBeNull();
    expect(parseWorkflowGraphResult({ ...valid, requestId: 'r'.repeat(129) })).toBeNull();
    expect(parseWorkflowGraphResult({ ...valid, taskId: 'task\0id' })).toBeNull();
    expect(parseWorkflowGraphResult({ ...valid, extra: true })).toBeNull();
  });

  it('rejects unknown codes, unsafe graph content, and invalid numeric bounds', () => {
    expect(parseWorkflowGraphResult({ ...valid, ok: false, code: 'internal' })).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, diagnostics: [{ code: 'database_path' }] },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, reuse: { nodeCount: -1, edgeCount: 0 } },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, activeGate: { ...valid.graph.activeGate!, required: Infinity } },
      }),
    ).toBeNull();
  });

  it('rejects graph records with missing or extra keys', () => {
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, nodes: [{ nodeId: 'plan', status: 'succeeded', reused: true, taskId: 'x' }] },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, edges: [{ fromNodeId: 'plan', toNodeId: 'implement', reused: true }] },
      }),
    ).toBeNull();
  });
});
