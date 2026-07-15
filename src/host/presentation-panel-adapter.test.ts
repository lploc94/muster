import { describe, expect, it, vi } from 'vitest';
import {
  createPresentationPanelAdapter,
  createPresentationPanelFactory,
  createPresentationPanelSerializer,
  type PresentationHost,
  type VscodePanelLike,
} from './presentation-panel-adapter';

function fakePanel(): VscodePanelLike & { disposeCount: number; messages: unknown[]; receive(message: unknown): void; fireDispose(): void } {
  const messages: unknown[] = [];
  let receiveListener: (message: unknown) => void = () => undefined;
  let disposeListener: () => void = () => undefined;
  return {
    title: 'Waiting',
    disposeCount: 0,
    webview: {
      cspSource: 'vscode-webview://presentation',
      html: '',
      asWebviewUri: (uri) => uri,
      postMessage: async (message) => { messages.push(message); return true; },
      onDidReceiveMessage: (listener) => { receiveListener = listener; return { dispose() {} }; },
    },
    messages,
    receive(message) { receiveListener(message); },
    fireDispose() { disposeListener(); },
    reveal() {},
    dispose() { this.disposeCount += 1; },
    onDidDispose: (listener) => { disposeListener = listener; return { dispose() {} }; },
  };
}

const host: PresentationHost = {
  joinPath: (...parts) => parts.join('/'),
  createPanel: () => fakePanel(),
  openExternal: async () => true,
  parseUri: (value) => value,
  besideColumn: 2,
};

