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

interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: string;
  lifecycle: string;
  runtimeActivity?: TaskRuntimeActivity | null;
  viewStatus: TaskViewStatus;
  updatedAt: string;
  backend: string;
}

interface SnapshotMessage {
  type: 'snapshot';
  /** Stamped automatically by postSnapshot() below; omit when constructing test fixtures. */
  protocolVersion?: number;
  rootTasks: TaskSummary[];
  focusedTaskId?: string;
  subtree?: TaskSummary[];
  transcript?: Array<{ id: string; kind: 'user' | 'assistant' | 'tool' | 'error'; content: unknown }>;
  activeTurnId?: string;
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
        window.__musterPostedMessages = [...(window.__musterPostedMessages ?? []), message];
        window.dispatchEvent(new CustomEvent('muster:test:postMessage', { detail: message }));
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
const PROTOCOL_VERSION = 2;

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
  await expect.poll(async () => postedMessages(page)).toContainEqual(expected);
}

async function expectButtonDisabledAttribute(page: Page, name: string) {
  await expect
    .poll(() => page.getByRole('button', { name }).evaluate((button) => button.hasAttribute('disabled')))
    .toBe(true);
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
  return {
    id: 'task-root',
    parentId: null,
    goal: 'Wire browser regression harness',
    role: 'coordinator',
    lifecycle,
    runtimeActivity,
    viewStatus,
    updatedAt: '2026-01-01T00:00:00.000Z',
    backend: 'claude',
    ...overrides,
    lifecycle,
    runtimeActivity: overrides.runtimeActivity !== undefined ? overrides.runtimeActivity : runtimeActivity,
    viewStatus: overrides.viewStatus ?? viewStatus,
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
    await expect(page.locator('[data-cli-status="not_started"]').getByText(/CLI not started/i)).toBeVisible();
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

    await postRawHostMessage(page, { type: 'filePicked', path: 'src/extension.ts' });
    await expect(composer).toHaveValue('Review this @src/extension.ts ');

    await composer.fill('Review @src/extension.ts');
    await page.getByRole('button', { name: 'Send' }).click();
    await expectPostedMessage(page, {
      type: 'send',
      text: 'Review @src/extension.ts',
      backend: 'claude',
    });
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

    await postRawHostMessage(page, { type: 'filePicked', path: 'src/host/workspace-files.ts' });
    await expect(composer).toHaveValue('Inspect @src/host/workspace-files.ts ');
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
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-running', goal: 'Run active work', viewStatus: 'running' })],
      focusedTaskId: 'task-running',
      subtree: [task({ id: 'task-running', goal: 'Run active work', viewStatus: 'running' })],
      activeTurnId: 'turn-running',
      storeRevision: 3,
    });
    await expect(menu).toHaveCount(0);
    await expect(addContextButton).toBeDisabled();
    await expect(addContextButton).toHaveAttribute('aria-expanded', 'false');
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
    await expect(page.locator('[data-cli-status="running"]').getByText(/CLI running/i)).toBeVisible();
    await page.getByRole('button', { name: 'History (previous coordinator tasks)' }).click();
    await expect(page.getByRole('button', { name: /Run the model evaluation.*Task Open.*CLI running.*Backend claude/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Recover failed analysis.*Task Open.*Backend claude/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancelled rollout.*Task Cancelled.*Backend claude/i })).toBeVisible();
    await page.getByRole('button', { name: 'Close history' }).click();
    await expect(page.locator('.task-workspace-banner').getByRole('button', { name: /Task status: Open/i })).toBeVisible();
    await expect(page.locator('[data-cli-status="running"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop' }).click();
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
    await expect(page.locator('[data-cli-status="stopped"]').getByText(/CLI stopped/i)).toBeVisible();
    await expect(page.locator('.task-action-panel--danger').getByText('No retryable turn is available for this task.')).toBeVisible();
    await expect(page.locator('.task-action-panel--danger').getByText(/Task lifecycle remains/i)).toBeVisible();
    await expect(page.getByText('Recovery actions need a retryable turn.')).toBeVisible();
    await expectButtonDisabledAttribute(page, 'Retry failed turn');
    await expectButtonDisabledAttribute(page, 'Continue task');
    await page.getByPlaceholder('What should the agent do differently?').fill('Retry without a turn.');
    await page.getByPlaceholder('Message to queue as the next turn...').fill('Continue without a turn.');
    await expectButtonDisabledAttribute(page, 'Retry failed turn');
    await expectButtonDisabledAttribute(page, 'Continue task');

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-recovery', goal: 'Recover failed analysis', viewStatus: 'needs_recovery' })],
      focusedTaskId: 'task-recovery',
      subtree: [task({ id: 'task-recovery', goal: 'Recover failed analysis', viewStatus: 'needs_recovery' })],
      transcript: [{ id: 'msg-2b', kind: 'error', content: { message: 'Tool timeout.' } }],
      activeTurnId: 'turn-retryable',
      storeRevision: 41,
    });

    await expect(page.locator('.task-action-panel--danger').getByText('No retryable turn is available for this task.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry failed turn' })).toBeEnabled();
    await page.getByPlaceholder('What should the agent do differently?').fill('Use a smaller batch and retry.');
    await expect(page.getByRole('button', { name: 'Retry failed turn' })).toBeEnabled();
    await page.getByRole('button', { name: 'Retry failed turn' }).click();
    await expectPostedMessage(page, {
      type: 'retryTurn',
      taskId: 'task-recovery',
      turnId: 'turn-retryable',
      instruction: 'Use a smaller batch and retry.',
    });

    await page.getByPlaceholder('Message to queue as the next turn...').fill('Continue after documenting the failure.');
    await expect(page.getByRole('button', { name: 'Continue task' })).toBeEnabled();
    await page.getByRole('button', { name: 'Continue task' }).click();
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
    await expect(page.locator('.task-action-panel--muted').getByText(/This task is closed; use Continue as new task/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue as new task' })).toBeVisible();
    await expect(page.locator('.composer-guidance').getByText(/This task is closed; use Continue as new task/i)).toBeVisible();
    await page.getByRole('button', { name: 'Continue as new task' }).click();
    await expectPostedMessage(page, { type: 'newTask' });
    await expect(page.getByText('Continue as new task')).toBeVisible();
    await page.getByPlaceholder('Start a new coordinator task with claude…').fill('Open a follow-up after cancellation.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expectPostedMessage(page, {
      type: 'send',
      text: 'Open a follow-up after cancellation.',
      backend: 'claude',
      continuationOf: 'task-cancelled',
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
    await expect(page.getByText('Queued turn is waiting to resume.')).toBeVisible();
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
    // Soft failed: reopen via send on the same task — not hard-terminal "Continue as new".
    await page.locator('.task-workspace-banner').getByRole('button', { name: /Expand task details/i }).click();
    await expect(page.getByText(/Send a message to reopen/i).first()).toBeVisible();
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
    await expect(page.locator('.task-action-panel--muted').getByText(/This task is closed; use Continue as new task/i)).toBeVisible();

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
    // ask_user: process on, not generating → CLI idle
    await expect(page.locator('[data-cli-status="idle"]').getByText(/CLI idle/i)).toBeVisible();
    await expect(page.getByText('Agent question')).toBeVisible();
    await expect(page.getByText('Which model should continue?')).toBeVisible();
    await expect(page.locator('.composer-guidance').getByText('Answer the pending task question above to continue.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    // Process is still up (CLI idle) — Stop remains available to abort the turn.
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.locator('vscode-radio').filter({ hasText: 'Claude' }).click();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expectPostedMessage(page, {
      type: 'submitAsk',
      taskId: 'task-waiting',
      turnId: 'turn-waiting',
      askId: 'ask-1',
      answers: {
        '0': { selected: ['Claude'], freeText: null },
      },
    });
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expectPostedMessage(page, {
      type: 'cancelAsk',
      taskId: 'task-waiting',
      turnId: 'turn-waiting',
      askId: 'ask-1',
    });

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
    // ask_user without pending card: process still on → CLI idle (not running).
    await expect(page.locator('[data-cli-status="idle"]').getByText(/CLI idle/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
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
