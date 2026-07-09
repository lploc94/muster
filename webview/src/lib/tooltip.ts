// Instant hover tooltip — a Svelte action replacing the native `title` attribute,
// which the browser shows only after a ~1s delay that cannot be configured.
//
// Usage:  <button use:tip={'Label'}>  or  <span use:tip={dynamicText}>
//
// The tooltip is drawn into <body> as a fixed-position element on mouseenter (so
// it appears immediately), positioned below the target and flipped above / clamped
// horizontally to stay within the (narrow) webview viewport.

export function tip(node: HTMLElement, text: string | null | undefined) {
  let current = text;
  let el: HTMLDivElement | null = null;

  function place() {
    if (!el) return;
    const r = node.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - t.width - 4));
    let top = r.bottom + 4;
    if (top + t.height > window.innerHeight - 4) top = r.top - t.height - 4;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function show() {
    if (!current || el) return;
    el = document.createElement('div');
    el.className = 'tt-pop';
    el.textContent = current;
    document.body.appendChild(el);
    place();
  }

  function hide() {
    el?.remove();
    el = null;
  }

  node.addEventListener('mouseenter', show);
  node.addEventListener('mouseleave', hide);
  node.addEventListener('mousedown', hide);

  return {
    update(next: string | null | undefined) {
      current = next;
      if (el) {
        if (!next) {
          hide();
        } else {
          el.textContent = next;
          place();
        }
      }
    },
    destroy() {
      hide();
      node.removeEventListener('mouseenter', show);
      node.removeEventListener('mouseleave', hide);
      node.removeEventListener('mousedown', hide);
    },
  };
}
