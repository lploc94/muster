import type {
  PredefinedWorkflowDiagnostic,
  PredefinedWorkflowSummary,
} from './predefined-workflows';
import type { WorkflowCatalogReason } from '../shared/workflow-catalog-wire';

export interface WorkflowCatalogSnapshot {
  workflows: readonly PredefinedWorkflowSummary[];
  diagnostics: readonly PredefinedWorkflowDiagnostic[];
}

export type WorkflowCatalogReader = (workspaceFolder: string) => Promise<WorkflowCatalogSnapshot>;

/**
 * One in-memory catalog snapshot keyed by the resolved workspace catalog folder.
 *
 * The key matters because the host resolves the folder through resolveTaskCwd(),
 * which is multi-root aware: the folder holding the active editor wins, so the
 * resolved root can change between requests without any user action here.
 *
 * A failed rescan rejects without replacing the previous snapshot, so a transient
 * read error cannot discard usable data. If scans overlap, only the most recently
 * started scan may replace the cached snapshot.
 */
export class WorkflowCatalogCache {
  private key: string | undefined;
  private snapshot: WorkflowCatalogSnapshot | undefined;
  private generation = 0;

  constructor(private readonly load: WorkflowCatalogReader) {}

  async read(workspaceFolder: string, reason: WorkflowCatalogReason): Promise<WorkflowCatalogSnapshot> {
    if (reason === 'initial' && this.snapshot !== undefined && this.key === workspaceFolder) {
      return this.snapshot;
    }

    const generation = ++this.generation;
    const next = await this.load(workspaceFolder);
    if (generation === this.generation) {
      this.key = workspaceFolder;
      this.snapshot = next;
    }
    return next;
  }

  dispose(): void {
    this.generation += 1;
    this.key = undefined;
    this.snapshot = undefined;
  }
}
