import { describe, expect, it, vi } from 'vitest';
import {
  routeRequestWorkflowCatalog,
  type WorkflowCatalogRouteDeps,
} from './workflow-catalog-route';
import {
  parseWorkflowCatalogResult,
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

    expect(outcome.kind).toBe('message');
    if (outcome.kind !== 'message' || !outcome.message.ok) throw new Error('expected success message');
    expect(outcome.message.catalog.workflows).toHaveLength(WORKFLOW_CATALOG_WORKFLOWS_MAX);
    expect(outcome.message.catalog.workflows[0]?.workflowRef).toBe('ref-0');
    expect(outcome.message.catalog.diagnostics.at(-1)?.code).toBe('catalog_truncated');
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

    expect(outcome.kind).toBe('message');
    if (outcome.kind !== 'message' || !outcome.message.ok) throw new Error('expected success message');
    const message = outcome.message;
    expect(message.catalog.diagnostics).toHaveLength(WORKFLOW_CATALOG_DIAGNOSTICS_MAX);
    expect(message.catalog.diagnostics.slice(0, -1).map((diagnostic) => diagnostic.file))
      .toEqual(Array.from({ length: WORKFLOW_CATALOG_DIAGNOSTICS_MAX - 1 }, (_, i) => `w${i}.md`));
    expect(message.catalog.diagnostics.at(-1)?.code).toBe('catalog_truncated');
    expect(parseWorkflowCatalogResult(message)).not.toBeNull();
  });

  it('replaces unsafe diagnostic paths before posting the catalog', async () => {
    const outcome = await routeRequestWorkflowCatalog(request, deps({
      readCatalog: async () => ({
        workflows: [],
        diagnostics: [
          { file: '/Users/alice/private.md', code: 'invalid_workflow_file', message: 'bad' },
          { file: 'C:\\Users\\alice\\private.md', code: 'invalid_workflow_file', message: 'bad' },
        ],
      }),
    }));

    expect(outcome.kind).toBe('message');
    if (outcome.kind !== 'message' || !outcome.message.ok) throw new Error('expected success message');
    expect(outcome.message.catalog.diagnostics.map(({ file }) => file))
      .toEqual(['(catalog)', '(catalog)']);
    expect(parseWorkflowCatalogResult(outcome.message)).not.toBeNull();
  });

  it('does not report truncation at the exact workflow cap', async () => {
    const workflows = Array.from({ length: WORKFLOW_CATALOG_WORKFLOWS_MAX }, (_, i) => ({
      workflowRef: `ref-${i}`, name: `Workflow ${i}`, description: '',
      scope: 'workspace' as const, packageKind: 'file' as const,
    }));
    const diagnostics = Array.from({ length: WORKFLOW_CATALOG_DIAGNOSTICS_MAX }, (_, i) => ({
      file: `w${i}.md`, code: 'invalid_workflow_file', message: 'bad',
    }));

    const outcome = await routeRequestWorkflowCatalog(request, deps({
      readCatalog: async () => ({ workflows, diagnostics }),
    }));

    expect(outcome.kind).toBe('message');
    if (outcome.kind !== 'message' || !outcome.message.ok) throw new Error('expected success message');
    expect(outcome.message.catalog.workflows).toHaveLength(WORKFLOW_CATALOG_WORKFLOWS_MAX);
    expect(outcome.message.catalog.workflows[0]?.workflowRef).toBe('ref-0');
    expect(outcome.message.catalog.diagnostics).toEqual(diagnostics);
    expect(outcome.message.catalog.diagnostics.some(({ code }) => code === 'catalog_truncated')).toBe(false);
  });

  it('emits a payload its own parser accepts', async () => {
    const outcome = await routeRequestWorkflowCatalog(request, deps());

    expect(outcome.kind).toBe('message');
    if (outcome.kind !== 'message') throw new Error('expected message');
    expect(parseWorkflowCatalogResult(
      outcome.message,
    )).not.toBeNull();
  });
});
