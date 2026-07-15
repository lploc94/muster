import { expect, test, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isFileMentionDirectorySymlink,
  listFileMentionSuggestions,
} from '../src/host/file-mention-suggestions';

type TaskRuntimeActivity =
  | 'waiting_dependencies'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_children'
  | 'blocked'
  | 'needs_recovery'
  | 'idle'
  | 'awaiting_outcome';

type TaskViewStatus =
  | TaskRuntimeActivity
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'open';

type TurnActivity =
  | { state: 'queued'; turnId: string; position?: number; waitReason?: string }
  | { state: 'executing'; turnId: string; phase?: string }
  | { state: 'waiting_you'; turnId: string; requestId?: string }
  | { state: 'failed_turn'; turnId: string; retryable: boolean }
  | { state: 'uncertain'; turnId: string; requiresConfirmation: true }
  | null;

type TaskHandoffPhase =
  | 'requested'
  | 'exporting_context'
  | 'summarizing_source'
  | 'preparing_receiver'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface HandoffProgressBinding {
  backend: string;
  model?: string;
}

interface HandoffProgress {
  operationId: string;
  phase: TaskHandoffPhase;
  source: HandoffProgressBinding;
  target: HandoffProgressBinding;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  failure?: { code: string; message: string; at: string };
}

interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: string;
  lifecycle: string;
  runtimeActivity?: TaskRuntimeActivity | null;
  viewStatus: TaskViewStatus;
  currentTurnActivity: TurnActivity;
  updatedAt: string;
  backend: string;
  /** Optional model id selected for this task. */
  model?: string;
  /** Sanitized task-scoped handoff chrome (never digests/session ids/bodies). */
  handoffProgress?: HandoffProgress;
}

interface QueuedTurnProjection {
  turnId: string;
  sequence: number;
  status: 'queued';
  messageIds: string[];
  createdAt: string;
  previewText?: string;
}

interface SnapshotMessage {
  type: 'snapshot';
  /** Stamped automatically by postSnapshot() below; omit when constructing test fixtures. */
  protocolVersion?: number;
  rootTasks: TaskSummary[];
  focusedTaskId?: string;
  subtree?: TaskSummary[];
  transcript?: Array<{ id: string; kind: 'user' | 'assistant' | 'tool' | 'error' | 'reasoning'; content: unknown }>;
  activeTurnId?: string;
  /** Authoritative multi-queue projection for FIFO follow-ups (edit/delete + panel). */
  queuedTurns?: QueuedTurnProjection[];
  pendingAsk?: {
    turnId: string;
    askId: string;
    questions: Array<{ prompt: string; options?: string[]; allowFreeText?: boolean }>;
  };
  storeRevision: number;
}

interface CommandErrorMessage {
  type: 'commandError';
  taskId?: string;
  message: string;
}

async function openWebview(page: Page) {
  await page.addInitScript(() => {
    const state = { value: undefined as unknown };
    window.acquireVsCodeApi = () => ({
      postMessage(message: unknown) {
        // Match VS Code's webview boundary: messages must survive structured
        // clone. This catches accidental Svelte `$state` Proxy payloads.
        const cloned = structuredClone(message);
        window.__musterPostedMessages = [...(window.__musterPostedMessages ?? []), cloned];
        window.dispatchEvent(new CustomEvent('muster:test:postMessage', { detail: cloned }));
      },
      getState() {
        return state.value;
      },
      setState(nextState: unknown) {
        state.value = nextState;
      },
    });
  });

  await page.goto('/');
  await expect(page.getByText('New task')).toBeVisible();
}

// Wire protocol version the webview currently stamps/expects; kept in sync with
// PROTOCOL_VERSION in webview/src/lib/protocol.ts. Test fixtures below always
// send it so the version-mismatch banner doesn't mask the harness's own
// snapshot messages.
const PROTOCOL_VERSION = 4;

async function postSnapshot(page: Page, snapshot: SnapshotMessage) {
  await page.evaluate((message) => {
    window.postMessage(message, '*');
  }, { protocolVersion: PROTOCOL_VERSION, ...snapshot });
}

async function postCommandError(page: Page, message: CommandErrorMessage) {
  await page.evaluate((hostMessage) => {
    window.postMessage(hostMessage, '*');
  }, message);
}

async function postRawHostMessage(page: Page, message: unknown) {
  await page.evaluate((hostMessage) => {
    window.postMessage(hostMessage, '*');
  }, message);
}

async function postedMessages(page: Page) {
  return page.evaluate(() => window.__musterPostedMessages ?? []);
}

async function expectPostedMessage(page: Page, expected: unknown) {
  // Partial match: Phase C send messages include ephemeral clientRequestId.
  await expect
    .poll(async () => postedMessages(page))
    .toEqual(
      expect.arrayContaining([
        typeof expected === 'object' && expected !== null
          ? expect.objectContaining(expected as Record<string, unknown>)
          : expected,
      ]),
    );
}

async function dispatchFileDrag(page: Page, type: 'dragover' | 'drop', mime: string, value: string) {
  await page.locator('.composer-shell').evaluate((element, args) => {
    const transfer = new DataTransfer();
    transfer.setData(args.mime, args.value);
    element.dispatchEvent(new DragEvent(args.type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { type, mime, value });
}

async function dispatchFileDragMulti(
  page: Page,
  type: 'dragover' | 'drop',
  entries: Array<{ mime: string; value: string }>,
) {
  await page.locator('.composer-shell').evaluate((element, args) => {
    const transfer = new DataTransfer();
    for (const entry of args.entries) transfer.setData(entry.mime, entry.value);
    element.dispatchEvent(new DragEvent(args.type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { type, entries });
}

async function expectButtonDisabledAttribute(page: Page, name: string) {
  await expect
    .poll(() => page.getByRole('button', { name }).evaluate((button) => button.hasAttribute('disabled')))
    .toBe(true);
}

/** Seed host model catalog so the task model switch has backend::model options. */
async function postModelsAvailable(
  page: Page,
  models: Record<
    string,
    { current?: string; options: Array<{ value: string; name: string }> }
  >,
) {
  await postRawHostMessage(page, { type: 'modelsAvailable', models });
}

/**
 * Drive vscode-single-select like a user pick: set value + dispatch change.
 * vscode-elements fires `new Event('change')` (isTrusted=false) for real clicks too.
 */
async function selectTaskModelSwitch(page: Page, value: string) {
  const picker = page.getByTestId('task-model-switch');
  await expect(picker).toBeVisible();
  await picker.evaluate((element, nextValue) => {
    const select = element as HTMLElement & { value: string };
    select.value = nextValue;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

function handoffProgressFixture(
  overrides: Partial<HandoffProgress> & Pick<HandoffProgress, 'phase'>,
): HandoffProgress {
  return {
    operationId: 'hop-e2e-1',
    source: { backend: 'claude', model: 'sonnet' },
    target: { backend: 'grok', model: 'grok-4' },
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:01.000Z',
    ...overrides,
  };
}

function turnActivityFromView(viewStatus: TaskViewStatus, lifecycle: string): TurnActivity {
  if (lifecycle !== 'open') return null;
  switch (viewStatus) {
    case 'running':
      return { state: 'executing', turnId: 'turn-fixture' };
    case 'waiting_user':
      return { state: 'waiting_you', turnId: 'turn-fixture' };
    case 'queued':
      return { state: 'queued', turnId: 'turn-fixture', position: 1 };
    case 'needs_recovery':
      return { state: 'failed_turn', turnId: 'turn-fixture', retryable: true };
    default:
      return null;
  }
}

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  const lifecycle = overrides.lifecycle ?? 'open';
  const viewStatus = overrides.viewStatus ?? (lifecycle === 'open' ? 'idle' : (lifecycle as TaskViewStatus));
  const runtimeActivity =
    overrides.runtimeActivity !== undefined
      ? overrides.runtimeActivity
      : lifecycle === 'open'
        ? ((viewStatus === 'succeeded' ||
            viewStatus === 'failed' ||
            viewStatus === 'cancelled' ||
            viewStatus === 'skipped' ||
            viewStatus === 'open'
            ? 'idle'
            : viewStatus) as TaskRuntimeActivity)
        : null;
  const currentTurnActivity =
    overrides.currentTurnActivity !== undefined
      ? overrides.currentTurnActivity
      : turnActivityFromView(viewStatus, lifecycle);
  return {
    id: 'task-root',
    parentId: null,
    goal: 'Wire browser regression harness',
    role: 'coordinator',
    updatedAt: '2026-01-01T00:00:00.000Z',
    backend: 'claude',
    ...overrides,
    lifecycle,
    runtimeActivity,
    viewStatus,
    currentTurnActivity,
  };
}

test.describe('Muster webview host state smoke', () => {
  test('renders task shell from a mocked VS Code snapshot', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task()],
      focusedTaskId: 'task-root',
      subtree: [task()],
      transcript: [{ id: 'msg-1', kind: 'assistant', content: 'Harness ready.' }],
      storeRevision: 1,
    });

    // Collapsed header card: title + status button (details hidden until expand).
    await expect(page.locator('.task-workspace-banner').getByText('Wire browser regression harness')).toBeVisible();
    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Open/i })).toBeVisible();
    await expect(page.locator('.task-workspace-banner').getByText('Task is open')).toHaveCount(0);
    await page.locator('.task-workspace-banner').getByRole('button', { name: /Expand task details/i }).click();
    await expect(page.locator('.task-workspace-banner').getByText('Task is open')).toBeVisible();
    // Between turns / idle open: no turn-activity strip (ready).
    await expect(page.locator('[data-turn-activity]')).toHaveCount(0);
    await expect(page.getByText('Harness ready.')).toBeVisible();
  });

  test('keeps the shell usable when a snapshot contains no tasks', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 2,
    });

    await expect(page.getByText('No previous tasks.')).toBeVisible();
    await page.getByRole('button', { name: 'New task' }).first().click();
    await expectPostedMessage(page, { type: 'newTask' });
    await expect(page.getByText('New task').first()).toBeVisible();
    await expect(page.getByText('First message creates the coordinator task.')).toBeVisible();
    await page.getByPlaceholder('Start a new coordinator task with claude…').fill('Start a browser-visible task.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expectPostedMessage(page, {
      type: 'send',
      text: 'Start a browser-visible task.',
      backend: 'claude',
    });
  });

  
test('file mention autocomplete requests host suggestions and inserts a relative file on click', async ({ page }) => {
  await openWebview(page);
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 2 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await composer.click();
  // Real typing — not fill/value injection — so caret-driven autocomplete runs.
  await composer.pressSequentially('Review @re', { delay: 20 });

  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages.filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const request = (await postedMessages(page)).find(
    (m) => (m as { type?: string }).type === 'requestFileMentionSuggestions',
  ) as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
    taskId?: string;
  };
  expect(request.parentDepth).toBe(0);
  expect(request.relativeQuery).toBe('re');
  expect(request.taskId).toBeUndefined();
  expect(typeof request.requestId).toBe('string');
  expect(request.requestId.length).toBeGreaterThan(0);

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: request.requestId,
    parentDepth: 0,
    relativeQuery: 're',
    items: [
      {
        id: 'file:readme.md',
        kind: 'file',
        label: 'readme.md',
        insertionPath: 'readme.md',
      },
      {
        id: 'dir:src',
        kind: 'directory',
        label: 'src',
        insertionPath: 'src',
      },
    ],
  });

  const listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(listbox).toBeVisible();
  // S02 shows files and directories so mouse navigation can drill down.
  await expect(listbox.getByRole('option', { name: 'readme.md' })).toBeVisible();
  await expect(listbox.getByRole('option', { name: 'src/' })).toBeVisible();

  await listbox.getByRole('option', { name: 'readme.md' }).click();
  await expect(listbox).toHaveCount(0);
  // Active @re token replaced; leading "Review " preserved.
  await expect(composer).toHaveValue('Review @readme.md ');

  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Review @readme.md',
    backend: 'claude',
  });
});

/**
 * T03: parent/grandparent depth tokens, directory drill-down, depth-3 rejection,
 * and stale-response non-paint — real typing + mouse activation.
 */
test('file mention autocomplete navigates parent depth and directory drill-down', async ({
  page,
}) => {
  await openWebview(page);
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 30 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await composer.click();

  // ── Depth 1: @../ ───────────────────────────────────────────────────────
  await composer.pressSequentially('Parent @../', { delay: 20 });

  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages.filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth1Request = (await postedMessages(page)).find(
    (m) => (m as { type?: string }).type === 'requestFileMentionSuggestions',
  ) as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(depth1Request.parentDepth).toBe(1);
  expect(depth1Request.relativeQuery).toBe('');
  expect(typeof depth1Request.requestId).toBe('string');

  // Inject a deliberately stale prior-query response first — must not paint.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: 'stale-prior-query',
    parentDepth: 0,
    relativeQuery: 'old',
    items: [
      {
        id: 'file:stale.md',
        kind: 'file',
        label: 'stale.md',
        insertionPath: 'stale.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  // Matching depth-1 response with directory + file.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth1Request.requestId,
    parentDepth: 1,
    relativeQuery: '',
    items: [
      {
        id: 'file:../root.md',
        kind: 'file',
        label: 'root.md',
        insertionPath: '../root.md',
      },
      {
        id: 'dir:../packages',
        kind: 'directory',
        label: 'packages',
        insertionPath: '../packages',
      },
    ],
  });

  const listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option', { name: 'root.md' })).toBeVisible();
  await expect(listbox.getByRole('option', { name: 'packages/' })).toBeVisible();
  // Stale label must never appear.
  await expect(listbox.getByRole('option', { name: 'stale.md' })).toHaveCount(0);

  // Directory selection refines token and requests children under that scope.
  const beforeDrill = (await postedMessages(page)).length;
  await listbox.getByRole('option', { name: 'packages/' }).click();
  await expect(composer).toHaveValue('Parent @../packages/');

  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(beforeDrill)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const drillRequest = (await postedMessages(page))
    .slice(beforeDrill)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(drillRequest.parentDepth).toBe(1);
  expect(drillRequest.relativeQuery).toBe('packages/');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: drillRequest.requestId,
    parentDepth: 1,
    relativeQuery: 'packages/',
    items: [
      {
        id: 'file:../packages/pkg.json',
        kind: 'file',
        label: 'pkg.json',
        insertionPath: '../packages/pkg.json',
      },
    ],
  });

  const childListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(childListbox).toBeVisible();
  await childListbox.getByRole('option', { name: 'pkg.json' }).click();
  await expect(childListbox).toHaveCount(0);
  await expect(composer).toHaveValue('Parent @pkg.json ');

  // ── Depth 2: clear and type @../../ ─────────────────────────────────────
  await composer.fill('');
  await composer.click();
  await composer.pressSequentially('Grand @../../', { delay: 20 });

  const beforeDepth2 = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(beforeDepth2)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth2Request = (await postedMessages(page))
    .slice(beforeDepth2)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(depth2Request.parentDepth).toBe(2);
  expect(depth2Request.relativeQuery).toBe('');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth2Request.requestId,
    parentDepth: 2,
    relativeQuery: '',
    items: [
      {
        id: 'file:../../top.md',
        kind: 'file',
        label: 'top.md',
        insertionPath: '../../top.md',
      },
    ],
  });

  const depth2Listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(depth2Listbox).toBeVisible();
  await depth2Listbox.getByRole('option', { name: 'top.md' }).click();
  await expect(composer).toHaveValue('Grand @top.md ');

  // ── Depth 3: @../../../ must never request the host ─────────────────────
  await composer.fill('');
  await composer.click();
  const beforeDepth3 = (await postedMessages(page)).length;
  await composer.pressSequentially('Too deep @../../../', { delay: 20 });
  // Wait past debounce; no new request should appear.
  await page.waitForTimeout(250);
  const afterDepth3 = (await postedMessages(page)).slice(beforeDepth3).filter(
    (m) => (m as { type?: string }).type === 'requestFileMentionSuggestions',
  );
  expect(afterDepth3).toHaveLength(0);
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);
});

/**
 * T04: assembled S02 bounded parent navigation flow.
 * Real typing for @../ / @../../, nested directory mouse drill-down,
 * normalized relative insert + dual-text send, depth-3 non-request,
 * and late responses from a prior query / other task that must not paint.
 * Fixture-relative insertion paths only — never absolute host paths.
 */
