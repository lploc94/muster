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
  let tocOpen = $state(false);
  let activeHeadingId = $state<string | undefined>(undefined);
  let pendingFragment = $state<string | undefined>(undefined);
  let revisionAnnounce = $state<string>('');
  let revisionAnnounceTimer: ReturnType<typeof setTimeout> | undefined;
  let relativeTick = $state(0);
  const rendered = $derived(document ? renderPresentationMarkdown(document.markdown) : undefined);

  function captureScrollAnchor(): { headingId?: string; ratio: number } {
    const shell = article?.closest('.presentation-shell') as HTMLElement | null;
    if (!shell || !article) return { ratio: 0 };
    const max = Math.max(1, shell.scrollHeight - shell.clientHeight);
    const ratio = shell.scrollTop / max;
    const headings = Array.from(article.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]'));
    const top = shell.getBoundingClientRect().top + 48;
    let headingId: string | undefined;
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= top + 8) headingId = h.id;
    }
    return { headingId, ratio };
  }

  async function restoreScrollAnchor(anchor: { headingId?: string; ratio: number }): Promise<void> {
    await tick();
    const shell = article?.closest('.presentation-shell') as HTMLElement | null;
    if (!shell || !article) return;
    if (anchor.headingId) {
      const el = article.querySelector<HTMLElement>(`#${CSS.escape(anchor.headingId)}`);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        return;
      }
    }
    const max = Math.max(0, shell.scrollHeight - shell.clientHeight);
    shell.scrollTop = max * Math.min(1, Math.max(0, anchor.ratio));
  }

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

  function openPresentationSource(): void {
    vscode.postMessage({ type: 'openPresentationSource' });
  }

  function scrollToHeading(id: string): void {
    const el = article?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    activeHeadingId = id;
  }

  async function applyPendingFragment(): Promise<void> {
    await tick();
    if (!pendingFragment || !article) return;
    const id = pendingFragment;
    pendingFragment = undefined;
    scrollToHeading(id);
  }

  function handleContentClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const copyBtn = target.closest<HTMLButtonElement>('[data-code-copy]');
    if (copyBtn) {
      event.preventDefault();
      const pre = copyBtn.parentElement?.querySelector('pre code') ?? copyBtn.parentElement?.querySelector('code');
      const text = pre?.textContent ?? '';
      void navigator.clipboard.writeText(text).then(
        () => {
          copyBtn.textContent = 'Copied';
          setTimeout(() => {
            if (copyBtn.isConnected) copyBtn.textContent = 'Copy';
          }, 1200);
        },
        () => {
          copyBtn.textContent = 'Failed';
        },
      );
      return;
    }

    const tocLink = target.closest<HTMLAnchorElement>('a[data-toc-href]');
    if (tocLink) {
      event.preventDefault();
      const id = tocLink.dataset.tocHref;
      if (id) scrollToHeading(id);
      return;
    }

    const headingAnchor = target.closest<HTMLAnchorElement>('a[href^="#"]');
    if (headingAnchor && article?.contains(headingAnchor)) {
      const href = headingAnchor.getAttribute('href') ?? '';
      if (href.startsWith('#') && href.length > 1) {
        event.preventDefault();
        scrollToHeading(decodeURIComponent(href.slice(1)));
        return;
      }
    }

    const workspace = target.closest<HTMLAnchorElement>('a[data-workspace-md-href]');
    if (workspace) {
      event.preventDefault();
      const href = workspace.dataset.workspaceMdHref;
      if (href) vscode.postMessage({ type: 'openWorkspaceMarkdown', href });
      return;
    }

    const external = target.closest<HTMLAnchorElement>('a[data-external-href]');
    if (external) {
      event.preventDefault();
      const url = external.dataset.externalHref;
      if (url) vscode.postMessage({ type: 'openExternal', url });
    }
  }

  onMount(() => {
    const handleMessage = (event: MessageEvent): void => {
      const data = event.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        (data as { type?: unknown }).type === 'navigatePresentationFragment' &&
        typeof (data as { fragment?: unknown }).fragment === 'string'
      ) {
        const frag = ((data as { fragment: string }).fragment).replace(/^#/, '');
        if (/^[A-Za-z0-9._:-]+$/.test(frag)) {
          pendingFragment = frag;
          void applyPendingFragment();
        }
        return;
      }
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
      const previous = document;
      const accepted = applyPresentationUpdate(document, event.data);
      if (accepted === document) return;
      const anchor =
        previous &&
        accepted &&
        previous.presentationId === accepted.presentationId &&
        accepted.revision > previous.revision &&
        !parsed.restore
          ? captureScrollAnchor()
          : undefined;
      document = accepted;
      if (parsed.rootId) rootId = parsed.rootId;
      persist();
      if (
        previous &&
        accepted &&
        previous.presentationId === accepted.presentationId &&
        accepted.revision > previous.revision &&
        !parsed.restore
      ) {
        revisionAnnounce = `Updated to revision ${accepted.revision}`;
        if (revisionAnnounceTimer) clearTimeout(revisionAnnounceTimer);
        revisionAnnounceTimer = setTimeout(() => {
          revisionAnnounce = '';
        }, 2500);
      }
      void applyPendingFragment();
      if (anchor) void restoreScrollAnchor(anchor);
    };
    window.addEventListener('message', handleMessage);
    window.addEventListener('click', handleContentClick);
    const relativeInterval = setInterval(() => {
      relativeTick += 1;
    }, 30_000);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('click', handleContentClick);
      if (copyResetTimer) clearTimeout(copyResetTimer);
      if (revealResetTimer) clearTimeout(revealResetTimer);
      if (revisionAnnounceTimer) clearTimeout(revisionAnnounceTimer);
      clearInterval(relativeInterval);
    };
  });

  $effect(() => {
    rendered?.toc;
    void applyPendingFragment();
  });

  $effect(() => {
    const entries = rendered?.toc ?? [];
    const root = article;
    if (!root || entries.length === 0) return;
    const shell = root.closest('.presentation-shell') as HTMLElement | null;
    const headings = entries
      .map((e) => root.querySelector<HTMLElement>(`#${CSS.escape(e.id)}`))
      .filter((el): el is HTMLElement => Boolean(el));
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter((r) => r.isIntersecting)
          .sort((a, b) => (a.boundingClientRect.top ?? 0) - (b.boundingClientRect.top ?? 0));
        if (visible[0]?.target instanceof HTMLElement && visible[0].target.id) {
          activeHeadingId = visible[0].target.id;
        }
      },
      {
        root: shell ?? null,
        rootMargin: '-10% 0px -70% 0px',
        threshold: [0, 0.1, 1],
      },
    );
    for (const h of headings) observer.observe(h);
    return () => observer.disconnect();
  });

  const showSecondary = $derived(Boolean(document?.updatedAt || document?.sourcePath));
  const relativeUpdated = $derived.by(() => {
    void relativeTick;
    return formatRelativeUpdated(document?.updatedAt);
  });
  const toc = $derived(rendered?.toc ?? []);
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
            <button
              type="button"
              class="presentation-source presentation-source-btn"
              title={document.sourcePath}
              onclick={openPresentationSource}
            >
              {document.sourcePath}
            </button>
            <button type="button" class="presentation-icon-btn" onclick={openPresentationSource}>
              Open source
            </button>
          {/if}
          {#if relativeUpdated}
            <span class="presentation-updated" title={document.updatedAt ?? ''}>{relativeUpdated}</span>
          {/if}
        </div>
      {/if}
      <span
        class="presentation-status"
        role="status"
        aria-live="polite"
        aria-label="Linked chat status"
        data-status="linked-chat"
      >
        {revealStatus === 'pending'
          ? 'Opening linked chat…'
          : revealStatus === 'success'
            ? 'Linked chat opened.'
            : revealStatus === 'failure'
              ? 'Could not open linked chat.'
              : ''}
      </span>
      <span
        class="presentation-status presentation-status--revision"
        role="status"
        aria-live="polite"
        aria-label="Revision status"
        data-status="revision"
      >
        {revisionAnnounce}
      </span>
    </header>
    {#if document.summary}
      <p class="presentation-summary">{document.summary}</p>
    {/if}
    {#if document.changeSummary}
      <p class="presentation-change-summary" role="note">
        <strong>What changed:</strong>
        {document.changeSummary}
      </p>
    {/if}
    {#if toc.length > 0}
      <div class="presentation-toc">
        <button
          type="button"
          class="presentation-toc__toggle"
          aria-expanded={tocOpen}
          aria-controls="presentation-toc-list"
          onclick={() => {
            tocOpen = !tocOpen;
          }}
        >
          Contents
        </button>
        {#if tocOpen}
          <nav id="presentation-toc-list" class="presentation-toc__list" aria-label="Contents">
            {#each toc as entry (entry.id)}
              <a
                href={`#${entry.id}`}
                data-toc-href={entry.id}
                class="presentation-toc__item"
                class:active={activeHeadingId === entry.id}
                data-level={entry.level}
              >
                {entry.text}
              </a>
            {/each}
          </nav>
        {/if}
      </div>
    {/if}
    <article bind:this={article} class="markdown-body presentation-content">
      {@html rendered?.html ?? ''}
    </article>
  </main>
{:else}
  <main class="presentation-empty" aria-live="polite">Waiting for presentation content…</main>
{/if}
