import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Root is the webview/ dir regardless of the cwd that invoked `vite --config`.
const root = fileURLToPath(new URL('.', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/webview', import.meta.url));

/**
 * Host loads stable paths:
 *   - dist/webview/assets/index.css        (main chat webview — extension.ts)
 *   - dist/webview/assets/presentation.css (presentation panel)
 *
 * Multi-entry + shared CSS can name the extracted sheet after a chunk (e.g.
 * markdown.css). Emit the host-expected aliases from that single stylesheet.
 */
function stableWebviewCssAliases(): Plugin {
  const aliases = ['assets/index.css', 'assets/presentation.css'] as const;

  return {
    name: 'stable-webview-css-aliases',
    generateBundle(_options, bundle) {
      const cssAssets = Object.values(bundle).filter(
        (output): output is Extract<typeof output, { type: 'asset' }> =>
          output.type === 'asset' &&
          output.fileName.endsWith('.css') &&
          !aliases.includes(output.fileName as (typeof aliases)[number]),
      );

      if (cssAssets.length === 0) {
        // Already emitted under a stable name (e.g. only index.css in bundle).
        const hasIndex = Boolean(bundle['assets/index.css']);
        const hasPresentation = Boolean(bundle['assets/presentation.css']);
        if (hasIndex && hasPresentation) return;
        if (hasIndex && !hasPresentation) {
          const source = (bundle['assets/index.css'] as { source: string | Uint8Array }).source;
          this.emitFile({ type: 'asset', fileName: 'assets/presentation.css', source });
          return;
        }
        if (hasPresentation && !hasIndex) {
          const source = (bundle['assets/presentation.css'] as { source: string | Uint8Array }).source;
          this.emitFile({ type: 'asset', fileName: 'assets/index.css', source });
          return;
        }
        this.error('Expected a webview stylesheet to alias as index.css / presentation.css');
      }

      if (cssAssets.length !== 1) {
        this.error(
          `Expected exactly one shared webview stylesheet to alias, found ${cssAssets.length}: ${cssAssets
            .map((a) => a.fileName)
            .join(', ')}`,
        );
      }

      const source = cssAssets[0].source;
      for (const fileName of aliases) {
        if (!bundle[fileName]) {
          this.emitFile({ type: 'asset', fileName, source });
        }
      }
    },
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [svelte(), tailwindcss(), stableWebviewCssAliases()],
  build: {
    outDir,
    emptyOutDir: true,
    // Pin non-hashed names so the extension host can load a stable path
    // (see docs/WEBVIEW.md §2).
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        presentation: resolve(root, 'presentation.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
