import { expect, test } from '@playwright/test';
import {
  VISUAL_CLOCK_ISO,
  VISUAL_FONT_STACK,
  VISUAL_LOCALE,
  VISUAL_PLAYWRIGHT_USE,
  VISUAL_TIMEZONE,
  assertSanitizedVisualFixture,
  createStaticPresentationFixture,
  createStaticWebviewFixture,
  ensureVisualEnvironmentApplied,
  installVisualEnvironment,
  normalizeVisualChrome,
  waitForVisualReady,
} from './visual-environment';

test.use({
  locale: VISUAL_PLAYWRIGHT_USE.locale,
  timezoneId: VISUAL_PLAYWRIGHT_USE.timezoneId,
  colorScheme: VISUAL_PLAYWRIGHT_USE.colorScheme,
  deviceScaleFactor: VISUAL_PLAYWRIGHT_USE.deviceScaleFactor,
});

test('installs deterministic visual environment seams for screenshot authoring', async ({ page }) => {
  await installVisualEnvironment(page, { theme: 'dark' });
  await page.setContent('<main id="app"><input id="focus-me" /><div id="scroll" style="height:2000px">content</div></main>');
  await ensureVisualEnvironmentApplied(page);
  await page.locator('#focus-me').focus();
  await page.evaluate(() => window.scrollTo(0, 400));
  await waitForVisualReady(page);
  await normalizeVisualChrome(page);

  const diagnostics = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const body = document.body;
    return {
      bodyClass: body.className,
      colorScheme: root.getPropertyValue('color-scheme').trim(),
      editorBg: root.getPropertyValue('--vscode-editor-background').trim(),
      fontFamily: root.getPropertyValue('--vscode-font-family').trim(),
      locale: document.documentElement.lang,
      now: Date.now(),
      iso: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      caretColor: getComputedStyle(body).caretColor,
      animationNone: getComputedStyle(document.getElementById('app')!).animation,
      activeTag: document.activeElement?.tagName ?? null,
      scrollY: window.scrollY,
    };
  });

  expect(diagnostics.bodyClass.split(/\s+/)).toEqual(expect.arrayContaining(['vscode-dark']));
  expect(diagnostics.colorScheme).toContain('dark');
  expect(diagnostics.editorBg).toBe('#1e1e1e');
  expect(diagnostics.fontFamily).toContain(VISUAL_FONT_STACK.split(',')[0]!.replace(/"/g, '').trim());
  expect(diagnostics.locale).toBe(VISUAL_LOCALE);
  expect(diagnostics.iso).toBe(VISUAL_CLOCK_ISO);
  expect(diagnostics.now).toBe(Date.parse(VISUAL_CLOCK_ISO));
  expect(diagnostics.timezone).toBe(VISUAL_TIMEZONE);
  expect(diagnostics.activeTag).toBe('BODY');
  expect(diagnostics.scrollY).toBe(0);

  const webviewFixture = createStaticWebviewFixture();
  const presentationFixture = createStaticPresentationFixture();
  expect(() => assertSanitizedVisualFixture(webviewFixture)).not.toThrow();
  expect(() => assertSanitizedVisualFixture(presentationFixture)).not.toThrow();
  expect(() =>
    assertSanitizedVisualFixture({
      markdown: 'C:/Users/secret/project and sk-live-abcdefghijklmnopqrstuvwxyz012345',
    }),
  ).toThrow(/sanitized visual fixture/i);
});
