/**
 * DAG layout for workflow graph (M024/S05 modal).
 * Pure function, no DOM dependency — layered (Sugiyama-style) longest-path layering.
 */
import type { WorkflowGraphWireGraph } from '../../../src/shared/workflow-graph-wire';

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  layer: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  reused: boolean;
  fromPos: { x: number; y: number };
  toPos: { x: number; y: number };
  path: string;
}

export interface WorkflowGraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

const NODE_W = 148;
const NODE_H = 44;
const X_GAP = 72;
const Y_GAP = 24;
const PADDING = 24;

export function computeWorkflowGraphLayout(graph: WorkflowGraphWireGraph): WorkflowGraphLayout {
  const nodes = graph.nodes;
  const edges = graph.edges;

  // Build adjacency + inDegree
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.nodeId, []);
    inDegree.set(n.nodeId, 0);
  }
  for (const e of edges) {
    if (!adj.has(e.fromNodeId) || !adj.has(e.toNodeId)) continue;
    adj.get(e.fromNodeId)!.push(e.toNodeId);
    inDegree.set(e.toNodeId, (inDegree.get(e.toNodeId) ?? 0) + 1);
  }

  // Longest-path layering via Kahn
  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      layer.set(id, 0);
    }
  }
  // Need mutable inDegree copy
  const indegCopy = new Map(inDegree);
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    const currLayer = layer.get(id) ?? 0;
    for (const nxt of adj.get(id) ?? []) {
      const existing = layer.get(nxt) ?? 0;
      layer.set(nxt, Math.max(existing, currLayer + 1));
      const nd = (indegCopy.get(nxt) ?? 1) - 1;
      indegCopy.set(nxt, nd);
      if (nd === 0) queue.push(nxt);
    }
  }
  // Unvisited nodes (cycles or disconnected) — put in layer 0
  for (const n of nodes) if (!layer.has(n.nodeId)) layer.set(n.nodeId, 0);

  const maxLayer = Math.max(0, ...Array.from(layer.values()));
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) {
    const l = layer.get(n.nodeId)!;
    layers[l].push(n.nodeId);
  }
  // Stable order: by original nodes order
  const orderIdx = new Map(nodes.map((n, i) => [n.nodeId, i] as const));
  for (const l of layers) l.sort((a, b) => (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0));

  const maxCount = Math.max(1, ...layers.map((l) => l.length));
  const totalHeight = maxCount * NODE_H + (maxCount - 1) * Y_GAP;

  const positions = new Map<string, { x: number; y: number }>();
  const layoutNodes: LayoutNode[] = [];
  for (let li = 0; li < layers.length; li++) {
    const ids = layers[li];
    const layerHeight = ids.length * NODE_H + Math.max(0, ids.length - 1) * Y_GAP;
    const yOffset = PADDING + (totalHeight - layerHeight) / 2;
    const x = PADDING + li * (NODE_W + X_GAP);
    for (let j = 0; j < ids.length; j++) {
      const id = ids[j];
      const y = yOffset + j * (NODE_H + Y_GAP);
      positions.set(id, { x, y });
      layoutNodes.push({ id, x, y, layer: li });
    }
  }
  // Deterministic order by node id for tests
  layoutNodes.sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0));

  const width = PADDING * 2 + layers.length * NODE_W + Math.max(0, layers.length - 1) * X_GAP;
  const height = PADDING * 2 + totalHeight;

  const layoutEdges: LayoutEdge[] = [];
  for (const e of edges) {
    const fromPos = positions.get(e.fromNodeId);
    const toPos = positions.get(e.toNodeId);
    if (!fromPos || !toPos) continue;
    const sx = fromPos.x + NODE_W;
    const sy = fromPos.y + NODE_H / 2;
    const tx = toPos.x;
    const ty = toPos.y + NODE_H / 2;
    const cx1 = sx + X_GAP / 2;
    const cx2 = tx - X_GAP / 2;
    // Cubic bezier for smooth horizontal flow
    const path = `M ${sx} ${sy} C ${cx1} ${sy}, ${cx2} ${ty}, ${tx} ${ty}`;
    layoutEdges.push({
      from: e.fromNodeId,
      to: e.toNodeId,
      reused: e.reused,
      fromPos: { x: sx, y: sy },
      toPos: { x: tx, y: ty },
      path,
    });
  }

  return { nodes: layoutNodes, edges: layoutEdges, width, height };
}

export const LAYOUT_NODE_W = NODE_W;
export const LAYOUT_NODE_H = NODE_H;
