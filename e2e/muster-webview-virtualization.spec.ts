import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6 chat virtualization browser contracts.
 * Protocol-conformant large history: bootstrap <=100, then owned older pages.
 */

const PROTOCOL_VERSION = 9;
const BOOTSTRAP = 100;
const PAGE = 100;
const TOTAL = 2000;
const PAGES = (TOTAL - BOOTSTRAP) / PAGE; // 19
const MAX_MOUNTED = 80;

interface TranscriptItem {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'reasoning';
  content: unknown;
  turnId?: string;
  order?: number;
  state?: string;
}

interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: string;
  lifecycle: string;
  runtimeActivity: string | null;
  viewStatus: string;
  currentTurnActivity: null;
  updatedAt: string;
  backend: string;
}

declare global {
  interface Window {
    __musterPostedMessages?: unknown[];
    __musterVsCodeState?: { value: unknown };
  }
}

function task(id = 'task-virt'): TaskSummary {
  return {
    id,
    parentId: null,
    goal: 'Virtualization fixture task',
    role: 'coordinator',
    lifecycle: 'open',
    runtimeActivity: 'idle',
    viewStatus: 'idle',
    currentTurnActivity: null,
    updatedAt: '2026-07-18T00:00:00.000Z',
    backend: 'claude',
  };
}

/** Build TOTAL mixed-height items in chronological order (oldest → newest). */
function buildHistory(total = TOTAL): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (let i = 0; i < total; i += 1) {
    const n = i + 1;
    const turnId = `turn-${Math.floor(i / 4) + 1}`;
    const mod = i % 8;
    if (mod === 0) {
      items.push({
        id: `u-${n}`,
        kind: 'user',
        content: `User message ${n}`,
        turnId,
        order: 0,
      });
    } else if (mod === 1) {
      items.push({
        id: `r-${n}`,
        kind: 'reasoning',
        turnId,
        content: `Reasoning block ${n}: ${'think '.repeat(20)}`,
      });
    } else if (mod === 2) {
      items.push({
        id: `a-${n}`,
        kind: 'assistant',
        content:
          n % 17 === 0
            ? `# Tall markdown ${n}\n\n${'paragraph with **bold** and code.\n\n'.repeat(12)}\`\`\`ts\nconst x = ${n};\n\`\`\`\n`
            : `Assistant reply ${n}`,
        turnId,
        order: 1,
        state: 'complete',
      });
    } else if (mod === 3) {
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
    } else if (mod === 4) {
      items.push({
        id: `u-${n}`,
        kind: 'user',
        content: `Short ${n}`,
        turnId,
        order: 0,
      });
    } else if (mod === 5) {
      items.push({
        id: `a-${n}`,
        kind: 'assistant',
        content: `Mid ${n}`,
        turnId,
        order: 1,
        state: 'complete',
      });
    } else if (mod === 6) {
      items.push({
        id: `t-${n}`,
        kind: 'tool',
        turnId,
        order: 2,
        content: {
          toolCallId: `t-${n}`,
          name: 'read',
          toolKind: 'builtin',
          status: 'success',
          input: { path: `f-${n}.ts` },
          output: 'ok',
        },
      });
    } else {
      items.push({
        id: `a-${n}`,
        kind: 'assistant',
        content: `Tail ${n}`,
        turnId,
        order: 1,
        state: 'complete',
      });
    }
  }
  return items;
}

/** Settled list items exclude reasoning (turn-scoped header). */
function settledIds(items: TranscriptItem[]): string[] {
  return items.filter((item) => item.kind !== 'reasoning').map((item) => item.id);
}

function cursorForIndex(index: number): string {
  // Opaque fixture cursor; webview only echoes it back for ownership checks.
  return `v2.fix-${index}`;
}

async function openWebview(page: Page) {
  await page.addInitScript(() => {
    const bag = { value: undefined as unknown };
    (window as unknown as { __musterVsCodeState: { value: unknown } }).__musterVsCodeState = bag;
    (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
      postMessage(message: unknown) {
        const cloned = structuredClone(message);
        window.__musterPostedMessages = [...(window.__musterPostedMessages ?? []), cloned];
        window.dispatchEvent(new CustomEvent('muster:test:postMessage', { detail: cloned }));
      },
      getState() {
        return (window as unknown as { __musterVsCodeState: { value: unknown } }).__musterVsCodeState
          .value;
      },
      setState(nextState: unknown) {
        (window as unknown as { __musterVsCodeState: { value: unknown } }).__musterVsCodeState.value =
          nextState;
      },
    });
  });
  await page.goto('/');
  await page.evaluate(() => {
    window.__musterPostedMessages = [];
  });
  await expect(page.getByText('New task')).toBeVisible();
}

async function postHost(page: Page, message: unknown) {
  await page.evaluate((msg) => {
    window.postMessage(msg, '*');
  }, message);
}

