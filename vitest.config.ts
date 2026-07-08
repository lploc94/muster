import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Host/source tests default to the lightweight `node` environment.
    // Webview tests that need a DOM (e.g. the DOMPurify-based sanitizer) opt
    // into `jsdom` per-file via a `// @vitest-environment jsdom` docblock —
    // see webview/src/lib/markdown.test.ts. jsdom is DOMPurify's reference DOM;
    // happy-dom was evaluated but silently drops DOMPurify's URI filtering and
    // afterSanitizeAttributes hook (a `javascript:` href survives), so it can't
    // genuinely exercise the sanitizer.
    environment: 'node',
    include: ['src/**/*.test.ts', 'webview/src/**/*.test.ts'],
  },
});
