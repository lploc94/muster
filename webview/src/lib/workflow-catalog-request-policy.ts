export type WorkflowCatalogFetch = { requestId: string; reason: 'initial' | 'reload' } | null;

/**
 * Pure request-correlation policy for the catalog store: monotonic request ids,
 * single-flight, and the held-snapshot rule that makes reopening free.
 *
 * Extracted from the runes store because vitest.config.ts runs the node
 * environment with no Svelte plugin, so $state is not compiled in tests.
 */
export class WorkflowCatalogRequestPolicy {
  private seq = 0;
  private inFlight: string | null = null;
  private held = false;

  /** null means no request: a snapshot is already held, or one is in flight. */
  onOpen(): WorkflowCatalogFetch {
    if (this.held || this.inFlight !== null) return null;
    return this.begin('initial');
  }

  onReload(): WorkflowCatalogFetch {
    if (this.inFlight !== null) return null;
    return this.begin('reload');
  }

  /** True when the reply is the in-flight request and the caller should apply it. */
  onResult(requestId: string, ok: boolean): boolean {
    if (this.inFlight === null || requestId !== this.inFlight) return false;
    this.inFlight = null;
    // A failed reload leaves `held` as it was, so the prior snapshot survives.
    if (ok) this.held = true;
    return true;
  }

  onTimeout(requestId: string): boolean {
    if (this.inFlight !== requestId) return false;
    this.inFlight = null;
    return true;
  }

  settle(): void {
    this.inFlight = null;
  }

  reset(): void {
    this.inFlight = null;
    this.held = false;
  }

  private begin(reason: 'initial' | 'reload'): WorkflowCatalogFetch {
    const requestId = `catalog-${++this.seq}`;
    this.inFlight = requestId;
    return { requestId, reason };
  }
}
