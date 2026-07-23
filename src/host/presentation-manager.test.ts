import { describe, expect, it } from 'vitest';
import {
  configurePresentationPanel,
  PresentationManager,
  type PresentationDocument,
  type PresentationPanel,
  type PresentationPanelFactory,
} from './presentation-manager';
import { PRESENTATION_MARKDOWN_MAX_LENGTH } from '../task/coordinator-tools';

class FakePanel implements PresentationPanel {
  readonly updates: PresentationDocument[] = [];
  revealCount = 0;
  disposeCount = 0;
  updateResult: boolean | Error = true;
  disposeRegistrationError?: Error;
  disposeDuringUpdate = false;
  revealError?: Error;
  private readonly disposeListeners = new Set<() => void>();

  async update(
    document: PresentationDocument,
    _rootId: string,
  ): Promise<boolean> {
    this.updates.push(document);
    if (this.disposeDuringUpdate) this.dispose();
    if (this.updateResult instanceof Error) throw this.updateResult;
    return this.updateResult;
  }

  reveal(): void {
    if (this.revealError) throw this.revealError;
    this.revealCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
    for (const listener of [...this.disposeListeners]) listener();
  }

  onDidDispose(listener: () => void): { dispose(): void } {
    if (this.disposeRegistrationError) throw this.disposeRegistrationError;
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }
}

class FakeFactory implements PresentationPanelFactory {
  readonly panels: FakePanel[] = [];
  readonly created: PresentationDocument[] = [];
  createError?: Error;
  nextUpdateResult: boolean | Error = true;
  nextDisposeRegistrationError?: Error;
  nextDisposeDuringUpdate = false;

  create(document: PresentationDocument): PresentationPanel {
    if (this.createError) throw this.createError;
    this.created.push(document);
    const panel = new FakePanel();
    panel.updateResult = this.nextUpdateResult;
    panel.disposeRegistrationError = this.nextDisposeRegistrationError;
    panel.disposeDuringUpdate = this.nextDisposeDuringUpdate;
    this.nextUpdateResult = true;
    this.nextDisposeRegistrationError = undefined;
    this.nextDisposeDuringUpdate = false;
    this.panels.push(panel);
    return panel;
  }
}

const context = {
  rootId: 'root-1',
  callerTaskId: 'root-1',
  turnId: 'turn-1',
};

const request = {
  presentationId: 'plan.main',
  ownerTaskId: 'root-1',
  opId: 'op-1',
  revision: 1,
  title: 'Launch plan',
  markdown: '# Launch\n\n<script>hostile()</script>',
};


function withoutHostStamps<T extends { updatedAt?: string }>(doc: T): Omit<T, 'updatedAt'> {
  const { updatedAt: _u, ...rest } = doc;
  return rest;
}

function wireMemoryStore(manager: PresentationManager): Map<string, PresentationDocument> {
  const docs = new Map<string, PresentationDocument>();
  const rootDocs = new Map<string, PresentationDocument>();
  const operations = new Map<string, string>();
  const key = (rootId: string, presentationId: string) => `${rootId}:${presentationId}`;
  manager.setDocumentStore({
    getPresentation: async (rootId, id) => rootDocs.get(key(rootId, id)),
    putPresentation: async (doc) => {
      docs.set(doc.presentationId, doc);
      rootDocs.set(key(doc.rootId, doc.presentationId), doc);
      return true;
    },
    commitPresentationOperation: async ({ operationKey, fingerprint, document }) => {
      const prior = operations.get(operationKey);
      if (prior !== undefined) return prior === fingerprint ? 'idempotent' : 'op_conflict';
      const existing = rootDocs.get(key(document.rootId, document.presentationId));
      if (existing?.ownerTaskId !== undefined && existing.ownerTaskId !== document.ownerTaskId) {
        return 'owner_mismatch';
      }
      if (existing && document.revision <= existing.revision) return 'stale_revision';
      docs.set(document.presentationId, document);
      rootDocs.set(key(document.rootId, document.presentationId), document);
      operations.set(operationKey, fingerprint);
      return 'committed';
    },
  });
  return docs;
}

