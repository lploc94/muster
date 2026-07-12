<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { renderMermaidDiagram } from './lib/mermaid-renderer';
  import { renderPresentationMarkdown } from './lib/presentation-markdown';
  import {
    applyPresentationUpdate,
    parsePersistedPresentation,
    parsePresentationRevealResult,
    type PresentationDocument,
  } from './lib/presentation-protocol';
  import { vscode } from './lib/vscode';

  let document = $state<PresentationDocument | undefined>(parsePersistedPresentation(vscode.getState()));
  let article = $state<HTMLElement>();
  let renderGeneration = 0;
  let revealStatus = $state<'idle' | 'pending' | 'success' | 'failure'>('idle');
  const rendered = $derived(document ? renderPresentationMarkdown(document.markdown) : undefined);

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
    return () => { renderGeneration++; };
  });

  function revealLinkedChat(): void {
    if (revealStatus === 'pending') return;
    revealStatus = 'pending';
    vscode.postMessage({ type: 'revealLinkedChat' });
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
        return;
      }
      const accepted = applyPresentationUpdate(document, event.data);
      if (accepted === document) return;
      document = accepted;
      vscode.setState(accepted);
    };
    window.addEventListener('message', handleMessage);
    window.addEventListener('click', handleContentClick);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('click', handleContentClick);
    };
  });
</script>

{#if document}
  <main
    class="presentation-shell"
    data-presentation-id={document.presentationId}
    data-presentation-revision={document.revision}
  >
    <header class="presentation-header">
      <h1>{document.title}</h1>
      <span aria-label={`Revision ${document.revision}`}>Revision {document.revision}</span>
      <button type="button" disabled={revealStatus === 'pending'} onclick={revealLinkedChat}>Open linked chat</button>
      <span role="status" aria-live="polite">{revealStatus === 'pending' ? 'Opening linked chat…' : revealStatus === 'success' ? 'Linked chat opened.' : revealStatus === 'failure' ? 'Could not open linked chat.' : ''}</span>
    </header>
    <article bind:this={article} class="markdown-body presentation-content">
      {@html rendered?.html ?? ''}
    </article>
  </main>
{:else}
  <main class="presentation-empty" aria-live="polite">Waiting for presentation content…</main>
{/if}
