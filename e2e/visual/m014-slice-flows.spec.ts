import { expect, test, type Page } from '@playwright/test';
import { openMusterPresentation, openMusterWebview } from '../fixtures/muster-webview';
import {
  createStaticPresentationFixture,
  createStaticWebviewFixture,
  ensureVisualEnvironmentApplied,
  installVisualEnvironment,
  normalizeVisualChrome,
  waitForVisualReady,
} from '../fixtures/visual-environment';

/**
 * Stable independently executable M014/S01 proof.
 * Exercises both entrypoint pilot boundaries and asserts their screenshots
 * compare in the deterministic visual-chromium environment.
 *
 * Screenshot names must match the committed pilot goldens:
 * - V01-webview-compact-dark.png
 * - V02-presentation-rich-dark.png
 */
export const M014_S01_FLOW_TITLE =
  'M014 S01 flow: deterministic dual-entrypoint pilot';

/** Keep in sync with e2e/visual/muster-webview.visual.spec.ts */
const WEBVIEW_VISUAL_PILOT_ID = 'V01-webview-compact-dark';
/** Keep in sync with e2e/visual/muster-presentation.visual.spec.ts */
const PRESENTATION_VISUAL_PILOT_ID = 'V02-presentation-rich-dark';

const PROTOCOL_VERSION = 5;

async function postSnapshot(page: Page, snapshot: Record<string, unknown>): Promise<void> {
  await page.evaluate((message) => {
    window.postMessage(message, '*');
  }, { ...snapshot, protocolVersion: PROTOCOL_VERSION });
}

test.describe('M014 S01 dual-entrypoint pilot flow', () => {
  test.use({
    viewport: { width: 1280, height: 720 },
  });

  test(M014_S01_FLOW_TITLE, async ({ page }) => {
    // --- Main webview pilot boundary ---
    const webviewFixture = createStaticWebviewFixture();
    await installVisualEnvironment(page, { theme: 'dark' });
    await openMusterWebview(page);
    await ensureVisualEnvironmentApplied(page);
    await postSnapshot(page, webviewFixture as unknown as Record<string, unknown>);
    await expect(page.getByText('Visual pilot workspace')).toBeVisible();
    await expect(page.getByText('Synthetic visual pilot transcript.')).toBeVisible();
    await waitForVisualReady(page, {
      selector: '[data-testid="runtime-interaction-stack"], body',
    });
    await normalizeVisualChrome(page);
    await expect(page).toHaveScreenshot(`${WEBVIEW_VISUAL_PILOT_ID}.png`, {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });

    // --- Presentation pilot boundary (same browser context, fresh navigation) ---
    const presentationFixture = createStaticPresentationFixture();
    await installVisualEnvironment(page, { theme: 'dark' });
    await openMusterPresentation(page, {
      initialState: presentationFixture,
      structuredCloneMessages: false,
      stateMode: 'direct',
      waitForReady: true,
    });
    await ensureVisualEnvironmentApplied(page);

    const root = page.locator('[data-presentation-id="visual-pilot-presentation"]');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute(
      'data-presentation-revision',
      String(presentationFixture.revision),
    );
    await expect(page.locator('#visual-pilot-presentation')).toBeVisible();
    const diagram = page.locator('[data-mermaid-id="mermaid-0"]');
    await expect(diagram).toHaveAttribute('data-mermaid-state', 'rendered', {
      timeout: 15_000,
    });
    await waitForVisualReady(page, {
      selector: '[data-presentation-id="visual-pilot-presentation"]',
    });
    await normalizeVisualChrome(page);
    await expect(page).toHaveScreenshot(`${PRESENTATION_VISUAL_PILOT_ID}.png`, {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
  });
});
