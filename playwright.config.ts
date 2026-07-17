import { defineConfig, devices } from '@playwright/test';
import { VISUAL_PLAYWRIGHT_USE } from './e2e/fixtures/visual-environment';

/**
 * Behavioral suites stay on the default `chromium` project.
 * Visual pilots use `visual-chromium` with deterministic locale/timezone/scale
 * and strict screenshot comparison options. Snapshot paths are platform-suffix
 * free so the pinned Linux authoring environment owns the golden images (T03).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  reporter: [['list']],
  // Predictable artifact path: e2e/visual/<file>.ts-snapshots/<name>.png
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // Retain trace + failure screenshots for visual diagnosis (no auto-update).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/visual/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'visual-chromium',
      testMatch: ['**/visual/**/*.visual.spec.ts', '**/visual/**/*-slice-flows.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        ...VISUAL_PLAYWRIGHT_USE,
        viewport: { width: 1280, height: 720 },
        // CSS scale keeps device pixels deterministic at deviceScaleFactor: 1.
        deviceScaleFactor: VISUAL_PLAYWRIGHT_USE.deviceScaleFactor,
      },
      expect: {
        toHaveScreenshot: {
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
          // Strict pilot compare; intentional updates use --update-snapshots only.
          maxDiffPixelRatio: 0,
          threshold: 0,
        },
      },
    },
  ],
  webServer: {
    command: 'npx vite --config webview/vite.config.ts --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
