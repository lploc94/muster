import {
  configurePresentationPanel,
  type PresentationDocument,
  type PresentationPanel,
  type PresentationPanelFactory,
  type PresentationResult,
} from './presentation-manager';
import { buildPresentationWebviewHtml, parseAllowedPresentationLink } from './webview-security';

export type RevealLinkedChat = (ownerTaskId: string) => PromiseLike<boolean> | boolean;

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
  revealLinkedChat?: RevealLinkedChat,
): PresentationPanel {
  configureWebview(host, panel, extensionUri);
  let disposed = false;
  let revealPending = false;
  let boundOwnerTaskId = ownerTaskId;
  panel.onDidDispose(() => { disposed = true; });
  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const data = message as Record<string, unknown>;
    if (Object.keys(data).length === 1 && data.type === 'revealLinkedChat') {
      if (disposed || revealPending || !boundOwnerTaskId || !revealLinkedChat) return;
      revealPending = true;
      void Promise.resolve().then(() => revealLinkedChat(boundOwnerTaskId!)).then(
        (ok) => postRevealResult(ok ? 'success' : 'failure'),
        () => postRevealResult('failure'),
      );
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
    async update(document: PresentationDocument): Promise<boolean> {
      if (boundOwnerTaskId && document.ownerTaskId !== boundOwnerTaskId) return false;
      if (!boundOwnerTaskId) boundOwnerTaskId = document.ownerTaskId;
      const accepted = await panel.webview.postMessage({ type: 'presentationUpdate', document });
      if (accepted) {
        try { panel.title = document.title; } catch { /* editor chrome is best-effort */ }
      }
      return accepted;
    },
    reveal: () => panel.reveal(host.besideColumn, false),
    dispose: () => panel.dispose(),
    onDidDispose: (listener) => panel.onDidDispose(listener),
  };
}

export function createPresentationPanelFactory(
  host: PresentationHost,
  extensionUri: unknown,
  revealLinkedChat?: RevealLinkedChat,
): PresentationPanelFactory {
  return {
    create(document: PresentationDocument): PresentationPanel {
      const resourceRoot = host.joinPath(extensionUri, 'dist', 'webview');
      const panel = host.createPanel(
        'muster.presentation',
        document.title,
        { viewColumn: host.besideColumn, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resourceRoot] },
      );
      return configurePresentationPanel(panel, () =>
        createPresentationPanelAdapter(host, panel, extensionUri, document.ownerTaskId, revealLinkedChat),
      );
    },
  };
}

export function createPresentationPanelSerializer(
  host: PresentationHost,
  extensionUri: unknown,
  manager: PresentationRestorer,
  revealLinkedChat?: RevealLinkedChat,
): { deserializeWebviewPanel(panel: VscodePanelLike, state: unknown): Promise<void> } {
  return {
    async deserializeWebviewPanel(panel, state): Promise<void> {
      let adapter: PresentationPanel;
      try {
        adapter = createPresentationPanelAdapter(host, panel, extensionUri, undefined, revealLinkedChat);
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
