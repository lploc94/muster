import type {
  RequestWorkflowCatalog,
  WorkflowCatalogResult,
  WorkflowCatalogWire,
} from '../../../src/shared/workflow-catalog-wire';
import { post as defaultPost } from './protocol';
import {
  WorkflowCatalogRequestPolicy,
  type WorkflowCatalogFetch,
} from './workflow-catalog-request-policy';

/** Matches the 8s timeout in workflow-graph-store.svelte.ts:220. */
export const WORKFLOW_CATALOG_TIMEOUT_MS = 8_000;

/**
 * Svelte 5 class store for the workspace-scoped workflow catalog.
 *
 * Deliberately simpler than WorkflowGraphStore: the catalog has no patch-driven
 * refresh, so there is no throttle. Reads happen on first open and on explicit
 * Reload only. Correlation lives in WorkflowCatalogRequestPolicy.
 */
export class WorkflowCatalogStore {
  catalog = $state<WorkflowCatalogWire | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  private policy = new WorkflowCatalogRequestPolicy();
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(private doPost: typeof defaultPost = defaultPost) {}

  open(): void {
    this.dispatch(this.policy.onOpen());
  }

  reload(): void {
    this.dispatch(this.policy.onReload());
  }

  retry(): void {
    this.reload();
  }

  handleResult(msg: WorkflowCatalogResult): void {
    if (!this.policy.onResult(msg.requestId, msg.ok)) return;
    this.loading = false;
    this.clearTimer();
    if (msg.ok) {
      this.catalog = msg.catalog;
      this.error = null;
      return;
    }
    // Keep the prior snapshot: an error must not discard usable data.
    this.error = msg.code;
  }

  /** Panel closed. The snapshot is retained so reopening does not refetch. */
  close(): void {
    this.policy.settle();
    this.loading = false;
    this.clearTimer();
  }

  dispose(): void {
    this.policy.reset();
    this.loading = false;
    this.clearTimer();
    this.catalog = null;
    this.error = null;
  }

  private dispatch(fetch: WorkflowCatalogFetch): void {
    if (fetch === null) return;
    this.error = null;
    this.loading = true;
    this.clearTimer();
    this.timeoutId = setTimeout(() => {
      if (!this.policy.onTimeout(fetch.requestId)) return;
      this.loading = false;
      this.error = 'unavailable';
      this.timeoutId = null;
    }, WORKFLOW_CATALOG_TIMEOUT_MS);
    const message: RequestWorkflowCatalog = {
      type: 'requestWorkflowCatalog',
      requestId: fetch.requestId,
      reason: fetch.reason,
    };
    this.doPost(message);
  }

  private clearTimer(): void {
    if (this.timeoutId === null) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }
}

export const workflowCatalogStore = new WorkflowCatalogStore();
