export type WorkflowCatalogFetch = { requestId: string; reason: 'initial' | 'reload' } | null;

/**
 * Pure request-correlation policy for the catalog store: monotonic request ids,
 * and single-flight request ownership. Every settled reopen sends an `initial`
 * request so the host can resolve the currently active workspace root; its
 * workspace-keyed cache keeps same-root reopen requests filesystem-free.
 *
 * Extracted from the runes store because vitest.config.ts runs the node
 * environment with no Svelte plugin, so $state is not compiled in tests.
 */
export class WorkflowCatalogRequestPolicy {
  private seq = 0;
  private inFlight: string | null = null;

  /** null means the existing request remains authoritative. */
  onOpen(): WorkflowCatalogFetch {
    if (this.inFlight !== null) return null;
    return this.begin('initial');
  }

  onReload(): WorkflowCatalogFetch {
    if (this.inFlight !== null) return null;
    return this.begin('reload');
  }

  /** True when the reply is the in-flight request and the caller should apply it. */
  onResult(requestId: string): boolean {
    if (this.inFlight === null || requestId !== this.inFlight) return false;
    this.inFlight = null;
    return true;
  }

  onTimeout(requestId: string): boolean {
    if (this.inFlight !== requestId) return false;
    this.inFlight = null;
    return true;
  }

  private begin(reason: 'initial' | 'reload'): WorkflowCatalogFetch {
    const requestId = `catalog-${++this.seq}`;
    this.inFlight = requestId;
    return { requestId, reason };
  }
}