async function postFocusedSnapshot(
  page: Page,
  opts: {
    taskId?: string;
    transcript: TranscriptItem[];
    storeRevision: number;
    hasMoreBefore: boolean;
    beforeCursor?: string;
    activeTurnId?: string;
  },
) {
  const t = task(opts.taskId ?? 'task-virt');
  await postHost(page, {
    type: 'snapshot',
    protocolVersion: PROTOCOL_VERSION,
    rootTasks: [t],
    focusedTaskId: t.id,
    subtree: [t],
    transcript: opts.transcript,
    transcriptPage: {
      hasMoreBefore: opts.hasMoreBefore,
      workspaceRevision: opts.storeRevision,
      ...(opts.hasMoreBefore && opts.beforeCursor ? { beforeCursor: opts.beforeCursor } : {}),
    },
    activeTurnId: opts.activeTurnId,
    storeRevision: opts.storeRevision,
  });
}

async function postedMessages(page: Page): Promise<unknown[]> {
  return page.evaluate(() => window.__musterPostedMessages ?? []);
}

async function clearPosted(page: Page) {
  await page.evaluate(() => {
    window.__musterPostedMessages = [];
  });
}

async function mountedTranscriptCount(page: Page): Promise<number> {
  return page.locator('[data-transcript-id]').count();
}

async function scrollThread(page: Page, top: number) {
  await page.locator('[data-testid="chat-thread-scroll"]').evaluate((el, y) => {
    el.scrollTop = y;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, top);
  // Allow TanStack observeElementOffset + Svelte publish to settle.
  await page.waitForTimeout(40);
}

async function scrollThreadTo(page: Page, position: 'top' | 'middle' | 'bottom') {
  // Write scrollTop several times while the virtualizer's measured total size settles.
  for (let i = 0; i < 6; i += 1) {
    await page.locator('[data-testid="chat-thread-scroll"]').evaluate((el, pos) => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (pos === 'bottom') el.scrollTop = max;
      else if (pos === 'middle') el.scrollTop = Math.floor(max * 0.5);
      else el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, position);
    await page.waitForTimeout(30);
  }
}

async function waitForId(page: Page, id: string, timeout = 20_000) {
  // Binary-search the virtual scroller using data-index on mounted rows.
  const scroll = page.locator('[data-testid="chat-thread-scroll"]');
  const deadline = Date.now() + timeout;

  const probe = async (): Promise<{ found: boolean; lo: number; hi: number; maxScroll: number }> => {
    return page.evaluate((targetId) => {
      const el = document.querySelector<HTMLElement>('[data-testid="chat-thread-scroll"]');
      if (!el) return { found: false, lo: 0, hi: 0, maxScroll: 0 };
      const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-id]'));
      const hit = rows.find((row) => row.dataset.transcriptId === targetId);
      if (hit) {
        hit.scrollIntoView({ block: 'center' });
        return { found: true, lo: 0, hi: 0, maxScroll: el.scrollHeight - el.clientHeight };
      }
      const indexes = rows
        .map((row) => Number(row.dataset.index))
        .filter((n) => Number.isFinite(n));
      const lo = indexes.length ? Math.min(...indexes) : 0;
      const hi = indexes.length ? Math.max(...indexes) : 0;
      return {
        found: false,
        lo,
        hi,
        maxScroll: Math.max(0, el.scrollHeight - el.clientHeight),
      };
    }, id);
  };

  // Seed at bottom, then walk by index order.
  await scrollThreadTo(page, 'bottom');
  let low = 0;
  let high = 1;
  {
    const p0 = await probe();
    if (p0.found) return;
    high = Math.max(p0.maxScroll, 1);
  }

  while (Date.now() < deadline) {
    const mid = Math.floor((low + high) / 2);
    await scroll.evaluate((el, y) => {
      el.scrollTop = y;
      el.dispatchEvent(new Event('scroll'));
    }, mid);
    await page.waitForTimeout(40);
    const p = await probe();
    if (p.found) {
      await expect(page.locator(`[data-transcript-id="${id}"]`)).toBeVisible();
      return;
    }
    // If we cannot see indexes yet, expand search window.
    if (p.hi <= p.lo) {
      // Linear sweep fallback.
      await scroll.evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollTop - Math.max(el.clientHeight, 200));
        el.dispatchEvent(new Event('scroll'));
      });
      continue;
    }
    // We need the target id's chronological position relative to the visible window.
    // Compare target id numeric suffix when present; otherwise move toward older.
    const targetNum = Number(String(id).replace(/\D+/g, '')) || 0;
    const midNum = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-transcript-id]'),
      );
      const midRow = rows[Math.floor(rows.length / 2)];
      return Number(String(midRow?.dataset.transcriptId ?? '').replace(/\D+/g, '')) || 0;
    });
    if (targetNum < midNum) {
      // Target is older → toward top (smaller scrollTop).
      high = mid;
    } else {
      low = mid + 1;
    }
    if (low >= high) {
      // Restart with a linear top sweep.
      await scrollThreadTo(page, 'top');
      for (let i = 0; i < 80 && Date.now() < deadline; i += 1) {
        const again = await probe();
        if (again.found) {
          await expect(page.locator(`[data-transcript-id="${id}"]`)).toBeVisible();
          return;
        }
        await scroll.evaluate((el) => {
          el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(el.clientHeight * 0.8, 200));
          el.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(20);
      }
      break;
    }
  }
  throw new Error(`Timed out waiting for transcript id ${id}`);
}

