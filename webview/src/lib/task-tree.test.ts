import { describe, expect, it } from 'vitest';
import type { TaskSummary } from './protocol';
import {
  breadcrumbPath,
  buildTaskTree,
  compactBreadcrumb,
  countTaskTree,
  defaultCollapsedIds,
  flattenTaskTree,
  expandPathInCollapsed,
  flattenTaskTreeCollapsible,
  formatTaskTreeSummary,
  isTaskTreeActive,
  isTaskTreeNeedYou,
  owningRootIdFromSubtree,
  parentSummary,
  shouldKeepTreeExpanded,
  showTaskNavFor,
  taskRoleIcon,
} from './task-tree';

function summary(partial: Partial<TaskSummary> & Pick<TaskSummary, 'id'>): TaskSummary {
  return {
    parentId: null,
    goal: partial.id,
    role: 'worker',
    lifecycle: 'open',
    runtimeActivity: 'idle',
    viewStatus: 'idle',
    currentTurnActivity: null,
    updatedAt: '2026-07-06T00:00:00.000Z',
    backend: 'fake',
    ...partial,
  };
}

describe('task-tree counts', () => {
  it('counts active and need-you with locked predicates', () => {
    const nodes = [
      summary({ id: 'r', role: 'coordinator', runtimeActivity: 'running', viewStatus: 'running' }),
      summary({ id: 'a', parentId: 'r', runtimeActivity: 'waiting_user', viewStatus: 'waiting_user' }),
      summary({ id: 'b', parentId: 'r', runtimeActivity: 'needs_recovery', viewStatus: 'needs_recovery' }),
      summary({ id: 'c', parentId: 'r', runtimeActivity: 'awaiting_outcome', viewStatus: 'awaiting_outcome' }),
      summary({ id: 'd', parentId: 'r', runtimeActivity: 'idle', viewStatus: 'idle' }),
      summary({ id: 'e', parentId: 'r', lifecycle: 'succeeded', runtimeActivity: null, viewStatus: 'succeeded' }),
      summary({ id: 'f', parentId: 'r', runtimeActivity: 'waiting_children', viewStatus: 'waiting_children' }),
    ];
    expect(isTaskTreeActive(nodes[0]!)).toBe(true);
    expect(isTaskTreeNeedYou(nodes[0]!)).toBe(false);
    expect(isTaskTreeNeedYou(nodes[1]!)).toBe(true);
    expect(isTaskTreeNeedYou(nodes[2]!)).toBe(true);
    expect(isTaskTreeNeedYou(nodes[3]!)).toBe(true);
    expect(isTaskTreeNeedYou(nodes[4]!)).toBe(false);
    expect(isTaskTreeNeedYou(nodes[5]!)).toBe(false);
    expect(isTaskTreeNeedYou(nodes[6]!)).toBe(false);

    const counts = countTaskTree(nodes);
    expect(counts).toEqual({ total: 7, active: 1, needYou: 3 });
    expect(formatTaskTreeSummary(counts)).toBe('Tasks 7 · 1 active · 3 need you');
    expect(formatTaskTreeSummary({ total: 2, active: 0, needYou: 0 })).toBe('Tasks 2');
  });
});

