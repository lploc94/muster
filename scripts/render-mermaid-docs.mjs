#!/usr/bin/env node
// Render fenced ```mermaid blocks from a Markdown file into SVG + PNG plus a small
// HTML gallery, so architecture diagrams can be reviewed as graphics.
//
// Zero new dependencies on purpose:
//   - mermaid    → already a webview dependency (webview/src/lib/mermaid-renderer.ts)
//   - playwright → already installed for e2e/visual regression
//
// Two environment details this script has to work around:
//   1. mermaid's ESM bundle lazy-imports relative chunks (`./chunks/mermaid.esm.min/*`).
//      Chromium blocks module fetches from `file://` (opaque origin), so the render host
//      page is served over an ephemeral loopback HTTP server instead. The server exposes
//      only `node_modules/mermaid/dist/` — no arbitrary repo files.
//   2. The pinned Playwright chromium build may not be downloaded locally. Launch falls
//      back to system Chrome, then Edge, before giving up with install guidance.
//
// Output lands in `artifacts/` (gitignored), so generated images never enter git.
//
// Usage:
//   node scripts/render-mermaid-docs.mjs [markdownPath] [--out <dir>] [--scale <n>] [--no-png]

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const mermaidDist = path.join(repoRoot, 'node_modules/mermaid/dist');

function parseArgs(argv) {
  const positional = [];
  const flags = { out: 'artifacts/diagrams', scale: 1, png: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--scale') flags.scale = Number(argv[++i]);
    else if (arg === '--no-png') flags.png = false;
    else positional.push(arg);
  }
  if (!Number.isFinite(flags.scale) || flags.scale <= 0) {
    throw new Error(`--scale must be a positive number, got ${flags.scale}`);
  }
  return { markdown: positional[0] ?? 'docs/ARCHITECTURE-DIAGRAMS.md', ...flags };
}

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'diagram';

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/** Extract mermaid blocks, naming each after its nearest preceding Markdown heading. */
function extractBlocks(markdown) {
  const blocks = [];
  let heading = 'diagram';
  let buffer = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (buffer === null) {
      const headingMatch = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
      if (headingMatch) heading = headingMatch[1];
      else if (/^\s*```mermaid\s*$/.test(line)) buffer = { heading, source: [] };
      continue;
    }
    if (/^\s*```\s*$/.test(line)) {
      const source = buffer.source.join('\n').trim();
      if (source) blocks.push({ heading: buffer.heading, source });
      buffer = null;
      continue;
    }
    buffer.source.push(line);
  }
  if (buffer !== null) throw new Error('Unterminated ```mermaid block in Markdown source.');
  return blocks.map((block, index) => ({
    ...block,
    id: `d${index}`,
    name: `${String(index + 1).padStart(2, '0')}-${slug(block.heading)}`,
    kind: block.source.split('\n', 1)[0].trim(),
  }));
}

const HOST_PAGE = `<!doctype html>
<meta charset="utf-8">
<body style="margin:0;background:#ffffff">
<div id="host"></div>
<script type="module">
import mermaid from '/mermaid/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'default' });
window.__renderDiagram = async (id, source) => (await mermaid.render(id, source)).svg;
window.__mermaidReady = true;
</script>
`;

