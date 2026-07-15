/**
 * Custom scrollbar for shadow-DOM scroll surfaces.
 *
 * Light-DOM scrollbars (task list, chat thread, tool cards, the composer textarea,
 * settings) are styled by the standard `scrollbar-width`/`scrollbar-color` rules in
 * app.css — VS Code's webview Chromium honours those but ignores `::-webkit-scrollbar`.
 * This module does not touch them.
 *
 * This module handles the one surface app.css cannot reach: the `<vscode-scrollable>`
 * custom scrollbar inside vscode-elements components (e.g. the model-picker
 * dropdown), which draws its own `.scrollbar-thumb` div — a plain class that DOES
 * work through adopted stylesheets. Its thumb defaults to a translucent,
 * auto-hiding slider; we override it to an opaque, thin, always-visible bar.
 *
 * The sheet is adopted recursively into every open shadow root. A MutationObserver
 * per root keeps adopting into shadow roots that appear later — components render
 * asynchronously (Lit) and the dropdown's scrollable only materialises when opened,
 * neither of which a document-level observer can see (mutations inside a shadow
 * root do not bubble out).
 */

const SCROLLBAR_CSS = `
.scrollbar-thumb.visible,
.scrollbar-thumb.fade {
  width: 5px !important;
  background-color: var(--vscode-descriptionForeground) !important;
  opacity: 1 !important;
  border-radius: 3px;
}
.scrollbar-thumb.visible:hover,
.scrollbar-thumb.visible.active,
.scrollbar-thumb.visible.active:hover {
  background-color: var(--vscode-foreground) !important;
}
`;

function buildSheet(): CSSStyleSheet | null {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SCROLLBAR_CSS);
    return sheet;
  } catch {
    return null;
  }
}

const sheet = buildSheet();
const observedRoots = new WeakSet<Document | ShadowRoot>();

/** Adopt the shared sheet into a shadow root, once. */
function adopt(root: ShadowRoot): void {
  if (!sheet) return;
  try {
    if (!root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
  } catch {
    /* adoptedStyleSheets unsupported on this root — ignore. */
  }
}

/** If the element hosts an open shadow root, process it (adopt + observe). */
function processElement(el: Element): void {
  const shadow = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
  if (shadow) processRoot(shadow);
}

/** Adopt into a root, descend into any existing shadow roots, then watch it. */
function processRoot(root: Document | ShadowRoot): void {
  if (root instanceof ShadowRoot) adopt(root);
  const host = root instanceof Document ? root.documentElement : root;
  for (const el of host.querySelectorAll('*')) processElement(el);
  observe(root);
}

/** Watch a root for later-added shadow hosts (async renders, dropdown open). */
function observe(root: Document | ShadowRoot): void {
  if (observedRoots.has(root)) return;
  observedRoots.add(root);
  const target = root instanceof Document ? root.documentElement : root;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        processElement(node);
        for (const el of node.querySelectorAll('*')) processElement(el);
      }
    }
  });
  observer.observe(target, { childList: true, subtree: true });
}

let installed = false;

/**
 * Install the custom scrollbar across the whole webview. Idempotent — safe to
 * call once at startup.
 */
export function installCustomScrollbars(): void {
  if (installed) return;
  installed = true;

  if (!sheet) {
    // Constructable stylesheets unavailable: fall back to a plain <style>. This only
    // reaches any light-DOM `.scrollbar-thumb`; shadow-DOM ones need adoption, but
    // this path is virtually never hit in a supported webview.
    const style = document.createElement('style');
    style.textContent = SCROLLBAR_CSS;
    document.head.appendChild(style);
    return;
  }

  // Adopt into the document too, so any light-DOM `.scrollbar-thumb` is covered;
  // processRoot then descends into the shadow roots that actually host them.
  try {
    if (!document.adoptedStyleSheets.includes(sheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
  } catch {
    /* ignore */
  }

  processRoot(document);
}
