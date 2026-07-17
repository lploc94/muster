import { expect, test } from '@playwright/test';
import {
  NARROW_PRESENTATION_VIEWPORT,
  VISUAL_CLOCK_ISO,
  VISUAL_FONT_STACK,
  VISUAL_LOCALE,
  VISUAL_PLAYWRIGHT_USE,
  VISUAL_TIMEZONE,
  assertPresentationReadableContrast,
  assertSanitizedVisualFixture,
  contrastRatio,
  createStaticNarrowPresentationFixture,
  createStaticPresentationFixture,
  createStaticWebviewFixture,
  ensureVisualEnvironmentApplied,
  installVisualEnvironment,
  measurePresentationReadableContrast,
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
  const narrowFixture = createStaticNarrowPresentationFixture();
  expect(() => assertSanitizedVisualFixture(webviewFixture)).not.toThrow();
  expect(() => assertSanitizedVisualFixture(presentationFixture)).not.toThrow();
  expect(() => assertSanitizedVisualFixture(narrowFixture)).not.toThrow();
  expect(presentationFixture.markdown).toMatch(/```ts/);
  expect(presentationFixture.markdown).toMatch(/```mermaid/);
  expect(presentationFixture.markdown).toMatch(/\[.*\]\(https:\/\/example\.invalid\//);
  expect(presentationFixture.markdown).toMatch(/\| Area \| State \|/);
  expect(narrowFixture.presentationId).toBe('visual-narrow-presentation');
  expect(narrowFixture.revision).toBe(2);
  expect(narrowFixture.updatedAt).toBe(VISUAL_CLOCK_ISO);
  expect(narrowFixture.markdown).toMatch(/## Section/);
  expect(narrowFixture.markdown).toMatch(/```ts/);
  expect(NARROW_PRESENTATION_VIEWPORT).toEqual({ width: 360, height: 600 });
  expect(() =>
    assertSanitizedVisualFixture({
      markdown: 'C:/Users/secret/project and sk-live-abcdefghijklmnopqrstuvwxyz012345',
    }),
  ).toThrow(/sanitized visual fixture/i);
});

test('rejects black-on-black presentation contrast samples', async ({ page }) => {
  await installVisualEnvironment(page, { theme: 'dark' });
  await page.setContent(`
    <main class="presentation-shell">
      <article class="markdown-body presentation-content" style="background:#1e1e1e;color:#000">
        <table>
          <tr><th style="background:#0d1117;color:#000">Area</th><th style="background:#0d1117;color:#000">State</th></tr>
          <tr><td style="background:#0d1117;color:#000">Baseline</td><td style="background:#0d1117;color:#000">Pinned</td></tr>
        </table>
        <div class="mermaid-diagram" data-mermaid-state="rendered">
          <svg width="120" height="40">
            <g class="node"><rect width="50" height="30" fill="#000000"></rect><text x="8" y="20" fill="#000000">Start</text></g>
          </svg>
        </div>
      </article>
    </main>
  `);
  await ensureVisualEnvironmentApplied(page);
  // Force the pathological paints the contract must catch (inline styles beat theme tokens).
  await page.addStyleTag({
    content: `
      .presentation-content table th, .presentation-content table td {
        color: #000 !important;
        background: #0d1117 !important;
      }
      .mermaid-diagram svg .node rect { fill: #000 !important; }
      .mermaid-diagram svg text { fill: #000 !important; }
    `,
  });
  const report = await measurePresentationReadableContrast(page, { minRatio: 3 });
  expect(report.ok).toBe(false);
  expect(report.failures.join(' ')).toMatch(/table-cell|mermaid/i);
  await expect(assertPresentationReadableContrast(page)).rejects.toThrow(/contrast contract failed/i);
  expect(contrastRatio([0, 0, 0], [13, 17, 23])).toBeLessThan(1.5);
});
