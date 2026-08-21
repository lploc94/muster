import { describe, expect, it } from 'vitest';
import type { WorkflowGraphWireGraph } from '../../../src/shared/workflow-graph-wire';
import {
  WORKFLOW_GRAPH_FIT_MAX_SCALE,
  WORKFLOW_GRAPH_FIT_MIN_SCALE,
  computeWorkflowGraphFit,
  computeWorkflowGraphLayout,
  decreaseWorkflowGraphScale,
} from './workflow-graph-layout';

function chainGraph(count: number): WorkflowGraphWireGraph {
  const nodeIds = Array.from({ length: count }, (_, index) => `node-${index}`);
  return {
    runId: `run-${count}`,
    runStatus: 'running',
    nodes: nodeIds.map((nodeId) => ({
      nodeId,
      workflowNodeStatus: 'active',
      executionActivity: 'queued',
      displayState: 'queued',
      progressBucket: 'queued',
      reused: false,
    })),
    edges: nodeIds.slice(1).map((toNodeId, index) => ({
      fromNodeId: nodeIds[index],
      toNodeId,
      inputRef: 'source',
      contributionState: 'pending',
      reused: false,
    })),
    gates: [],
    progress: {
      total: count, completed: 0, queued: count, executing: 0, waiting: 0,
      blocked: 0, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
      frontierNodeIds: nodeIds, activeNodeIds: [],
    },
    feedbackRounds: [], childRuns: [], reuse: { nodeCount: 0, edgeCount: 0 }, diagnostics: [],
  };
}

describe('workflow graph layout and fit', () => {
  it('lays out a five-node chain in deterministic layers and fits a narrow viewport', () => {
    const layout = computeWorkflowGraphLayout(chainGraph(5));
    expect(layout.nodes.map((node) => node.layer)).toEqual([0, 1, 2, 3, 4]);
    expect(layout.edges).toHaveLength(4);

    const fit = computeWorkflowGraphFit(layout, { width: 320, height: 240 });
    expect(fit.scale).toBeLessThan(1);
    expect(fit.x).toBeGreaterThanOrEqual(0);
    expect(fit.y).toBeGreaterThanOrEqual(0);
    expect(layout.width * fit.scale).toBeLessThanOrEqual(288);
    expect(layout.height * fit.scale).toBeLessThanOrEqual(208);
  });

  it('keeps multi-entry fan-in layering stable', () => {
    const graph = chainGraph(4);
    graph.edges = [
      { fromNodeId: 'node-0', toNodeId: 'node-2', inputRef: 'a', contributionState: 'pending', reused: false },
      { fromNodeId: 'node-1', toNodeId: 'node-2', inputRef: 'b', contributionState: 'pending', reused: false },
      { fromNodeId: 'node-2', toNodeId: 'node-3', inputRef: 'result', contributionState: 'pending', reused: false },
    ];
    expect(computeWorkflowGraphLayout(graph).nodes.map(({ id, layer }) => [id, layer])).toEqual([
      ['node-0', 0], ['node-1', 0], ['node-2', 1], ['node-3', 2],
    ]);
  });

  it('fits the maximum bounded chain and clamps tiny and oversized transforms', () => {
    const maximum = computeWorkflowGraphLayout(chainGraph(64));
    const fit = computeWorkflowGraphFit(maximum, { width: 800, height: 500 });
    expect(fit.scale).toBeGreaterThanOrEqual(WORKFLOW_GRAPH_FIT_MIN_SCALE);
    expect(maximum.width * fit.scale).toBeLessThanOrEqual(768);
    expect(maximum.height * fit.scale).toBeLessThanOrEqual(468);

    const narrowFit = computeWorkflowGraphFit(maximum, { width: 320, height: 240 });
    expect(narrowFit.scale).toBeGreaterThanOrEqual(WORKFLOW_GRAPH_FIT_MIN_SCALE);
    expect(narrowFit.x).toBeGreaterThanOrEqual(0);
    expect(narrowFit.y).toBeGreaterThanOrEqual(0);
    expect(maximum.width * narrowFit.scale).toBeLessThanOrEqual(288);
    expect(maximum.height * narrowFit.scale).toBeLessThanOrEqual(208);
    expect(decreaseWorkflowGraphScale(narrowFit.scale, 0.15)).toBe(narrowFit.scale);
    expect(decreaseWorkflowGraphScale(0.2, 0.15)).toBe(0.05);
    expect(decreaseWorkflowGraphScale(0.06, 0.08)).toBe(0.05);

    const enlarged = computeWorkflowGraphFit(computeWorkflowGraphLayout(chainGraph(1)), {
      width: 4000,
      height: 3000,
    });
    expect(enlarged.scale).toBe(WORKFLOW_GRAPH_FIT_MAX_SCALE);

    const invalid = computeWorkflowGraphFit(maximum, { width: 0, height: Number.NaN });
    expect(invalid).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('recomputes a smaller scale when the viewport narrows', () => {
    const layout = computeWorkflowGraphLayout(chainGraph(5));
    const wide = computeWorkflowGraphFit(layout, { width: 900, height: 400 });
    const narrow = computeWorkflowGraphFit(layout, { width: 360, height: 400 });
    expect(narrow.scale).toBeLessThan(wide.scale);
  });
});
