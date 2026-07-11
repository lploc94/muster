/**
 * Approve + materialize plan DAG into tasks (idempotent).
 */

import { createHash } from 'crypto';
import type { DepGraph } from '../task/deps';
import type { TaskStoreFile } from '../task/types';
import type { CreateTaskInput } from '../task/transitions';
import { createTask } from '../task/transitions';
import {
  approvePlan as approvePlanRecord,
  markPlanMaterialized,
  getWorkflowRun,
} from './store';
import type { PlanArtifactBody, ProposedTaskNode } from './contracts';
import { workflowError, type WorkflowError } from './contracts';
import type { WorkflowArtifactRecord } from './types';

function depGraphFromFile(file: TaskStoreFile): DepGraph {
  return {
    rootOf: (taskId) => {
      const task = file.tasks[taskId];
      if (!task) return undefined;
      let current = task;
      while (current.parentId) {
        const parent = file.tasks[current.parentId];
        if (!parent) break;
        current = parent;
      }
      return current.id;
    },
    dependsOn: (taskId) => file.tasks[taskId]?.dependencies.map((d) => d.taskId) ?? [],
  };
}

export type MaterializeResult =
  | {
      ok: true;
      workflowRunId: string;
      createdTaskIds: string[];
      /** proposalId → store task id */
      idMap: Record<string, string>;
      alreadyMaterialized: boolean;
    }
  | { ok: false; error: WorkflowError };

function stableTaskId(rootTaskId: string, planRevision: number, proposalId: string): string {
  const h = createHash('sha256')
    .update(`${rootTaskId}:r${planRevision}:${proposalId}`)
    .digest('hex')
    .slice(0, 16);
  return `wf-${h}`;
}

function topoSort(tasks: ProposedTaskNode[]): ProposedTaskNode[] | undefined {
  const byId = new Map(tasks.map((t) => [t.proposalId, t]));
  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.proposalId, 0);
    edges.set(t.proposalId, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) return undefined;
      edges.get(dep)!.push(t.proposalId);
      indegree.set(t.proposalId, (indegree.get(t.proposalId) ?? 0) + 1);
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const ordered: ProposedTaskNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node) return undefined;
    ordered.push(node);
    for (const next of edges.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (ordered.length !== tasks.length) return undefined;
  return ordered;
}

/**
 * Approve pending plan and materialize child tasks under the root.
 * Does not schedule turns — caller starts ready roots of the DAG.
 */
export function approveAndMaterialize(
  draft: TaskStoreFile,
  params: {
    workflowRunId: string;
    planArtifactId: string;
    materializeOpId: string;
    now: string;
    /** Default execution policy for children. */
    defaultPolicy: CreateTaskInput['executionPolicy'];
  },
): MaterializeResult {
  const approved = approvePlanRecord(draft, {
    workflowRunId: params.workflowRunId,
    planArtifactId: params.planArtifactId,
    materializeOpId: params.materializeOpId,
    now: params.now,
  });
  if (!approved.ok) {
    return { ok: false, error: approved.error };
  }

  const run = getWorkflowRun(draft, params.workflowRunId);
  if (!run) {
    return { ok: false, error: workflowError('NOT_FOUND', 'workflow run missing after approve') };
  }

  if (run.approval?.materialized) {
    // Rebuild id map from existing tasks for callers
    const artifact = draft.workflowArtifacts?.[params.planArtifactId];
    const body = artifact?.body as PlanArtifactBody | undefined;
    const idMap: Record<string, string> = {};
    const createdTaskIds: string[] = [];
    if (body) {
      for (const t of body.tasks) {
        const id = stableTaskId(run.rootTaskId, body.revision, t.proposalId);
        if (draft.tasks[id]) {
          idMap[t.proposalId] = id;
          createdTaskIds.push(id);
        }
      }
    }
    return {
      ok: true,
      workflowRunId: params.workflowRunId,
      createdTaskIds,
      idMap,
      alreadyMaterialized: true,
    };
  }

  const artifact: WorkflowArtifactRecord | undefined =
    draft.workflowArtifacts?.[params.planArtifactId];
  if (!artifact || artifact.kind !== 'plan') {
    return { ok: false, error: workflowError('PLAN_INVALID', 'plan artifact not found') };
  }
  const body = artifact.body as PlanArtifactBody;
  const ordered = topoSort(body.tasks);
  if (!ordered) {
    return { ok: false, error: workflowError('PLAN_INVALID', 'plan DAG invalid at materialize') };
  }

  const root = draft.tasks[run.rootTaskId];
  if (!root) {
    return { ok: false, error: workflowError('NOT_FOUND', 'root task not found') };
  }

  const idMap: Record<string, string> = {};
  const createdTaskIds: string[] = [];
  // Graph reads live from draft.tasks, so sequential creates see prior siblings.
  const graph = depGraphFromFile(draft);

  for (const node of ordered) {
    const childId = stableTaskId(run.rootTaskId, body.revision, node.proposalId);
    idMap[node.proposalId] = childId;

    if (draft.tasks[childId]) {
      createdTaskIds.push(childId);
      continue;
    }

    const dependencies = node.dependsOn.map((depProposal) => ({
      taskId: idMap[depProposal] ?? stableTaskId(run.rootTaskId, body.revision, depProposal),
      requiredOutcome: 'succeeded' as const,
      onUnsatisfied: 'block' as const,
    }));

    const input: CreateTaskInput = {
      id: childId,
      role: node.role,
      goal: node.goal,
      description: node.notes,
      parentId: run.rootTaskId,
      dependencies,
      backend: node.backend,
      model: node.model,
      cwd: root.cwd,
      capabilities:
        node.role === 'coordinator'
          ? ['create_child', 'start_child', 'wait_child', 'read_subtree']
          : [],
      executionPolicy: params.defaultPolicy,
    };

    const created = createTask(input, { rootId: run.rootTaskId, graph, now: params.now });
    if (!created.ok) {
      return {
        ok: false,
        error: workflowError('PLAN_INVALID', created.reason ?? 'createTask failed', {
          proposalId: node.proposalId,
        }),
      };
    }
    draft.tasks[childId] = created.next;
    createdTaskIds.push(childId);
  }

  const marked = markPlanMaterialized(draft, {
    workflowRunId: params.workflowRunId,
    materializeOpId: params.materializeOpId,
    now: params.now,
  });
  if (!marked.ok) {
    return { ok: false, error: marked.error };
  }

  return {
    ok: true,
    workflowRunId: params.workflowRunId,
    createdTaskIds,
    idMap,
    alreadyMaterialized: false,
  };
}

/** Ready children: no deps or all deps succeeded. */
export function readyChildIds(
  file: TaskStoreFile,
  childIds: string[],
): string[] {
  return childIds.filter((id) => {
    const task = file.tasks[id];
    if (!task || task.lifecycle !== 'open') return false;
    return task.dependencies.every((dep) => {
      const d = file.tasks[dep.taskId];
      if (!d) return false;
      if (dep.requiredOutcome === 'succeeded') return d.lifecycle === 'succeeded';
      return (
        d.lifecycle === 'succeeded' ||
        d.lifecycle === 'failed' ||
        d.lifecycle === 'cancelled' ||
        d.lifecycle === 'skipped'
      );
    });
  });
}
