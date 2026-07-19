#!/usr/bin/env node
/**
 * Phase 6 webview virtualization resource benchmark.
 *
 * Launches the production webview build in Chromium, injects a large transcript
 * fixture (direct 2000-item snapshot — benchmark-only), settles + double-GC
 * samples heap/DOM via CDP, traverses oldest/middle/latest, and asserts:
 *   retainedDeltaBytes <= 16 MiB
 *   finalUsedBytes <= 1.5 * baselineUsedBytes
 *   every sampled domNodes <= baselineDomNodes + 2500
 *   finalDomNodes <= baselineDomNodes + 250
 *   mounted transcript rows <= 80
 *
 * Usage:
 *   npm run bench:phase6-webview
 *   node scripts/bench-phase6-webview.mjs --json-out path.json
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, extname, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const webviewDist = resolve(root, 'dist/webview');
const TOTAL = 2000;
const MAX_MOUNTED = 80;
const MAX_RETAINED_DELTA = 16 * 1024 * 1024;
const MAX_DOM_PEAK_DELTA = 2500;
const MAX_DOM_FINAL_DELTA = 250;
const HEAP_RATIO = 1.5;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.map':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

function buildHistory(total) {
  const items = [];
  for (let i = 0; i < total; i += 1) {
    const n = i + 1;
    const turnId = `turn-${Math.floor(i / 4) + 1}`;
    const mod = i % 6;
    if (mod === 0) {
      items.push({
        id: `u-${n}`,
        kind: 'user',
        content: `User ${n}`,
        turnId,
        order: 0,
      });
    } else if (mod === 1) {
      // n = i+1 and mod===1 ⇒ n ≡ 2 (mod 6). Use n % 12 === 2 for reachable tall rows.
      const tall = n % 12 === 2;
      items.push({
        id: `a-${n}`,
        kind: 'assistant',
        content: tall
          ? `# Tall markdown ${n}\n\n${'paragraph with **bold** and code sample line.\n\n'.repeat(40)}\`\`\`ts\nconst x = ${n};\nconsole.log(x);\n\`\`\`\n`
          : `Assistant ${n}`,
        turnId,
        order: 1,
        state: 'complete',
      });
    } else if (mod === 2) {
      items.push({
        id: `t-${n}`,
        kind: 'tool',
        turnId,
        order: 2,
        content: {
          toolCallId: `t-${n}`,
          name: 'bash',
          toolKind: 'builtin',
          status: 'success',
          input: { cmd: `echo ${n}` },
          output: `out-${n}`,
        },
      });
    } else if (mod === 3) {
      items.push({
        id: `r-${n}`,
        kind: 'reasoning',
        turnId,
        content: `think ${n} ${'x'.repeat(40)}`,
      });
    } else if (mod === 4) {
      items.push({
        id: `u-${n}`,
        kind: 'user',
        content: `Short ${n}`,
        turnId,
        order: 0,
      });
    } else {
      items.push({
        id: `a-${n}`,
        kind: 'assistant',
        content: `Mid ${n}`,
        turnId,
        order: 1,
        state: 'complete',
      });
    }
  }
  const tallCount = items.filter(
    (item) =>
      item.kind === 'assistant' &&
      typeof item.content === 'string' &&
      // Multi-paragraph markdown with fenced code (~1KiB+ of body text).
      item.content.length > 800 &&
      item.content.includes('```'),
  ).length;
  if (tallCount < 10) {
    throw new Error(
      `bench fixture missing multi-kilobyte tall Markdown rows (found ${tallCount})`,
    );
  }
  return items;
}

function startStaticServer(dir) {
  return new Promise((resolveServer, reject) => {
    const server = createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] || '/');
        const rel = urlPath === '/' ? '/index.html' : urlPath;
        const filePath = resolve(dir, `.${rel}`);
        if (!filePath.startsWith(dir)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        if (!existsSync(filePath)) {
          res.writeHead(404);
          res.end('missing');
          return;
        }
        const body = readFileSync(filePath);
        res.writeHead(200, { 'content-type': contentType(filePath) });
        res.end(body);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolveServer({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

async function settleAndSample(page, cdp, mountedSelector = '[data-transcript-id]') {
  await page.evaluate(
    () =>
      new Promise((resolveSettle) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolveSettle, 100);
          });
        });
      }),
  );
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  const mounted = await page.locator(mountedSelector).count();
  return {
    usedSize: heap.usedSize,
    domNodes: dom.nodes,
    mountedRows: mounted,
  };
}

function buildWideTree(count) {
  const root = {
    id: 'tree-root',
    parentId: null,
    goal: 'Root coordinator',
    role: 'coordinator',
    lifecycle: 'open',
    runtimeActivity: 'idle',
    viewStatus: 'idle',
    currentTurnActivity: null,
    updatedAt: '2026-07-18T00:00:00.000Z',
    backend: 'claude',
  };
  const children = [];
  for (let i = 0; i < count - 1; i += 1) {
    children.push({
      ...root,
      id: `tree-c-${i}`,
      parentId: 'tree-root',
      goal: `Wide child ${i}`,
      role: 'worker',
    });
  }
  return [root, ...children];
}

async function main() {
  if (!existsSync(join(webviewDist, 'index.html'))) {
    console.error('Missing dist/webview. Run npm run build:webview first.');
    process.exit(2);
  }

  const history = buildHistory(TOTAL);
  const task = {
    id: 'task-bench',
    parentId: null,
    goal: 'Phase 6 bench',
    role: 'coordinator',
    lifecycle: 'open',
    runtimeActivity: 'idle',
    viewStatus: 'idle',
    currentTurnActivity: null,
    updatedAt: '2026-07-18T00:00:00.000Z',
    backend: 'claude',
  };

  const { server, port } = await startStaticServer(webviewDist);
  const browser = await chromium.launch({ headless: true });
  const started = Date.now();
  const samples = [];
  let peakDom = 0;
  let peakMounted = 0;

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');

    await page.addInitScript(() => {
      const bag = { value: undefined };
      window.__musterVsCodeState = bag;
      window.__musterPostedMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          window.__musterPostedMessages = [
            ...(window.__musterPostedMessages ?? []),
            structuredClone(message),
          ];
        },
        getState() {
          return window.__musterVsCodeState.value;
        },
        setState(next) {
          window.__musterVsCodeState.value = next;
        },
      });
    });

    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=New task');

    // Benchmark-only: direct large snapshot (not the paging acceptance path).
    await page.evaluate(
      ({ task, history }) => {
        window.postMessage(
          {
            type: 'snapshot',
            protocolVersion: 9,
            rootTasks: [task],
            focusedTaskId: task.id,
            subtree: [task],
            transcript: history,
            transcriptPage: {
              hasMoreBefore: false,
              workspaceRevision: 1,
            },
            storeRevision: 1,
          },
          '*',
        );
      },
      { task, history },
    );

    await page.waitForSelector('[data-transcript-id]', { timeout: 30_000 });
    // Scroll to latest first.
    await page.locator('[data-testid="chat-thread-scroll"]').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(100);

    const baseline = await settleAndSample(page, cdp);
    samples.push({ label: 'baseline_latest', ...baseline });
    peakDom = Math.max(peakDom, baseline.domNodes);
    peakMounted = Math.max(peakMounted, baseline.mountedRows);

    const scroll = page.locator('[data-testid="chat-thread-scroll"]');
    // oldest
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(150);
    const oldest = await settleAndSample(page, cdp);
    samples.push({ label: 'oldest', ...oldest });
    peakDom = Math.max(peakDom, oldest.domNodes);
    peakMounted = Math.max(peakMounted, oldest.mountedRows);

    // middle
    await scroll.evaluate((el) => {
      el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(150);
    const middle = await settleAndSample(page, cdp);
    samples.push({ label: 'middle', ...middle });
    peakDom = Math.max(peakDom, middle.domNodes);
    peakMounted = Math.max(peakMounted, middle.mountedRows);

    // latest again
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(150);
    const finalSample = await settleAndSample(page, cdp);
    samples.push({ label: 'final_latest', ...finalSample });
    peakDom = Math.max(peakDom, finalSample.domNodes);
    peakMounted = Math.max(peakMounted, finalSample.mountedRows);

    const retainedDeltaBytes = Math.max(0, finalSample.usedSize - baseline.usedSize);
    const heapOk =
      retainedDeltaBytes <= MAX_RETAINED_DELTA &&
      finalSample.usedSize <= HEAP_RATIO * baseline.usedSize;
    const domPeakOk = samples.every((s) => s.domNodes <= baseline.domNodes + MAX_DOM_PEAK_DELTA);
    const domFinalOk = finalSample.domNodes <= baseline.domNodes + MAX_DOM_FINAL_DELTA;
    const mountedOk = peakMounted <= MAX_MOUNTED && samples.every((s) => s.mountedRows <= MAX_MOUNTED);
    const chatPass = heapOk && domPeakOk && domFinalOk && mountedOk;

    // --- Expanded task-tree virtualization fixture (5000 visible rows) ---
    const TREE_N = 5000;
    const MAX_TREE_MOUNTED = 100;
    const treeSubtree = buildWideTree(TREE_N);
    const treeRoot = treeSubtree[0];
    await page.evaluate(
      ({ root, subtree }) => {
        window.postMessage(
          {
            type: 'snapshot',
            protocolVersion: 9,
            rootTasks: [root],
            focusedTaskId: root.id,
            subtree,
            transcript: [
              {
                id: 'msg-tree',
                kind: 'assistant',
                content: 'Tree ready',
                turnId: 'tt',
                order: 1,
                state: 'complete',
              },
            ],
            transcriptPage: { hasMoreBefore: false, workspaceRevision: 2 },
            storeRevision: 2,
          },
          '*',
        );
      },
      { root: treeRoot, subtree: treeSubtree },
    );
    await page.waitForSelector('[data-testid="task-tree-summary"]', { timeout: 30_000 });
    await page.getByTestId('task-tree-summary').click();
    await page.waitForTimeout(150);

    const treeSamples = [];
    let treePeakDom = 0;
    let treePeakMounted = 0;
    const treeBaseline = await settleAndSample(page, cdp, '[data-testid="task-tree-row"]');
    treeSamples.push({ label: 'tree_baseline_expanded', ...treeBaseline });
    treePeakDom = Math.max(treePeakDom, treeBaseline.domNodes);
    treePeakMounted = Math.max(treePeakMounted, treeBaseline.mountedRows);

    const treeList = page.getByTestId('task-chrome-tree');
    await treeList.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(120);
    const treeEnd = await settleAndSample(page, cdp, '[data-testid="task-tree-row"]');
    treeSamples.push({ label: 'tree_end', ...treeEnd });
    treePeakDom = Math.max(treePeakDom, treeEnd.domNodes);
    treePeakMounted = Math.max(treePeakMounted, treeEnd.mountedRows);

    await treeList.evaluate((el) => {
      el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(120);
    const treeMid = await settleAndSample(page, cdp, '[data-testid="task-tree-row"]');
    treeSamples.push({ label: 'tree_middle', ...treeMid });
    treePeakDom = Math.max(treePeakDom, treeMid.domNodes);
    treePeakMounted = Math.max(treePeakMounted, treeMid.mountedRows);

    await treeList.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(120);
    const treeFinal = await settleAndSample(page, cdp, '[data-testid="task-tree-row"]');
    treeSamples.push({ label: 'tree_final_top', ...treeFinal });
    treePeakDom = Math.max(treePeakDom, treeFinal.domNodes);
    treePeakMounted = Math.max(treePeakMounted, treeFinal.mountedRows);

    const treeRetained = Math.max(0, treeFinal.usedSize - treeBaseline.usedSize);
    const treeHeapOk =
      treeRetained <= MAX_RETAINED_DELTA && treeFinal.usedSize <= HEAP_RATIO * treeBaseline.usedSize;
    const treeDomPeakOk = treeSamples.every(
      (s) => s.domNodes <= treeBaseline.domNodes + MAX_DOM_PEAK_DELTA,
    );
    const treeDomFinalOk = treeFinal.domNodes <= treeBaseline.domNodes + MAX_DOM_FINAL_DELTA;
    const treeMountedOk =
      treePeakMounted <= MAX_TREE_MOUNTED &&
      treeSamples.every((s) => s.mountedRows <= MAX_TREE_MOUNTED);
    const treePass = treeHeapOk && treeDomPeakOk && treeDomFinalOk && treeMountedOk;

    const pass = chatPass && treePass;

    const result = {
      status: pass ? 'PASS' : 'FAIL',
      fixture: {
        transcriptItems: TOTAL,
        treeVisibleRows: TREE_N,
        contentClasses: ['user', 'assistant', 'tool', 'reasoning', 'tall-markdown', 'wide-tree'],
      },
      viewport: { width: 1280, height: 720 },
      thresholds: {
        maxMountedRows: MAX_MOUNTED,
        maxTreeMountedRows: MAX_TREE_MOUNTED,
        maxRetainedDeltaBytes: MAX_RETAINED_DELTA,
        heapRatio: HEAP_RATIO,
        maxDomPeakDelta: MAX_DOM_PEAK_DELTA,
        maxDomFinalDelta: MAX_DOM_FINAL_DELTA,
      },
      metrics: {
        baselineUsedBytes: baseline.usedSize,
        finalUsedBytes: finalSample.usedSize,
        retainedDeltaBytes,
        baselineDomNodes: baseline.domNodes,
        peakDomNodes: peakDom,
        finalDomNodes: finalSample.domNodes,
        peakMountedRows: peakMounted,
        samples,
        tree: {
          baselineUsedBytes: treeBaseline.usedSize,
          finalUsedBytes: treeFinal.usedSize,
          retainedDeltaBytes: treeRetained,
          baselineDomNodes: treeBaseline.domNodes,
          peakDomNodes: treePeakDom,
          finalDomNodes: treeFinal.domNodes,
          peakMountedRows: treePeakMounted,
          logicalRows: TREE_N,
          samples: treeSamples,
        },
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        browser: 'chromium',
      },
      durationMs: Date.now() - started,
    };

    const jsonOut = argValue('--json-out');
    if (jsonOut) {
      writeFileSync(resolve(jsonOut), `${JSON.stringify(result, null, 2)}\n`);
    }

    console.log(JSON.stringify(result, null, 2));
    if (!pass) {
      console.error('BUDGET FAIL: phase6 webview virtualization thresholds exceeded');
      process.exitCode = 1;
    } else {
      console.error('BUDGET PASS: phase6 webview virtualization');
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
