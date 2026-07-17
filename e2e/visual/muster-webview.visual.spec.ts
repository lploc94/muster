import { expect, test, type Page } from '@playwright/test';
import { openMusterWebview } from '../fixtures/muster-webview';
import {
  createStaticWebviewFixture,
  ensureVisualEnvironmentApplied,
  installVisualEnvironment,
  normalizeVisualChrome,
  waitForVisualReady,
} from '../fixtures/visual-environment';

/** Stable pilot case ID for the main webview entrypoint (S01). */
export const WEBVIEW_VISUAL_PILOT_ID = 'V01-webview-compact-dark';

const PROTOCOL_VERSION = 5;

async function postSnapshot(page: Page, snapshot: Record<string, unknown>): Promise<void> {
  await page.evaluate((message) => {
    window.postMessage(message, '*');
  }, { ...snapshot, protocolVersion: PROTOCOL_VERSION });
}

test.describe('visual pilot · main webview', () => {
  test.use({
    viewport: { width: 1280, height: 720 },
  });

  test(`${WEBVIEW_VISUAL_PILOT_ID} · idle workspace shell`, async ({ page }) => {
    const fixture = createStaticWebviewFixture();

    await installVisualEnvironment(page, { theme: 'dark' });
    await openMusterWebview(page);
    await ensureVisualEnvironmentApplied(page);

    await postSnapshot(page, fixture as unknown as Record<string, unknown>);
    await expect(page.getByText('Visual pilot workspace')).toBeVisible();
    await expect(page.getByText('Synthetic visual pilot transcript.')).toBeVisible();

    await waitForVisualReady(page, { selector: '[data-testid="runtime-interaction-stack"], body' });
    await normalizeVisualChrome(page);

    await expect(page).toHaveScreenshot(`${WEBVIEW_VISUAL_PILOT_ID}.png`, {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
  });
});
