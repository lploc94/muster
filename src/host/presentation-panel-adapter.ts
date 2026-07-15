import {
  configurePresentationPanel,
  type PresentationDocument,
  type PresentationPanel,
  type PresentationPanelFactory,
  type PresentationResult,
} from './presentation-manager';
import { buildPresentationWebviewHtml, parseAllowedPresentationLink } from './webview-security';

export type RevealLinkedChat = (ownerTaskId: string) => PromiseLike<boolean> | boolean;
export type OpenPresentationSource = (document: PresentationDocument) => PromiseLike<void> | void;
export type OpenWorkspaceMarkdownFromPresentation = (
  href: string,
  origin: { rootId: string; document: PresentationDocument },
) => PromiseLike<void> | void;

export interface DisposableLike { dispose(): void }

export interface VscodePanelLike {
  title: string;
  webview: {
    cspSource: string;
    html: string;
    asWebviewUri(uri: unknown): { toString(): string } | string;
    postMessage(message: unknown): PromiseLike<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => void): DisposableLike;
  };
  reveal(column: unknown, preserveFocus: boolean): void;
  dispose(): void;
  onDidDispose(listener: () => void): DisposableLike;
}

export interface PresentationHost {
  joinPath(...parts: unknown[]): unknown;
  createPanel(
    viewType: string,
    title: string,
    showOptions: unknown,
    options: unknown,
  ): VscodePanelLike;
  openExternal(uri: unknown): PromiseLike<unknown>;
  parseUri(value: string): unknown;
  besideColumn: unknown;
}

export interface PresentationPanelHandlers {
  revealLinkedChat?: RevealLinkedChat;
  openPresentationSource?: OpenPresentationSource;
  openWorkspaceMarkdown?: OpenWorkspaceMarkdownFromPresentation;
}

interface PresentationRestorer {
  restore(panel: PresentationPanel, state: unknown): Promise<PresentationResult>;
}

function configureWebview(host: PresentationHost, panel: VscodePanelLike, extensionUri: unknown): void {
  const resourceRoot = host.joinPath(extensionUri, 'dist', 'webview');
  const assets = host.joinPath(resourceRoot, 'assets');
  panel.webview.html = buildPresentationWebviewHtml({
    cspSource: panel.webview.cspSource,
    scriptUri: panel.webview.asWebviewUri(host.joinPath(assets, 'presentation.js')).toString(),
    styleUri: panel.webview.asWebviewUri(host.joinPath(assets, 'presentation.css')).toString(),
  });
}

