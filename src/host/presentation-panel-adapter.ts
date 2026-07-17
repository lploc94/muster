import {
  configurePresentationPanel,
  type PresentationDocument,
  type PresentationPanel,
  type PresentationPanelFactory,
  type PresentationResult,
} from './presentation-manager';
import { buildPresentationWebviewHtml, parseAllowedPresentationLink } from './webview-security';
import { statSync } from 'node:fs';

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
  const scriptFile = host.joinPath(assets, 'presentation.js');
  const styleFile = host.joinPath(assets, 'presentation.css');
  const version = (resource: unknown): string => {
    if (typeof resource !== 'object' || resource === null || !('fsPath' in resource)) return '0';
    const fsPath = (resource as { fsPath?: unknown }).fsPath;
    if (typeof fsPath !== 'string') return '0';
    try {
      return String(Math.trunc(statSync(fsPath).mtimeMs));
    } catch {
      return '0';
    }
  };
  panel.webview.html = buildPresentationWebviewHtml({
    cspSource: panel.webview.cspSource,
    scriptUri: `${panel.webview.asWebviewUri(scriptFile).toString()}?v=${version(scriptFile)}`,
    styleUri: `${panel.webview.asWebviewUri(styleFile).toString()}?v=${version(styleFile)}`,
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
  let readyVersion = 0;
  panel.onDidDispose(() => { disposed = true; });
  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const data = message as Record<string, unknown>;
    if (Object.keys(data).length === 1 && data.type === 'presentationReady') {
      readyVersion += 1;
      if (!disposed && lastDocument && lastRootId) {
        void Promise.resolve(postPresentationUpdate(lastDocument, lastRootId)).catch(() => undefined);
      }
      return;
    }
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

  function postPresentationUpdate(
    document: PresentationDocument,
    rootId: string,
  ): PromiseLike<boolean> {
    return panel.webview.postMessage({ type: 'presentationUpdate', document, rootId });
  }

  return {
    async update(
      document: PresentationDocument,
      rootId: string,
    ): Promise<boolean> {
      if (boundOwnerTaskId && document.ownerTaskId !== boundOwnerTaskId) {
        return false;
      }
      if (!boundOwnerTaskId) boundOwnerTaskId = document.ownerTaskId;
      const readyAtSend = readyVersion;
      const accepted = await postPresentationUpdate(document, rootId);
      if (accepted) {
        lastDocument = document;
        lastRootId = rootId;
        try { panel.title = document.title; } catch { /* editor chrome is best-effort */ }
        // If readiness raced the initial delivery, its handler had no accepted
        // document to replay. Deliver once more now that the cache is bound.
        if (readyVersion !== readyAtSend && !disposed) {
          try {
            await postPresentationUpdate(document, rootId);
          } catch {
            // The original accepted delivery remains authoritative.
          }
        }
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
      // Do not await delivery here. VS Code does not consider a restored panel
      // fully live until this serializer returns, while postMessage can depend on
      // the panel becoming live. The adapter's presentationReady handshake closes
      // the delivery race after the bootstrap has mounted.
      console.log('Muster: presentation restore scheduled');
      void Promise.resolve(manager.restore(adapter, state)).then(
        (result) => {
          console.log(`Muster: presentation restore ${result.code}`);
          if (!result.ok) {
            try { panel.dispose(); } catch { /* rejection remains content-free */ }
          }
        },
        () => {
          console.warn('Muster: presentation restore failed');
          try { panel.dispose(); } catch { /* rejection remains content-free */ }
        },
      );
    },
  };
}
