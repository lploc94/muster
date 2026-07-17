import { expect, test, type Page } from '@playwright/test';
import {
  openMusterPresentation,
  openMusterWebview,
  postHostMessage,
  readPostedMessages,
} from '../fixtures/muster-webview';
import {
  COMPACT_WEBVIEW_VIEWPORT,
  NARROW_PRESENTATION_VIEWPORT,
  createStaticFileMentionSuggestions,
  createStaticNarrowPresentationFixture,
  createStaticPendingAsk,
  createStaticPermissionPendingMessage,
  createStaticPermissionSettingsSnapshot,
  createStaticPresentationFixture,
  createStaticRuntimeStorageSettingsSnapshot,
  createStaticTaskTypesSettingsSnapshot,
  createStaticWebviewFixture,
  ensureVisualEnvironmentApplied,
  installVisualEnvironment,
  normalizeVisualChrome,
  normalizeVisualScroll,
  waitForVisualReady,
  type VisualThemeKind,
} from '../fixtures/visual-environment';
import {
  M014_S02_FLOW_TITLE,
  VISUAL_MATRIX_CASES,
  VISUAL_MATRIX_MAX_CASES,
} from './visual-cases';

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
const SCREENSHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  scale: 'css' as const,
};

const FORBIDDEN_BODY_RE =
  /sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z]:\\|\/(?:Users|home)\/[^/\s]+/;

async function postSnapshot(page: Page, snapshot: Record<string, unknown>): Promise<void> {
  await page.evaluate((message) => {
    window.postMessage(message, '*');
  }, { ...snapshot, protocolVersion: PROTOCOL_VERSION });
}

async function assertNoForbiddenPageText(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(FORBIDDEN_BODY_RE);
  expect(bodyText).not.toMatch(/Coming soon/i);
}

async function seedWebview(
  page: Page,
  theme: VisualThemeKind,
  fixture: Record<string, unknown> = createStaticWebviewFixture() as unknown as Record<
    string,
    unknown
  >,
): Promise<void> {
  await installVisualEnvironment(page, { theme });
  await openMusterWebview(page);
  await ensureVisualEnvironmentApplied(page);
  await postSnapshot(page, fixture);
  await expect(page.getByText('Visual pilot workspace')).toBeVisible();
}

async function openComposerAutocomplete(page: Page): Promise<void> {
  await page.evaluate((message) => {
    window.postMessage(message, '*');
  }, { type: 'snapshot', protocolVersion: PROTOCOL_VERSION, rootTasks: [], storeRevision: 2 });

  await page.getByRole('button', { name: 'New task' }).first().click();
  await expect
    .poll(async () => {
      const messages = await readPostedMessages(page);
      return messages.some((m) => (m as { type?: string }).type === 'newTask');
    })
    .toBe(true);

  const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.pressSequentially('Review @re', { delay: 20 });

  await expect
    .poll(async () => {
      const messages = await readPostedMessages(page);
      return messages.filter(
        (m) => (m as { type?: string }).type === 'requestFileMentionSuggestions',
      );
    })
    .not.toHaveLength(0);

  const request = (await readPostedMessages(page)).find(
    (m) => (m as { type?: string }).type === 'requestFileMentionSuggestions',
  ) as { requestId: string };

  const reply = createStaticFileMentionSuggestions(request.requestId, {
    parentDepth: 0,
    relativeQuery: 're',
  });
  await page.evaluate((msg) => {
    window.postMessage(msg, '*');
  }, reply);

  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('option', { name: 'readme.md' })).toBeVisible();
}

async function openSettingsWithSnapshots(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await postHostMessage(page, {
    type: 'settingsSnapshot',
    protocolVersion: PROTOCOL_VERSION,
    snapshot: createStaticRuntimeStorageSettingsSnapshot(),
  });
  await postHostMessage(page, {
    type: 'taskTypesSettingsSnapshot',
    protocolVersion: PROTOCOL_VERSION,
    snapshot: createStaticTaskTypesSettingsSnapshot(),
  });
  await postHostMessage(page, {
    type: 'permissionSettingsSnapshot',
    protocolVersion: PROTOCOL_VERSION,
    snapshot: createStaticPermissionSettingsSnapshot(),
  });
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 10_000,
  });
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
  const headingId = options.articleHeadingId ?? presentationId;
  await expect(page.locator(`#${headingId}`)).toBeVisible();
  const diagram = page.locator('[data-mermaid-id="mermaid-0"]');
  await expect(diagram).toHaveAttribute('data-mermaid-state', 'rendered', { timeout: 15_000 });
  await waitForVisualReady(page, { selector: `[data-presentation-id="${presentationId}"]` });
  await normalizeVisualChrome(page);
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
    await expect(page).toHaveScreenshot(`${WEBVIEW_VISUAL_PILOT_ID}.png`, SCREENSHOT);

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
    await expect(page).toHaveScreenshot(`${PRESENTATION_VISUAL_PILOT_ID}.png`, SCREENSHOT);
  });
});

/**
 * Stable independently executable M014/S02 proof.
 * Traverses the approved representative matrix across both entrypoints and
 * proves committed comparisons under the deterministic visual contract.
 * Aggregate matrix suite runs cannot substitute for this named flow.
 *
 * Flow snapshot names are S02-prefixed so they do not collide with the S01
 * dual-entrypoint goldens that share V01/V02 ids at a different viewport.
 */
