import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Root is the webview/ dir regardless of the cwd that invoked `vite --config`.
const root = fileURLToPath(new URL('.', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/webview', import.meta.url));

function stablePresentationCssAlias(): Plugin {
  return {
    name: 'stable-presentation-css-alias',
    generateBundle(_options, bundle) {
      if (bundle['assets/presentation.css']) return;
      const cssAssets = Object.values(bundle).filter(
        (output): output is Extract<typeof output, { type: 'asset' }> =>
          output.type === 'asset' && output.fileName.endsWith('.css'),
      );
      if (cssAssets.length !== 1) {
        this.error(`Expected exactly one shared webview stylesheet, found ${cssAssets.length}`);
      }
      this.emitFile({
        type: 'asset',
        fileName: 'assets/presentation.css',
        source: cssAssets[0].source,
      });
    },
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [svelte(), tailwindcss(), stablePresentationCssAlias()],
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