async function loadAllOlderPages(
  page: Page,
  history: TranscriptItem[],
  taskId: string,
): Promise<string[]> {
  // history is oldest→newest. Bootstrap is the last BOOTSTRAP items.
  const fullSettled = settledIds(history);
  const accumulated = settledIds(history.slice(history.length - BOOTSTRAP));
  let oldestLoadedIndex = history.length - BOOTSTRAP; // index of oldest loaded in full history
  let expectedCursor = cursorForIndex(oldestLoadedIndex);

  for (let pageNum = 0; pageNum < PAGES; pageNum += 1) {
    await clearPosted(page);
    // Capture the first-visible anchor BEFORE the load request, matching the
    // production capture timing inside requestOlder (not after an async wait).
    await scrollThread(page, 0);
    const anchorBefore = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('[data-testid="chat-thread-scroll"]');
      if (!scroll) return null;
      const scrollRect = scroll.getBoundingClientRect();
      const rows = Array.from(
        scroll.querySelectorAll<HTMLElement>('[data-transcript-id]'),
      );
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > scrollRect.top + 1 && row.dataset.transcriptId) {
          return {
            id: row.dataset.transcriptId,
            y: rect.top - scrollRect.top,
          };
        }
      }
      const first = rows[0];
      if (!first?.dataset.transcriptId) return null;
      const rect = first.getBoundingClientRect();
      return { id: first.dataset.transcriptId, y: rect.top - scrollRect.top };
    });

    // Trigger older load via top scroll or button.
    const loadBtn = page.getByRole('button', { name: 'Load earlier messages' });
    if (await loadBtn.count()) {
      await loadBtn.first().click({ force: true });
    } else {
      // Edge-trigger near-top again if the button was already consumed.
      await scrollThread(page, 20);
      await scrollThread(page, 0);
    }

    const request = await expect
      .poll(async () => {
        const msgs = await postedMessages(page);
        return msgs.find(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'loadTranscriptPage',
        );
      }, { timeout: 10_000 })
      .toBeTruthy()
      .then(async () => {
        const msgs = await postedMessages(page);
        const loads = msgs.filter(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'loadTranscriptPage',
        );
        expect(loads.length).toBe(1);
        return loads[0] as {
          type: string;
          requestId: string;
          taskId: string;
          beforeCursor: string;
        };
      });

    expect(request.taskId).toBe(taskId);
    expect(typeof request.requestId).toBe('string');
    // Cursor must match the page window the webview was given (not an arbitrary non-empty string).
    expect(request.beforeCursor).toBe(expectedCursor);

    const start = Math.max(0, oldestLoadedIndex - PAGE);
    const pageItems = history.slice(start, oldestLoadedIndex);
    const hasMoreBefore = start > 0;
    oldestLoadedIndex = start;

    await postHost(page, {
      type: 'transcriptPageResult',
      requestId: request.requestId,
      taskId,
      ok: true,
      items: pageItems,
      transcriptPage: {
        hasMoreBefore,
        workspaceRevision: 1 + pageNum,
        ...(hasMoreBefore ? { beforeCursor: cursorForIndex(start) } : {}),
      },
    });

    // Wait for request to clear / items to grow.
    await expect
      .poll(async () => mountedTranscriptCount(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(MAX_MOUNTED);

    const settledPageIds = settledIds(pageItems);
    accumulated.unshift(...settledPageIds);
    expectedCursor = hasMoreBefore ? cursorForIndex(start) : '';

    // Anchor continuity within 2px (scroller-relative) when the stable row remains mounted.
    if (anchorBefore?.id) {
      await expect
        .poll(
          async () => {
            const y = await page.evaluate((id) => {
              const scroll = document.querySelector<HTMLElement>(
                '[data-testid="chat-thread-scroll"]',
              );
              const row = document.querySelector<HTMLElement>(
                `[data-transcript-id="${CSS.escape(id)}"]`,
              );
              if (!scroll || !row) return null;
              return row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
            }, anchorBefore.id);
            if (y === null) return Number.POSITIVE_INFINITY;
            return Math.abs(y - anchorBefore.y);
          },
          { timeout: 8_000 },
        )
        .toBeLessThanOrEqual(2);
    }

    // Production-state probe: every currently mounted virtual index must map to the
    // expected full-list settled id (rejects drop/reorder/cap of resident items).
    const mounted = await page.locator('[data-transcript-id]').evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-transcript-id') ?? '',
        index: Number(el.getAttribute('data-index') ?? -1),
      })),
    );
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(MAX_MOUNTED);
    for (const row of mounted) {
      expect(row.index).toBeGreaterThanOrEqual(0);
      expect(row.index).toBeLessThan(accumulated.length);
      expect(row.id).toBe(accumulated[row.index]);
    }

    // Only one in-flight at a time already asserted; ensure no duplicate settled ids.
    expect(new Set(accumulated).size).toBe(accumulated.length);
  }

  expect(accumulated.length).toBe(fullSettled.length);
  expect(accumulated).toEqual(fullSettled);

  // Traverse first / middle / last via production virtualizer helpers and assert
  // the mounted id at those indexes matches the full settled list.
  const probes = [
    { to: 'start' as const, id: fullSettled[0]!, index: 0 },
    {
      to: Math.floor(fullSettled.length / 2),
      id: fullSettled[Math.floor(fullSettled.length / 2)]!,
      index: Math.floor(fullSettled.length / 2),
    },
    { to: 'end' as const, id: fullSettled[fullSettled.length - 1]!, index: fullSettled.length - 1 },
  ];
  for (const probe of probes) {
    await page.evaluate((to) => {
      window.dispatchEvent(new CustomEvent('muster-chat-scroll', { detail: { to } }));
    }, probe.to);
    await page.waitForTimeout(100);
    // Retry once after measurements settle.
    await page.evaluate((to) => {
      window.dispatchEvent(new CustomEvent('muster-chat-scroll', { detail: { to } }));
    }, probe.to);
    await expect
      .poll(async () => {
        return page.locator(`[data-transcript-id="${probe.id}"]`).count();
      }, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const hit = page.locator(`[data-transcript-id="${probe.id}"]`);
    await expect(hit).toBeVisible();
    // Index attribute must match the full-list position (ownership preserved).
    await expect(hit).toHaveAttribute('data-index', String(probe.index));
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);
  }

  return accumulated;
}

