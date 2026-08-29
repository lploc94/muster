import { describe, expect, it, vi } from 'vitest';
import {
  routeRequestWorkflowCatalog,
  type WorkflowCatalogRouteDeps,
} from './workflow-catalog-route';
import {
  WORKFLOW_CATALOG_DIAGNOSTICS_MAX,
  WORKFLOW_CATALOG_WORKFLOWS_MAX,
} from '../shared/workflow-catalog-wire';

function deps(overrides?: Partial<WorkflowCatalogRouteDeps>): WorkflowCatalogRouteDeps {
  return {
    readCatalog: async () => ({
      workflows: [{
        workflowRef: 'ref-1', name: 'Build checks', description: 'Run lint',
        scope: 'workspace', packageKind: 'bundle',
      }],
      diagnostics: [],
    }),
    ...overrides,
  };
}

const request = { type: 'requestWorkflowCatalog', requestId: 'req-1', reason: 'initial' };

describe('routeRequestWorkflowCatalog', () => {
  it('silently drops correlation-unsafe requests without reading the catalog', async () => {
    const readCatalog = vi.fn(deps().readCatalog);

    await expect(routeRequestWorkflowCatalog(
      { ...request, requestId: '' }, deps({ readCatalog }),
    )).resolves.toEqual({ kind: 'silent' });
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('returns invalidRequest for a malformed reason without reading the catalog', async () => {
    const readCatalog = vi.fn(deps().readCatalog);

    await expect(routeRequestWorkflowCatalog(
      { ...request, reason: 'poll' }, deps({ readCatalog }),
    )).resolves.toEqual({
      kind: 'message',
      message: { type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'invalidRequest' },
    });
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('projects the catalog snapshot onto the wire shape', async () => {
    await expect(routeRequestWorkflowCatalog(request, deps())).resolves.toEqual({
      kind: 'message',
      message: {
        type: 'workflowCatalogResult', requestId: 'req-1', ok: true,
        catalog: {
          reason: 'initial',
          workflows: [{
            workflowRef: 'ref-1', name: 'Build checks', description: 'Run lint',
            scope: 'workspace', packageKind: 'bundle',
          }],
          diagnostics: [],
        },
      },
    });
  });

  it('passes the request reason through to the reader and the payload', async () => {
    const readCatalog = vi.fn(deps().readCatalog);

    const outcome = await routeRequestWorkflowCatalog(
      { ...request, reason: 'reload' }, deps({ readCatalog }),
    );

    expect(readCatalog).toHaveBeenCalledWith('reload');
    expect(outcome).toMatchObject({ message: { catalog: { reason: 'reload' } } });
  });

  it('maps a catalog read failure to unavailable', async () => {
    await expect(routeRequestWorkflowCatalog(request, deps({
      readCatalog: async () => { throw new Error('EACCES'); },
    }))).resolves.toEqual({
      kind: 'message',
      message: { type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'unavailable' },
    });
  });

  it('clamps an over-cap merged list and reports the truncation', async () => {
    const workflows = Array.from({ length: WORKFLOW_CATALOG_WORKFLOWS_MAX + 5 }, (_, i) => ({
      workflowRef: `ref-${i}`, name: `Workflow ${i}`, description: '',
      scope: 'workspace' as const, packageKind: 'file' as const,
    }));

    const outcome = await routeRequestWorkflowCatalog(request, deps({
      readCatalog: async () => ({ workflows, diagnostics: [] }),
    }));

    expect(outcome).toMatchObject({ kind: 'message' });
    const message = (outcome as { message: { catalog: { workflows: unknown[]; diagnostics: { code: string }[] } } }).message;
    expect(message.catalog.workflows).toHaveLength(WORKFLOW_CATALOG_WORKFLOWS_MAX);
    expect(message.catalog.diagnostics.at(-1)?.code).toBe('catalog_truncated');
  });

  it('keeps the truncation diagnostic within the cap when diagnostics are already full', async () => {
    const workflows = Array.from({ length: WORKFLOW_CATALOG_WORKFLOWS_MAX + 1 }, (_, i) => ({
      workflowRef: `ref-${i}`, name: `Workflow ${i}`, description: '',
      scope: 'workspace' as const, packageKind: 'file' as const,
    }));
    const diagnostics = Array.from({ length: WORKFLOW_CATALOG_DIAGNOSTICS_MAX }, (_, i) => ({
      file: `w${i}.md`, code: 'invalid_workflow_file', message: 'bad',
    }));

    const outcome = await routeRequestWorkflowCatalog(request, deps({
      readCatalog: async () => ({ workflows, diagnostics }),
    }));

    const message = (outcome as { message: { catalog: { diagnostics: { code: string }[] } } }).message;
    expect(message.catalog.diagnostics).toHaveLength(WORKFLOW_CATALOG_DIAGNOSTICS_MAX);
    expect(message.catalog.diagnostics.at(-1)?.code).toBe('catalog_truncated');
  });

  it('emits a payload its own parser accepts', async () => {
    const { parseWorkflowCatalogResult } = await import('../shared/workflow-catalog-wire');
    const outcome = await routeRequestWorkflowCatalog(request, deps());

    expect(outcome.kind).toBe('message');
    expect(parseWorkflowCatalogResult(
      (outcome as { message: unknown }).message,
    )).not.toBeNull();
  });
});