export function createPresentationPanelAdapter(
  host: PresentationHost,
  panel: VscodePanelLike,
  extensionUri: unknown,
  ownerTaskId?: string,
  revealLinkedChatOrHandlers?: RevealLinkedChat | PresentationPanelHandlers,
): PresentationPanel {
  const handlers: PresentationPanelHandlers =
    typeof revealLinkedChatOrHandlers === 'function'
      ? { revealLinkedChat: revealLinkedChatOrHandlers }
      : revealLinkedChatOrHandlers ?? {};
  configureWebview(host, panel, extensionUri);
  let disposed = false;
  let revealPending = false;
  let boundOwnerTaskId = ownerTaskId;
  let lastDocument: PresentationDocument | undefined;
  let lastRootId: string | undefined;
  panel.onDidDispose(() => { disposed = true; });
  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const data = message as Record<string, unknown>;
    if (Object.keys(data).length === 1 && data.type === 'revealLinkedChat') {
      if (disposed || revealPending || !boundOwnerTaskId || !handlers.revealLinkedChat) return;
      revealPending = true;
      void Promise.resolve().then(() => handlers.revealLinkedChat!(boundOwnerTaskId!)).then(
        (ok) => postRevealResult(ok ? 'success' : 'failure'),
        () => postRevealResult('failure'),
      );
      return;
    }
    if (Object.keys(data).length === 1 && data.type === 'openPresentationSource') {
      if (disposed || !handlers.openPresentationSource || !lastDocument) return;
      const doc = lastDocument;
      void Promise.resolve()
        .then(() => handlers.openPresentationSource!(doc))
        .catch(() => undefined);
      return;
    }
    if (data.type === 'openWorkspaceMarkdown' && typeof data.href === 'string') {
      if (disposed || !handlers.openWorkspaceMarkdown || !lastDocument || !lastRootId) return;
      const href = data.href;
      if (!href || href.length > 4096 || href.includes('\0')) return;
      const origin = { rootId: lastRootId, document: lastDocument };
      void Promise.resolve()
        .then(() => handlers.openWorkspaceMarkdown!(href, origin))
        .catch(() => undefined);
      return;
    }
    if (data.type !== 'openExternal') return;
    const allowedUrl = parseAllowedPresentationLink(data.url);
    if (!allowedUrl) return;
    try {
      void Promise.resolve(host.openExternal(host.parseUri(allowedUrl))).catch(() => undefined);
    } catch {
      // Invalid navigation and host failures remain inert and content-free.
    }
  });

  function postRevealResult(status: 'success' | 'failure'): void {
    revealPending = false;
    if (disposed) return;
    try {
      void Promise.resolve(panel.webview.postMessage({ type: 'revealLinkedChatResult', status })).catch(() => undefined);
    } catch {
      // Host delivery errors remain local and content-free.
    }
  }

  return {
    async update(
      document: PresentationDocument,
      rootId?: string,
      options?: { restore?: boolean },
    ): Promise<boolean> {
      if (boundOwnerTaskId && document.ownerTaskId !== boundOwnerTaskId) {
        if (!options?.restore) return false;
        // Host-authorized restore migration may rebind owner once.
        boundOwnerTaskId = document.ownerTaskId;
      }
      if (!boundOwnerTaskId) boundOwnerTaskId = document.ownerTaskId;
      const message: Record<string, unknown> = { type: 'presentationUpdate', document };
      if (rootId !== undefined) message.rootId = rootId;
      if (options?.restore) message.restore = true;
      const accepted = await panel.webview.postMessage(message);
      if (accepted) {
        lastDocument = document;
        if (rootId !== undefined) lastRootId = rootId;
        try { panel.title = document.title; } catch { /* editor chrome is best-effort */ }
      }
      return accepted;
    },
    reveal: () => panel.reveal(host.besideColumn, false),
    dispose: () => panel.dispose(),
    onDidDispose: (listener) => panel.onDidDispose(listener),
    navigateFragment: (fragment: string) => {
      if (disposed || !/^[A-Za-z0-9._:-]+$/.test(fragment)) return false;
      return panel.webview.postMessage({ type: 'navigatePresentationFragment', fragment });
    },
  };
}

export function createPresentationPanelFactory(
  host: PresentationHost,
  extensionUri: unknown,
  revealLinkedChatOrHandlers?: RevealLinkedChat | PresentationPanelHandlers,
): PresentationPanelFactory {
  return {
    create(document: PresentationDocument): PresentationPanel {
      const resourceRoot = host.joinPath(extensionUri, 'dist', 'webview');
      const panel = host.createPanel(
        'muster.presentation',
        document.title,
        { viewColumn: host.besideColumn, preserveFocus: false },
        {
          enableScripts: true,
          enableFindWidget: true,
          retainContextWhenHidden: true,
          localResourceRoots: [resourceRoot],
        },
      );
      return configurePresentationPanel(panel, () =>
        createPresentationPanelAdapter(
          host,
          panel,
          extensionUri,
          document.ownerTaskId,
          revealLinkedChatOrHandlers,
        ),
      );
    },
  };
}

export function createPresentationPanelSerializer(
  host: PresentationHost,
  extensionUri: unknown,
  manager: PresentationRestorer,
  revealLinkedChatOrHandlers?: RevealLinkedChat | PresentationPanelHandlers,
): { deserializeWebviewPanel(panel: VscodePanelLike, state: unknown): Promise<void> } {
  return {
    async deserializeWebviewPanel(panel, state): Promise<void> {
      let adapter: PresentationPanel;
      try {
        adapter = createPresentationPanelAdapter(
          host,
          panel,
          extensionUri,
          undefined,
          revealLinkedChatOrHandlers,
        );
      } catch {
        try { panel.dispose(); } catch { /* preserve fail-closed restore */ }
        return;
      }
      const result = await manager.restore(adapter, state);
      if (!result.ok) {
        try { panel.dispose(); } catch { /* rejection remains content-free */ }
      }
    },
  };
}
