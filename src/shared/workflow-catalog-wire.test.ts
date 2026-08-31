import { describe, expect, it } from 'vitest';
import {
  parseRequestWorkflowCatalogMessage,
  parseWorkflowCatalogResult,
  WORKFLOW_CATALOG_DESCRIPTION_MAX,
  WORKFLOW_CATALOG_DIAGNOSTIC_CODE_MAX,
  WORKFLOW_CATALOG_DIAGNOSTIC_FILE_MAX,
  WORKFLOW_CATALOG_DIAGNOSTICS_MAX,
  WORKFLOW_CATALOG_NAME_MAX,
  WORKFLOW_CATALOG_REF_MAX,
  WORKFLOW_CATALOG_REQUEST_ID_MAX,
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

  it('silently drops an over-bound request id', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog',
      requestId: 'x'.repeat(WORKFLOW_CATALOG_REQUEST_ID_MAX + 1),
      reason: 'initial',
    })).toEqual({ ok: false, silent: true });
  });

  it('silently drops a NUL-bearing request id', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog', requestId: 'req\0-1', reason: 'initial',
    })).toEqual({ ok: false, silent: true });
  });

  it('returns invalidRequest for an extra request key', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog', requestId: 'req-1', reason: 'initial', extra: true,
    })).toEqual({ ok: false, silent: false, requestId: 'req-1', code: 'invalidRequest' });
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

  it('rejects the removed flat-file package kind', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, packageKind: 'file' }], diagnostics: [] },
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

  it('rejects null input', () => {
    expect(parseWorkflowCatalogResult(null)).toBeNull();
  });

  it('rejects non-record input', () => {
    expect(parseWorkflowCatalogResult(42)).toBeNull();
  });

  it('rejects an over-bound result request id', () => {
    expect(parseWorkflowCatalogResult(result({
      requestId: 'x'.repeat(WORKFLOW_CATALOG_REQUEST_ID_MAX + 1),
    }))).toBeNull();
  });

  it('rejects a NUL-bearing result request id', () => {
    expect(parseWorkflowCatalogResult(result({ requestId: 'req\0-1' }))).toBeNull();
  });

  it('rejects an extra key on a success result envelope', () => {
    expect(parseWorkflowCatalogResult(result({ extra: true }))).toBeNull();
  });

  it('rejects an extra key on an error result envelope', () => {
    expect(parseWorkflowCatalogResult({
      type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'unavailable', extra: true,
    })).toBeNull();
  });

  it('rejects an unknown ok value', () => {
    expect(parseWorkflowCatalogResult(result({ ok: 'pending' }))).toBeNull();
  });

  it('rejects an extra key on the catalog', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [], diagnostics: [], extra: true },
    }))).toBeNull();
  });

  it('rejects a missing key on the catalog', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [] },
    }))).toBeNull();
  });

  it('rejects an unknown catalog reason', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'poll', workflows: [], diagnostics: [] },
    }))).toBeNull();
  });

  it('rejects a missing key on an entry', () => {
    const missingPackageKind = {
      workflowRef: entry.workflowRef,
      name: entry.name,
      description: entry.description,
      scope: entry.scope,
    };
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [missingPackageKind], diagnostics: [] },
    }))).toBeNull();
  });

  it('rejects an over-bound workflowRef', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial',
        workflows: [{ ...entry, workflowRef: 'r'.repeat(WORKFLOW_CATALOG_REF_MAX + 1) }],
        diagnostics: [],
      },
    }))).toBeNull();
  });

  it('rejects an over-bound name', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial',
        workflows: [{ ...entry, name: 'n'.repeat(WORKFLOW_CATALOG_NAME_MAX + 1) }],
        diagnostics: [],
      },
    }))).toBeNull();
  });

  it('rejects an over-bound description', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial',
        workflows: [{ ...entry, description: 'd'.repeat(WORKFLOW_CATALOG_DESCRIPTION_MAX + 1) }],
        diagnostics: [],
      },
    }))).toBeNull();
  });

  it('accepts a canonical description at the manifest bound', () => {
    expect(WORKFLOW_CATALOG_DESCRIPTION_MAX).toBe(4_096);
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial',
        workflows: [{ ...entry, description: 'd'.repeat(WORKFLOW_CATALOG_DESCRIPTION_MAX) }],
        diagnostics: [],
      },
    }))).not.toBeNull();
  });

  it('rejects an empty workflowRef', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, workflowRef: '' }], diagnostics: [] },
    }))).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, name: '' }], diagnostics: [] },
    }))).toBeNull();
  });

  it('rejects duplicate workflowRef values', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial',
        workflows: [entry, { ...entry, name: 'Another workflow' }],
        diagnostics: [],
      },
    }))).toBeNull();
  });

  it('rejects an oversized diagnostics array', () => {
    const diagnostics = Array.from({ length: WORKFLOW_CATALOG_DIAGNOSTICS_MAX + 1 }, () => ({
      file: '(scope)', code: 'x', message: 'x',
    }));
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [], diagnostics },
    }))).toBeNull();
  });

  it('rejects an extra key on a diagnostic', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial', workflows: [],
        diagnostics: [{ file: '(scope)', code: 'x', message: 'x', extra: true }],
      },
    }))).toBeNull();
  });

  it('rejects an empty diagnostic file', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial', workflows: [],
        diagnostics: [{ file: '', code: 'x', message: 'x' }],
      },
    }))).toBeNull();
  });

  it('rejects diagnostic paths and control-bearing labels', () => {
    for (const file of [
      '/Users/alice/.muster/workflows/broken.md',
      'C:\\Users\\alice\\.muster\\workflows\\broken.md',
      'nested/broken.md',
      'nested\\broken.md',
      'broken\n.md',
    ]) {
      expect(parseWorkflowCatalogResult(result({
        catalog: {
          reason: 'initial', workflows: [],
          diagnostics: [{ file, code: 'invalid_workflow_file', message: 'bad' }],
        },
      }))).toBeNull();
    }
  });

  it('rejects an over-bound diagnostic code', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial', workflows: [],
        diagnostics: [{
          file: '(scope)',
          code: 'c'.repeat(WORKFLOW_CATALOG_DIAGNOSTIC_CODE_MAX + 1),
          message: 'x',
        }],
      },
    }))).toBeNull();
  });

  it('rejects an over-bound diagnostic file', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial',
        workflows: [],
        diagnostics: [{
          file: 'f'.repeat(WORKFLOW_CATALOG_DIAGNOSTIC_FILE_MAX + 1),
          code: 'x',
          message: 'x',
        }],
      },
    }))).toBeNull();
  });
});
