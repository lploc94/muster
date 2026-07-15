import { describe, expect, it } from 'vitest';
import {
  configurePresentationPanel,
  PresentationManager,
  type PresentationDocument,
  type PresentationPanel,
  type PresentationPanelFactory,
} from './presentation-manager';

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
    _rootId?: string,
    _options?: { restore?: boolean },
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

describe('PresentationManager.openWorkspaceDocument', () => {
  it('opens a new panel for a workspace markdown document', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
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

    const result = await manager.upsert(context, { ...request, ownerTaskId: 'other-task' });

    expect(result).toEqual({ ok: false, code: 'owner_mismatch' });
    expect(factory.created).toEqual([]);
  });

  it('makes exact same-turn operation retries idempotent and rejects conflicting reuse', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);

    expect(await manager.upsert(context, request)).toEqual({ ok: true, code: 'opened' });
    expect(await manager.upsert(context, { ...request })).toEqual({ ok: true, code: 'idempotent' });
    expect(await manager.upsert(context, { ...request, markdown: '# Changed' })).toEqual({
      ok: false,
      code: 'op_conflict',
    });
    expect(factory.panels).toHaveLength(1);
    expect(factory.panels[0].updates).toHaveLength(1);
  });

  it('rejects malformed and oversized requests before calling the panel factory', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);

    await expect(manager.upsert(context, { ...request, revision: 0 })).resolves.toEqual({
      ok: false,
      code: 'invalid_arguments',
    });
    await expect(manager.upsert(context, { ...request, markdown: 'x'.repeat(100_001) })).resolves.toEqual({
      ok: false,
      code: 'payload_too_large',
    });
    await expect(
      manager.upsert(context, { ...request, unexpected: true } as typeof request),
    ).resolves.toEqual({ ok: false, code: 'invalid_arguments' });
    expect(factory.created).toEqual([]);
  });

  it('rejects stale and equal same-ID revisions without mutating or revealing the panel', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
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
    factory.nextDisposeDuringUpdate = true;

    expect(await manager.upsert(context, request)).toEqual({
      ok: false,
      code: 'panel_open_failed',
    });
    expect(await manager.upsert(context, request)).toEqual({ ok: true, code: 'opened' });
    expect(factory.panels).toHaveLength(2);
  });

  it('recreates disposed panels and ignores stale callbacks from their predecessors', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
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

  it('restores an exact persisted document by binding the supplied panel', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    const panel = new FakePanel();

    expect(
      await manager.restore(panel, {
        rootId: context.rootId,
        presentationId: request.presentationId,
        ownerTaskId: request.ownerTaskId,
        revision: request.revision,
        title: request.title,
        markdown: request.markdown,
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

  it('migrates legacy child owner to root when resolver is set, rejects unresolved owners', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    manager.setOwnerResolver((ownerId) => (ownerId === 'child-1' || ownerId === 'root-1' ? 'root-1' : undefined));
    const panel = new FakePanel();
    expect(
      await manager.restore(panel, {
        rootId: 'root-1',
        presentationId: request.presentationId,
        ownerTaskId: 'child-1',
        revision: 1,
        title: request.title,
        markdown: request.markdown,
      }),
    ).toEqual({ ok: true, code: 'restored' });
    expect(panel.updates[0]?.ownerTaskId).toBe('root-1');

    const bad = new FakePanel();
    expect(
      await manager.restore(bad, {
        rootId: 'root-1',
        presentationId: 'other-plan',
        ownerTaskId: 'missing',
        revision: 1,
        title: request.title,
        markdown: request.markdown,
      }),
    ).toEqual({ ok: false, code: 'restore_rejected' });
  });

  it('rejects malformed, conflicting, and failed restores with stable content-free codes', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
    const persisted = {
      rootId: context.rootId,
      presentationId: request.presentationId,
      ownerTaskId: request.ownerTaskId,
      revision: request.revision,
      title: request.title,
      markdown: request.markdown,
    };

    const malformedPanel = new FakePanel();
    expect(await manager.restore(malformedPanel, { ...persisted, unexpected: request.markdown })).toEqual({
      ok: false,
      code: 'restore_rejected',
    });
    expect(malformedPanel.updates).toEqual([]);

    const livePanel = new FakePanel();
    expect(await manager.restore(livePanel, persisted)).toEqual({ ok: true, code: 'restored' });
    const conflictPanel = new FakePanel();
    expect(await manager.restore(conflictPanel, { ...persisted, revision: 2 })).toEqual({
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

  it('isolates identical presentation IDs by authenticated root and disposes all live panels', async () => {
    const factory = new FakeFactory();
    const manager = new PresentationManager(factory);
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