describe('PresentationManager.openWorkspaceDocument', () => {
  it('opens a new panel for a workspace markdown document', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    const result = await manager.openWorkspaceDocument('root-1', {
      presentationId: 'md:docs-plan.md',
      ownerTaskId: 'root-1',
      title: 'plan',
      markdown: '# From file',
    });
    expect(result).toEqual({ ok: true, code: 'opened' });
    expect(factory.created).toHaveLength(1);
    expect(factory.panels[0].updates[0]).toMatchObject({
      presentationId: 'md:docs-plan.md',
      revision: 1,
      markdown: '# From file',
    });
  });

  it('reveals without bumping when content is unchanged', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.openWorkspaceDocument('root-1', {
      presentationId: 'md:docs-plan.md',
      ownerTaskId: 'root-1',
      title: 'plan',
      markdown: '# Same',
    });
    const result = await manager.openWorkspaceDocument('root-1', {
      presentationId: 'md:docs-plan.md',
      ownerTaskId: 'root-1',
      title: 'plan',
      markdown: '# Same',
    });
    expect(result).toEqual({ ok: true, code: 'idempotent' });
    expect(factory.panels).toHaveLength(1);
    expect(factory.panels[0].revealCount).toBe(1);
    expect(factory.panels[0].updates).toHaveLength(1);
  });

  it('bumps revision when file content changed', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    const docs = wireMemoryStore(manager);
    await manager.openWorkspaceDocument('root-1', {
      presentationId: 'md:docs-plan.md',
      ownerTaskId: 'root-1',
      title: 'plan',
      markdown: '# v1',
    });
    const result = await manager.openWorkspaceDocument('root-1', {
      presentationId: 'md:docs-plan.md',
      ownerTaskId: 'root-1',
      title: 'plan',
      markdown: '# v2',
    });
    expect(result).toEqual({ ok: true, code: 'opened' });
    expect(factory.panels[0].updates.at(-1)?.revision).toBe(2);
    expect(factory.panels[0].updates.at(-1)?.markdown).toBe('# v2');
    expect(docs.get('md:docs-plan.md')?.markdown).toBe('# v2');
  });

  it('continues from the durable revision after a manager restart', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    let stored: PresentationDocument & { rootId: string } = {
      presentationId: 'md:docs-plan.md',
      ownerTaskId: 'root-1',
      rootId: 'root-1',
      revision: 7,
      title: 'plan',
      markdown: '# Before restart',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    manager.setDocumentStore({
      getPresentation: async () => stored,
      putPresentation: async (document) => {
        stored = document;
        return true;
      },
      commitPresentationOperation: async () => 'committed',
    });

    await expect(manager.openWorkspaceDocument('root-1', {
      presentationId: 'md:docs-plan.md',
      ownerTaskId: 'root-1',
      title: 'plan',
      markdown: '# After restart',
    })).resolves.toEqual({ ok: true, code: 'opened' });
    expect(stored.revision).toBe(8);
    expect(factory.panels[0]?.updates[0]?.revision).toBe(8);
  });

  it('fails closed when document store is not wired', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    const result = await manager.openWorkspaceDocument('root-1', {
      presentationId: 'md:docs-plan.md',
      ownerTaskId: 'root-1',
      title: 'plan',
      markdown: '# From file',
    });
    expect(result).toEqual({ ok: false, code: 'host_delivery_failed' });
    expect(factory.created).toHaveLength(0);
  });
});

describe('configurePresentationPanel', () => {
  it('disposes a created host panel when adapter configuration throws', () => {
    const hostPanel = { disposeCount: 0, dispose() { this.disposeCount += 1; } };

    expect(() =>
      configurePresentationPanel(
        hostPanel,
        () => {
          throw new Error('resource setup failed');
        },
      ),
    ).toThrow('resource setup failed');
    expect(hostPanel.disposeCount).toBe(1);
  });
});

