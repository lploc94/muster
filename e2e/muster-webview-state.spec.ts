import { expect, test, type Page } from '@playwright/test';

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
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Backed by VS Code configuration')).toBeVisible();
    await expect(page.getByText('Retention keeps recent task history usable without storing unlimited completed-turn output.')).toBeVisible();
    await expect(page.getByRole('status').getByText('Loading retention settings from VS Code…')).toBeVisible();
    await expect(page.getByPlaceholder('Search tasks…')).toBeVisible();

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

    await expect(page.getByRole('status').getByText('Settings ready. Edit one field at a time; each Save writes only that VS Code setting.')).toBeVisible();
    await expect(page.getByLabel('Maximum turns per task')).toHaveValue('200');
    await expect(page.getByLabel('Maximum stored output characters')).toHaveValue('200000');
    await expect(page.getByText('Minimum 1. Default 200.')).toBeVisible();
    await expect(page.getByText('Minimum 1024. Default 200000.')).toBeVisible();

    await page.getByLabel('Maximum turns per task').fill('0');
    await page.getByRole('button', { name: 'Save Maximum turns per task' }).click();
    await expect(page.getByRole('alert').getByText('Maximum turns per task must be at least 1.')).toBeVisible();
    await expect.poll(async () => (await postedMessages(page)).filter((message) => (message as { type?: string }).type === 'updateSetting')).toHaveLength(0);

    await page.getByLabel('Maximum turns per task').fill('201');
    await page.getByRole('button', { name: 'Save Maximum turns per task' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'maxTurnsPerTask', value: 201 });
    await expect(page.getByText('Saving Maximum turns per task…')).toBeVisible();

    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'maxTurnsPerTask', value: 201 },
    });
    await expect(page.getByLabel('Maximum turns per task')).toHaveValue('201');
    await expect(page.getByText('Saved Maximum turns per task.')).toBeVisible();

    await page.getByLabel('Maximum stored output characters').fill('250000');
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
    await expect(page.getByLabel('Maximum stored output characters')).toHaveValue('200000');

    await page.setViewportSize({ width: 360, height: 720 });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Maximum stored output characters' })).toBeVisible();
    await expect
      .poll(() =>
        page.locator('.settings-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
      )
      .toBe(true);

    await page.getByRole('button', { name: 'Close settings' }).click();
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
    await page.getByRole('button', { name: 'Close settings' }).click();
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

    // Path-like fileName must not invent a success banner (formatter rejects; message ignored).
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
