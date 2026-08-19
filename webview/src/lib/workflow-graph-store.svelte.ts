import type { WorkflowGraphWireGraph } from '../../../src/shared/workflow-graph-wire';
import { post as defaultPost } from './protocol';

/**
 * Throttle with leading + trailing (live telemetry pattern).
 * Guarantees at most 1 call per `wait` ms *during* burst, plus final call.
 * Follows adarshm.com / dev.to guidance: throttle for scroll/telemetry,
 * debounce for search.
 */
export function throttle<T extends (...args: any[]) => void>(fn: T, wait: number): T & { cancel: () => void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const throttled = (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    lastArgs = args;
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      last = now;
      fn(...(args as any));
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        if (lastArgs) fn(...(lastArgs as any));
      }, remaining);
    }
  };

  (throttled as any).cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  return throttled as T & { cancel: () => void };
}

export interface WorkflowGraphRequest {
  requestId: string;
  taskId: string;
}

/**
 * Svelte 5 class store for focus-scoped workflow graph.
 * Uses `$state` for fine-grained reactivity; caller drives it via
 * declarative `$effect` (store.setFocused) and patch notifications.
 * Throttled fetch prevents storm during rapid `taskUpserted` bursts.
 */
export class WorkflowGraphStore {
  graph = $state<WorkflowGraphWireGraph | null>(null);
  request = $state<WorkflowGraphRequest | null>(null);
  private seq = 0;
  private throttledFetch: (() => void) & { cancel: () => void };
  private pendingTaskId: string | null = null;

  constructor(private doPost: typeof defaultPost = defaultPost as unknown as typeof defaultPost) {
    // 250ms matches HackerNoon/Sportmonks live-update guidance
    this.throttledFetch = throttle(() => this.flushFetch(), 250);
  }

  /** Called declaratively from App.svelte $effect on focusedTaskId change. */
  setFocused(taskId: string | null): void {
    this.throttledFetch.cancel();
    this.pendingTaskId = taskId;
    this.graph = null;
    this.request = null;
    if (!taskId) return;
    this.requestFetch(taskId);
  }

  /** Host result correlation — ignore stale task/request. */
  handleResult(msg: { requestId: string; taskId: string; ok: boolean; graph?: WorkflowGraphWireGraph }, focusedTaskId: string | null): void {
    if (msg.requestId !== this.request?.requestId || msg.taskId !== focusedTaskId) return;
    this.request = null;
    this.graph = msg.ok && msg.graph ? msg.graph : null;
  }

  /** Patch-driven invalidation: hybrid event-driven + throttled poll fallback. */
  notifyPatch(hasTaskPatch: boolean, focusedTaskId: string | null, isCoordinator: boolean): void {
    if (!hasTaskPatch || !focusedTaskId) return;
    // Only poll when displaying a graph or focused task is coordinator (workflow parent)
    // — avoids polling plain tasks (common practice: scoped invalidation).
    if (!this.graph && !isCoordinator && !this.request) return;
    // Avoid overlapping with in-flight request for same task
    if (this.request?.taskId === focusedTaskId) return;
    this.pendingTaskId = focusedTaskId;
    this.throttledFetch();
  }

  private requestFetch(taskId: string): void {
    const requestId = `workflow-graph-${++this.seq}-${Date.now()}`;
    this.request = { requestId, taskId };
    this.doPost({ type: 'requestWorkflowGraph', requestId, taskId });
  }

  private flushFetch(): void {
    const taskId = this.pendingTaskId;
    if (!taskId) return;
    if (this.request?.taskId === taskId) return;
    this.requestFetch(taskId);
  }

  dispose(): void {
    this.throttledFetch.cancel();
  }
}

export const workflowGraphStore = new WorkflowGraphStore();