describe('PresentationManager', () => {
  it('opens a panel and posts the requested document through the panel boundary', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);

    const result = await manager.upsert(context, request);

    expect(result).toEqual({ ok: true, code: 'opened' });
    expect(factory.created).toHaveLength(1);
    expect(withoutHostStamps(factory.created[0])).toEqual({
      presentationId: 'plan.main',
      ownerTaskId: 'root-1',
      revision: 1,
      title: 'Launch plan',
      markdown: '# Launch\n\n<script>hostile()</script>',
    });
    expect(factory.created[0].updatedAt).toEqual(expect.any(String));
    expect(factory.panels[0].updates).toEqual(factory.created);
  });

  it('rejects an owner mismatch before creating panel state', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);

    const result = await manager.upsert(context, { ...request, ownerTaskId: 'other-task' });

    expect(result).toEqual({ ok: false, code: 'owner_mismatch' });
    expect(factory.created).toEqual([]);
  });

  it('makes exact same-turn operation retries idempotent and rejects conflicting reuse', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);

    expect(await manager.upsert(context, request)).toEqual({ ok: true, code: 'opened' });
    expect(await manager.upsert(context, { ...request })).toEqual({ ok: true, code: 'idempotent' });
    expect(await manager.upsert(context, { ...request, markdown: '# Changed' })).toEqual({
      ok: false,
      code: 'op_conflict',
    });
    expect(factory.panels).toHaveLength(1);
    expect(factory.panels[0].updates).toHaveLength(1);
  });

  it('allocates semantic revisions and replays identical content without a caller revision', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    const docs = wireMemoryStore(manager);
    const semantic = { ...request, revision: undefined };

    expect(await manager.upsert(context, semantic)).toEqual({ ok: true, code: 'opened' });
    expect(docs.get('plan.main')?.revision).toBe(1);
    expect(await manager.upsert(context, semantic)).toEqual({ ok: true, code: 'idempotent' });
    expect(await manager.upsert(
      { ...context, turnId: 'turn-2' },
      { ...semantic, opId: 'op-2', markdown: '# Revised' },
    )).toEqual({ ok: true, code: 'opened' });
    expect(docs.get('plan.main')?.revision).toBe(2);
  });

  it('rejects malformed and oversized requests before calling the panel factory', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);

    await expect(manager.upsert(context, { ...request, revision: 0 })).resolves.toEqual({
      ok: false,
      code: 'invalid_arguments',
    });
    await expect(manager.upsert(context, { ...request, markdown: 'x'.repeat(PRESENTATION_MARKDOWN_MAX_LENGTH + 1) })).resolves.toEqual({
      ok: false,
      code: 'payload_too_large',
    });
    await expect(manager.upsert(context, { ...request, markdown: '# bad\0document' })).resolves.toEqual({
      ok: false,
      code: 'invalid_arguments',
    });
    await expect(
      manager.upsert(context, { ...request, unexpected: true } as typeof request),
    ).resolves.toEqual({ ok: false, code: 'invalid_arguments' });
    expect(factory.created).toEqual([]);
  });

  it('rejects stale and equal same-ID revisions without mutating or revealing the panel', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.upsert(context, { ...request, revision: 2 });

    expect(
      await manager.upsert(context, { ...request, opId: 'op-equal', revision: 2 }),
    ).toEqual({ ok: false, code: 'stale_revision' });
    expect(
      await manager.upsert(context, { ...request, opId: 'op-stale', revision: 1 }),
    ).toEqual({ ok: false, code: 'stale_revision' });
    expect(factory.panels[0].updates.map((document) => document.revision)).toEqual([2]);
    expect(factory.panels[0].revealCount).toBe(0);
  });

  it('keeps the registered owner immutable across authenticated callers', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.upsert(context, request);

    expect(
      await manager.upsert(
        { ...context, callerTaskId: 'other-task' },
        { ...request, ownerTaskId: 'other-task', opId: 'other-op', revision: 2 },
      ),
    ).toEqual({ ok: false, code: 'owner_mismatch' });
    expect(factory.panels[0].updates).toHaveLength(1);
  });

  it('returns a stable host delivery failure when an existing panel rejects an update', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.upsert(context, request);
    factory.panels[0].updateResult = new Error(`delivery leaked ${request.markdown}`);

    expect(await manager.upsert(context, { ...request, opId: 'op-2', revision: 2 })).toEqual({
      ok: false,
      code: 'host_delivery_failed',
    });
  });

  it('posts a newer revision to the existing panel and reveals it', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.upsert(context, request);

    const result = await manager.upsert(context, {
      ...request,
      opId: 'op-2',
      revision: 2,
      title: 'Revised launch plan',
      markdown: '# Revised',
    });

    expect(result).toEqual({ ok: true, code: 'opened' });
    expect(factory.panels).toHaveLength(1);
    expect(factory.panels[0].updates.map((document) => document.revision)).toEqual([1, 2]);
    expect(factory.panels[0].revealCount).toBe(1);
  });

  it('keeps an accepted existing-panel update successful when reveal fails', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.upsert(context, request);
    factory.panels[0].revealError = new Error(`reveal leaked ${request.markdown}`);

    expect(
      await manager.upsert(context, { ...request, opId: 'op-2', revision: 2 }),
    ).toEqual({ ok: true, code: 'opened' });
    expect(await manager.upsert(context, { ...request, opId: 'op-2', revision: 2 })).toEqual({
      ok: true,
      code: 'idempotent',
    });
  });

  it('sanitizes panel factory and initial update failures and disposes partial panels', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    factory.createError = new Error(`factory leaked ${request.markdown}`);

    await expect(manager.upsert(context, request)).resolves.toEqual({
      ok: false,
      code: 'panel_open_failed',
    });

    factory.createError = undefined;
    factory.nextDisposeRegistrationError = new Error(`listener leaked ${request.markdown}`);
    await expect(manager.upsert(context, request)).resolves.toEqual({
      ok: false,
      code: 'panel_open_failed',
    });
    expect(factory.panels[0].disposeCount).toBe(1);

    factory.nextUpdateResult = new Error(`post leaked ${request.markdown}`);
    await expect(manager.upsert(context, request)).resolves.toEqual({
      ok: false,
      code: 'panel_open_failed',
    });
    expect(factory.panels[1].disposeCount).toBe(1);
  });

  it('does not acknowledge or ledger a panel disposed during its initial update', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    factory.nextDisposeDuringUpdate = true;

    expect(await manager.upsert(context, request)).toEqual({
      ok: false,
      code: 'panel_open_failed',
    });
    expect(await manager.upsert(context, request)).toEqual({ ok: true, code: 'idempotent' });
    expect(factory.panels).toHaveLength(2);
  });

  it('recreates disposed panels and ignores stale callbacks from their predecessors', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.upsert(context, request);
    const disposedPanel = factory.panels[0];
    disposedPanel.dispose();

    await manager.upsert(context, { ...request, opId: 'op-2', revision: 2 });
    disposedPanel.dispose();
    await manager.upsert(context, { ...request, opId: 'op-3', revision: 3 });

    expect(factory.panels).toHaveLength(2);
    expect(factory.panels[1].updates.map((document) => document.revision)).toEqual([2, 3]);
  });

  it('keeps distinct presentation IDs under one authenticated root isolated', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.upsert(context, request);
    await manager.upsert(context, {
      ...request,
      presentationId: 'plan.secondary',
      opId: 'op-secondary',
      title: 'Secondary',
    });

    await manager.upsert(context, { ...request, opId: 'op-main-2', revision: 2 });

    expect(factory.panels).toHaveLength(2);
    expect(factory.panels[0].updates.map((document) => document.presentationId)).toEqual([
      'plan.main',
      'plan.main',
    ]);
    expect(factory.panels[0].revealCount).toBe(1);
    expect(factory.panels[1].updates.map((document) => document.presentationId)).toEqual([
      'plan.secondary',
    ]);
    expect(factory.panels[1].revealCount).toBe(0);
    expect(factory.panels[1].disposeCount).toBe(0);
  });

  it('restores via opaque IDs and SQLite document store', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    const docs = new Map<string, import('./presentation-manager').PresentationDocument>();
    docs.set(request.presentationId, {
      presentationId: request.presentationId,
      ownerTaskId: request.ownerTaskId,
      revision: request.revision,
      title: request.title,
      markdown: request.markdown,
    });
    manager.setDocumentStore({
      getPresentation: async (_rootId, id) => docs.get(id),
      putPresentation: async (doc) => {
        docs.set(doc.presentationId, doc);
        return true;
      },
      commitPresentationOperation: async () => 'committed',
    });
    const panel = new FakePanel();

    expect(
      await manager.restore(panel, {
        rootId: context.rootId,
        presentationId: request.presentationId,
      }),
    ).toEqual({ ok: true, code: 'restored' });
    expect(panel.updates).toHaveLength(1);
    expect(withoutHostStamps(panel.updates[0])).toEqual({
      presentationId: request.presentationId,
      ownerTaskId: request.ownerTaskId,
      revision: request.revision,
      title: request.title,
      markdown: request.markdown,
    });
    expect(factory.created).toEqual([]);
  });

  it('validates child ownership against the persisted root without rewriting identity', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    const docs = new Map<string, import('./presentation-manager').PresentationDocument>([
      [request.presentationId, {
        presentationId: request.presentationId,
        ownerTaskId: 'child-1',
        revision: 1,
        title: request.title,
        markdown: request.markdown,
      }],
      ['other-plan', {
        presentationId: 'other-plan',
        ownerTaskId: 'missing',
        revision: 1,
        title: request.title,
        markdown: request.markdown,
      }],
    ]);
    manager.setDocumentStore({
      getPresentation: async (_rootId, id) => docs.get(id),
      putPresentation: async () => true,
      commitPresentationOperation: async () => 'committed',
    });
    manager.setOwnerResolver((ownerId) => (ownerId === 'child-1' || ownerId === 'root-1' ? 'root-1' : undefined));
    const panel = new FakePanel();
    expect(
      await manager.restore(panel, {
        rootId: 'root-1',
        presentationId: request.presentationId,
      }),
    ).toEqual({ ok: true, code: 'restored' });
    expect(panel.updates[0]?.ownerTaskId).toBe('child-1');

    const bad = new FakePanel();
    expect(
      await manager.restore(bad, {
        rootId: 'root-1',
        presentationId: 'other-plan',
      }),
    ).toEqual({ ok: false, code: 'restore_rejected' });
  });

  it('rejects malformed, conflicting, and failed restores with stable content-free codes', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    const docs = new Map<string, import('./presentation-manager').PresentationDocument>([
      [request.presentationId, {
        presentationId: request.presentationId,
        ownerTaskId: request.ownerTaskId,
        revision: request.revision,
        title: request.title,
        markdown: request.markdown,
      }],
    ]);
    manager.setDocumentStore({
      getPresentation: async (_rootId, id) => docs.get(id),
      putPresentation: async () => true,
      commitPresentationOperation: async () => 'committed',
    });
    const persisted = {
      rootId: context.rootId,
      presentationId: request.presentationId,
    };

    const malformedPanel = new FakePanel();
    expect(await manager.restore(malformedPanel, { document: { markdown: 'x' } })).toEqual({
      ok: false,
      code: 'restore_rejected',
    });
    expect(await manager.restore(new FakePanel(), { ...persisted, extra: true })).toEqual({
      ok: false,
      code: 'restore_rejected',
    });
    expect(malformedPanel.updates).toEqual([]);

    const livePanel = new FakePanel();
    expect(await manager.restore(livePanel, persisted)).toEqual({ ok: true, code: 'restored' });
    const conflictPanel = new FakePanel();
    expect(await manager.restore(conflictPanel, persisted)).toEqual({
      ok: false,
      code: 'restore_conflict',
    });
    expect(conflictPanel.updates).toEqual([]);

    livePanel.dispose();
    const registrationFailure = new FakePanel();
    registrationFailure.disposeRegistrationError = new Error(`listener leaked ${request.markdown}`);
    expect(await manager.restore(registrationFailure, persisted)).toEqual({
      ok: false,
      code: 'host_delivery_failed',
    });

    const updateFailure = new FakePanel();
    updateFailure.updateResult = new Error(`update leaked ${request.markdown}`);
    expect(await manager.restore(updateFailure, persisted)).toEqual({
      ok: false,
      code: 'host_delivery_failed',
    });
    expect(await manager.restore(new FakePanel(), persisted)).toEqual({ ok: true, code: 'restored' });
  });

  it('settles queued restores on store failure and extension disposal', async () => {
    const failedManager = new PresentationManager(new FakeFactory());
    const failedPanel = new FakePanel();
    const failedRestore = failedManager.restore(failedPanel, {
      rootId: context.rootId,
      presentationId: request.presentationId,
    });
    failedManager.setDocumentStore({
      getPresentation: async () => {
        throw new Error(`sqlite leaked ${request.markdown}`);
      },
      putPresentation: async () => true,
      commitPresentationOperation: async () => 'committed',
    });
    await expect(failedRestore).resolves.toEqual({ ok: false, code: 'restore_rejected' });

    const disposedManager = new PresentationManager(new FakeFactory());
    const disposedPanel = new FakePanel();
    const disposedRestore = disposedManager.restore(disposedPanel, {
      rootId: context.rootId,
      presentationId: request.presentationId,
    });
    disposedManager.dispose();
    await expect(disposedRestore).resolves.toEqual({ ok: false, code: 'restore_rejected' });
    expect(disposedPanel.disposeCount).toBe(1);
    await expect(disposedManager.restore(new FakePanel(), {
      rootId: context.rootId,
      presentationId: request.presentationId,
    })).resolves.toEqual({ ok: false, code: 'restore_rejected' });
  });

  it('cancels a queued restore already waiting inside SQLite when disposed', async () => {
    const manager = new PresentationManager(new FakeFactory());
    const panel = new FakePanel();
    let release!: (document: import('./presentation-manager').PresentationDocument) => void;
    const durableRead = new Promise<import('./presentation-manager').PresentationDocument>((resolve) => {
      release = resolve;
    });
    const restoring = manager.restore(panel, {
      rootId: context.rootId,
      presentationId: request.presentationId,
    });
    manager.setDocumentStore({
      getPresentation: async () => durableRead,
      putPresentation: async () => true,
      commitPresentationOperation: async () => 'committed',
    });

    manager.dispose();
    await expect(restoring).resolves.toEqual({ ok: false, code: 'restore_rejected' });
    expect(panel.disposeCount).toBe(1);

    release({
      presentationId: request.presentationId,
      ownerTaskId: request.ownerTaskId,
      revision: 1,
      title: request.title,
      markdown: request.markdown,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.updates).toEqual([]);
    expect(panel.disposeCount).toBe(1);
  });

  it('isolates identical presentation IDs by authenticated root and disposes all live panels', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    wireMemoryStore(manager);
    await manager.upsert(context, request);
    await manager.upsert(
      { ...context, rootId: 'root-2', turnId: 'turn-2' },
      { ...request, opId: 'op-root-2' },
    );

    expect(factory.panels).toHaveLength(2);
    manager.dispose();

    expect(factory.panels.map((panel) => panel.disposeCount)).toEqual([1, 1]);
  });
});