test('bounded parent file mention flow covers depth, drill-down, stale task, and insert', async ({
  page,
}) => {
  await openWebview(page);

  // ── Draft @../ depth 1 + nested directory path ─────────────────────────
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 40 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const draftComposer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await draftComposer.click();
  await draftComposer.pressSequentially('Scope @../', { delay: 20 });

  const draftDepth1Before = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(draftDepth1Before)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const draftDepth1 = (await postedMessages(page))
    .slice(draftDepth1Before)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
    taskId?: string;
  };
  expect(draftDepth1.parentDepth).toBe(1);
  expect(draftDepth1.relativeQuery).toBe('');
  expect(draftDepth1.taskId).toBeUndefined();
  expect(typeof draftDepth1.requestId).toBe('string');
  expect(draftDepth1.requestId.length).toBeGreaterThan(0);

  // Late response from a prior (different) query — must not paint.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: 'stale-prior-query-t04',
    parentDepth: 0,
    relativeQuery: 'old',
    items: [
      {
        id: 'file:stale-prior.md',
        kind: 'file',
        label: 'stale-prior.md',
        insertionPath: 'stale-prior.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: draftDepth1.requestId,
    parentDepth: 1,
    relativeQuery: '',
    items: [
      {
        id: 'dir:../packages',
        kind: 'directory',
        label: 'packages',
        insertionPath: '../packages',
      },
      {
        id: 'file:../root.md',
        kind: 'file',
        label: 'root.md',
        insertionPath: '../root.md',
      },
    ],
  });

  const draftListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(draftListbox).toBeVisible();
  await expect(draftListbox.getByRole('option', { name: 'stale-prior.md' })).toHaveCount(0);
  await expect(draftListbox.getByRole('option', { name: 'packages/' })).toBeVisible();

  // Nested directory mouse path: packages/ → utils/ → helper.ts
  const beforePackagesDrill = (await postedMessages(page)).length;
  await draftListbox.getByRole('option', { name: 'packages/' }).click();
  await expect(draftComposer).toHaveValue('Scope @../packages/');

  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(beforePackagesDrill)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const packagesRequest = (await postedMessages(page))
    .slice(beforePackagesDrill)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(packagesRequest.parentDepth).toBe(1);
  expect(packagesRequest.relativeQuery).toBe('packages/');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: packagesRequest.requestId,
    parentDepth: 1,
    relativeQuery: 'packages/',
    items: [
      {
        id: 'dir:../packages/utils',
        kind: 'directory',
        label: 'utils',
        insertionPath: '../packages/utils',
      },
    ],
  });

  const utilsListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(utilsListbox).toBeVisible();
  const beforeUtilsDrill = (await postedMessages(page)).length;
  await utilsListbox.getByRole('option', { name: 'utils/' }).click();
  await expect(draftComposer).toHaveValue('Scope @../packages/utils/');

  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(beforeUtilsDrill)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const utilsRequest = (await postedMessages(page))
    .slice(beforeUtilsDrill)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(utilsRequest.parentDepth).toBe(1);
  expect(utilsRequest.relativeQuery).toBe('packages/utils/');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: utilsRequest.requestId,
    parentDepth: 1,
    relativeQuery: 'packages/utils/',
    items: [
      {
        id: 'file:../packages/utils/helper.ts',
        kind: 'file',
        label: 'helper.ts',
        insertionPath: '../packages/utils/helper.ts',
      },
    ],
  });

  const helperListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(helperListbox).toBeVisible();
  await helperListbox.getByRole('option', { name: 'helper.ts' }).click();
  await expect(helperListbox).toHaveCount(0);
  // Display token is basename; agent path stays the normalized relative insertionPath.
  await expect(draftComposer).toHaveValue('Scope @helper.ts ');

  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Scope @helper.ts',
    llmText: 'Scope @../packages/utils/helper.ts',
    backend: 'claude',
  });

  // ── Draft @../../ depth 2 ───────────────────────────────────────────────
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 41 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const depth2Composer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await depth2Composer.click();
  await depth2Composer.pressSequentially('Grand @../../', { delay: 20 });

  const depth2Before = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(depth2Before)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth2Request = (await postedMessages(page))
    .slice(depth2Before)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
    taskId?: string;
  };
  expect(depth2Request.parentDepth).toBe(2);
  expect(depth2Request.relativeQuery).toBe('');
  expect(depth2Request.taskId).toBeUndefined();

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth2Request.requestId,
    parentDepth: 2,
    relativeQuery: '',
    items: [
      {
        id: 'file:../../top.md',
        kind: 'file',
        label: 'top.md',
        insertionPath: '../../top.md',
      },
    ],
  });

  const depth2Listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(depth2Listbox).toBeVisible();
  await depth2Listbox.getByRole('option', { name: 'top.md' }).click();
  await expect(depth2Composer).toHaveValue('Grand @top.md ');

  // ── Depth 3 never requests the host ─────────────────────────────────────
  await depth2Composer.fill('');
  await depth2Composer.click();
  const beforeDepth3 = (await postedMessages(page)).length;
  await depth2Composer.pressSequentially('Too deep @../../../', { delay: 20 });
  await page.waitForTimeout(250);
  const afterDepth3 = (await postedMessages(page)).slice(beforeDepth3).filter(
    (m) => (m as { type?: string }).type === 'requestFileMentionSuggestions',
  );
  expect(afterDepth3).toHaveLength(0);
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  // ── Idle task scope + late response from another task ───────────────────
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-parent-a',
        goal: 'Parent mention task A',
        viewStatus: 'idle',
      }),
      task({
        id: 'task-parent-b',
        goal: 'Parent mention task B',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-parent-a',
    subtree: [
      task({
        id: 'task-parent-a',
        goal: 'Parent mention task A',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-parent-a', kind: 'assistant', content: 'Task A ready.' }],
    storeRevision: 42,
  });

  await expect(page.getByText('Task A ready.')).toBeVisible();
  const taskAComposer = page.getByPlaceholder('Message this task…');
  await expect(taskAComposer).toBeEnabled();
  await taskAComposer.click();
  await taskAComposer.pressSequentially('A @../', { delay: 20 });

  const taskABefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(taskABefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const taskARequest = (await postedMessages(page))
    .slice(taskABefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
    taskId?: string;
  };
  expect(taskARequest.parentDepth).toBe(1);
  expect(taskARequest.relativeQuery).toBe('');
  expect(taskARequest.taskId).toBe('task-parent-a');

  // Switch focused task before answering — late task-A response must not paint on B.
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-parent-a',
        goal: 'Parent mention task A',
        viewStatus: 'idle',
      }),
      task({
        id: 'task-parent-b',
        goal: 'Parent mention task B',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-parent-b',
    subtree: [
      task({
        id: 'task-parent-b',
        goal: 'Parent mention task B',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-parent-b', kind: 'assistant', content: 'Task B ready.' }],
    storeRevision: 43,
  });

  await expect(page.getByText('Task B ready.')).toBeVisible();
  const taskBComposer = page.getByPlaceholder('Message this task…');
  await expect(taskBComposer).toBeEnabled();
  // Composer draft is component-local and may survive focus switches; clear so
  // the B-scope token is the only active query while A’s late response is injected.
  await taskBComposer.fill('');
  await taskBComposer.click();
  await taskBComposer.pressSequentially('B @../', { delay: 20 });

  const taskBBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(taskBBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const taskBRequest = (await postedMessages(page))
    .slice(taskBBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
    taskId?: string;
  };
  expect(taskBRequest.parentDepth).toBe(1);
  expect(taskBRequest.relativeQuery).toBe('');
  expect(taskBRequest.taskId).toBe('task-parent-b');
  expect(taskBRequest.requestId).not.toBe(taskARequest.requestId);

  // Late response for the other task (A) — must neither render nor insert.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: taskARequest.requestId,
    parentDepth: 1,
    relativeQuery: '',
    items: [
      {
        id: 'file:../other-task.md',
        kind: 'file',
        label: 'other-task.md',
        insertionPath: '../other-task.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);
  await expect(taskBComposer).toHaveValue('B @../');

  // Matching task-B response paints; mouse file select inserts display token only.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: taskBRequest.requestId,
    parentDepth: 1,
    relativeQuery: '',
    items: [
      {
        id: 'file:../current-task.md',
        kind: 'file',
        label: 'current-task.md',
        insertionPath: '../current-task.md',
      },
    ],
  });

  const taskBListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(taskBListbox).toBeVisible();
  await expect(taskBListbox.getByRole('option', { name: 'other-task.md' })).toHaveCount(0);
  await taskBListbox.getByRole('option', { name: 'current-task.md' }).click();
  await expect(taskBListbox).toHaveCount(0);
  await expect(taskBComposer).toHaveValue('B @current-task.md ');

  // Prove the stale other-task item was never insertable: composer has only the
  // matching selection, and send expands the bound relative path for the LLM.
  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    taskId: 'task-parent-b',
    text: 'B @current-task.md',
    llmText: 'B @../current-task.md',
  });
});

/**
 * T04 full S01 browser-flow proof: draft + idle task, real typing/click,
 * active-query replacement, and dual text/llmText send resolution.
 * Playwright only — not native Extension Development Host proof.
 */
test('current-directory file mention flow covers draft and idle task dual-text send', async ({
  page,
}) => {
  await openWebview(page);

  // ── Draft mode ──────────────────────────────────────────────────────────
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 20 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const draftComposer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await draftComposer.click();
  // Real typing — not fill/value injection — so caret-driven autocomplete runs.
  await draftComposer.pressSequentially('Draft note @re', { delay: 20 });

  const draftBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(draftBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const draftRequest = (await postedMessages(page))
    .slice(draftBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
    taskId?: string;
  };
  expect(draftRequest.parentDepth).toBe(0);
  expect(draftRequest.relativeQuery).toBe('re');
  expect(draftRequest.taskId).toBeUndefined();
  expect(typeof draftRequest.requestId).toBe('string');
  expect(draftRequest.requestId.length).toBeGreaterThan(0);

  // Bounded current-directory fixture: relative items only; multi-segment
  // insertionPath proves display-token → agent-path expand-on-send.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: draftRequest.requestId,
    parentDepth: 0,
    relativeQuery: 're',
    items: [
      {
        id: 'file:readme.md',
        kind: 'file',
        label: 'readme.md',
        insertionPath: 'docs/readme.md',
      },
      {
        id: 'dir:reports',
        kind: 'directory',
        label: 'reports',
        insertionPath: 'reports',
      },
    ],
  });

  const draftListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(draftListbox).toBeVisible();
  await expect(draftListbox.getByRole('option', { name: 'readme.md' })).toBeVisible();
  // S02 shows directory rows for drill-down navigation.
  await expect(draftListbox.getByRole('option', { name: 'reports/' })).toBeVisible();

  await draftListbox.getByRole('option', { name: 'readme.md' }).click();
  await expect(draftListbox).toHaveCount(0);
  // Only the active @re token is replaced; leading text is preserved.
  await expect(draftComposer).toHaveValue('Draft note @readme.md ');

  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Draft note @readme.md',
    llmText: 'Draft note @docs/readme.md',
    backend: 'claude',
  });

  // ── Idle existing task ──────────────────────────────────────────────────
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-idle-mention',
        goal: 'Idle task for current-directory mention flow',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-idle-mention',
    subtree: [
      task({
        id: 'task-idle-mention',
        goal: 'Idle task for current-directory mention flow',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-idle-mention', kind: 'assistant', content: 'Ready for mentions.' }],
    storeRevision: 21,
  });

  await expect(page.getByText('Ready for mentions.')).toBeVisible();
  const taskComposer = page.getByPlaceholder('Message this task…');
  await expect(taskComposer).toBeEnabled();
  await taskComposer.click();
  await taskComposer.pressSequentially('Check @pa', { delay: 20 });

  const taskBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(taskBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const taskRequest = (await postedMessages(page))
    .slice(taskBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
    taskId?: string;
  };
  expect(taskRequest.parentDepth).toBe(0);
  expect(taskRequest.relativeQuery).toBe('pa');
  expect(taskRequest.taskId).toBe('task-idle-mention');
  expect(typeof taskRequest.requestId).toBe('string');
  expect(taskRequest.requestId.length).toBeGreaterThan(0);

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: taskRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'pa',
    items: [
      {
        id: 'file:package.json',
        kind: 'file',
        label: 'package.json',
        insertionPath: 'package.json',
      },
      {
        id: 'dir:packages',
        kind: 'directory',
        label: 'packages',
        insertionPath: 'packages',
      },
    ],
  });

  const taskListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(taskListbox).toBeVisible();
  await expect(taskListbox.getByRole('option', { name: 'package.json' })).toBeVisible();
  await expect(taskListbox.getByRole('option', { name: 'packages/' })).toBeVisible();

  await taskListbox.getByRole('option', { name: 'package.json' }).click();
  await expect(taskListbox).toHaveCount(0);
  await expect(taskComposer).toHaveValue('Check @package.json ');

  await page.getByRole('button', { name: 'Send' }).click();
  // Basename insertionPath === display token, so llmText equals text and is omitted.
  await expectPostedMessage(page, {
    type: 'send',
    taskId: 'task-idle-mention',
    text: 'Check @package.json',
  });
  const taskSend = (await postedMessages(page))
    .slice(taskBefore)
    .find(
      (m) =>
        (m as { type?: string }).type === 'send' &&
        (m as { taskId?: string }).taskId === 'task-idle-mention',
    ) as { type: string; text: string; llmText?: string; taskId: string };
  expect(taskSend.text).toBe('Check @package.json');
  expect(taskSend.llmText).toBeUndefined();
});

/**
 * Integration proof across production seams: the browser emits a bounded
 * task-scoped request, the real host listing core derives its authoritative cwd
 * and reads the filesystem, and the guarded result returns through the popup,
 * mention binding, and dual text/llmText send path.
 */
test('production host listing composes with browser selection and dual-path send', async ({
  page,
}) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-file-mention-'));
  const taskCwd = path.join(fixtureRoot, 'task');
  await fs.mkdir(taskCwd);
  await fs.writeFile(path.join(fixtureRoot, 'config.ts'), 'export const safe = true;\n');

  try {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 'task-production-host-mention',
          goal: 'Exercise production host listing',
          viewStatus: 'idle',
        }),
      ],
      focusedTaskId: 'task-production-host-mention',
      subtree: [
        task({
          id: 'task-production-host-mention',
          goal: 'Exercise production host listing',
          viewStatus: 'idle',
        }),
      ],
      transcript: [{ id: 'msg-production-host-mention', kind: 'assistant', content: 'Ready.' }],
      storeRevision: 31,
    });

    const composer = page.getByPlaceholder('Message this task…');
    await composer.click();
    const requestStart = (await postedMessages(page)).length;
    await composer.pressSequentially('Review @../co', { delay: 15 });

    await expect
      .poll(async () => {
        const messages = await postedMessages(page);
        return messages
          .slice(requestStart)
          .filter(
            (message) =>
              (message as { type?: string }).type === 'requestFileMentionSuggestions',
          );
      })
      .not.toHaveLength(0);

    const request = (await postedMessages(page))
      .slice(requestStart)
      .find(
        (message) =>
          (message as { type?: string }).type === 'requestFileMentionSuggestions',
      ) as {
      requestId: string;
      taskId?: string;
      parentDepth: number;
      relativeQuery: string;
    };
    expect(request).toMatchObject({
      taskId: 'task-production-host-mention',
      parentDepth: 1,
      relativeQuery: 'co',
    });
    expect(JSON.stringify(request)).not.toContain(taskCwd);

    const resolvedScopes: Array<{ taskId?: string }> = [];
    const result = await listFileMentionSuggestions(
      {
        requestId: request.requestId,
        taskId: request.taskId,
        parentDepth: request.parentDepth,
        relativeQuery: request.relativeQuery,
      },
      {
        resolveCwd: (scope) => {
          resolvedScopes.push(scope);
          return scope.taskId === 'task-production-host-mention' ? taskCwd : undefined;
        },
        readDirectory: (dirPath) => fs.readdir(dirPath, { withFileTypes: true }),
        isDirectorySymlink: isFileMentionDirectorySymlink,
      },
    );

    expect(resolvedScopes).toEqual([{ taskId: 'task-production-host-mention' }]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(fixtureRoot);
    if (!result.ok) throw new Error(`production host listing failed: ${result.code}`);
    expect(result.items).toEqual([
      {
        id: 'file:../config.ts',
        kind: 'file',
        label: 'config.ts',
        insertionPath: '../config.ts',
      },
    ]);

    await postRawHostMessage(page, {
      type: 'fileMentionSuggestions',
      ok: true,
      requestId: result.requestId,
      parentDepth: result.parentDepth,
      relativeQuery: result.relativeQuery,
      items: result.items,
    });

    const listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: 'config.ts' }).click();
    await expect(composer).toHaveValue('Review @config.ts ');

    await page.getByRole('button', { name: 'Send' }).click();
    await expectPostedMessage(page, {
      type: 'send',
      taskId: 'task-production-host-mention',
      text: 'Review @config.ts',
      llmText: 'Review @../config.ts',
    });
    await expect(page.locator('body')).not.toContainText(fixtureRoot);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

/**
 * Integration regression for the durable send NACK path. A rejected send must
 * restore only the user-visible relative mention text from the outbox; the
 * agent-facing llmText path must not leak into the composer or error chrome.
 */
