import type { WorkflowGraphWireGraph } from '../../../src/shared/workflow-graph-wire';
import { post as defaultPost } from './protocol';
import { WorkflowGraphRefreshPolicy } from './workflow-graph-refresh-policy';

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

type WorkflowGraphDebug = (event: string, details: Record<string, unknown>) => void;

/**
 * Svelte 5 class store for focus-scoped workflow graph.
 * Uses `$state` for fine-grained reactivity; caller drives it via
 * declarative `$effect` (store.setFocused) and patch notifications.
 * Throttled fetch prevents storm during rapid `taskUpserted` bursts.
 */
export class WorkflowGraphStore {
  graph = $state<WorkflowGraphWireGraph | null>(null);
  request = $state<WorkflowGraphRequest | null>(null);
  error = $state<string | null>(null);
  private seq = 0;
  private throttledFetch: (() => void) & { cancel: () => void };
  private pendingTaskId: string | null = null;
  private isOpen = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private refreshPolicy = new WorkflowGraphRefreshPolicy();

  constructor(
    private doPost: typeof defaultPost = defaultPost as unknown as typeof defaultPost,
    private debug: WorkflowGraphDebug = () => {},
  ) {
    // 250ms matches HackerNoon/Sportmonks live-update guidance
    this.throttledFetch = throttle(() => this.flushFetch(), 250);
  }

  /** Called declaratively from App.svelte $effect on focusedTaskId change. Kept for tests; delegates to setOpen when modal is managed. */
  setFocused(taskId: string | null): void {
    this.throttledFetch.cancel();
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
    this.pendingTaskId = taskId;
    this.graph = null;
    this.request = null;
    this.error = null;
    this.refreshPolicy.reset();
    if (!taskId) return;
    // Legacy auto-fetch path — retained so existing wiring tests that call setFocused directly still trigger a fetch.
    // App.svelte now gates via setOpen(); this path is only for direct callers / tests.
    this.requestFetch(taskId);
  }

  /** Modal-aware focus+open sync — App.svelte calls this so graph is NOT fetched until the user opens the modal. */
  setOpen(open: boolean, taskId: string | null): void {
    const changed = this.isOpen !== open || this.pendingTaskId !== taskId;
    this.debug('workflow_graph.store_set_open', {
      open,
      taskId,
      pendingTaskId: this.pendingTaskId,
      changed,
    });
    if (!changed) {
      this.debug('workflow_graph.store_deduped', { reason: 'open_state_unchanged', taskId });
      return;
    }
    this.isOpen = open;
    this.pendingTaskId = taskId;
    this.throttledFetch.cancel();
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
    this.graph = null;
    this.request = null;
    this.error = null;
    this.refreshPolicy.reset();
    if (!open || !taskId) return;
    this.requestFetch(taskId);
  }

  clear(): void {
    this.throttledFetch.cancel();
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
    this.pendingTaskId = null;
    this.graph = null;
    this.request = null;
    this.error = null;
    this.refreshPolicy.reset();
    this.isOpen = false;
  }

  retry(): void {
    this.debug('workflow_graph.store_retry', {
      isOpen: this.isOpen,
      pendingTaskId: this.pendingTaskId,
      requestId: this.request?.requestId,
      error: this.error,
    });
    if (!this.isOpen || !this.pendingTaskId) return;
    if (this.request) return; // already pending
    this.error = null;
    this.requestFetch(this.pendingTaskId);
  }

  /** Host result correlation — ignore stale task/request. */
  handleResult(msg: { requestId: string; taskId: string; ok: boolean; graph?: WorkflowGraphWireGraph; code?: string }, focusedTaskId: string | null): void {
    const expectedRequestId = this.request?.requestId;
    this.debug('workflow_graph.store_result', {
      requestId: msg.requestId,
      taskId: msg.taskId,
      ok: msg.ok,
      code: msg.code,
      graphRunId: msg.graph?.runId,
      expectedRequestId,
      focusedTaskId,
    });
    if (msg.requestId !== expectedRequestId || msg.taskId !== focusedTaskId) {
      this.debug('workflow_graph.store_result_dropped', {
        requestId: msg.requestId,
        taskId: msg.taskId,
        expectedRequestId,
        focusedTaskId,
        requestMatches: msg.requestId === expectedRequestId,
        taskMatches: msg.taskId === focusedTaskId,
      });
      return;
    }
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
    const refreshAfterResult = this.refreshPolicy.onResult(msg.ok && !!msg.graph);
    this.request = null;
    if (msg.ok && msg.graph) {
      this.graph = msg.graph;
      this.error = null;
    } else {
      this.graph = null;
      // Preserve host error code for UI (notInWorkflow, unavailable, invalidRequest)
      this.error = (msg as any).code ?? 'unavailable';
    }
    if (
      refreshAfterResult
      && msg.ok
      && msg.graph
      && this.isOpen
      && this.pendingTaskId === focusedTaskId
    ) this.throttledFetch();
  }

  /** Patch-driven invalidation: hybrid event-driven + throttled poll fallback. */
  notifyPatch(hasTaskPatch: boolean, focusedTaskId: string | null, isCoordinator: boolean): void {
    if (!hasTaskPatch || !focusedTaskId) return;
    // Modal gated: only poll when the workflow view is open (on-demand). This avoids
    // fetching/polling when the user never opened the graph, saving vertical space and network.
    if (!this.isOpen) return;
    // Only poll when displaying a graph or focused task is coordinator (workflow parent)
    // — avoids polling plain tasks (common practice: scoped invalidation).
    if (!this.graph && !isCoordinator && !this.request) return;
    // Avoid overlapping with in-flight request for same task
    if (this.refreshPolicy.onPatch(this.request?.taskId === focusedTaskId, this.error !== null) === 'ignore') return;
    this.pendingTaskId = focusedTaskId;
    this.throttledFetch();
  }

  private requestFetch(taskId: string): void {
    const requestId = `workflow-graph-${++this.seq}-${Date.now()}`;
    this.request = { requestId, taskId };
    this.error = null;
    this.refreshPolicy.reset();
    this.debug('workflow_graph.webview_request', { requestId, taskId });
    this.doPost({ type: 'requestWorkflowGraph', requestId, taskId });
    // Guard against silent host (no reply) — don't stay in loading forever
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => {
      if (this.request?.requestId === requestId) {
        this.debug('workflow_graph.store_timeout', {
          requestId,
          taskId,
          focusedPendingTaskId: this.pendingTaskId,
          isOpen: this.isOpen,
        });
        this.request = null;
        this.error = 'unavailable';
        this.refreshPolicy.reset();
      }
    }, 8000);
  }

  private flushFetch(): void {
    const taskId = this.pendingTaskId;
    if (!taskId) return;
    if (this.request?.taskId === taskId) return;
    this.requestFetch(taskId);
  }

  dispose(): void {
    this.throttledFetch.cancel();
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
    this.refreshPolicy.reset();
  }
}

export const workflowGraphStore = new WorkflowGraphStore();
