/**
 * Pure helpers for owning-root task tree UI (nav chrome + panel rows).
 */

import type { TaskRuntimeActivity, TaskSummary } from './protocol';

export interface TaskTreeNode {
  task: TaskSummary;
  depth: number;
  children: TaskTreeNode[];
}

export interface TaskTreeCounts {
  total: number;
  active: number;
  needYou: number;
}

const ATTENTION_ACTIVITIES = new Set<string>([
  'waiting_user',
  'needs_recovery',
  'awaiting_outcome',
]);

/** Local mirror of host effective activity — pure, no vscode import. */
function activityOf(
  task: Pick<TaskSummary, 'lifecycle' | 'runtimeActivity' | 'viewStatus'>,
): TaskRuntimeActivity | null {
  if (task.lifecycle !== 'open') return null;
  if (task.runtimeActivity !== undefined) return task.runtimeActivity;
  const vs = task.viewStatus;
  if (
    vs === 'waiting_dependencies' ||
    vs === 'queued' ||
    vs === 'running' ||
    vs === 'waiting_user' ||
    vs === 'waiting_children' ||
    vs === 'blocked' ||
    vs === 'needs_recovery' ||
    vs === 'idle' ||
    vs === 'awaiting_outcome'
  ) {
    return vs;
  }
  return 'idle';
}

/** Open + running. */
export function isTaskTreeActive(task: TaskSummary): boolean {
  return activityOf(task) === 'running';
}

/** Open + user-actionable runtime activities (locked plan set). */
export function isTaskTreeNeedYou(task: TaskSummary): boolean {
  const activity = activityOf(task);
  return activity !== null && ATTENTION_ACTIVITIES.has(activity);
}

export function countTaskTree(tasks: readonly TaskSummary[]): TaskTreeCounts {
  let active = 0;
  let needYou = 0;
  for (const task of tasks) {
    if (isTaskTreeActive(task)) active += 1;
    if (isTaskTreeNeedYou(task)) needYou += 1;
  }
  return { total: tasks.length, active, needYou };
}

/** One-line summary for nav chrome. */
export function formatTaskTreeSummary(counts: TaskTreeCounts): string {
  const parts = [`Tasks ${counts.total}`];
  if (counts.active > 0) parts.push(`${counts.active} active`);
  if (counts.needYou > 0) parts.push(`${counts.needYou} need you`);
  return parts.join(' · ');
}

/**
 * Build indented forest from flat owning-root summaries.
 * Prefer host DFS order when present; orphan nodes (missing parent in set) attach at depth 0.
 */
export function buildTaskTree(nodes: readonly TaskSummary[]): TaskTreeNode[] {
  if (nodes.length === 0) return [];

  const byId = new Map(nodes.map((t) => [t.id, t]));
  const childMap = new Map<string, TaskSummary[]>();
  for (const task of nodes) {
    if (task.parentId && byId.has(task.parentId)) {
      const list = childMap.get(task.parentId) ?? [];
      list.push(task);
      childMap.set(task.parentId, list);
    }
  }

  // Preserve relative order from input array among siblings.
  const order = new Map(nodes.map((t, i) => [t.id, i]));
  for (const [, list] of childMap) {
    list.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  const roots = nodes.filter((t) => !t.parentId || !byId.has(t.parentId));
  roots.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const walk = (task: TaskSummary, depth: number): TaskTreeNode => ({
    task,
    depth,
    children: (childMap.get(task.id) ?? []).map((child) => walk(child, depth + 1)),
  });

  return roots.map((r) => walk(r, 0));
}

/** Flatten tree for list rendering (DFS). */
export function flattenTaskTree(roots: readonly TaskTreeNode[]): TaskTreeNode[] {
  const out: TaskTreeNode[] = [];
  const visit = (node: TaskTreeNode) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

export function parentSummary(
  focused: TaskSummary,
  subtree: readonly TaskSummary[],
): TaskSummary | undefined {
  if (!focused.parentId) return undefined;
  return subtree.find((t) => t.id === focused.parentId) ?? undefined;
}

/** Ancestor chain root→…→focused (inclusive) for breadcrumb chrome. */
export function breadcrumbPath(
  focused: TaskSummary,
  subtree: readonly TaskSummary[],
): TaskSummary[] {
  const byId = new Map(subtree.map((t) => [t.id, t]));
  const chain: TaskSummary[] = [];
  let current: TaskSummary | undefined = focused;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

/** Compact breadcrumb labels when path is long: first, …, last two. */
export function compactBreadcrumb(
  path: readonly TaskSummary[],
  maxNodes = 3,
): Array<{ task: TaskSummary; ellipsisBefore: boolean }> {
  if (path.length <= maxNodes) {
    return path.map((task) => ({ task, ellipsisBefore: false }));
  }
  const head = path[0]!;
  const tail = path.slice(-(maxNodes - 1));
  return [
    { task: head, ellipsisBefore: false },
    ...tail.map((task, i) => ({ task, ellipsisBefore: i === 0 })),
  ];
}

/** Codicon class for task role (I3). */
export function taskRoleIcon(role: TaskSummary['role'] | string | undefined): string {
  if (role === 'coordinator') return 'codicon-type-hierarchy-sub';
  return 'codicon-tools';
}

/**
 * Flatten with optional collapsed set: descendants of collapsed ids are hidden.
 * Collapse only applies to nodes that have children.
 */
export function flattenTaskTreeCollapsible(
  roots: readonly TaskTreeNode[],
  collapsedIds: ReadonlySet<string>,
): TaskTreeNode[] {
  const out: TaskTreeNode[] = [];
  const visit = (node: TaskTreeNode) => {
    out.push(node);
    if (node.children.length > 0 && collapsedIds.has(node.task.id)) {
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/** Default collapsed: all nodes deeper than maxExpandedDepth that have children. */
export function defaultCollapsedIds(
  roots: readonly TaskTreeNode[],
  maxExpandedDepth = 2,
): Set<string> {
  const collapsed = new Set<string>();
  const visit = (node: TaskTreeNode) => {
    if (node.children.length > 0 && node.depth >= maxExpandedDepth) {
      collapsed.add(node.task.id);
    }
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return collapsed;
}

/**
 * Ensure focused task remains visible: expand every ancestor on the path
 * (remove from collapsed set). Does not force-expand siblings.
 */
export function expandPathInCollapsed(
  collapsed: ReadonlySet<string>,
  path: readonly TaskSummary[],
): Set<string> {
  const next = new Set(collapsed);
  for (const node of path) {
    next.delete(node.id);
  }
  return next;
}