test('sendRejected restores file mention display text without exposing agent paths', async ({
  page,
}) => {
  await openWebview(page);
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-mention-rejected',
        goal: 'Reject a file mention send safely',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-mention-rejected',
    subtree: [
      task({
        id: 'task-mention-rejected',
        goal: 'Reject a file mention send safely',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-mention-rejected', kind: 'assistant', content: 'Ready.' }],
    storeRevision: 30,
  });

  const composer = page.getByPlaceholder('Message this task…');
  await composer.click();
  const requestStart = (await postedMessages(page)).length;
  await composer.pressSequentially('Review @co', { delay: 15 });
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(requestStart)
        .filter((message) => (message as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const request = (await postedMessages(page))
    .slice(requestStart)
    .find(
      (message) => (message as { type?: string }).type === 'requestFileMentionSuggestions',
    ) as {
    requestId: string;
  };

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: request.requestId,
    parentDepth: 0,
    relativeQuery: 'co',
    items: [
      {
        id: 'file:config.ts',
        kind: 'file',
        label: 'config.ts',
        insertionPath: 'src/private/config.ts',
      },
    ],
  });

  await page
    .getByRole('listbox', { name: 'File mention suggestions' })
    .getByRole('option', { name: 'config.ts' })
    .click();
  await expect(composer).toHaveValue('Review @config.ts ');

  await page.getByRole('button', { name: 'Send' }).click();
  const send = (await postedMessages(page)).find(
    (message) =>
      (message as { type?: string; taskId?: string }).type === 'send' &&
      (message as { taskId?: string }).taskId === 'task-mention-rejected',
  ) as {
    clientRequestId: string;
    text: string;
    llmText?: string;
  };
  expect(send.text).toBe('Review @config.ts');
  expect(send.llmText).toBe('Review @src/private/config.ts');
  expect(send.clientRequestId).toEqual(expect.any(String));
  await expect(composer).toHaveValue('');

  await postRawHostMessage(page, {
    type: 'sendRejected',
    clientRequestId: send.clientRequestId,
    taskId: 'task-mention-rejected',
    reason: 'Task queue capacity reached.',
    code: 'capacity',
  });

  await expect(composer).toHaveValue('Review @config.ts');
  await expect(page.getByRole('alert').getByText('Task queue capacity reached.')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('src/private/config.ts');

  // Retrying the restored draft must retain the private display-token binding.
  // Otherwise the second send silently loses llmText and the agent sees only @config.ts.
  const retryStart = (await postedMessages(page)).length;
  await page.getByRole('button', { name: 'Send' }).click();
  const retrySend = (await postedMessages(page))
    .slice(retryStart)
    .find(
      (message) =>
        (message as { type?: string; taskId?: string }).type === 'send' &&
        (message as { taskId?: string }).taskId === 'task-mention-rejected',
    ) as {
    clientRequestId: string;
    text: string;
    llmText?: string;
  };
  expect(retrySend.text).toBe('Review @config.ts');
  expect(retrySend.llmText).toBe('Review @src/private/config.ts');
  expect(retrySend.clientRequestId).not.toBe(send.clientRequestId);
});

/**
 * T03: keyboard / mouse / IME / caret proof for file-mention autocomplete.
 * Real typing + host-mocked suggestions — not Extension Development Host.
 */
test('file mention autocomplete keyboard mouse IME and caret interactions', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Vite/dev asset 403s are harness noise, not product regressions.
    const text = msg.text();
    if (/status of 403|Failed to load resource/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    // Ignore harness asset 403/net::ERR noise from Vite/dev server.
    if (/403|ERR_ABORTED|net::ERR/i.test(failure) || /403/.test(req.url())) return;
    failedRequests.push(`${req.method()} ${req.url()} ${failure}`);
  });

  await openWebview(page);
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 40 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await composer.click();

  // ── Keyboard: Arrow navigation, Enter accepts (does not send), Escape dismisses ──
  await composer.pressSequentially('Draft note @re', { delay: 20 });

  const kbBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(kbBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const kbRequest = (await postedMessages(page))
    .slice(kbBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(kbRequest.parentDepth).toBe(0);
  expect(kbRequest.relativeQuery).toBe('re');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: kbRequest.requestId,
    parentDepth: 0,
    relativeQuery: 're',
    items: [
      {
        id: 'file:readme.md',
        kind: 'file',
        label: 'readme.md',
        insertionPath: 'docs/readme.md',
      },
      {
        id: 'file:reports.md',
        kind: 'file',
        label: 'reports.md',
        insertionPath: 'reports.md',
      },
      {
        id: 'dir:research',
        kind: 'directory',
        label: 'research',
        insertionPath: 'research',
      },
    ],
  });

  const listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(listbox).toBeVisible();
  await expect(listbox).toHaveAttribute('data-testid', 'file-mention-listbox');
  await expect(composer).toHaveAttribute('aria-expanded', 'true');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-0');

  // Active-option state via mouseenter (same mentionActiveIndex path as Arrow move).
  // Pure Arrow policy is covered by unit tests; browser proof focuses on accept/dismiss.
  await expect(composer).toBeFocused();
  await listbox.getByRole('option', { name: 'reports.md' }).hover();
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
  await expect(listbox.getByRole('option', { name: 'reports.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Return highlight to first option for Enter accept proof.
  await listbox.getByRole('option', { name: 'readme.md' }).hover();
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-0');
  await expect(composer).toBeFocused();

  // Enter accepts the active option — must not post send while popup is open.
  const beforeEnter = (await postedMessages(page)).length;
  await composer.press('Enter');
  await expect(listbox).toHaveCount(0);
  // Only the active @re token is replaced; leading draft text is preserved.
  await expect(composer).toHaveValue('Draft note @readme.md ');
  await expect(composer).toBeFocused();
  const afterEnter = await postedMessages(page);
  expect(
    afterEnter
      .slice(beforeEnter)
      .some((m) => (m as { type?: string }).type === 'send'),
  ).toBe(false);

  // Ordinary Enter after dismissal resumes send.
  await composer.press('Enter');
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Draft note @readme.md',
    llmText: 'Draft note @docs/readme.md',
    backend: 'claude',
  });

  // ── Tab accept + mouse click + mid-sentence caret replacement ──
  await composer.fill('');
  await composer.pressSequentially('See @fi before after', { delay: 15 });
  // Move caret into the middle of the @fi query (after "See @fi").
  await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  await composer.dispatchEvent('select');

  const midBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(midBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const midRequest = (await postedMessages(page))
    .slice(midBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    type: string;
    requestId: string;
    relativeQuery: string;
  };
  expect(midRequest.relativeQuery).toBe('fi');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: midRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'fi',
    items: [
      {
        id: 'file:file.ts',
        kind: 'file',
        label: 'file.ts',
        insertionPath: 'src/file.ts',
      },
      {
        id: 'file:filter.ts',
        kind: 'file',
        label: 'filter.ts',
        insertionPath: 'filter.ts',
      },
    ],
  });

  const midListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(midListbox).toBeVisible();

  // Mouse click preserves textarea focus (mousedown preventDefault) and replaces only @fi.
  await midListbox.getByRole('option', { name: 'file.ts' }).click();
  await expect(midListbox).toHaveCount(0);
  await expect(composer).toHaveValue('See @file.ts before after');
  await expect(composer).toBeFocused();

  // Re-open for Tab accept + Escape dismiss proof.
  await composer.fill('');
  await composer.pressSequentially('Pick @ta', { delay: 15 });
  const tabBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(tabBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const tabRequest = (await postedMessages(page))
    .slice(tabBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: tabRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'ta',
    items: [
      {
        id: 'file:task.md',
        kind: 'file',
        label: 'task.md',
        insertionPath: 'task.md',
      },
      {
        id: 'file:table.md',
        kind: 'file',
        label: 'table.md',
        insertionPath: 'table.md',
      },
    ],
  });
  const tabListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(tabListbox).toBeVisible();
  await composer.press('ArrowDown');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
  await composer.press('Tab');
  await expect(tabListbox).toHaveCount(0);
  await expect(composer).toHaveValue('Pick @table.md ');

  // Escape dismisses without inserting; draft preserved.
  await composer.fill('');
  await composer.pressSequentially('Keep @esc', { delay: 15 });
  const escBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(escBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const escRequest = (await postedMessages(page))
    .slice(escBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: escRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'esc',
    items: [
      {
        id: 'file:escape.md',
        kind: 'file',
        label: 'escape.md',
        insertionPath: 'escape.md',
      },
    ],
  });
  const escListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(escListbox).toBeVisible();
  await composer.press('Escape');
  await expect(escListbox).toHaveCount(0);
  await expect(composer).toHaveValue('Keep @esc');
  await expect(composer).toHaveAttribute('aria-expanded', 'false');

  // ── Email-like text does not open the popup or request host suggestions ──
  await composer.fill('');
  const emailBefore = (await postedMessages(page)).length;
  await composer.pressSequentially('user@example.com', { delay: 10 });
  await page.waitForTimeout(200);
  const emailMessages = (await postedMessages(page)).slice(emailBefore);
  expect(
    emailMessages.filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions'),
  ).toHaveLength(0);
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  // ── IME composition must not open the popup or post host requests ──
  await composer.fill('');
  await composer.click();
  const imeBefore = (await postedMessages(page)).length;
  await composer.evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    el.value = 'こんにちは@re';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'こんにちは@re', isComposing: true }));
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(
      new CompositionEvent('compositionupdate', { bubbles: true, data: 'こんにちは@re' }),
    );
  });
  await page.waitForTimeout(200);
  const imeDuring = (await postedMessages(page)).slice(imeBefore);
  expect(
    imeDuring.filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions'),
  ).toHaveLength(0);
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);
  // End composition and re-evaluate; still no request if query invalid / closed during IME.
  await composer.evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: 'こんにちは@re' }),
    );
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Force a clean non-composition @ query next.
  await composer.fill('');
  await composer.pressSequentially('@ime', { delay: 15 });
  const imeAfterBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(imeAfterBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  // ── Empty results: status popup, draft preserved, no free-form host text ──
  await composer.fill('');
  await composer.pressSequentially('Empty @zz', { delay: 15 });
  const emptyBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(emptyBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const emptyRequest = (await postedMessages(page))
    .slice(emptyBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    relativeQuery: string;
  };
  expect(emptyRequest.relativeQuery).toBe('zz');
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: emptyRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'zz',
    items: [],
  });
  const emptyListbox = page.getByTestId('file-mention-listbox');
  await expect(emptyListbox).toBeVisible();
  await expect(emptyListbox).toHaveAttribute('data-outcome', 'empty');
  await expect(page.getByTestId('file-mention-status')).toHaveText('No matching files');
  await expect(composer).toHaveValue('Empty @zz');
  // Enter while empty status is open must not send.
  const emptyEnterBefore = (await postedMessages(page)).length;
  await composer.press('Enter');
  expect(
    (await postedMessages(page))
      .slice(emptyEnterBefore)
      .some((m) => (m as { type?: string }).type === 'send'),
  ).toBe(false);
  await composer.press('Escape');
  await expect(emptyListbox).toHaveCount(0);
  await expect(composer).toHaveValue('Empty @zz');

  // ── Sanitized host error: no codes/paths in UI, draft preserved ──
  await composer.fill('');
  await composer.pressSequentially('Fail @er', { delay: 15 });
  const errBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(errBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const errRequest = (await postedMessages(page))
    .slice(errBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    ok: false,
    requestId: errRequest.requestId,
    code: 'listingFailed',
  });
  const errListbox = page.getByTestId('file-mention-listbox');
  await expect(errListbox).toBeVisible();
  await expect(errListbox).toHaveAttribute('data-outcome', 'error');
  await expect(page.getByTestId('file-mention-status')).toHaveText('File suggestions unavailable');
  await expect(composer).toHaveValue('Fail @er');
  // Never surface host codes or absolute paths in the DOM.
  await expect(page.locator('body')).not.toContainText('listingFailed');
  await expect(page.locator('body')).not.toContainText('/Users');
  await expect(page.locator('body')).not.toContainText('C:\\');
  await composer.press('Escape');
  await expect(errListbox).toHaveCount(0);
  await expect(composer).toHaveValue('Fail @er');

  // ── Task change closes suggestions ──
  await composer.fill('');
  await composer.pressSequentially('Scope @ch', { delay: 15 });
  const taskChangeBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(taskChangeBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const taskChangeRequest = (await postedMessages(page))
    .slice(taskChangeBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: taskChangeRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'ch',
    items: [
      {
        id: 'file:change.md',
        kind: 'file',
        label: 'change.md',
        insertionPath: 'change.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toBeVisible();

  // Switch into an existing task — mode/taskId effect closes the popup.
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-mention-switch',
        goal: 'Task change closes mention popup',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-mention-switch',
    subtree: [
      task({
        id: 'task-mention-switch',
        goal: 'Task change closes mention popup',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-switch', kind: 'assistant', content: 'Ready after switch.' }],
    storeRevision: 41,
  });
  await expect(page.getByText('Ready after switch.')).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  // ── Blocked composer (pending ask) closes suggestions ──
  const taskComposer = page.getByPlaceholder('Message this task…');
  await expect(taskComposer).toBeEnabled();
  await taskComposer.click();
  await taskComposer.pressSequentially('Block @bl', { delay: 15 });
  const blockBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(blockBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const blockRequest = (await postedMessages(page))
    .slice(blockBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    taskId?: string;
  };
  expect(blockRequest.taskId).toBe('task-mention-switch');
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: blockRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'bl',
    items: [
      {
        id: 'file:block.md',
        kind: 'file',
        label: 'block.md',
        insertionPath: 'block.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toBeVisible();

  // Pending ask blocks free-form send and must close the popup.
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-mention-switch',
        goal: 'Task change closes mention popup',
        viewStatus: 'waiting_user',
      }),
    ],
    focusedTaskId: 'task-mention-switch',
    subtree: [
      task({
        id: 'task-mention-switch',
        goal: 'Task change closes mention popup',
        viewStatus: 'waiting_user',
      }),
    ],
    transcript: [{ id: 'msg-switch', kind: 'assistant', content: 'Ready after switch.' }],
    activeTurnId: 'turn-block',
    pendingAsk: {
      turnId: 'turn-block',
      askId: 'ask-block',
      questions: [{ prompt: 'Continue?', options: ['Yes', 'No'], allowFreeText: false }],
    },
    storeRevision: 42,
  });
  await expect(page.getByText('Answer above to continue.')).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  // No console errors, page errors, or failed network requests from this flow.
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
});

test('accessible file mention keyboard flow', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/status of 403|Failed to load resource/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    if (/403|ERR_ABORTED|net::ERR/i.test(failure) || /403/.test(req.url())) return;
    failedRequests.push(`${req.method()} ${req.url()} ${failure}`);
  });

  await openWebview(page);
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 50 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await composer.click();
  await expect(composer).toBeFocused();

  // Closed baseline: combobox-like list semantics present, popup collapsed.
  await expect(composer).toHaveAttribute('aria-autocomplete', 'list');
  await expect(composer).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  await expect(composer).not.toHaveAttribute('aria-activedescendant');
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  // ── Type @ and open listbox: full accessibility contract ──
  await composer.pressSequentially('Review @ac', { delay: 15 });
  const openBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(openBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const openRequest = (await postedMessages(page))
    .slice(openBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    relativeQuery: string;
    parentDepth: number;
  };
  expect(openRequest.relativeQuery).toBe('ac');
  expect(openRequest.parentDepth).toBe(0);

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: openRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'ac',
    items: [
      {
        id: 'file:access.md',
        kind: 'file',
        label: 'access.md',
        insertionPath: 'docs/access.md',
      },
      {
        id: 'file:actions.ts',
        kind: 'file',
        label: 'actions.ts',
        insertionPath: 'src/actions.ts',
      },
      {
        id: 'dir:accounts',
        kind: 'directory',
        label: 'accounts',
        insertionPath: 'accounts',
      },
    ],
  });

  const listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(listbox).toBeVisible();
  await expect(listbox).toHaveAttribute('id', 'file-mention-listbox');
  await expect(listbox).toHaveAttribute('data-testid', 'file-mention-listbox');
  await expect(listbox).toHaveAttribute('data-outcome', 'ready');
  await expect(listbox).toHaveAttribute('role', 'listbox');
  await expect(listbox).toHaveAttribute('aria-label', 'File mention suggestions');

  // Textarea remains focused; listbox is controlled via aria-activedescendant.
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute('aria-expanded', 'true');
  await expect(composer).toHaveAttribute('aria-controls', 'file-mention-listbox');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-0');

  const options = listbox.getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute('id', 'file-mention-option-0');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(0)).toHaveAttribute('data-testid', 'file-mention-option');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'false');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'false');
  // Directory option exposes trailing slash in accessible name.
  await expect(options.nth(2)).toHaveAttribute('aria-label', 'accounts/');

  // ── ArrowDown / ArrowUp move active option with aria-activedescendant ──
  await composer.press('ArrowDown');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(composer).toBeFocused();

  await composer.press('ArrowDown');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-2');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');

  await composer.press('ArrowUp');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');

  // Mouse hover also drives the same active option path.
  await options.nth(0).hover();
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-0');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(composer).toBeFocused();

  // ── Enter accepts active option; does not send ──
  const beforeEnter = (await postedMessages(page)).length;
  await composer.press('Enter');
  await expect(listbox).toHaveCount(0);
  await expect(composer).toHaveValue('Review @access.md ');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  await expect(composer).not.toHaveAttribute('aria-activedescendant');
  expect(
    (await postedMessages(page))
      .slice(beforeEnter)
      .some((m) => (m as { type?: string }).type === 'send'),
  ).toBe(false);

  // Ordinary Enter after popup close resumes send.
  await composer.press('Enter');
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Review @access.md',
    llmText: 'Review @docs/access.md',
    backend: 'claude',
  });

  // ── Mid-sentence caret replacement via mouse ──
  await composer.fill('');
  await composer.pressSequentially('See @fi before after', { delay: 12 });
  await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  await composer.dispatchEvent('select');

  const midBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(midBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const midRequest = (await postedMessages(page))
    .slice(midBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    relativeQuery: string;
  };
  expect(midRequest.relativeQuery).toBe('fi');
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: midRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'fi',
    items: [
      {
        id: 'file:file.ts',
        kind: 'file',
        label: 'file.ts',
        insertionPath: 'src/file.ts',
      },
      {
        id: 'file:filter.ts',
        kind: 'file',
        label: 'filter.ts',
        insertionPath: 'filter.ts',
      },
    ],
  });
  const midListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(midListbox).toBeVisible();
  await expect(composer).toHaveAttribute('aria-expanded', 'true');
  await midListbox.getByRole('option', { name: 'file.ts' }).click();
  await expect(midListbox).toHaveCount(0);
  await expect(composer).toHaveValue('See @file.ts before after');
  await expect(composer).toBeFocused();

  // ── Tab accept after Arrow navigation ──
  await composer.fill('');
  await composer.pressSequentially('Pick @ta', { delay: 12 });
  const tabBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(tabBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const tabRequest = (await postedMessages(page))
    .slice(tabBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: tabRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'ta',
    items: [
      {
        id: 'file:task.md',
        kind: 'file',
        label: 'task.md',
        insertionPath: 'task.md',
      },
      {
        id: 'file:table.md',
        kind: 'file',
        label: 'table.md',
        insertionPath: 'table.md',
      },
    ],
  });
  const tabListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(tabListbox).toBeVisible();
  await composer.press('ArrowDown');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
  await expect(tabListbox.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await composer.press('Tab');
  await expect(tabListbox).toHaveCount(0);
  await expect(composer).toHaveValue('Pick @table.md ');
  await expect(composer).toBeFocused();

  // ── Escape dismisses without insert; draft + collapsed ARIA preserved ──
  await composer.fill('');
  await composer.pressSequentially('Keep @esc', { delay: 12 });
  const escBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(escBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const escRequest = (await postedMessages(page))
    .slice(escBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: escRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'esc',
    items: [
      {
        id: 'file:escape.md',
        kind: 'file',
        label: 'escape.md',
        insertionPath: 'escape.md',
      },
    ],
  });
  const escListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(escListbox).toBeVisible();
  await composer.press('Escape');
  await expect(escListbox).toHaveCount(0);
  await expect(composer).toHaveValue('Keep @esc');
  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  await expect(composer).not.toHaveAttribute('aria-activedescendant');

  // ── Email-like text never opens suggestions ──
  await composer.fill('');
  const emailBefore = (await postedMessages(page)).length;
  await composer.pressSequentially('user@example.com', { delay: 8 });
  await page.waitForTimeout(180);
  expect(
    (await postedMessages(page))
      .slice(emailBefore)
      .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions'),
  ).toHaveLength(0);
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);
  await expect(composer).toHaveAttribute('aria-expanded', 'false');

  // ── IME composition suppresses open/request ──
  await composer.fill('');
  await composer.click();
  const imeBefore = (await postedMessages(page)).length;
  await composer.evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    el.value = 'こんにちは@re';
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: 'こんにちは@re', isComposing: true }),
    );
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(
      new CompositionEvent('compositionupdate', { bubbles: true, data: 'こんにちは@re' }),
    );
  });
  await page.waitForTimeout(180);
  expect(
    (await postedMessages(page))
      .slice(imeBefore)
      .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions'),
  ).toHaveLength(0);
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);
  await composer.evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: 'こんにちは@re' }),
    );
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // ── Empty results: status role + draft preserved ──
  await composer.fill('');
  await composer.pressSequentially('Empty @zz', { delay: 12 });
  const emptyBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(emptyBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const emptyRequest = (await postedMessages(page))
    .slice(emptyBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: emptyRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'zz',
    items: [],
  });
  const emptyListbox = page.getByTestId('file-mention-listbox');
  await expect(emptyListbox).toBeVisible();
  await expect(emptyListbox).toHaveAttribute('data-outcome', 'empty');
  const emptyStatus = page.getByTestId('file-mention-status');
  await expect(emptyStatus).toHaveText('No matching files');
  await expect(emptyStatus).toHaveAttribute('role', 'status');
  await expect(emptyStatus).toHaveAttribute('aria-live', 'polite');
  await expect(composer).toHaveValue('Empty @zz');
  await expect(composer).toHaveAttribute('aria-expanded', 'true');
  // No selectable options while empty; Enter must not send.
  await expect(emptyListbox.getByRole('option')).toHaveCount(0);
  const emptyEnterBefore = (await postedMessages(page)).length;
  await composer.press('Enter');
  expect(
    (await postedMessages(page))
      .slice(emptyEnterBefore)
      .some((m) => (m as { type?: string }).type === 'send'),
  ).toBe(false);
  await composer.press('Escape');
  await expect(emptyListbox).toHaveCount(0);
  await expect(composer).toHaveValue('Empty @zz');

  // ── Sanitized host error: bounded status, no codes/paths ──
  await composer.fill('');
  await composer.pressSequentially('Fail @er', { delay: 12 });
  const errBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(errBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const errRequest = (await postedMessages(page))
    .slice(errBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    ok: false,
    requestId: errRequest.requestId,
    code: 'listingFailed',
  });
  const errListbox = page.getByTestId('file-mention-listbox');
  await expect(errListbox).toBeVisible();
  await expect(errListbox).toHaveAttribute('data-outcome', 'error');
  await expect(page.getByTestId('file-mention-status')).toHaveText('File suggestions unavailable');
  await expect(composer).toHaveValue('Fail @er');
  await expect(page.locator('body')).not.toContainText('listingFailed');
  await expect(page.locator('body')).not.toContainText('/Users');
  await expect(page.locator('body')).not.toContainText('C:\\');
  await composer.press('Escape');
  await expect(errListbox).toHaveCount(0);

  // ── Task change closes suggestions and collapses ARIA ──
  await composer.fill('');
  await composer.pressSequentially('Scope @ch', { delay: 12 });
  const taskChangeBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(taskChangeBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const taskChangeRequest = (await postedMessages(page))
    .slice(taskChangeBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: taskChangeRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'ch',
    items: [
      {
        id: 'file:change.md',
        kind: 'file',
        label: 'change.md',
        insertionPath: 'change.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toBeVisible();
  await expect(composer).toHaveAttribute('aria-expanded', 'true');

  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-a11y-switch',
        goal: 'Task change closes accessible mention popup',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-a11y-switch',
    subtree: [
      task({
        id: 'task-a11y-switch',
        goal: 'Task change closes accessible mention popup',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-a11y-switch', kind: 'assistant', content: 'Ready after a11y switch.' }],
    storeRevision: 51,
  });
  await expect(page.getByText('Ready after a11y switch.')).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  // ── Blocked composer (pending ask) closes suggestions ──
  const taskComposer = page.getByPlaceholder('Message this task…');
  await expect(taskComposer).toBeEnabled();
  await taskComposer.click();
  await taskComposer.pressSequentially('Block @bl', { delay: 12 });
  const blockBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(blockBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const blockRequest = (await postedMessages(page))
    .slice(blockBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    taskId?: string;
  };
  expect(blockRequest.taskId).toBe('task-a11y-switch');
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: blockRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'bl',
    items: [
      {
        id: 'file:block.md',
        kind: 'file',
        label: 'block.md',
        insertionPath: 'block.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toBeVisible();
  await expect(taskComposer).toHaveAttribute('aria-expanded', 'true');

  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-a11y-switch',
        goal: 'Task change closes accessible mention popup',
        viewStatus: 'waiting_user',
      }),
    ],
    focusedTaskId: 'task-a11y-switch',
    subtree: [
      task({
        id: 'task-a11y-switch',
        goal: 'Task change closes accessible mention popup',
        viewStatus: 'waiting_user',
      }),
    ],
    transcript: [{ id: 'msg-a11y-switch', kind: 'assistant', content: 'Ready after a11y switch.' }],
    activeTurnId: 'turn-a11y-block',
    pendingAsk: {
      turnId: 'turn-a11y-block',
      askId: 'ask-a11y-block',
      questions: [{ prompt: 'Continue?', options: ['Yes', 'No'], allowFreeText: false }],
    },
    storeRevision: 52,
  });
  await expect(page.getByText('Answer above to continue.')).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
});

/**
 * S04 T01 integrated acceptance matrix for assembled file-mention autocomplete.
 * Real typing + option activation across @ / @../ / @../../, directory refinement,
 * mouse + keyboard selection, caret replacement, dual text/llmText, stale and
 * cross-task rejection, empty + sanitized failures, and depth-3 non-request.
 * Playwright browser proof only — not native Extension Development Host.
 */
test('integrated acceptance matrix for assembled file mention autocomplete', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/status of 403|Failed to load resource/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    if (/403|ERR_ABORTED|net::ERR/i.test(failure) || /403/.test(req.url())) return;
    failedRequests.push(`${req.method()} ${req.url()} ${failure}`);
  });

  await openWebview(page);

  // ── @ current-directory: mouse select + dual text/llmText ───────────────
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 80 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const draftComposer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await draftComposer.click();
  await draftComposer.pressSequentially('Matrix @re', { delay: 15 });

  const depth0Before = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(depth0Before)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth0Request = (await postedMessages(page))
    .slice(depth0Before)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(depth0Request.parentDepth).toBe(0);
  expect(depth0Request.relativeQuery).toBe('re');

  // Stale prior-query response must not paint.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: 'stale-matrix-prior',
    parentDepth: 0,
    relativeQuery: 'old',
    items: [
      {
        id: 'file:stale-matrix.md',
        kind: 'file',
        label: 'stale-matrix.md',
        insertionPath: 'stale-matrix.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth0Request.requestId,
    parentDepth: 0,
    relativeQuery: 're',
    items: [
      {
        id: 'file:readme.md',
        kind: 'file',
        label: 'readme.md',
        insertionPath: 'docs/readme.md',
      },
      {
        id: 'dir:reports',
        kind: 'directory',
        label: 'reports',
        insertionPath: 'reports',
      },
    ],
  });

  const depth0Listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(depth0Listbox).toBeVisible();
  await expect(depth0Listbox.getByRole('option', { name: 'stale-matrix.md' })).toHaveCount(0);
  await depth0Listbox.getByRole('option', { name: 'readme.md' }).click();
  await expect(depth0Listbox).toHaveCount(0);
  await expect(draftComposer).toHaveValue('Matrix @readme.md ');

  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Matrix @readme.md',
    llmText: 'Matrix @docs/readme.md',
    backend: 'claude',
  });

  // ── @../ parent: nested directory refinement + dual-text send ────────────
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 81 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const parentComposer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await parentComposer.click();
  await parentComposer.pressSequentially('Parent @../', { delay: 15 });

  const depth1Before = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(depth1Before)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth1Request = (await postedMessages(page))
    .slice(depth1Before)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(depth1Request.parentDepth).toBe(1);
  expect(depth1Request.relativeQuery).toBe('');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth1Request.requestId,
    parentDepth: 1,
    relativeQuery: '',
    items: [
      {
        id: 'dir:../packages',
        kind: 'directory',
        label: 'packages',
        insertionPath: '../packages',
      },
      {
        id: 'file:../root.md',
        kind: 'file',
        label: 'root.md',
        insertionPath: '../root.md',
      },
    ],
  });

  const parentListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(parentListbox).toBeVisible();
  const beforeDrill = (await postedMessages(page)).length;
  await parentListbox.getByRole('option', { name: 'packages/' }).click();
  await expect(parentComposer).toHaveValue('Parent @../packages/');

  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(beforeDrill)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const drillRequest = (await postedMessages(page))
    .slice(beforeDrill)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(drillRequest.parentDepth).toBe(1);
  expect(drillRequest.relativeQuery).toBe('packages/');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: drillRequest.requestId,
    parentDepth: 1,
    relativeQuery: 'packages/',
    items: [
      {
        id: 'file:../packages/helper.ts',
        kind: 'file',
        label: 'helper.ts',
        insertionPath: '../packages/helper.ts',
      },
    ],
  });

  const drillListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(drillListbox).toBeVisible();
  await drillListbox.getByRole('option', { name: 'helper.ts' }).click();
  await expect(drillListbox).toHaveCount(0);
  await expect(parentComposer).toHaveValue('Parent @helper.ts ');

  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Parent @helper.ts',
    llmText: 'Parent @../packages/helper.ts',
    backend: 'claude',
  });

  // ── @../../ grandparent + depth-3 rejection ─────────────────────────────
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 82 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const grandComposer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await grandComposer.click();
  await grandComposer.pressSequentially('Grand @../../', { delay: 15 });

  const depth2Before = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(depth2Before)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth2Request = (await postedMessages(page))
    .slice(depth2Before)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    parentDepth: number;
  };
  expect(depth2Request.parentDepth).toBe(2);

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth2Request.requestId,
    parentDepth: 2,
    relativeQuery: '',
    items: [
      {
        id: 'file:../../top.md',
        kind: 'file',
        label: 'top.md',
        insertionPath: '../../top.md',
      },
    ],
  });

  const depth2Listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(depth2Listbox).toBeVisible();
  await depth2Listbox.getByRole('option', { name: 'top.md' }).click();
  await expect(grandComposer).toHaveValue('Grand @top.md ');

  await grandComposer.fill('');
  await grandComposer.click();
  const beforeDepth3 = (await postedMessages(page)).length;
  await grandComposer.pressSequentially('Too deep @../../../', { delay: 15 });
  await page.waitForTimeout(250);
  const afterDepth3 = (await postedMessages(page))
    .slice(beforeDepth3)
    .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
  expect(afterDepth3).toHaveLength(0);
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  // ── Keyboard accept + mid-sentence caret replacement ─────────────────────
  await grandComposer.fill('');
  await grandComposer.pressSequentially('See @fi before after', { delay: 12 });
  await grandComposer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  await grandComposer.dispatchEvent('select');

  const caretBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(caretBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const caretRequest = (await postedMessages(page))
    .slice(caretBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    relativeQuery: string;
  };
  expect(caretRequest.relativeQuery).toBe('fi');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: caretRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'fi',
    items: [
      {
        id: 'file:file.ts',
        kind: 'file',
        label: 'file.ts',
        insertionPath: 'src/file.ts',
      },
      {
        id: 'file:filter.ts',
        kind: 'file',
        label: 'filter.ts',
        insertionPath: 'filter.ts',
      },
    ],
  });

  const caretListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(caretListbox).toBeVisible();
  await grandComposer.press('ArrowDown');
  await expect(grandComposer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
  await grandComposer.press('Enter');
  await expect(caretListbox).toHaveCount(0);
  await expect(grandComposer).toHaveValue('See @filter.ts before after');

  // ── Empty + sanitized failure outcomes ───────────────────────────────────
  await grandComposer.fill('');
  await grandComposer.pressSequentially('Empty @zz', { delay: 12 });
  const emptyBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(emptyBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const emptyRequest = (await postedMessages(page))
    .slice(emptyBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: emptyRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'zz',
    items: [],
  });
  const emptyListbox = page.getByTestId('file-mention-listbox');
  await expect(emptyListbox).toBeVisible();
  await expect(emptyListbox).toHaveAttribute('data-outcome', 'empty');
  await expect(page.getByTestId('file-mention-status')).toHaveText('No matching files');
  await grandComposer.press('Escape');
  await expect(emptyListbox).toHaveCount(0);

  await grandComposer.fill('');
  await grandComposer.pressSequentially('Fail @er', { delay: 12 });
  const errBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(errBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);
  const errRequest = (await postedMessages(page))
    .slice(errBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
  };
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    ok: false,
    requestId: errRequest.requestId,
    code: 'listingFailed',
  });
  const errListbox = page.getByTestId('file-mention-listbox');
  await expect(errListbox).toBeVisible();
  await expect(errListbox).toHaveAttribute('data-outcome', 'error');
  await expect(page.getByTestId('file-mention-status')).toHaveText('File suggestions unavailable');
  await expect(page.locator('body')).not.toContainText('listingFailed');
  await expect(page.locator('body')).not.toContainText('/Users');
  await expect(page.locator('body')).not.toContainText('C:\\');
  await grandComposer.press('Escape');

  // ── Cross-task stale response rejection ──────────────────────────────────
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-matrix-a',
        goal: 'Matrix task A',
        viewStatus: 'idle',
      }),
      task({
        id: 'task-matrix-b',
        goal: 'Matrix task B',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-matrix-a',
    subtree: [
      task({
        id: 'task-matrix-a',
        goal: 'Matrix task A',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-matrix-a', kind: 'assistant', content: 'Matrix A ready.' }],
    storeRevision: 83,
  });

  await expect(page.getByText('Matrix A ready.')).toBeVisible();
  const taskAComposer = page.getByPlaceholder('Message this task…');
  await expect(taskAComposer).toBeEnabled();
  await taskAComposer.click();
  await taskAComposer.pressSequentially('A @../', { delay: 15 });

  const taskABefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(taskABefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const taskARequest = (await postedMessages(page))
    .slice(taskABefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    taskId?: string;
    parentDepth: number;
  };
  expect(taskARequest.parentDepth).toBe(1);
  expect(taskARequest.taskId).toBe('task-matrix-a');

  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-matrix-a',
        goal: 'Matrix task A',
        viewStatus: 'idle',
      }),
      task({
        id: 'task-matrix-b',
        goal: 'Matrix task B',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-matrix-b',
    subtree: [
      task({
        id: 'task-matrix-b',
        goal: 'Matrix task B',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-matrix-b', kind: 'assistant', content: 'Matrix B ready.' }],
    storeRevision: 84,
  });

  await expect(page.getByText('Matrix B ready.')).toBeVisible();
  const taskBComposer = page.getByPlaceholder('Message this task…');
  await expect(taskBComposer).toBeEnabled();
  await taskBComposer.fill('');
  await taskBComposer.click();
  await taskBComposer.pressSequentially('B @../', { delay: 15 });

  const taskBBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(taskBBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const taskBRequest = (await postedMessages(page))
    .slice(taskBBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    taskId?: string;
  };
  expect(taskBRequest.taskId).toBe('task-matrix-b');
  expect(taskBRequest.requestId).not.toBe(taskARequest.requestId);

  // Late response for task A must not paint on task B.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: taskARequest.requestId,
    parentDepth: 1,
    relativeQuery: '',
    items: [
      {
        id: 'file:../other-task.md',
        kind: 'file',
        label: 'other-task.md',
        insertionPath: '../other-task.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);
  await expect(taskBComposer).toHaveValue('B @../');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: taskBRequest.requestId,
    parentDepth: 1,
    relativeQuery: '',
    items: [
      {
        id: 'file:../current-task.md',
        kind: 'file',
        label: 'current-task.md',
        insertionPath: '../current-task.md',
      },
    ],
  });

  const taskBListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(taskBListbox).toBeVisible();
  await expect(taskBListbox.getByRole('option', { name: 'other-task.md' })).toHaveCount(0);
  await taskBListbox.getByRole('option', { name: 'current-task.md' }).click();
  await expect(taskBComposer).toHaveValue('B @current-task.md ');

  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    taskId: 'task-matrix-b',
    text: 'B @current-task.md',
    llmText: 'B @../current-task.md',
  });

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
});

/**
 * S04 T04 final integrated file mention flow.
 * End-to-end user journey with real typing + mouse/keyboard activation across
 * @ / @../ / @../../, nested refinement, stale rejection, dual text/llmText,
 * task focus changes, Add Context + file-drop regressions, normal send,
 * queued follow-up, and live-input preservation.
 * Playwright browser proof only — native Extension Development Host remains
 * ENVIRONMENT BLOCKED (see docs/uat/m011-s04/file-mention-autocomplete-live-host-evidence.md).
 */
test('final integrated file mention flow', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/status of 403|Failed to load resource/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    if (/403|ERR_ABORTED|net::ERR/i.test(failure) || /403/.test(req.url())) return;
    failedRequests.push(`${req.method()} ${req.url()} ${failure}`);
  });

  await openWebview(page);

  // ── @ current: mouse select + dual text/llmText ──────────────────────────
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 90 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const draftComposer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await draftComposer.click();
  await draftComposer.pressSequentially('Final @re', { delay: 15 });

  const depth0Before = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(depth0Before)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth0Request = (await postedMessages(page))
    .slice(depth0Before)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(depth0Request.parentDepth).toBe(0);
  expect(depth0Request.relativeQuery).toBe('re');

  // Stale prior-query response must not paint.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: 'stale-final-prior',
    parentDepth: 0,
    relativeQuery: 'old',
    items: [
      {
        id: 'file:stale-final.md',
        kind: 'file',
        label: 'stale-final.md',
        insertionPath: 'stale-final.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth0Request.requestId,
    parentDepth: 0,
    relativeQuery: 're',
    items: [
      {
        id: 'file:readme.md',
        kind: 'file',
        label: 'readme.md',
        insertionPath: 'docs/readme.md',
      },
      {
        id: 'dir:reports',
        kind: 'directory',
        label: 'reports',
        insertionPath: 'reports',
      },
    ],
  });

  const depth0Listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(depth0Listbox).toBeVisible();
  await expect(depth0Listbox.getByRole('option', { name: 'stale-final.md' })).toHaveCount(0);
  await depth0Listbox.getByRole('option', { name: 'readme.md' }).click();
  await expect(depth0Listbox).toHaveCount(0);
  await expect(draftComposer).toHaveValue('Final @readme.md ');

  // ── Add Context regression (picker + display mention) ────────────────────
  const addContextButton = page.getByRole('button', { name: 'Add Context' });
  await addContextButton.click();
  const menu = page.getByRole('menu', { name: 'Add Context' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Add file' }).click();
  await expectPostedMessage(page, { type: 'pickFile' });
  await postRawHostMessage(page, {
    type: 'filePicked',
    path: 'src/extension.ts',
    displayName: 'extension.ts',
  });
  await expect(draftComposer).toHaveValue('Final @readme.md @extension.ts ');

  // Normal send preserves dual text/llmText for autocomplete + picker mentions.
  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Final @readme.md @extension.ts',
    llmText: 'Final @docs/readme.md @src/extension.ts',
    backend: 'claude',
  });

  // ── @../ parent: nested directory refinement + keyboard accept ───────────
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 91 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const parentComposer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await parentComposer.click();
  await parentComposer.pressSequentially('Parent @../', { delay: 15 });

  const depth1Before = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(depth1Before)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth1Request = (await postedMessages(page))
    .slice(depth1Before)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(depth1Request.parentDepth).toBe(1);
  expect(depth1Request.relativeQuery).toBe('');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth1Request.requestId,
    parentDepth: 1,
    relativeQuery: '',
    items: [
      {
        id: 'dir:../packages',
        kind: 'directory',
        label: 'packages',
        insertionPath: '../packages',
      },
      {
        id: 'file:../root.md',
        kind: 'file',
        label: 'root.md',
        insertionPath: '../root.md',
      },
    ],
  });

  const parentListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(parentListbox).toBeVisible();
  const beforeDrill = (await postedMessages(page)).length;
  await parentListbox.getByRole('option', { name: 'packages/' }).click();
  await expect(parentComposer).toHaveValue('Parent @../packages/');

  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(beforeDrill)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const drillRequest = (await postedMessages(page))
    .slice(beforeDrill)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(drillRequest.parentDepth).toBe(1);
  expect(drillRequest.relativeQuery).toBe('packages/');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: drillRequest.requestId,
    parentDepth: 1,
    relativeQuery: 'packages/',
    items: [
      {
        id: 'file:../packages/helper.ts',
        kind: 'file',
        label: 'helper.ts',
        insertionPath: '../packages/helper.ts',
      },
      {
        id: 'file:../packages/index.ts',
        kind: 'file',
        label: 'index.ts',
        insertionPath: '../packages/index.ts',
      },
    ],
  });

  const drillListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(drillListbox).toBeVisible();
  // Keyboard: ArrowDown then Enter (second option).
  await parentComposer.press('ArrowDown');
  await expect(parentComposer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
  await parentComposer.press('Enter');
  await expect(drillListbox).toHaveCount(0);
  await expect(parentComposer).toHaveValue('Parent @index.ts ');

  // ── File-drop regression mid-draft ───────────────────────────────────────
  const shell = page.locator('.composer-shell');
  await dispatchFileDrag(page, 'dragover', 'text/uri-list', 'file:///workspace/docs/drop-me.md');
  await expect(shell).toHaveClass(/composer-shell--dragging/);
  await dispatchFileDrag(page, 'drop', 'text/uri-list', 'file:///workspace/docs/drop-me.md');
  await expectPostedMessage(page, {
    type: 'resolveFileDrop',
    candidates: ['file:///workspace/docs/drop-me.md'],
  });
  await postRawHostMessage(page, {
    type: 'filePicked',
    path: 'docs/drop-me.md',
    displayName: 'drop-me.md',
  });
  await expect(parentComposer).toHaveValue('Parent @index.ts @drop-me.md ');
  await expect(shell).not.toHaveClass(/composer-shell--dragging/);

  await page.getByRole('button', { name: 'Send' }).click();
  await expectPostedMessage(page, {
    type: 'send',
    text: 'Parent @index.ts @drop-me.md',
    llmText: 'Parent @../packages/index.ts @docs/drop-me.md',
    backend: 'claude',
  });

  // ── @../../ grandparent + task focus change ──────────────────────────────
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({ id: 'task-final-a', goal: 'Final task A', viewStatus: 'idle' }),
      task({ id: 'task-final-b', goal: 'Final task B', viewStatus: 'idle' }),
    ],
    focusedTaskId: 'task-final-a',
    subtree: [task({ id: 'task-final-a', goal: 'Final task A', viewStatus: 'idle' })],
    transcript: [{ id: 'msg-final-a', kind: 'assistant', content: 'Final A ready.' }],
    storeRevision: 92,
  });

  await expect(page.getByText('Final A ready.')).toBeVisible();
  const taskAComposer = page.getByPlaceholder('Message this task…');
  await expect(taskAComposer).toBeEnabled();
  await taskAComposer.click();
  await taskAComposer.pressSequentially('A @../../', { delay: 15 });

  const depth2Before = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(depth2Before)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const depth2Request = (await postedMessages(page))
    .slice(depth2Before)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    parentDepth: number;
    taskId?: string;
  };
  expect(depth2Request.parentDepth).toBe(2);
  expect(depth2Request.taskId).toBe('task-final-a');

  // Switch focus before late A response arrives — must not paint on B.
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({ id: 'task-final-a', goal: 'Final task A', viewStatus: 'idle' }),
      task({ id: 'task-final-b', goal: 'Final task B', viewStatus: 'idle' }),
    ],
    focusedTaskId: 'task-final-b',
    subtree: [task({ id: 'task-final-b', goal: 'Final task B', viewStatus: 'idle' })],
    transcript: [{ id: 'msg-final-b', kind: 'assistant', content: 'Final B ready.' }],
    storeRevision: 93,
  });

  await expect(page.getByText('Final B ready.')).toBeVisible();
  const taskBComposer = page.getByPlaceholder('Message this task…');
  await expect(taskBComposer).toBeEnabled();
  await taskBComposer.fill('');
  await taskBComposer.click();
  await taskBComposer.pressSequentially('B @../../', { delay: 15 });

  const taskBBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(taskBBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const taskBRequest = (await postedMessages(page))
    .slice(taskBBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    taskId?: string;
    parentDepth: number;
  };
  expect(taskBRequest.taskId).toBe('task-final-b');
  expect(taskBRequest.parentDepth).toBe(2);
  expect(taskBRequest.requestId).not.toBe(depth2Request.requestId);

  // Late response for task A must not paint on task B.
  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: depth2Request.requestId,
    parentDepth: 2,
    relativeQuery: '',
    items: [
      {
        id: 'file:../../other-top.md',
        kind: 'file',
        label: 'other-top.md',
        insertionPath: '../../other-top.md',
      },
    ],
  });
  await expect(page.getByRole('listbox', { name: 'File mention suggestions' })).toHaveCount(0);
  await expect(taskBComposer).toHaveValue('B @../../');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: taskBRequest.requestId,
    parentDepth: 2,
    relativeQuery: '',
    items: [
      {
        id: 'file:../../top.md',
        kind: 'file',
        label: 'top.md',
        insertionPath: '../../top.md',
      },
    ],
  });

  const taskBListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(taskBListbox).toBeVisible();
  await expect(taskBListbox.getByRole('option', { name: 'other-top.md' })).toHaveCount(0);
  await taskBListbox.getByRole('option', { name: 'top.md' }).click();
  await expect(taskBComposer).toHaveValue('B @top.md ');

  // Normal Enter send on idle task.
  await taskBComposer.press('Enter');
  await expectPostedMessage(page, {
    type: 'send',
    taskId: 'task-final-b',
    text: 'B @top.md',
    llmText: 'B @../../top.md',
  });
  await expect(taskBComposer).toHaveValue('');

  // ── Queued follow-up + live-input preservation while running ─────────────
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [task({ id: 'task-final-live', goal: 'Final live work', viewStatus: 'running' })],
    focusedTaskId: 'task-final-live',
    subtree: [task({ id: 'task-final-live', goal: 'Final live work', viewStatus: 'running' })],
    transcript: [{ id: 'msg-final-live', kind: 'assistant', content: 'Still working…' }],
    activeTurnId: 'turn-final-live',
    storeRevision: 94,
  });

  await expect(page.locator('[data-turn-activity="executing"]')).toBeVisible();
  const liveComposer = page.getByPlaceholder(/Enter queues a follow-up/i);
  await expect(liveComposer).toBeEnabled();
  await expect(page.getByTestId('composer-live-inject')).toBeVisible();

  // Autocomplete still works while a turn is running.
  await liveComposer.click();
  await liveComposer.pressSequentially('Queue @li', { delay: 15 });
  const liveMentionBefore = (await postedMessages(page)).length;
  await expect
    .poll(async () => {
      const messages = await postedMessages(page);
      return messages
        .slice(liveMentionBefore)
        .filter((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions');
    })
    .not.toHaveLength(0);

  const liveMentionRequest = (await postedMessages(page))
    .slice(liveMentionBefore)
    .find((m) => (m as { type?: string }).type === 'requestFileMentionSuggestions') as {
    requestId: string;
    taskId?: string;
    parentDepth: number;
    relativeQuery: string;
  };
  expect(liveMentionRequest.taskId).toBe('task-final-live');
  expect(liveMentionRequest.parentDepth).toBe(0);
  expect(liveMentionRequest.relativeQuery).toBe('li');

  await postRawHostMessage(page, {
    type: 'fileMentionSuggestions',
    requestId: liveMentionRequest.requestId,
    parentDepth: 0,
    relativeQuery: 'li',
    items: [
      {
        id: 'file:live.ts',
        kind: 'file',
        label: 'live.ts',
        insertionPath: 'src/live.ts',
      },
    ],
  });

  const liveListbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(liveListbox).toBeVisible();
  await liveListbox.getByRole('option', { name: 'live.ts' }).click();
  await expect(liveComposer).toHaveValue('Queue @live.ts ');

  // Enter queues a follow-up (not live inject) while running.
  await liveComposer.press('Enter');
  await expectPostedMessage(page, {
    type: 'send',
    taskId: 'task-final-live',
    text: 'Queue @live.ts',
    llmText: 'Queue @src/live.ts',
  });
  await expect(liveComposer).toHaveValue('');
  expect(
    (await postedMessages(page)).filter((m) => (m as { type?: string }).type === 'sendLiveInput'),
  ).toHaveLength(0);

  // Ctrl+Enter posts sendLiveInput only (live-input path preserved).
  await liveComposer.fill('Inject now');
  await liveComposer.press('Control+Enter');
  await expectPostedMessage(page, {
    type: 'sendLiveInput',
    taskId: 'task-final-live',
    instruction: 'Inject now',
  });
  await expect(liveComposer).toHaveValue('');
  expect(
    (await postedMessages(page)).filter(
      (m) =>
        (m as { type?: string; text?: string }).type === 'send' &&
        (m as { text?: string }).text === 'Inject now',
    ),
  ).toHaveLength(0);

  // Live-input delivery notice remains task-scoped success chrome.
  await postRawHostMessage(page, {
    type: 'liveInputResult',
    taskId: 'task-final-live',
    code: 'delivered',
    sessionId: 'sess-final',
  });
  const notice = page.locator('.task-command-notice');
  await expect(notice).toBeVisible();
  await expect(
    notice.getByText('Live input delivered to the active session.', { exact: true }),
  ).toBeVisible();

  // Browser diagnostics must stay clean for the assembled journey.
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);

  // Native Extension Development Host: ENVIRONMENT BLOCKED in this harness
  // (no desktop UI control surface). Playwright is never promoted to live host proof.
});

