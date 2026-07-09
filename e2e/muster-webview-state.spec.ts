import { expect, test, type Page } from '@playwright/test';

type TaskViewStatus =
  | 'waiting_dependencies'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_children'
  | 'blocked'
  | 'needs_recovery'
  | 'idle'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

interface TaskSummary {
  id: string;
  parentId: string | null;
  goal: string;
  role: string;
  lifecycle: string;
  viewStatus: TaskViewStatus;
  updatedAt: string;
  backend: string;
}

interface SnapshotMessage {
  type: 'snapshot';
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
  await expect(page.getByText('Muster')).toBeVisible();
}

async function postSnapshot(page: Page, snapshot: SnapshotMessage) {
  await page.evaluate((message) => {
    window.postMessage(message, '*');
  }, snapshot);
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
  return {
    id: 'task-root',
    parentId: null,
    goal: 'Wire browser regression harness',
    role: 'coordinator',
    lifecycle: 'open',
    viewStatus: 'idle',
    updatedAt: '2026-01-01T00:00:00.000Z',
    backend: 'claude',
    ...overrides,
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

    await expect(page.locator('.task-workspace-banner').getByText('Ready for work')).toBeVisible();
    await expect(page.locator('.task-workspace-banner').getByText('No turn is currently running for this task.')).toBeVisible();
    await expect(page.getByText('Wire browser regression harness').first()).toBeVisible();
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
    await page.locator('button[title="New task"]').first().click();
    await expectPostedMessage(page, { type: 'newTask' });
    await expect(page.getByText('New task').first()).toBeVisible();
    await expect(page.getByText('First message creates the coordinator task.')).toBeVisible();
    await page.getByPlaceholder('Start a new coordinator task with claude…').fill('Start a browser-visible task.');
    await page.locator('button[title="Send"]').click();
    await expectPostedMessage(page, {
      type: 'send',
      text: 'Start a browser-visible task.',
      backend: 'claude',
    });
  });

  test('adds a file mention from the composer add-file button', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 2,
    });

    await page.locator('button[title="New task"]').first().click();
    await expectPostedMessage(page, { type: 'newTask' });

    await page.locator('button[title="Add file"]').click();
    await expectPostedMessage(page, { type: 'pickFile' });

    await postRawHostMessage(page, { type: 'filePicked', path: 'src/extension.ts' });
    await expect(page.getByPlaceholder('Start a new coordinator task with claude…')).toHaveValue('@src/extension.ts ');

    await page.getByPlaceholder('Start a new coordinator task with claude…').fill('Review @src/extension.ts');
    await page.locator('button[title="Send"]').click();
    await expectPostedMessage(page, {
      type: 'send',
      text: 'Review @src/extension.ts',
      backend: 'claude',
    });
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

    await expect(page.locator('.task-workspace-banner').getByText('Task is running')).toBeVisible();
    await expect(page.locator('.task-workspace-banner').getByText('The assigned agent is actively processing this task')).toBeVisible();
    await page.locator('button[title="History (previous coordinator tasks)"]').click();
    await expect(page.getByRole('button', { name: /Run the model evaluation.*Running.*Agent is working.*Backend claude/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Recover failed analysis.*Needs recovery.*Recovery required.*Backend claude/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancelled rollout.*Cancelled.*Stopped before finishing.*Backend claude/i })).toBeVisible();
    await page.getByRole('button', { name: 'Close history' }).click();
    await expect(page.getByText('Task is running')).toBeVisible();
    await expect(page.getByText('Composer is disabled while the active turn is running')).toBeVisible();
    await expect(page.locator('button[title="Stop"]')).toBeVisible();
    await page.locator('button[title="Stop"]').click();
    await expectPostedMessage(page, {
      type: 'cancelTurn',
      taskId: 'task-running',
      turnId: 'turn-running',
    });

    if ((await page.getByRole('button', { name: /Recover failed analysis.*Needs recovery.*Recovery required.*Backend claude/i }).count()) === 0) {
      await page.locator('button[title="History (previous coordinator tasks)"]').click();
    }
    await page.getByRole('button', { name: /Recover failed analysis.*Needs recovery.*Recovery required.*Backend claude/i }).click();
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

    await expect(page.locator('.task-workspace-banner').getByText('Recovery needed')).toBeVisible();
    await expect(page.locator('.task-action-panel--danger').getByText('No retryable turn is available for this task.')).toBeVisible();
    await expect(page.locator('.task-action-panel--danger').getByText('Review the failure, then retry or continue with recovery instructions.')).toBeVisible();
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

    await expect(page.locator('.task-workspace-banner').getByText('Task cancelled')).toBeVisible();
    await expect(page.locator('.task-action-panel--muted').getByText('This task is closed; use Continue as new task for follow-up work.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue as new task' })).toBeVisible();
    await expect(page.locator('.composer-guidance').getByText('This task is closed; use Continue as new task for follow-up work.')).toBeVisible();
    await page.getByRole('button', { name: 'Continue as new task' }).click();
    await expectPostedMessage(page, { type: 'newTask' });
    await expect(page.getByText('Continue as new task')).toBeVisible();
    await page.getByPlaceholder('Start a new coordinator task with claude…').fill('Open a follow-up after cancellation.');
    await page.locator('button[title="Send"]').click();
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

    await expect(page.locator('.task-workspace-banner').getByText('Queued for execution')).toBeVisible();
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
      rootTasks: [task({ id: 'task-failed', goal: 'Failed rollout', viewStatus: 'failed', lifecycle: 'failed' })],
      focusedTaskId: 'task-failed',
      subtree: [task({ id: 'task-failed', goal: 'Failed rollout', viewStatus: 'failed', lifecycle: 'failed' })],
      transcript: [{ id: 'msg-3', kind: 'error', content: 'Build failed.' }],
      storeRevision: 47,
    });

    await expect(page.locator('.task-workspace-banner').getByText('Task failed')).toBeVisible();
    await expect(page.locator('.task-action-panel--muted').getByText('This task is closed; use Continue as new task for follow-up work.')).toBeVisible();
    await expect(page.locator('.composer-guidance').getByText('This task is closed; use Continue as new task for follow-up work.')).toBeVisible();

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-succeeded', goal: 'Ship status UI', viewStatus: 'succeeded', lifecycle: 'succeeded' })],
      focusedTaskId: 'task-succeeded',
      subtree: [task({ id: 'task-succeeded', goal: 'Ship status UI', viewStatus: 'succeeded', lifecycle: 'succeeded' })],
      transcript: [{ id: 'msg-4', kind: 'assistant', content: 'Done.' }],
      storeRevision: 48,
    });

    await expect(page.locator('.task-workspace-banner').getByText('Task succeeded')).toBeVisible();
    await expect(page.locator('.task-action-panel--muted').getByText('This task is closed; use Continue as new task for follow-up work.')).toBeVisible();

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

    await expect(page.locator('.task-workspace-banner').getByText('Input required')).toBeVisible();
    await expect(page.getByText('Agent question')).toBeVisible();
    await expect(page.getByText('Which model should continue?')).toBeVisible();
    await expect(page.locator('.composer-guidance').getByText('Answer the pending task question above to continue.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
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
    await expect(page.locator('.composer-guidance').getByText('Answer the pending prompt to unblock the task.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
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
