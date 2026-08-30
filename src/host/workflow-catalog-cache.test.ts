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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('WorkflowCatalogCache', () => {
  it('scans once for initial then serves the cached snapshot', async () => {
    const read = vi.fn(async () => snapshot('one'));
    const cache = new WorkflowCatalogCache(read);

    const first = await cache.read('/root/a', 'initial');
    expect(first).toEqual(snapshot('one'));
    await expect(cache.read('/root/a', 'initial')).resolves.toBe(first);
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

  it('does not let an older scan overwrite a newer completed scan', async () => {
    const older = deferred<WorkflowCatalogSnapshot>();
    const newer = deferred<WorkflowCatalogSnapshot>();
    const read = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const cache = new WorkflowCatalogCache(read);

    const olderRead = cache.read('/root/a', 'initial');
    const newerRead = cache.read('/root/a', 'initial');
    const newerSnapshot = snapshot('newer');
    newer.resolve(newerSnapshot);
    await expect(newerRead).resolves.toBe(newerSnapshot);
    older.resolve(snapshot('older'));
    await expect(olderRead).resolves.toEqual(snapshot('older'));

    await expect(cache.read('/root/a', 'initial')).resolves.toBe(newerSnapshot);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not let an older scan replace a newer cache hit', async () => {
    const pending = deferred<WorkflowCatalogSnapshot>();
    const cached = snapshot('cached');
    const read = vi.fn()
      .mockResolvedValueOnce(cached)
      .mockImplementationOnce(() => pending.promise);
    const cache = new WorkflowCatalogCache(read);

    await expect(cache.read('/root/a', 'initial')).resolves.toBe(cached);
    const otherRead = cache.read('/root/b', 'initial');
    await expect(cache.read('/root/a', 'initial')).resolves.toBe(cached);

    pending.resolve(snapshot('other'));
    await expect(otherRead).resolves.toEqual(snapshot('other'));
    await expect(cache.read('/root/a', 'initial')).resolves.toBe(cached);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not let an in-flight scan repopulate the cache after dispose', async () => {
    const pending = deferred<WorkflowCatalogSnapshot>();
    const fresh = snapshot('fresh');
    const read = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(fresh);
    const cache = new WorkflowCatalogCache(read);

    const staleRead = cache.read('/root/a', 'initial');
    cache.dispose();
    pending.resolve(snapshot('stale'));
    await expect(staleRead).resolves.toEqual(snapshot('stale'));

    await expect(cache.read('/root/a', 'initial')).resolves.toBe(fresh);
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