const CONTENT_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Loopback server exposing the host page plus a read-only view of mermaid's dist dir. */
async function startRenderServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HOST_PAGE);
      return;
    }
    if (!url.pathname.startsWith('/mermaid/')) {
      res.writeHead(404).end('not found');
      return;
    }
    const target = path.resolve(mermaidDist, decodeURIComponent(url.pathname.slice('/mermaid/'.length)));
    if (target !== mermaidDist && !target.startsWith(mermaidDist + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
      }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Bundled chromium first; fall back to installed Chrome / Edge so the script works offline. */
async function launchBrowser() {
  const candidates = [
    { label: 'bundled chromium', options: {} },
    { label: 'system Chrome', options: { channel: 'chrome' } },
    { label: 'system Edge', options: { channel: 'msedge' } },
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const browser = await chromium.launch(candidate.options);
      return { browser, label: candidate.label };
    } catch (error) {
      errors.push(`${candidate.label}: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  throw new Error(
    `No usable Chromium found. Run \`npx playwright install chromium\`, or install Chrome/Edge.\n  ${errors.join('\n  ')}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const markdownPath = path.resolve(repoRoot, args.markdown);
  const outDir = path.resolve(repoRoot, args.out);

  if (!existsSync(markdownPath)) throw new Error(`Markdown file not found: ${markdownPath}`);
  if (!existsSync(mermaidDist)) throw new Error('mermaid not installed — run `npm install` first.');

  const blocks = extractBlocks(await readFile(markdownPath, 'utf8'));
  if (blocks.length === 0) {
    console.log(`No \`\`\`mermaid blocks found in ${path.relative(repoRoot, markdownPath)}.`);
    return;
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const server = await startRenderServer();
  const { browser, label } = await launchBrowser();
  console.log(`Rendering ${blocks.length} diagram(s) with ${label}\n`);
  const failures = [];
  try {
    const page = await browser.newPage({
      deviceScaleFactor: 2,
      viewport: { width: 1600, height: 900 },
    });
    const pageProblems = [];
    page.on('pageerror', (error) => pageProblems.push(`pageerror: ${error.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageProblems.push(`console: ${msg.text()}`);
    });

    await page.goto(server.origin);
    try {
      await page.waitForFunction('window.__mermaidReady === true', undefined, { timeout: 20_000 });
    } catch {
      throw new Error(
        `mermaid failed to load in the page.${pageProblems.length ? `\n  ${pageProblems.join('\n  ')}` : ''}`,
      );
    }

    for (const block of blocks) {
      let svg;
      try {
        svg = await page.evaluate(
          ([id, source]) => window.__renderDiagram(id, source),
          [block.id, block.source],
        );
      } catch (error) {
        failures.push(`${block.name} (${block.kind}): ${String(error?.message ?? error).split('\n')[0]}`);
        console.log(`FAIL ${block.name} — ${block.kind}`);
        continue;
      }

      await writeFile(path.join(outDir, `${block.name}.svg`), svg, 'utf8');

      let pngNote = '';
      if (args.png) {
        // Pin the SVG to its natural viewBox size (times --scale) so the element
        // screenshot is not clamped by mermaid's own `max-width` style.
        const size = await page.evaluate(
          ([markup, scale]) => {
            const host = document.getElementById('host');
            host.innerHTML = markup;
            const el = host.querySelector('svg');
            const box = el.viewBox?.baseVal;
            const width = Math.ceil((box?.width || el.clientWidth || 800) * scale);
            const height = Math.ceil((box?.height || el.clientHeight || 600) * scale);
            el.removeAttribute('style');
            el.setAttribute('width', String(width));
            el.setAttribute('height', String(height));
            host.style.width = `${width}px`;
            return { width, height };
          },
          [svg, args.scale],
        );
        await page.setViewportSize({
          width: Math.min(4000, Math.max(320, size.width)),
          height: Math.min(4000, Math.max(240, size.height)),
        });
        await page.locator('#host').screenshot({ path: path.join(outDir, `${block.name}.png`) });
        pngNote = ` + png ${size.width * 2}x${size.height * 2}`;
      }
      console.log(`OK   ${block.name} — ${block.kind}${pngNote}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const rendered = blocks.filter((block) => existsSync(path.join(outDir, `${block.name}.svg`)));
  const sourceRel = path.relative(repoRoot, markdownPath).replace(/\\/g, '/');
  const gallery = `<!doctype html>
<meta charset="utf-8">
<title>Muster architecture diagrams</title>
<style>
  body { margin: 0; padding: 24px 32px; background: #f6f7f9; color: #1f2328;
         font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.src { margin: 0 0 28px; color: #59636e; font-size: 13px; }
  section { background: #fff; border: 1px solid #d8dee4; border-radius: 8px;
            padding: 16px 20px; margin-bottom: 24px; overflow-x: auto; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  img { max-width: 100%; height: auto; display: block; }
</style>
<h1>Muster architecture diagrams</h1>
<p class="src">Generated from ${escapeHtml(sourceRel)} — regenerate with <code>npm run docs:diagrams</code></p>
${rendered
  .map(
    (block) =>
      `<section><h2>${escapeHtml(block.heading)}</h2><img src="${block.name}.svg" alt="${escapeHtml(block.heading)} diagram"></section>`,
  )
  .join('\n')}
`;
  await writeFile(path.join(outDir, 'index.html'), gallery, 'utf8');

  const galleryPath = path.relative(repoRoot, path.join(outDir, 'index.html')).replace(/\\/g, '/');
  console.log(`\n${rendered.length}/${blocks.length} diagram(s) rendered → ${galleryPath}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
