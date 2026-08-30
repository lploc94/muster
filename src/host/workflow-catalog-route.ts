import {
  parseRequestWorkflowCatalogMessage,
  WORKFLOW_CATALOG_DIAGNOSTICS_MAX,
  WORKFLOW_CATALOG_DIAGNOSTIC_MESSAGE_MAX,
  WORKFLOW_CATALOG_WORKFLOWS_MAX,
  type WorkflowCatalogErrorCode,
  type WorkflowCatalogReason,
  type WorkflowCatalogResult,
  type WorkflowCatalogWire,
  type WorkflowCatalogWireDiagnostic,
} from '../shared/workflow-catalog-wire';
import type { WorkflowCatalogSnapshot } from './workflow-catalog-cache';

export interface WorkflowCatalogRouteDeps {
  readCatalog(reason: WorkflowCatalogReason): Promise<WorkflowCatalogSnapshot>;
}

export type WorkflowCatalogHostOutcome =
  | { kind: 'silent' }
  | { kind: 'message'; message: WorkflowCatalogResult };

function failure(requestId: string, code: WorkflowCatalogErrorCode): WorkflowCatalogHostOutcome {
  return {
    kind: 'message',
    message: { type: 'workflowCatalogResult', requestId, ok: false, code },
  };
}

/**
 * Copies the host catalog snapshot into the exact shared wire shape, so the
 * route stays the only host-to-webview catalog adapter.
 *
 * The host truncates at 128 entries per scope and the catalog merges two scopes,
 * so a merged list can exceed the wire cap. Clamping plus a diagnostic keeps the
 * payload acceptable to our own fail-closed parser.
 *
 * The host also caps merged diagnostics at PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS (32),
 * so the truncation diagnostic must displace the last entry rather than append a
 * 33rd one that the same parser would reject.
 */
function toWireCatalog(
  snapshot: WorkflowCatalogSnapshot,
  reason: WorkflowCatalogReason,
): WorkflowCatalogWire {
  const workflows = snapshot.workflows
    .slice(0, WORKFLOW_CATALOG_WORKFLOWS_MAX)
    .map(({ workflowRef, name, description, scope, packageKind }) => ({
      workflowRef, name, description, scope, packageKind,
    }));

  const diagnostics: WorkflowCatalogWireDiagnostic[] = snapshot.diagnostics
    .slice(0, WORKFLOW_CATALOG_DIAGNOSTICS_MAX)
    .map(({ file, code, message }) => ({
      file, code,
      message: message.slice(0, WORKFLOW_CATALOG_DIAGNOSTIC_MESSAGE_MAX),
    }));

  if (snapshot.workflows.length > WORKFLOW_CATALOG_WORKFLOWS_MAX) {
    if (diagnostics.length >= WORKFLOW_CATALOG_DIAGNOSTICS_MAX) diagnostics.pop();
    diagnostics.push({
      file: '(catalog)',
      code: 'catalog_truncated',
      message: `more than ${WORKFLOW_CATALOG_WORKFLOWS_MAX} workflows across all scopes; later entries ignored`,
    });
  }

  return { reason, workflows, diagnostics };
}

/**
 * Pull-based catalog request route. It validates before any catalog read and has
 * no focused-task check, because the catalog is workspace-scoped rather than
 * run-scoped.
 */
export async function routeRequestWorkflowCatalog(
  data: unknown,
  deps: WorkflowCatalogRouteDeps,
): Promise<WorkflowCatalogHostOutcome> {
  const parsed = parseRequestWorkflowCatalogMessage(data);
  if (!parsed.ok) {
    return parsed.silent ? { kind: 'silent' } : failure(parsed.requestId, parsed.code);
  }

  const { requestId, reason } = parsed;
  let snapshot: WorkflowCatalogSnapshot;
  try {
    snapshot = await deps.readCatalog(reason);
  } catch {
    return failure(requestId, 'unavailable');
  }

  return {
    kind: 'message',
    message: {
      type: 'workflowCatalogResult',
      requestId,
      ok: true,
      catalog: toWireCatalog(snapshot, reason),
    },
  };
}
