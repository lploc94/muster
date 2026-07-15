<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { renderMermaidDiagram } from './lib/mermaid-renderer';
  import { renderPresentationMarkdown } from './lib/presentation-markdown';
  import {
    applyPresentationUpdate,
    buildPersistedState,
    kindLabel,
    parsePersistedPresentation,
    parsePersistedPresentationState,
    parsePresentationRevealResult,
    parsePresentationUpdate,
    type PresentationDocument,
  } from './lib/presentation-protocol';
  import { vscode } from './lib/vscode';

  function initialDocument(): PresentationDocument | undefined {
    const state = vscode.getState();
    const envelope = parsePersistedPresentationState(state);
    if (envelope) return envelope.document;
    return parsePersistedPresentation(state);
  }

  function initialRootId(): string | undefined {
    return parsePersistedPresentationState(vscode.getState())?.rootId;
  }

  let document = $state<PresentationDocument | undefined>(initialDocument());
  let rootId = $state<string | undefined>(initialRootId());
  let article = $state<HTMLElement>();
  let renderGeneration = 0;
  let revealStatus = $state<'idle' | 'pending' | 'success' | 'failure'>('idle');
  let copyStatus = $state<'idle' | 'copied' | 'failed'>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
  let revealResetTimer: ReturnType<typeof setTimeout> | undefined;
  const rendered = $derived(document ? renderPresentationMarkdown(document.markdown) : undefined);

  function persist(): void {
    if (!document) return;
    vscode.setState(buildPersistedState(rootId, document));
  }

  function showFallback(element: HTMLElement, reason: string, source: string): void {
    element.replaceChildren();
    element.dataset.mermaidState = 'fallback';
    element.dataset.mermaidReason = reason;
    const message = window.document.createElement('p');
    message.className = 'mermaid-fallback__reason';
    message.setAttribute('role', 'status');
    message.textContent = `Diagram could not be rendered (${reason}).`;
    const pre = window.document.createElement('pre');
    pre.className = 'mermaid-fallback__source';
    const code = window.document.createElement('code');
    code.textContent = source;
    pre.append(code);
    element.append(message, pre);
  }

  async function renderDiagrams(generation: number): Promise<void> {
    await tick();
    if (!article || generation !== renderGeneration || !rendered) return;
    for (const diagram of rendered.diagrams) {
      if (generation !== renderGeneration) return;
      const element = article.querySelector<HTMLElement>(`[data-mermaid-id="${diagram.id}"]`);
      if (!element) continue;
      const outcome = await renderMermaidDiagram(diagram);
      if (generation !== renderGeneration || !element.isConnected) return;
      if (outcome.state === 'rendered') {
        element.innerHTML = outcome.svg;
        element.dataset.mermaidState = 'rendered';
        delete element.dataset.mermaidReason;
      } else {
        showFallback(element, outcome.reason, outcome.source);
      }
    }
  }

  $effect(() => {
    document?.revision;
    rendered;
    const generation = ++renderGeneration;
    void renderDiagrams(generation);
    return () => {
      renderGeneration++;
    };
  });

  function revealLinkedChat(): void {
    if (revealStatus === 'pending') return;
    if (revealResetTimer) clearTimeout(revealResetTimer);
    revealStatus = 'pending';
    vscode.postMessage({ type: 'revealLinkedChat' });
  }

  async function copyMarkdown(): Promise<void> {
    if (!document?.markdown) return;
    try {
      await navigator.clipboard.writeText(document.markdown);
      copyStatus = 'copied';
    } catch {
      copyStatus = 'failed';
    }
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyStatus = 'idle';
    }, 1500);
  }

  function formatRelativeUpdated(iso: string | undefined): string {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const delta = Date.now() - t;
    if (delta < 15_000) return 'Updated just now';
    if (delta < 60_000) return 'Updated moments ago';
    if (delta < 3_600_000) return `Updated ${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `Updated ${Math.floor(delta / 3_600_000)}h ago`;
    return `Updated ${new Date(t).toLocaleString()}`;
  }

  function handleContentClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>('a[data-external-href]');
    if (!anchor) return;
    event.preventDefault();
    const url = anchor.dataset.externalHref;
    if (url) vscode.postMessage({ type: 'openExternal', url });
  }

  onMount(() => {
    const handleMessage = (event: MessageEvent): void => {
      const revealResult = parsePresentationRevealResult(event.data);
      if (revealResult && revealStatus === 'pending') {
        revealStatus = revealResult.status;
        if (revealResult.status === 'success') {
          if (revealResetTimer) clearTimeout(revealResetTimer);
          revealResetTimer = setTimeout(() => {
            if (revealStatus === 'success') revealStatus = 'idle';
          }, 2000);
        }
        return;
      }
      const parsed = parsePresentationUpdate(event.data);
      if (!parsed) return;
      const accepted = applyPresentationUpdate(document, event.data);
      if (accepted === document) return;
      document = accepted;
      if (parsed.rootId) rootId = parsed.rootId;
      persist();
    };
    window.addEventListener('message', handleMessage);
    window.addEventListener('click', handleContentClick);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('click', handleContentClick);
      if (copyResetTimer) clearTimeout(copyResetTimer);
      if (revealResetTimer) clearTimeout(revealResetTimer);
    };
  });

  const showSecondary = $derived(Boolean(document?.updatedAt || document?.sourcePath));
  const relativeUpdated = $derived(formatRelativeUpdated(document?.updatedAt));
</script>

{#if document}
  <main
    class="presentation-shell"
    data-presentation-id={document.presentationId}
    data-presentation-revision={document.revision}
    data-presentation-kind={document.kind ?? 'document'}
  >
    <header class="presentation-header">
      <div class="presentation-header__primary">
        <div class="presentation-header__identity">
          <span class="presentation-kind" aria-label={`Kind ${kindLabel(document.kind)}`}>
            {kindLabel(document.kind)}
          </span>
          <h1 title={document.title}>{document.title}</h1>
        </div>
        <div class="presentation-header__actions">
          <span
            class="presentation-revision"
            aria-label={`Revision ${document.revision}`}
            title="Monotonic presentation revision"
          >
            v{document.revision}
          </span>
          <button
            type="button"
            class="presentation-icon-btn"
            onclick={copyMarkdown}
            title="Copy markdown"
            aria-label="Copy markdown"
          >
            {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Failed' : 'Copy'}
          </button>
          <button
            type="button"
            class="presentation-primary-btn"
            disabled={revealStatus === 'pending'}
            onclick={revealLinkedChat}
          >
            {revealStatus === 'pending' ? 'Opening…' : 'Open linked chat'}
          </button>
        </div>
      </div>
      {#if showSecondary}
        <div class="presentation-header__secondary">
          {#if document.sourcePath}
            <span class="presentation-source" title={document.sourcePath}>{document.sourcePath}</span>
          {/if}
          {#if relativeUpdated}
            <span class="presentation-updated" title={document.updatedAt ?? ''}>{relativeUpdated}</span>
          {/if}
        </div>
      {/if}
      <span class="presentation-status" role="status" aria-live="polite">
        {revealStatus === 'pending'
          ? 'Opening linked chat…'
          : revealStatus === 'success'
            ? 'Linked chat opened.'
            : revealStatus === 'failure'
              ? 'Could not open linked chat.'
              : ''}
      </span>
    </header>
    {#if document.summary}
      <p class="presentation-summary">{document.summary}</p>
    {/if}
    <article bind:this={article} class="markdown-body presentation-content">
      {@html rendered?.html ?? ''}
    </article>
  </main>
{:else}
  <main class="presentation-empty" aria-live="polite">Waiting for presentation content…</main>
{/if}
