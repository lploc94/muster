import { describe, expect, it } from 'vitest';
import {
  parseRequestWorkflowCatalogMessage,
  parseWorkflowCatalogResult,
  WORKFLOW_CATALOG_WORKFLOWS_MAX,
} from './workflow-catalog-wire';

const entry = {
  workflowRef: 'ref-1',
  name: 'Build checks',
  description: 'Run lint and typecheck',
  scope: 'workspace',
  packageKind: 'bundle',
};

function result(overrides?: Record<string, unknown>) {
  return {
    type: 'workflowCatalogResult',
    requestId: 'req-1',
    ok: true,
    catalog: { reason: 'initial', workflows: [entry], diagnostics: [] },
    ...overrides,
  };
}

describe('parseRequestWorkflowCatalogMessage', () => {
  it('accepts an exact request', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog', requestId: 'req-1', reason: 'reload',
    })).toEqual({ ok: true, requestId: 'req-1', reason: 'reload' });
  });

  it('silently drops a request with unsafe correlation', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog', requestId: '', reason: 'initial',
    })).toEqual({ ok: false, silent: true });
  });

  it('returns invalidRequest when correlation is safe but reason is not', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog', requestId: 'req-1', reason: 'poll',
    })).toEqual({ ok: false, silent: false, requestId: 'req-1', code: 'invalidRequest' });
  });

  it('silently drops a foreign message type', () => {
    expect(parseRequestWorkflowCatalogMessage({ type: 'requestWorkflowGraph', requestId: 'r' }))
      .toEqual({ ok: false, silent: true });
  });
});

describe('parseWorkflowCatalogResult', () => {
  it('accepts a well-formed success payload', () => {
    expect(parseWorkflowCatalogResult(result())).not.toBeNull();
  });

  it('accepts an empty catalog', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'reload', workflows: [], diagnostics: [] },
    }))).not.toBeNull();
  });

  it('accepts an empty description', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, description: '' }], diagnostics: [] },
    }))).not.toBeNull();
  });

  it('accepts an unrecognised diagnostic code as bounded text', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial', workflows: [],
        diagnostics: [{ file: '(scope)', code: 'some_future_code', message: 'x' }],
      },
    }))).not.toBeNull();
  });

  it('rejects an unknown scope', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, scope: 'user' }], diagnostics: [] },
    }))).toBeNull();
  });

  it('rejects an unknown packageKind', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, packageKind: 'zip' }], diagnostics: [] },
    }))).toBeNull();
  });

  it('rejects an extra key on an entry', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial',
        workflows: [{ ...entry, packagePath: '/home/u/.muster/workflows' }],
        diagnostics: [],
      },
    }))).toBeNull();
  });

  it('rejects an oversized workflows array', () => {
    const workflows = Array.from({ length: WORKFLOW_CATALOG_WORKFLOWS_MAX + 1 }, (_, i) => ({
      ...entry, workflowRef: `ref-${i}`,
    }));
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows, diagnostics: [] },
    }))).toBeNull();
  });

  it('accepts a bounded error payload and rejects an unknown code', () => {
    expect(parseWorkflowCatalogResult({
      type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'unavailable',
    })).not.toBeNull();
    expect(parseWorkflowCatalogResult({
      type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'boom',
    })).toBeNull();
  });
});
