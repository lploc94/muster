import { expect, test, type Page } from '@playwright/test';
import {
  findLatestPostedMessage,
  openMusterWebview,
  postHostMessage,
  readPostedMessages,
} from '../fixtures/muster-webview';
import {
  COMPACT_WEBVIEW_VIEWPORT,
  createStaticFileMentionSuggestions,
  createStaticPendingAsk,
  createStaticPermissionPendingMessage,
  createStaticPermissionSettingsSnapshot,
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

/** Stable pilot case ID for the main webview entrypoint (S01/S02). */
export const WEBVIEW_VISUAL_PILOT_ID = 'V01-webview-compact-dark';

/** Open composer autocomplete at compact containment (light theme). */
export const WEBVIEW_VISUAL_AUTOCOMPLETE_ID = 'V03-webview-autocomplete-light';

/** Runtime prompt while Settings is open at 320×600 (high-contrast). */
export const WEBVIEW_VISUAL_SETTINGS_PROMPT_ID = 'V04-webview-settings-prompt-hc';

/** Accessible Ask validation errors (dark theme). */
export const WEBVIEW_VISUAL_VALIDATION_ID = 'V05-webview-validation-errors-dark';

/** All main-webview matrix case IDs owned by this spec (S02 T01). */
export const WEBVIEW_VISUAL_CASE_IDS = [
  WEBVIEW_VISUAL_PILOT_ID,
  WEBVIEW_VISUAL_AUTOCOMPLETE_ID,
  WEBVIEW_VISUAL_SETTINGS_PROMPT_ID,
  WEBVIEW_VISUAL_VALIDATION_ID,
] as const;

const PROTOCOL_VERSION = 5;
const SCREENSHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  scale: 'css' as const,
};

async function postSnapshot(page: Page, snapshot: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (message) => {
      window.postMessage(message, '*');
    },
    { ...snapshot, protocolVersion: PROTOCOL_VERSION },
  );
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
  // Exact e2e/muster-webview-state.spec.ts flow (draft composer + protocol reply).
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
  ) as { requestId: string; parentDepth: number; relativeQuery: string };

  // Hardcode parentDepth/relativeQuery like e2e (must match request).
  await page.evaluate(
    (msg) => {
      window.postMessage(msg, '*');
    },
    {
      type: 'fileMentionSuggestions',
      requestId: request.requestId,
      parentDepth: 0,
      relativeQuery: 're',
      items: [
        {
          id: 'file:readme.md',
          kind: 'file',
          label: 'readme.md',
          insertionPath: 'readme.md',
        },
        {
          id: 'dir:src',
          kind: 'directory',
          label: 'src',
          insertionPath: 'src',
        },
      ],
    },
  );

  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('option', { name: 'readme.md' })).toBeVisible();
}

async function openSettingsWithSnapshots(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // Host replies for the three Settings catalog requests.
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

test.describe('visual matrix · main webview', () => {
  test(`${WEBVIEW_VISUAL_PILOT_ID} · compact idle workspace shell`, async ({ page }) => {
    await page.setViewportSize(COMPACT_WEBVIEW_VIEWPORT);
    await seedWebview(page, 'dark');
    await expect(page.getByText('Synthetic visual pilot transcript.')).toBeVisible();

    await waitForVisualReady(page, {
      selector: '[data-testid="runtime-interaction-stack"], body',
    });
    await normalizeVisualChrome(page);

    await expect(page).toHaveScreenshot(`${WEBVIEW_VISUAL_PILOT_ID}.png`, SCREENSHOT);
  });

  test(`${WEBVIEW_VISUAL_AUTOCOMPLETE_ID} · open composer file mention autocomplete`, async ({
    page,
  }) => {
    await page.setViewportSize(COMPACT_WEBVIEW_VIEWPORT);
    // Install theme + open shell without a focused-task snapshot; draft flow owns state.
    await installVisualEnvironment(page, { theme: 'light' });
    await openMusterWebview(page);
    await ensureVisualEnvironmentApplied(page);
    await openComposerAutocomplete(page);

    await waitForVisualReady(page, {
      selector: '[data-testid="file-mention-listbox"], [role="listbox"]',
    });
    // Keep focus so the open listbox and active option remain intentional.
    await normalizeVisualScroll(page);

    await expect(page).toHaveScreenshot(`${WEBVIEW_VISUAL_AUTOCOMPLETE_ID}.png`, SCREENSHOT);
  });

  test(`${WEBVIEW_VISUAL_SETTINGS_PROMPT_ID} · Settings open with runtime permission prompt`, async ({
    page,
  }) => {
    await page.setViewportSize(COMPACT_WEBVIEW_VIEWPORT);
    await seedWebview(page, 'high-contrast');
    await openSettingsWithSnapshots(page);

    await postHostMessage(page, createStaticPermissionPendingMessage());
    await expect(page.getByRole('region', { name: 'Runtime permission request' })).toBeVisible();
    await expect(page.getByText('Write docs/UI-VISUAL-REGRESSION.md')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    await waitForVisualReady(page, {
      selector: '[data-testid="runtime-interaction-stack"], body',
    });
    await normalizeVisualChrome(page);

    await expect(page).toHaveScreenshot(`${WEBVIEW_VISUAL_SETTINGS_PROMPT_ID}.png`, SCREENSHOT);
  });

  test(`${WEBVIEW_VISUAL_VALIDATION_ID} · accessible Ask validation errors`, async ({ page }) => {
    await page.setViewportSize(COMPACT_WEBVIEW_VIEWPORT);
    const fixture = createStaticWebviewFixture({
      pendingAsk: createStaticPendingAsk(),
    }) as unknown as Record<string, unknown>;
    await seedWebview(page, 'dark', fixture);

    await expect(page.getByText('Confirm the visual gate fixture label')).toBeVisible();

    // Submit empty free-text to surface accessible validation errors.
    const accept = page.locator('vscode-button', { hasText: 'Accept' });
    await expect(accept).toBeVisible();
    await accept.click();
    await expect(page.getByRole('alert').filter({ hasText: /is required/i })).toBeVisible();

    await waitForVisualReady(page, {
      selector: '[data-testid="runtime-interaction-stack"], body',
    });
    // Keep focus on the invalid control for the accessible error ring.
    await normalizeVisualScroll(page);

    await expect(page).toHaveScreenshot(`${WEBVIEW_VISUAL_VALIDATION_ID}.png`, SCREENSHOT);

    // Negative surface: posted messages must not contain secrets/paths.
    const posted = await readPostedMessages(page);
    const blob = JSON.stringify(posted);
    expect(blob).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(blob).not.toMatch(/[A-Za-z]:\\/);
    expect(blob).not.toMatch(/\/(?:Users|home)\/[^/\s]+/);
  });
});
