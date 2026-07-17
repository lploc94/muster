import { expect, test, type Page } from '@playwright/test';
import { openMusterPresentation } from '../fixtures/muster-webview';
import {
  NARROW_PRESENTATION_VIEWPORT,
  createStaticNarrowPresentationFixture,
  createStaticPresentationFixture,
  ensureVisualEnvironmentApplied,
  installVisualEnvironment,
  normalizeVisualChrome,
  waitForVisualReady,
  type VisualThemeKind,
} from '../fixtures/visual-environment';

/** Rich restored document with table, code, links, and Mermaid (dark theme). */
export const PRESENTATION_VISUAL_RICH_ID = 'V02-presentation-rich-dark';

/** Narrow containment layout with TOC-oriented body (light theme). */
export const PRESENTATION_VISUAL_NARROW_ID = 'V06-presentation-narrow-light';

/** Back-compat alias used by the S01 dual-entrypoint flow. */
export const PRESENTATION_VISUAL_PILOT_ID = PRESENTATION_VISUAL_RICH_ID;

/** Presentation matrix case IDs owned by this spec (S02 T02). */
export const PRESENTATION_VISUAL_CASE_IDS = [
  PRESENTATION_VISUAL_RICH_ID,
  PRESENTATION_VISUAL_NARROW_ID,
] as const;

const SCREENSHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  scale: 'css' as const,
};

async function openPresentationVisual(
  page: Page,
  theme: VisualThemeKind,
  fixture: ReturnType<typeof createStaticPresentationFixture>,
): Promise<void> {
  await installVisualEnvironment(page, { theme });
  await openMusterPresentation(page, {
    initialState: fixture,
    structuredCloneMessages: false,
    stateMode: 'direct',
    waitForReady: true,
  });
  await ensureVisualEnvironmentApplied(page);
}

async function waitForPresentationSettled(
  page: Page,
  presentationId: string,
  revision: number,
  options: { articleHeadingId?: string } = {},
): Promise<void> {
  const root = page.locator(`[data-presentation-id="${presentationId}"]`);
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute('data-presentation-revision', String(revision));
  // Article H1 id is slugified from markdown, not necessarily the presentationId.
  const headingId = options.articleHeadingId ?? presentationId;
  await expect(page.locator(`#${headingId}`)).toBeVisible();

  // Entrypoint-specific async readiness: Mermaid must finish before rasterization.
  const diagram = page.locator('[data-mermaid-id="mermaid-0"]');
  await expect(diagram).toHaveAttribute('data-mermaid-state', 'rendered', { timeout: 15_000 });

  await waitForVisualReady(page, { selector: `[data-presentation-id="${presentationId}"]` });
  await normalizeVisualChrome(page);
}

test.describe('visual matrix · presentation', () => {
  test(`${PRESENTATION_VISUAL_RICH_ID} · restored rich document with mermaid`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const fixture = createStaticPresentationFixture();

    await openPresentationVisual(page, 'dark', fixture);
    await waitForPresentationSettled(page, fixture.presentationId, fixture.revision);

    // Rich content surface checks (code + table + link) before rasterization.
    await expect(page.getByRole('table')).toContainText('Baseline');
    await expect(page.locator('pre code.hljs.language-ts, pre code.language-ts')).toContainText(
      'const ready: boolean = true;',
    );
    await expect(page.getByRole('link', { name: 'synthetic guide' })).toBeVisible();

    await expect(page).toHaveScreenshot(`${PRESENTATION_VISUAL_RICH_ID}.png`, SCREENSHOT);
  });

  test(`${PRESENTATION_VISUAL_NARROW_ID} · narrow containment light theme`, async ({ page }) => {
    await page.setViewportSize(NARROW_PRESENTATION_VIEWPORT);
    const fixture = createStaticNarrowPresentationFixture();

    await openPresentationVisual(page, 'light', fixture);
    await waitForPresentationSettled(page, fixture.presentationId, fixture.revision, {
      articleHeadingId: 'narrow-containment-presentation',
    });

    // Narrow chrome remains overflow-safe; TOC may be present at 360px.
    const shell = page.locator('.presentation-shell');
    await expect(shell).toBeVisible();
    const overflow = await shell.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    await expect(page.getByRole('table')).toContainText('Containment');
    await expect(page.locator('pre code.hljs.language-ts, pre code.language-ts')).toContainText(
      'const narrow: boolean = true;',
    );

    await expect(page).toHaveScreenshot(`${PRESENTATION_VISUAL_NARROW_ID}.png`, SCREENSHOT);
  });
});