test.describe('M014 S02 representative visual matrix flow', () => {
  test('M014 S02 flow: representative visual matrix', async ({ page }) => {
    test.setTimeout(180_000);
    expect(M014_S02_FLOW_TITLE).toBe('M014 S02 flow: representative visual matrix');

    // Manifest hard-cap and coverage are part of the named flow contract.
    expect(VISUAL_MATRIX_CASES.length).toBeLessThanOrEqual(VISUAL_MATRIX_MAX_CASES);
    expect(VISUAL_MATRIX_CASES.length).toBeGreaterThanOrEqual(2);
    expect(VISUAL_MATRIX_MAX_CASES).toBe(8);
    const entrypoints = new Set(VISUAL_MATRIX_CASES.map((c) => c.entrypoint));
    expect(entrypoints.has('webview')).toBe(true);
    expect(entrypoints.has('presentation')).toBe(true);
    const themes = new Set(VISUAL_MATRIX_CASES.map((c) => c.theme));
    expect(themes.has('dark')).toBe(true);
    expect(themes.has('light')).toBe(true);
    expect(themes.has('high-contrast')).toBe(true);
    const layouts = new Set(VISUAL_MATRIX_CASES.map((c) => c.layout));
    expect(layouts.has('compact')).toBe(true);
    expect(layouts.has('narrow')).toBe(true);

    // --- V01: compact idle dark webview ---
    await page.setViewportSize(COMPACT_WEBVIEW_VIEWPORT);
    await seedWebview(page, 'dark');
    await expect(page.getByText('Synthetic visual pilot transcript.')).toBeVisible();
    await waitForVisualReady(page, {
      selector: '[data-testid="runtime-interaction-stack"], body',
    });
    await normalizeVisualChrome(page);
    await assertNoForbiddenPageText(page);
    await expect(page).toHaveScreenshot('S02-V01-webview-compact-dark.png', SCREENSHOT);

    // --- V03: autocomplete light ---
    await page.setViewportSize(COMPACT_WEBVIEW_VIEWPORT);
    await installVisualEnvironment(page, { theme: 'light' });
    await openMusterWebview(page);
    await ensureVisualEnvironmentApplied(page);
    await openComposerAutocomplete(page);
    await waitForVisualReady(page, {
      selector: '[data-testid="file-mention-listbox"], [role="listbox"]',
    });
    await normalizeVisualScroll(page);
    await assertNoForbiddenPageText(page);
    await expect(page).toHaveScreenshot('S02-V03-webview-autocomplete-light.png', SCREENSHOT);

    // --- V04: settings + runtime permission high-contrast ---
    await page.setViewportSize(COMPACT_WEBVIEW_VIEWPORT);
    await seedWebview(page, 'high-contrast');
    await openSettingsWithSnapshots(page);
    // Settings taxonomy: actionable domains present, no placeholder tabs.
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByText('Coming soon', { exact: false })).toHaveCount(0);
    await postHostMessage(page, createStaticPermissionPendingMessage());
    await expect(page.getByRole('region', { name: 'Runtime permission request' })).toBeVisible();
    await expect(page.getByText('Write docs/UI-VISUAL-REGRESSION.md')).toBeVisible();
    await waitForVisualReady(page, {
      selector: '[data-testid="runtime-interaction-stack"], body',
    });
    await normalizeVisualChrome(page);
    await assertNoForbiddenPageText(page);
    await expect(page).toHaveScreenshot('S02-V04-webview-settings-prompt-hc.png', SCREENSHOT);

    // --- V05: accessible Ask validation errors dark ---
    await page.setViewportSize(COMPACT_WEBVIEW_VIEWPORT);
    const askFixture = createStaticWebviewFixture({
      pendingAsk: createStaticPendingAsk(),
    }) as unknown as Record<string, unknown>;
    await seedWebview(page, 'dark', askFixture);
    await expect(page.getByText('Confirm the visual gate fixture label')).toBeVisible();
    const accept = page.locator('vscode-button', { hasText: 'Accept' });
    await expect(accept).toBeVisible();
    await accept.click();
    await expect(page.getByRole('alert').filter({ hasText: /is required/i })).toBeVisible();
    await waitForVisualReady(page, {
      selector: '[data-testid="runtime-interaction-stack"], body',
    });
    await normalizeVisualScroll(page);
    await assertNoForbiddenPageText(page);
    await expect(page).toHaveScreenshot('S02-V05-webview-validation-errors-dark.png', SCREENSHOT);

    // --- V02: rich presentation dark ---
    await page.setViewportSize({ width: 1280, height: 720 });
    const rich = createStaticPresentationFixture();
    await installVisualEnvironment(page, { theme: 'dark' });
    await openMusterPresentation(page, {
      initialState: rich,
      structuredCloneMessages: false,
      stateMode: 'direct',
      waitForReady: true,
    });
    await ensureVisualEnvironmentApplied(page);
    await waitForPresentationSettled(page, rich.presentationId, rich.revision);
    await expect(page.getByRole('table')).toContainText('Baseline');
    await expect(page.getByRole('link', { name: 'synthetic guide' })).toBeVisible();
    await assertNoForbiddenPageText(page);
    await expect(page).toHaveScreenshot('S02-V02-presentation-rich-dark.png', SCREENSHOT);

    // --- V06: narrow presentation light ---
    await page.setViewportSize(NARROW_PRESENTATION_VIEWPORT);
    const narrow = createStaticNarrowPresentationFixture();
    await installVisualEnvironment(page, { theme: 'light' });
    await openMusterPresentation(page, {
      initialState: narrow,
      structuredCloneMessages: false,
      stateMode: 'direct',
      waitForReady: true,
    });
    await ensureVisualEnvironmentApplied(page);
    await waitForPresentationSettled(page, narrow.presentationId, narrow.revision, {
      articleHeadingId: 'narrow-containment-presentation',
    });
    const shell = page.locator('.presentation-shell');
    await expect(shell).toBeVisible();
    const overflow = await shell.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    await assertNoForbiddenPageText(page);
    await expect(page).toHaveScreenshot('S02-V06-presentation-narrow-light.png', SCREENSHOT);
  });
});
