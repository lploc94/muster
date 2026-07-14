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
 * Multi-entry builds may split CSS several ways: one shared chunk sheet (named
 * after a chunk, e.g. markdown.css) carrying Tailwind/codicons, plus optional
 * entry-specific sheets already named index.css / presentation.css (an index-only
 * component's scoped styles land there). The host loads ONLY the two aliases, so
 * each alias must carry the COMPLETE stylesheet. Concatenate every emitted CSS
 * (shared base first, then per-entry styles) and write it to both aliases.
 */
function stableWebviewCssAliases(): Plugin {
  const aliases = ['assets/index.css', 'assets/presentation.css'] as const;
  const toText = (source: string | Uint8Array): string =>
    typeof source === 'string' ? source : Buffer.from(source).toString('utf8');

  return {
    name: 'stable-webview-css-aliases',
    generateBundle(_options, bundle) {
      const cssAssets = Object.values(bundle).filter(
        (output): output is Extract<typeof output, { type: 'asset' }> =>
          output.type === 'asset' && output.fileName.endsWith('.css'),
      );

      if (cssAssets.length === 0) {
        this.error('Expected at least one webview stylesheet to alias as index.css / presentation.css');
        return;
      }

      // Shared chunk sheets (Tailwind/codicons/app.css) come first so their base
      // layer precedes any entry-specific component styles.
      const shared = cssAssets.filter(
        (asset) => !aliases.includes(asset.fileName as (typeof aliases)[number]),
      );
      const base = shared.map((asset) => toText(asset.source)).join('\n');
      const ownText = (fileName: string): string => {
        const asset = bundle[fileName];
        return asset && asset.type === 'asset' ? toText(asset.source) : '';
      };

      // Both aliases get the full union of styles; unused per-entry selectors are
      // harmless, and this stays correct no matter how the bundler splits CSS.
      const complete = [base, ownText('assets/index.css'), ownText('assets/presentation.css')]
        .filter((chunk) => chunk.trim().length > 0)
        .join('\n');

      for (const fileName of aliases) {
        const existing = bundle[fileName];
        if (existing && existing.type === 'asset') {
          existing.source = complete;
        } else {
          this.emitFile({ type: 'asset', fileName, source: complete });
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
