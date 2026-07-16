import { expect, test, type Page } from '@playwright/test';

interface PresentationDocument {
  presentationId: string;
  ownerTaskId: string;
  revision: number;
  title: string;
  markdown: string;
  kind?: 'plan' | 'spec' | 'document';
  sourcePath?: string;
  updatedAt?: string;
}

async function openPresentation(page: Page, persistedState?: unknown) {
  await page.addInitScript((initialState) => {
    window.__musterPersistedState = initialState;
    window.acquireVsCodeApi = () => ({
      postMessage(message: unknown) {
        window.__musterPostedMessages = [...(window.__musterPostedMessages ?? []), message];
      },
      getState() {
        return window.__musterPersistedState;
      },
      setState(state: unknown) {
        window.__musterPersistedState = state;
      },
    });
  }, persistedState);
  await page.goto('/presentation.html');
}

async function postUpdate(page: Page, document: PresentationDocument, rootId = 'task-root') {
  await page.evaluate(
    ({ value, root }) => {
      window.postMessage({ type: 'presentationUpdate', document: value, rootId: root }, '*');
    },
    { value: document, root: rootId },
  );
}

async function postRawMessage(page: Page, message: unknown) {
  await page.evaluate((value) => {
    window.postMessage(value, '*');
  }, message);
}

function presentation(overrides: Partial<PresentationDocument> = {}): PresentationDocument {
  return {
    presentationId: 'release-notes',
    ownerTaskId: 'task-root',
    revision: 1,
    title: 'Release notes',
    markdown: '# Browser-ready',
    ...overrides,
  };
}