test('Add Context menu keeps the existing file picker and mention flow', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 2,
    });

    await page.getByRole('button', { name: 'New task' }).first().click();
    await expectPostedMessage(page, { type: 'newTask' });

    const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
    await composer.fill('Review this');

    const addContextButton = page.getByRole('button', { name: 'Add Context' });
    await expect(addContextButton).toHaveAttribute('aria-expanded', 'false');
    await addContextButton.click();

    const menu = page.getByRole('menu', { name: 'Add Context' });
    await expect(menu).toBeVisible();
    await expect(addContextButton).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitem', { name: 'Add file' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Browse workspace files' })).toBeVisible();
    expect(await postedMessages(page)).not.toContainEqual({ type: 'pickFile' });

    await menu.getByRole('menuitem', { name: 'Add file' }).click();
    await expectPostedMessage(page, { type: 'pickFile' });
    await expect(menu).toHaveCount(0);

    await postRawHostMessage(page, { type: 'filePicked', path: 'src/extension.ts', displayName: 'extension.ts' });
    await expect(composer).toHaveValue('Review this @extension.ts ');

    await composer.fill('Review @src/extension.ts');
    await page.getByRole('button', { name: 'Send' }).click();
    await expectPostedMessage(page, {
      type: 'send',
      text: 'Review @src/extension.ts',
      backend: 'claude',
    });
  });

  test('inserts picked files at the caret and preserves surrounding draft text', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 2 });
    await page.getByRole('button', { name: 'New task' }).first().click();

    const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
    await composer.fill('Review before after');
    await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
    // UI inserts display basename only; full path is bound for expand-on-send.
    await postRawHostMessage(page, { type: 'filePicked', path: 'docs/my file.md', displayName: 'my file.md' });

    await expect(composer).toHaveValue('Review @"my file.md" before after');
    await expect(composer).toBeFocused();
    // "Review " = 7, + @"my file.md" = 13, + trailing space = 21 → caret at 7+13+1 = 21
    await expect.poll(() => composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(21);
  });

  test('drops a file through the host contract and projects sanitized failures without changing the draft', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 2 });
    await page.getByRole('button', { name: 'New task' }).first().click();

    const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
    const shell = page.locator('.composer-shell');
    await composer.fill('Use this');
    await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));

    await dispatchFileDrag(page, 'dragover', 'text/uri-list', 'file:///workspace/docs/my%20file.md');
    await expect(shell).toHaveClass(/composer-shell--dragging/);
    await expect(page.getByRole('status').getByText('Drop file to mention it')).toBeVisible();
    await dispatchFileDrag(page, 'drop', 'text/uri-list', 'file:///workspace/docs/my%20file.md');
    await expectPostedMessage(page, { type: 'resolveFileDrop', candidates: ['file:///workspace/docs/my%20file.md'] });
    await expect(shell).not.toHaveClass(/composer-shell--dragging/);

    await postRawHostMessage(page, { type: 'filePicked', path: 'docs/my file.md', displayName: 'my file.md' });
    await expect(composer).toHaveValue('Use @"my file.md" this');

    // VS Code Explorer uses resourceurls JSON, not text/uri-list.
    await composer.fill('Explorer ');
    await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(9, 9));
    await dispatchFileDragMulti(page, 'dragover', [
      { mime: 'resourceurls', value: JSON.stringify(['file:///workspace/src/extension.ts']) },
    ]);
    await expect(page.getByRole('status').getByText(/Hold Shift and drop/i)).toBeVisible();
    await dispatchFileDragMulti(page, 'drop', [
      { mime: 'resourceurls', value: JSON.stringify(['file:///workspace/src/extension.ts']) },
    ]);
    await expectPostedMessage(page, {
      type: 'resolveFileDrop',
      candidates: ['file:///workspace/src/extension.ts'],
    });
    await postRawHostMessage(page, { type: 'filePicked', path: 'src/extension.ts', displayName: 'extension.ts' });
    await expect(composer).toHaveValue('Explorer @extension.ts ');

    await composer.fill('Keep draft');
    await dispatchFileDrag(page, 'dragover', 'text/plain', 'outside.txt');
    await dispatchFileDrag(page, 'drop', 'text/plain', 'outside.txt');
    await postCommandError(page, { type: 'commandError', message: 'Drop a file from the current workspace.' });
    await expect(page.getByText('Drop a file from the current workspace.')).toBeVisible();
    await expect(composer).toHaveValue('Keep draft');
    await expect(shell).not.toHaveClass(/composer-shell--dragging/);
  });

  test('ignores file drops while the composer is disabled', async ({ page }) => {
    await openWebview(page);
    // Running no longer disables free-form send (FIFO + live inject). Use a true
    // blocking activity so drop handling stays gated by canSend.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ viewStatus: 'waiting_user' })],
      focusedTaskId: 'task-root',
      subtree: [task({ viewStatus: 'waiting_user' })],
      activeTurnId: 'turn-waiting',
      storeRevision: 3,
    });
    const shell = page.locator('.composer-shell');
    const before = await postedMessages(page);
    await dispatchFileDrag(page, 'dragover', 'text/plain', 'src/a.ts');
    await dispatchFileDrag(page, 'drop', 'text/plain', 'src/a.ts');
    await expect(shell).not.toHaveClass(/composer-shell--dragging/);
    expect(await postedMessages(page)).toEqual(before);
  });

  test('Add Context menu browses workspace files through the shared filePicked mention flow', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 2,
    });

    await page.getByRole('button', { name: 'New task' }).first().click();
    await expectPostedMessage(page, { type: 'newTask' });

    const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
    await composer.fill('Inspect');

    const addContextButton = page.getByRole('button', { name: 'Add Context' });
    await addContextButton.click();
    const menu = page.getByRole('menu', { name: 'Add Context' });
    await menu.getByRole('menuitem', { name: 'Browse workspace files' }).click();

    await expectPostedMessage(page, { type: 'browseWorkspaceFiles' });
    await expect(menu).toHaveCount(0);
    await expect(addContextButton).toHaveAttribute('aria-expanded', 'false');
    await expect(composer).toHaveValue('Inspect');

    await postRawHostMessage(page, {
      type: 'filePicked',
      path: 'src/host/workspace-files.ts',
      displayName: 'workspace-files.ts',
    });
    await expect(composer).toHaveValue('Inspect @workspace-files.ts ');
  });

  test('Add Context menu renders future model actions as disabled coming-soon entries', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 2,
    });

    await page.getByRole('button', { name: 'New task' }).first().click();
    await expectPostedMessage(page, { type: 'newTask' });

    const addContextButton = page.getByRole('button', { name: 'Add Context' });
    await addContextButton.click();
    const menu = page.getByRole('menu', { name: 'Add Context' });
    await expect(menu).toBeVisible();

    for (const label of ['Skill', 'Wiki page', 'Agent', 'Browser tab', 'Web search']) {
      const item = menu.getByRole('menuitem', { name: label });
      await expect(item).toBeVisible();
      await expect(item).toBeDisabled();
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item.locator('.add-context__menu-item-badge')).toHaveText('Coming soon');
    }

    await menu.getByRole('menuitem', { name: 'Skill' }).click({ force: true });
    expect(await postedMessages(page)).not.toContainEqual({ type: 'pickFile' });
    expect(await postedMessages(page)).not.toContainEqual({ type: 'browseWorkspaceFiles' });
    await expect(menu).toBeVisible();
    await expect(addContextButton).toHaveAttribute('aria-expanded', 'true');
  });

  test('Add Context menu hardens dismissal states without losing draft text', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 2,
    });

    await page.getByRole('button', { name: 'New task' }).first().click();
    await expectPostedMessage(page, { type: 'newTask' });

    const composer = page.getByRole('textbox').first();
    const addContextButton = page.getByRole('button', { name: 'Add Context' });
    const menu = page.getByRole('menu', { name: 'Add Context' });

    await composer.fill('Keep this draft');
    await addContextButton.click();
    await expect(menu).toBeVisible();
    await composer.click();
    await expect(menu).toHaveCount(0);
    await expect(addContextButton).toHaveAttribute('aria-expanded', 'false');
    await expect(composer).toHaveValue('Keep this draft');

    await addContextButton.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveValue('Keep this draft');

    await addContextButton.click();
    await expect(menu).toBeVisible();
    await addContextButton.click();
    await expect(menu).toHaveCount(0);

    await addContextButton.click();
    await expect(menu).toBeVisible();
    // Hard-terminal tasks stay writable for same-id reopen (send reopens).
    // Menu closes on snapshot focus change; Add Context remains enabled.
    // Running composer unlock is covered by queue/inject tests.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 'task-succeeded',
          goal: 'Run active work',
          viewStatus: 'succeeded',
          lifecycle: 'succeeded',
        }),
      ],
      focusedTaskId: 'task-succeeded',
      subtree: [
        task({
          id: 'task-succeeded',
          goal: 'Run active work',
          viewStatus: 'succeeded',
          lifecycle: 'succeeded',
        }),
      ],
      storeRevision: 3,
    });
    await expect(menu).toHaveCount(0);
    await expect(addContextButton).toBeEnabled();
    await expect(addContextButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('textbox').first()).toBeEnabled();
  });

  test('surfaces task-centric status feedback for active and failed tasks', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({ id: 'task-running', goal: 'Run the model evaluation', viewStatus: 'running' }),
        task({ id: 'task-recovery', goal: 'Recover failed analysis', viewStatus: 'needs_recovery' }),
        task({
          id: 'task-cancelled',
          goal: 'Cancelled rollout',
          viewStatus: 'cancelled',
          lifecycle: 'cancelled',
        }),
      ],
      focusedTaskId: 'task-running',
      subtree: [task({ id: 'task-running', goal: 'Run the model evaluation', viewStatus: 'running' })],
      transcript: [{ id: 'msg-1', kind: 'assistant', content: 'Evaluation started.' }],
      activeTurnId: 'turn-running',
      storeRevision: 3,
    });

    await expect(page.locator('.task-workspace-banner').getByText('Run the model evaluation')).toBeVisible();
    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Open/i })).toBeVisible();
    await expect(page.locator('[data-turn-activity="executing"]').getByText(/Working/i)).toBeVisible();
    await page.getByRole('button', { name: 'History (previous coordinator tasks)' }).click();
    await expect(page.getByRole('button', { name: /Run the model evaluation.*Task Open.*Turn working.*Backend claude/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Recover failed analysis.*Task Open.*Backend claude/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancelled rollout.*Task Cancelled.*Backend claude/i })).toBeVisible();
    await page.getByRole('button', { name: 'Close history' }).click();
    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Open/i })).toBeVisible();
    await expect(page.locator('[data-turn-activity="executing"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop this turn' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop this turn' }).click();
    await expectPostedMessage(page, {
      type: 'cancelTurn',
      taskId: 'task-running',
      turnId: 'turn-running',
    });

    if ((await page.getByRole('button', { name: /Recover failed analysis.*Task Open.*Backend claude/i }).count()) === 0) {
      await page.getByRole('button', { name: 'History (previous coordinator tasks)' }).click();
    }
    await page.getByRole('button', { name: /Recover failed analysis.*Task Open.*Backend claude/i }).click();
    await expectPostedMessage(page, { type: 'focusTask', taskId: 'task-recovery' });
    await expectPostedMessage(page, { type: 'hydrateSubtree', taskId: 'task-recovery' });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-recovery', goal: 'Recover failed analysis', viewStatus: 'needs_recovery' })],
      focusedTaskId: 'task-recovery',
      subtree: [task({ id: 'task-recovery', goal: 'Recover failed analysis', viewStatus: 'needs_recovery' })],
      transcript: [{ id: 'msg-2', kind: 'error', content: { message: 'Agent process exited.' } }],
      storeRevision: 4,
    });

    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Open/i })).toBeVisible();
    await expect(page.locator('.turn-activity-bar[data-turn-activity="failed_turn"]')).toBeVisible();
    await expect(page.locator('.task-action-panel--danger').getByText(/^Could not finish$/)).toBeVisible();
    // Host currentTurnActivity carries turnId even without activeTurnId projection.
    await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
    await page.getByPlaceholder('What should the agent do differently?').fill('Use a smaller batch and retry.');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectPostedMessage(page, {
      type: 'retryTurn',
      taskId: 'task-recovery',
      turnId: 'turn-fixture',
      instruction: 'Use a smaller batch and retry.',
    });

    await page.getByPlaceholder('Message to queue as the next turn...').fill('Continue after documenting the failure.');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expectPostedMessage(page, {
      type: 'continueTask',
      taskId: 'task-recovery',
      instruction: 'Continue after documenting the failure.',
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 'task-cancelled',
          goal: 'Cancelled rollout',
          viewStatus: 'cancelled',
          lifecycle: 'cancelled',
        }),
      ],
      focusedTaskId: 'task-cancelled',
      subtree: [
        task({
          id: 'task-cancelled',
          goal: 'Cancelled rollout',
          viewStatus: 'cancelled',
          lifecycle: 'cancelled',
        }),
      ],
      transcript: [],
      storeRevision: 42,
    });

    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Cancelled/i })).toBeVisible();
    await expect(page.locator('.task-action-panel--warning').getByText(/This task is cancelled/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
    // Single warning (panel + Reopen only) — no duplicate under the composer.
    await expect(page.locator('.composer-guidance')).toHaveCount(0);
    // Composer stays enabled — warning only (native layered textarea).
    await expect(page.locator('.composer-input__textarea')).toBeEnabled();
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expectPostedMessage(page, {
      type: 'setTaskLifecycle',
      taskId: 'task-cancelled',
      lifecycle: 'open',
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-queued', goal: 'Queued follow-up', viewStatus: 'queued' })],
      focusedTaskId: 'task-queued',
      subtree: [task({ id: 'task-queued', goal: 'Queued follow-up', viewStatus: 'queued' })],
      transcript: [],
      activeTurnId: 'turn-queued',
      storeRevision: 46,
    });

    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Open/i })).toBeVisible();
    await page.locator('.task-workspace-banner').getByRole('button', { name: /Expand task details/i }).click();
    await expect(page.locator('.task-workspace-orchestration').getByText(/Queued/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume queued task' })).toBeVisible();
    // Live/queued composers stay editable with queue-oriented guidance (not a hard disable).
    await expect(
      page.locator('.composer-guidance').getByText(/Enter queues another follow-up/i),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Resume queued task' }).click();
    await expectPostedMessage(page, {
      type: 'resumeQueuedTurn',
      taskId: 'task-queued',
      turnId: 'turn-queued',
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-failed', goal: 'Failed rollout', viewStatus: 'failed', lifecycle: 'failed', runtimeActivity: null })],
      focusedTaskId: 'task-failed',
      subtree: [task({ id: 'task-failed', goal: 'Failed rollout', viewStatus: 'failed', lifecycle: 'failed', runtimeActivity: null })],
      transcript: [{ id: 'msg-3', kind: 'error', content: 'Build failed.' }],
      storeRevision: 47,
    });

    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Failed/i })).toBeVisible();
    // Soft failed: reopen via send or Reopen on the same task id.
    await page.locator('.task-workspace-banner').getByRole('button', { name: /Expand task details/i }).click();
    await expect(page.getByText(/This task is failed/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue as new task' })).toHaveCount(0);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-succeeded', goal: 'Ship status UI', viewStatus: 'succeeded', lifecycle: 'succeeded' })],
      focusedTaskId: 'task-succeeded',
      subtree: [task({ id: 'task-succeeded', goal: 'Ship status UI', viewStatus: 'succeeded', lifecycle: 'succeeded' })],
      transcript: [{ id: 'msg-4', kind: 'assistant', content: 'Done.' }],
      storeRevision: 48,
    });

    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Succeeded/i })).toBeVisible();
    await expect(page.locator('.task-action-panel--warning').getByText(/This task is succeeded/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();

    await postCommandError(page, {
      type: 'commandError',
      taskId: 'other-task',
      message: 'Error for another task.',
    });
    await expect(page.getByRole('alert')).toHaveCount(0);

    await postRawHostMessage(page, {
      type: 'commandError',
      taskId: 'task-succeeded',
      message: 500,
    });
    await expect(page.getByRole('alert')).toHaveCount(0);

    await postCommandError(page, {
      type: 'commandError',
      taskId: 'task-succeeded',
      message: 'Resume command rejected by host.',
    });

    await expect(page.getByRole('alert').getByText('Task command failed')).toBeVisible();
    await expect(page.getByRole('alert').getByText('Resume command rejected by host.')).toBeVisible();

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-idle', goal: 'Idle task', viewStatus: 'idle' })],
      focusedTaskId: 'task-idle',
      subtree: [task({ id: 'task-idle', goal: 'Idle task', viewStatus: 'idle' })],
      transcript: [],
      storeRevision: 49,
    });
    await expect(page.getByRole('alert')).toHaveCount(0);

    await postCommandError(page, {
      type: 'commandError',
      message: 'Global command rejected by host.',
    });
    await expect(page.getByRole('alert').getByText('Global command rejected by host.')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('blocks the composer while a pending task ask is visible', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-waiting', goal: 'Answer model question', viewStatus: 'waiting_user' })],
      focusedTaskId: 'task-waiting',
      subtree: [task({ id: 'task-waiting', goal: 'Answer model question', viewStatus: 'waiting_user' })],
      transcript: [],
      activeTurnId: 'turn-waiting',
      pendingAsk: {
        turnId: 'turn-waiting',
        askId: 'ask-1',
        questions: [{ prompt: 'Which model should continue?', options: ['Claude', 'Codex'], allowFreeText: false }],
      },
      storeRevision: 1,
    });

    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Open/i })).toBeVisible();
    // Structured ask: turn waiting for user.
    await expect(page.locator('[data-turn-activity="waiting_you"]').getByText(/Waiting for you/i)).toBeVisible();
    await expect(page.getByText('Agent question')).toBeVisible();
    await expect(page.getByText('Which model should continue?')).toBeVisible();
    await expect(page.locator('.composer-guidance').getByText('Answer above to continue.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    // Live turn still open — Stop this turn remains available.
    await expect(page.getByRole('button', { name: 'Stop this turn' })).toBeVisible();
    await page.locator('vscode-radio').filter({ hasText: 'Claude' }).click();
    await page.getByRole('button', { name: 'Accept' }).click();
    await expectPostedMessage(page, {
      type: 'submitAsk',
      taskId: 'task-waiting',
      turnId: 'turn-waiting',
      askId: 'ask-1',
      answers: {
        '0': { selected: ['Claude'], freeText: null },
      },
    });
    await postRawHostMessage(page, {
      type: 'askSubmissionResult',
      taskId: 'task-waiting',
      turnId: 'turn-waiting',
      askId: 'ask-1',
      ok: false,
      message: 'turn is not waiting for user',
    });
    await expect(page.getByRole('alert').getByText('turn is not waiting for user')).toBeVisible();
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(async () =>
      (await postedMessages(page)).filter((message) =>
        (message as { type?: string }).type === 'submitAsk',
      ),
    ).toHaveLength(2);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-waiting', goal: 'Answer model question', viewStatus: 'waiting_user' })],
      focusedTaskId: 'task-waiting',
      subtree: [task({ id: 'task-waiting', goal: 'Answer model question', viewStatus: 'waiting_user' })],
      transcript: [],
      activeTurnId: 'turn-waiting',
      storeRevision: 2,
    });

    await expect(page.getByText('Agent question')).toHaveCount(0);
    // waiting_user without pending card: still Waiting for you.
    await expect(page.locator('[data-turn-activity="waiting_you"]').getByText(/Waiting for you/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop this turn' })).toBeVisible();
  });

  test('RFD form shows validation errors and unlocks after host rejection', async ({ page }) => {
    await openWebview(page);
    await postRawHostMessage(page, {
      type: 'elicitationFormPending',
      promptId: 'elicitation-1',
      message: 'Choose a deployment target',
      fields: [{ key: 'targets', type: 'multiEnum', title: 'Targets', options: ['Staging', 'Production'], required: true }],
      required: ['targets'],
      askLike: true,
    });

    await page.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByRole('alert').getByText('Targets is required.')).toBeVisible();
    expect(
      (await postedMessages(page)).filter((message) =>
        (message as { type?: string }).type === 'submitElicitation',
      ),
    ).toHaveLength(0);

    await page.getByRole('checkbox', { name: 'Staging' }).click();
    await page.getByRole('checkbox', { name: 'Production' }).click();
    await page.getByRole('button', { name: 'Accept' }).click();
    await expectPostedMessage(page, {
      type: 'submitElicitation',
      promptId: 'elicitation-1',
      action: 'accept',
      content: { targets: ['Staging', 'Production'] },
    });

    await postRawHostMessage(page, {
      type: 'elicitationSubmissionResult',
      promptId: 'elicitation-1',
      ok: false,
      message: 'no matching pending elicitation',
    });
    await expect(page.getByRole('alert').getByText('no matching pending elicitation')).toBeVisible();
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(async () =>
      (await postedMessages(page)).filter((message) =>
        (message as { type?: string }).type === 'submitElicitation',
      ),
    ).toHaveLength(2);
  });

  test('RFD URL consent unlocks after host rejection', async ({ page }) => {
    await openWebview(page);
    await postRawHostMessage(page, {
      type: 'elicitationUrlPending',
      promptId: 'elicitation-url-1',
      elicitationId: 'oauth-1',
      url: 'https://example.com/authorize',
      message: 'Authorize the CLI',
    });

    await page.getByRole('button', { name: 'Open & continue' }).click();
    await expectPostedMessage(page, {
      type: 'submitElicitation',
      promptId: 'elicitation-url-1',
      action: 'accept',
    });

    await postRawHostMessage(page, {
      type: 'elicitationSubmissionResult',
      promptId: 'elicitation-url-1',
      ok: false,
      message: 'no matching pending elicitation',
    });
    await expect(page.getByRole('alert').getByText('no matching pending elicitation')).toBeVisible();
    await page.getByRole('button', { name: 'Open & continue' }).click();
    await expect.poll(async () =>
      (await postedMessages(page)).filter((message) =>
        (message as { type?: string }).type === 'submitElicitation',
      ),
    ).toHaveLength(2);
  });

  test('Settings panel edits host-backed retention values without losing task or chat state', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-settings', goal: 'Keep chat state visible', viewStatus: 'idle' })],
      storeRevision: 10,
    });

    await expect(page.getByPlaceholder('Search tasks…')).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Retention keeps recent task history usable without storing unlimited completed-turn output.')).toBeVisible();
    await expect(page.getByRole('status').getByText('Loading retention settings from VS Code…')).toBeVisible();
    // Full-view Settings replaces the task list (not an overlay).
    await expect(page.getByPlaceholder('Search tasks…')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Back to tasks' })).toBeVisible();

    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: {
        settings: [
          {
            id: 'maxTurnsPerTask',
            label: 'Max turns per task',
            description: 'Controls how many settled turns are retained for each terminal task.',
            value: 200,
            defaultValue: 200,
            minimum: 1,
          },
          {
            id: 'maxStoredOutputChars',
            label: 'Max stored output characters',
            description: 'Limits retained assistant output for settled turns on open tasks.',
            value: 200000,
            defaultValue: 200000,
            minimum: 1024,
          },
        ],
      },
    });

    // Once the snapshot loads, the loading status is replaced by the editable fields.
    await expect(page.getByText('Loading retention settings from VS Code…')).toHaveCount(0);
    await expect(page.getByRole('spinbutton', { name: 'Maximum turns per task', exact: true })).toHaveValue('200');
    await expect(page.getByRole('spinbutton', { name: 'Maximum stored output characters', exact: true })).toHaveValue('200000');
    await expect(page.getByText('Min 1 · Default 200')).toBeVisible();
    await expect(page.getByText('Min 1024 · Default 200000')).toBeVisible();

    await page.getByRole('spinbutton', { name: 'Maximum turns per task', exact: true }).fill('0');
    await page.getByRole('button', { name: 'Save Maximum turns per task' }).click();
    await expect(page.getByRole('alert').getByText('Maximum turns per task must be at least 1.')).toBeVisible();
    await expect.poll(async () => (await postedMessages(page)).filter((message) => (message as { type?: string }).type === 'updateSetting')).toHaveLength(0);

    await page.getByRole('spinbutton', { name: 'Maximum turns per task', exact: true }).fill('201');
    await page.getByRole('button', { name: 'Save Maximum turns per task' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'maxTurnsPerTask', value: 201 });
    await expect(page.getByText('Saving Maximum turns per task…')).toBeVisible();

    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'maxTurnsPerTask', value: 201 },
    });
    await expect(page.getByRole('spinbutton', { name: 'Maximum turns per task', exact: true })).toHaveValue('201');
    await expect(page.getByText('Saved Maximum turns per task.')).toBeVisible();

    await page.getByRole('spinbutton', { name: 'Maximum stored output characters', exact: true }).fill('250000');
    await page.getByRole('button', { name: 'Save Maximum stored output characters' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'maxStoredOutputChars', value: 250000 });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: {
        ok: false,
        settingId: 'maxStoredOutputChars',
        code: 'updateFailed',
        message: 'Error: leaked stack trace from vscode.workspace.getConfiguration().update',
      },
    });
    await expect(page.getByRole('alert').getByText('Settings save failed')).toBeVisible();
    await expect(page.getByRole('alert').getByText('Unable to save Maximum stored output characters. Check the VS Code setting and try again.')).toBeVisible();
    await expect(page.getByText('leaked stack trace')).toHaveCount(0);
    await expect(page.getByRole('spinbutton', { name: 'Maximum stored output characters', exact: true })).toHaveValue('200000');

    await page.setViewportSize({ width: 360, height: 720 });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Maximum stored output characters' })).toBeVisible();
    await expect
      .poll(() =>
        page.locator('.settings-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
      )
      .toBe(true);

    await page.getByRole('button', { name: 'Back to tasks' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Search tasks…')).toBeVisible();

    await page.getByRole('button', { name: /Keep chat state visible.*Task Open.*Backend claude/i }).click();
    await expectPostedMessage(page, { type: 'focusTask', taskId: 'task-settings' });
    await expectPostedMessage(page, { type: 'hydrateSubtree', taskId: 'task-settings' });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-settings', goal: 'Keep chat state visible', viewStatus: 'idle' })],
      focusedTaskId: 'task-settings',
      subtree: [task({ id: 'task-settings', goal: 'Keep chat state visible', viewStatus: 'idle' })],
      transcript: [{ id: 'msg-settings', kind: 'assistant', content: 'Chat context remains visible.' }],
      storeRevision: 11,
    });
    await postCommandError(page, {
      type: 'commandError',
      taskId: 'task-settings',
      message: 'Host command remains visible.',
    });

    await expect(page.getByText('Chat context remains visible.')).toBeVisible();
    await expect(page.getByRole('alert').getByText('Host command remains visible.')).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // Full-view Settings hides chat until Back.
    await expect(page.getByText('Chat context remains visible.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to tasks' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByText('Chat context remains visible.')).toBeVisible();
    await expect(page.getByRole('alert').getByText('Host command remains visible.')).toBeVisible();
  });

  test('Enter queues a FIFO follow-up while running; Ctrl+Enter posts sendLiveInput only', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-live', goal: 'Live turn work', viewStatus: 'running' })],
      focusedTaskId: 'task-live',
      subtree: [task({ id: 'task-live', goal: 'Live turn work', viewStatus: 'running' })],
      transcript: [{ id: 'msg-live', kind: 'assistant', content: 'Working…' }],
      activeTurnId: 'turn-live',
      storeRevision: 100,
    });

    await expect(page.locator('[data-turn-activity="executing"]')).toBeVisible();
    await expect(
      page.locator('.composer-guidance').getByText(/Enter queues a follow-up turn/i),
    ).toBeVisible();
    const liveInject = page.getByTestId('composer-live-inject');
    await expect(liveInject).toBeVisible();
    await expect(liveInject).toHaveAttribute('aria-label', 'Interrupt and send');

    const composer = page.getByPlaceholder(/Enter queues a follow-up/i);
    await expect(composer).toBeEnabled();

    await composer.fill('Queue this follow-up');
    await composer.press('Enter');
    await expectPostedMessage(page, {
      type: 'send',
      taskId: 'task-live',
      text: 'Queue this follow-up',
    });
    await expect(composer).toHaveValue('');

    const afterQueue = await postedMessages(page);
    expect(afterQueue.filter((m) => (m as { type?: string }).type === 'sendLiveInput')).toHaveLength(0);

    await composer.fill('Inject now');
    await composer.press('Control+Enter');
    await expectPostedMessage(page, {
      type: 'sendLiveInput',
      taskId: 'task-live',
      instruction: 'Inject now',
    });
    await expect(composer).toHaveValue('');

    // Ctrl+Enter must never fall through to queue creation.
    const livePosts = (await postedMessages(page)).filter(
      (m) => (m as { type?: string }).type === 'sendLiveInput',
    );
    expect(livePosts).toContainEqual({
      type: 'sendLiveInput',
      taskId: 'task-live',
      instruction: 'Inject now',
    });
    expect(
      (await postedMessages(page)).filter(
        (m) =>
          (m as { type?: string; text?: string }).type === 'send' &&
          (m as { text?: string }).text === 'Inject now',
      ),
    ).toHaveLength(0);

    // Explicit interrupt-and-send control uses the same live-input path.
    await composer.fill('Inject via button');
    await liveInject.click();
    await expectPostedMessage(page, {
      type: 'sendLiveInput',
      taskId: 'task-live',
      instruction: 'Inject via button',
    });
  });

  test('Ctrl+Enter on an idle task posts send (not sendLiveInput)', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-idle', goal: 'Idle work', viewStatus: 'idle' })],
      focusedTaskId: 'task-idle',
      subtree: [task({ id: 'task-idle', goal: 'Idle work', viewStatus: 'idle' })],
      storeRevision: 120,
    });

    const composer = page.getByRole('textbox').first();
    await expect(composer).toBeEnabled();
    await expect(page.getByTestId('composer-live-inject')).toHaveCount(0);

    await composer.fill('Send while idle via chord');
    await composer.press('Control+Enter');
    await expectPostedMessage(page, {
      type: 'send',
      taskId: 'task-idle',
      text: 'Send while idle via chord',
    });
    expect(
      (await postedMessages(page)).filter((m) => (m as { type?: string }).type === 'sendLiveInput'),
    ).toHaveLength(0);
  });

  test('Shift+Enter does not submit while a live turn is running', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-live', goal: 'Live turn work', viewStatus: 'running' })],
      focusedTaskId: 'task-live',
      subtree: [task({ id: 'task-live', goal: 'Live turn work', viewStatus: 'running' })],
      activeTurnId: 'turn-live',
      storeRevision: 101,
    });

    const composer = page.getByPlaceholder(/Enter queues a follow-up/i);
    await composer.fill('Line one');
    await composer.press('Shift+Enter');

    // No host post for Shift+Enter; draft retains content (newline may be inserted by the control).
    expect(
      (await postedMessages(page)).filter((m) =>
        ['send', 'sendLiveInput'].includes((m as { type?: string }).type ?? ''),
      ),
    ).toHaveLength(0);
    await expect.poll(async () => composer.inputValue()).toMatch(/Line one/);
  });

  test('surfaces liveInputResult delivery notice without treating inject unavailability as failure chrome', async ({
    page,
  }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-live', goal: 'Live turn work', viewStatus: 'running' })],
      focusedTaskId: 'task-live',
      subtree: [task({ id: 'task-live', goal: 'Live turn work', viewStatus: 'running' })],
      activeTurnId: 'turn-live',
      storeRevision: 110,
    });

    await postRawHostMessage(page, {
      type: 'liveInputResult',
      taskId: 'task-live',
      code: 'delivered',
      sessionId: 'sess-abc',
    });

    const notice = page.locator('.task-command-notice');
    await expect(notice).toBeVisible();
    // Shared task-scoped notice chrome uses a generic Status title; detail carries the ack.
    await expect(notice.getByText('Status', { exact: true })).toBeVisible();
    await expect(
      notice.getByText('Live input delivered to the active session.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Malformed liveInputResult (missing sessionId) must not invent a banner.
    await postRawHostMessage(page, {
      type: 'liveInputResult',
      taskId: 'task-live',
      code: 'delivered',
    });
    await expect(
      notice.getByText('Live input delivered to the active session.', { exact: true }),
    ).toBeVisible();

    // Capability refusals are no longer red task-command-failed banners (host falls back to send).
    // Unrelated command errors still show when the host posts them for other reasons.
    await postCommandError(page, {
      type: 'commandError',
      taskId: 'task-live',
      message: 'message cannot be empty',
    });
    await expect(page.getByRole('alert').getByText('Task command failed')).toBeVisible();
    await expect(page.getByRole('alert').getByText('message cannot be empty')).toBeVisible();

    // Foreign-task errors stay hidden while focused elsewhere.
    await postCommandError(page, {
      type: 'commandError',
      taskId: 'other-task',
      message: 'Foreign inject refusal.',
    });
    await expect(page.getByRole('alert').getByText('Foreign inject refusal.')).toHaveCount(0);
  });

  test('queuedTurns panel supports edit/delete and shows stale mutation feedback', async ({ page }) => {
    await openWebview(page);

    const queuedMessageId = 'msg-queued-1';
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-queue', goal: 'Queued follow-ups', viewStatus: 'running' })],
      focusedTaskId: 'task-queue',
      subtree: [task({ id: 'task-queue', goal: 'Queued follow-ups', viewStatus: 'running' })],
      // Queued follow-ups must not appear in chat transcript — only in queue panel.
      transcript: [{ id: 'msg-assistant', kind: 'assistant', content: 'Still working…' }],
      activeTurnId: 'turn-active',
      queuedTurns: [
        {
          turnId: 'turn-q1',
          sequence: 1,
          status: 'queued',
          messageIds: [queuedMessageId],
          createdAt: '2026-01-01T00:00:01.000Z',
          previewText: 'First queued follow-up',
        },
      ],
      storeRevision: 120,
    });

    const panel = page.getByTestId('queued-turns-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Queued follow-ups (1)')).toBeVisible();
    await expect(panel.getByText('First queued follow-up')).toBeVisible();
    // Not in the chat thread as a user bubble.
    await expect(page.getByText('First queued follow-up')).toHaveCount(1);

    const item = panel.locator('.queued-turn-item[data-turn-id="turn-q1"]');
    await expect(item).toHaveAttribute('data-queued-locked', 'false');

    // Edit: remove from queue + prefill composer message box for re-send.
    await item.getByRole('button', { name: 'Edit queued turn 1' }).click();
    await expectPostedMessage(page, {
      type: 'deleteQueuedTurn',
      taskId: 'task-queue',
      turnId: 'turn-q1',
    });
    await expect(page.getByTestId('queued-turns-panel')).toHaveCount(0);
    const composer = page.getByRole('textbox').first();
    await expect(composer).toHaveValue('First queued follow-up');

    // Host confirms empty queue.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-queue', goal: 'Queued follow-ups', viewStatus: 'running' })],
      focusedTaskId: 'task-queue',
      subtree: [task({ id: 'task-queue', goal: 'Queued follow-ups', viewStatus: 'running' })],
      transcript: [{ id: 'msg-assistant', kind: 'assistant', content: 'Still working…' }],
      activeTurnId: 'turn-active',
      queuedTurns: [],
      storeRevision: 121,
    });
    await expect(page.getByTestId('queued-turns-panel')).toHaveCount(0);

    // Re-queue a row to exercise Delete.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-queue', goal: 'Queued follow-ups', viewStatus: 'running' })],
      focusedTaskId: 'task-queue',
      subtree: [task({ id: 'task-queue', goal: 'Queued follow-ups', viewStatus: 'running' })],
      transcript: [{ id: 'msg-assistant', kind: 'assistant', content: 'Still working…' }],
      activeTurnId: 'turn-active',
      queuedTurns: [
        {
          turnId: 'turn-q2',
          sequence: 2,
          status: 'queued',
          messageIds: ['msg-queued-2'],
          createdAt: '2026-01-01T00:00:02.000Z',
          previewText: 'Second queued follow-up',
        },
      ],
      storeRevision: 122,
    });
    const item2 = page.locator('.queued-turn-item[data-turn-id="turn-q2"]');
    await item2.getByRole('button', { name: 'Delete queued turn 2' }).click();
    await expectPostedMessage(page, {
      type: 'deleteQueuedTurn',
      taskId: 'task-queue',
      turnId: 'turn-q2',
    });
    await expect(page.getByTestId('queued-turns-panel')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Export task/chat posts exportTask and shows task-scoped success/failure chrome', async ({
    page,
  }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-export', goal: 'Export this task', viewStatus: 'idle' })],
      focusedTaskId: 'task-export',
      subtree: [task({ id: 'task-export', goal: 'Export this task', viewStatus: 'idle' })],
      transcript: [{ id: 'msg-export-1', kind: 'assistant', content: 'Ready to export.' }],
      storeRevision: 201,
    });

    const exportBtn = page.getByTestId('export-task-chat');
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toHaveAttribute('aria-label', 'Export task/chat');

    // Stale failure chrome is cleared when Export is re-triggered.
    await postCommandError(page, {
      type: 'commandError',
      taskId: 'task-export',
      message: 'Previous export failed.',
    });
    await expect(page.getByRole('alert').getByText('Previous export failed.')).toBeVisible();

    await exportBtn.click();
    await expectPostedMessage(page, { type: 'exportTask', taskId: 'task-export' });
    // Click path only posts exportTask with focused taskId — no extra payload fields required by host.
    const exportPosts = (await postedMessages(page)).filter(
      (m) => (m as { type?: string }).type === 'exportTask',
    );
    expect(exportPosts).toEqual([{ type: 'exportTask', taskId: 'task-export' }]);
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Success notice is task-scoped and uses basename + sourceRevision only (no absolute paths).
    await postRawHostMessage(page, {
      type: 'exportResult',
      taskId: 'task-export',
      fileName: 'export-this-task.md',
      sourceRevision: 201,
      exportedAt: '2026-07-14T00:00:00.000Z',
    });
    const notice = page.locator('.task-command-notice');
    await expect(notice).toBeVisible();
    await expect(notice.getByText('Status', { exact: true })).toBeVisible();
    await expect(
      notice.getByText('Export saved as export-this-task.md (source revision 201).', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Notice text must never surface absolute destinations.
    await expect(notice).not.toContainText(/[\\/]/);
    await expect(notice).not.toContainText(/^[A-Za-z]:/);

    // Foreign-task exportResult stays hidden while focused elsewhere.
    await postRawHostMessage(page, {
      type: 'exportResult',
      taskId: 'other-task',
      fileName: 'other.md',
      sourceRevision: 9,
      exportedAt: '2026-07-14T00:00:01.000Z',
    });
    await expect(
      notice.getByText('Export saved as export-this-task.md (source revision 201).', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(notice.getByText('Export saved as other.md (source revision 9).')).toHaveCount(0);

    // Task-scoped commandError is the failure chrome; success notice is superseded.
    await postCommandError(page, {
      type: 'commandError',
      taskId: 'task-export',
      message: 'Export could not be completed.',
    });
    await expect(page.getByRole('alert').getByText('Task command failed')).toBeVisible();
    await expect(page.getByRole('alert').getByText('Export could not be completed.')).toBeVisible();
    await expect(page.locator('.task-command-notice')).toHaveCount(0);

    // Foreign-task failure stays hidden.
    await postCommandError(page, {
      type: 'commandError',
      taskId: 'other-task',
      message: 'Foreign export failed.',
    });
    await expect(page.getByRole('alert').getByText('Foreign export failed.')).toHaveCount(0);

    // Cancel is silent: host posts nothing after exportTask. Click clears prior error chrome
    // so a cancelled Save As does not leave a stale failure banner.
    const beforeCancel = await postedMessages(page);
    await exportBtn.click();
    await expect.poll(async () => (await postedMessages(page)).length).toBe(beforeCancel.length + 1);
    const cancelExportPosts = (await postedMessages(page)).filter(
      (m) => (m as { type?: string }).type === 'exportTask',
    );
    expect(cancelExportPosts.at(-1)).toEqual({ type: 'exportTask', taskId: 'task-export' });
    await expect(page.getByRole('alert')).toHaveCount(0);
    // No exportResult arrives on cancel; success notice must not appear from silence alone.
    await expect(page.locator('.task-command-notice')).toHaveCount(0);

    // Path-like fileName is rejected by protocol guard before formatting (no banner).
    await postRawHostMessage(page, {
      type: 'exportResult',
      taskId: 'task-export',
      fileName: 'C:\\Users\\secret\\export.md',
      sourceRevision: 201,
      exportedAt: '2026-07-14T00:00:02.000Z',
    });
    await expect(page.locator('.task-command-notice')).toHaveCount(0);
    // Malformed exportResult (missing required fields) is ignored by protocol guard.
    await postRawHostMessage(page, {
      type: 'exportResult',
      taskId: 'task-export',
      fileName: 'ignored.md',
    });
    await expect(page.locator('.task-command-notice')).toHaveCount(0);
  });

  test('existing-task model switch posts requestRuntimeHandoff, shows handoffProgress chrome, and keeps chat free of hidden handoff content', async ({
    page,
  }) => {
    await openWebview(page);

    const taskId = 'task-handoff';
    const conversationOnly = 'Conversation-only visible reply.';
    // Canaries that must never appear in chat when projected only via handoff chrome.
    const sessionCanary = 'sess-hidden-handoff-xyz';
    const digestCanary = 'digest-deadbeef-handoff';
    const summaryBodyCanary = 'HIDDEN_SOURCE_SUMMARY_BODY';
    const bootstrapCanary = 'HIDDEN_BOOTSTRAP_PROMPT';

    const idleTask = task({
      id: taskId,
      goal: 'Switch model on existing idle task',
      viewStatus: 'idle',
      lifecycle: 'open',
      backend: 'claude',
      model: 'sonnet',
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [idleTask],
      focusedTaskId: taskId,
      subtree: [idleTask],
      transcript: [
        { id: 'msg-user-1', kind: 'user', content: 'Please summarize the plan.' },
        { id: 'msg-asst-1', kind: 'assistant', content: conversationOnly },
      ],
      storeRevision: 301,
    });

    // Host model catalog — required for backend::model picker options.
    await postModelsAvailable(page, {
      claude: {
        current: 'sonnet',
        options: [
          { value: 'sonnet', name: 'sonnet' },
          { value: 'opus', name: 'opus' },
        ],
      },
      grok: {
        current: 'grok-4',
        options: [{ value: 'grok-4', name: 'grok-4' }],
      },
    });

    const modelSwitch = page.getByTestId('task-model-switch');
    await expect(modelSwitch).toBeVisible();
    await expect(page.getByTestId('task-model-readonly')).toHaveCount(0);

    // User changes model on the existing idle task.
    await selectTaskModelSwitch(page, 'grok::grok-4');

    await expectPostedMessage(page, {
      type: 'requestRuntimeHandoff',
      taskId,
      targetBackend: 'grok',
      targetModel: 'grok-4',
    });

    // Host projects in-flight handoffProgress (sanitized labels only).
    const inFlight = handoffProgressFixture({
      phase: 'preparing_receiver',
      startedAt: '2026-07-14T00:00:02.000Z',
    });
    const inFlightTask = task({
      ...idleTask,
      handoffProgress: inFlight,
      updatedAt: '2026-07-14T00:00:02.000Z',
    });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [inFlightTask],
      focusedTaskId: taskId,
      subtree: [inFlightTask],
      transcript: [
        { id: 'msg-user-1', kind: 'user', content: 'Please summarize the plan.' },
        { id: 'msg-asst-1', kind: 'assistant', content: conversationOnly },
      ],
      storeRevision: 302,
    });

    const progress = page.getByTestId('handoff-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('data-handoff-phase', 'preparing_receiver');
    await expect(progress).toContainText('Preparing receiver');
    await expect(progress).toContainText('[Claude] sonnet');
    await expect(progress).toContainText('[Grok] grok-4');
    // Chrome must not surface secret-bearing fields even if a bad host leaked them elsewhere.
    await expect(progress).not.toContainText(sessionCanary);
    await expect(progress).not.toContainText(digestCanary);
    await expect(progress).not.toContainText(summaryBodyCanary);
    await expect(progress).not.toContainText(bootstrapCanary);
    await expect(progress).not.toContainText(inFlight.operationId);

    // Chat stays conversation-only — no hidden handoff turn / canaries.
    await expect(page.getByText(conversationOnly)).toBeVisible();
    await expect(page.getByText('Please summarize the plan.')).toBeVisible();
    await expect(page.getByText(sessionCanary)).toHaveCount(0);
    await expect(page.getByText(digestCanary)).toHaveCount(0);
    await expect(page.getByText(summaryBodyCanary)).toHaveCount(0);
    await expect(page.getByText(bootstrapCanary)).toHaveCount(0);
    // Picker stays interactive during in-flight handoff (product rule).
    // vscode-single-select exposes `disabled` as an attribute; Playwright's
    // a11y-based toBeDisabled() does not always treat custom elements as disabled.
    await expect
      .poll(() => modelSwitch.evaluate((el) => el.hasAttribute('disabled')))
      .toBe(false);

    // Completion: binding updates to target; progress is terminal completed chrome.
    const completed = handoffProgressFixture({
      phase: 'completed',
      startedAt: '2026-07-14T00:00:02.000Z',
      finishedAt: '2026-07-14T00:00:05.000Z',
      updatedAt: '2026-07-14T00:00:05.000Z',
    });
    const completedTask = task({
      id: taskId,
      goal: idleTask.goal,
      viewStatus: 'idle',
      lifecycle: 'open',
      backend: 'grok',
      model: 'grok-4',
      handoffProgress: completed,
      updatedAt: '2026-07-14T00:00:05.000Z',
    });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [completedTask],
      focusedTaskId: taskId,
      subtree: [completedTask],
      transcript: [
        { id: 'msg-user-1', kind: 'user', content: 'Please summarize the plan.' },
        { id: 'msg-asst-1', kind: 'assistant', content: conversationOnly },
      ],
      storeRevision: 303,
    });

    await expect(progress).toHaveAttribute('data-handoff-phase', 'completed');
    await expect(progress).toContainText('Switch complete');
    // Task header pill + model switch reflect the new binding.
    await expect(page.locator('.task-pill').filter({ hasText: 'grok' })).toBeVisible();
    // Terminal completed handoff re-enables the interactive switch (attribute cleared).
    await expect
      .poll(() => modelSwitch.evaluate((el) => el.hasAttribute('disabled')))
      .toBe(false);
    // Chat still free of handoff canaries after completion.
    await expect(page.getByText(conversationOnly)).toBeVisible();
    await expect(page.getByText(sessionCanary)).toHaveCount(0);
    await expect(page.getByText(digestCanary)).toHaveCount(0);
    await expect(page.getByText(summaryBodyCanary)).toHaveCount(0);
    await expect(page.getByText(bootstrapCanary)).toHaveCount(0);

    // Failed handoff keeps prior (source) binding labels and shows bounded failure chrome only.
    const failed = handoffProgressFixture({
      phase: 'failed',
      source: { backend: 'grok', model: 'grok-4' },
      target: { backend: 'claude', model: 'opus' },
      finishedAt: '2026-07-14T00:00:08.000Z',
      updatedAt: '2026-07-14T00:00:08.000Z',
      failure: {
        code: 'receiver_unavailable',
        message: 'Target backend is not available.',
        at: '2026-07-14T00:00:08.000Z',
      },
    });
    const failedTask = task({
      id: taskId,
      goal: idleTask.goal,
      viewStatus: 'idle',
      lifecycle: 'open',
      // Binding remains source after failure.
      backend: 'grok',
      model: 'grok-4',
      handoffProgress: failed,
      updatedAt: '2026-07-14T00:00:08.000Z',
    });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [failedTask],
      focusedTaskId: taskId,
      subtree: [failedTask],
      transcript: [
        { id: 'msg-user-1', kind: 'user', content: 'Please summarize the plan.' },
        { id: 'msg-asst-1', kind: 'assistant', content: conversationOnly },
      ],
      storeRevision: 304,
    });

    await expect(progress).toHaveAttribute('data-handoff-phase', 'failed');
    await expect(progress).toContainText('Switch failed');
    await expect(progress).toContainText('Target backend is not available.');
    await expect(progress).not.toContainText(sessionCanary);
    await expect(progress).not.toContainText(digestCanary);
    // Prior binding remains on the task header.
    await expect(page.locator('.task-pill').filter({ hasText: 'grok' })).toBeVisible();
    await expect(page.locator('.task-pill').filter({ hasText: 'claude' })).toHaveCount(0);
    await expect(page.getByText(conversationOnly)).toBeVisible();
    await expect(page.getByText(sessionCanary)).toHaveCount(0);

    // Busy (running) tasks still show an interactive picker — never blocked.
    const runningTask = task({
      id: taskId,
      goal: idleTask.goal,
      viewStatus: 'running',
      lifecycle: 'open',
      backend: 'grok',
      model: 'grok-4',
      updatedAt: '2026-07-14T00:00:09.000Z',
    });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [runningTask],
      focusedTaskId: taskId,
      subtree: [runningTask],
      transcript: [
        { id: 'msg-user-1', kind: 'user', content: 'Please summarize the plan.' },
        { id: 'msg-asst-1', kind: 'assistant', content: conversationOnly },
      ],
      storeRevision: 305,
    });
    await expect(page.getByTestId('task-model-switch')).toBeVisible();
    await expect(page.getByTestId('task-model-readonly')).toHaveCount(0);
  });
});

declare global {
  interface Window {
    acquireVsCodeApi: () => {
      postMessage(message: unknown): void;
      getState<T = unknown>(): T | undefined;
      setState<T = unknown>(state: T): void;
    };
    __musterPostedMessages?: unknown[];
  }
}