describe('buildTaskTree', () => {
  it('builds depth and preserves order for owning-root list', () => {
    const nodes = [
      summary({ id: 'root', role: 'coordinator' }),
      summary({ id: 'a', parentId: 'root' }),
      summary({ id: 'nested', parentId: 'a' }),
      summary({ id: 'b', parentId: 'root' }),
    ];
    const tree = buildTaskTree(nodes);
    expect(flattenTaskTree(tree).map((n) => [n.task.id, n.depth])).toEqual([
      ['root', 0],
      ['a', 1],
      ['nested', 2],
      ['b', 1],
    ]);
    expect(parentSummary(nodes[2]!, nodes)?.id).toBe('a');
  });

  it('builds breadcrumb root→focused and compacts long paths', () => {
    const nodes = [
      summary({ id: 'root', role: 'coordinator' }),
      summary({ id: 'a', parentId: 'root' }),
      summary({ id: 'b', parentId: 'a' }),
      summary({ id: 'c', parentId: 'b' }),
    ];
    const path = breadcrumbPath(nodes[3]!, nodes);
    expect(path.map((t) => t.id)).toEqual(['root', 'a', 'b', 'c']);
    const compact = compactBreadcrumb(path, 3);
    expect(compact.map((c) => [c.task.id, c.ellipsisBefore])).toEqual([
      ['root', false],
      ['b', true],
      ['c', false],
    ]);
  });

  it('collapses deep branches and maps role icons', () => {
    const nodes = [
      summary({ id: 'root', role: 'coordinator' }),
      summary({ id: 'a', parentId: 'root' }),
      summary({ id: 'nested', parentId: 'a' }),
      summary({ id: 'deep', parentId: 'nested' }),
    ];
    const tree = buildTaskTree(nodes);
    const collapsed = defaultCollapsedIds(tree, 1);
    expect(collapsed.has('a')).toBe(true);
    const flat = flattenTaskTreeCollapsible(tree, collapsed);
    expect(flat.map((n) => n.task.id)).toEqual(['root', 'a']);
    expect(taskRoleIcon('coordinator')).toBe('codicon-type-hierarchy-sub');
    expect(taskRoleIcon('worker')).toBe('codicon-tools');
  });

  it('expands ancestor path so focused deep node stays visible', () => {
    const nodes = [
      summary({ id: 'root', role: 'coordinator' }),
      summary({ id: 'a', parentId: 'root' }),
      summary({ id: 'nested', parentId: 'a' }),
      summary({ id: 'deep', parentId: 'nested' }),
    ];
    const tree = buildTaskTree(nodes);
    const collapsed = defaultCollapsedIds(tree, 1);
    const path = breadcrumbPath(nodes[3]!, nodes);
    const opened = expandPathInCollapsed(collapsed, path);
    const flat = flattenTaskTreeCollapsible(tree, opened);
    expect(flat.map((n) => n.task.id)).toContain('deep');
  });
});

describe('owning-root expand retention', () => {
  it('resolves owning root from parent links', () => {
    const nodes = [
      summary({ id: 'root', role: 'coordinator' }),
      summary({ id: 'a', parentId: 'root' }),
      summary({ id: 'nested', parentId: 'a' }),
    ];
    expect(owningRootIdFromSubtree('nested', nodes)).toBe('root');
    expect(owningRootIdFromSubtree('root', nodes)).toBe('root');
    expect(owningRootIdFromSubtree('missing', nodes)).toBeNull();
  });

  it('keeps expand only for same owning root', () => {
    expect(
      shouldKeepTreeExpanded({
        wasExpanded: true,
        previousOwningRootId: 'root-a',
        nextOwningRootId: 'root-a',
        nextShowTaskNav: true,
      }),
    ).toBe(true);
    expect(
      shouldKeepTreeExpanded({
        wasExpanded: true,
        previousOwningRootId: 'root-a',
        nextOwningRootId: 'root-b',
        nextShowTaskNav: true,
      }),
    ).toBe(false);
    expect(
      shouldKeepTreeExpanded({
        wasExpanded: true,
        previousOwningRootId: 'root-a',
        nextOwningRootId: 'root-a',
        nextShowTaskNav: false,
      }),
    ).toBe(false);
    expect(
      shouldKeepTreeExpanded({
        wasExpanded: false,
        previousOwningRootId: 'root-a',
        nextOwningRootId: 'root-a',
        nextShowTaskNav: true,
      }),
    ).toBe(false);
  });

  it('showTaskNav requires parent or multi-node', () => {
    expect(showTaskNavFor({ parentId: null }, 1)).toBe(false);
    expect(showTaskNavFor({ parentId: null }, 2)).toBe(true);
    expect(showTaskNavFor({ parentId: 'r' }, 1)).toBe(true);
  });
});