describe('presentation panel adapter', () => {
  it('configures stable filesystem-resolvable presentation assets and delivers updates', async () => {
    const panel = fakePanel();
    const adapter = createPresentationPanelAdapter(host, panel, '/extension');

    await adapter.update({ presentationId: 'plan.main', ownerTaskId: 'root', revision: 1, title: 'Plan', markdown: '# Plan' });

    expect(panel.webview.html).toContain('/extension/dist/webview/assets/presentation.css');
    expect(panel.webview.html).toContain('presentation.js?v=0');
    expect(panel.webview.html).toContain('presentation.css?v=0');
    expect(panel.webview.html).not.toContain('?inline');
    expect(panel.messages).toEqual([{ type: 'presentationUpdate', document: expect.objectContaining({ revision: 1 }) }]);
    expect(panel.title).toBe('Plan');
  });

  it('derives reveal identity from its immutable owner and returns a typed result', async () => {
    const panel = fakePanel();
    const revealLinkedChat = vi.fn().mockResolvedValue(true);
    createPresentationPanelAdapter(host, panel, '/extension', 'owner-task', revealLinkedChat);

    panel.receive({ type: 'revealLinkedChat' });
    await vi.waitFor(() => expect(revealLinkedChat).toHaveBeenCalledWith('owner-task'));
    await vi.waitFor(() => expect(panel.messages).toContainEqual({ type: 'revealLinkedChatResult', status: 'success' }));
  });

  it('rejects forged, concurrent, disposed, and failed reveal requests without leaking errors', async () => {
    const panel = fakePanel();
    let resolveReveal!: (value: boolean) => void;
    const revealLinkedChat = vi.fn(() => new Promise<boolean>((resolve) => { resolveReveal = resolve; }));
    createPresentationPanelAdapter(host, panel, '/extension', 'owner-task', revealLinkedChat);

    panel.receive({ type: 'revealLinkedChat', ownerTaskId: 'forged' });
    panel.receive({ type: 'revealLinkedChat' });
    panel.receive({ type: 'revealLinkedChat' });
    await vi.waitFor(() => expect(revealLinkedChat).toHaveBeenCalledTimes(1));
    panel.fireDispose();
    resolveReveal(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.messages).not.toContainEqual(expect.objectContaining({ type: 'revealLinkedChatResult' }));

    const failedPanel = fakePanel();
    createPresentationPanelAdapter(host, failedPanel, '/extension', 'owner-task', async () => { throw new Error('private transcript'); });
    failedPanel.receive({ type: 'revealLinkedChat' });
    await vi.waitFor(() => expect(failedPanel.messages).toContainEqual({ type: 'revealLinkedChatResult', status: 'failure' }));
    expect(JSON.stringify(failedPanel.messages)).not.toContain('private transcript');
  });

  it('binds restored adapters to the first owner and rejects later owner changes', async () => {
    const panel = fakePanel();
    const revealLinkedChat = vi.fn().mockResolvedValue(true);
    const adapter = createPresentationPanelAdapter(host, panel, '/extension', undefined, revealLinkedChat);

    expect(await adapter.update({ presentationId: 'p', ownerTaskId: 'restored-owner', revision: 1, title: 'T', markdown: 'M' })).toBe(true);
    expect(await adapter.update({ presentationId: 'p', ownerTaskId: 'changed-owner', revision: 2, title: 'T2', markdown: 'M2' })).toBe(false);
    panel.receive({ type: 'revealLinkedChat' });
    await vi.waitFor(() => expect(revealLinkedChat).toHaveBeenCalledWith('restored-owner'));
  });

  it('replays the accepted document after a restored webview reports ready', async () => {
    const panel = fakePanel();
    let webviewReady = false;
    panel.webview.postMessage = async (message) => {
      // VS Code can accept a host post before the restored page has mounted,
      // while no page listener exists to consume it.
      if (webviewReady) panel.messages.push(message);
      return true;
    };
    const adapter = createPresentationPanelAdapter(host, panel, '/extension');
    const document = {
      presentationId: 'restored-plan',
      ownerTaskId: 'root',
      revision: 2,
      title: 'Restored plan',
      markdown: '# Restored',
    };

    expect(await adapter.update(document, 'root', { restore: true })).toBe(true);
    expect(panel.messages).toEqual([]);

    webviewReady = true;
    panel.receive({ type: 'presentationReady' });
    await vi.waitFor(() => expect(panel.messages).toEqual([
      { type: 'presentationUpdate', document, rootId: 'root', restore: true },
    ]));

    panel.messages.length = 0;
    panel.receive({ type: 'presentationReady', forged: true });
    await Promise.resolve();
    expect(panel.messages).toEqual([]);
  });

  it('factory disposes a host panel when configuration fails', () => {
    const panel = fakePanel();
    panel.webview.asWebviewUri = () => { throw new Error('assets unavailable'); };
    const factory = createPresentationPanelFactory({ ...host, createPanel: () => panel }, '/extension');

    expect(() => factory.create({ presentationId: 'p', ownerTaskId: 'r', revision: 1, title: 'T', markdown: 'M' })).toThrow('assets unavailable');
    expect(panel.disposeCount).toBe(1);
  });

  it('serializer rebinds accepted state and disposes rejected restored panels', async () => {
    const accepted = fakePanel();
    const rejected = fakePanel();
    const restore = vi.fn().mockResolvedValueOnce({ ok: true, code: 'restored' }).mockResolvedValueOnce({ ok: false, code: 'restore_rejected' });
    const serializer = createPresentationPanelSerializer(host, '/extension', { restore });

    await serializer.deserializeWebviewPanel(accepted, { rootId: 'r' });
    await serializer.deserializeWebviewPanel(rejected, { broken: true });

    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    expect(accepted.disposeCount).toBe(0);
    await vi.waitFor(() => expect(rejected.disposeCount).toBe(1));
  });

  it('does not keep VS Code waiting for host delivery before a restored panel becomes live', async () => {
    const panel = fakePanel();
    const restore = vi.fn(() => new Promise<never>(() => undefined));
    const serializer = createPresentationPanelSerializer(host, '/extension', { restore });

    let serializerReturned = false;
    void serializer.deserializeWebviewPanel(panel, { rootId: 'r' }).then(() => {
      serializerReturned = true;
    });

    await vi.waitFor(() => expect(serializerReturned).toBe(true));
    expect(restore).toHaveBeenCalledTimes(1);
    expect(panel.disposeCount).toBe(0);
  });
});
