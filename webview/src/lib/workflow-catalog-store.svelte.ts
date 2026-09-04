import type {
  RequestWorkflowCatalog,
  RequestWorkflowCatalogDetail,
  WorkflowCatalogDetailResult,
  WorkflowCatalogResult,
  WorkflowCatalogWire,
  WorkflowCatalogWireDetail,
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
 * refresh, so there is no throttle. Opens revalidate the active workspace through
 * the host cache; explicit Reload forces a rescan. Correlation lives in
 * WorkflowCatalogRequestPolicy.
 */
export class WorkflowCatalogStore {
  catalog = $state<WorkflowCatalogWire | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  detail = $state<WorkflowCatalogWireDetail | null>(null);
  detailLoading = $state(false);
  detailError = $state<string | null>(null);
  private policy = new WorkflowCatalogRequestPolicy();
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private detailTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private detailRequestId: string | null = null;
  private panelOpen = false;
  private revalidateAfterFlight = false;

  constructor(private doPost: typeof defaultPost = defaultPost) {}

  open(): void {
    this.panelOpen = true;
    const fetch = this.policy.onOpen();
    this.revalidateAfterFlight = fetch === null;
    this.dispatch(fetch);
  }

  reload(): void {
    this.dispatch(this.policy.onReload());
  }

  retry(): void {
    this.reload();
  }

  handleResult(msg: WorkflowCatalogResult): void {
    if (!this.policy.onResult(msg.requestId)) return;
    this.loading = false;
    this.clearTimer();
    if (msg.ok) {
      this.catalog = msg.catalog;
      this.error = null;
      this.revalidateOpenPanel();
      return;
    }
    // Keep the prior snapshot: an error must not discard usable data.
    this.error = msg.code;
    this.revalidateOpenPanel();
  }

  requestDetail(workflowRef: string): void {
    if (this.detailTimeoutId !== null) clearTimeout(this.detailTimeoutId);
    const requestId = `detail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.detailRequestId = requestId;
    this.detailLoading = true;
    this.detailError = null;
    const message: RequestWorkflowCatalogDetail = {
      type: 'requestWorkflowCatalogDetail',
      requestId,
      workflowRef,
    };
    this.doPost(message);
    this.detailTimeoutId = setTimeout(() => {
      if (this.detailRequestId !== requestId) return;
      this.detailLoading = false;
      this.detailError = 'unavailable';
      this.detailTimeoutId = null;
    }, WORKFLOW_CATALOG_TIMEOUT_MS);
  }

  handleDetailResult(msg: WorkflowCatalogDetailResult): void {
    if (msg.requestId !== this.detailRequestId) return;
    this.detailLoading = false;
    this.detailRequestId = null;
    if (this.detailTimeoutId !== null) clearTimeout(this.detailTimeoutId);
    this.detailTimeoutId = null;
    if (msg.ok) {
      this.detail = msg.detail;
      this.detailError = null;
    } else {
      this.detailError = msg.code;
    }
  }

  /** Panel close cancels pending detail work and clears stale selection state. */
  close(): void {
    this.panelOpen = false;
    this.detail = null;
    this.detailError = null;
    this.detailLoading = false;
    this.detailRequestId = null;
    if (this.detailTimeoutId !== null) clearTimeout(this.detailTimeoutId);
    this.detailTimeoutId = null;
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
      this.revalidateOpenPanel();
    }, WORKFLOW_CATALOG_TIMEOUT_MS);
    const message: RequestWorkflowCatalog = {
      type: 'requestWorkflowCatalog',
      requestId: fetch.requestId,
      reason: fetch.reason,
    };
    this.doPost(message);
  }

  private revalidateOpenPanel(): void {
    if (!this.panelOpen || !this.revalidateAfterFlight) return;
    this.revalidateAfterFlight = false;
    this.dispatch(this.policy.onOpen());
  }

  private clearTimer(): void {
    if (this.timeoutId === null) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }
}

export const workflowCatalogStore = new WorkflowCatalogStore();