test('reveals linked chat with identity-free messages and accessible typed status', async ({ page }) => {
  await openPresentation(page, presentation());

  const action = page.getByRole('button', { name: 'Open linked chat' });
  await action.click();
  await expect(action).toBeDisabled();
  const chatStatus = page.getByRole('status', { name: 'Linked chat status' });
  await expect(chatStatus).toHaveText('Opening linked chat…');
  await expect.poll(() => page.evaluate(() => window.__musterPostedMessages ?? [])).toEqual([
    { type: 'presentationReady' },
    { type: 'revealLinkedChat' },
  ]);

  await postRawMessage(page, { type: 'revealLinkedChatResult', status: 'success' });
  await expect(action).toBeEnabled();
  await expect(chatStatus).toHaveText('Linked chat opened.');
  // Success status is transient (clears after ~2s); failure stays until retry.

  const presentationRoot = page.locator('[data-presentation-id]');
  await presentationRoot.evaluate((element) => { element.setAttribute('data-test-instance', 'original'); });
  await postUpdate(page, presentation({ revision: 2, title: 'Revised release notes', markdown: '# Revised in place' }));
  await expect(presentationRoot).toHaveAttribute('data-test-instance', 'original');
  await expect(presentationRoot).toHaveAttribute('data-presentation-revision', '2');
  await expect(page.getByRole('heading', { name: 'Revised release notes', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Revised in place', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/presentation\.html$/);

  await action.click();
  await postRawMessage(page, { type: 'revealLinkedChatResult', status: 'failure', error: 'private transcript' });
  await expect(chatStatus).toHaveText('Opening linked chat…');
  await postRawMessage(page, { type: 'revealLinkedChatResult', status: 'failure' });
  await expect(chatStatus).toHaveText('Could not open linked chat.');
  await expect(page.getByText('private transcript')).toHaveCount(0);

  await postUpdate(page, presentation({ revision: 3, title: 'Rev 3', markdown: '# Rev 3 body' }));
  await expect(page.getByRole('status', { name: 'Revision status' })).toHaveText('Updated to revision 3');
  await expect(chatStatus).toHaveText('Could not open linked chat.');
});

test('restores a validated persisted presentation on browser startup', async ({ page }) => {
  await openPresentation(page, presentation({
    revision: 4,
    title: 'Restored title',
    markdown: '# Restored body',
  }));

  await expect(page.locator('[data-presentation-id]')).toHaveAttribute('data-presentation-id', 'release-notes');
  await expect(page.locator('[data-presentation-revision]')).toHaveAttribute('data-presentation-revision', '4');
  await expect(page.getByRole('heading', { name: 'Restored title', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Restored body', level: 1 })).toBeVisible();
});

test('persists the last accepted host revision as exact VS Code envelope state', async ({ page }) => {
  await openPresentation(page);
  const accepted = presentation({ revision: 3, title: 'Persisted title', markdown: '# Persisted body' });

  await postUpdate(page, accepted, 'task-root');

  await expect.poll(() => page.evaluate(() => window.__musterPersistedState)).toEqual({
    rootId: 'task-root',
    document: accepted,
  });
});

test('renders the waiting state for malformed persisted presentation state', async ({ page }) => {
  await openPresentation(page, { ...presentation(), markdown: '', injected: true });

  await expect(page.getByText('Waiting for presentation content…')).toBeVisible();
  await expect(page.locator('[data-presentation-id]')).toHaveCount(0);
});

test('renders a guarded Markdown presentation from a host update', async ({ page }) => {
  await openPresentation(page);
  await postUpdate(page, {
    presentationId: 'release-notes',
    ownerTaskId: 'task-root',
    revision: 1,
    title: 'Release notes',
    markdown: [
      '# Browser-ready',
      '',
      '| Area | State |',
      '| --- | --- |',
      '| Protocol | Guarded |',
      '',
      '```ts',
      'const ready: boolean = true;',
      '```',
    ].join('\n'),
  });

  await expect(page.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Browser-ready', level: 1 })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Protocol');
  await expect(page.locator('pre code.hljs.language-ts')).toContainText('const ready: boolean = true;');
  await expect(page.locator('[data-presentation-revision]')).toHaveAttribute('data-presentation-revision', '1');
});

test('keeps presentation chrome compact, aligned, and overflow-safe', async ({ page }) => {
  await page.setViewportSize({ width: 895, height: 520 });
  const longBody = Array.from({ length: 60 }, (_, index) => `Dòng nội dung ${index + 1}.`).join('\n\n');
  await openPresentation(page, presentation({
    title: 'plan',
    kind: 'document',
    sourcePath: 'docs/plans/ho-chi-minh-city-three-day-plan.md',
    updatedAt: new Date().toISOString(),
    markdown: `# Lịch trình TP.HCM 3 ngày 2 đêm\n\n## Nên ở đâu\n\n${longBody}`,
  }));

  const controlHeights = await page.locator(
    '.presentation-revision, .presentation-header__actions button',
  ).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(controlHeights).toEqual([28, 28, 28]);

  const contextHeights = await page.locator(
    '.presentation-source-btn, .presentation-updated',
  ).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(contextHeights).toEqual([26, 26]);
  await expect(page.locator('.presentation-header')).toHaveCSS('gap', '8px');
  await expect(page.getByRole('status')).toHaveCount(0);

  const tocToggle = page.getByRole('button', { name: 'Contents' });
  await expect(tocToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('navigation', { name: 'Contents' })).toBeVisible();
  await expect(page.locator('.presentation-shell')).toHaveCSS('overflow', 'hidden');
  await expect(page.locator('.presentation-content-scroll')).toHaveCSS('overflow-y', 'auto');

  const pinnedBefore = await page.locator('.presentation-header, .presentation-toc')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
  await page.locator('.presentation-content-scroll').evaluate((element) => {
    element.scrollTop = 240;
  });
  await expect.poll(() => page.locator('.presentation-content-scroll').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const pinnedAfter = await page.locator('.presentation-header, .presentation-toc')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
  expect(pinnedAfter).toEqual(pinnedBefore);

  await tocToggle.click();
  await expect(tocToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('navigation', { name: 'Contents' })).toHaveCount(0);

  await page.setViewportSize({ width: 360, height: 520 });
  const overflow = await page.locator('.presentation-shell').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  await expect(page.getByRole('button', { name: 'Open linked chat' })).toBeVisible();
});

test('expands a long table of contents without an internal scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 895, height: 720 });
  const headings = Array.from(
    { length: 12 },
    (_, index) => `## Section ${index + 1}\n\nSection ${index + 1} content.`,
  ).join('\n\n');
  await openPresentation(page, presentation({ markdown: `# Long plan\n\n${headings}` }));

  const toc = page.getByRole('navigation', { name: 'Contents' });
  await expect(toc).toBeVisible();
  await expect(toc.getByRole('link')).toHaveCount(13);
  const overflow = await toc.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(overflow.scrollHeight).toBe(overflow.clientHeight);
  expect(overflow.overflowY).toBe('visible');
});

test('sanitizes hostile markup and routes only annotated links through the host', async ({ page }) => {
  await openPresentation(page);
  await postUpdate(page, presentation({
    markdown: [
      '<script>window.__presentationPwned = true</script>',
      '<img src=x onerror="window.__presentationPwned = true">',
      '[unsafe](javascript:alert(1))',
      '[external](https://example.com/release)',
    ].join('\n\n'),
  }));

  await expect(page.locator('.presentation-content script')).toHaveCount(0);
  await expect(page.locator('.presentation-content img')).toHaveCount(0);
  await expect(page.getByText('<script>window.__presentationPwned = true</script>')).toBeVisible();
  await expect(page.getByText('unsafe', { exact: true })).toBeVisible();
  await expect(page.locator('.presentation-content a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__presentationPwned)).toBeUndefined();

  await page.getByRole('link', { name: 'external' }).click();
  await expect.poll(() => page.evaluate(() => window.__musterPostedMessages ?? [])).toContainEqual({
    type: 'openExternal',
    url: 'https://example.com/release',
  });
  await expect(page).toHaveURL(/\/presentation\.html$/);
});

test('renders Mermaid diagrams locally without disturbing surrounding Markdown or host links', async ({ page }) => {
  await openPresentation(page);
  await postUpdate(page, presentation({
    markdown: [
      '# Diagram release',
      '',
      '| Area | State |',
      '| --- | --- |',
      '| Mermaid | Guarded |',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Start] --> B[Finish]',
      '```',
      '',
      '```ts',
      'const adjacent = true;',
      '```',
      '',
      '[release](https://example.com/release)',
    ].join('\n'),
  }));

  const diagram = page.locator('[data-mermaid-id="mermaid-0"]');
  await expect(diagram).toHaveAttribute('data-mermaid-state', 'rendered');
  await expect(diagram.locator('svg')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Diagram release' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Guarded');
  await expect(page.locator('pre code.language-ts')).toContainText('const adjacent = true;');
  await page.getByRole('link', { name: 'release', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__musterPostedMessages ?? [])).toContainEqual({
    type: 'openExternal',
    url: 'https://example.com/release',
  });
});

test('keeps malformed, oversized, and excess Mermaid failures local and readable', async ({ page }) => {
  await openPresentation(page);
  const diagrams = Array.from({ length: 9 }, (_, index) => [
    '```mermaid',
    index === 0 ? 'flowchart LR\n  A[Broken' : `flowchart LR\n  A${index} --> B${index}`,
    '```',
  ].join('\n'));
  diagrams[1] = `\`\`\`mermaid\nflowchart LR\n  A[${'x'.repeat(8_001)}]\n\`\`\``;
  await postUpdate(page, presentation({ markdown: ['# Still here', ...diagrams, 'After diagrams'].join('\n\n') }));

  const malformed = page.locator('[data-mermaid-id="mermaid-0"]');
  await expect(malformed).toHaveAttribute('data-mermaid-state', 'fallback');
  await expect(malformed).toHaveAttribute('data-mermaid-reason', 'malformed');
  await expect(malformed.getByRole('status')).toContainText('could not be rendered');
  await expect(malformed.locator('code')).toContainText('A[Broken');

  await expect(page.locator('[data-mermaid-id="mermaid-1"]')).toHaveAttribute('data-mermaid-reason', 'oversized');
  await expect(page.locator('[data-mermaid-id="mermaid-8"]')).toHaveAttribute('data-mermaid-reason', 'excess');
  await expect(page.locator('[data-mermaid-state="rendered"]')).toHaveCount(6);
  await expect(page.getByRole('heading', { name: 'Still here' })).toBeVisible();
  await expect(page.getByText('After diagrams')).toBeVisible();
});

test('does not allow hostile Mermaid output or stale diagram work to cross revisions', async ({ page }) => {
  await openPresentation(page);
  await postUpdate(page, presentation({
    revision: 1,
    markdown: '```mermaid\nflowchart LR\n  A[<script>window.__mermaidPwned=true</script>] --> B\n```',
  }));
  await postUpdate(page, presentation({ revision: 2, markdown: '# Newest revision' }));

  await expect(page.locator('[data-presentation-revision]')).toHaveAttribute('data-presentation-revision', '2');
  await expect(page.getByRole('heading', { name: 'Newest revision' })).toBeVisible();
  await expect(page.locator('.presentation-content [data-mermaid-id]')).toHaveCount(0);
  await expect(page.locator('.presentation-content script, .presentation-content foreignObject')).toHaveCount(0);
  await expect(page.locator('.presentation-content [onload], .presentation-content [onclick]')).toHaveCount(0);
  await expect(page.locator('.presentation-content svg a, .presentation-content svg [href^="javascript:"], .presentation-content svg [href^="http"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__mermaidPwned)).toBeUndefined();
});

test('preserves the last accepted revision after malformed, stale, or conflicting updates', async ({ page }) => {
  await openPresentation(page);
  const accepted = presentation({
    revision: 2,
    title: 'Accepted title',
    markdown: '# Accepted body',
  });
  await postUpdate(page, accepted);
  await expect(page.getByRole('heading', { name: 'Accepted body', level: 1 })).toBeVisible();

  await postRawMessage(page, {
    type: 'presentationUpdate',
    document: { ...accepted, revision: 3, title: 'Malformed title', markdown: '' },
  });
  await postUpdate(page, { ...accepted, title: 'Stale title' });
  await postUpdate(page, { ...accepted, revision: 3, presentationId: 'other', title: 'Other title' });
  await postUpdate(page, { ...accepted, revision: 3, ownerTaskId: 'other-task', title: 'Wrong owner' });

  await expect(page.locator('[data-presentation-revision]')).toHaveAttribute('data-presentation-revision', '2');
  await expect(page.getByRole('heading', { name: 'Accepted title', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accepted body', level: 1 })).toBeVisible();
  await expect(page.getByText(/Malformed title|Stale title|Other title|Wrong owner/)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__musterPersistedState)).toEqual({
    rootId: 'task-root',
    document: accepted,
  });
});

declare global {
  interface Window {
    acquireVsCodeApi: () => {
      postMessage(message: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    };
    __musterPostedMessages?: unknown[];
    __musterPersistedState?: unknown;
  }
}
