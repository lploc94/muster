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
    runStatus: 'running',
    nodes: [
      {
        nodeId: 'plan', workflowNodeStatus: 'reused', executionActivity: 'none',
        displayState: 'reused', progressBucket: 'completed', reused: true,
      },
      {
        nodeId: 'implement', title: 'Implement safely', workflowNodeStatus: 'pending', executionActivity: 'none',
        displayState: 'blocked', progressBucket: 'blocked', reason: 'waiting_for_inputs',
        decisionGate: 'required',
        reused: false,
      },
    ],
    edges: [{
      fromNodeId: 'plan', toNodeId: 'implement', inputRef: 'plan',
      contributionState: 'supplied_reused', reused: true,
    }],
    gates: [{
      consumerNodeId: 'implement', status: 'open',
      satisfied: 1, required: 2,
      inputs: [
        { inputRef: 'plan', producerNodeId: 'plan', state: 'supplied_reused' },
        { inputRef: 'review', producerNodeId: 'engine_start', state: 'pending' },
      ],
    }],
    activeGate: {
      consumerNodeId: 'implement', status: 'open',
      satisfied: 1, required: 2,
      inputs: [
        { inputRef: 'plan', producerNodeId: 'plan', state: 'supplied_reused' },
        { inputRef: 'review', producerNodeId: 'engine_start', state: 'pending' },
      ],
    },
    progress: {
      total: 2, completed: 1, queued: 0, executing: 0, waiting: 0,
      blocked: 1, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
      frontierNodeIds: ['implement'], activeNodeIds: [],
    },
    feedbackRounds: [
      {
        requesterNodeId: 'plan',
        status: 'open',
        joinMode: 'all',
        required: 2,
        responded: 1,
      },
    ],
    childRuns: [{ status: 'running' }],
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
      'workflow_graph_gates_truncated',
      'workflow_graph_child_runs_truncated',
    ]);
  });

  it('accepts a bounded successful graph result with graph details', () => {
    expect(parseWorkflowGraphResult(valid)).toEqual(valid);
  });

  it('accepts only closed bounded title and decision-gate summaries', () => {
    const decisionResult: WorkflowGraphResult = {
      type: 'workflowGraphResult',
      requestId: 'decision-request',
      taskId: 'decision-task',
      ok: true,
      graph: {
        runStatus: 'running',
        nodes: [{
          nodeId: 'repair',
          title: 'Review route',
          workflowNodeStatus: 'active',
          executionActivity: 'queued',
          displayState: 'queued',
          progressBucket: 'queued',
          decisionGate: 'required',
          decision: { status: 'correcting', attempt: 2, maxAttempts: 3 },
          reused: false,
        }],
        edges: [],
        gates: [],
        progress: {
          total: 1, completed: 0, queued: 1, executing: 0, waiting: 0,
          blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
          frontierNodeIds: ['repair'], activeNodeIds: [],
        },
        feedbackRounds: [],
        childRuns: [],
        reuse: { nodeCount: 0, edgeCount: 0 },
        diagnostics: [],
      },
    };
    expect(parseWorkflowGraphResult(decisionResult)).toEqual(decisionResult);

    const node = decisionResult.graph.nodes[0]!;
    for (const invalidNode of [
      { ...node, title: 'x'.repeat(201) },
      { ...node, title: 'unsafe\0title' },
      { ...node, decisionGate: 'hidden' },
      { ...node, decision: { status: 'correcting', attempt: 0, maxAttempts: 3 } },
      { ...node, decision: { status: 'correcting', attempt: 2, maxAttempts: 4 } },
      { ...node, decision: { status: 'private-response', attempt: 2, maxAttempts: 3 } },
      { ...node, decision: { status: 'correcting', attempt: 2, maxAttempts: 3, response: 'secret' } },
      { ...node, decisionGate: 'optional', decision: { status: 'waiting', attempt: 1, maxAttempts: 3 } },
      { ...node, decision: { status: 'waiting', attempt: 2, maxAttempts: 3 } },
      { ...node, decision: { status: 'exhausted', attempt: 3, maxAttempts: 3 } },
    ]) {
      expect(parseWorkflowGraphResult({
        ...decisionResult,
        graph: { ...decisionResult.graph, nodes: [invalidNode] },
      })).toBeNull();
    }
    expect(parseWorkflowGraphResult({
      ...decisionResult,
      graph: {
        ...decisionResult.graph,
        nodes: [{ ...node, decisionGate: undefined }],
      },
    })).toBeNull();
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
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          runStatus: 'workspace:/private/repository.sqlite',
          nodes: valid.graph.nodes.map((node) => node.nodeId === 'implement'
            ? {
                ...node,
                displayState: 'not_started',
                progressBucket: 'not_started',
                reason: 'run_closed_before_activation',
              }
            : node),
          progress: {
            ...valid.graph.progress,
            blocked: 0,
            notStarted: 1,
            frontierNodeIds: [],
          },
        },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          nodes: valid.graph.nodes.map((node) => node.nodeId === 'implement'
            ? { ...node, workflowNodeStatus: 'secret-backed-status' }
            : node),
        },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          gates: [{ ...valid.graph.gates[0], status: 'database:/private/repository.sqlite' }],
          activeGate: { ...valid.graph.activeGate!, status: 'database:/private/repository.sqlite' },
        },
      }),
    ).toBeNull();
  });

  it('rejects graph records with missing or extra keys', () => {
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, nodes: [{ ...valid.graph.nodes[0], taskId: 'x' }] },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, edges: [{ fromNodeId: 'plan', toNodeId: 'implement', reused: true }] },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          gates: [{ ...valid.graph.gates[0], consumerNodeId: undefined }],
        },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          gates: [{ ...valid.graph.gates[0], satisfied: 2 }],
        },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, progress: { ...valid.graph.progress, completed: 2 } },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          nodes: valid.graph.nodes.map((node) => node.nodeId === 'implement'
            ? {
                nodeId: node.nodeId,
                workflowNodeStatus: node.workflowNodeStatus,
                executionActivity: 'executing',
                displayState: 'completed',
                progressBucket: 'completed',
                reused: node.reused,
              }
            : node),
          progress: {
            ...valid.graph.progress,
            completed: 2,
            blocked: 0,
            frontierNodeIds: [],
            activeNodeIds: [],
          },
        },
      }),
    ).toBeNull();
  });

  it('rejects every durable orchestration identity at the webview boundary', () => {
    for (const graph of [
      { ...valid.graph, runId: 'wfr_private' },
      {
        ...valid.graph,
        gates: [{ ...valid.graph.gates[0], gateId: 'wfg_private' }],
      },
      {
        ...valid.graph,
        activeGate: { ...valid.graph.activeGate!, gateId: 'wfg_private' },
      },
      {
        ...valid.graph,
        feedbackRounds: [{ ...valid.graph.feedbackRounds[0], roundId: 'wfbr_private' }],
      },
      {
        ...valid.graph,
        childRuns: [{ ...valid.graph.childRuns[0], runId: 'wfr_child_private' }],
      },
    ]) {
      expect(parseWorkflowGraphResult({ ...valid, graph })).toBeNull();
    }
  });

  it('rejects over-bound gate and input collections', () => {
    const { activeGate: _activeGate, ...graphWithoutActiveGate } = valid.graph;
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: { ...valid.graph, gates: Array.from({ length: 129 }, () => valid.graph.gates[0]) },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          gates: [{
            ...valid.graph.gates[0],
            required: 129,
            inputs: Array.from({ length: 129 }, (_, index) => ({
              inputRef: `input-${index}`,
              producerNodeId: `producer-${index}`,
              state: 'pending',
            })),
          }],
        },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...graphWithoutActiveGate,
          edges: [],
          gates: Array.from({ length: 65 }, (_, index) => ({
            consumerNodeId: 'implement',
            status: 'consumed',
            satisfied: 0,
            required: 0,
            inputs: [],
          })),
          reuse: { nodeCount: 1, edgeCount: 0 },
        },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...graphWithoutActiveGate,
          edges: [],
          gates: [{
            consumerNodeId: 'implement',
            status: 'open',
            satisfied: 0,
            required: 65,
            inputs: Array.from({ length: 65 }, (_, index) => ({
              inputRef: `input-${index}`,
              producerNodeId: 'engine_start',
              state: 'pending',
            })),
          }],
          reuse: { nodeCount: 1, edgeCount: 0 },
        },
      }),
    ).toBeNull();
  });

  it('rejects reused nodes that claim live execution', () => {
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          nodes: valid.graph.nodes.map((node) => node.nodeId === 'plan'
            ? {
                ...node,
                executionActivity: 'executing',
                displayState: 'executing',
                progressBucket: 'executing',
              }
            : node),
          progress: {
            ...valid.graph.progress,
            completed: 0,
            executing: 1,
            frontierNodeIds: ['plan', 'implement'],
            activeNodeIds: ['plan'],
          },
        },
      }),
    ).toBeNull();
  });

  it('keeps terminal workflow-node truth authoritative over lagging execution activity', () => {
    const terminalWithLiveActivity: WorkflowGraphResult = {
      type: 'workflowGraphResult',
      requestId: 'terminal-live-activity',
      taskId: 'terminal-task',
      ok: true,
      graph: {
        runStatus: 'failed',
        nodes: [{
          nodeId: 'worker',
          workflowNodeStatus: 'failed',
          executionActivity: 'executing',
          displayState: 'failed',
          progressBucket: 'failed',
          reused: false,
        }],
        edges: [],
        gates: [],
        progress: {
          total: 1, completed: 0, queued: 0, executing: 0, waiting: 0,
          blocked: 0, notStarted: 0, failed: 1, cancelled: 0, skipped: 0,
          frontierNodeIds: [], activeNodeIds: [],
        },
        feedbackRounds: [],
        childRuns: [],
        reuse: { nodeCount: 0, edgeCount: 0 },
        diagnostics: [],
      },
    };
    expect(parseWorkflowGraphResult(terminalWithLiveActivity)).toEqual(terminalWithLiveActivity);
    expect(parseWorkflowGraphResult({
      ...terminalWithLiveActivity,
      graph: {
        ...terminalWithLiveActivity.graph,
        nodes: [{
          ...terminalWithLiveActivity.graph.nodes[0],
          displayState: 'executing',
          progressBucket: 'executing',
        }],
        progress: {
          ...terminalWithLiveActivity.graph.progress,
          executing: 1,
          failed: 0,
          frontierNodeIds: ['worker'],
          activeNodeIds: ['worker'],
        },
      },
    })).toBeNull();
  });

  it('reconciles gate lifecycle status with durable fill counts', () => {
    for (const status of ['satisfied', 'consumed'] as const) {
      expect(
        parseWorkflowGraphResult({
          ...valid,
          graph: {
            ...valid.graph,
            gates: [{ ...valid.graph.gates[0], status }],
            activeGate: { ...valid.graph.activeGate!, status },
          },
        }),
      ).toBeNull();
    }
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          gates: [{
            ...valid.graph.gates[0],
            status: 'open',
            satisfied: 2,
            inputs: valid.graph.gates[0].inputs.map((input) => ({
              ...input,
              state: input.producerNodeId === 'plan' ? 'supplied_reused' : 'supplied_live',
            })),
          }],
          activeGate: {
            ...valid.graph.activeGate!,
            status: 'open',
            satisfied: 2,
            inputs: valid.graph.activeGate!.inputs.map((input) => ({
              ...input,
              state: input.producerNodeId === 'plan' ? 'supplied_reused' : 'supplied_live',
            })),
          },
        },
      }),
    ).toBeNull();
  });

  it('reconciles feedback lifecycle status with response counts', () => {
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        feedbackRounds: [{
          ...valid.graph.feedbackRounds[0],
          status: 'satisfied',
        }],
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        feedbackRounds: [{
          ...valid.graph.feedbackRounds[0],
          status: 'open',
          responded: 2,
        }],
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        feedbackRounds: [{
          ...valid.graph.feedbackRounds[0],
          required: 65,
        }],
      },
    })).toBeNull();
  });

  it('ties blocked node display to exactly one incomplete consumer gate', () => {
    const { activeGate: _activeGate, ...graphWithoutActiveGate } = valid.graph;
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...graphWithoutActiveGate,
        edges: [],
        gates: [],
        reuse: { nodeCount: 1, edgeCount: 0 },
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        nodes: valid.graph.nodes.map((node) => {
          if (node.nodeId !== 'implement') return node;
          const { reason: _reason, ...nodeWithoutReason } = node;
          return {
            ...nodeWithoutReason,
            displayState: 'not_started',
            progressBucket: 'not_started',
          };
        }),
        progress: {
          ...valid.graph.progress,
          blocked: 0,
          notStarted: 1,
          frontierNodeIds: [],
        },
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
          gates: [
            valid.graph.gates[0],
            {
              consumerNodeId: 'implement',
            status: 'open',
            satisfied: 0,
            required: 1,
            inputs: [{ inputRef: 'entry', producerNodeId: 'engine_start', state: 'pending' }],
          },
        ],
      },
    })).toBeNull();
  });

  it('rejects engine-start inputs that falsely claim reuse', () => {
    const suppliedInputs = valid.graph.gates[0].inputs.map((input) => input.producerNodeId === 'engine_start'
      ? { ...input, state: 'supplied_reused' as const }
      : input);
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        gates: [{
          ...valid.graph.gates[0],
          status: 'satisfied',
          satisfied: 2,
          inputs: suppliedInputs,
        }],
        activeGate: {
          ...valid.graph.activeGate!,
          status: 'satisfied',
          satisfied: 2,
          inputs: suppliedInputs,
        },
      },
    })).toBeNull();

    const actualEngineStartProducer: WorkflowGraphResult = {
      type: 'workflowGraphResult',
      requestId: 'actual-engine-start-node',
      taskId: 'task-engine-start-node',
      ok: true,
      graph: {
        runStatus: 'running',
        nodes: [
          {
            nodeId: 'engine_start', workflowNodeStatus: 'reused', executionActivity: 'none',
            displayState: 'reused', progressBucket: 'completed', reused: true,
          },
          {
            nodeId: 'consumer', workflowNodeStatus: 'active', executionActivity: 'queued',
            displayState: 'queued', progressBucket: 'queued', reused: false,
          },
        ],
        edges: [{
          fromNodeId: 'engine_start', toNodeId: 'consumer', inputRef: 'source',
          contributionState: 'supplied_reused', reused: true,
        }],
        gates: [{
          consumerNodeId: 'consumer', status: 'satisfied',
          satisfied: 1, required: 1,
          inputs: [{ inputRef: 'source', producerNodeId: 'engine_start', state: 'supplied_reused' }],
        }],
        progress: {
          total: 2, completed: 1, queued: 1, executing: 0, waiting: 0,
          blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
          frontierNodeIds: ['consumer'], activeNodeIds: [],
        },
        feedbackRounds: [],
        childRuns: [],
        reuse: { nodeCount: 1, edgeCount: 1 },
        diagnostics: [],
      },
    };
    expect(parseWorkflowGraphResult(actualEngineStartProducer)).toEqual(actualEngineStartProducer);
  });

  it('rejects unknown feedback-round status and join mode', () => {
    const feedbackRound = valid.graph.feedbackRounds[0];
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        feedbackRounds: [{ ...feedbackRound, status: 'secret-status' }],
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        feedbackRounds: [{ ...feedbackRound, joinMode: 'private-mode' }],
      },
    })).toBeNull();
  });

  it('rejects edges with omitted endpoints and duplicate durable gate identities', () => {
    const { activeGate: _activeGate, ...graphWithoutActiveGate } = valid.graph;
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...graphWithoutActiveGate,
          edges: [{
            ...valid.graph.edges[0],
            fromNodeId: 'omitted-producer',
            contributionState: 'supplied_live',
            reused: false,
          }],
          gates: [{
            ...valid.graph.gates[0],
            inputs: valid.graph.gates[0].inputs.map((input) => input.inputRef === 'plan'
              ? { ...input, producerNodeId: 'omitted-producer', state: 'supplied_live' }
              : input),
          }],
        },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...valid.graph,
          gates: [valid.graph.gates[0], valid.graph.gates[0]],
        },
      }),
    ).toBeNull();
    expect(
      parseWorkflowGraphResult({
        ...valid,
        graph: {
          ...graphWithoutActiveGate,
          gates: [{
            ...valid.graph.gates[0],
            inputs: [
              valid.graph.gates[0].inputs[0],
              { ...valid.graph.gates[0].inputs[1], inputRef: valid.graph.gates[0].inputs[0].inputRef },
            ],
          }],
        },
      }),
    ).toBeNull();
  });

  it('rejects duplicate or incomplete graph identities and reuse contributions', () => {
    const { activeGate: _activeGate, ...graphWithoutActiveGate } = valid.graph;
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        edges: [valid.graph.edges[0], valid.graph.edges[0]],
        reuse: { nodeCount: 1, edgeCount: 2 },
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...graphWithoutActiveGate,
        gates: [{
          ...valid.graph.gates[0],
          inputs: valid.graph.gates[0].inputs.map((input) => input.inputRef === 'review'
            ? { ...input, producerNodeId: 'omitted-producer' }
            : input),
        }],
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        feedbackRounds: [{ ...valid.graph.feedbackRounds[0], requesterNodeId: 'omitted-requester' }],
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        feedbackRounds: [valid.graph.feedbackRounds[0], valid.graph.feedbackRounds[0]],
      },
    })).not.toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        childRuns: [valid.graph.childRuns[0], valid.graph.childRuns[0]],
      },
    })).not.toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        edges: [{ ...valid.graph.edges[0], contributionState: 'supplied_live' }],
        gates: [{
          ...valid.graph.gates[0],
          inputs: valid.graph.gates[0].inputs.map((input) => input.inputRef === 'plan'
            ? { ...input, state: 'supplied_live' }
            : input),
        }],
        activeGate: {
          ...valid.graph.activeGate!,
          inputs: valid.graph.activeGate!.inputs.map((input) => input.inputRef === 'plan'
            ? { ...input, state: 'supplied_live' }
            : input),
        },
      },
    })).toBeNull();
  });

  it('accepts the validated maximum gate and per-gate input matrix', () => {
    const nodeIds = Array.from({ length: 64 }, (_, index) => `node-${index}`);
    const nodes = nodeIds.map((nodeId) => ({
      nodeId,
      workflowNodeStatus: 'pending' as const,
      executionActivity: 'none' as const,
      displayState: 'blocked' as const,
      progressBucket: 'blocked' as const,
      reason: 'waiting_for_inputs' as const,
      reused: false,
    }));
    const gates = nodeIds.map((consumerNodeId, gateIndex) => ({
      consumerNodeId,
      status: 'open' as const,
      satisfied: 0,
      required: 64,
      inputs: Array.from({ length: 64 }, (_, inputIndex) => ({
        inputRef: `input-${inputIndex}`,
        producerNodeId: 'engine_start',
        state: 'pending' as const,
      })),
    }));
    const result: WorkflowGraphResult = {
      type: 'workflowGraphResult',
      requestId: 'max-gates',
      taskId: 'task-max-gates',
      ok: true,
      graph: {
        runStatus: 'running',
        nodes,
        edges: [],
        gates,
        progress: {
          total: 64, completed: 0, queued: 0, executing: 0, waiting: 0,
          blocked: 64, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
          frontierNodeIds: nodeIds, activeNodeIds: [],
        },
        feedbackRounds: [],
        childRuns: [],
        reuse: { nodeCount: 0, edgeCount: 0 },
        diagnostics: [],
      },
    };
    expect(parseWorkflowGraphResult(result)).toEqual(result);
  });

  it('rejects every exact collection boundary plus one', () => {
    const { activeGate: _activeGate, ...graphWithoutActiveGate } = valid.graph;
    const blockedNode = (nodeId: string) => ({
      nodeId,
      workflowNodeStatus: 'pending' as const,
      executionActivity: 'none' as const,
      displayState: 'blocked' as const,
      progressBucket: 'blocked' as const,
      reason: 'waiting_for_inputs' as const,
      reused: false,
    });
    const nodeIds = Array.from({ length: 64 }, (_, index) => `bounded-node-${index}`);
    const nodes = nodeIds.map(blockedNode);
    const edges = nodeIds.flatMap((toNodeId, index) => [0, 1].map((inputIndex) => ({
      fromNodeId: nodeIds[(index * 2 + inputIndex) % nodeIds.length],
      toNodeId,
      inputRef: `input-${inputIndex}`,
      contributionState: 'pending' as const,
      reused: false,
    })));
    const gates = nodeIds.map((consumerNodeId, index) => ({
      consumerNodeId,
      status: 'open' as const,
      satisfied: 0,
      required: 2,
      inputs: edges.slice(index * 2, index * 2 + 2).map((edge) => ({
        inputRef: edge.inputRef,
        producerNodeId: edge.fromNodeId,
        state: 'pending' as const,
      })),
    }));
    const boundedGraph = {
      ...graphWithoutActiveGate,
      nodes,
      edges,
      gates,
      progress: {
        total: 64, completed: 0, queued: 0, executing: 0, waiting: 0,
        blocked: 64, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
        frontierNodeIds: nodeIds, activeNodeIds: [],
      },
      feedbackRounds: [],
      childRuns: [],
      reuse: { nodeCount: 0, edgeCount: 0 },
      diagnostics: [],
    };
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...boundedGraph,
        nodes: [...nodes, blockedNode('bounded-node-65')],
        progress: { ...boundedGraph.progress, total: 65, blocked: 65, frontierNodeIds: [...nodeIds, 'bounded-node-65'] },
      },
    })).toBeNull();
    const extraEdge = {
      fromNodeId: nodeIds[2], toNodeId: nodeIds[0], inputRef: 'input-2',
      contributionState: 'pending' as const, reused: false,
    };
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...boundedGraph,
        edges: [...edges, extraEdge],
        gates: gates.map((gate, index) => index === 0
          ? {
              ...gate,
              required: 3,
              inputs: [...gate.inputs, {
                inputRef: extraEdge.inputRef,
                producerNodeId: extraEdge.fromNodeId,
                state: extraEdge.contributionState,
              }],
            }
          : gate),
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        feedbackRounds: Array.from({ length: 33 }, (_, index) => ({
          requesterNodeId: 'plan',
          status: 'open',
          joinMode: 'all',
          required: 2,
          responded: 1,
        })),
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        childRuns: Array.from({ length: 65 }, () => ({
          status: 'running',
        })),
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...valid.graph,
        diagnostics: Array.from({ length: 9 }, () => ({
          code: 'workflow_graph_nodes_truncated',
        })),
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...boundedGraph,
        progress: {
          ...boundedGraph.progress,
          frontierNodeIds: [...nodeIds, nodeIds[0]],
        },
      },
    })).toBeNull();
    expect(parseWorkflowGraphResult({
      ...valid,
      graph: {
        ...boundedGraph,
        progress: {
          ...boundedGraph.progress,
          activeNodeIds: Array.from({ length: 65 }, () => nodeIds[0]),
        },
      },
    })).toBeNull();
  });
});
