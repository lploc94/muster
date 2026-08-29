import { describe, expect, it, vi } from 'vitest';
import { WorkflowCatalogCache, type WorkflowCatalogSnapshot } from './workflow-catalog-cache';

function snapshot(name: string): WorkflowCatalogSnapshot {
  return {
    workflows: [{
      workflowRef: `ref-${name}`, name, description: '',
      scope: 'workspace', packageKind: 'file',
    }],
    diagnostics: [],
  };
}

describe('WorkflowCatalogCache', () => {
  it('scans once for initial then serves the cached snapshot', async () => {
    const read = vi.fn(async () => snapshot('one'));
    const cache = new WorkflowCatalogCache(read);

    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('one'));
    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('one'));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rescans on reload and replaces the snapshot', async () => {
    let current = snapshot('one');
    const read = vi.fn(async () => current);
    const cache = new WorkflowCatalogCache(read);

    await cache.read('/root/a', 'initial');
    current = snapshot('two');
    await expect(cache.read('/root/a', 'reload')).resolves.toEqual(snapshot('two'));
    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('two'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rescans when the resolved folder differs from the cached key', async () => {
    const read = vi.fn(async (folder: string) => snapshot(folder));
    const cache = new WorkflowCatalogCache(read);

    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('/root/a'));
    await expect(cache.read('/root/b', 'initial')).resolves.toEqual(snapshot('/root/b'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not poison the cached snapshot when a rescan fails', async () => {
    let fail = false;
    const read = vi.fn(async () => {
      if (fail) throw new Error('EACCES');
      return snapshot('one');
    });
    const cache = new WorkflowCatalogCache(read);

    await cache.read('/root/a', 'initial');
    fail = true;
    await expect(cache.read('/root/a', 'reload')).rejects.toThrow('EACCES');

    fail = false;
    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('one'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('drops the snapshot on dispose', async () => {
    const read = vi.fn(async () => snapshot('one'));
    const cache = new WorkflowCatalogCache(read);

    await cache.read('/root/a', 'initial');
    cache.dispose();
    await cache.read('/root/a', 'initial');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