test.describe('Phase 6 chat virtualization', () => {
  test('bounds DOM while loading 2000 items through owned pages', async ({ page }) => {
    test.setTimeout(120_000);
    await openWebview(page);
    const history = buildHistory(TOTAL);
    const taskId = 'task-virt';
    const bootstrap = history.slice(history.length - BOOTSTRAP);
    const bootstrapCursor = cursorForIndex(history.length - BOOTSTRAP);

    await postFocusedSnapshot(page, {
      taskId,
      transcript: bootstrap,
      storeRevision: 1,
      hasMoreBefore: true,
      beforeCursor: bootstrapCursor,
    });

    // Latest content visible; mounted rows bounded.
    const latestSettled = settledIds(bootstrap).at(-1)!;
    await expect(page.locator(`[data-transcript-id="${latestSettled}"]`)).toBeVisible({
      timeout: 10_000,
    });
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);

    await loadAllOlderPages(page, history, taskId);

    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);

    // After the full protocol-conformant load:
    // - every page stayed within the DOM ceiling (asserted per page above)
    // - accumulated settled ids match the full history exactly (asserted in loader)
    // - hasMoreBefore is cleared so the load chrome can disappear
    await expect
      .poll(async () => page.getByRole('button', { name: 'Load earlier messages' }).count(), {
        timeout: 5_000,
      })
      .toBe(0);
    // Virtualization still bounds the final resident window.
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);
    // Distinct windows: scroll via the production helper and require the mounted
    // index range to move while remaining bounded.
    const mountedIndexes = async () =>
      page.locator('[data-index]').evaluateAll((els) =>
        els
          .map((el) => Number(el.getAttribute('data-index')))
          .filter((n) => Number.isFinite(n) && n >= 0),
      );

    const before = await mountedIndexes();
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('muster-chat-scroll', { detail: { to: 'end' } }));
    });
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('muster-chat-scroll', { detail: { to: 'end' } }));
    });
    await page.waitForTimeout(120);
    const afterEnd = await mountedIndexes();
    expect(afterEnd.length).toBeGreaterThan(0);
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);
    // End navigation must move the window or already be at the tail.
    const beforeMax = before.length ? Math.max(...before) : -1;
    const afterMax = Math.max(...afterEnd);
    expect(afterMax).toBeGreaterThanOrEqual(beforeMax);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('muster-chat-scroll', { detail: { to: 'start' } }));
    });
    await page.waitForTimeout(120);
    const afterStart = await mountedIndexes();
    expect(afterStart.length).toBeGreaterThan(0);
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);
    // Keep fixture cardinalities referenced.
    expect(settledIds(history).length).toBeGreaterThan(1000);
  });

  test('cancels stale older-page restore after focus replacement', async ({ page }) => {
    await openWebview(page);
    const history = buildHistory(300);
    const taskA = 'task-a';
    const taskB = 'task-b';
    const bootstrap = history.slice(history.length - BOOTSTRAP);

    await postFocusedSnapshot(page, {
      taskId: taskA,
      transcript: bootstrap,
      storeRevision: 1,
      hasMoreBefore: true,
      beforeCursor: cursorForIndex(history.length - BOOTSTRAP),
    });
    await expect(page.locator('[data-transcript-id]').first()).toBeVisible();

    await clearPosted(page);
    const loadBtn = page.getByRole('button', { name: 'Load earlier messages' });
    await loadBtn.click();
    const request = await expect
      .poll(async () => {
        const msgs = await postedMessages(page);
        return msgs.find(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'loadTranscriptPage',
        ) as { requestId: string; taskId: string } | undefined;
      })
      .toBeTruthy()
      .then(async () => {
        const msgs = await postedMessages(page);
        return msgs.find(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'loadTranscriptPage',
        ) as { requestId: string; taskId: string };
      });

    // Replace focus before the page returns.
    await postFocusedSnapshot(page, {
      taskId: taskB,
      transcript: [
        {
          id: 'only-b',
          kind: 'assistant',
          content: 'Focused on B',
          turnId: 'tb',
          order: 1,
          state: 'complete',
        },
      ],
      storeRevision: 2,
      hasMoreBefore: false,
    });
    await expect(page.getByText('Focused on B')).toBeVisible();

    // Stale result for task A must not clobber task B.
    await postHost(page, {
      type: 'transcriptPageResult',
      requestId: request.requestId,
      taskId: taskA,
      ok: true,
      items: history.slice(0, 50),
      transcriptPage: { hasMoreBefore: false, workspaceRevision: 9 },
    });

    await expect(page.getByText('Focused on B')).toBeVisible();
    await expect(page.locator('[data-transcript-id="only-b"]')).toBeVisible();
    // Stale prepend ids must not appear.
    await expect(page.locator(`[data-transcript-id="${settledIds(history)[0]}"]`)).toHaveCount(0);
  });

  test('pinned streaming updates tail without mounting full history', async ({ page }) => {
    await openWebview(page);
    const history = buildHistory(150);
    const bootstrap = history.slice(history.length - BOOTSTRAP);
    const taskId = 'task-stream';

    await postFocusedSnapshot(page, {
      taskId,
      transcript: bootstrap,
      storeRevision: 1,
      hasMoreBefore: false,
      activeTurnId: 'turn-live',
    });

    await postHost(page, {
      type: 'turnStart',
      taskId,
      turnId: 'turn-live',
    });
    await postHost(page, {
      type: 'event',
      taskId,
      turnId: 'turn-live',
      event: { type: 'assistantDelta', messageId: 'stream-1', content: 'Hello' },
    });
    await expect(page.getByText('Hello')).toBeVisible();
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);

    await postHost(page, {
      type: 'event',
      taskId,
      turnId: 'turn-live',
      event: { type: 'assistantDelta', messageId: 'stream-1', content: ' world' },
    });
    await expect(page.getByText('Hello world')).toBeVisible();
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);
  });

  test('unpinned streaming keeps scroll; offscreen tool patch applies on visit', async ({
    page,
  }) => {
    await openWebview(page);
    const history = buildHistory(200);
    const bootstrap = history.slice(history.length - BOOTSTRAP);
    const taskId = 'task-stream-unpin';
    const settled = settledIds(bootstrap);
    // Pick a tool near the start of the bootstrap window (will be offscreen after pin-to-end).
    const offscreenTool = bootstrap.find((item) => item.kind === 'tool')!;
    expect(offscreenTool).toBeTruthy();

    await postFocusedSnapshot(page, {
      taskId,
      transcript: bootstrap,
      storeRevision: 1,
      hasMoreBefore: false,
      activeTurnId: 'turn-live',
    });
    await expect(page.locator(`[data-transcript-id="${settled.at(-1)}"]`)).toBeVisible();

    // Unpin by scrolling toward older content.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('muster-chat-scroll', { detail: { to: 0 } }));
    });
    await page.waitForTimeout(80);
    const scrollBefore = await page
      .locator('[data-testid="chat-thread-scroll"]')
      .evaluate((el) => el.scrollTop);

    await postHost(page, {
      type: 'turnStart',
      taskId,
      turnId: 'turn-live',
    });
    await postHost(page, {
      type: 'event',
      taskId,
      turnId: 'turn-live',
      event: { type: 'assistantDelta', messageId: 'stream-u', content: 'unpinned-delta' },
    });
    // Streaming bubble may be offscreen while unpinned; scroll position must not yank.
    await page.waitForTimeout(80);
    const scrollAfter = await page
      .locator('[data-testid="chat-thread-scroll"]')
      .evaluate((el) => el.scrollTop);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(4);
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);

    // Patch an offscreen tool via workspacePatchBatch, then navigate to it.
    await postHost(page, {
      type: 'workspacePatchBatch',
      revision: 2,
      patches: [
        {
          type: 'transcriptItemPatched',
          taskId,
          item: {
            id: offscreenTool.id,
            kind: 'tool',
            turnId: offscreenTool.turnId,
            order: offscreenTool.order ?? 2,
            content: {
              toolCallId: offscreenTool.id,
              name: 'bash',
              toolKind: 'builtin',
              status: 'success',
              input: { cmd: 'patched' },
              output: 'PATCHED-OUTPUT-VISIBLE',
            },
          },
        },
      ],
    });

    const toolIndex = settled.indexOf(offscreenTool.id);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    await page.evaluate((index) => {
      window.dispatchEvent(new CustomEvent('muster-chat-scroll', { detail: { to: index } }));
    }, toolIndex);
    const toolRow = page.locator(`[data-transcript-id="${offscreenTool.id}"]`);
    await expect(toolRow).toBeVisible({ timeout: 8_000 });
    // ToolCard collapses output by default — expand via the header button.
    await toolRow.getByRole('button').first().click({ force: true });
    await expect(toolRow.getByText('PATCHED-OUTPUT-VISIBLE')).toBeVisible({ timeout: 5_000 });
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);
  });

  test('block-start header and reasoning render at virtual boundaries', async ({ page }) => {
    await openWebview(page);
    // Construct a compact fixture with explicit block starts + reasoning.
    const items: TranscriptItem[] = [];
    for (let i = 0; i < 80; i += 1) {
      const turnId = `bt-${i}`;
      items.push({
        id: `bu-${i}`,
        kind: 'user',
        content: `User ${i}`,
        turnId,
        order: 0,
      });
      items.push({
        id: `br-${i}`,
        kind: 'reasoning',
        turnId,
        content: `Boundary reasoning ${i}`,
      });
      items.push({
        id: `ba-${i}`,
        kind: 'assistant',
        content: i % 5 === 0 ? `# Tall boundary ${i}\n\n${'line\n'.repeat(30)}` : `Assistant ${i}`,
        turnId,
        order: 1,
        state: 'complete',
      });
    }
    const taskId = 'task-boundary';
    await postFocusedSnapshot(page, {
      taskId,
      transcript: items,
      storeRevision: 1,
      hasMoreBefore: false,
    });

    // Navigate to a mid assistant that should open a block header after a user row.
    const targetIndex = 40; // settled index of ba-20 roughly; compute from settled list
    const settled = settledIds(items);
    const assistantId = 'ba-20';
    const idx = settled.indexOf(assistantId);
    expect(idx).toBeGreaterThan(0);
    await page.evaluate((index) => {
      window.dispatchEvent(new CustomEvent('muster-chat-scroll', { detail: { to: index } }));
    }, idx);
    const row = page.locator(`[data-transcript-id="${assistantId}"]`);
    await expect(row).toBeVisible({ timeout: 8_000 });
    // Reasoning lives in a collapsed <details>; open it then assert content.
    const thinking = row.locator('details').filter({ hasText: 'Thinking' }).first();
    await expect(thinking).toBeAttached();
    await thinking.evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });
    await expect(row.getByText('Boundary reasoning 20')).toBeVisible();
    // Backend chip label from block header.
    await expect(row.getByText('Claude').first()).toBeVisible();
    // Variable-height: after opening details, wait for remeasure then assert no overlap.
    await page.waitForTimeout(100);
    await expect
      .poll(async () => {
        return page.evaluate((id) => {
          const scroll = document.querySelector<HTMLElement>('[data-testid="chat-thread-scroll"]');
          if (!scroll) return false;
          const rows = Array.from(scroll.querySelectorAll<HTMLElement>('[data-transcript-id]'));
          const idx = rows.findIndex((r) => r.dataset.transcriptId === id);
          if (idx < 0 || idx + 1 >= rows.length) return true;
          const a = rows[idx]!.getBoundingClientRect();
          const b = rows[idx + 1]!.getBoundingClientRect();
          return a.bottom <= b.top + 1;
        }, assistantId);
      }, { timeout: 3_000 })
      .toBe(true);
    expect(await mountedTranscriptCount(page)).toBeLessThanOrEqual(MAX_MOUNTED);
    void targetIndex;
  });
});

