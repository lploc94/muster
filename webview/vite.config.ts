import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Root is the webview/ dir regardless of the cwd that invoked `vite --config`.
const root = fileURLToPath(new URL('.', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/webview', import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir,
    emptyOutDir: true,
    // Pin non-hashed names so the extension host can load a stable path
    // (see docs/WEBVIEW.md §2).
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
