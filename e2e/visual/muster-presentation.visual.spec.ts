import { expect, test } from '@playwright/test';
import { openMusterPresentation } from '../fixtures/muster-webview';
import {
  createStaticPresentationFixture,
  ensureVisualEnvironmentApplied,
  installVisualEnvironment,
  normalizeVisualChrome,
  waitForVisualReady,
} from '../fixtures/visual-environment';

/** Stable pilot case ID for the Presentation entrypoint (S01). */
export const PRESENTATION_VISUAL_PILOT_ID = 'V02-presentation-rich-dark';

test.describe('visual pilot · presentation', () => {
  test.use({
    viewport: { width: 1280, height: 720 },
  });

  test(`${PRESENTATION_VISUAL_PILOT_ID} · restored rich document with mermaid`, async ({ page }) => {
    const fixture = createStaticPresentationFixture();

    await installVisualEnvironment(page, { theme: 'dark' });
    await openMusterPresentation(page, {
      initialState: fixture,
      structuredCloneMessages: false,
      stateMode: 'direct',
      waitForReady: true,
    });
    await ensureVisualEnvironmentApplied(page);

    const root = page.locator('[data-presentation-id="visual-pilot-presentation"]');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute('data-presentation-revision', String(fixture.revision));
    // Chrome title + markdown H1 share the same text; assert the article heading id.
    await expect(page.locator('#visual-pilot-presentation')).toBeVisible();

    // Entrypoint-specific async readiness: Mermaid must finish before rasterization.
    const diagram = page.locator('[data-mermaid-id="mermaid-0"]');
    await expect(diagram).toHaveAttribute('data-mermaid-state', 'rendered', { timeout: 15_000 });

    await waitForVisualReady(page, { selector: '[data-presentation-id="visual-pilot-presentation"]' });
    await normalizeVisualChrome(page);

    await expect(page).toHaveScreenshot(`${PRESENTATION_VISUAL_PILOT_ID}.png`, {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
  });
});