test.describe('Phase 6 expanded task-tree virtualization', () => {
  const TREE_N = 5000;
  const MAX_TREE_MOUNTED = 100;

  function makeWideSubtree(count: number) {
    const root = {
      id: 'tree-root',
      parentId: null as string | null,
      goal: 'Root coordinator',
      role: 'coordinator',
      lifecycle: 'open',
      runtimeActivity: 'idle',
      viewStatus: 'idle',
      currentTurnActivity: null,
      updatedAt: '2026-07-18T00:00:00.000Z',
      backend: 'claude',
    };
    const children = Array.from({ length: count - 1 }, (_, i) => ({
      ...root,
      id: `tree-c-${i}`,
      parentId: 'tree-root',
      goal: `Wide child ${i}`,
      role: 'worker',
    }));
    return [root, ...children];
  }

  test('bounds mounted rows for a 5000-node expanded tree and preserves interactions', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openWebview(page);
    const subtree = makeWideSubtree(TREE_N);
    const root = subtree[0]!;
    const middle = subtree[Math.floor(TREE_N / 2)]!;
    const last = subtree[TREE_N - 1]!;

    // Build the large subtree inside the page to avoid huge Node↔browser clone cost.
    await page.evaluate(
      ({ protocolVersion, n }) => {
        const subtree: Array<Record<string, unknown>> = [
          {
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
          },
        ];
        for (let i = 0; i < n - 1; i += 1) {
          subtree.push({
            id: `tree-c-${i}`,
            parentId: 'tree-root',
            goal: `Wide child ${i}`,
            role: 'worker',
            lifecycle: 'open',
            runtimeActivity: 'idle',
            viewStatus: 'idle',
            currentTurnActivity: null,
            updatedAt: '2026-07-18T00:00:00.000Z',
            backend: 'claude',
          });
        }
        const root = subtree[0]!;
        window.postMessage(
          {
            type: 'snapshot',
            protocolVersion,
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
            transcriptPage: { hasMoreBefore: false, workspaceRevision: 1 },
            storeRevision: 1,
          },
          '*',
        );
      },
      { protocolVersion: PROTOCOL_VERSION, n: TREE_N },
    );
    void subtree;
    void root;

    await expect(page.getByTestId('task-tree-summary')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('task-tree-summary').click();
    await expect(page.locator('[data-testid="task-chrome"]')).toHaveAttribute(
      'data-tree-expanded',
      'true',
    );

    await expect
      .poll(async () => page.locator('[data-testid="task-tree-row"]').count(), {
        timeout: 15_000,
      })
      .toBeLessThanOrEqual(MAX_TREE_MOUNTED);
    const initialMounted = await page.locator('[data-testid="task-tree-row"]').count();
    expect(initialMounted).toBeGreaterThan(0);
    expect(initialMounted).toBeLessThanOrEqual(MAX_TREE_MOUNTED);
    await expect(page.locator('[data-testid="task-tree-row"][data-task-id="tree-root"]')).toBeVisible();

    const treeList = page.getByTestId('task-chrome-tree');
    // Exact middle DFS identity: sweep until the known middle id mounts.
    expect(await page.locator('[data-testid="task-tree-row"]').count()).toBeLessThanOrEqual(
      MAX_TREE_MOUNTED,
    );
    let foundMiddle = false;
    for (const frac of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65]) {
      await treeList.evaluate((el, f) => {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.floor(max * f);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, frac);
      await page.waitForTimeout(40);
      if (
        (await page.locator(`[data-testid="task-tree-row"][data-task-id="${middle.id}"]`).count()) >
        0
      ) {
        foundMiddle = true;
        break;
      }
    }
    expect(foundMiddle).toBe(true);
    const middleRow = page.locator(`[data-testid="task-tree-row"][data-task-id="${middle.id}"]`);
    await expect(middleRow).toHaveAttribute('data-tree-depth', '1');
    // Indentation for depth 1: inline style padding-left: 18px (6 + 12*depth).
    const midPad = await middleRow.evaluate((el) => {
      const row = el.closest('.task-tree-panel__row') as HTMLElement | null;
      return row?.style.paddingLeft ?? '';
    });
    expect(midPad).toBe('18px');

    // Last row reachable.
    await treeList.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(100);
    await expect
      .poll(
        async () => page.locator(`[data-testid="task-tree-row"][data-task-id="${last.id}"]`).count(),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    expect(await page.locator('[data-testid="task-tree-row"]').count()).toBeLessThanOrEqual(
      MAX_TREE_MOUNTED,
    );

    // Select far row → focusTask + focused visibility.
    await clearPosted(page);
    await page.locator(`[data-testid="task-tree-row"][data-task-id="${last.id}"]`).click();
    await expect
      .poll(async () => {
        const msgs = await postedMessages(page);
        return msgs.some(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'focusTask' &&
            (m as { taskId?: string }).taskId === last.id,
        );
      }, { timeout: 5_000 })
      .toBe(true);

    // Lifecycle menu + recycle close: open menu then scroll its row out of range.
    await treeList.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(80);
    await clearPosted(page);
    const rootStatus = page
      .locator('[data-testid="task-tree-row"][data-task-id="tree-root"]')
      .locator('xpath=..')
      .locator('.task-tree-panel__status-btn');
    await rootStatus.click({ force: true });
    await expect(page.getByRole('menuitem').filter({ hasText: 'Mark done' }).first()).toBeVisible({
      timeout: 3_000,
    });
    // Scroll away so the open menu's row leaves the virtual window → menu must close.
    await treeList.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(120);
    await expect(page.getByRole('menuitem')).toHaveCount(0);

    // Re-open menu at top and complete a lifecycle action.
    await treeList.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(80);
    await rootStatus.click({ force: true });
    await page.evaluate(() => {
      const item = document.querySelector<HTMLElement>('[role="menuitem"]');
      item?.click();
    });
    await expect
      .poll(async () => {
        const msgs = await postedMessages(page);
        return msgs.some(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'setTaskLifecycle' &&
            (m as { taskId?: string }).taskId === 'tree-root' &&
            (m as { lifecycle?: string }).lifecycle === 'succeeded',
        );
      }, { timeout: 5_000 })
      .toBe(true);

    // Collapse root branch via chrome toggle (row 0) then re-expand.
    await page.getByTestId('task-tree-summary').click();
    await expect(page.locator('[data-testid="task-chrome"]')).toHaveAttribute(
      'data-tree-expanded',
      'false',
    );
    await page.getByTestId('task-tree-summary').click();
    await expect(page.locator('[data-testid="task-chrome"]')).toHaveAttribute(
      'data-tree-expanded',
      'true',
    );
    expect(await page.locator('[data-testid="task-tree-row"]').count()).toBeLessThanOrEqual(
      MAX_TREE_MOUNTED,
    );

    // Patch removal: ensure middle is mounted again, remove it, then sweep.
    let middleMounted = false;
    for (const frac of [0.4, 0.45, 0.5, 0.55, 0.6]) {
      await treeList.evaluate((el, f) => {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.floor(max * f);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, frac);
      await page.waitForTimeout(40);
      if (
        (await page.locator(`[data-testid="task-tree-row"][data-task-id="${middle.id}"]`).count()) >
        0
      ) {
        middleMounted = true;
        break;
      }
    }
    expect(middleMounted).toBe(true);
    const removeId = middle.id;
    await postHost(page, {
      type: 'workspacePatchBatch',
      revision: 2,
      patches: [{ type: 'taskRemoved', taskId: removeId }],
    });
    // Immediately after patch, middle must leave the mounted set.
    await expect
      .poll(
        async () => page.locator(`[data-testid="task-tree-row"][data-task-id="${removeId}"]`).count(),
        { timeout: 5_000 },
      )
      .toBe(0);
    // Full-range sweep: removed id never remounts; root remains reachable at top;
    // last remains reachable at bottom; no duplicate keys; bound holds.
    let sawRemoved = false;
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      await treeList.evaluate((el, f) => {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.floor(max * f);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, frac);
      await page.waitForTimeout(40);
      if (
        (await page.locator(`[data-testid="task-tree-row"][data-task-id="${removeId}"]`).count()) > 0
      ) {
        sawRemoved = true;
      }
      const ids = await page.locator('[data-testid="task-tree-row"]').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-task-id') ?? ''),
      );
      expect(new Set(ids).size).toBe(ids.length);
      expect(await page.locator('[data-testid="task-tree-row"]').count()).toBeLessThanOrEqual(
        MAX_TREE_MOUNTED,
      );
    }
    expect(sawRemoved).toBe(false);
    await treeList.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(page.locator('[data-testid="task-tree-row"][data-task-id="tree-root"]')).toBeVisible();
    await treeList.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect
      .poll(
        async () => page.locator(`[data-testid="task-tree-row"][data-task-id="${last.id}"]`).count(),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    // Patch insertion: upsert a new child and assert it appears exactly once when scrolled into range.
    const insertedId = 'tree-c-inserted';
    await postHost(page, {
      type: 'workspacePatchBatch',
      revision: 3,
      patches: [
        {
          type: 'taskUpserted',
          task: {
            id: insertedId,
            parentId: 'tree-root',
            goal: 'Inserted child',
            role: 'worker',
            lifecycle: 'open',
            runtimeActivity: 'idle',
            viewStatus: 'idle',
            currentTurnActivity: null,
            updatedAt: '2026-07-18T00:00:01.000Z',
            backend: 'claude',
          },
        },
      ],
    });
    // Scroll through the list until the inserted row mounts (or top/bottom sweeps).
    let foundInserted = false;
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      await treeList.evaluate((el, f) => {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.floor(max * f);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, frac);
      await page.waitForTimeout(40);
      if (
        (await page.locator(`[data-testid="task-tree-row"][data-task-id="${insertedId}"]`).count()) >
        0
      ) {
        foundInserted = true;
        break;
      }
    }
    expect(foundInserted).toBe(true);
    const insertedCount = await page
      .locator(`[data-testid="task-tree-row"][data-task-id="${insertedId}"]`)
      .count();
    expect(insertedCount).toBe(1);
    expect(await page.locator('[data-testid="task-tree-row"]').count()).toBeLessThanOrEqual(
      MAX_TREE_MOUNTED,
    );
  });
});
