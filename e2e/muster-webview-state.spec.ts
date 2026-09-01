import { expect, test, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openMusterWebview,
  readMusterWebviewState,
} from './fixtures/muster-webview';
import {
  isFileMentionDirectorySymlink,
  listFileMentionSuggestions,
} from '../src/host/file-mention-suggestions';

type TaskRuntimeActivity =
  | 'waiting_dependencies'
  | 'waiting_workflow'
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
  workflowNodeStatus?: string | null;
  ownerWorkflowStatus?: string | null;
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
  transcript?: Array<{
    id: string;
    kind: 'user' | 'assistant' | 'tool' | 'error' | 'reasoning';
    content: unknown;
    turnId?: string;
    order?: number;
    state?: string;
  }>;
  /** Protocol v9: required when focusedTaskId is set. */
  transcriptPage?: {
    hasMoreBefore: boolean;
    workspaceRevision: number;
    beforeCursor?: string;
  };
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

async function openWebview(
  page: Page,
  options?: { initialState?: unknown; backendReadiness?: 'none' | 'all-installed-unverified' },
) {
  // Shared harness: structured-clone VS Code API mock + deterministic open path.
  // M019: the draft composer is fail-closed on backend readiness, so this suite
  // seeds a settled all-installed-unverified snapshot by default. Without it the
  // draft textarea stays disabled behind setup guidance and every composer flow
  // (file mentions, Add Context, model switch) times out. Readiness-specific
  // tests opt out with backendReadiness: 'none'.
  await openMusterWebview(page, {
    initialState: options?.initialState,
    structuredCloneMessages: true,
    stateMode: 'bag',
    backendReadiness: options?.backendReadiness ?? 'all-installed-unverified',
  });
}

async function readVsCodeState(page: Page): Promise<unknown> {
  return readMusterWebviewState(page);
}

/** Move file-mention highlight to option index (retries ArrowDown if the first key is dropped). */
async function focusFileMentionOption(
  composer: ReturnType<Page['getByPlaceholder']>,
  optionIndex: number,
) {
  const target = `file-mention-option-${optionIndex}`;
  await expect
    .poll(
      async () => {
        const current = await composer.getAttribute('aria-activedescendant');
        if (current === target) return target;
        await composer.press('ArrowDown');
        return composer.getAttribute('aria-activedescendant');
      },
      { timeout: 5_000 },
    )
    .toBe(target);
}

/** Seed a full ok task-types host snapshot for Settings flow tests. */
function taskTypesOkSnapshot(overrides: Partial<{
  status: 'ok' | 'empty' | 'invalid';
  types: Array<{
    id: string;
    backend: string;
    role: 'coordinator' | 'worker';
    briefKind: string;
    description?: string;
    model?: string;
  }>;
  diagnostics: Array<{ code: string; message: string }>;
}> = {}) {
  return {
    status: overrides.status ?? 'ok',
    diagnostics: overrides.diagnostics ?? [],
    types: overrides.types ?? [
      {
        id: 'worker',
        backend: 'claude',
        role: 'worker' as const,
        briefKind: 'generic',
        description: 'Default worker',
      },
    ],
    defaults: [
      {
        id: 'worker',
        backend: 'claude',
        role: 'worker' as const,
        briefKind: 'generic',
      },
      {
        id: 'coordinator',
        backend: 'claude',
        role: 'coordinator' as const,
        briefKind: 'generic',
      },
    ],
    constraints: {
      maxTypes: 32,
      idPattern: '^[a-z][a-z0-9_-]{0,63}$',
      descriptionMax: 200,
      stringMax: 128,
      roles: ['coordinator', 'worker'] as Array<'coordinator' | 'worker'>,
      briefKinds: ['generic', 'investigation', 'implementation'],
    },
  };
}

function retentionSettingsSnapshot(values: {
  maxRetainedTurnsPerTask: number;
  maxStoredOutputChars: number;
  runLimit?: '15m' | '30m' | '1h' | '2h' | '4h' | '8h';
}) {
  return {
    settings: [
      {
        kind: 'enum',
        id: 'runLimit',
        label: 'Maximum uninterrupted agent run',
        description: 'Maximum uninterrupted runtime for a newly promoted agent turn.',
        value: values.runLimit ?? '2h',
        defaultValue: '2h',
        options: ['15m', '30m', '1h', '2h', '4h', '8h'],
      },
      {
        kind: 'number',
        id: 'maxRetainedTurnsPerTask',
        label: 'Retained turns per completed task',
        description: 'Controls how many settled turns are retained for each terminal task.',
        value: values.maxRetainedTurnsPerTask,
        defaultValue: 200,
        minimum: 1,
      },
      {
        kind: 'number',
        id: 'maxStoredOutputChars',
        label: 'Stored output per turn',
        description: 'Limits retained assistant output for settled turns on open tasks.',
        value: values.maxStoredOutputChars,
        defaultValue: 200000,
        minimum: 1024,
      },
    ],
  };
}

function permissionSettingsSnapshot(mode: 'ask' | 'allow' | 'readonly' = 'ask') {
  return {
    mode,
    defaultMode: 'ask' as const,
    description:
      "How Muster handles agent tool-permission requests. 'ask' (safe): auto-allow read-only, prompt for writes/commands. 'allow': auto-approve everything (less safe). 'readonly': deny all writes/commands.",
    options: [
      {
        mode: 'ask' as const,
        label: 'Ask',
        description: 'Safe: auto-allow read-only tool calls, prompt for writes/commands/unknown actions.',
        risk: 'recommended' as const,
      },
      {
        mode: 'allow' as const,
        label: 'Allow',
        description: 'Auto-approve every tool-permission request (least safe; still audit-logged).',
        risk: 'least-safe' as const,
      },
      {
        mode: 'readonly' as const,
        label: 'Read only',
        description: 'Allow read-only tool calls, deny all writes/commands without prompting.',
        risk: 'restricted' as const,
      },
    ],
  };
}

function taskTypesSettingsSnapshot(overrides?: {
  status?: 'ok' | 'empty' | 'invalid';
  types?: Array<{
    id: string;
    backend: string;
    role: 'coordinator' | 'worker';
    briefKind: string;
    description?: string;
    model?: string;
  }>;
  diagnostics?: Array<{ code: string; message: string }>;
}) {
  const types = overrides?.types ?? [
    {
      id: 'worker',
      backend: 'claude',
      role: 'worker' as const,
      briefKind: 'generic',
      description: 'Default worker',
    },
    {
      id: 'coordinator',
      backend: 'claude',
      role: 'coordinator' as const,
      briefKind: 'generic',
      description: 'Default coordinator',
    },
  ];
  return {
    status: overrides?.status ?? 'ok',
    types,
    diagnostics: overrides?.diagnostics ?? [],
    defaults: types.map((t) => ({ ...t })),
    constraints: {
      maxTypes: 32,
      idPattern: '^[a-z][a-z0-9_-]{0,63}$',
      descriptionMax: 200,
      stringMax: 128,
      roles: ['coordinator', 'worker'] as Array<'coordinator' | 'worker'>,
      briefKinds: ['generic', 'investigation', 'implementation'],
    },
  };
}


// Wire protocol version the webview currently stamps/expects; kept in sync with
// PROTOCOL_VERSION in webview/src/lib/protocol.ts. Test fixtures below always
// send it so the version-mismatch banner doesn't mask the harness's own
// snapshot messages.
const PROTOCOL_VERSION = 13;

/**
 * Normalize a focused snapshot to the protocol v9 current-only contract:
 * focused => transcript[] + transcriptPage; host never ships error transcript items.
 */
function normalizeSnapshotMessage(snapshot: SnapshotMessage): SnapshotMessage & {
  protocolVersion: number;
} {
  const focused = typeof snapshot.focusedTaskId === 'string' && snapshot.focusedTaskId.length > 0;
  const rawTranscript = Array.isArray(snapshot.transcript) ? snapshot.transcript : [];
  // Host isExtMessage rejects kind:'error' transcript rows (locally synthesized only).
  const transcript = rawTranscript.filter((item) => item && item.kind !== 'error');
  if (!focused) {
    const { transcript: _t, transcriptPage: _p, ...rest } = snapshot as SnapshotMessage & {
      transcriptPage?: unknown;
    };
    return {
      ...rest,
      protocolVersion: PROTOCOL_VERSION,
    };
  }
  const hasMoreBefore = Boolean(
    (snapshot as SnapshotMessage & { transcriptPage?: { hasMoreBefore?: boolean } }).transcriptPage
      ?.hasMoreBefore,
  );
  const beforeCursor = (
    snapshot as SnapshotMessage & { transcriptPage?: { beforeCursor?: string } }
  ).transcriptPage?.beforeCursor;
  const workspaceRevision =
    (snapshot as SnapshotMessage & { transcriptPage?: { workspaceRevision?: number } })
      .transcriptPage?.workspaceRevision ?? snapshot.storeRevision;
  return {
    ...snapshot,
    protocolVersion: PROTOCOL_VERSION,
    transcript,
    transcriptPage: {
      hasMoreBefore,
      workspaceRevision,
      ...(hasMoreBefore && beforeCursor ? { beforeCursor } : {}),
    },
  };
}

async function postSnapshot(page: Page, snapshot: SnapshotMessage) {
  await page.evaluate((message) => {
    window.postMessage(message, '*');
  }, normalizeSnapshotMessage(snapshot));
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

/**
 * Narrow a recorded outbound message to the importPastedImage envelope.
 * postedMessages() returns structured-cloned wire traffic, so the fields are
 * checked here rather than asserted at the read site.
 */
function isPastedImagePost(message: unknown): message is { type: 'importPastedImage'; name: string; data: unknown } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'importPastedImage' &&
    'name' in message &&
    typeof message.name === 'string' &&
    'data' in message
  );
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

/** True when document focus is on `el` or inside its light/shadow tree. */
async function controlHasFocus(locator: import('@playwright/test').Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const active = document.activeElement;
    if (!active) return false;
    if (el === active || el.contains(active)) return true;
    let node: Node | null = active;
    while (node) {
      if (node === el) return true;
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) {
        node = root.host;
        continue;
      }
      node = node.parentNode;
    }
    return false;
  });
}

async function expectControlFocused(locator: import('@playwright/test').Locator): Promise<void> {
  await expect.poll(async () => controlHasFocus(locator)).toBe(true);
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

    // Compact chrome: title + status button (no legacy expand-details disclosure).
    await expect(page.locator('.task-chrome').getByText('Wire browser regression harness')).toBeVisible();
    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Idle/i })).toBeVisible();
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

  await page.getByRole('button', { name: 'Send', exact: true }).click();
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
  await page.getByRole('button', { name: 'Send', exact: true }).click();
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
  await focusFileMentionOption(composer, 1);
  await expect(tabListbox.getByRole('option', { name: 'table.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
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

  // Closed baseline: valid combobox role (aria-expanded is unsupported on an
  // implicit textarea textbox — role=combobox is required for the ARIA contract).
  await expect(composer).toHaveAttribute('role', 'combobox');
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

  // Combobox remains focused; listbox is controlled via aria-activedescendant.
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute('role', 'combobox');
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
  await focusFileMentionOption(composer, 1);
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(composer).toBeFocused();

  await focusFileMentionOption(composer, 2);
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');

  await composer.press('ArrowUp');
  await focusFileMentionOption(composer, 1);
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
  await focusFileMentionOption(composer, 1);
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
 * M013 S03 / T01: focused RED regressions for composer combobox semantics,
 * reduced-motion streaming cursor, and compact icon hit areas at 320px.
 * Implementation lands in T02; these must fail against current production UI.
 */
test('composer combobox semantics', async ({ page }) => {
  await openWebview(page);
  await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 1301 });
  await page.getByRole('button', { name: 'New task' }).first().click();
  await expectPostedMessage(page, { type: 'newTask' });

  const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
  await composer.click();
  await expect(composer).toBeFocused();

  // Valid combobox role is required so aria-expanded is not pinned on an implicit textbox.
  await expect(composer).toHaveAttribute('role', 'combobox');
  await expect(composer).toHaveAttribute('aria-autocomplete', 'list');
  await expect(composer).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  await expect(composer).not.toHaveAttribute('aria-activedescendant');

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
  };

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
    ],
  });

  const listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
  await expect(listbox).toBeVisible();
  await expect(composer).toHaveAttribute('role', 'combobox');
  await expect(composer).toHaveAttribute('aria-expanded', 'true');
  await expect(composer).toHaveAttribute('aria-controls', 'file-mention-listbox');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-0');
  await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');

  // Keyboard selection must keep combobox focus and update active descendant.
  await composer.press('ArrowDown');
  await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
  await expect(listbox.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('reduced motion streaming cursor', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWebview(page);
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-m013-s03-stream',
        goal: 'Streaming reduced-motion proof',
        viewStatus: 'running',
      }),
    ],
    focusedTaskId: 'task-m013-s03-stream',
    subtree: [
      task({
        id: 'task-m013-s03-stream',
        goal: 'Streaming reduced-motion proof',
        viewStatus: 'running',
      }),
    ],
    transcript: [],
    activeTurnId: 'turn-m013-s03-stream',
    storeRevision: 1302,
  });

  await postRawHostMessage(page, {
    type: 'turnStart',
    taskId: 'task-m013-s03-stream',
    turnId: 'turn-m013-s03-stream',
  });
  await postRawHostMessage(page, {
    type: 'event',
    taskId: 'task-m013-s03-stream',
    turnId: 'turn-m013-s03-stream',
    event: {
      type: 'assistantDelta',
      content: 'Streaming under reduced motion…',
      messageId: 'msg-m013-s03-stream',
    },
  });

  const cursor = page.locator('.streaming-cursor');
  await expect(cursor).toBeVisible();
  await expect(cursor).toHaveText('▋');

  // prefers-reduced-motion must stop the infinite blink animation.
  const motion = await cursor.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      animationIterationCount: style.animationIterationCount,
      animationPlayState: style.animationPlayState,
    };
  });
  const noInfiniteBlink =
    motion.animationName === 'none' ||
    motion.animationDuration === '0s' ||
    motion.animationIterationCount === '0' ||
    motion.animationPlayState === 'paused';
  expect(
    noInfiniteBlink,
    `expected reduced-motion to disable infinite blink, got ${JSON.stringify(motion)}`,
  ).toBe(true);
});

test('compact icon targets', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openWebview(page);
  await postSnapshot(page, {
    type: 'snapshot',
    rootTasks: [
      task({
        id: 'task-m013-s03-icons',
        goal: 'Compact icon hit-area proof',
        viewStatus: 'idle',
      }),
    ],
    focusedTaskId: 'task-m013-s03-icons',
    subtree: [
      task({
        id: 'task-m013-s03-icons',
        goal: 'Compact icon hit-area proof',
        viewStatus: 'idle',
      }),
    ],
    transcript: [{ id: 'msg-m013-s03-icons', kind: 'assistant', content: 'Toolbar ready.' }],
    storeRevision: 1303,
  });

  await expect(page.getByText('Toolbar ready.')).toBeVisible();

  // Shared toolbar icon controls must expose practical ≥28×28 CSS-pixel hit areas.
  const toolbarIcons = page.locator(
    'button.icon-btn[aria-label="Back to tasks list"], button.icon-btn[aria-label="History (previous coordinator tasks)"], button.icon-btn[aria-label="New task"], button.icon-btn[aria-label="Export task/chat"], button.icon-btn[aria-label="Settings"]',
  );
  await expect(toolbarIcons).toHaveCount(5);

  const boxes = await toolbarIcons.evaluateAll((els) =>
    els.map((el) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      return {
        label: el.getAttribute('aria-label') ?? '(unlabeled)',
        width: box.width,
        height: box.height,
      };
    }),
  );
  for (const box of boxes) {
    expect(
      box.width,
      `${box.label} width ${box.width}px must be ≥ 28 CSS px`,
    ).toBeGreaterThanOrEqual(28);
    expect(
      box.height,
      `${box.label} height ${box.height}px must be ≥ 28 CSS px`,
    ).toBeGreaterThanOrEqual(28);
  }

  // Compact 320px toolbar must not force document horizontal overflow.
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      docOk: doc.scrollWidth <= doc.clientWidth + 1,
      bodyOk: body.scrollWidth <= body.clientWidth + 1,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
    };
  });
  expect(
    overflow.docOk && overflow.bodyOk,
    `document horizontal overflow at 320px: ${JSON.stringify(overflow)}`,
  ).toBe(true);
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
  await focusFileMentionOption(grandComposer, 1);
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
 * queued follow-up, and interrupt-and-send.
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
  await focusFileMentionOption(parentComposer, 1);
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

  // ── Queued follow-up + interrupt-and-send while running ──────────────────
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

  // Ctrl+Enter posts sendLiveInput (interrupt & send).
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

    // Skill is now an enabled action that opens the in-webview skill picker.
    const skillItem = menu.getByRole('menuitem', { name: 'Skill' });
    await expect(skillItem).toBeVisible();
    await expect(skillItem).toBeEnabled();

    for (const label of ['Wiki page', 'Agent', 'Browser tab', 'Web search']) {
      const item = menu.getByRole('menuitem', { name: label });
      await expect(item).toBeVisible();
      await expect(item).toBeDisabled();
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item.locator('.add-context__menu-item-badge')).toHaveText('Coming soon');
    }

    // Choosing Skill opens the in-webview picker (dismissing the menu) and posts no
    // file-pick host messages.
    await skillItem.click();
    await expect(menu).toBeHidden();
    expect(await postedMessages(page)).not.toContainEqual({ type: 'pickFile' });
    expect(await postedMessages(page)).not.toContainEqual({ type: 'browseWorkspaceFiles' });
  });

  test('Add Context Image posts pickImage and picked paths become removable chips carried on send', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 2 });
    await page.getByRole('button', { name: 'New task' }).first().click();
    await expectPostedMessage(page, { type: 'newTask' });

    const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
    await composer.fill('Look at these');

    // No chip strip until the host answers with real paths.
    await expect(page.getByTestId('attachment-chips')).toHaveCount(0);

    const addContextButton = page.getByRole('button', { name: 'Add Context' });
    await addContextButton.click();
    const menu = page.getByRole('menu', { name: 'Add Context' });
    const imageItem = menu.getByRole('menuitem', { name: 'Image' });
    await expect(imageItem).toBeEnabled();
    await imageItem.click();
    await expectPostedMessage(page, { type: 'pickImage' });
    await expect(menu).toHaveCount(0);

    await postRawHostMessage(page, {
      type: 'imagesPicked',
      paths: ['/tmp/shots/alpha.png', '/tmp/shots/beta.jpeg'],
    });

    const chips = page.getByTestId('attachment-chip');
    await expect(chips).toHaveCount(2);
    // Chips show basenames only; the absolute path stays in data-path for send.
    await expect(chips.nth(0)).toContainText('alpha.png');
    await expect(chips.nth(1)).toContainText('beta.jpeg');
    await expect(chips.nth(0)).toHaveAttribute('data-path', '/tmp/shots/alpha.png');

    // Removing one chip must not disturb the draft or the surviving chip.
    await chips.nth(0).getByRole('button', { name: 'Remove alpha.png' }).click();
    await expect(page.getByTestId('attachment-chip')).toHaveCount(1);
    await expect(page.getByTestId('attachment-chip')).toContainText('beta.jpeg');
    await expect(composer).toHaveValue('Look at these');

    await page.getByRole('button', { name: 'Send' }).click();
    await expectPostedMessage(page, {
      type: 'send',
      text: 'Look at these',
      attachments: ['/tmp/shots/beta.jpeg'],
    });

    // Chips clear with the draft so the next prompt does not resend the image.
    await expect(page.getByTestId('attachment-chips')).toHaveCount(0);
  });

  test('duplicate picks are ignored and the fifth image surfaces the cap instead of attaching', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 2 });
    await page.getByRole('button', { name: 'New task' }).first().click();

    await postRawHostMessage(page, { type: 'imagesPicked', paths: ['/tmp/a.png'] });
    await expect(page.getByTestId('attachment-chip')).toHaveCount(1);

    // Same path again: dedupe by path, no second chip.
    await postRawHostMessage(page, { type: 'imagesPicked', paths: ['/tmp/a.png'] });
    await expect(page.getByTestId('attachment-chip')).toHaveCount(1);

    await postRawHostMessage(page, {
      type: 'imagesPicked',
      paths: ['/tmp/b.png', '/tmp/c.png', '/tmp/d.png', '/tmp/e.png'],
    });
    // Cap is 4: the overflow is refused loudly rather than silently dropped.
    await expect(page.getByTestId('attachment-chip')).toHaveCount(4);
    await expect(page.getByRole('alert')).toHaveText('Up to 4 images per message.');
  });

  test('pasting an image posts importPastedImage bytes and leaves the draft text untouched', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 2 });
    await page.getByRole('button', { name: 'New task' }).first().click();

    const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
    await composer.fill('before paste');

    // Synthetic clipboard paste: a real image item plus real bytes.
    await composer.evaluate((el: HTMLTextAreaElement) => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const file = new File([bytes], 'clip.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    // Narrow the recorded host message rather than asserting a shape onto it:
    // postedMessages() is structured-cloned wire traffic, so the fields must be
    // checked before they are read.
    const pastedImagePosts = async () => (await postedMessages(page)).filter(isPastedImagePost);
    await expect.poll(async () => (await pastedImagePosts()).length).toBeGreaterThan(0);
    const posted = (await pastedImagePosts())[0]!;
    // Host-facing name carries the mime-derived extension; bytes travel as a buffer.
    expect(posted.name).toMatch(/^pasted-image-\d+\.png$/);
    expect(posted.data).toBeTruthy();

    // Paste of an image must never mutate the textarea.
    await expect(composer).toHaveValue('before paste');

    // Host echo turns the staged temp path into a chip.
    await postRawHostMessage(page, { type: 'pastedImageImported', path: '/tmp/muster-drop-x/clip.png' });
    await expect(page.getByTestId('attachment-chip')).toHaveText(/clip\.png/);

    // A staging failure surfaces the host reason and adds no chip.
    await postRawHostMessage(page, { type: 'pastedImageRejected', reason: 'Image is too large.' });
    await expect(page.getByRole('alert')).toHaveText('Image is too large.');
    await expect(page.getByTestId('attachment-chip')).toHaveCount(1);
  });

  test('pasting plain text still lands in the draft and posts no image message', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, { type: 'snapshot', rootTasks: [], storeRevision: 2 });
    await page.getByRole('button', { name: 'New task' }).first().click();

    const composer = page.getByPlaceholder('Start a new coordinator task with claude…');
    await composer.click();
    await composer.evaluate((el: HTMLTextAreaElement) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'pasted words');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    // preventDefault must NOT fire for text-only paste: the browser default applies.
    expect(await postedMessages(page)).not.toContainEqual(
      expect.objectContaining({ type: 'importPastedImage' }),
    );
    await expect(page.getByTestId('attachment-chips')).toHaveCount(0);
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

    const composer = page.getByRole('combobox').first();
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
    await expect(page.getByRole('combobox').first()).toBeEnabled();
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

    await expect(page.locator('.task-chrome').getByText('Run the model evaluation')).toBeVisible();
    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Working/i })).toBeVisible();
    await expect(page.locator('[data-turn-activity="executing"]').getByText(/Working/i)).toBeVisible();
    await page.getByRole('button', { name: 'History (previous coordinator tasks)' }).click();
    await expect(page.getByRole('button', { name: /Run the model evaluation.*Task Open.*Turn working.*Backend claude/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Recover failed analysis.*Task Open.*Backend claude/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancelled rollout.*Task Cancelled.*Backend claude/i })).toBeVisible();
    await page.getByRole('button', { name: 'Close history' }).click();
    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Working/i })).toBeVisible();
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

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-recovery', goal: 'Recover failed analysis', viewStatus: 'needs_recovery' })],
      focusedTaskId: 'task-recovery',
      subtree: [task({ id: 'task-recovery', goal: 'Recover failed analysis', viewStatus: 'needs_recovery' })],
      transcript: [{ id: 'msg-2', kind: 'error', content: { message: 'Agent process exited.' } }],
      storeRevision: 4,
    });

    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Could not finish/i })).toBeVisible();
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
      instruction:
        'Please check the workspace state and continue the previous work where it left off. Additional context: Continue after documenting the failure.',
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

    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Cancelled/i })).toBeVisible();
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

    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Queued/i })).toBeVisible();
    await expect(page.getByText(/A queued task turn is ready to start/i)).toBeVisible();
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

    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Failed/i })).toBeVisible();
    // Soft failed: reopen via send or Reopen on the same task id.
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

    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Succeeded/i })).toBeVisible();
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

    await expect(page.locator('.task-chrome').getByRole('button', { name: /Task status: Waiting for you/i })).toBeVisible();
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

  test('long RFD form keeps its actions reachable', async ({ page }) => {
    // M013 S01: at 320×600 a long elicitation must wheel-scroll until Accept is
    // in the viewport and can submit the existing submitElicitation envelope.
    await page.setViewportSize({ width: 320, height: 600 });
    await openWebview(page);

    const longFields = Array.from({ length: 14 }, (_, i) => ({
      key: `field_${i + 1}`,
      type: 'string',
      title: `Long field ${i + 1}`,
      description:
        `Extra description for field ${i + 1} so the form body exceeds the short viewport ` +
        'and forces normal wheel scrolling before the action row is reachable.',
      required: false,
    }));

    await postRawHostMessage(page, {
      type: 'elicitationFormPending',
      promptId: 'elicitation-long-reach',
      message:
        'Complete this long form. Actions must remain reachable after scrolling at a compact viewport.',
      fields: longFields,
      required: [],
      askLike: true,
    });

    const accept = page.getByRole('button', { name: 'Accept' });
    await expect(accept).toBeAttached();

    // Accept starts below the fold at 320×600 with a long field list.
    await expect
      .poll(async () => {
        const box = await accept.boundingBox();
        if (!box) return false;
        return box.y + box.height > 600;
      })
      .toBe(true);

    // Normal wheel interaction (not programmatic scrollIntoView) must bring Accept into view.
    for (let i = 0; i < 24; i++) {
      await page.mouse.move(160, 300);
      await page.mouse.wheel(0, 200);
      const box = await accept.boundingBox();
      if (box && box.y >= 0 && box.y + box.height <= 600) break;
    }

    await expect
      .poll(async () => {
        const box = await accept.boundingBox();
        if (!box) return false;
        return box.y >= 0 && box.y + box.height <= 600;
      })
      .toBe(true);

    await accept.click();
    await expectPostedMessage(page, {
      type: 'submitElicitation',
      promptId: 'elicitation-long-reach',
      action: 'accept',
      content: {},
    });
  });

  test('M013 S01 flow: runtime prompt reachability', async ({ page }) => {
    // Independent S01 evidence: one assembled journey at 320×600 covering
    // long-elicitation wheel scroll + Accept, then Settings coexistence with a
    // pending runtime permission whose Allow once still submits the existing
    // envelope while policy controls stay distinct. Browser diagnostics must stay clean.
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

    await page.setViewportSize({ width: 320, height: 600 });
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m013-s01-flow', goal: 'S01 reachability flow', viewStatus: 'idle' })],
      storeRevision: 40,
    });

    // --- Phase 1: long elicitation must wheel-scroll until Accept is reachable ---
    const longFields = Array.from({ length: 14 }, (_, i) => ({
      key: `flow_field_${i + 1}`,
      type: 'string',
      title: `Flow field ${i + 1}`,
      description:
        `Extra description for flow field ${i + 1} so the form body exceeds the short viewport ` +
        'and forces normal wheel scrolling before the action row is reachable.',
      required: false,
    }));

    await postRawHostMessage(page, {
      type: 'elicitationFormPending',
      promptId: 'elicitation-m013-s01-flow',
      message:
        'Complete this long form. Actions must remain reachable after scrolling at a compact viewport.',
      fields: longFields,
      required: [],
      askLike: true,
    });

    const accept = page.getByRole('button', { name: 'Accept' });
    await expect(accept).toBeAttached();
    await expect(page.getByTestId('runtime-interaction-stack')).toBeVisible();

    // Accept starts below the fold at 320×600 with a long field list.
    await expect
      .poll(async () => {
        const box = await accept.boundingBox();
        if (!box) return false;
        return box.y + box.height > 600;
      })
      .toBe(true);

    // Normal wheel interaction (not programmatic scrollIntoView) must bring Accept into view.
    for (let i = 0; i < 24; i++) {
      await page.mouse.move(160, 300);
      await page.mouse.wheel(0, 200);
      const box = await accept.boundingBox();
      if (box && box.y >= 0 && box.y + box.height <= 600) break;
    }

    await expect
      .poll(async () => {
        const box = await accept.boundingBox();
        if (!box) return false;
        return box.y >= 0 && box.y + box.height <= 600;
      })
      .toBe(true);

    await accept.click();
    await expectPostedMessage(page, {
      type: 'submitElicitation',
      promptId: 'elicitation-m013-s01-flow',
      action: 'accept',
      content: {},
    });

    // Clear the elicitation so the stack can host the permission card alone.
    await postRawHostMessage(page, {
      type: 'elicitationCleared',
      promptId: 'elicitation-m013-s01-flow',
    });
    await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);

    // --- Phase 2: Settings open + pending runtime permission remains operable ---
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expectPostedMessage(page, { type: 'requestPermissionSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    await page.getByRole('tab', { name: /Execution/i }).click();
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('ask'),
    });
    await expect(page.getByTestId('permissions-mode-group')).toBeVisible();
    await expect(page.locator('#permission-mode-ask')).toBeChecked();

    await postRawHostMessage(page, {
      type: 'permissionPending',
      sessionId: 'sess-m013-s01-flow',
      permissionId: 'perm-m013-s01-flow',
      title: 'Write src/host/runtime-reachability.ts',
      kind: 'edit',
      classification: 'write',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Deny', kind: 'reject' },
      ],
    });

    // Runtime card stays mounted while Settings policy controls remain distinct.
    await expect(page.getByTestId('runtime-interaction-stack')).toBeVisible();
    await expect(page.getByTestId('runtime-permission-card')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Runtime permission request' })).toBeVisible();
    await expect(page.getByText('Write src/host/runtime-reachability.ts')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await expect(page.getByTestId('permissions-settings')).toBeVisible();
    await expect(page.getByTestId('permissions-mode-group')).toBeVisible();
    await expect(page.getByTestId('permissions-runtime-note')).toContainText(
      'This tab only configures the default policy mode',
    );

    // Scoped Allow once submits the existing permission envelope while Settings stays open.
    await page.getByRole('button', { name: 'Allow once' }).click();
    await expectPostedMessage(page, {
      type: 'submitPermission',
      permissionId: 'perm-m013-s01-flow',
      optionId: 'allow-once',
      remember: false,
    });

    // Policy controls remain distinct from the runtime action that just fired.
    await expect(page.getByTestId('permissions-mode-group')).toBeVisible();
    await expect(page.locator('#permission-mode-ask')).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Browser diagnostics must stay clean for the assembled journey.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
  });

  test('accessible prompt labels associate Ask and Elicitation controls with visible titles', async ({
    page,
  }) => {
    // M013 S02 / T01: controls are reachable by their visible accessible names,
    // descriptions are programmatically associated, and the first useful control
    // receives focus on appearance without trapping Tab.
    await openWebview(page);

    // --- Elicitation form: named string field + associated description ---
    await postRawHostMessage(page, {
      type: 'elicitationFormPending',
      promptId: 'elicitation-a11y-labels',
      message: 'Provide the deployment settings.',
      fields: [
        {
          key: 'service_name',
          type: 'string',
          title: 'Service name',
          description: 'DNS-safe name used in the deployment manifest.',
          required: true,
        },
        {
          key: 'replica_count',
          type: 'number',
          title: 'Replica count',
          description: 'How many instances should run.',
          required: true,
        },
      ],
      required: ['service_name', 'replica_count'],
      askLike: true,
    });

    await expect(page.getByText('Agent question')).toBeVisible();

    const serviceName = page.getByRole('textbox', { name: 'Service name', exact: true });
    const replicaCount = page.getByRole('spinbutton', { name: 'Replica count', exact: true });
    await expect(serviceName).toBeVisible();
    await expect(replicaCount).toBeVisible();

    // Description association: control's aria-describedby resolves to visible description text.
    await expect
      .poll(async () =>
        serviceName.evaluate((el) => {
          const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
          return ids
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ');
        }),
      )
      .toContain('DNS-safe name used in the deployment manifest.');

    // Prompt appearance focuses the first useful control (no focus trap asserted).
    await expectControlFocused(serviceName);

    // Tab must still be able to leave the first field (escape without a trap).
    await page.keyboard.press('Tab');
    await expect
      .poll(async () => controlHasFocus(serviceName))
      .toBe(false);

    // Clear elicitation so the Ask card can take over the stack.
    await postRawHostMessage(page, {
      type: 'elicitationCleared',
      promptId: 'elicitation-a11y-labels',
    });
    await expect(page.getByRole('textbox', { name: 'Service name', exact: true })).toHaveCount(0);

    // --- Ask card: free-text control named by the visible prompt ---
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-a11y-ask', goal: 'Answer named ask', viewStatus: 'waiting_user' })],
      focusedTaskId: 'task-a11y-ask',
      subtree: [task({ id: 'task-a11y-ask', goal: 'Answer named ask', viewStatus: 'waiting_user' })],
      transcript: [],
      activeTurnId: 'turn-a11y-ask',
      pendingAsk: {
        turnId: 'turn-a11y-ask',
        askId: 'ask-a11y-labels',
        questions: [
          {
            prompt: 'Deployment environment?',
            allowFreeText: true,
          },
        ],
      },
      storeRevision: 70,
    });

    await expect(page.getByText('Agent question')).toBeVisible();
    const askField = page.getByRole('textbox', { name: 'Deployment environment?', exact: true });
    await expect(askField).toBeVisible();
    await expectControlFocused(askField);

    // Tab escape: focus leaves the free-text control without a trap.
    await page.keyboard.press('Tab');
    await expect.poll(async () => controlHasFocus(askField)).toBe(false);
  });

  test('invalid prompt field focus announces required errors on the first invalid control', async ({
    page,
  }) => {
    // M013 S02 / T01: required-field validation exposes aria-invalid + aria-describedby
    // error association and moves focus to the first invalid field.
    await openWebview(page);

    await postRawHostMessage(page, {
      type: 'elicitationFormPending',
      promptId: 'elicitation-a11y-invalid',
      message: 'Fill every required field before continuing.',
      fields: [
        {
          key: 'service_name',
          type: 'string',
          title: 'Service name',
          description: 'DNS-safe name used in the deployment manifest.',
          required: true,
        },
        {
          key: 'replica_count',
          type: 'number',
          title: 'Replica count',
          required: true,
        },
      ],
      required: ['service_name', 'replica_count'],
      askLike: true,
    });

    const serviceName = page.getByRole('textbox', { name: 'Service name', exact: true });
    const replicaCount = page.getByRole('spinbutton', { name: 'Replica count', exact: true });
    await expect(serviceName).toBeVisible();
    await expect(replicaCount).toBeVisible();

    // Submit empty required form — must not post submitElicitation.
    await page.getByRole('button', { name: 'Accept' }).click();
    expect(
      (await postedMessages(page)).filter(
        (message) => (message as { type?: string }).type === 'submitElicitation',
      ),
    ).toHaveLength(0);

    await expect(page.getByRole('alert').getByText('Service name is required.')).toBeVisible();

    // First invalid control exposes invalid state + error association.
    await expect(serviceName).toHaveAttribute('aria-invalid', 'true');
    await expect
      .poll(async () =>
        serviceName.evaluate((el) => {
          const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
          return ids
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ');
        }),
      )
      .toMatch(/Service name is required/i);

    // Focus moves to the first invalid field after client validation.
    await expectControlFocused(serviceName);

    // Second field is also invalid but must not steal focus from the first.
    await expect(replicaCount).toHaveAttribute('aria-invalid', 'true');

    // --- Ask free-text required validation ---
    await postRawHostMessage(page, {
      type: 'elicitationCleared',
      promptId: 'elicitation-a11y-invalid',
    });
    await expect(page.getByRole('textbox', { name: 'Service name', exact: true })).toHaveCount(0);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-a11y-invalid', goal: 'Answer invalid ask', viewStatus: 'waiting_user' })],
      focusedTaskId: 'task-a11y-invalid',
      subtree: [task({ id: 'task-a11y-invalid', goal: 'Answer invalid ask', viewStatus: 'waiting_user' })],
      transcript: [],
      activeTurnId: 'turn-a11y-invalid',
      pendingAsk: {
        turnId: 'turn-a11y-invalid',
        askId: 'ask-a11y-invalid',
        questions: [
          {
            prompt: 'Deployment environment?',
            allowFreeText: true,
          },
        ],
      },
      storeRevision: 71,
    });

    const askField = page.getByRole('textbox', { name: 'Deployment environment?', exact: true });
    await expect(askField).toBeVisible();

    // Empty free-text Accept must block and focus the invalid field.
    await page.getByRole('button', { name: 'Accept' }).click();
    expect(
      (await postedMessages(page)).filter(
        (message) => (message as { type?: string }).type === 'submitAsk',
      ),
    ).toHaveLength(0);

    await expect(page.getByRole('alert').getByText(/Deployment environment\?/i)).toBeVisible();
    await expect(askField).toHaveAttribute('aria-invalid', 'true');
    await expect
      .poll(async () =>
        askField.evaluate((el) => {
          const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
          return ids
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ');
        }),
      )
      .toMatch(/required/i);
    await expectControlFocused(askField);

    // --- Multi-option required/invalid state on checkboxes (not role=group) ---
    // Snapshot omits pendingAsk so the protocol clears the free-text Ask card.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-a11y-invalid', goal: 'Answer invalid ask', viewStatus: 'waiting_user' })],
      focusedTaskId: 'task-a11y-invalid',
      subtree: [task({ id: 'task-a11y-invalid', goal: 'Answer invalid ask', viewStatus: 'waiting_user' })],
      transcript: [],
      activeTurnId: 'turn-a11y-invalid',
      storeRevision: 72,
    });
    await expect(page.getByRole('textbox', { name: 'Deployment environment?', exact: true })).toHaveCount(0);

    await postRawHostMessage(page, {
      type: 'elicitationFormPending',
      promptId: 'elicitation-a11y-multi',
      message: 'Pick every required multi-option field.',
      fields: [
        {
          key: 'targets',
          type: 'multiEnum',
          title: 'Deploy targets',
          description: 'Select one or more environments.',
          options: ['Staging', 'Production'],
          required: true,
        },
      ],
      required: ['targets'],
      askLike: true,
    });

    const multiGroup = page.getByRole('group', { name: 'Deploy targets' });
    const multiStaging = page.getByRole('checkbox', { name: 'Staging', exact: true });
    await expect(multiGroup).toBeVisible();
    await expect(multiStaging).toBeVisible();
    await expect(multiStaging).toHaveAttribute('aria-required', 'true');
    // Unsupported on role=group — required/invalid live on the checkboxes.
    await expect(multiGroup).not.toHaveAttribute('aria-required', 'true');
    await expect(multiGroup).not.toHaveAttribute('aria-invalid', 'true');

    await page.getByRole('button', { name: 'Accept' }).click();
    expect(
      (await postedMessages(page)).filter(
        (message) => (message as { type?: string }).type === 'submitElicitation',
      ),
    ).toHaveLength(0);
    await expect(page.getByRole('alert').getByText('Deploy targets is required.')).toBeVisible();
    await expect(multiStaging).toHaveAttribute('aria-invalid', 'true');
    await expect(multiGroup).not.toHaveAttribute('aria-invalid', 'true');
    await expectControlFocused(multiStaging);

    await postRawHostMessage(page, {
      type: 'elicitationCleared',
      promptId: 'elicitation-a11y-multi',
    });
    await expect(page.getByRole('group', { name: 'Deploy targets' })).toHaveCount(0);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-a11y-multi-ask', goal: 'Answer multi ask', viewStatus: 'waiting_user' })],
      focusedTaskId: 'task-a11y-multi-ask',
      subtree: [task({ id: 'task-a11y-multi-ask', goal: 'Answer multi ask', viewStatus: 'waiting_user' })],
      transcript: [],
      activeTurnId: 'turn-a11y-multi-ask',
      pendingAsk: {
        turnId: 'turn-a11y-multi-ask',
        askId: 'ask-a11y-multi',
        questions: [
          {
            prompt: 'Which regions?',
            options: ['us-east', 'eu-west'],
            multiSelect: true,
          },
        ],
      },
      storeRevision: 73,
    });

    const askMultiGroup = page.getByRole('group', { name: 'Which regions?' });
    const askMultiOption = page.getByRole('checkbox', { name: 'us-east', exact: true });
    await expect(askMultiGroup).toBeVisible();
    await expect(askMultiOption).toHaveAttribute('aria-required', 'true');
    await expect(askMultiGroup).not.toHaveAttribute('aria-required', 'true');
    await expect(askMultiGroup).not.toHaveAttribute('aria-invalid', 'true');

    await page.getByRole('button', { name: 'Accept' }).click();
    expect(
      (await postedMessages(page)).filter(
        (message) => (message as { type?: string }).type === 'submitAsk',
      ),
    ).toHaveLength(0);
    await expect(page.getByRole('alert').getByText(/Which regions\?/i)).toBeVisible();
    await expect(askMultiOption).toHaveAttribute('aria-invalid', 'true');
    await expect(askMultiGroup).not.toHaveAttribute('aria-invalid', 'true');
    await expectControlFocused(askMultiOption);
  });

  test('M013 S02 flow: accessible prompt forms', async ({ page }) => {
    // Independent S02 journey: Ask + Elicitation through the real webview —
    // named controls, initial focus, keyboard nav, validation announcement,
    // first-invalid focus, corrected values, and exact outbound envelopes.
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Ignore harness asset 403/net::ERR noise from Vite/dev server.
      if (/403|Failed to load resource|net::ERR/i.test(text)) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText ?? 'unknown';
      // Ignore harness asset 403/net::ERR noise from Vite/dev server.
      if (/403|ERR_ABORTED|net::ERR/i.test(failure) || /403/.test(req.url())) return;
      if (/favicon|sourcemap/i.test(req.url())) return;
      failedRequests.push(`${req.method()} ${req.url()} ${failure}`);
    });

    await openWebview(page);

    // --- Phase 1: Elicitation form accessibility + submit envelope ---
    await postRawHostMessage(page, {
      type: 'elicitationFormPending',
      promptId: 'elicitation-m013-s02-flow',
      message: 'Provide the deployment settings for S02.',
      fields: [
        {
          key: 'service_name',
          type: 'string',
          title: 'Service name',
          description: 'DNS-safe name used in the deployment manifest.',
          required: true,
        },
        {
          key: 'replica_count',
          type: 'number',
          title: 'Replica count',
          description: 'How many instances should run.',
          required: true,
        },
      ],
      required: ['service_name', 'replica_count'],
      askLike: true,
    });

    await expect(page.getByText('Agent question')).toBeVisible();
    const serviceName = page.getByRole('textbox', { name: 'Service name', exact: true });
    const replicaCount = page.getByRole('spinbutton', { name: 'Replica count', exact: true });
    await expect(serviceName).toBeVisible();
    await expect(replicaCount).toBeVisible();

    // Initial focus lands on the first useful control.
    await expectControlFocused(serviceName);

    // Description association via aria-describedby.
    await expect
      .poll(async () =>
        serviceName.evaluate((el) => {
          const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
          return ids
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ');
        }),
      )
      .toContain('DNS-safe name used in the deployment manifest.');

    // Keyboard navigation: Tab escapes the first field (no trap).
    await page.keyboard.press('Tab');
    await expect.poll(async () => controlHasFocus(serviceName)).toBe(false);

    // Empty Accept: block submit, announce associated error, focus first invalid.
    await page.getByRole('button', { name: 'Accept' }).click();
    expect(
      (await postedMessages(page)).filter(
        (message) => (message as { type?: string }).type === 'submitElicitation',
      ),
    ).toHaveLength(0);
    await expect(page.getByRole('alert').getByText('Service name is required.')).toBeVisible();
    await expect(serviceName).toHaveAttribute('aria-invalid', 'true');
    await expect
      .poll(async () =>
        serviceName.evaluate((el) => {
          const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
          return ids
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ');
        }),
      )
      .toMatch(/Service name is required/i);
    await expectControlFocused(serviceName);
    await expect(replicaCount).toHaveAttribute('aria-invalid', 'true');

    // Correct values and submit exact existing envelope.
    await serviceName.fill('m013-s02-service');
    await replicaCount.fill('3');
    await page.getByRole('button', { name: 'Accept' }).click();
    await expectPostedMessage(page, {
      type: 'submitElicitation',
      promptId: 'elicitation-m013-s02-flow',
      action: 'accept',
      content: {
        service_name: 'm013-s02-service',
        replica_count: 3,
      },
    });

    // Clear elicitation so Ask can take the stack.
    await postRawHostMessage(page, {
      type: 'elicitationCleared',
      promptId: 'elicitation-m013-s02-flow',
    });
    await expect(page.getByRole('textbox', { name: 'Service name', exact: true })).toHaveCount(0);

    // --- Phase 2: Ask card accessibility + submit envelope ---
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({ id: 'task-m013-s02-flow', goal: 'Answer S02 ask', viewStatus: 'waiting_user' }),
      ],
      focusedTaskId: 'task-m013-s02-flow',
      subtree: [
        task({ id: 'task-m013-s02-flow', goal: 'Answer S02 ask', viewStatus: 'waiting_user' }),
      ],
      transcript: [],
      activeTurnId: 'turn-m013-s02-flow',
      pendingAsk: {
        turnId: 'turn-m013-s02-flow',
        askId: 'ask-m013-s02-flow',
        questions: [
          {
            prompt: 'Deployment environment?',
            allowFreeText: true,
          },
        ],
      },
      storeRevision: 80,
    });

    await expect(page.getByText('Agent question')).toBeVisible();
    const askField = page.getByRole('textbox', { name: 'Deployment environment?', exact: true });
    await expect(askField).toBeVisible();
    await expectControlFocused(askField);

    // Tab escape without a trap.
    await page.keyboard.press('Tab');
    await expect.poll(async () => controlHasFocus(askField)).toBe(false);

    // Empty Accept: block submitAsk, announce associated error, focus invalid field.
    await page.getByRole('button', { name: 'Accept' }).click();
    expect(
      (await postedMessages(page)).filter(
        (message) => (message as { type?: string }).type === 'submitAsk',
      ),
    ).toHaveLength(0);
    await expect(page.getByRole('alert').getByText(/Deployment environment\?/i)).toBeVisible();
    await expect(askField).toHaveAttribute('aria-invalid', 'true');
    await expect
      .poll(async () =>
        askField.evaluate((el) => {
          const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
          return ids
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ');
        }),
      )
      .toMatch(/required/i);
    await expectControlFocused(askField);

    // Correct value and submit exact existing envelope (no answer body logging).
    await askField.fill('staging');
    await page.getByRole('button', { name: 'Accept' }).click();
    await expectPostedMessage(page, {
      type: 'submitAsk',
      taskId: 'task-m013-s02-flow',
      turnId: 'turn-m013-s02-flow',
      askId: 'ask-m013-s02-flow',
      answers: {
        '0': {
          selected: [],
          freeText: 'staging',
        },
      },
    });

    // Focused console / network diagnostics must stay clean for the assembled journey.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
  });

  test('M013 S03 flow: composer motion and compact controls', async ({ page }) => {
    // Independent S03 evidence: one assembled journey at 320px covering composer
    // combobox/listbox semantics with active-descendant selection, reduced-motion
    // streaming cursor (no infinite blink), and practical ≥28×28 toolbar icon hit
    // areas without document horizontal overflow. Browser diagnostics must stay clean.
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Vite/dev asset 403s are harness noise, not product regressions.
      if (/status of 403|Failed to load resource|403|net::ERR/i.test(text)) return;
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

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: 720 });
    await openWebview(page);

    // --- Phase 1: compact toolbar icons ≥28×28 with no horizontal overflow ---
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 'task-m013-s03-flow',
          goal: 'S03 composer motion and compact controls',
          viewStatus: 'idle',
        }),
      ],
      focusedTaskId: 'task-m013-s03-flow',
      subtree: [
        task({
          id: 'task-m013-s03-flow',
          goal: 'S03 composer motion and compact controls',
          viewStatus: 'idle',
        }),
      ],
      transcript: [{ id: 'msg-m013-s03-flow-ready', kind: 'assistant', content: 'S03 flow ready.' }],
      storeRevision: 1401,
    });
    await expect(page.getByText('S03 flow ready.')).toBeVisible();

    const toolbarIcons = page.locator(
      'button.icon-btn[aria-label="Back to tasks list"], button.icon-btn[aria-label="History (previous coordinator tasks)"], button.icon-btn[aria-label="New task"], button.icon-btn[aria-label="Export task/chat"], button.icon-btn[aria-label="Settings"]',
    );
    await expect(toolbarIcons).toHaveCount(5);

    const boxes = await toolbarIcons.evaluateAll((els) =>
      els.map((el) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        return {
          label: el.getAttribute('aria-label') ?? '(unlabeled)',
          width: box.width,
          height: box.height,
        };
      }),
    );
    for (const box of boxes) {
      expect(
        box.width,
        `${box.label} width ${box.width}px must be ≥ 28 CSS px`,
      ).toBeGreaterThanOrEqual(28);
      expect(
        box.height,
        `${box.label} height ${box.height}px must be ≥ 28 CSS px`,
      ).toBeGreaterThanOrEqual(28);
    }

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return {
        docOk: doc.scrollWidth <= doc.clientWidth + 1,
        bodyOk: body.scrollWidth <= body.clientWidth + 1,
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
      };
    });
    expect(
      overflow.docOk && overflow.bodyOk,
      `document horizontal overflow at 320px: ${JSON.stringify(overflow)}`,
    ).toBe(true);

    // --- Phase 2: reduced-motion streaming cursor must not blink infinitely ---
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 'task-m013-s03-flow',
          goal: 'S03 composer motion and compact controls',
          viewStatus: 'running',
        }),
      ],
      focusedTaskId: 'task-m013-s03-flow',
      subtree: [
        task({
          id: 'task-m013-s03-flow',
          goal: 'S03 composer motion and compact controls',
          viewStatus: 'running',
        }),
      ],
      transcript: [],
      activeTurnId: 'turn-m013-s03-flow',
      storeRevision: 1402,
    });

    await postRawHostMessage(page, {
      type: 'turnStart',
      taskId: 'task-m013-s03-flow',
      turnId: 'turn-m013-s03-flow',
    });
    await postRawHostMessage(page, {
      type: 'event',
      taskId: 'task-m013-s03-flow',
      turnId: 'turn-m013-s03-flow',
      event: {
        type: 'assistantDelta',
        content: 'Streaming under reduced motion for S03 flow…',
        messageId: 'msg-m013-s03-flow-stream',
      },
    });

    const cursor = page.locator('.streaming-cursor');
    await expect(cursor).toBeVisible();
    await expect(cursor).toHaveText('▋');

    const motion = await cursor.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationIterationCount: style.animationIterationCount,
        animationPlayState: style.animationPlayState,
      };
    });
    const noInfiniteBlink =
      motion.animationName === 'none' ||
      motion.animationDuration === '0s' ||
      motion.animationIterationCount === '0' ||
      motion.animationPlayState === 'paused';
    expect(
      noInfiniteBlink,
      `expected reduced-motion to disable infinite blink, got ${JSON.stringify(motion)}`,
    ).toBe(true);

    // --- Phase 3: composer file suggestions expose valid combobox semantics ---
    // Return to an idle task so the native composer is available for @ mentions.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 'task-m013-s03-flow',
          goal: 'S03 composer motion and compact controls',
          viewStatus: 'idle',
        }),
      ],
      focusedTaskId: 'task-m013-s03-flow',
      subtree: [
        task({
          id: 'task-m013-s03-flow',
          goal: 'S03 composer motion and compact controls',
          viewStatus: 'idle',
        }),
      ],
      transcript: [
        {
          id: 'msg-m013-s03-flow-idle',
          kind: 'assistant',
          content: 'Ready for composer suggestions.',
        },
      ],
      storeRevision: 1403,
    });
    await expect(page.getByText('Ready for composer suggestions.')).toBeVisible();

    const composer = page.locator('.composer-input__textarea').first();
    await composer.click();
    await expect(composer).toBeFocused();

    await expect(composer).toHaveAttribute('role', 'combobox');
    await expect(composer).toHaveAttribute('aria-autocomplete', 'list');
    await expect(composer).toHaveAttribute('aria-haspopup', 'listbox');
    await expect(composer).toHaveAttribute('aria-expanded', 'false');
    await expect(composer).not.toHaveAttribute('aria-activedescendant');

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
    };

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
      ],
    });

    const listbox = page.getByRole('listbox', { name: 'File mention suggestions' });
    await expect(listbox).toBeVisible();
    await expect(composer).toHaveAttribute('role', 'combobox');
    await expect(composer).toHaveAttribute('aria-expanded', 'true');
    await expect(composer).toHaveAttribute('aria-controls', 'file-mention-listbox');
    await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-0');
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');

    await composer.press('ArrowDown');
    await expect(composer).toHaveAttribute('aria-activedescendant', 'file-mention-option-1');
    await expect(listbox.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');

    // Compact layout still holds after opening suggestions.
    const overflowAfter = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return {
        docOk: doc.scrollWidth <= doc.clientWidth + 1,
        bodyOk: body.scrollWidth <= body.clientWidth + 1,
      };
    });
    expect(
      overflowAfter.docOk && overflowAfter.bodyOk,
      `document horizontal overflow after suggestions: ${JSON.stringify(overflowAfter)}`,
    ).toBe(true);

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
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

  test('M012 S01 retention regression: Settings panel edits host-backed retention values without losing task or chat state', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-settings', goal: 'Keep chat state visible', viewStatus: 'idle' })],
      storeRevision: 10,
    });

    await expect(page.getByPlaceholder('Search tasks…')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('status').getByText('Loading history and output settings from VS Code…')).toBeVisible();
    // Full-view Settings replaces the task list (not an overlay).
    await expect(page.getByPlaceholder('Search tasks…')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Back to tasks' })).toBeVisible();

    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({
        maxRetainedTurnsPerTask: 200,
        maxStoredOutputChars: 200000,
      }),
    });

    // Once the snapshot loads, the loading status is replaced by the editable fields.
    await expect(page.getByText('Loading history and output settings from VS Code…')).toHaveCount(0);
    await expect(page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true })).toHaveValue('200');
    await expect(page.getByRole('spinbutton', { name: 'Stored output per turn', exact: true })).toHaveValue('200000');
    await expect(page.getByText('Min 1 · Default 200')).toBeVisible();
    await expect(page.getByText('Min 1024 · Default 200000')).toBeVisible();

    await page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true }).fill('0');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expect(page.getByRole('alert').getByText('Retained turns per completed task must be at least 1.')).toBeVisible();
    await expect.poll(async () => (await postedMessages(page)).filter((message) => (message as { type?: string }).type === 'updateSetting')).toHaveLength(0);

    await page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true }).fill('201');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'maxRetainedTurnsPerTask', value: 201 });
    await expect(page.getByText('Saving Retained turns per completed task…')).toBeVisible();

    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 201 },
    });
    await expect(page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true })).toHaveValue('201');
    await expect(page.getByText('Saved Retained turns per completed task.')).toBeVisible();

    await page.getByRole('spinbutton', { name: 'Stored output per turn', exact: true }).fill('250000');
    await page.getByRole('button', { name: 'Save Stored output per turn' }).click();
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
    await expect(page.getByTestId('data-local-error')).toBeVisible();
    await expect(page.getByTestId('data-local-error')).toContainText('Outputs save failed');
    await expect(page.getByRole('alert').getByText('Unable to save Stored output per turn. Check the VS Code setting and try again.')).toBeVisible();
    await expect(page.getByText('leaked stack trace')).toHaveCount(0);
    // Failed save keeps the attempted draft (does not rehydrate back to prior saved).
    await expect(page.getByRole('spinbutton', { name: 'Stored output per turn', exact: true })).toHaveValue('250000');

    await page.setViewportSize({ width: 360, height: 720 });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Stored output per turn' })).toBeVisible();
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // Full-view Settings hides chat until Back.
    await expect(page.getByText('Chat context remains visible.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to tasks' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByText('Chat context remains visible.')).toBeVisible();
    await expect(page.getByRole('alert').getByText('Host command remains visible.')).toBeVisible();
  });

  test('M012 S01 semantics: Settings tablist exposes three domains with ARIA relationships and keyboard activation', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m012-sem', goal: 'Topic shell smoke', viewStatus: 'idle' })],
      storeRevision: 12,
    });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({
        maxRetainedTurnsPerTask: 200,
        maxStoredOutputChars: 200000,
      }),
    });

    const tablist = page.getByRole('tablist', { name: 'Settings domains' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText(/Agents/i);
    await expect(tabs.nth(1)).toHaveText(/Execution/i);
    await expect(tabs.nth(2)).toHaveText(/Data/i);

    const agentsTab = page.getByRole('tab', { name: /Agents/i });
    await expect(agentsTab).toHaveAttribute('aria-selected', 'true');
    await expect(agentsTab).toHaveAttribute('tabindex', '0');
    await expect(agentsTab).toHaveAttribute('id', 'settings-tab-agents');
    await expect(agentsTab).toHaveAttribute('aria-controls', 'settings-panel-agents');
    const agentsPanel = page.locator('#settings-panel-agents');
    await expect(agentsPanel).toBeVisible();
    await expect(agentsPanel).toHaveAttribute('role', 'tabpanel');
    await expect(agentsPanel).toHaveAttribute('aria-labelledby', 'settings-tab-agents');
    await expect(page.getByRole('heading', { name: 'Task profiles' })).toBeVisible();

    for (const name of [/Execution/i, /Data/i]) {
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false');
      await expect(page.getByRole('tab', { name })).toHaveAttribute('tabindex', '-1');
    }

    await page.getByRole('tab', { name: /Execution/i }).click();
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#settings-panel-execution')).toBeVisible();
    await expect(page.getByTestId('execution-run-limits')).toBeVisible();
    await expect(page.getByTestId('permissions-settings')).toBeVisible();
    await expect(page.getByTestId('permissions-runtime-note')).toContainText(
      'Runtime permission prompts still appear as in-session permission cards',
    );

    const executionTab = page.getByRole('tab', { name: /Execution/i });
    await executionTab.focus();
    await executionTab.press('ArrowRight');
    const dataTab = page.getByRole('tab', { name: /Data/i });
    await expect(dataTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#settings-panel-data')).toBeVisible();
    await expect(page.getByTestId('data-settings')).toBeVisible();
    await expect(page.getByRole('region', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Outputs' })).toBeVisible();

    await dataTab.press('End');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: /Data/i }).press('Home');
    const agentsTabAfterHome = page.getByRole('tab', { name: /Agents/i });
    await expect(agentsTabAfterHome).toHaveAttribute('aria-selected', 'true');

    await agentsTabAfterHome.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
  });

  test('M012 S01 semantics: only the three actionable domains render with no reserved/placeholder navigation', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m012-soon', goal: 'Domain shell', viewStatus: 'idle' })],
      storeRevision: 13,
    });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });

    const tablist = page.getByRole('tablist', { name: 'Settings domains' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText(/Agents/i);
    await expect(tabs.nth(1)).toHaveText(/Execution/i);
    await expect(tabs.nth(2)).toHaveText(/Data/i);

    // No reserved/placeholder navigation and no "Coming soon" affordance anywhere.
    await expect(page.getByText('Coming soon')).toHaveCount(0);
    for (const gone of [/Connections/i, /Models and CLIs/i, /Context and MCP/i]) {
      await expect(page.getByRole('tab', { name: gone })).toHaveCount(0);
    }

    // Opening Settings emits only the legit request/catalog messages — no mutations.
    const legitTypes = new Set([
      'requestSettings',
      'requestTaskTypesSettings',
      'requestPermissionSettings',
      'listBackends',
      'listModels',
    ]);
    const mutationTypes = new Set([
      'updateSetting',
      'updateTaskTypes',
      'updatePermissionSettings',
      'setComposerSelection',
      'send',
      'focusTask',
    ]);
    const opened = await postedMessages(page);
    for (const message of opened) {
      const type = (message as { type?: string }).type ?? '';
      expect(mutationTypes.has(type)).toBe(false);
      if (type) expect(legitTypes.has(type)).toBe(true);
    }

    const baseline = await postedMessages(page);
    const baselineCount = baseline.length;

    // Navigate across all three tabs by mouse then keyboard — zero additional mutations.
    for (const name of [/Execution/i, /Data/i, /Agents/i]) {
      await page.getByRole('tab', { name }).click();
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    }
    const agentsTab = page.getByRole('tab', { name: /Agents/i });
    await agentsTab.focus();
    await agentsTab.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: /Execution/i }).press('End');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: /Data/i }).press('Home');
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('aria-selected', 'true');

    const after = await postedMessages(page);
    const extra = after.slice(baselineCount).filter((message) => mutationTypes.has((message as { type?: string }).type ?? ''));
    expect(extra).toEqual([]);
    await expect(page.getByText('Coming soon')).toHaveCount(0);
  });

  test('M012 S01 flow: Settings entry opens tab shell; mouse/keyboard traverse all topics; 320px keeps forms contained', async ({
    page,
  }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m012-flow', goal: 'Flow proof shell', viewStatus: 'idle' })],
      storeRevision: 14,
    });

    // Real Settings entry point (toolbar), not a CSS-only harness.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    const tablist = page.getByRole('tablist', { name: 'Settings domains' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(3);

    const topicOrder = [
      { name: /Agents/i, id: 'agents', panel: 'settings-panel-agents' },
      { name: /Execution/i, id: 'execution', panel: 'settings-panel-execution' },
      { name: /Data/i, id: 'data', panel: 'settings-panel-data' },
    ] as const;

    // Mouse: visit every topic in order and assert ARIA relationships + single live panel.
    for (const topic of topicOrder) {
      const tab = page.getByRole('tab', { name: topic.name });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(tab).toHaveAttribute('tabindex', '0');
      await expect(tab).toHaveAttribute('id', `settings-tab-${topic.id}`);
      await expect(tab).toHaveAttribute('aria-controls', topic.panel);
      const panel = page.locator(`#${topic.panel}`);
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('role', 'tabpanel');
      await expect(panel).toHaveAttribute('aria-labelledby', `settings-tab-${topic.id}`);
      await expect(page.getByRole('tabpanel')).toHaveCount(1);
      for (const other of topicOrder) {
        if (other.id === topic.id) continue;
        await expect(page.getByRole('tab', { name: other.name })).toHaveAttribute('aria-selected', 'false');
        await expect(page.getByRole('tab', { name: other.name })).toHaveAttribute('tabindex', '-1');
        await expect(page.locator(`#${other.panel}`)).toHaveCount(0);
      }
    }

    // Keyboard: ArrowLeft / ArrowRight wraparound, Home, End from the active tab.
    const dataTab = page.getByRole('tab', { name: /Data/i });
    await dataTab.focus();
    await expect(dataTab).toBeFocused();
    await dataTab.press('ArrowRight');
    const agentsTab = page.getByRole('tab', { name: /Agents/i });
    await expect(agentsTab).toHaveAttribute('aria-selected', 'true');
    await expect(agentsTab).toBeFocused();

    await agentsTab.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /Data/i })).toBeFocused();

    await page.getByRole('tab', { name: /Data/i }).press('Home');
    await expect(agentsTab).toHaveAttribute('aria-selected', 'true');
    await expect(agentsTab).toBeFocused();

    await agentsTab.press('End');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /Data/i })).toBeFocused();

    await page.getByRole('tab', { name: /Data/i }).press('ArrowLeft');
    const executionTab = page.getByRole('tab', { name: /Execution/i });
    await expect(executionTab).toHaveAttribute('aria-selected', 'true');
    await expect(executionTab).toBeFocused();

    await executionTab.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');

    // Tab / Shift+Tab: leave the tablist into the panel, then return; selected indicator stays.
    await page.getByRole('tab', { name: /Data/i }).click();
    const retentionTab = page.getByRole('tab', { name: /Data/i });
    await expect(retentionTab).toHaveAttribute('aria-selected', 'true');
    await retentionTab.focus();
    await page.keyboard.press('Tab');
    const retentionPanel = page.locator('#settings-panel-data');
    await expect(retentionPanel).toBeFocused();
    await expect(retentionTab).toHaveAttribute('aria-selected', 'true');
    await expect(retentionTab).toHaveClass(/settings-panel__tab--selected/);
    // Selected indicator is structural (border/box-shadow), not color-only.
    await expect
      .poll(async () =>
        retentionTab.evaluate((el) => {
          const styles = getComputedStyle(el);
          return {
            borderBottomWidth: styles.borderBottomWidth,
            boxShadow: styles.boxShadow,
            fontWeight: styles.fontWeight,
          };
        }),
      )
      .toEqual(
        expect.objectContaining({
          borderBottomWidth: expect.not.stringMatching(/^0px$/),
          boxShadow: expect.not.stringMatching(/^none$/),
        }),
      );

    await page.keyboard.press('Shift+Tab');
    await expect(retentionTab).toBeFocused();
    await expect(retentionTab).toHaveAttribute('aria-selected', 'true');

    // Return to Data with a real snapshot and usable controls.
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({
        maxRetainedTurnsPerTask: 150,
        maxStoredOutputChars: 100000,
      }),
    });
    await expect(page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true })).toHaveValue('150');
    await expect(page.getByRole('spinbutton', { name: 'Stored output per turn', exact: true })).toHaveValue(
      '100000',
    );
    await page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true }).fill('175');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'maxRetainedTurnsPerTask', value: 175 });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 175 },
    });
    await expect(page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true })).toHaveValue('175');
    await expect(page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true })).toBeEnabled();

    // Seed Task profiles so 320px containment can inspect real type cards.
    await page.getByRole('tab', { name: /Agents/i }).click();
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: {
        status: 'ok',
        diagnostics: [],
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'Default worker',
          },
        ],
        defaults: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
          },
        ],
        constraints: {
          maxTypes: 32,
          idPattern: '^[a-z][a-z0-9_-]{0,63}$',
          descriptionMax: 200,
          stringMax: 128,
          roles: ['coordinator', 'worker'],
          briefKinds: ['generic', 'investigation', 'implementation'],
        },
      },
    });
    await expect(page.locator('.type-card').first()).toBeVisible();

    // 320 CSS px: tabs stay equal-width on one no-scroll row; document/panel/forms stay contained.
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const docEl = document.documentElement;
          const body = document.body;
          const app = document.querySelector('#app');
          const panel = document.querySelector('.settings-panel');
          const tabsEl = document.querySelector('.settings-panel__tabs');
          const cards = [...document.querySelectorAll('.type-card')];
          const noHOverflow = (el: Element | null) => {
            if (!el) return false;
            const node = el as HTMLElement;
            return node.scrollWidth <= node.clientWidth + 1;
          };
          return {
            docOk: noHOverflow(docEl) && noHOverflow(body),
            appOk: noHOverflow(app),
            panelOk: noHOverflow(panel),
            cardsOk: cards.length > 0 && cards.every((card) => noHOverflow(card)),
            // Three equal-width tabs fit on one row with no horizontal scroll.
            tabsNoScroll: Boolean(tabsEl && (tabsEl as HTMLElement).scrollWidth <= (tabsEl as HTMLElement).clientWidth + 1),
            tabsNowrap: tabsEl
              ? getComputedStyle(tabsEl).flexWrap === 'nowrap' && getComputedStyle(tabsEl).overflowX === 'hidden'
              : false,
          };
        }),
      )
      .toEqual(
        expect.objectContaining({
          docOk: true,
          appOk: true,
          panelOk: true,
          cardsOk: true,
          tabsNoScroll: true,
          tabsNowrap: true,
        }),
      );

    // Data controls remain usable at 320px without panel horizontal overflow.
    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Retained turns per completed task' })).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const panel = document.querySelector('.settings-panel');
          const fields = document.querySelector('.settings-fields');
          const input = document.querySelector('#settings-maxRetainedTurnsPerTask');
          const noHOverflow = (el: Element | null) => {
            if (!el) return false;
            const node = el as HTMLElement;
            return node.scrollWidth <= node.clientWidth + 1;
          };
          return {
            panelOk: noHOverflow(panel),
            fieldsOk: noHOverflow(fields),
            inputOk: noHOverflow(input),
          };
        }),
      )
      .toEqual({ panelOk: true, fieldsOk: true, inputOk: true });

    await page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true }).fill('180');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'maxRetainedTurnsPerTask', value: 180 });
  });

  test('M012 S02 flow: Agents and Data state safety, isolation, hide/reveal, and 320px layout', async ({
    page,
  }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m012-s02', goal: 'S02 state safety', viewStatus: 'idle' })],
      storeRevision: 20,
    });

    // Real Settings entry point (toolbar).
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('aria-selected', 'true');

    // --- Task Types: ok first so drafts hydrate pristine, then empty/invalid diagnostics ---
    // (Posting empty before any hydrate would own an empty draft and block later ok hydrate.)
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        status: 'ok',
        diagnostics: [{ code: 'note', message: 'Optional note from host.' }],
      }),
    });
    await expect(page.locator('.type-status--ok')).toHaveText('Valid');
    await expect(page.getByTestId('task-types-workspace-scope')).toContainText(
      'workspace-level muster.taskTypes map',
    );
    await expect(page.getByTestId('task-types-workspace-scope')).toContainText(
      'Folder-specific resource overrides remain in native VS Code Settings',
    );
    await expect(page.getByTestId('task-types-diagnostic-ok-with-notes')).toContainText(
      'Optional note from host.',
    );
    await expect(page.locator('.type-card')).toHaveCount(1);
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'data-tab-state',
      'diagnostic',
    );
    await expect(page.getByTestId('settings-tab-indicator-agents')).toHaveText('Needs attention');

    // Empty host map: dirty drafts stay (not overwritten); diagnostic + tab badge still show.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({ status: 'empty', types: [], diagnostics: [] }),
    });
    await expect(page.locator('.type-status--empty')).toHaveText('Empty');
    await expect(page.getByTestId('task-types-diagnostic-empty')).toBeVisible();
    await expect(page.getByText(/Host map is empty/i)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Task profile ID' })).toHaveValue('worker');
    // Preserved drafts vs empty host map mark the tab dirty; diagnostic copy remains visible.
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'data-tab-state',
      'dirty',
    );

    // Invalid host map: same non-overwrite + diagnostic surface.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        status: 'invalid',
        types: [],
        diagnostics: [{ code: 'invalid_map', message: 'Type id "Bad Id" is invalid.' }],
      }),
    });
    await expect(page.locator('.type-status--invalid')).toHaveText('Invalid');
    await expect(page.getByTestId('task-types-diagnostic-invalid')).toBeVisible();
    await expect(page.getByText('Host task profiles are invalid')).toBeVisible();
    await expect(page.getByText('Type id "Bad Id" is invalid.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Task profile ID' })).toHaveValue('worker');

    // Return to a clean ok snapshot for the edit loop.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot(),
    });
    await expect(page.getByRole('textbox', { name: 'Task profile ID' })).toHaveValue('worker');
    await expect(page.locator('.type-status--ok')).toHaveText('Valid');
    // UI dirty compares drafts to the current snapshot types (not intermediate maps).
    await expect(page.getByTestId('task-types-dirty')).toHaveCount(0);

    // Add + edit + remove (draft ownership).
    await page.getByRole('button', { name: /^Add$/ }).click();
    await expect(page.locator('.type-card')).toHaveCount(2);
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'dirty');
    await expect(page.getByTestId('settings-tab-indicator-agents')).toHaveText('Unsaved');

    const newId = page.locator('.type-card').nth(1).getByRole('textbox', { name: 'Task profile ID' });
    await newId.fill('helper');
    await page.locator('.type-card').nth(1).getByRole('button', { name: 'Remove task profile' }).click();
    await expect(page.locator('.type-card')).toHaveCount(1);

    // Edit existing row description so draft stays dirty for isolation checks.
    await page.locator('#tt-desc-0').fill('Edited worker draft');
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();

    // Client rejection: empty id blocks host update.
    const updateTaskTypesBeforeReject = (await postedMessages(page)).filter(
      (m) => (m as { type?: string }).type === 'updateTaskTypes',
    ).length;
    await page.getByRole('button', { name: /^Add$/ }).click();
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByTestId('task-types-draft-error')).toHaveText('Each task profile needs an ID.');
    await expect
      .poll(async () =>
        (await postedMessages(page)).filter((m) => (m as { type?: string }).type === 'updateTaskTypes')
          .length,
      )
      .toBe(updateTaskTypesBeforeReject);
    // Fill valid id for later save.
    await page.locator('.type-card').nth(1).getByRole('textbox', { name: 'Task profile ID' }).fill('helper');
    await page.locator('.type-card').nth(1).locator('#tt-desc-1').fill('Helper type');

    // Valid save success path.
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expectPostedMessage(page, {
      type: 'updateTaskTypes',
      types: expect.arrayContaining([
        expect.objectContaining({ id: 'worker', description: 'Edited worker draft' }),
        expect.objectContaining({ id: 'helper', description: 'Helper type' }),
      ]),
    });
    await expect(page.getByRole('button', { name: /Saving/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'saving');

    await postRawHostMessage(page, {
      type: 'taskTypesSettingsUpdateResult',
      result: { ok: true },
    });
    await expect(page.getByTestId('task-types-saved')).toContainText(
      'Saved task profiles to workspace settings.',
    );
    // Force-hydrate snapshot clears dirty only after host success.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'Edited worker draft',
          },
          {
            id: 'helper',
            backend: 'opencode',
            role: 'worker',
            briefKind: 'generic',
            description: 'Helper type',
          },
        ],
      }),
    });
    await expect(page.getByTestId('task-types-dirty')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'saved');
    await expect(page.locator('.type-card')).toHaveCount(2);

    // Sanitized host failure preserves draft and prior saved snapshot.
    await page.locator('#tt-desc-0').fill('Should stay after failure');
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expectPostedMessage(page, {
      type: 'updateTaskTypes',
      types: expect.arrayContaining([
        expect.objectContaining({ id: 'worker', description: 'Should stay after failure' }),
      ]),
    });
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsUpdateResult',
      result: {
        ok: false,
        code: 'updateFailed',
        message: 'Unable to update muster.taskTypes.',
        diagnostics: [
          {
            code: 'updateFailed',
            message: 'Unable to update muster.taskTypes.',
          },
        ],
      },
    });
    await expect(page.getByTestId('task-types-save-error')).toBeVisible();
    await expect(page.getByTestId('task-types-save-error')).toContainText('Task profiles save failed');
    await expect(page.getByTestId('task-types-save-error')).toContainText(
      'Unable to update muster.taskTypes.',
    );
    await expect(page.getByText('leaked stack')).toHaveCount(0);
    await expect(page.locator('#tt-desc-0')).toHaveValue('Should stay after failure');
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'error');
    await expect(page.getByTestId('settings-tab-indicator-agents')).toHaveText('Error');

    // Stale snapshot must not overwrite dirty Task Types drafts.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'Edited worker draft',
          },
          {
            id: 'helper',
            backend: 'opencode',
            role: 'worker',
            briefKind: 'generic',
            description: 'Helper type',
          },
        ],
      }),
    });
    await expect(page.locator('#tt-desc-0')).toHaveValue('Should stay after failure');

    // Reset posts defaults as an explicit host update and keeps dirty until success.
    await page.getByRole('button', { name: /^Reset$/ }).click();
    await expectPostedMessage(page, {
      type: 'updateTaskTypes',
      types: [
        expect.objectContaining({ id: 'worker' }),
        expect.objectContaining({ id: 'coordinator' }),
      ],
    });
    // Drafts still show pre-reset dirty content until force-hydrate.
    await expect(page.locator('#tt-desc-0')).toHaveValue('Should stay after failure');
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsUpdateResult',
      result: { ok: true },
    });
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        types: [
          { id: 'worker', backend: 'claude', role: 'worker', briefKind: 'generic' },
          { id: 'coordinator', backend: 'claude', role: 'coordinator', briefKind: 'generic' },
        ],
      }),
    });
    await expect(page.locator('.type-card')).toHaveCount(2);
    await expect(page.getByRole('textbox', { name: 'Task profile ID' }).first()).toHaveValue('worker');
    await expect(page.getByTestId('task-types-dirty')).toHaveCount(0);

    // Dirty Task Types again for cross-topic isolation.
    await page.locator('#tt-desc-0').fill('Isolation TT draft');
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();

    // --- Data: validation, success, failed save + draft preservation, stale snapshot ---
    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 200, maxStoredOutputChars: 200000 }),
    });
    await expect(page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true })).toHaveValue(
      '200',
    );

    // Client validation: empty / non-numeric / below-min do not post updateSetting.
    const turns = page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true });
    await turns.fill('');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expect(page.getByRole('alert').getByText('Retained turns per completed task must be a number.')).toBeVisible();
    await turns.fill('1.5');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expect(page.getByRole('alert').getByText('Retained turns per completed task must be an integer.')).toBeVisible();
    await turns.fill('0');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expect(page.getByRole('alert').getByText('Retained turns per completed task must be at least 1.')).toBeVisible();
    await expect
      .poll(async () =>
        (await postedMessages(page)).filter((m) => (m as { type?: string }).type === 'updateSetting'),
      )
      .toHaveLength(0);

    // Success path.
    await turns.fill('222');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'maxRetainedTurnsPerTask', value: 222 });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 222 },
    });
    await expect(turns).toHaveValue('222');
    await expect(page.getByTestId('data-local-success')).toContainText('Saved Retained turns per completed task.');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('data-tab-state', 'saved');

    // Failed save keeps attempted draft and prior saved snapshot authoritative.
    const chars = page.getByRole('spinbutton', { name: 'Stored output per turn', exact: true });
    await chars.fill('333333');
    await page.getByRole('button', { name: 'Save Stored output per turn' }).click();
    await expectPostedMessage(page, {
      type: 'updateSetting',
      settingId: 'maxStoredOutputChars',
      value: 333333,
    });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: {
        ok: false,
        settingId: 'maxStoredOutputChars',
        code: 'updateFailed',
        message: 'Error: leaked stack trace from vscode.workspace.getConfiguration().update',
      },
    });
    await expect(page.getByTestId('data-local-error')).toBeVisible();
    await expect(page.getByTestId('data-local-error')).toContainText('Outputs save failed');
    await expect(page.getByTestId('data-local-error')).toContainText(
      'Unable to save Stored output per turn. Check the VS Code setting and try again.',
    );
    await expect(page.getByText('leaked stack trace')).toHaveCount(0);
    await expect(chars).toHaveValue('333333');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('data-tab-state', 'error');
    await expect(page.getByTestId('settings-tab-indicator-data')).toHaveText('Error');

    // Stale snapshot refreshes saved state but cannot overwrite dirty retention draft.
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 222, maxStoredOutputChars: 200000 }),
    });
    await expect(chars).toHaveValue('333333');
    await expect(turns).toHaveValue('222');

    // --- Cross-domain isolation: drafts, dirty indicators, and domain-local errors ---
    // Data still dirty+error; Agents dirty from Isolation TT draft.
    await page.getByRole('tab', { name: /Agents/i }).click();
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tt-desc-0')).toHaveValue('Isolation TT draft');
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();
    await expect(page.getByTestId('task-types-save-error')).toHaveCount(0);
    await expect(page.getByTestId('data-local-error')).toHaveCount(0);
    // Hidden Data still shows error indicator on its tab.
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('data-tab-state', 'error');
    await expect(page.getByTestId('settings-tab-indicator-data')).toHaveText('Error');
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'dirty');

    // Inject Agents error while Data error remains on its tab.
    await page.getByRole('button', { name: /^Save$/ }).click();
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsUpdateResult',
      result: {
        ok: false,
        code: 'updateFailed',
        message: 'Unable to update muster.taskTypes.',
      },
    });
    await expect(page.getByTestId('task-types-save-error')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'error');

    // Switch repeatedly — both topic indicators and drafts remain isolated.
    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(chars).toHaveValue('333333');
    await expect(page.getByTestId('data-local-error')).toBeVisible();
    await expect(page.getByTestId('task-types-save-error')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'error');

    await page.getByRole('tab', { name: /Execution/i }).click();
    await expect(page.getByTestId('permissions-settings')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'error');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('data-tab-state', 'error');

    await page.getByRole('tab', { name: /Agents/i }).click();
    await expect(page.locator('#tt-desc-0')).toHaveValue('Isolation TT draft');
    await expect(page.getByTestId('task-types-save-error')).toBeVisible();

    // --- Hide/reveal: capture getState bag, re-open webview, restore drafts + active topic ---
    // Seed unrelated bag keys so merge-not-replace is proven.
    await page.evaluate(() => {
      const api = window.acquireVsCodeApi();
      const prev = (api.getState?.() as Record<string, unknown> | undefined) ?? {};
      api.setState?.({
        ...prev,
        'muster.sendOutbox.v1': [{ clientRequestId: 'outbox-keep', status: 'pending' }],
        'muster.composerSelection.v1': { backend: 'claude', model: 'sonnet' },
      });
    });
    const capturedState = await readVsCodeState(page);
    // Settings bag key is v3; assert isolation-critical keys (extra draft fields OK).
    const bag = capturedState as Record<string, unknown>;
    const settingsKey = Object.keys(bag ?? {}).find((k) => k.startsWith('muster.settingsView.'));
    expect(settingsKey).toBeTruthy();
    const settingsView = bag[settingsKey!] as Record<string, unknown>;
    expect(settingsView?.activeTopicId).toBe('agents');
    const typeDrafts = settingsView?.taskTypeDrafts as Array<Record<string, unknown>>;
    expect(
      typeDrafts?.some((d) => d.id === 'worker' && d.description === 'Isolation TT draft'),
    ).toBe(true);
    const retentionDrafts = settingsView?.retentionDrafts as Record<string, unknown>;
    expect(retentionDrafts?.maxStoredOutputChars).toBe('333333');
    const dirtyIds = settingsView?.retentionDirtySettingIds as string[] | undefined;
    if (dirtyIds) {
      expect(dirtyIds).toEqual(expect.arrayContaining(['maxStoredOutputChars']));
    }
    const outbox = bag['muster.sendOutbox.v1'] as Array<Record<string, unknown>>;
    expect(outbox?.some((e) => e.clientRequestId === 'outbox-keep')).toBe(true);
    const composerSel = bag['muster.composerSelection.v1'] as Record<string, unknown>;
    expect(composerSel?.backend).toBe('claude');

    // Unmount Settings, then fully recreate the webview with the captured bag.
    await page.getByRole('button', { name: 'Back to tasks' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);

    await openWebview(page, { initialState: capturedState });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m012-s02', goal: 'S02 state safety', viewStatus: 'idle' })],
      storeRevision: 21,
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });

    // Active topic restored to Task Types; drafts restored before host snapshots.
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('aria-selected', 'true');
    // Host snapshots arrive after restore; dirty drafts must not be overwritten.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        types: [
          { id: 'worker', backend: 'claude', role: 'worker', briefKind: 'generic' },
          { id: 'coordinator', backend: 'claude', role: 'coordinator', briefKind: 'generic' },
        ],
      }),
    });
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({
        runLimit: '4h',
        maxRetainedTurnsPerTask: 225,
        maxStoredOutputChars: 200000,
      }),
    });
    await expect(page.locator('#tt-desc-0')).toHaveValue('Isolation TT draft');
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();

    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(
      page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true }),
    ).toHaveValue('225');
    await expect(
      page.getByRole('spinbutton', { name: 'Stored output per turn', exact: true }),
    ).toHaveValue('333333');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('data-tab-state', 'dirty');

    await page.getByRole('tab', { name: /Execution/i }).click();
    await expect(
      page.getByRole('combobox', { name: 'Maximum uninterrupted agent run' }),
    ).toHaveValue('4h');
    await page.getByRole('tab', { name: /Data/i }).click();

    // Unrelated bag keys still present after settings writes during restore.
    const restoredBag = (await readVsCodeState(page)) as Record<string, unknown>;
    const restoredOutbox = restoredBag['muster.sendOutbox.v1'] as Array<Record<string, unknown>>;
    expect(restoredOutbox?.some((e) => e.clientRequestId === 'outbox-keep')).toBe(true);
    const restoredComposer = restoredBag['muster.composerSelection.v1'] as Record<string, unknown>;
    expect(restoredComposer?.backend).toBe('claude');
    const restoredSettingsKey = Object.keys(restoredBag ?? {}).find((k) =>
      k.startsWith('muster.settingsView.'),
    );
    expect(restoredSettingsKey).toBeTruthy();
    const restoredSettings = restoredBag[restoredSettingsKey!] as Record<string, unknown>;
    expect(restoredSettings?.activeTopicId).toBe('data');

    // --- 320px layout remains usable for both topics ---
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('tab', { name: /Agents/i }).click();
    await expect(page.locator('.type-card').first()).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const panel = document.querySelector('.settings-panel');
          const cards = [...document.querySelectorAll('.type-card')];
          const noHOverflow = (el: Element | null) => {
            if (!el) return false;
            const node = el as HTMLElement;
            return node.scrollWidth <= node.clientWidth + 1;
          };
          return {
            panelOk: noHOverflow(panel),
            cardsOk: cards.length > 0 && cards.every((card) => noHOverflow(card)),
          };
        }),
      )
      .toEqual({ panelOk: true, cardsOk: true });

    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Retained turns per completed task' })).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const panel = document.querySelector('.settings-panel');
          const fields = document.querySelector('.settings-fields');
          return {
            panelOk: Boolean(panel && (panel as HTMLElement).scrollWidth <= (panel as HTMLElement).clientWidth + 1),
            fieldsOk: Boolean(
              fields && (fields as HTMLElement).scrollWidth <= (fields as HTMLElement).clientWidth + 1,
            ),
          };
        }),
      )
      .toEqual({ panelOk: true, fieldsOk: true });
  });

  test('M012 S03 permissions UI: loading, selection, success, sanitized failure, stale snapshot, runtime card isolation', async ({
    page,
  }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m012-s03', goal: 'S03 permissions UI', viewStatus: 'idle' })],
      storeRevision: 30,
    });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expectPostedMessage(page, { type: 'requestPermissionSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Seed Agents + Data so isolation can prove they stay untouched.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'S03 worker stays',
          },
        ],
      }),
    });
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 111, maxStoredOutputChars: 150000 }),
    });

    await page.getByRole('tab', { name: /Execution/i }).click();
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('permissions-loading')).toBeVisible();
    await expect(page.getByTestId('permissions-runtime-note')).toContainText(
      'Runtime permission prompts still appear as in-session permission cards',
    );

    // Loading → host snapshot hydrates Ask as recommended default.
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('ask'),
    });
    await expect(page.getByTestId('permissions-loading')).toHaveCount(0);
    await expect(page.getByTestId('permissions-mode-group')).toBeVisible();
    await expect(page.locator('#permission-mode-ask')).toBeChecked();
    await expect(page.getByTestId('permission-mode-risk-ask')).toHaveText(/Recommended default/i);
    await expect(page.getByTestId('permission-mode-risk-allow')).toHaveText(/Least safe/i);
    await expect(page.getByTestId('permission-mode-option-allow')).toHaveAttribute(
      'data-risk',
      'least-safe',
    );
    await expect(page.getByTestId('permissions-dirty')).toHaveCount(0);
    await expect(page.getByTestId('permissions-save')).toBeDisabled();

    // Selection is draft-only until Save.
    await page.getByTestId('permission-mode-option-readonly').click();
    await expect(page.locator('#permission-mode-readonly')).toBeChecked();
    await expect(page.getByTestId('permissions-dirty')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute(
      'data-tab-state',
      'dirty',
    );
    await expect(page.getByTestId('settings-tab-indicator-execution')).toHaveText('Unsaved');
    await expect(page.getByTestId('permissions-save')).toBeEnabled();
    await expect
      .poll(async () =>
        (await postedMessages(page)).filter(
          (m) => (m as { type?: string }).type === 'updatePermissionSettings',
        ),
      )
      .toHaveLength(0);

    // Success path: explicit Save posts update, then host success + snapshot clear dirty.
    await page.getByTestId('permissions-save').click();
    await expectPostedMessage(page, { type: 'updatePermissionSettings', mode: 'readonly' });
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute(
      'data-tab-state',
      'saving',
    );
    await postRawHostMessage(page, {
      type: 'permissionSettingsUpdateResult',
      result: { ok: true, mode: 'readonly' },
    });
    await expect(page.getByTestId('permissions-local-success')).toContainText(
      'Saved permission mode.',
    );
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('readonly'),
    });
    await expect(page.getByTestId('permissions-dirty')).toHaveCount(0);
    await expect(page.locator('#permission-mode-readonly')).toBeChecked();
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute(
      'data-tab-state',
      'saved',
    );

    // Sanitized failure keeps unsaved draft; prior saved mode remains authoritative in snapshot.
    await page.getByTestId('permission-mode-option-allow').click();
    await expect(page.locator('#permission-mode-allow')).toBeChecked();
    await page.getByTestId('permissions-save').click();
    await expectPostedMessage(page, { type: 'updatePermissionSettings', mode: 'allow' });
    await postRawHostMessage(page, {
      type: 'permissionSettingsUpdateResult',
      result: {
        ok: false,
        code: 'updateFailed',
        message: 'Error: ENOENT /secret/token=abc leaked stack',
      },
    });
    await expect(page.getByTestId('permissions-local-error')).toBeVisible();
    await expect(page.getByTestId('permissions-local-error')).toContainText(
      'Permission mode save failed',
    );
    await expect(page.getByTestId('permissions-local-error')).toContainText(
      'Unable to save permission mode. Check the VS Code setting and try again.',
    );
    await expect(page.getByText('ENOENT')).toHaveCount(0);
    await expect(page.getByText('token=abc')).toHaveCount(0);
    await expect(page.getByText('leaked stack')).toHaveCount(0);
    await expect(page.locator('#permission-mode-allow')).toBeChecked();
    await expect(page.getByTestId('permissions-dirty')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute(
      'data-tab-state',
      'error',
    );
    await expect(page.getByTestId('settings-tab-indicator-execution')).toHaveText('Error');

    // Stale snapshot must not overwrite dirty Permissions draft.
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('readonly'),
    });
    await expect(page.locator('#permission-mode-allow')).toBeChecked();
    await expect(page.getByTestId('permissions-dirty')).toBeVisible();

    // Other topics remain untouched by permission failure.
    await page.getByRole('tab', { name: /Agents/i }).click();
    await expect(page.locator('#tt-desc-0')).toHaveValue('S03 worker stays');
    await expect(page.getByTestId('task-types-dirty')).toHaveCount(0);
    await expect(page.getByTestId('task-types-save-error')).toHaveCount(0);
    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(
      page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true }),
    ).toHaveValue('111');
    await expect(page.getByTestId('data-local-error')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute(
      'data-tab-state',
      'error',
    );

    // Runtime PermissionCard must remain distinct from Settings configuration.
    await page.getByRole('button', { name: 'Back to tasks' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await postRawHostMessage(page, {
      type: 'permissionPending',
      sessionId: 'sess-s03',
      permissionId: 'perm-s03',
      title: 'Write src/host/permission-settings.ts',
      kind: 'edit',
      classification: 'write',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Deny', kind: 'reject' },
      ],
    });
    await expect(page.getByTestId('runtime-permission-card')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Runtime permission request' })).toBeVisible();
    await expect(page.getByText('Write src/host/permission-settings.ts')).toBeVisible();
    await expect(page.getByText(/This agent wants to run a write \/ command action/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();

    // Re-open Settings while a runtime permission is pending — configuration UI stays distinct,
    // and the runtime card remains mounted/operable (M013 S01: no unmount under Settings).
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestPermissionSettings' });
    await page.getByRole('tab', { name: /Execution/i }).click();
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('readonly'),
    });
    // Dirty draft (allow) survives reopen via view-state; runtime card is not Settings UI.
    await expect(page.locator('#permission-mode-allow')).toBeChecked();
    await expect(page.getByTestId('permissions-settings')).toBeVisible();
    await expect(page.getByTestId('runtime-permission-card')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Runtime permission request' })).toBeVisible();
    await expect(page.getByText('Write src/host/permission-settings.ts')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
    // Settings modes are radios under Permission mode — not runtime prompt buttons.
    await expect(page.getByTestId('permissions-mode-group')).toBeVisible();
    await expect(page.getByTestId('permissions-runtime-note')).toContainText(
      'This tab only configures the default policy mode',
    );

    // Scoped Allow once must submit the existing permission envelope while Settings stays open.
    await page.getByRole('button', { name: 'Allow once' }).click();
    await expectPostedMessage(page, {
      type: 'submitPermission',
      permissionId: 'perm-s03',
      optionId: 'allow-once',
      remember: false,
    });
    // Policy controls remain distinct from the runtime action that just fired.
    await expect(page.getByTestId('permissions-mode-group')).toBeVisible();
    await expect(page.locator('#permission-mode-allow')).toBeChecked();
  });

  test('M012 S03 flow: save readonly then allow, exact outbound update, sanitized failure keeps draft', async ({
    page,
  }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m012-s03-flow', goal: 'S03 permissions flow', viewStatus: 'idle' })],
      storeRevision: 31,
    });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestPermissionSettings' });

    // Seed sibling topics so isolation is observable after a permission failure.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'S03 flow worker stays',
          },
        ],
      }),
    });
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 122, maxStoredOutputChars: 160000 }),
    });

    await page.getByRole('tab', { name: /Execution/i }).click();
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('ask'),
    });
    await expect(page.locator('#permission-mode-ask')).toBeChecked();

    // Save readonly: exact outbound update, then host success + refreshed snapshot.
    await page.getByTestId('permission-mode-option-readonly').click();
    await page.getByTestId('permissions-save').click();
    await expectPostedMessage(page, { type: 'updatePermissionSettings', mode: 'readonly' });
    await postRawHostMessage(page, {
      type: 'permissionSettingsUpdateResult',
      result: { ok: true, mode: 'readonly' },
    });
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('readonly'),
    });
    await expect(page.locator('#permission-mode-readonly')).toBeChecked();
    await expect(page.getByTestId('permissions-dirty')).toHaveCount(0);
    await expect(page.getByTestId('permissions-local-success')).toContainText('Saved permission mode.');

    // Save allow after success: exact outbound update for the new mode.
    await page.getByTestId('permission-mode-option-allow').click();
    await page.getByTestId('permissions-save').click();
    await expectPostedMessage(page, { type: 'updatePermissionSettings', mode: 'allow' });
    await postRawHostMessage(page, {
      type: 'permissionSettingsUpdateResult',
      result: { ok: true, mode: 'allow' },
    });
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('allow'),
    });
    await expect(page.locator('#permission-mode-allow')).toBeChecked();
    await expect(page.getByTestId('permissions-dirty')).toHaveCount(0);

    // Failure keeps unsaved draft without leaking raw errors or altering other topics.
    await page.getByTestId('permission-mode-option-ask').click();
    await page.getByTestId('permissions-save').click();
    await expectPostedMessage(page, { type: 'updatePermissionSettings', mode: 'ask' });
    await postRawHostMessage(page, {
      type: 'permissionSettingsUpdateResult',
      result: {
        ok: false,
        code: 'updateFailed',
        message: 'Error: EPERM /secret/token=xyz stack',
      },
    });
    await expect(page.getByTestId('permissions-local-error')).toBeVisible();
    await expect(page.getByTestId('permissions-local-error')).toContainText(
      'Unable to save permission mode. Check the VS Code setting and try again.',
    );
    await expect(page.getByText('EPERM')).toHaveCount(0);
    await expect(page.getByText('token=xyz')).toHaveCount(0);
    await expect(page.getByText('/secret/')).toHaveCount(0);
    await expect(page.locator('#permission-mode-ask')).toBeChecked();
    await expect(page.getByTestId('permissions-dirty')).toBeVisible();

    await page.getByRole('tab', { name: /Agents/i }).click();
    await expect(page.locator('#tt-desc-0')).toHaveValue('S03 flow worker stays');
    await expect(page.getByTestId('task-types-dirty')).toHaveCount(0);
    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(
      page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true }),
    ).toHaveValue('122');
    await expect(page.getByTestId('data-local-error')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute(
      'data-tab-state',
      'error',
    );
  });

  test('M012 S03 isolation: Execution run-limit and Data history feedback never leak across domains', async ({
    page,
  }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m012-s03-iso', goal: 'Cross-domain feedback isolation', viewStatus: 'idle' })],
      storeRevision: 32,
    });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expectPostedMessage(page, { type: 'requestPermissionSettings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Seed all three snapshots so every domain hydrates its controls.
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({
        maxRetainedTurnsPerTask: 200,
        maxStoredOutputChars: 200000,
        runLimit: '2h',
      }),
    });
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesSettingsSnapshot(),
    });
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('ask'),
    });

    // An unsolicited unknown-setting failure has no pending owner and therefore
    // remains visible as a Settings-level alert instead of leaking into a domain.
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: {
        ok: false,
        code: 'unknownSetting',
        message: 'Unsupported setting.',
      },
    });
    await expect(page.getByTestId('settings-level-error')).toContainText(
      'Unable to load or save settings. Check the VS Code setting and try again.',
    );

    // --- Execution: change runLimit select and save; success stays in Execution ---
    await page.getByRole('tab', { name: /Execution/i }).click();
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute('aria-selected', 'true');
    const runLimit = page.getByRole('combobox', { name: 'Maximum uninterrupted agent run' });
    await expect(runLimit).toHaveValue('2h');
    await runLimit.selectOption('4h');
    await page.getByRole('button', { name: 'Save Maximum uninterrupted agent run' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'runLimit', value: '4h' });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'runLimit', value: '4h' },
    });
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({
        maxRetainedTurnsPerTask: 200,
        maxStoredOutputChars: 200000,
        runLimit: '4h',
      }),
    });
    await expect(page.getByTestId('run-limits-local-success')).toBeVisible();
    await expect(page.getByTestId('settings-level-error')).toHaveCount(0);
    // runLimit success never renders in the Data panel.
    await expect(page.getByTestId('data-local-success')).toHaveCount(0);

    // unknownSetting omits settingId in the result, so App must capture the
    // pending run-limit owner before clearing the in-flight save state.
    await runLimit.selectOption('8h');
    await page.getByRole('button', { name: 'Save Maximum uninterrupted agent run' }).click();
    await expectPostedMessage(page, { type: 'updateSetting', settingId: 'runLimit', value: '8h' });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: {
        ok: false,
        code: 'unknownSetting',
        message: 'Unsupported setting.',
      },
    });
    await expect(page.getByTestId('run-limits-local-error')).toBeVisible();
    await expect(page.getByTestId('settings-level-error')).toHaveCount(0);

    // --- Data: neither run-limit success nor its later error leaked here ---
    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('data-local-success')).toHaveCount(0);
    await expect(page.getByTestId('data-local-error')).toHaveCount(0);

    // Change a Data number field and drive a failing save.
    const turns = page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true });
    await turns.fill('210');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expectPostedMessage(page, {
      type: 'updateSetting',
      settingId: 'maxRetainedTurnsPerTask',
      value: 210,
    });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: {
        ok: false,
        settingId: 'maxRetainedTurnsPerTask',
        code: 'updateFailed',
        message: 'Error: /secret leak',
      },
    });
    await expect(page.getByTestId('data-local-error')).toBeVisible();
    await expect(page.getByTestId('data-local-error')).toContainText('History save failed');
    await expect(page.getByText('/secret leak')).toHaveCount(0);

    // --- Execution: the Data failure did not leak here ---
    await page.getByRole('tab', { name: /Execution/i }).click();
    await expect(page.getByTestId('run-limits-local-error')).toHaveCount(0);
    // The Data failure leaves Execution outside the error state.
    await expect(page.getByRole('tab', { name: /Execution/i })).not.toHaveAttribute('data-tab-state', 'error');

    // --- Tab indicators: Data reads Error while Execution does not ---
    await expect(page.getByTestId('settings-tab-indicator-data')).toHaveText('Error');
    // Execution's indicator is either absent or non-error, but never reads Error.
    await expect(
      page.getByTestId('settings-tab-indicator-execution').filter({ hasText: 'Error' }),
    ).toHaveCount(0);
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

    // Explicit interrupt-and-send control uses the same sendLiveInput path.
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

    const composer = page.getByRole('combobox').first();
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
    const composer = page.getByRole('combobox').first();
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

    // Product v2 switch has no multi-phase handoffProgress chrome on TaskSummary
    // (host projectTaskSummary omits it). Keep the chat free of hidden canaries
    // and the picker interactive after the outbound request.
    await expect(page.getByTestId('handoff-progress')).toHaveCount(0);
    await expect(page.getByText(conversationOnly)).toBeVisible();
    await expect(page.getByText('Please summarize the plan.')).toBeVisible();
    await expect(page.getByText(sessionCanary)).toHaveCount(0);
    await expect(page.getByText(digestCanary)).toHaveCount(0);
    await expect(page.getByText(summaryBodyCanary)).toHaveCount(0);
    await expect(page.getByText(bootstrapCanary)).toHaveCount(0);
    await expect
      .poll(() => modelSwitch.evaluate((el) => el.hasAttribute('disabled')))
      .toBe(false);

    // Host projects updated binding after a successful switch (no progress chrome).
    const completedTask = task({
      id: taskId,
      goal: idleTask.goal,
      viewStatus: 'idle',
      lifecycle: 'open',
      backend: 'grok',
      model: 'grok-4',
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

    await expect(page.getByTestId('handoff-progress')).toHaveCount(0);
    // Binding lives in the composer switch; task-tree chrome does not repeat backend metadata.
    await expect
      .poll(() => modelSwitch.evaluate((el) => (el as HTMLElement & { value: string }).value))
      .toBe('grok::grok-4');
    await expect(page.getByTestId('task-chrome').getByText('grok', { exact: true })).toHaveCount(0);
    await expect
      .poll(() => modelSwitch.evaluate((el) => el.hasAttribute('disabled')))
      .toBe(false);
    await expect(page.getByText(conversationOnly)).toBeVisible();
    await expect(page.getByText(sessionCanary)).toHaveCount(0);
    await expect(page.getByText(digestCanary)).toHaveCount(0);
    await expect(page.getByText(summaryBodyCanary)).toHaveCount(0);
    await expect(page.getByText(bootstrapCanary)).toHaveCount(0);

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

    // Extension/webview reload with a persisted terminal record must not replay
    // the old handoff status. It is metadata now, not a new notification.
    await page.reload();
    await expect(page.getByText('New task')).toBeVisible();
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [completedTask],
      focusedTaskId: taskId,
      subtree: [completedTask],
      transcript: [
        { id: 'msg-user-1', kind: 'user', content: 'Please summarize the plan.' },
        { id: 'msg-asst-1', kind: 'assistant', content: conversationOnly },
      ],
      storeRevision: 306,
    });
    await expect(page.getByTestId('task-model-switch')).toBeVisible();
    await expect(page.getByTestId('handoff-progress')).toHaveCount(0);

    // A refreshed/partial catalog must not coerce the committed task model to
    // its new default; otherwise the next chat would trigger a second handoff.
    await postModelsAvailable(page, {
      grok: {
        current: 'grok-next',
        options: [{ value: 'grok-next', name: 'grok-next' }],
      },
    });
    await expect
      .poll(() =>
        page.getByTestId('task-model-switch').evaluate((el) => (el as HTMLElement & { value: string }).value),
      )
      .toBe('grok::grok-4');

    await page.locator('.composer-input__textarea').fill('Continue after the model switch.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(async () =>
        (await postedMessages(page)).filter(
          (message) => (message as { type?: string }).type === 'requestRuntimeHandoff',
        ).length,
      )
      .toBe(0);
  });
});

test.describe('Task-tree chrome navigation', () => {
  test('renders every pending workflow shell and blocks manual composer sends', async ({ page }) => {
    await openWebview(page);

    const coordinator = task({
      id: 'workflow-owner',
      role: 'coordinator',
      goal: 'Coordinate release workflow',
      viewStatus: 'running',
      runtimeActivity: 'running',
    });
    const producer = task({
      id: 'workflow-producer',
      parentId: 'workflow-owner',
      role: 'worker',
      goal: 'Produce release evidence',
      viewStatus: 'running',
      runtimeActivity: 'running',
    });
    const consumerShell = task({
      id: 'workflow-consumer-shell',
      parentId: 'workflow-owner',
      role: 'worker',
      goal: 'Review release evidence',
      viewStatus: 'waiting_workflow',
      runtimeActivity: 'waiting_workflow',
      currentTurnActivity: null,
      workflowNodeStatus: 'pending',
    });
    const terminalShell = task({
      id: 'workflow-terminal-shell',
      parentId: 'workflow-owner',
      role: 'worker',
      goal: 'Publish release result',
      viewStatus: 'waiting_workflow',
      runtimeActivity: 'waiting_workflow',
      currentTurnActivity: null,
      workflowNodeStatus: 'pending',
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [coordinator],
      focusedTaskId: consumerShell.id,
      subtree: [coordinator, producer, consumerShell, terminalShell],
      transcript: [],
      storeRevision: 901,
    });

    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(4);
    await expect(page.getByTestId('task-tree-row').filter({ hasText: consumerShell.goal })).toBeVisible();
    await expect(page.getByTestId('task-tree-row').filter({ hasText: terminalShell.goal })).toBeVisible();
    await expect(page.locator('.task-tree-panel__item').filter({ hasText: consumerShell.goal }).getByRole('button', { name: /Task status: Waiting for inputs/i })).toBeVisible();
    await expect(page.locator('.task-tree-panel__item').filter({ hasText: terminalShell.goal }).getByRole('button', { name: /Task status: Waiting for inputs/i })).toBeVisible();
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByText(/waiting for workflow inputs.*activates automatically/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop this turn' })).toHaveCount(0);
    await expect(page.locator('textarea.composer-input__textarea, textarea').last()).toBeDisabled();
    expect((await postedMessages(page)).filter((message) => (message as { type?: string }).type === 'send')).toHaveLength(0);
    await page.locator('.task-tree-panel__status-btn').first().click();
    await expect(page.getByRole('group', { name: 'Lifecycle actions' }).getByRole('button')).toHaveCount(0);
    await page.keyboard.press('Escape');

    const closedConsumerShell = task({
      ...consumerShell,
      lifecycle: 'failed',
      viewStatus: 'failed',
      runtimeActivity: null,
      currentTurnActivity: null,
      workflowNodeStatus: 'pending',
    });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [coordinator],
      focusedTaskId: closedConsumerShell.id,
      subtree: [coordinator, producer, closedConsumerShell, terminalShell],
      transcript: [],
      storeRevision: 901,
    });
    await expect(page.locator('textarea.composer-input__textarea, textarea').last()).toBeDisabled();
    await expect(page.getByRole('button', { name: /reopen/i })).toHaveCount(0);

    const activatedConsumer = task({
      ...consumerShell,
      viewStatus: 'queued',
      runtimeActivity: 'queued',
      currentTurnActivity: { state: 'queued', turnId: 'workflow-consumer-turn' },
      workflowNodeStatus: 'active',
    });
    await postRawHostMessage(page, {
      type: 'workspacePatchBatch',
      revision: 902,
      patches: [{ type: 'taskUpserted', task: activatedConsumer }],
    });
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(4);
    await expect(page.locator('[data-testid="task-tree-row"][data-task-id="workflow-consumer-shell"]')).toContainText('Review release evidence');
    await expect(page.getByText(/waiting for workflow inputs.*activates automatically/i)).toHaveCount(0);
    const activatedComposer = page.locator('textarea.composer-input__textarea, textarea').last();
    await expect(activatedComposer).toBeEnabled();
    await activatedComposer.fill('Follow up after workflow activation');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expectPostedMessage(page, {
      type: 'send',
      taskId: consumerShell.id,
      text: 'Follow up after workflow activation',
    });

    await page.reload();
    await expect(page.getByText('New task')).toBeVisible();
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [coordinator],
      focusedTaskId: activatedConsumer.id,
      subtree: [coordinator, producer, activatedConsumer, terminalShell],
      transcript: [],
      storeRevision: 903,
    });
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(4);
    await expect(page.locator('[data-testid="task-tree-row"][data-task-id="workflow-consumer-shell"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="task-tree-row"][data-task-id="workflow-terminal-shell"]')).toHaveCount(1);
  });

  test('collapsed tree is the selected-task header and expands without duplicate context', async ({
    page,
  }) => {
    await openWebview(page);

    const root = task({
      id: 'coord-root',
      role: 'coordinator',
      goal: 'Coordinate multi-child work',
      viewStatus: 'running',
      runtimeActivity: 'running',
    });
    const childA = task({
      id: 'worker-a',
      parentId: 'coord-root',
      role: 'worker',
      goal: 'Auth worker',
      viewStatus: 'idle',
      runtimeActivity: 'idle',
    });
    const childB = task({
      id: 'worker-b',
      parentId: 'coord-root',
      role: 'worker',
      goal: 'Docs worker',
      viewStatus: 'waiting_user',
      runtimeActivity: 'waiting_user',
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [root],
      focusedTaskId: 'coord-root',
      subtree: [root, childA, childB],
      transcript: [
        { id: 'msg-u', kind: 'user', content: 'Kick off children' },
        { id: 'msg-a', kind: 'assistant', content: 'Coordinator reply.' },
      ],
      storeRevision: 900,
    });

    await expect(page.getByTestId('task-chrome')).toBeVisible();
    // Collapsed chrome is exactly the focused task row, not a second title above the tree.
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'false');
    await expect(page.getByTestId('task-chrome').getByTestId('task-tree-summary')).toBeVisible();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(1);
    await expect(page.getByTestId('task-tree-row')).toContainText('Coordinate multi-child work');
    await expect(page.getByTestId('task-tree-row').filter({ hasText: 'Auth worker' })).toHaveCount(0);

    // The selected header itself opens the tree; clicking it again collapses.
    await page.getByTestId('task-tree-row').click();
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'true');
    await page.getByTestId('task-tree-row').filter({ hasText: 'Coordinate multi-child work' }).click();
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'false');

    const taskComposer = page.locator('textarea.composer-input__textarea, textarea').last();
    await taskComposer.fill('draft stays while tree open');

    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'true');
    await expect(page.getByTestId('task-tree-row')).toHaveCount(3);
    await expect(page.getByTestId('task-tree-row').filter({ hasText: 'Auth worker' })).toBeVisible();
    // The selected goal and lifecycle each occur once inside chrome.
    await expect(page.getByTestId('task-chrome').getByText('Coordinate multi-child work', { exact: true })).toHaveCount(1);
    await expect(
      page.getByTestId('task-chrome').locator('.task-tree-panel__status-btn[data-task-lifecycle="open"]'),
    ).toHaveCount(3);
    await expect(page.getByTestId('task-chrome').getByText('Open', { exact: true })).toHaveCount(0);

    const docsNode = page.locator('.task-tree-panel__item').filter({ hasText: 'Docs worker' });
    await docsNode.locator('.task-tree-panel__status-btn').click();
    await page.getByRole('dialog', { name: 'Status details for Docs worker' }).getByText('Mark done', { exact: true }).click();
    await expectPostedMessage(page, {
      type: 'setTaskLifecycle',
      taskId: 'worker-b',
      lifecycle: 'succeeded',
    });

    await expect(taskComposer).toHaveValue('draft stays while tree open');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'false');
    await expect(page.getByTestId('task-tree-row')).toHaveCount(1);
    await expect(taskComposer).toHaveValue('draft stays while tree open');

    await page.getByTestId('task-tree-summary').click();
    await page.getByTestId('task-tree-row').filter({ hasText: 'Auth worker' }).click();

    await expect
      .poll(async () => {
        const messages = await postedMessages(page);
        return messages.some(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'focusTask' &&
            (m as { taskId?: string }).taskId === 'worker-a',
        );
      })
      .toBe(true);

    // Host snapshot has not arrived yet: pending navigation must still own tree chrome.
    await expect(page.getByTestId('task-tree-row').filter({ hasText: 'Auth worker' })).toHaveAttribute('aria-current', 'page');
    // In expanded mode the predictable top/root chevron collapses the whole chrome.
    await expect(
      page.locator('.task-tree-panel__item').filter({ hasText: 'Coordinate multi-child work' }).getByTestId('task-tree-summary'),
    ).toBeVisible();
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(1);
    await expect(page.getByTestId('task-tree-row')).toContainText('Auth worker');
    await expect(page.getByTestId('task-chrome').getByText('Coordinate multi-child work')).toHaveCount(0);
    await page.getByTestId('task-tree-summary').click();

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [root],
      focusedTaskId: 'worker-a',
      subtree: [root, childA, childB],
      transcript: [{ id: 'msg-child', kind: 'user', content: 'only child transcript' }],
      storeRevision: 901,
    });

    await expect(page.getByText('only child transcript')).toBeVisible();
    await expect(page.getByText('Kick off children')).toHaveCount(0);
    // Same owning-root hop: tree stays expanded and marks the child as current.
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'true');
    await expect(page.getByTestId('task-tree-row').filter({ hasText: 'Auth worker' })).toHaveAttribute('aria-current', 'page');
    await expect(taskComposer).toHaveValue('draft stays while tree open');

    // Regression: collapsing while a child is focused must use the child as header, never row 0/root.
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(1);
    await expect(page.getByTestId('task-tree-row')).toContainText('Auth worker');
    await expect(page.getByTestId('task-chrome').getByText('Coordinate multi-child work')).toHaveCount(0);
    await page.getByTestId('task-tree-summary').click();

    // The tree itself navigates back to the coordinator; no breadcrumb duplicates it.
    await page.getByTestId('task-tree-row').filter({ hasText: 'Coordinate multi-child work' }).click();
    await expect
      .poll(async () => {
        const messages = await postedMessages(page);
        return messages.some(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'focusTask' &&
            (m as { taskId?: string }).taskId === 'coord-root',
        );
      })
      .toBe(true);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [root],
      focusedTaskId: 'coord-root',
      subtree: [root, childA, childB],
      transcript: [{ id: 'msg-back', kind: 'user', content: 'back on root' }],
      storeRevision: 902,
    });
    // After ancestor hop within same root, tree still expanded.
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'true');

    // A solitary task uses the same row/header pattern.
    const solitary = task({
      id: 'solo-root',
      role: 'coordinator',
      goal: 'Solitary coordinator',
      viewStatus: 'idle',
    });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [solitary],
      focusedTaskId: 'solo-root',
      subtree: [solitary],
      transcript: [{ id: 'msg-solo', kind: 'user', content: 'solo chat' }],
      storeRevision: 903,
    });
    await expect(page.getByTestId('task-chrome')).toContainText('Solitary coordinator');
    await expect(page.getByTestId('task-tree-row')).toHaveCount(1);
    await expect(page.getByTestId('task-tree-summary')).toBeVisible();
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'false');

    // Re-enter multi-node, expand, then draft mode removes task chrome.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [root],
      focusedTaskId: 'coord-root',
      subtree: [root, childA, childB],
      transcript: [{ id: 'msg-r2', kind: 'user', content: 'again' }],
      storeRevision: 904,
    });
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'true');
    await page.getByRole('button', { name: 'New task' }).first().click();
    await expect(page.getByText('First message creates the coordinator task.')).toBeVisible();
    await expect(page.getByTestId('task-chrome')).toHaveCount(0);

    // Different multi-node root → collapse.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [root],
      focusedTaskId: 'coord-root',
      subtree: [root, childA, childB],
      transcript: [{ id: 'msg-r3', kind: 'user', content: 'expand again' }],
      storeRevision: 905,
    });
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'true');

    const otherRoot = task({
      id: 'other-root',
      role: 'coordinator',
      goal: 'Other coordinator',
      viewStatus: 'idle',
    });
    const otherChild = task({
      id: 'other-child',
      parentId: 'other-root',
      role: 'worker',
      goal: 'Other worker',
      viewStatus: 'idle',
    });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [root, otherRoot],
      focusedTaskId: 'other-root',
      subtree: [otherRoot, otherChild],
      transcript: [{ id: 'msg-o', kind: 'user', content: 'other root chat' }],
      storeRevision: 906,
    });
    await expect(page.getByTestId('task-chrome')).toContainText('Other coordinator');
    await expect(page.getByTestId('task-chrome')).toHaveAttribute('data-tree-expanded', 'true');
    await expect(page.getByTestId('task-tree-row').filter({ hasText: 'Other worker' })).toBeVisible();
  });

  test('narrow viewport keeps selected child as compact header without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 280, height: 700 });
    await openWebview(page);

    const root = task({
      id: 'coord-root',
      role: 'coordinator',
      goal: 'Coordinate multi-child work',
      viewStatus: 'running',
    });
    const childA = task({
      id: 'worker-a',
      parentId: 'coord-root',
      role: 'worker',
      goal: 'Auth worker',
      viewStatus: 'idle',
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [root],
      focusedTaskId: 'worker-a',
      subtree: [root, childA],
      transcript: [{ id: 'msg-c', kind: 'user', content: 'child' }],
      storeRevision: 910,
    });

    await expect(page.getByTestId('task-chrome')).toBeVisible();
    await expect(page.getByTestId('export-task-chat')).toBeVisible();
    await expect(page.getByTestId('task-chrome')).toContainText('Auth worker');
    await expect(page.getByTestId('task-chrome').getByRole('button', { name: /Task status:/i })).toBeVisible();
    await expect(page.getByTestId('task-tree-summary')).toBeVisible();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(1);
    await expect(page.getByTestId('task-chrome').getByText('Coordinate multi-child work')).toHaveCount(0);

    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(2);
    await expect(page.getByTestId('task-tree-row').filter({ hasText: 'Coordinate multi-child work' })).toBeVisible();

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth <= doc.clientWidth + 1;
    });
    expect(overflow).toBe(true);
  });

  test('expanded nested tree replaces breadcrumb and keeps one selected-task copy', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 700 });
    await openWebview(page);

    const root = task({
      id: 'coord-root',
      role: 'coordinator',
      goal: 'Coordinate multi-child work',
      viewStatus: 'running',
    });
    const childA = task({
      id: 'worker-a',
      parentId: 'coord-root',
      role: 'worker',
      goal: 'Auth worker',
      viewStatus: 'idle',
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [root],
      focusedTaskId: 'worker-a',
      subtree: [root, childA],
      transcript: [{ id: 'msg-c', kind: 'user', content: 'child' }],
      storeRevision: 920,
    });

    await expect(page.getByTestId('task-tree-row')).toHaveCount(1);
    await expect(page.getByTestId('task-tree-row')).toContainText('Auth worker');
    await page.getByTestId('task-tree-summary').click();
    await expect(page.getByTestId('task-tree-row')).toHaveCount(2);
    await expect(page.getByTestId('task-chrome').getByText('Auth worker', { exact: true })).toHaveCount(1);
    await expect(page.getByTestId('task-tree-row').filter({ hasText: 'Auth worker' })).toHaveAttribute('aria-current', 'page');
  });

  test('M012 S04 integrated settings acceptance: three-domain keyboard mouse isolation host loops state restore and 320px', async ({
    page,
  }) => {
    await openWebview(page, {
      rootTasks: [task({ id: 'task-m012-s04', goal: 'Integrated settings acceptance', viewStatus: 'idle' })],
      storeRevision: 40,
    });

    // --- Real Settings entry + host snapshots for all three active topics ---
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expectPostedMessage(page, { type: 'requestSettings' });
    await expectPostedMessage(page, { type: 'requestTaskTypesSettings' });
    await expectPostedMessage(page, { type: 'requestPermissionSettings' });

    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 120, maxStoredOutputChars: 150000 }),
    });
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        status: 'ok',
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'S04 worker',
          },
          {
            id: 'coordinator',
            backend: 'claude',
            role: 'coordinator',
            briefKind: 'generic',
            description: 'S04 coordinator',
          },
        ],
      }),
    });
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('ask'),
    });

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // --- Three-domain taxonomy + WAI-ARIA relationships ---
    const tablist = page.getByRole('tablist', { name: 'Settings domains' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText(/Agents/i);
    await expect(tabs.nth(1)).toHaveText(/Execution/i);
    await expect(tabs.nth(2)).toHaveText(/Data/i);

    const taskTypesTab = page.getByRole('tab', { name: /Agents/i });
    await expect(taskTypesTab).toHaveAttribute('aria-selected', 'true');
    await expect(taskTypesTab).toHaveAttribute('aria-controls', 'settings-panel-agents');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'settings-panel-agents');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'settings-tab-agents');

    // Mouse activation of each topic
    for (const name of [/Execution/i, /Data/i, /Agents/i]) {
      await page.getByRole('tab', { name }).click();
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    }

    // Keyboard: ArrowRight wrap, ArrowLeft wrap, Home, End, Tab into panel
    await taskTypesTab.focus();
    await expect(taskTypesTab).toBeFocused();
    await taskTypesTab.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: /Execution/i }).press('End');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: /Data/i }).press('Home');
    await expect(taskTypesTab).toHaveAttribute('aria-selected', 'true');
    await taskTypesTab.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: /Data/i }).press('ArrowRight');
    await expect(taskTypesTab).toHaveAttribute('aria-selected', 'true');

    // Tab into panel; selected tab remains selected after focus enters controls
    await taskTypesTab.press('Tab');
    await expect(taskTypesTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toBeFocused();

    // --- Successful host-backed update: Task profiles ---
    await page.locator('#tt-desc-0').fill('S04 integrated worker');
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectPostedMessage(page, {
      type: 'updateTaskTypes',
      types: expect.arrayContaining([
        expect.objectContaining({ id: 'worker', description: 'S04 integrated worker' }),
      ]),
    });
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsUpdateResult',
      result: { ok: true },
    });
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        status: 'ok',
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'S04 integrated worker',
          },
          {
            id: 'coordinator',
            backend: 'claude',
            role: 'coordinator',
            briefKind: 'generic',
            description: 'S04 coordinator',
          },
        ],
      }),
    });
    await expect(page.getByTestId('task-types-dirty')).toHaveCount(0);
    await expect(page.getByTestId('task-types-saved')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Agents/i })).toHaveAttribute('data-tab-state', 'saved');

    // --- Successful host-backed update: Tool access (Execution) ---
    await page.getByRole('tab', { name: /Execution/i }).click();
    await page.getByTestId('permission-mode-option-readonly').click();
    await expect(page.getByTestId('permissions-dirty')).toBeVisible();
    await page.getByTestId('permissions-save').click();
    await expectPostedMessage(page, { type: 'updatePermissionSettings', mode: 'readonly' });
    await postRawHostMessage(page, {
      type: 'permissionSettingsUpdateResult',
      result: { ok: true, mode: 'readonly' },
    });
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('readonly'),
    });
    await expect(page.getByTestId('permissions-dirty')).toHaveCount(0);
    await expect(page.getByTestId('permissions-local-success')).toBeVisible();
    await expect(page.locator('#permission-mode-readonly')).toBeChecked();

    // --- Successful host-backed update: Data ---
    await page.getByRole('tab', { name: /Data/i }).click();
    const turns = page.getByRole('spinbutton', { name: 'Retained turns per completed task', exact: true });
    await turns.fill('180');
    await page.getByRole('button', { name: 'Save Retained turns per completed task' }).click();
    await expectPostedMessage(page, {
      type: 'updateSetting',
      settingId: 'maxRetainedTurnsPerTask',
      value: 180,
    });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 180 },
    });
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 180, maxStoredOutputChars: 150000 }),
    });
    await expect(turns).toHaveValue('180');
    await expect(page.getByTestId('data-local-success')).toBeVisible();

    // --- Cross-topic isolation: inject sanitized failure into Agents; others unchanged ---
    await page.getByRole('tab', { name: /Agents/i }).click();
    await page.locator('#tt-desc-0').fill('Should stay after failure');
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsUpdateResult',
      result: {
        ok: false,
        code: 'updateFailed',
        message: 'Error: EPERM /secret/token=xyz stack',
      },
    });
    // Failure path sanitizes / keeps draft
    await expect(page.getByTestId('task-types-save-error')).toBeVisible();
    await expect(page.locator('#tt-desc-0')).toHaveValue('Should stay after failure');
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();

    // Execution (Tool access) saved snapshot + indicators remain
    await page.getByRole('tab', { name: /Execution/i }).click();
    await expect(page.locator('#permission-mode-readonly')).toBeChecked();
    await expect(page.getByTestId('permissions-dirty')).toHaveCount(0);
    await expect(page.getByTestId('permissions-local-error')).toHaveCount(0);

    // Data saved snapshot + indicators remain
    await page.getByRole('tab', { name: /Data/i }).click();
    await expect(turns).toHaveValue('180');
    await expect(page.getByTestId('data-local-error')).toHaveCount(0);

    // Dirty Agents draft survives stale snapshot
    await page.getByRole('tab', { name: /Agents/i }).click();
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        status: 'ok',
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'S04 integrated worker',
          },
          {
            id: 'coordinator',
            backend: 'claude',
            role: 'coordinator',
            briefKind: 'generic',
            description: 'S04 coordinator',
          },
        ],
      }),
    });
    await expect(page.locator('#tt-desc-0')).toHaveValue('Should stay after failure');
    await expect(page.getByTestId('task-types-dirty')).toBeVisible();

    // Explicit success clears dirty
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsUpdateResult',
      result: { ok: true },
    });
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        status: 'ok',
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'Should stay after failure',
          },
          {
            id: 'coordinator',
            backend: 'claude',
            role: 'coordinator',
            briefKind: 'generic',
            description: 'S04 coordinator',
          },
        ],
      }),
    });
    await expect(page.getByTestId('task-types-dirty')).toHaveCount(0);

    // --- Complete user loops re-run (Agents already above; Execution allow; Data chars) ---
    await page.getByRole('tab', { name: /Execution/i }).click();
    await page.getByTestId('permission-mode-option-allow').click();
    await page.getByTestId('permissions-save').click();
    await expectPostedMessage(page, { type: 'updatePermissionSettings', mode: 'allow' });
    await postRawHostMessage(page, {
      type: 'permissionSettingsUpdateResult',
      result: { ok: true, mode: 'allow' },
    });
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('allow'),
    });
    await expect(page.locator('#permission-mode-allow')).toBeChecked();

    await page.getByRole('tab', { name: /Data/i }).click();
    const chars = page.getByRole('spinbutton', { name: 'Stored output per turn', exact: true });
    await chars.fill('250000');
    await page.getByRole('button', { name: 'Save Stored output per turn' }).click();
    await expectPostedMessage(page, {
      type: 'updateSetting',
      settingId: 'maxStoredOutputChars',
      value: 250000,
    });
    await postRawHostMessage(page, {
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'maxStoredOutputChars', value: 250000 },
    });
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 180, maxStoredOutputChars: 250000 }),
    });
    await expect(chars).toHaveValue('250000');

    // Dirty draft survives stale retention snapshot
    await chars.fill('333333');
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 180, maxStoredOutputChars: 999999 }),
    });
    await expect(chars).toHaveValue('333333');

    // --- Capture/restore webview state across page recreation ---
    await page.getByRole('tab', { name: /Execution/i }).click();
    await expect(page.getByRole('tab', { name: /Execution/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Leave a dirty retention draft before recreation
    await page.getByRole('tab', { name: /Data/i }).click();
    await chars.fill('444444');

    const captured = await page.evaluate(() => {
      const api = window.acquireVsCodeApi();
      return api.getState?.() ?? null;
    });
    expect(captured).toBeTruthy();

    await openWebview(page, {
      rootTasks: [task({ id: 'task-m012-s04', goal: 'Integrated settings acceptance', viewStatus: 'idle' })],
      storeRevision: 41,
      initialState: captured as never,
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await postRawHostMessage(page, {
      type: 'settingsSnapshot',
      snapshot: retentionSettingsSnapshot({ maxRetainedTurnsPerTask: 180, maxStoredOutputChars: 250000 }),
    });
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot({
        status: 'ok',
        types: [
          {
            id: 'worker',
            backend: 'claude',
            role: 'worker',
            briefKind: 'generic',
            description: 'Should stay after failure',
          },
          {
            id: 'coordinator',
            backend: 'claude',
            role: 'coordinator',
            briefKind: 'generic',
            description: 'S04 coordinator',
          },
        ],
      }),
    });
    await postRawHostMessage(page, {
      type: 'permissionSettingsSnapshot',
      snapshot: permissionSettingsSnapshot('allow'),
    });

    // Restored navigation + dirty retention draft
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('spinbutton', { name: 'Stored output per turn', exact: true }),
    ).toHaveValue('444444');

    // --- 320px: containment, single-row tabs (no scroll), keyboard ---
    await page.setViewportSize({ width: 320, height: 720 });
    const tablistNarrow = page.getByRole('tablist', { name: 'Settings domains' });
    await expect
      .poll(async () =>
        tablistNarrow.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return {
            wrap: style.flexWrap,
            overflowX: style.overflowX,
            singleRow: (el as HTMLElement).scrollHeight <= (el as HTMLElement).clientHeight + 8,
            // Three equal-width tabs fit; the tablist does not scroll horizontally.
            canScroll: (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1,
          };
        }),
      )
      .toEqual(
        expect.objectContaining({
          wrap: 'nowrap',
          overflowX: 'hidden',
          singleRow: true,
          canScroll: false,
        }),
      );

    // Keyboard still reaches last tab (Data)
    await page.getByRole('tab', { name: /Agents/i }).focus();
    await page.getByRole('tab', { name: /Agents/i }).press('End');
    await expect(page.getByRole('tab', { name: /Data/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tab', { name: /Data/i })).toBeFocused();

    // Page containment at 320
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const panel = document.querySelector('.settings-panel');
          const body = document.querySelector('.settings-panel__body');
          return {
            panelOk: Boolean(
              panel && (panel as HTMLElement).scrollWidth <= (panel as HTMLElement).clientWidth + 1,
            ),
            bodyOk: Boolean(
              body && (body as HTMLElement).scrollWidth <= (body as HTMLElement).clientWidth + 1,
            ),
          };
        }),
      )
      .toEqual({ panelOk: true, bodyOk: true });
  });


});


test.describe('M015 S01 task list search and rename accessibility', () => {
  test('search accessible name', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-a11y-search', goal: 'Named search target', viewStatus: 'idle' })],
      storeRevision: 1501,
    });

    // Acceptance: resolve by accessible name (not placeholder-only).
    // Requires type="search" + aria-label="Search tasks" (T02).
    await expect(page.getByRole('searchbox', { name: 'Search tasks' })).toBeVisible();
  });

  test('rename focus and invalid', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-a11y-rename', goal: 'Rename me please', viewStatus: 'idle' })],
      storeRevision: 1502,
    });

    // Full list is the default shell (no focusedTaskId).
    await expect(page.getByRole('searchbox', { name: 'Search tasks' })).toBeVisible();

    const row = page.locator('.group').filter({ hasText: 'Rename me please' }).first();
    await row.hover();
    await page.getByRole('button', { name: 'Rename task' }).click();

    // Rename field must resolve by accessible name (T02 wires aria-label="Task name").
    const renameField = page.getByRole('textbox', { name: 'Task name' });
    await expect(renameField).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save name' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel rename' })).toBeVisible();

    // Invalid empty/whitespace must surface associated error text, not silently exit edit mode.
    await renameField.fill('   ');
    await page.getByRole('button', { name: 'Save name' }).click();

    await expect(renameField).toBeVisible();
    await expect(renameField).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await renameField.getAttribute('aria-describedby');
    expect(describedBy, 'rename field must expose aria-describedby for the invalid-state message').toBeTruthy();
    // Prefer attribute selector: Node test runner has no browser CSS.escape global.
    const error = page.locator(`[id="${describedBy}"]`);
    await expect(error).toBeVisible();
    await expect(error).toContainText(/empty|name|required|whitespace/i);
  });

  test('M015 S01 flow: task search and rename a11y', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    // Harness noise: optional assets (favicon/codicon font) may 403 or abort under vite without app impact.
    const isHarnessNoise = (text: string) =>
      /403\s*\(Forbidden\)/i.test(text) ||
      /Failed to load resource:.*403/i.test(text) ||
      /favicon\.ico/i.test(text) ||
      /codicon\.(ttf|woff2?|css)/i.test(text) ||
      /@vscode\/codicons/i.test(text) ||
      /net::ERR_ABORTED/i.test(text);
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (isHarnessNoise(text)) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(String(err?.message ?? err));
    });
    page.on('requestfailed', (req) => {
      const entry = `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`;
      if (isHarnessNoise(entry) || /favicon\.ico/i.test(req.url())) return;
      failedRequests.push(entry);
    });

    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({ id: 'task-m015-s01-keep', goal: 'Alpha keep-me target', viewStatus: 'idle' }),
        task({ id: 'task-m015-s01-hide', goal: 'Beta hide-me other', viewStatus: 'idle' }),
      ],
      storeRevision: 1503,
    });

    // 1) Named search control filters the full task list.
    const search = page.getByRole('searchbox', { name: 'Search tasks' });
    await expect(search).toBeVisible();
    await search.fill('keep-me');
    await expect(page.getByText('Alpha keep-me target')).toBeVisible();
    await expect(page.getByText('Beta hide-me other')).toHaveCount(0);

    // Clear filter so rename targets the keep-me row in a full list context.
    await search.fill('');
    await expect(page.getByText('Beta hide-me other')).toBeVisible();

    // 2) Enter rename mode; field + Save/Cancel resolve by accessible name.
    // Scope rename to the row — full list has one Rename control per task.
    const row = page.locator('.group').filter({ hasText: 'Alpha keep-me target' }).first();
    await row.hover();
    await row.getByRole('button', { name: 'Rename task' }).click();

    const renameField = page.getByRole('textbox', { name: 'Task name' });
    const saveBtn = page.getByRole('button', { name: 'Save name' });
    const cancelBtn = page.getByRole('button', { name: 'Cancel rename' });
    await expect(renameField).toBeVisible();
    await expect(saveBtn).toBeVisible();
    await expect(cancelBtn).toBeVisible();

    // 3) Invalid whitespace first so later focus probes that blur the field keep edit mode open.
    await renameField.fill('   ');
    await saveBtn.click();
    await expect(renameField).toBeVisible();
    await expect(renameField).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await renameField.getAttribute('aria-describedby');
    expect(describedBy, 'rename field must expose aria-describedby for the invalid-state message').toBeTruthy();
    const error = page.locator(`[id="${describedBy}"]`);
    await expect(error).toBeVisible();
    await expect(error).toContainText(/empty|name|required|whitespace/i);

    // 4) Visible :focus-visible rings on rename field + Save/Cancel (shared focus tokens).
    // FocusOptions.focusVisible marks keyboard modality so Chromium applies the ring CSS.
    // Seed invalid state above so onblur commit keeps edit mode while probing buttons.
    const expectVisibleFocusRing = async (
      locator: import('@playwright/test').Locator,
      label: string,
    ) => {
      await locator.evaluate((el) => {
        (el as HTMLElement).focus({ focusVisible: true } as FocusOptions);
      });
      const ring = await locator.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return {
          active: document.activeElement === el,
          focusVisible: el.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          className: el.className,
        };
      });
      expect(ring.active, `${label} should be document.activeElement: ${JSON.stringify(ring)}`).toBe(true);
      expect(ring.focusVisible, `${label} should match :focus-visible: ${JSON.stringify(ring)}`).toBe(true);
      expect(ring.outlineStyle, `${label} outline style: ${JSON.stringify(ring)}`).toBe('solid');
      expect(ring.outlineWidth, `${label} outline width: ${JSON.stringify(ring)}`).toBe('1px');
    };

    await expectVisibleFocusRing(renameField, 'Task name');
    await expectVisibleFocusRing(saveBtn, 'Save name');
    await expect(renameField).toBeVisible(); // still editing after Save focus (invalid name)
    await expectVisibleFocusRing(cancelBtn, 'Cancel rename');
    await expect(renameField).toBeVisible(); // still editing after Cancel focus (invalid name)

    // 5) Correct name and Save successfully → renameTask host message + exit edit mode.
    const before = (await postedMessages(page)).length;
    await renameField.fill('Alpha renamed keep-me');
    await saveBtn.click();

    await expect(renameField).toHaveCount(0);
    await expect
      .poll(async () => {
        const messages = await postedMessages(page);
        return messages.slice(before).some((m) => {
          const msg = m as { type?: string; taskId?: string; goal?: string };
          return (
            msg.type === 'renameTask' &&
            msg.taskId === 'task-m015-s01-keep' &&
            msg.goal === 'Alpha renamed keep-me'
          );
        });
      })
      .toBe(true);

    // Console and network stay clean for this assembled a11y flow.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
  });
});


test.describe('M015 S02 compact hit targets', () => {
  /**
   * Hit-target policy (T01 RED / T02 GREEN):
   * - Compact standard for .icon-btn: >= 28x28 CSS px
   * - Dense exception (settings-panel__icon-btn or .icon-btn--dense): >= 26x26 CSS px
   * Silent inline width/height shrinks below the applicable minimum are not allowed.
   *
   * Audit (T02 GREEN):
   * - TaskList Clear search: .icon-btn → compact 28
   * - TaskList Rename/Save/Cancel/Delete: .icon-btn.icon-btn--dense → dense 26 (no inline shrink)
   * - Composer Settings / toolbar icons: .icon-btn, no silent inline size → compact 28
   * - settings-panel__icon-btn: mapped to dense floor 26 in app.css
   */
  test('icon controls meet compact hit targets', async ({ page }) => {
    const COMPACT_MIN = 28;
    const DENSE_MIN = 26;

    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-hit-target', goal: 'Hit target sample task', viewStatus: 'idle' })],
      storeRevision: 1520,
    });

    const assertHitTarget = async (
      locator: import('@playwright/test').Locator,
      label: string,
      options?: { dense?: boolean },
    ) => {
      await expect(locator, `${label} should be visible`).toBeVisible();
      const box = await locator.boundingBox();
      expect(box, `${label} should have a bounding box`).toBeTruthy();
      const min = options?.dense ? DENSE_MIN : COMPACT_MIN;
      const meta = await locator.evaluate((el) => {
        const style = (el as HTMLElement).getAttribute('style') ?? '';
        const className = (el as HTMLElement).className ?? '';
        const cs = window.getComputedStyle(el as HTMLElement);
        return {
          style,
          className,
          width: cs.width,
          height: cs.height,
          minWidth: cs.minWidth,
          minHeight: cs.minHeight,
        };
      });
      // Silent inline shrinks below the applicable minimum are policy violations.
      const inlineW = /width:\s*(\d+(?:\.\d+)?)px/i.exec(meta.style);
      const inlineH = /height:\s*(\d+(?:\.\d+)?)px/i.exec(meta.style);
      if (inlineW) {
        expect(
          Number(inlineW[1]),
          `${label} silent inline width ${inlineW[1]}px must be >= ${min} (${JSON.stringify(meta)})`,
        ).toBeGreaterThanOrEqual(min);
      }
      if (inlineH) {
        expect(
          Number(inlineH[1]),
          `${label} silent inline height ${inlineH[1]}px must be >= ${min} (${JSON.stringify(meta)})`,
        ).toBeGreaterThanOrEqual(min);
      }
      expect(
        box!.width,
        `${label} width ${box!.width}px must be >= ${min} CSS px (${JSON.stringify({ box, meta })})`,
      ).toBeGreaterThanOrEqual(min - 0.5);
      expect(
        box!.height,
        `${label} height ${box!.height}px must be >= ${min} CSS px (${JSON.stringify({ box, meta })})`,
      ).toBeGreaterThanOrEqual(min - 0.5);
    };

    // 1) Task-list clear-search (compact .icon-btn).
    const search = page.getByRole('searchbox', { name: 'Search tasks' });
    await expect(search).toBeVisible();
    await search.fill('Hit target');
    const clearSearch = page.getByRole('button', { name: 'Clear search' });
    await assertHitTarget(clearSearch, 'Clear search');

    // Row chrome uses explicit dense variant (no silent inline shrink).
    const row = page.locator('.group').filter({ hasText: 'Hit target sample task' }).first();
    await row.hover();
    const renameBtn = row.getByRole('button', { name: 'Rename task' });
    await assertHitTarget(renameBtn, 'Rename task', { dense: true });
    const renameMeta = await renameBtn.evaluate((el) => ({
      className: (el as HTMLElement).className ?? '',
      style: (el as HTMLElement).getAttribute('style') ?? '',
    }));
    expect(renameMeta.className, 'Rename task must use icon-btn--dense').toMatch(/icon-btn--dense/);
    expect(renameMeta.style, 'Rename task must not use silent inline width/height').not.toMatch(
      /width\s*:|height\s*:/i,
    );

    // 2) Representative composer icon control (compact).
    const composerSettings = page.getByRole('button', { name: 'Settings', exact: true });
    await assertHitTarget(composerSettings, 'Composer Settings');

    // 3) Representative settings icon control (header back uses standard .icon-btn).
    // Dense floor for settings-panel__icon-btn is documented/mapped in app.css.
    await composerSettings.click();
    const backToTasks = page.getByRole('button', { name: 'Back to tasks' });
    await assertHitTarget(backToTasks, 'Back to tasks');
  });

  /**
   * M015 S02 assembled flow evidence: one scenario at 320px samples critical
   * migrated icon controls against compact/dense floors, bans silent inline
   * shrinks, and keeps console + failed requests clean.
   */
  test('M015 S02 flow: compact hit targets', async ({ page }) => {
    const COMPACT_MIN = 28;
    const DENSE_MIN = 26;

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    // Harness noise: optional assets (favicon/codicon font) may 403 or abort under vite without app impact.
    const isHarnessNoise = (text: string) =>
      /403\s*\(Forbidden\)/i.test(text) ||
      /Failed to load resource:.*403/i.test(text) ||
      /favicon\.ico/i.test(text) ||
      /codicon\.(ttf|woff2?|css)/i.test(text) ||
      /@vscode\/codicons/i.test(text) ||
      /net::ERR_ABORTED/i.test(text);
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (isHarnessNoise(text)) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(String(err?.message ?? err));
    });
    page.on('requestfailed', (req) => {
      const entry = `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`;
      if (isHarnessNoise(entry) || /favicon\.ico/i.test(req.url())) return;
      failedRequests.push(entry);
    });

    await page.setViewportSize({ width: 320, height: 720 });
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m015-s02-hit', goal: 'S02 flow hit target task', viewStatus: 'idle' })],
      storeRevision: 1521,
    });

    const assertHitTarget = async (
      locator: import('@playwright/test').Locator,
      label: string,
      options?: { dense?: boolean },
    ) => {
      await expect(locator, `${label} should be visible`).toBeVisible();
      const box = await locator.boundingBox();
      expect(box, `${label} should have a bounding box`).toBeTruthy();
      const min = options?.dense ? DENSE_MIN : COMPACT_MIN;
      const meta = await locator.evaluate((el) => {
        const style = (el as HTMLElement).getAttribute('style') ?? '';
        const className = (el as HTMLElement).className ?? '';
        const cs = window.getComputedStyle(el as HTMLElement);
        return {
          style,
          className,
          width: cs.width,
          height: cs.height,
          minWidth: cs.minWidth,
          minHeight: cs.minHeight,
        };
      });
      // No silent inline shrink below the applicable floor.
      expect(meta.style, `${label} must not use silent inline width/height`).not.toMatch(
        /width\s*:|height\s*:/i,
      );
      expect(
        box!.width,
        `${label} width ${box!.width}px must be >= ${min} CSS px at 320px (${JSON.stringify({ box, meta })})`,
      ).toBeGreaterThanOrEqual(min - 0.5);
      expect(
        box!.height,
        `${label} height ${box!.height}px must be >= ${min} CSS px at 320px (${JSON.stringify({ box, meta })})`,
      ).toBeGreaterThanOrEqual(min - 0.5);
    };

    // 1) Task-list clear-search (compact .icon-btn) at 320px.
    const search = page.getByRole('searchbox', { name: 'Search tasks' });
    await expect(search).toBeVisible();
    await search.fill('S02 flow');
    const clearSearch = page.getByRole('button', { name: 'Clear search' });
    await assertHitTarget(clearSearch, 'Clear search');

    // Dense row chrome: explicit .icon-btn--dense, no inline size.
    const row = page.locator('.group').filter({ hasText: 'S02 flow hit target task' }).first();
    await row.hover();
    const renameBtn = row.getByRole('button', { name: 'Rename task' });
    await assertHitTarget(renameBtn, 'Rename task', { dense: true });
    const renameMeta = await renameBtn.evaluate((el) => ({
      className: (el as HTMLElement).className ?? '',
      style: (el as HTMLElement).getAttribute('style') ?? '',
    }));
    expect(renameMeta.className, 'Rename task must use icon-btn--dense').toMatch(/icon-btn--dense/);

    // 2) Composer Settings (compact .icon-btn).
    const composerSettings = page.getByRole('button', { name: 'Settings', exact: true });
    await assertHitTarget(composerSettings, 'Composer Settings');

    // 3) Settings header Back (compact .icon-btn).
    await composerSettings.click();
    const backToTasks = page.getByRole('button', { name: 'Back to tasks' });
    await assertHitTarget(backToTasks, 'Back to tasks');

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
  });
});





test.describe('M019 S01 Composer readiness', () => {
  function fiveMissingSnapshot(correlationId = 'e2e-corr-missing') {
    const checkedAt = '2026-07-25T00:00:00.000Z';
    const backends = ['claude', 'grok', 'kiro', 'codex', 'opencode'].map((backendId) => ({
      backendId,
      state: 'missing',
      code: 'executable_missing',
      recoveryAction: 'install',
      compatibility: 'unknown',
      versionEvidence: null,
      checkedAt,
    }));
    return {
      schemaVersion: 1,
      correlationId,
      phase: 'settled',
      checkedAt,
      backends,
    };
  }

  function oneInstalledUnverifiedSnapshot(correlationId = 'e2e-corr-opencode') {
    const checkedAt = '2026-07-25T00:01:00.000Z';
    const backends = ['claude', 'grok', 'kiro', 'codex', 'opencode'].map((backendId) => {
      if (backendId === 'opencode') {
        return {
          backendId,
          state: 'installed_unverified',
          code: 'version_unknown',
          recoveryAction: 'retry',
          compatibility: 'unknown',
          versionEvidence: '1.0.0',
          checkedAt,
        };
      }
      return {
        backendId,
        state: 'missing',
        code: 'executable_missing',
        recoveryAction: 'install',
        compatibility: 'unknown',
        versionEvidence: null,
        checkedAt,
      };
    });
    return {
      schemaVersion: 1,
      correlationId,
      phase: 'settled',
      checkedAt,
      backends,
    };
  }

  test('loading then settled-empty blocks draft; refresh installs unverified option; existing task stays usable', async ({
    page,
  }) => {
    // This suite owns the readiness state machine itself, so it must start from
    // the unseeded loading state rather than the shared all-installed seed.
    await openWebview(page, { backendReadiness: 'none' });

    // Loading: no readiness / backends yet → guidance + disabled draft picker.
    await page.getByRole('button', { name: 'New task' }).click();
    await expect(page.getByTestId('backend-readiness-guidance')).toBeVisible();
    await expect(page.getByTestId('refresh-backends')).toBeVisible();
    const draftPicker = page.getByTestId('draft-model-picker');
    await expect(draftPicker).toHaveAttribute('disabled', '');

    // Settled empty (all missing).
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: fiveMissingSnapshot(),
    });
    await expect(page.getByTestId('backend-readiness-guidance')).toContainText(/No supported agent CLIs/i);
    await expect(draftPicker).toHaveAttribute('disabled', '');
    await expect(page.getByPlaceholder('Install a supported agent CLI to start a task…')).toBeVisible();

    // Refresh action posts correlated refreshBackendReadiness.
    const beforeRefresh = (await postedMessages(page)).length;
    await page.getByTestId('refresh-backends').click();
    await expect
      .poll(async () =>
        (await postedMessages(page))
          .slice(beforeRefresh)
          .some((m) => (m as { type?: string }).type === 'refreshBackendReadiness'),
      )
      .toBe(true);

    // Installed-unverified becomes selectable; missing providers stay off the list.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: oneInstalledUnverifiedSnapshot(),
    });
    await expect(draftPicker).not.toHaveAttribute('disabled', '');
    const optionLabels = await draftPicker.locator('vscode-option').allTextContents();
    expect(optionLabels.join(' ')).toMatch(/installed, unverified/i);
    expect(optionLabels.join(' ').toLowerCase()).not.toContain('claude');

    // Existing task non-regression: task composer remains usable with bound backend.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 't-existing',
          goal: 'Existing task',
          backend: 'claude',
          lifecycle: 'open',
          viewStatus: 'idle',
        }),
      ],
      focusedTaskId: 't-existing',
      subtree: [],
      transcript: [],
      transcriptPage: { hasMoreBefore: false, workspaceRevision: 1 },
      storeRevision: 1,
    });
    await expect(page.getByTestId('task-model-switch')).toBeVisible();
    const taskComposer = page.getByPlaceholder('Message this task…');
    await expect(taskComposer).toBeVisible();
    await expect(taskComposer).not.toBeDisabled();
  });
});

test.describe('M019 S02 Test Connection', () => {
  // S03 relocated Test Connection from draft Composer to Agents → Backends.
  // Assertions preserve S02 progress/ready/auth/cancel/stale-drop contracts on
  // the stable settings-backends surface (backend-row-*).
  const checkedAt = '2026-07-25T02:00:00.000Z';

  function allInstalledUnverifiedSnapshot(correlationId = 'e2e-s02-unverified') {
    const backends = ['claude', 'grok', 'kiro', 'codex', 'opencode'].map((backendId) => ({
      backendId,
      state: 'installed_unverified',
      code: 'version_unknown',
      recoveryAction: 'retry',
      compatibility: 'unknown',
      versionEvidence: '1.0.0',
      checkedAt,
    }));
    return {
      schemaVersion: 1,
      correlationId,
      phase: 'settled',
      checkedAt,
      backends,
    };
  }

  function withClaudeState(
    base: ReturnType<typeof allInstalledUnverifiedSnapshot>,
    claude: {
      state: string;
      code: string;
      recoveryAction: string;
      compatibility?: string;
      versionEvidence?: string | null;
      checkedAt?: string;
    },
  ) {
    return {
      ...base,
      correlationId: `${base.correlationId}-${claude.state}`,
      checkedAt: claude.checkedAt ?? base.checkedAt,
      backends: base.backends.map((record) =>
        record.backendId === 'claude'
          ? {
              ...record,
              state: claude.state,
              code: claude.code,
              recoveryAction: claude.recoveryAction,
              compatibility: claude.compatibility ?? record.compatibility,
              versionEvidence:
                claude.versionEvidence === undefined
                  ? record.versionEvidence
                  : claude.versionEvidence,
              checkedAt: claude.checkedAt ?? record.checkedAt,
            }
          : record,
      ),
    };
  }

  async function openAgentsBackendsProbeSurface(page: Page) {
    // Default harness seeds all-installed-unverified so Claude is probe-eligible.
    await openWebview(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('tab', { name: 'Agents' }).click();
    const surface = page.getByTestId('settings-backends');
    await expect(surface).toBeVisible();
    const claudeRow = page.getByTestId('backend-row-claude');
    await expect(claudeRow).toBeVisible();
    await expect(claudeRow).toHaveAttribute('data-backend-state', 'installed_unverified');
    await expect(page.getByTestId('backend-row-diagnostic-claude')).toContainText(
      /Claude is installed but not yet verified/i,
    );
    await expect(page.getByTestId('backend-row-test-claude')).toBeVisible();
    return surface;
  }

  test('idle start posts correlated probe; progress/ready and auth diagnostics render; cancel posts cancel; keyboard reachable', async ({
    page,
  }) => {
    const surface = await openAgentsBackendsProbeSurface(page);
    const start = page.getByTestId('backend-row-test-claude');

    // Keyboard/status semantics: Test Connection is a real button with aria-label.
    await start.focus();
    await expect(start).toBeFocused();
    await expect(start).toHaveAttribute('aria-label', /Test Connection for Claude/i);

    const beforeStart = (await postedMessages(page)).length;
    await start.click();

    // Webview posts one correlated startBackendProbe (schemaVersion + probeId + backendId).
    let startMsg: {
      type?: string;
      schemaVersion?: number;
      probeId?: string;
      backendId?: string;
    } | null = null;
    await expect
      .poll(async () => {
        const msgs = (await postedMessages(page)).slice(beforeStart);
        startMsg =
          (msgs.find(
            (m) => (m as { type?: string }).type === 'startBackendProbe',
          ) as typeof startMsg) ?? null;
        return startMsg?.type === 'startBackendProbe';
      })
      .toBe(true);
    expect(startMsg?.schemaVersion).toBe(1);
    expect(startMsg?.backendId).toBe('claude');
    expect(typeof startMsg?.probeId).toBe('string');
    expect(startMsg?.probeId?.length).toBeGreaterThan(0);
    const probeId = startMsg!.probeId as string;

    // Local correlation flips the row to testing + Cancel before host settles.
    await expect(page.getByTestId('backend-row-claude')).toHaveClass(/backend-row--testing/);
    await expect(page.getByTestId('backend-row-progress-claude')).toBeVisible();
    const cancel = page.getByTestId('backend-row-cancel-claude');
    await expect(cancel).toBeVisible();
    await expect(cancel).toHaveAttribute('aria-label', /Cancel Test Connection for Claude/i);

    // Host progress (version stage) updates status without inventing readiness truth.
    await postRawHostMessage(page, {
      type: 'backendProbeProgress',
      progress: {
        schemaVersion: 1,
        probeId,
        backendId: 'claude',
        stage: 'version',
        startedAt: '2026-07-25T02:00:01.000Z',
      },
    });
    await expect(page.getByTestId('backend-row-progress-claude')).toContainText(/Checking version/i);

    // Host testing snapshot keeps Cancel and does not enable Start.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: withClaudeState(allInstalledUnverifiedSnapshot(), {
        state: 'testing',
        code: 'none',
        recoveryAction: 'none',
        checkedAt: '2026-07-25T02:00:01.000Z',
      }),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute('data-backend-state', 'testing');
    await expect(page.getByTestId('backend-row-test-claude')).toHaveCount(0);
    await expect(cancel).toBeVisible();

    // Ready terminal: status shows ready/version evidence; Start may reappear (re-probe).
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: withClaudeState(allInstalledUnverifiedSnapshot('e2e-s02-ready'), {
        state: 'ready',
        code: 'none',
        recoveryAction: 'none',
        compatibility: 'compatible',
        versionEvidence: '1.0.0',
        checkedAt: '2026-07-25T02:00:02.000Z',
      }),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute('data-backend-state', 'ready');
    await expect(page.getByTestId('backend-row-diagnostic-claude')).toContainText(/Claude is ready/i);
    await expect(page.getByTestId('backend-row-version-claude')).toContainText(/1\.0\.0/);
    await expect(page.getByTestId('backend-row-cancel-claude')).toHaveCount(0);
    await expect(page.getByTestId('backend-row-test-claude')).toBeVisible();

    // Probe never posts session/prompt or task send traffic.
    const afterReady = await postedMessages(page);
    expect(
      afterReady.some((m) => {
        const type = (m as { type?: string }).type;
        return type === 'send' || type === 'session/prompt' || type === 'prompt';
      }),
    ).toBe(false);

    // Auth diagnostic path: re-start, progress authenticate, settle auth_required.
    const beforeAuthStart = (await postedMessages(page)).length;
    await page.getByTestId('backend-row-test-claude').click();
    let authProbeId: string | null = null;
    await expect
      .poll(async () => {
        const msgs = (await postedMessages(page)).slice(beforeAuthStart);
        const msg = msgs.find(
          (m) => (m as { type?: string }).type === 'startBackendProbe',
        ) as { probeId?: string } | undefined;
        authProbeId = msg?.probeId ?? null;
        return typeof authProbeId === 'string' && authProbeId.length > 0;
      })
      .toBe(true);

    await postRawHostMessage(page, {
      type: 'backendProbeProgress',
      progress: {
        schemaVersion: 1,
        probeId: authProbeId,
        backendId: 'claude',
        stage: 'authenticate',
        startedAt: '2026-07-25T02:00:03.000Z',
      },
    });
    await expect(page.getByTestId('backend-row-progress-claude')).toContainText(
      /Checking authentication/i,
    );

    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: withClaudeState(allInstalledUnverifiedSnapshot('e2e-s02-auth'), {
        state: 'auth_required',
        code: 'auth_required',
        recoveryAction: 'login',
        compatibility: 'unknown',
        versionEvidence: '1.0.0',
        checkedAt: '2026-07-25T02:00:04.000Z',
      }),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'auth_required',
    );
    await expect(page.getByTestId('backend-row-status-claude')).toContainText(/Sign in required/i);
    await expect(page.getByTestId('backend-row-diagnostic-claude')).toContainText(/sign in/i);
    await expect(page.getByTestId('backend-row-test-claude')).toBeVisible();
    await expect(page.getByTestId('backend-row-cancel-claude')).toHaveCount(0);

    // Cancel path: start → cancel posts cancelBackendProbe with same probeId.
    const beforeCancelStart = (await postedMessages(page)).length;
    await page.getByTestId('backend-row-test-claude').click();
    let cancelProbeId: string | null = null;
    await expect
      .poll(async () => {
        const msgs = (await postedMessages(page)).slice(beforeCancelStart);
        const msg = msgs.find(
          (m) => (m as { type?: string }).type === 'startBackendProbe',
        ) as { probeId?: string } | undefined;
        cancelProbeId = msg?.probeId ?? null;
        return typeof cancelProbeId === 'string' && cancelProbeId.length > 0;
      })
      .toBe(true);

    await expect(page.getByTestId('backend-row-cancel-claude')).toBeVisible();
    const beforeCancel = (await postedMessages(page)).length;
    await page.getByTestId('backend-row-cancel-claude').click();
    await expect
      .poll(async () =>
        (await postedMessages(page))
          .slice(beforeCancel)
          .some(
            (m) =>
              (m as { type?: string; probeId?: string; backendId?: string }).type ===
                'cancelBackendProbe' &&
              (m as { probeId?: string }).probeId === cancelProbeId &&
              (m as { backendId?: string }).backendId === 'claude',
          ),
      )
      .toBe(true);

    // Host cancel settles back to installed_unverified (never claims ready/failed).
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: withClaudeState(allInstalledUnverifiedSnapshot('e2e-s02-cancelled'), {
        state: 'installed_unverified',
        code: 'cancelled',
        recoveryAction: 'retry',
        checkedAt: '2026-07-25T02:00:05.000Z',
      }),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'installed_unverified',
    );
    await expect(page.getByTestId('backend-row-diagnostic-claude')).toContainText(
      /installed but not yet verified|cancelled/i,
    );
    await expect(page.getByTestId('backend-row-test-claude')).toBeVisible();
    await expect(page.getByTestId('backend-row-cancel-claude')).toHaveCount(0);

    // Stale/unsolicited progress for a different probeId must not hijack status.
    await postRawHostMessage(page, {
      type: 'backendProbeProgress',
      progress: {
        schemaVersion: 1,
        probeId: 'stale-other-probe',
        backendId: 'claude',
        stage: 'session',
        startedAt: '2026-07-25T02:00:06.000Z',
      },
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'installed_unverified',
    );
    // No progress row for a stale probe when idle; status must not claim session stage.
    await expect(page.getByTestId('backend-row-progress-claude')).toHaveCount(0);
    await expect(surface).toBeVisible();
  });
});

test.describe('M019 S03 First Run Journey', () => {
  const checkedAt = '2026-07-25T03:00:00.000Z';

  function fiveMissingSnapshot(correlationId = 'e2e-s03-missing') {
    const backends = ['claude', 'grok', 'kiro', 'codex', 'opencode'].map((backendId) => ({
      backendId,
      state: 'missing',
      code: 'executable_missing',
      recoveryAction: 'install',
      compatibility: 'unknown',
      versionEvidence: null,
      checkedAt,
    }));
    return {
      schemaVersion: 1,
      correlationId,
      phase: 'settled',
      checkedAt,
      backends,
    };
  }

  function oneInstalledUnverifiedSnapshot(correlationId = 'e2e-s03-unverified') {
    const backends = ['claude', 'grok', 'kiro', 'codex', 'opencode'].map((backendId) => {
      if (backendId === 'claude') {
        return {
          backendId,
          state: 'installed_unverified',
          code: 'version_unknown',
          recoveryAction: 'retry',
          compatibility: 'unknown',
          versionEvidence: '1.0.0',
          checkedAt,
        };
      }
      return {
        backendId,
        state: 'missing',
        code: 'executable_missing',
        recoveryAction: 'install',
        compatibility: 'unknown',
        versionEvidence: null,
        checkedAt,
      };
    });
    return {
      schemaVersion: 1,
      correlationId,
      phase: 'settled',
      checkedAt,
      backends,
    };
  }

  function claudeReadySnapshot(correlationId = 'e2e-s03-ready') {
    const base = oneInstalledUnverifiedSnapshot(correlationId);
    return {
      ...base,
      backends: base.backends.map((record) =>
        record.backendId === 'claude'
          ? {
              ...record,
              state: 'ready',
              code: 'none',
              recoveryAction: 'none',
              compatibility: 'compatible',
              versionEvidence: '1.0.0',
              checkedAt: '2026-07-25T03:00:02.000Z',
            }
          : record,
      ),
    };
  }

  test('assembled journey: empty state → Agents Backends → refresh/test → ready → draft send; 320px usable', async ({
    page,
  }) => {
    // Start unseeded so the derived first-run journey owns the empty-state path.
    await openWebview(page, { backendReadiness: 'none' });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 1,
    });

    // Settled empty → install step visible; no Composer probe controls remain.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: fiveMissingSnapshot(),
    });
    const journey = page.getByTestId('first-run-journey');
    await expect(journey).toBeVisible();
    await expect(journey).toHaveAttribute('data-active-step', 'install');
    await expect(page.getByTestId('first-run-step-install')).toHaveAttribute(
      'data-step-state',
      'active',
    );
    await expect(page.getByTestId('start-backend-probe')).toHaveCount(0);
    await expect(page.getByTestId('backend-probe-surface')).toHaveCount(0);

    // Primary action deep-links into Agents → Backends.
    await page.getByTestId('first-run-journey-primary').click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByTestId('settings-backends')).toBeVisible();
    await expect(page.getByTestId('backends-list')).toBeVisible();
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'missing',
    );

    // Refresh from the Backends surface posts refreshBackendReadiness.
    const beforeRefresh = (await postedMessages(page)).length;
    await page.getByTestId('backends-refresh').click();
    await expect
      .poll(async () =>
        (await postedMessages(page))
          .slice(beforeRefresh)
          .some((m) => (m as { type?: string }).type === 'refreshBackendReadiness'),
      )
      .toBe(true);

    // Host settles one installed_unverified; Test Connection becomes available.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: oneInstalledUnverifiedSnapshot(),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'installed_unverified',
    );
    const testBtn = page.getByTestId('backend-row-test-claude');
    await expect(testBtn).toBeVisible();
    await testBtn.focus();
    await expect(testBtn).toBeFocused();

    const beforeProbe = (await postedMessages(page)).length;
    await testBtn.click();
    let probeId: string | null = null;
    await expect
      .poll(async () => {
        const msgs = (await postedMessages(page)).slice(beforeProbe);
        const msg = msgs.find(
          (m) => (m as { type?: string }).type === 'startBackendProbe',
        ) as { probeId?: string; backendId?: string } | undefined;
        probeId = msg?.probeId ?? null;
        return msg?.backendId === 'claude' && typeof probeId === 'string';
      })
      .toBe(true);

    await postRawHostMessage(page, {
      type: 'backendProbeProgress',
      progress: {
        schemaVersion: 1,
        probeId,
        backendId: 'claude',
        stage: 'version',
        startedAt: '2026-07-25T03:00:01.000Z',
      },
    });
    await expect(page.getByTestId('backend-row-progress-claude')).toContainText(/Checking version/i);

    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: claudeReadySnapshot(),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'ready',
    );
    await expect(page.getByTestId('backend-row-diagnostic-claude')).toContainText(/Claude is ready/i);

    // Leave Settings; journey advances to first-task with ready evidence.
    await page.getByRole('button', { name: /Back/i }).first().click();
    await expect(page.getByTestId('first-run-journey')).toBeVisible();
    await expect(page.getByTestId('first-run-journey')).toHaveAttribute(
      'data-active-step',
      'first-task',
    );
    await expect(page.getByTestId('first-run-journey-detail')).toContainText(/Claude is ready/i);

    // Start first task from journey → draft composer; send posts selected backend.
    await page.getByTestId('first-run-journey-primary').click();
    await expectPostedMessage(page, { type: 'newTask' });
    const draftPicker = page.getByTestId('draft-model-picker');
    await expect(draftPicker).toBeVisible();
    await expect(draftPicker).not.toHaveAttribute('disabled', '');
    // Ready backend: setup guidance strip is hidden; probe controls stay relocated away.
    await expect(page.getByTestId('start-backend-probe')).toHaveCount(0);
    await expect(page.getByTestId('backend-probe-surface')).toHaveCount(0);
    // Journey secondary still exposes Open backend setup while on first-task step before draft.
    // After draft opens with a ready backend, Composer does not re-show setup chrome.
    await expect(page.getByTestId('open-backend-setup')).toHaveCount(0);

    const composer = page.getByPlaceholder(/Start a new coordinator task/i);
    await composer.fill('First accepted task after ready probe');
    await page.getByRole('button', { name: 'Send' }).click();
    await expectPostedMessage(page, {
      type: 'send',
      text: 'First accepted task after ready probe',
      backend: 'claude',
    });

    // Leave draft so the task list shell is visible, then prove history remains
    // listable even when no backend is currently ready.
    await page.getByRole('button', { name: 'Back to tasks list' }).click();
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 't-history',
          goal: 'Prior task still openable',
          backend: 'claude',
          lifecycle: 'open',
          viewStatus: 'idle',
        }),
      ],
      // Omit focusedTaskId (null is rejected by isExtMessage).
      storeRevision: 2,
    });
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: fiveMissingSnapshot('e2e-s03-history-missing'),
    });
    // Journey hides once taskCount > 0 (no durable onboarding flag).
    await expect(page.getByTestId('first-run-journey')).toHaveCount(0);
    await expect(page.getByText('Prior task still openable')).toBeVisible();

    // 320px density: reopen empty journey + Backends remains operable.
    await page.setViewportSize({ width: 320, height: 720 });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 3,
    });
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: oneInstalledUnverifiedSnapshot('e2e-s03-narrow'),
    });
    await expect(page.getByTestId('first-run-journey')).toBeVisible();
    await page.getByTestId('first-run-journey-primary').click();
    await expect(page.getByTestId('settings-backends')).toBeVisible();
    await expect(page.getByTestId('backend-row-test-claude')).toBeVisible();
    const backendsBox = await page.getByTestId('settings-backends').boundingBox();
    expect(backendsBox).toBeTruthy();
    expect(backendsBox!.width).toBeLessThanOrEqual(320);
  });

  test('revealBackendDiagnostics deep-link focuses settings-backends', async ({ page }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 1,
    });
    await postRawHostMessage(page, {
      type: 'revealBackendDiagnostics',
    });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const backends = page.getByTestId('settings-backends');
    await expect(backends).toBeVisible();
    await expect
      .poll(async () => controlHasFocus(backends))
      .toBe(true);
  });
});

test.describe('M019 S04 Doctor + runtime recovery', () => {
  const checkedAt = '2026-07-26T16:00:00.000Z';

  function fiveReadySnapshot(correlationId = 'e2e-s04-ready') {
    const backends = ['claude', 'grok', 'kiro', 'codex', 'opencode'].map((backendId) => ({
      backendId,
      state: 'ready',
      code: 'none',
      recoveryAction: 'none',
      compatibility: 'compatible',
      versionEvidence: '2.1.4',
      checkedAt,
    }));
    return {
      schemaVersion: 1,
      correlationId,
      phase: 'settled',
      checkedAt,
      backends,
    };
  }

  function withClaudeInvalidated(
    base: ReturnType<typeof fiveReadySnapshot>,
    claude: {
      state: string;
      code: string;
      recoveryAction: string;
      compatibility?: string;
      checkedAt?: string;
    },
  ) {
    return {
      ...base,
      correlationId: `${base.correlationId}-${claude.state}`,
      backends: base.backends.map((record) =>
        record.backendId === 'claude'
          ? {
              ...record,
              state: claude.state,
              code: claude.code,
              recoveryAction: claude.recoveryAction,
              compatibility: claude.compatibility ?? record.compatibility,
              checkedAt: claude.checkedAt ?? '2026-07-26T16:05:00.000Z',
            }
          : record,
      ),
    };
  }

  test('Doctor refresh-then-reveal focuses settings-backends on refreshed snapshot', async ({
    page,
  }) => {
    // Host Doctor order (T02): refresh readiness publish, open chat, then post
    // revealBackendDiagnostics. Playwright proves the S03 deep-link contract still
    // focuses Agents → Backends after a refreshed readiness snapshot lands first.
    await openWebview(page, { backendReadiness: 'none' });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 1,
    });

    // Doctor refresh publishes the shared readiness snapshot first.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: fiveReadySnapshot('e2e-s04-doctor-refresh'),
    });

    // Then Doctor posts the S03 reveal deep-link.
    await postRawHostMessage(page, {
      type: 'revealBackendDiagnostics',
    });

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const backends = page.getByTestId('settings-backends');
    await expect(backends).toBeVisible();
    await expect(page.getByTestId('backends-list')).toBeVisible();
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'ready',
    );
    await expect(page.getByTestId('backend-row-diagnostic-claude')).toContainText(
      /Claude is ready/i,
    );
    await expect
      .poll(async () => controlHasFocus(backends))
      .toBe(true);
  });

  test('runtime-invalidated provider shows same Agents Backends recovery guidance', async ({
    page,
  }) => {
    // Assembled S04 browser path: ready inventory visible on Agents Backends,
    // then a later runtime invalidation republishes the same sanitized readiness
    // channel with auth_required + login recovery (no second diagnostic vocabulary).
    await openWebview(page, { backendReadiness: 'none' });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        {
          id: 't-live',
          parentId: null,
          goal: 'Live task that later hits auth setup failure',
          role: 'worker',
          lifecycle: 'open',
          viewStatus: 'failed',
          currentTurnActivity: null,
          updatedAt: checkedAt,
          backend: 'claude',
        },
      ],
      storeRevision: 1,
    });

    // Doctor / inventory: all ready.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: fiveReadySnapshot('e2e-s04-ready-base'),
    });
    await postRawHostMessage(page, {
      type: 'revealBackendDiagnostics',
    });

    await expect(page.getByTestId('settings-backends')).toBeVisible();
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'ready',
    );

    // Later real-task auth setup failure invalidates only claude via shared snapshot.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: withClaudeInvalidated(fiveReadySnapshot('e2e-s04-runtime-auth'), {
        state: 'auth_required',
        code: 'auth_required',
        recoveryAction: 'login',
        compatibility: 'compatible',
        checkedAt: '2026-07-26T16:10:00.000Z',
      }),
    });

    const claudeRow = page.getByTestId('backend-row-claude');
    await expect(claudeRow).toHaveAttribute('data-backend-state', 'auth_required');
    await expect(page.getByTestId('backend-row-status-claude')).toContainText(
      /Sign in required/i,
    );
    await expect(page.getByTestId('backend-row-diagnostic-claude')).toContainText(
      /sign in/i,
    );
    // Same recovery affordance as S02 Test Connection auth path: re-test remains available.
    await expect(page.getByTestId('backend-row-test-claude')).toBeVisible();
    // Sibling providers stay ready (only the failing provider is invalidated).
    await expect(page.getByTestId('backend-row-codex')).toHaveAttribute(
      'data-backend-state',
      'ready',
    );

    // Spawn-style invalidation also lands on the same surface with install recovery.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: withClaudeInvalidated(fiveReadySnapshot('e2e-s04-runtime-missing'), {
        state: 'missing',
        code: 'executable_missing',
        recoveryAction: 'install',
        compatibility: 'unknown',
        checkedAt: '2026-07-26T16:12:00.000Z',
      }),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'missing',
    );
    await expect(page.getByTestId('backend-row-status-claude')).toContainText(/Not installed|Missing|Install/i);
  });
});

test.describe('M019 S05 Assembled First Run', () => {
  const checkedAt = '2026-07-26T18:00:00.000Z';

  /** Harness noise: optional assets may 403/abort under vite without app impact. */
  function isHarnessNoise(text: string): boolean {
    return (
      /403\s*\(Forbidden\)/i.test(text) ||
      /Failed to load resource:.*403/i.test(text) ||
      /favicon\.ico/i.test(text) ||
      /codicon\.(ttf|woff2?|css)/i.test(text) ||
      /@vscode\/codicons/i.test(text) ||
      /net::ERR_ABORTED/i.test(text)
    );
  }

  function fiveMissingSnapshot(correlationId = 'e2e-s05-missing') {
    const backends = ['claude', 'grok', 'kiro', 'codex', 'opencode'].map((backendId) => ({
      backendId,
      state: 'missing',
      code: 'executable_missing',
      recoveryAction: 'install',
      compatibility: 'unknown',
      versionEvidence: null,
      checkedAt,
    }));
    return {
      schemaVersion: 1,
      correlationId,
      phase: 'settled',
      checkedAt,
      backends,
    };
  }

  function oneInstalledUnverifiedSnapshot(correlationId = 'e2e-s05-unverified') {
    const backends = ['claude', 'grok', 'kiro', 'codex', 'opencode'].map((backendId) => {
      if (backendId === 'claude') {
        return {
          backendId,
          state: 'installed_unverified',
          code: 'version_unknown',
          recoveryAction: 'retry',
          compatibility: 'unknown',
          versionEvidence: '1.0.0',
          checkedAt,
        };
      }
      return {
        backendId,
        state: 'missing',
        code: 'executable_missing',
        recoveryAction: 'install',
        compatibility: 'unknown',
        versionEvidence: null,
        checkedAt,
      };
    });
    return {
      schemaVersion: 1,
      correlationId,
      phase: 'settled',
      checkedAt,
      backends,
    };
  }

  function claudeReadySnapshot(correlationId = 'e2e-s05-ready') {
    const base = oneInstalledUnverifiedSnapshot(correlationId);
    return {
      ...base,
      backends: base.backends.map((record) =>
        record.backendId === 'claude'
          ? {
              ...record,
              state: 'ready',
              code: 'none',
              recoveryAction: 'none',
              compatibility: 'compatible',
              versionEvidence: '1.0.0',
              checkedAt: '2026-07-26T18:00:02.000Z',
            }
          : record,
      ),
    };
  }

  test('assembled clean-profile: setup → ready backend → Doctor → first send; keyboard + 320px; Settings draft + sanitized diagnostics; no console/network errors', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (isHarnessNoise(text)) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(String(err?.message ?? err));
    });
    page.on('requestfailed', (req) => {
      const entry = `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`;
      if (isHarnessNoise(entry) || /favicon\.ico/i.test(req.url())) return;
      failedRequests.push(entry);
    });

    // Supportive browser proof only — not native Extension Host acceptance.
    await openWebview(page, { backendReadiness: 'none' });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 1,
    });

    // 1) No-task setup: settled empty journey owns install step.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: fiveMissingSnapshot(),
    });
    const journey = page.getByTestId('first-run-journey');
    await expect(journey).toBeVisible();
    await expect(journey).toHaveAttribute('data-active-step', 'install');
    await expect(page.getByTestId('start-backend-probe')).toHaveCount(0);

    // Keyboard: primary action is focusable and activates via Enter.
    const primary = page.getByTestId('first-run-journey-primary');
    await primary.focus();
    await expect(primary).toBeFocused();
    await primary.press('Enter');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByTestId('settings-backends')).toBeVisible();
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'missing',
    );

    // Keep an unrelated Settings draft dirty through readiness operations.
    await postRawHostMessage(page, {
      type: 'taskTypesSettingsSnapshot',
      snapshot: taskTypesOkSnapshot(),
    });
    const settingsDraft = page.locator('#tt-desc-0');
    const settingsDirty = page.getByTestId('task-types-dirty');
    await expect(settingsDraft).toBeVisible();
    await settingsDraft.fill('Preserve through backend diagnostics');
    await expect(settingsDirty).toBeVisible();
    const expectSettingsDraftPreserved = async () => {
      await expect(settingsDraft).toHaveValue('Preserve through backend diagnostics');
      await expect(settingsDirty).toBeVisible();
    };

    // The Backends surface exposes named region/list/status/action semantics.
    const backendsRegion = page.getByRole('region', { name: 'Backends' });
    await expect(backendsRegion).toBeVisible();
    await expect(backendsRegion.getByRole('list')).toBeVisible();
    await expect(backendsRegion.getByRole('listitem', { name: /Claude/i })).toBeVisible();
    await expect(
      backendsRegion.getByRole('button', { name: 'Refresh backends' }),
    ).toBeVisible();

    // Refresh from Agents → Backends (keyboard-reachable control).
    const refreshBtn = page.getByTestId('backends-refresh');
    await refreshBtn.focus();
    await expect(refreshBtn).toBeFocused();
    const beforeRefresh = (await postedMessages(page)).length;
    await refreshBtn.press('Enter');
    await expect
      .poll(async () =>
        (await postedMessages(page))
          .slice(beforeRefresh)
          .some((m) => (m as { type?: string }).type === 'refreshBackendReadiness'),
      )
      .toBe(true);
    await expectSettingsDraftPreserved();

    // Host settles one installed_unverified; Test Connection available.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: oneInstalledUnverifiedSnapshot(),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'installed_unverified',
    );
    await expectSettingsDraftPreserved();
    const testBtn = page.getByRole('button', { name: 'Test Connection for Claude' });
    await expect(testBtn).toBeVisible();
    await testBtn.focus();
    await expect(testBtn).toBeFocused();

    const beforeProbe = (await postedMessages(page)).length;
    await testBtn.press('Enter');
    let probeId: string | null = null;
    await expect
      .poll(async () => {
        const msgs = (await postedMessages(page)).slice(beforeProbe);
        const msg = msgs.find(
          (m) => (m as { type?: string }).type === 'startBackendProbe',
        ) as { probeId?: string; backendId?: string } | undefined;
        probeId = msg?.probeId ?? null;
        return msg?.backendId === 'claude' && typeof probeId === 'string';
      })
      .toBe(true);

    await postRawHostMessage(page, {
      type: 'backendProbeProgress',
      progress: {
        schemaVersion: 1,
        probeId,
        backendId: 'claude',
        stage: 'version',
        startedAt: '2026-07-26T18:00:01.000Z',
      },
    });
    await expect(page.getByTestId('backend-row-progress-claude')).toContainText(/Checking version/i);
    await expectSettingsDraftPreserved();

    // Ready backend evidence on Agents → Backends.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: claudeReadySnapshot(),
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'ready',
    );
    await expect(page.getByTestId('backend-row-diagnostic-claude')).toContainText(/Claude is ready/i);
    await expect(
      backendsRegion.getByRole('status').filter({ hasText: /Claude is ready/i }),
    ).toBeVisible();
    await expectSettingsDraftPreserved();

    // Unsafe version evidence must reject the whole candidate snapshot.
    const unsafeVersionSnapshot = claudeReadySnapshot('e2e-s05-unsafe-version');
    unsafeVersionSnapshot.backends = unsafeVersionSnapshot.backends.map((record) =>
      record.backendId === 'claude'
        ? {
            ...record,
            state: 'auth_required',
            code: 'auth_required',
            recoveryAction: 'login',
            versionEvidence: 'sk-live-READINESS_SECRET_CANARY',
          }
        : record,
    );
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: unsafeVersionSnapshot,
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'ready',
    );

    // Extra stderr/prompt/path/store fields reject the whole snapshot too.
    const extraFieldSnapshot = claudeReadySnapshot('e2e-s05-extra-fields');
    extraFieldSnapshot.backends[0] = {
      ...extraFieldSnapshot.backends[0],
      state: 'auth_required',
      code: 'auth_required',
      recoveryAction: 'login',
      stderr: 'RAW_STDERR_CANARY',
      prompt: 'PROMPT_BODY_CANARY',
      absolutePath: 'C:\\Users\\secret\\muster.db',
      storeBody: 'STORE_BODY_CANARY',
    } as never;
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: extraFieldSnapshot,
    });
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'ready',
    );
    const renderedBackends = await backendsRegion.evaluate((element) => element.outerHTML);
    expect(renderedBackends).not.toMatch(
      /READINESS_SECRET_CANARY|RAW_STDERR_CANARY|PROMPT_BODY_CANARY|STORE_BODY_CANARY|C:\\Users\\secret/,
    );
    await expectSettingsDraftPreserved();

    // 2) Doctor refresh-then-reveal focuses settings-backends on the ready snapshot.
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: claudeReadySnapshot('e2e-s05-doctor-refresh'),
    });
    await postRawHostMessage(page, {
      type: 'revealBackendDiagnostics',
    });
    const backends = page.getByTestId('settings-backends');
    await expect(backends).toBeVisible();
    await expect.poll(async () => controlHasFocus(backends)).toBe(true);
    await expect(page.getByTestId('backend-row-claude')).toHaveAttribute(
      'data-backend-state',
      'ready',
    );
    await expectSettingsDraftPreserved();

    // Leave Settings; journey advances to first-task with ready evidence.
    await page.getByRole('button', { name: /Back/i }).first().click();
    await expect(page.getByTestId('first-run-journey')).toBeVisible();
    await expect(page.getByTestId('first-run-journey')).toHaveAttribute(
      'data-active-step',
      'first-task',
    );
    await expect(page.getByTestId('first-run-journey-detail')).toContainText(/Claude is ready/i);

    // 3) First accepted send posts selected ready backend (supportive browser path).
    await page.getByTestId('first-run-journey-primary').click();
    await expectPostedMessage(page, { type: 'newTask' });
    const draftPicker = page.getByTestId('draft-model-picker');
    await expect(draftPicker).toBeVisible();
    await expect(draftPicker).not.toHaveAttribute('disabled', '');
    await expect(page.getByTestId('start-backend-probe')).toHaveCount(0);
    await expect(page.getByTestId('open-backend-setup')).toHaveCount(0);

    const composer = page.getByPlaceholder(/Start a new coordinator task/i);
    await composer.fill('Assembled first-run accepted send');
    // Keyboard send: focus Send and activate with Enter.
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await sendBtn.focus();
    await expect(sendBtn).toBeFocused();
    await sendBtn.press('Enter');
    await expectPostedMessage(page, {
      type: 'send',
      text: 'Assembled first-run accepted send',
      backend: 'claude',
    });

    // 4) 320px containment: reopen empty journey + Backends remains operable.
    await page.getByRole('button', { name: 'Back to tasks list' }).click();
    await page.setViewportSize({ width: 320, height: 720 });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [],
      storeRevision: 2,
    });
    await postRawHostMessage(page, {
      type: 'backendReadinessSnapshot',
      snapshot: oneInstalledUnverifiedSnapshot('e2e-s05-narrow'),
    });
    await expect(page.getByTestId('first-run-journey')).toBeVisible();
    await page.getByTestId('first-run-journey-primary').click();
    await expect(page.getByTestId('settings-backends')).toBeVisible();
    await expect(page.getByTestId('backend-row-test-claude')).toBeVisible();
    await expectSettingsDraftPreserved();
    const backendsBox = await page.getByTestId('settings-backends').boundingBox();
    expect(backendsBox).toBeTruthy();
    expect(backendsBox!.width).toBeLessThanOrEqual(320);

    // Doctor reveal still focuses at compact width.
    await postRawHostMessage(page, {
      type: 'revealBackendDiagnostics',
    });
    await expect.poll(async () => controlHasFocus(page.getByTestId('settings-backends'))).toBe(true);

    // Negative surface: no app console/page errors and no failed non-harness requests.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);

    // Posted host traffic must stay free of secrets and absolute paths.
    const posted = await postedMessages(page);
    const blob = JSON.stringify(posted);
    expect(blob).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(blob).not.toMatch(/[A-Za-z]:\\/);
    expect(blob).not.toMatch(/\/(?:Users|home)\/[^/\s]+/);
  });

  test('M020 live permission flow: initial diff is visible before approval and unsafe updates are rejected', async ({
    page,
  }) => {
    await openWebview(page);
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-live-diff', goal: 'Approve one edit', viewStatus: 'running' })],
      focusedTaskId: 'task-live-diff',
      subtree: [task({ id: 'task-live-diff', goal: 'Approve one edit', viewStatus: 'running' })],
      transcript: [],
      transcriptPage: { hasMoreBefore: false, workspaceRevision: 1 },
      storeRevision: 1,
    });

    await postRawHostMessage(page, {
      type: 'turnStart',
      taskId: 'task-live-diff',
      turnId: 'turn-live-diff',
      trigger: 'engine',
    });
    await postRawHostMessage(page, {
      type: 'event',
      taskId: 'task-live-diff',
      turnId: 'turn-live-diff',
      event: {
        type: 'toolStarted',
        toolCallId: 'edit-live',
        name: 'Edit',
        kind: 'builtin',
        fileChanges: [
          {
            path: 'src/live.ts',
            oldText: 'const value = 1;\n',
            newText: 'const value = 2;\n',
          },
        ],
      },
    });
    await postRawHostMessage(page, {
      type: 'permissionPending',
      sessionId: 'session-live-diff',
      permissionId: 'permission-live-diff',
      title: 'Edit src/live.ts',
      kind: 'edit',
      classification: 'write',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Deny', kind: 'reject' },
      ],
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(card).toBeVisible();
    await card.locator('button.tool-card__diff-toggle').click();
    await expect(card.locator('.tool-card__diff-line--removed')).toContainText(
      '-const value = 1;',
    );
    await expect(card.locator('.tool-card__diff-line--added')).toContainText(
      '+const value = 2;',
    );
    await expect(page.getByTestId('runtime-permission-card')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();

    // The host/webview guard must reject raw unsafe evidence rather than overwrite
    // the canonical initial diff that the user is reviewing.
    await postRawHostMessage(page, {
      type: 'event',
      taskId: 'task-live-diff',
      turnId: 'turn-live-diff',
      event: {
        type: 'toolUpdated',
        toolCallId: 'edit-live',
        fileChanges: [
          {
            path: 'C:\\Users\\alice\\secret.ts',
            oldText: 'safe',
            newText: 'UNSAFE_LIVE_DIFF_CANARY',
          },
        ],
      },
    });
    await expect(card).not.toContainText('UNSAFE_LIVE_DIFF_CANARY');
    await expect(card).not.toContainText('Users');
    await expect(card.locator('.tool-card__diff-line--added')).toContainText(
      '+const value = 2;',
    );
  });

  test('M020 S01 inline diff: ToolCard renders removed and added lines from fileChanges', async ({
    page,
  }) => {
    await openWebview(page);

    const sharedBefore = 'export function greeting() {';
    const oldLine = 'const greeting = "hello";';
    const newLine = 'const greeting = "world";';
    const sharedAfter = 'return greeting;';
    // Model-supplied markup must render as inert text, not HTML.
    const inertPayload = '<img src=x onerror=window.__m020Xss=1>';

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-diff', goal: 'Apply one-file edit' })],
      focusedTaskId: 'task-diff',
      subtree: [task({ id: 'task-diff', goal: 'Apply one-file edit' })],
      transcript: [
        {
          id: 'tool-diff-1',
          kind: 'tool',
          turnId: 'turn-diff',
          order: 0,
          content: {
            toolCallId: 'tc-diff-1',
            name: 'Edit',
            toolKind: 'builtin',
            status: 'success',
            // Evidence-only: no input/output so expandability comes from fileChanges.
            fileChanges: [
              {
                path: 'src/hello.ts',
                oldText: `${sharedBefore}\n${oldLine}\n${inertPayload}\n${sharedAfter}\n`,
                newText: `${sharedBefore}\n${newLine}\n${sharedAfter}\n`,
              },
            ],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(card).toBeVisible();
    await expect(card.getByText('src/hello.ts')).toBeVisible();

    // Diff bodies are lazy and only mount after the per-file disclosure is opened.
    await expect(card.locator('.tool-card__diff-line')).toHaveCount(0);
    await card.locator('button.tool-card__diff-toggle').click();
    const removed = card.locator('.tool-card__diff-line--removed');
    const added = card.locator('.tool-card__diff-line--added');
    await expect(removed.filter({ hasText: oldLine })).toBeVisible();
    await expect(added.filter({ hasText: newLine })).toBeVisible();
    await expect(removed.filter({ hasText: inertPayload })).toBeVisible();

    // Exact line diff: unchanged context is rendered once, not once per side.
    const context = card.locator('.tool-card__diff-line--context');
    await expect(context.filter({ hasText: sharedBefore })).toHaveCount(1);
    await expect(context.filter({ hasText: sharedAfter })).toHaveCount(1);
    await expect(card.locator('.tool-card__diff-counts')).toContainText('+1');
    await expect(card.locator('.tool-card__diff-counts')).toContainText('−2');

    // Evidence has its own per-file disclosure; the top-level header must not
    // claim to control a details region that does not exist.
    const header = card.getByRole('button').first();
    await expect(header).toBeDisabled();
    expect(await header.getAttribute('aria-expanded')).toBeNull();
    expect(await header.getAttribute('aria-controls')).toBeNull();

    // Inert rendering: markup from model text must not become a live element.
    await expect(card.locator('img')).toHaveCount(0);
    const xssFlag = await page.evaluate(() => (window as Window & { __m020Xss?: number }).__m020Xss);
    expect(xssFlag).toBeUndefined();
  });

  test('M020 S01 inline diff: content-only tool stays free of empty diff chrome', async ({
    page,
  }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-content', goal: 'Read a file' })],
      focusedTaskId: 'task-content',
      subtree: [task({ id: 'task-content', goal: 'Read a file' })],
      transcript: [
        {
          id: 'tool-read-1',
          kind: 'tool',
          turnId: 'turn-read',
          order: 0,
          content: {
            toolCallId: 'tc-read-1',
            name: 'Read',
            toolKind: 'builtin',
            status: 'success',
            input: { path: 'src/hello.ts' },
            output: 'file contents',
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Read' });
    await expect(card).toBeVisible();
    await expect(card.locator('.tool-card__diff')).toHaveCount(0);
    await expect(card.locator('.tool-card__diff-line--removed')).toHaveCount(0);
    await expect(card.locator('.tool-card__diff-line--added')).toHaveCount(0);

    // Existing expand path for input/output still works.
    const header = card.getByRole('button').first();
    await expect(header).toBeEnabled();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    const detailsId = await header.getAttribute('aria-controls');
    const headerId = await header.getAttribute('id');
    expect(detailsId).toBeTruthy();
    expect(headerId).toBeTruthy();
    const details = card.locator(`#${detailsId}`);
    await expect(details).toHaveAttribute('role', 'region');
    await expect(details).toHaveAttribute('aria-labelledby', headerId!);
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByText('params:')).toBeVisible();
    await expect(card.getByText('result:')).toBeVisible();
  });

  test('M020 S02 bounds: multi-file diffs render every path', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-multi', goal: 'Edit three files' })],
      focusedTaskId: 'task-multi',
      subtree: [task({ id: 'task-multi', goal: 'Edit three files' })],
      transcript: [
        {
          id: 'tool-multi-1',
          kind: 'tool',
          turnId: 'turn-multi',
          order: 0,
          content: {
            toolCallId: 'tc-multi-1',
            name: 'Edit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              { path: 'src/a.ts', oldText: 'a-old\n', newText: 'a-new\n' },
              { path: 'src/b.ts', oldText: 'b-old\n', newText: 'b-new\n' },
              { path: 'src/c.ts', oldText: null, newText: 'c-new\n' },
            ],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(card).toBeVisible();
    await expect(card.getByText('src/a.ts')).toBeVisible();
    await expect(card.getByText('src/b.ts')).toBeVisible();
    await expect(card.getByText('src/c.ts')).toBeVisible();
    await expect(card.locator('.tool-card__diff-file')).toHaveCount(3);
    // No truncation/omission chrome when bounds were not hit.
    await expect(card.locator('.tool-card__diff-truncated')).toHaveCount(0);
    await expect(card.locator('.tool-card__diff-omitted')).toHaveCount(0);
  });

  test('M020 S02 bounds: truncated fileChange shows honest marker', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-trunc', goal: 'Huge edit' })],
      focusedTaskId: 'task-trunc',
      subtree: [task({ id: 'task-trunc', goal: 'Huge edit' })],
      transcript: [
        {
          id: 'tool-trunc-1',
          kind: 'tool',
          turnId: 'turn-trunc',
          order: 0,
          content: {
            toolCallId: 'tc-trunc-1',
            name: 'Edit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              {
                path: 'src/big.ts',
                oldText: 'line-old\n… truncated',
                newText: 'line-new\n… truncated',
                truncated: true,
              },
            ],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(card).toBeVisible();
    await expect(card.getByText('src/big.ts')).toBeVisible();
    await card.locator('button.tool-card__diff-toggle').click();
    // Dedicated marker (not only the text suffix buried in the pre).
    const marker = card.locator('.tool-card__diff-truncated');
    await expect(marker).toHaveCount(1);
    await expect(marker).toBeVisible();
    await expect(marker).toContainText(/truncated/i);
    // Content-only chrome still absent on a pure evidence tool.
    await expect(card.locator('.tool-card__diff-omitted')).toHaveCount(0);
  });

  test('M020 S02 bounds: omitted-file count is honest and visible', async ({ page }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-omit', goal: 'Many files' })],
      focusedTaskId: 'task-omit',
      subtree: [task({ id: 'task-omit', goal: 'Many files' })],
      transcript: [
        {
          id: 'tool-omit-1',
          kind: 'tool',
          turnId: 'turn-omit',
          order: 0,
          content: {
            toolCallId: 'tc-omit-1',
            name: 'MultiEdit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              { path: 'src/kept-1.ts', oldText: null, newText: 'one\n' },
              { path: 'src/kept-2.ts', oldText: null, newText: 'two\n' },
            ],
            fileChangesOmitted: 5,
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'MultiEdit' });
    await expect(card).toBeVisible();
    await expect(card.getByText('src/kept-1.ts')).toBeVisible();
    await expect(card.getByText('src/kept-2.ts')).toBeVisible();

    const omitted = card.locator('.tool-card__diff-omitted');
    await expect(omitted).toHaveCount(1);
    await expect(omitted).toBeVisible();
    await expect(omitted).toContainText(/5/);
    await expect(omitted).toContainText(/omitted/i);
    // Truncation chrome only when truncated:true is set on an entry.
    await expect(card.locator('.tool-card__diff-truncated')).toHaveCount(0);
  });
  test('M020 S03 collapse: multi-file diff starts collapsed with counts and expands', async ({
    page,
  }) => {
    await openWebview(page);

    // Every file body starts collapsed regardless of retained diff size.
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-s03-collapse', goal: 'Edit four files' })],
      focusedTaskId: 'task-s03-collapse',
      subtree: [task({ id: 'task-s03-collapse', goal: 'Edit four files' })],
      transcript: [
        {
          id: 'tool-s03-collapse-1',
          kind: 'tool',
          turnId: 'turn-s03-collapse',
          order: 0,
          content: {
            toolCallId: 'tc-s03-collapse-1',
            name: 'MultiEdit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              { path: 'src/a.ts', oldText: null, newText: 'a-unique-body\n' },
              { path: 'src/b.ts', oldText: null, newText: 'b-unique-body\n' },
              { path: 'src/c.ts', oldText: null, newText: 'c-unique-body\n' },
              { path: 'src/d.ts', oldText: null, newText: 'd-unique-body\n' },
            ],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'MultiEdit' });
    await expect(card).toBeVisible();

    const group = card.locator('.tool-card__diff');
    await expect(group).toHaveAttribute('role', 'group');
    await expect(card.locator('.tool-card__diff-file')).toHaveCount(4);

    // Per-file counts visible while bodies are collapsed.
    const counts = card.locator('.tool-card__diff-counts');
    await expect(counts).toHaveCount(4);
    await expect(counts.first()).toContainText('+1');
    await expect(counts.first()).toContainText('−0');

    const toggles = card.locator('button.tool-card__diff-toggle');
    await expect(toggles).toHaveCount(4);
    await expect(toggles.first()).toHaveAttribute('aria-expanded', 'false');
    // Lightweight controlled regions stay mounted, but all expensive line DOM
    // is absent until an individual file is expanded.
    await expect(card.locator('.tool-card__diff-body-panel')).toHaveCount(4);
    await expect(card.locator('.tool-card__diff-line')).toHaveCount(0);

    // Collapsed panel is marked data-collapsed and clips via grid 0fr.
    // Assert collapse state via attributes + bounding box (Playwright still
    // treats overflow-hidden grid children as "visible" for toBeVisible).
    const firstBodyId = await toggles.first().getAttribute('aria-controls');
    const firstToggleId = await toggles.first().getAttribute('id');
    expect(firstBodyId).toBeTruthy();
    expect(firstToggleId).toBeTruthy();
    const firstBody = card.locator(`#${firstBodyId}`);
    await expect(firstBody).toHaveAttribute('role', 'region');
    await expect(firstBody).toHaveAttribute('aria-labelledby', firstToggleId!);
    await expect(firstBody).toHaveAttribute('data-collapsed', 'true');
    await expect(firstBody.locator('.tool-card__diff-line')).toHaveCount(0);
    const collapsedBox = await firstBody.boundingBox();
    expect(collapsedBox).toBeTruthy();
    expect(collapsedBox!.height).toBeLessThanOrEqual(1);

    await toggles.first().click();
    await expect(toggles.first()).toHaveAttribute('aria-expanded', 'true');
    await expect(firstBody).toHaveAttribute('data-collapsed', 'false');
    await expect(card.getByText('a-unique-body')).toBeVisible();
    await expect(
      card.locator('.tool-card__diff-line--added').filter({ hasText: 'a-unique-body' }),
    ).toBeVisible();
    // The panel expands via a `grid-template-rows` transition, so the row is
    // still animating when `data-collapsed` flips. A single boundingBox() sample
    // does not retry and can land mid-animation on a loaded CI runner (observed
    // height 0). Poll until the row settles instead.
    await expect
      .poll(async () => (await firstBody.boundingBox())?.height ?? 0)
      .toBeGreaterThan(1);

    await toggles.first().click();
    await expect(toggles.first()).toHaveAttribute('aria-expanded', 'false');
    await expect(firstBody).toHaveAttribute('data-collapsed', 'true');
    await expect(firstBody.locator('.tool-card__diff-line')).toHaveCount(0);
  });

  test('M020 S03 a11y: aria-controls targets body id and screen-reader summary is present', async ({
    page,
  }) => {
    await openWebview(page);

    // Long single-file diff (>24 changed lines) triggers line-threshold collapse.
    const oldText = Array.from({ length: 13 }, (_, i) => `old-line-${i + 1}`).join('\n') + '\n';
    const newText = Array.from({ length: 12 }, (_, i) => `new-line-${i + 1}`).join('\n') + '\n';

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-s03-a11y', goal: 'Long edit' })],
      focusedTaskId: 'task-s03-a11y',
      subtree: [task({ id: 'task-s03-a11y', goal: 'Long edit' })],
      transcript: [
        {
          id: 'tool-s03-a11y-1',
          kind: 'tool',
          turnId: 'turn-s03-a11y',
          order: 0,
          content: {
            toolCallId: 'tc-s03-a11y-1',
            name: 'Edit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              {
                path: 'src/long.ts',
                oldText,
                newText,
                truncated: true,
              },
            ],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(card).toBeVisible();

    const toggle = card.locator('button.tool-card__diff-toggle');
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    const controlsId = await toggle.getAttribute('aria-controls');
    const toggleId = await toggle.getAttribute('id');
    expect(controlsId).toBeTruthy();
    expect(toggleId).toBeTruthy();
    // bodyId derived from transcript item id + index, never agent path.
    expect(controlsId!).toMatch(/^tool-diff-body-/);
    expect(controlsId!).not.toContain('long.ts');
    expect(controlsId!).not.toContain('/');

    // bodyId is already DOM-safe (sanitized tool id + index); no CSS.escape needed.
    const body = card.locator(`#${controlsId}`);
    await expect(body).toHaveCount(1);
    await expect(body).toHaveAttribute('role', 'region');
    await expect(body).toHaveAttribute('aria-labelledby', toggleId!);
    await expect(body).toHaveAttribute('data-collapsed', 'true');
    await expect(body.locator('.tool-card__diff-line')).toHaveCount(0);

    const ariaLabel = await toggle.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();
    expect(ariaLabel!).toMatch(/src\/long\.ts/);
    expect(ariaLabel!).toMatch(/12 lines added/);
    expect(ariaLabel!).toMatch(/13 lines removed/);
    expect(ariaLabel!).toMatch(/partial/i);

    await expect(card.locator('.tool-card__diff-counts')).toContainText(/partial/i);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toHaveAttribute('data-collapsed', 'false');
    // exact: true — substring match would also hit old-line-10..13.
    await expect(card.getByText('-old-line-1', { exact: true })).toBeVisible();
    await expect(card.getByText('+new-line-12', { exact: true })).toBeVisible();
  });

  test('M020 S03 reduced motion: expansion transition duration is 0s', async ({ page }) => {
    await openWebview(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const newText =
      Array.from({ length: 25 }, (_, i) => `motion-line-${i + 1}`).join('\n') + '\n';

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-s03-motion', goal: 'Motion edit' })],
      focusedTaskId: 'task-s03-motion',
      subtree: [task({ id: 'task-s03-motion', goal: 'Motion edit' })],
      transcript: [
        {
          id: 'tool-s03-motion-1',
          kind: 'tool',
          turnId: 'turn-s03-motion',
          order: 0,
          content: {
            toolCallId: 'tc-s03-motion-1',
            name: 'Write',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [{ path: 'src/motion.ts', oldText: null, newText }],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Write' });
    await expect(card).toBeVisible();

    const panel = card.locator('.tool-card__diff-body-panel');
    await expect(panel).toHaveCount(1);

    const durationReduce = await panel.evaluate((el) =>
      getComputedStyle(el).transitionDuration,
    );
    expect(durationReduce === '0s' || durationReduce === '0ms').toBe(true);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const durationNormal = await panel.evaluate((el) =>
      getComputedStyle(el).transitionDuration,
    );
    const normalMs = durationNormal
      .split(',')
      .map((part) => part.trim())
      .map((part) => {
        if (part.endsWith('ms')) return Number.parseFloat(part);
        if (part.endsWith('s')) return Number.parseFloat(part) * 1000;
        return Number.NaN;
      })
      .filter((n) => Number.isFinite(n));
    expect(normalMs.some((n) => n > 0)).toBe(true);
  });

  test('M020 S03 lazy diff: small fixture starts collapsed with counts and expands', async ({
    page,
  }) => {
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-s03-small', goal: 'Tiny edit' })],
      focusedTaskId: 'task-s03-small',
      subtree: [task({ id: 'task-s03-small', goal: 'Tiny edit' })],
      transcript: [
        {
          id: 'tool-s03-small-1',
          kind: 'tool',
          turnId: 'turn-s03-small',
          order: 0,
          content: {
            toolCallId: 'tc-s03-small-1',
            name: 'Edit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              {
                path: 'src/tiny.ts',
                oldText: 'tiny-old\n',
                newText: 'tiny-new\n',
              },
            ],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(card).toBeVisible();

    await expect(card.locator('.tool-card__diff-counts')).toContainText('+1');
    const toggle = card.locator('button.tool-card__diff-toggle');
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('.tool-card__diff-line')).toHaveCount(0);

    await toggle.click();
    await expect(card.getByText('tiny-old')).toBeVisible();
    await expect(card.getByText('tiny-new')).toBeVisible();
  });
  test('M021 S03 fold: three full-budget files collapse and expand within row bounds', async ({
    page,
  }) => {
    await openWebview(page);

    // Roadmap demo: 3 files × full 2,000-line retained budget with one central
    // change. Context windows compact to ≤10 rows/file (2 folds + 6 context +
    // rem + add); rendered total 30 > line threshold → collapsed by default.
    const SIDE = 2_000;
    const half = Math.floor(SIDE / 2); // 1000 leading
    const nLines = (n: number, prefix: string): string =>
      Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n');
    const leading = nLines(half, 'lead');
    const trailing = nLines(SIDE - half - 1, 'trail'); // 999
    // Keep 3 context on each side → omit 997 leading + 996 trailing.
    const LEAD_OMITTED = half - 3; // 997
    const TRAIL_OMITTED = SIDE - half - 1 - 3; // 996
    const fullBudget = (filePath: string) => ({
      path: filePath,
      oldText: `${leading}\nOLD\n${trailing}\n`,
      newText: `${leading}\nNEW\n${trailing}\n`,
    });

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m021-s03-fold', goal: 'Bounded context windows' })],
      focusedTaskId: 'task-m021-s03-fold',
      subtree: [task({ id: 'task-m021-s03-fold', goal: 'Bounded context windows' })],
      transcript: [
        {
          id: 'tool-m021-s03-fold-1',
          kind: 'tool',
          turnId: 'turn-m021-s03-fold',
          order: 0,
          content: {
            toolCallId: 'tc-m021-s03-fold-1',
            name: 'MultiEdit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              fullBudget('src/a.ts'),
              fullBudget('src/b.ts'),
              fullBudget('src/c.ts'),
            ],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'MultiEdit' });
    await expect(card).toBeVisible();
    await expect(card.locator('.tool-card__diff-file')).toHaveCount(3);

    // Collapsed bodies mount zero line/fold DOM.
    const toggles = card.locator('button.tool-card__diff-toggle');
    await expect(toggles).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(toggles.nth(i)).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(card.locator('.tool-card__diff-line')).toHaveCount(0);
    await expect(card.locator('.tool-card__diff-line--fold')).toHaveCount(0);

    // Expand every file body and assert the rendered bound.
    for (let i = 0; i < 3; i++) {
      await toggles.nth(i).click();
      await expect(toggles.nth(i)).toHaveAttribute('aria-expanded', 'true');
    }

    const files = card.locator('.tool-card__diff-file');
    await expect(files).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const file = files.nth(i);
      const bodyId = await toggles.nth(i).getAttribute('aria-controls');
      expect(bodyId).toBeTruthy();
      const body = card.locator(`#${bodyId}`);
      await expect(body).toHaveAttribute('data-collapsed', 'false');

      // ≤10 rendered rows per full-budget single-change file.
      const lines = body.locator('.tool-card__diff-line');
      const lineCount = await lines.count();
      expect(lineCount).toBeGreaterThan(0);
      expect(lineCount).toBeLessThanOrEqual(10);

      // Fold rows are explicit counted markers, not ordinary empty source lines.
      const folds = body.locator('.tool-card__diff-line--fold');
      await expect(folds).toHaveCount(2);
      await expect(folds.nth(0)).toHaveAttribute('data-omitted-count', String(LEAD_OMITTED));
      await expect(folds.nth(1)).toHaveAttribute('data-omitted-count', String(TRAIL_OMITTED));
      await expect(folds.nth(0)).toContainText(`${LEAD_OMITTED} unchanged lines omitted`);
      await expect(folds.nth(1)).toContainText(`${TRAIL_OMITTED} unchanged lines omitted`);
      // No +/- prefix on fold markers (not source lines).
      const foldText = (await folds.nth(0).textContent()) ?? '';
      expect(foldText.startsWith('-') || foldText.startsWith('+')).toBe(false);

      // Every changed row remains visible after compaction.
      await expect(
        body.locator('.tool-card__diff-line--removed').filter({ hasText: 'OLD' }),
      ).toHaveCount(1);
      await expect(
        body.locator('.tool-card__diff-line--added').filter({ hasText: 'NEW' }),
      ).toHaveCount(1);

      // Per-file counts stay exact (fold rows never counted as added/removed).
      await expect(file.locator('.tool-card__diff-counts')).toContainText('+1');
      await expect(file.locator('.tool-card__diff-counts')).toContainText('−1');
    }

    // Expanded total across three files stays bounded (≤30 nodes).
    const allLines = card.locator('.tool-card__diff-line');
    expect(await allLines.count()).toBeLessThanOrEqual(30);

    // Inert rendering: model text never becomes live markup.
    await expect(card.locator('img')).toHaveCount(0);
  });

  test('M021 S03 fold: expanded small window renders counted fold markers', async ({
    page,
  }) => {
    await openWebview(page);

    // 10 leading + change + 10 trailing → 2 folds + 6 context + rem + add = 10
    // rows after the user expands the body.
    const nLines = (n: number, prefix: string): string =>
      Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n');
    const leading = nLines(10, 'L');
    const trailing = nLines(10, 'T');

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: 'task-m021-s03-small-fold', goal: 'Small folded window' })],
      focusedTaskId: 'task-m021-s03-small-fold',
      subtree: [task({ id: 'task-m021-s03-small-fold', goal: 'Small folded window' })],
      transcript: [
        {
          id: 'tool-m021-s03-small-fold-1',
          kind: 'tool',
          turnId: 'turn-m021-s03-small-fold',
          order: 0,
          content: {
            toolCallId: 'tc-m021-s03-small-fold-1',
            name: 'Edit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              {
                path: 'src/window.ts',
                oldText: `${leading}\nold\n${trailing}\n`,
                newText: `${leading}\nnew\n${trailing}\n`,
              },
            ],
          },
        },
      ],
      storeRevision: 1,
    });

    const card = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(card).toBeVisible();

    // Every fixture starts collapsed; full diff rows mount only after expansion.
    const toggle = card.locator('button.tool-card__diff-toggle');
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('.tool-card__diff-line')).toHaveCount(0);

    await toggle.click();
    const lines = card.locator('.tool-card__diff-line');
    expect(await lines.count()).toBeLessThanOrEqual(10);

    const folds = card.locator('.tool-card__diff-line--fold');
    await expect(folds).toHaveCount(2);
    await expect(folds.nth(0)).toHaveAttribute('data-omitted-count', '7');
    await expect(folds.nth(1)).toHaveAttribute('data-omitted-count', '7');
    await expect(folds.nth(0)).toContainText('7 unchanged lines omitted');
    await expect(folds.nth(1)).toContainText('7 unchanged lines omitted');

    // Kept context + changes are ordinary source lines; folds are not.
    // Context rows carry a single leading space prefix (diff gutter).
    await expect(card.getByText(' L-8', { exact: true })).toHaveCount(1);
    await expect(card.locator('.tool-card__diff-line--removed').filter({ hasText: 'old' })).toHaveCount(1);
    await expect(card.locator('.tool-card__diff-line--added').filter({ hasText: 'new' })).toHaveCount(1);
    // Omitted source text must not appear (exact: true so L-10 does not match L-1).
    await expect(card.getByText(' L-1', { exact: true })).toHaveCount(0);
    await expect(card.getByText(' T-10', { exact: true })).toHaveCount(0);
  });

  /**
   * M021 S04 final proof: outside-workspace warning is visible before the
   * permission decision and after durable projection, without exposing host
   * path or traversal canaries. Host evidence is already basename-canonical
   * with present-only outsideWorkspace: true (as the engine emits).
   */
  test('M021 S04 outside workspace: warning before approval and after durable projection', async ({
    page,
  }) => {
    // Synthetic canaries — must never appear in browser-visible content.
    const absCanary = 'C:\\Users\\m021-s04-canary\\secrets\\outside-secret.ts';
    const posixCanary = '/tmp/m021-s04-canary/outside-secret.ts';
    const traversalCanary = '../../etc/m021-s04-canary';
    const safeBasename = 'outside-secret.ts';

    await openWebview(page);

    // --- Phase 1: live pre-approval surface ---
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 'task-m021-s04-outside',
          goal: 'Review outside edit',
          viewStatus: 'running',
        }),
      ],
      focusedTaskId: 'task-m021-s04-outside',
      subtree: [
        task({
          id: 'task-m021-s04-outside',
          goal: 'Review outside edit',
          viewStatus: 'running',
        }),
      ],
      transcript: [],
      transcriptPage: { hasMoreBefore: false, workspaceRevision: 1 },
      storeRevision: 1,
    });

    await postRawHostMessage(page, {
      type: 'turnStart',
      taskId: 'task-m021-s04-outside',
      turnId: 'turn-m021-s04-outside',
      trigger: 'engine',
    });
    await postRawHostMessage(page, {
      type: 'event',
      taskId: 'task-m021-s04-outside',
      turnId: 'turn-m021-s04-outside',
      event: {
        type: 'toolStarted',
        toolCallId: 'edit-m021-s04-outside',
        name: 'Edit',
        kind: 'builtin',
        fileChanges: [
          {
            path: safeBasename,
            oldText: 'const secret = 1;\n',
            newText: 'const secret = 2;\n',
            outsideWorkspace: true,
          },
        ],
      },
    });
    await postRawHostMessage(page, {
      type: 'permissionPending',
      sessionId: 'session-m021-s04-outside',
      permissionId: 'permission-m021-s04-outside',
      title: `Edit ${safeBasename}`,
      kind: 'edit',
      classification: 'write',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Deny', kind: 'reject' },
      ],
    });

    const liveCard = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(liveCard).toBeVisible();
    await expect(page.getByTestId('runtime-permission-card')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();

    // Visible Outside workspace badge before the permission decision.
    const liveBadge = liveCard.locator('.tool-card__diff-outside');
    await expect(liveBadge).toHaveCount(1);
    await expect(liveBadge).toHaveText('Outside workspace');

    // Accessible summary carries the same warning (badge is aria-hidden).
    const liveSummary = liveCard.locator(
      '.tool-card__diff-summary-static, button.tool-card__diff-toggle',
    );
    await expect(liveSummary).toHaveAttribute('aria-label', /outside workspace/i);

    // Basename only — no absolute / traversal / host canaries.
    await expect(liveCard.locator('.tool-card__diff-path')).toHaveText(safeBasename);
    await expect(liveCard).not.toContainText(absCanary);
    await expect(liveCard).not.toContainText(posixCanary);
    await expect(liveCard).not.toContainText(traversalCanary);
    await expect(liveCard).not.toContainText('Users\\m021-s04-canary');
    await expect(liveCard).not.toContainText('/tmp/m021-s04-canary');
    await expect(liveCard).not.toContainText('../../etc');

    // Ordinary in-workspace path must not show the warning when co-projected.
    // (Negative control is covered in durable phase with a second file.)

    // --- Phase 2: durable snapshot projection after settle ---
    // Clear the pre-approval card so durable projection is the only surface.
    await postRawHostMessage(page, {
      type: 'permissionCleared',
      permissionId: 'permission-m021-s04-outside',
    });
    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [
        task({
          id: 'task-m021-s04-outside',
          goal: 'Review outside edit',
          viewStatus: 'idle',
        }),
      ],
      focusedTaskId: 'task-m021-s04-outside',
      subtree: [
        task({
          id: 'task-m021-s04-outside',
          goal: 'Review outside edit',
          viewStatus: 'idle',
        }),
      ],
      transcript: [
        {
          id: 'tool-m021-s04-outside-durable',
          kind: 'tool',
          turnId: 'turn-m021-s04-outside',
          order: 0,
          content: {
            toolCallId: 'edit-m021-s04-outside',
            name: 'Edit',
            toolKind: 'builtin',
            status: 'success',
            fileChanges: [
              {
                path: safeBasename,
                oldText: 'const secret = 1;\n',
                newText: 'const secret = 2;\n',
                outsideWorkspace: true,
              },
              {
                path: 'src/inside.ts',
                oldText: 'export const inside = 1;\n',
                newText: 'export const inside = 2;\n',
              },
            ],
          },
        },
      ],
      storeRevision: 2,
    });

    const durableCard = page.locator('.tool-card').filter({ hasText: 'Edit' });
    await expect(durableCard).toBeVisible();
    await expect(page.getByTestId('runtime-permission-card')).toHaveCount(0);

    const durableFiles = durableCard.locator('.tool-card__diff-file');
    await expect(durableFiles).toHaveCount(2);

    const outsideFile = durableFiles.filter({ hasText: safeBasename });
    const insideFile = durableFiles.filter({ hasText: 'src/inside.ts' });

    await expect(outsideFile.locator('.tool-card__diff-outside')).toHaveCount(1);
    await expect(outsideFile.locator('.tool-card__diff-outside')).toHaveText(
      'Outside workspace',
    );
    await expect(
      outsideFile.locator('.tool-card__diff-summary-static, button.tool-card__diff-toggle'),
    ).toHaveAttribute('aria-label', /outside workspace/i);

    // In-workspace file: no warning badge, no outside-workspace aria prose.
    await expect(insideFile.locator('.tool-card__diff-outside')).toHaveCount(0);
    await expect(
      insideFile.locator('.tool-card__diff-summary-static, button.tool-card__diff-toggle'),
    ).not.toHaveAttribute('aria-label', /outside workspace/i);

    // Still no host-layout canaries after durable projection.
    const durableBlob = await durableCard.innerText();
    expect(durableBlob).not.toContain(absCanary);
    expect(durableBlob).not.toContain(posixCanary);
    expect(durableBlob).not.toContain(traversalCanary);
    expect(durableBlob).not.toMatch(/[A-Za-z]:\\Users\\/);
    expect(durableBlob).not.toMatch(/\/tmp\/m021-s04-canary/);
    expect(durableBlob).not.toContain('../../etc');
  });

  test('M024 S05 workflow graph: focused host result renders all gates, frontier, fit, feedback, child run, and degraded state', async ({
    page,
  }) => {
    const taskId = 'task-m024-s05-workflow';
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: taskId, goal: 'Run reuse workflow', viewStatus: 'running' })],
      focusedTaskId: taskId,
      subtree: [task({ id: taskId, goal: 'Run reuse workflow', viewStatus: 'running' })],
      transcript: [],
      transcriptPage: { hasMoreBefore: false, workspaceRevision: 1 },
      storeRevision: 1,
    });

    // Workflow is on-demand via the View Workflow button next to History (no auto-fetch on focus)
    await expect(page.getByTestId('workflow-graph-modal')).toHaveCount(0);
    await expect(page.getByTestId('workflow-graph-panel')).toHaveCount(0);
    // No request yet before opening the modal
    let preMessages = await postedMessages(page);
    expect(preMessages.find((m) => (m as { type?: string }).type === 'requestWorkflowGraph')).toBeUndefined();
    await page.getByTestId('view-workflow-graph').click();

    await expect.poll(async () => {
      const messages = await postedMessages(page);
      return messages.find((message) => (message as { type?: string }).type === 'requestWorkflowGraph');
    }).toMatchObject({ type: 'requestWorkflowGraph', taskId });

    const request = (await postedMessages(page)).find(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    ) as { requestId: string; taskId: string };

    const graphPayload = {
        runId: 'run-m024-s05',
        runStatus: 'running',
        nodes: [
          { nodeId: 'node-1', title: 'Prior result', workflowNodeStatus: 'reused', executionActivity: 'none', displayState: 'reused', progressBucket: 'completed', reused: true },
          { nodeId: 'node-2', title: 'Completed source', workflowNodeStatus: 'succeeded', executionActivity: 'completed', displayState: 'completed', progressBucket: 'completed', reused: false },
          {
            nodeId: 'node-3', title: 'Route correction', workflowNodeStatus: 'active', executionActivity: 'executing',
            displayState: 'executing', progressBucket: 'executing', reused: false,
            decisionGate: 'required', decision: { status: 'correcting', attempt: 2, maxAttempts: 3 },
          },
          { nodeId: 'node-4', title: 'Parallel execution', workflowNodeStatus: 'active', executionActivity: 'executing', displayState: 'executing', progressBucket: 'executing', reused: false },
          { nodeId: 'node-5', title: 'Feedback join', workflowNodeStatus: 'pending', executionActivity: 'none', displayState: 'blocked', progressBucket: 'blocked', reason: 'waiting_for_inputs', reused: false },
        ],
        edges: [
          { fromNodeId: 'node-1', toNodeId: 'node-5', inputRef: 'reuse_result', contributionState: 'supplied_reused', reused: true },
          { fromNodeId: 'node-2', toNodeId: 'node-5', inputRef: 'live_result', contributionState: 'supplied_live', reused: false },
          { fromNodeId: 'node-3', toNodeId: 'node-5', inputRef: 'pending_three', contributionState: 'pending', reused: false },
          { fromNodeId: 'node-4', toNodeId: 'node-5', inputRef: 'pending_four', contributionState: 'pending', reused: false },
        ],
        gates: [
          { gateId: 'gate-node-1', consumerNodeId: 'node-1', status: 'consumed', satisfied: 1, required: 1, inputs: [{ inputRef: 'entry', producerNodeId: 'engine_start', state: 'supplied_live' }] },
          { gateId: 'gate-node-2', consumerNodeId: 'node-2', status: 'consumed', satisfied: 1, required: 1, inputs: [{ inputRef: 'entry', producerNodeId: 'engine_start', state: 'supplied_live' }] },
          { gateId: 'gate-node-3', consumerNodeId: 'node-3', status: 'consumed', satisfied: 1, required: 1, inputs: [{ inputRef: 'entry', producerNodeId: 'engine_start', state: 'supplied_live' }] },
          { gateId: 'gate-node-4', consumerNodeId: 'node-4', status: 'consumed', satisfied: 1, required: 1, inputs: [{ inputRef: 'entry', producerNodeId: 'engine_start', state: 'supplied_live' }] },
          {
            gateId: 'gate-m024-s05', consumerNodeId: 'node-5', status: 'open', satisfied: 2, required: 4,
            inputs: [
              { inputRef: 'reuse_result', producerNodeId: 'node-1', state: 'supplied_reused' },
              { inputRef: 'live_result', producerNodeId: 'node-2', state: 'supplied_live' },
              { inputRef: 'pending_three', producerNodeId: 'node-3', state: 'pending' },
              { inputRef: 'pending_four', producerNodeId: 'node-4', state: 'pending' },
            ],
          },
        ],
        activeGate: {
          gateId: 'gate-m024-s05', consumerNodeId: 'node-5', status: 'open', satisfied: 2, required: 4,
          inputs: [
            { inputRef: 'reuse_result', producerNodeId: 'node-1', state: 'supplied_reused' },
            { inputRef: 'live_result', producerNodeId: 'node-2', state: 'supplied_live' },
            { inputRef: 'pending_three', producerNodeId: 'node-3', state: 'pending' },
            { inputRef: 'pending_four', producerNodeId: 'node-4', state: 'pending' },
          ],
        },
        progress: {
          total: 5, completed: 2, queued: 0, executing: 2, waiting: 0,
          blocked: 1, notStarted: 0, failed: 0, cancelled: 0, skipped: 0,
          frontierNodeIds: ['node-3', 'node-4', 'node-5'], activeNodeIds: ['node-3', 'node-4'],
        },
        feedbackRounds: [
          { roundId: 'feedback-m024-s05', requesterNodeId: 'node-5', status: 'open', joinMode: 'all', required: 2, responded: 1 },
        ],
        childRuns: [{ runId: 'child-run-m024-s05', status: 'running' }],
        reuse: { nodeCount: 1, edgeCount: 1 },
        diagnostics: [{ code: 'workflow_graph_nodes_truncated' }],
    };
    await postRawHostMessage(page, {
      type: 'workflowGraphResult',
      requestId: request.requestId,
      taskId: request.taskId,
      ok: true,
      graph: graphPayload,
    });

    const modal = page.getByTestId('workflow-graph-modal');
    await expect(modal).toBeVisible();
    // Canvas DAG (not a plain list) — nodes positioned via layout, edges as SVG paths
    const canvas = page.getByTestId('workflow-graph-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas.locator('[data-node-id]')).toHaveCount(5);
    await expect(canvas.locator('[data-edge-from="node-1"][data-edge-to="node-5"][data-input-state="supplied_reused"]')).toHaveCount(1);
    await expect(canvas.locator('[data-edge-from="node-3"][data-edge-to="node-5"][data-input-state="pending"]')).toHaveCount(1);
    await expect(modal).toContainText('1 reused node · 1 reused edge');
    await expect(modal.locator('.workflow-modal__legend-item.is-active')).toHaveCount(2);
    await expect(modal.locator('.workflow-modal__legend-item[data-node-id="node-5"]')).toContainText('Blocked');
    await expect(modal.locator('.workflow-modal__legend-item[data-node-id="node-3"]')).toContainText('Route correction');
    await expect(modal.locator('.workflow-modal__legend-item[data-node-id="node-3"]')).toContainText('Decision required');
    await expect(modal.locator('.workflow-modal__legend-item[data-node-id="node-3"]')).toContainText('Correcting workflow route · attempt 2 of 3');
    await expect(canvas.locator('[data-node-id="node-3"]')).toHaveAttribute('aria-label', /Route correction.*Correcting workflow route.*attempt 2 of 3/);
    await expect(modal.getByTestId('workflow-progress-summary')).toContainText('2 of 5 completed · 2 executing · 1 blocked');
    await expect(modal.getByTestId('workflow-frontier-summary')).toContainText('Frontier: node-3, node-4, node-5');
    await expect(modal.locator('[data-gate-id]')).toHaveCount(5);
    await expect(modal.locator('[data-gate-id="gate-m024-s05"]')).toContainText('node-5');
    await expect(modal.locator('[data-gate-id="gate-m024-s05"]')).toContainText('2 of 4 required inputs supplied');
    await expect(modal.locator('[data-gate-id="gate-m024-s05"] [data-input-ref="pending_three"]')).toContainText('Pending');
    await modal.getByRole('button', { name: 'Reset view' }).click();
    await expect(modal.locator('.workflow-modal__scale')).toHaveText('100%');
    await modal.getByRole('button', { name: 'Zoom in' }).click();
    await expect(modal.locator('.workflow-modal__scale')).toHaveText('115%');
    await postRawHostMessage(page, {
      type: 'workspacePatchBatch',
      revision: 2,
      patches: [{
        type: 'taskUpserted',
        task: task({ id: taskId, goal: 'Run reuse workflow', viewStatus: 'running' }),
      }],
    });
    await expect.poll(async () => (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    ).length).toBe(2);
    const refreshRequest = (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    )[1] as { requestId: string; taskId: string };
    await postRawHostMessage(page, {
      type: 'workflowGraphResult',
      requestId: refreshRequest.requestId,
      taskId: refreshRequest.taskId,
      ok: true,
      graph: {
        ...graphPayload,
        nodes: graphPayload.nodes.map((node) => node.nodeId === 'node-3'
          ? { ...node, executionActivity: 'completed', displayState: 'completed', progressBucket: 'completed', workflowNodeStatus: 'succeeded' }
          : node),
        progress: {
          ...graphPayload.progress,
          completed: 3,
          executing: 1,
          activeNodeIds: ['node-4'],
        },
      },
    });
    await expect(modal.locator('.workflow-modal__scale')).toHaveText('115%');
    await modal.getByRole('button', { name: 'Fit view' }).click();
    await expect(modal.locator('.workflow-modal__scale')).not.toHaveText('100%');
    const wrapBox = await page.getByTestId('workflow-graph-canvas-wrap').boundingBox();
    const canvasBox = await canvas.locator('svg').boundingBox();
    expect(wrapBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(canvasBox!.x).toBeGreaterThanOrEqual(wrapBox!.x - 1);
    expect(canvasBox!.y).toBeGreaterThanOrEqual(wrapBox!.y - 1);
    expect(canvasBox!.x + canvasBox!.width).toBeLessThanOrEqual(wrapBox!.x + wrapBox!.width + 1);
    expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(wrapBox!.y + wrapBox!.height + 1);
    await expect(modal).toContainText('Feedback rounds');
    await expect(modal).toContainText('1 of 2 responses received');
    await expect(modal.locator('[data-child-run-id="child-run-m024-s05"]')).toContainText('Running');
    await expect(modal.getByRole('status')).toContainText('Workflow graph may be incomplete');
    await expect(modal).toContainText('Workflow nodes were truncated');
    await modal.getByRole('button', { name: 'Close workflow graph' }).click();
    await expect(modal).toHaveCount(0);

    await page.getByTestId('view-workflow-graph').click();
    await expect.poll(async () => (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    ).length).toBe(3);
    const reopenedRequest = (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    )[2] as { requestId: string; taskId: string };
    await postRawHostMessage(page, {
      type: 'workflowGraphResult',
      requestId: reopenedRequest.requestId,
      taskId: reopenedRequest.taskId,
      ok: true,
      graph: graphPayload,
    });
    await expect(modal).toBeVisible();
    await expect(modal.locator('.workflow-modal__scale')).not.toHaveText('100%');
    await modal.getByRole('button', { name: 'Close workflow graph' }).click();
    await expect(modal).toHaveCount(0);

    // Status overlay shows per-node detail for the clicked node (lifecycle/runtime/workflow labels)
    await expect(page.getByTestId('node-status-detail')).toHaveCount(0);
    await page.getByRole('button', { name: /Task status:/ }).click();
    const detail = page.getByTestId('node-status-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Run reuse workflow');
    await expect(detail).toContainText('Lifecycle');
    await expect(detail).toContainText('Runtime');
    await expect(page.getByTestId('task-status-overlay')).toBeVisible();
    await expect(page.getByTestId('task-status-overlay').getByText('Mark done')).toBeVisible();
    await expect(page.getByTestId('task-status-overlay').getByText('Mark failed')).toBeVisible();
  });

  test('M024 S05 workflow graph: terminal error stays settled until explicit retry', async ({ page }) => {
    const taskId = 'task-m024-s05-workflow-error';
    await openWebview(page);

    await postSnapshot(page, {
      type: 'snapshot',
      rootTasks: [task({ id: taskId, goal: 'Inspect workflow error', viewStatus: 'running' })],
      focusedTaskId: taskId,
      subtree: [task({ id: taskId, goal: 'Inspect workflow error', viewStatus: 'running' })],
      transcript: [],
      transcriptPage: { hasMoreBefore: false, workspaceRevision: 1 },
      storeRevision: 1,
    });

    await page.getByTestId('view-workflow-graph').click();
    await expect.poll(async () => (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    ).length).toBe(1);

    const firstRequest = (await postedMessages(page)).find(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    ) as { requestId: string; taskId: string };
    await postRawHostMessage(page, {
      type: 'workflowGraphResult',
      requestId: firstRequest.requestId,
      taskId,
      ok: false,
      code: 'notInWorkflow',
    });

    await expect(page.getByTestId('workflow-graph-error')).toContainText(
      'This task is not part of a workflow run.',
    );
    await postRawHostMessage(page, {
      type: 'workspacePatchBatch',
      revision: 2,
      patches: [{
        type: 'taskUpserted',
        task: task({ id: taskId, goal: 'Inspect workflow error', viewStatus: 'running' }),
      }],
    });
    await page.waitForTimeout(400);
    expect((await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    )).toHaveLength(1);

    await page.getByTestId('workflow-graph-retry').click();
    await expect.poll(async () => (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    ).length).toBe(2);
    const requests = (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowGraph',
    ) as Array<{ requestId: string }>;
    expect(requests[1]!.requestId).not.toBe(firstRequest.requestId);
  });

});
test.describe('Workflow catalog surface', () => {
  const workspaceEntry = {
    workflowRef: 'ref-build',
    name: 'Build checks',
    description: 'Run lint and typecheck',
    scope: 'workspace',
    packageKind: 'bundle',
  } as const;
  const globalEntry = {
    workflowRef: 'ref-release',
    name: 'Release notes',
    description: 'Draft release notes',
    scope: 'global',
    packageKind: 'bundle',
  } as const;

  type CatalogRequest = {
    type: 'requestWorkflowCatalog';
    requestId: string;
    reason: string;
  };

  function isCatalogRequest(message: unknown): message is CatalogRequest {
    if (typeof message !== 'object' || message === null) return false;
    if (!('type' in message) || message.type !== 'requestWorkflowCatalog') return false;
    return (
      'requestId' in message &&
      typeof message.requestId === 'string' &&
      'reason' in message &&
      typeof message.reason === 'string'
    );
  }

  async function catalogRequests(page: Page): Promise<CatalogRequest[]> {
    return (await postedMessages(page)).filter(isCatalogRequest);
  }

  async function lastCatalogRequest(page: Page, count: number): Promise<CatalogRequest> {
    await expect.poll(async () => (await catalogRequests(page)).length).toBe(count);
    const requests = await catalogRequests(page);
    return requests.at(-1)!;
  }

  test('opens, reloads, preserves catalog data on failure, retries, and closes', async ({ page }) => {
    await openWebview(page);

    await page.getByTestId('open-workflows').first().click();
    await expect(page.getByTestId('workflow-catalog-loading')).toBeVisible();
    const first = await lastCatalogRequest(page, 1);
    expect(first.reason).toBe('initial');
    expect((await catalogRequests(page))).toHaveLength(1);

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult',
      requestId: first.requestId,
      ok: true,
      catalog: {
        reason: 'initial',
        workflows: [workspaceEntry, globalEntry],
        diagnostics: [{
          file: 'messy',
          code: 'invalid_workflow_file',
          message: 'missing name',
        }],
      },
    });

    const panel = page.getByTestId('workflow-catalog-panel');
    await expect(panel).toHaveAttribute('data-state', 'populated');
    await expect(page.getByTestId('workflow-catalog-row')).toHaveCount(2);
    await expect(page.getByTestId('workflow-catalog-group-workspace')).toContainText('Build checks');
    await expect(page.getByTestId('workflow-catalog-group-workspace')).toContainText('bundle');
    await expect(page.getByTestId('workflow-catalog-group-global')).toContainText('Release notes');
    await expect(page.getByTestId('workflow-catalog-group-global')).toContainText('User');
    await expect(page.getByTestId('workflow-catalog-diagnostics')).toBeVisible();
    await expect(page.getByTestId('workflow-catalog-diagnostic')).toHaveCount(1);
    await expect(page.getByTestId('workflow-catalog-diagnostic')).toContainText('invalid_workflow_file');

    await page.getByTestId('workflow-catalog-reload').click();
    const second = await lastCatalogRequest(page, 2);
    expect(second.reason).toBe('reload');
    await expect(page.getByTestId('workflow-catalog-refreshing')).toBeVisible();
    await expect(page.getByTestId('workflow-catalog-row')).toHaveCount(2);

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult',
      requestId: second.requestId,
      ok: false,
      code: 'unavailable',
    });
    await expect(panel).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId('workflow-catalog-error')).toBeVisible();
    await expect(page.getByTestId('workflow-catalog-row')).toHaveCount(2);
    await expect(page.getByTestId('workflow-catalog-group-workspace')).toContainText('Build checks');
    await expect(page.getByTestId('workflow-catalog-group-global')).toContainText('Release notes');

    await page.getByTestId('workflow-catalog-retry').click();
    const third = await lastCatalogRequest(page, 3);
    expect(third.reason).toBe('reload');
    await expect(page.getByTestId('workflow-catalog-error')).toHaveCount(0);
    await expect(page.getByTestId('workflow-catalog-refreshing')).toBeVisible();
    await expect(page.getByTestId('workflow-catalog-row')).toHaveCount(2);

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult',
      requestId: third.requestId,
      ok: true,
      catalog: {
        reason: 'reload',
        workflows: [workspaceEntry, globalEntry],
        diagnostics: [],
      },
    });
    await expect(panel).toHaveAttribute('data-state', 'populated');
    await expect(page.getByTestId('workflow-catalog-diagnostic')).toHaveCount(0);

    await page.getByTestId('workflow-catalog-reload').click();
    const fourth = await lastCatalogRequest(page, 4);
    expect(fourth.reason).toBe('reload');
    await page.getByTestId('workflow-catalog-close').click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('open-workflows').first()).toBeFocused();

    await page.getByTestId('open-workflows').first().click();
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('workflow-catalog-refreshing')).toBeVisible();
    expect(await catalogRequests(page)).toHaveLength(4);

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult',
      requestId: fourth.requestId,
      ok: true,
      catalog: {
        reason: 'reload',
        workflows: [
          workspaceEntry,
          globalEntry,
          {
            workflowRef: 'ref-deploy',
            name: 'Deploy',
            description: 'Ship the current build',
            scope: 'workspace',
            packageKind: 'bundle',
          },
        ],
        diagnostics: [],
      },
    });
    await expect(page.getByTestId('workflow-catalog-row')).toHaveCount(3);
    const fifth = await lastCatalogRequest(page, 5);
    expect(fifth.reason).toBe('initial');
    await expect(page.getByTestId('workflow-catalog-refreshing')).toBeVisible();
    await postRawHostMessage(page, {
      type: 'workflowCatalogResult',
      requestId: fifth.requestId,
      ok: true,
      catalog: {
        reason: 'initial',
        workflows: [workspaceEntry, globalEntry],
        diagnostics: [],
      },
    });
    await expect(page.getByTestId('workflow-catalog-row')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('open-workflows').first()).toBeFocused();
  });

  test('renders guidance for an empty catalog', async ({ page }) => {
    await openWebview(page);
    await page.getByTestId('open-workflows').first().click();
    const first = await lastCatalogRequest(page, 1);

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult',
      requestId: first.requestId,
      ok: true,
      catalog: {
        reason: 'initial',
        workflows: [],
        diagnostics: [],
      },
    });

    const panel = page.getByTestId('workflow-catalog-panel');
    await expect(panel).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('workflow-catalog-empty')).toContainText('.muster/workflows/');
    await expect(page.getByTestId('workflow-catalog-error')).toHaveCount(0);
  });

  test('renders a diagnostics-only state for an empty catalog with diagnostics', async ({ page }) => {
    await openWebview(page);
    await page.getByTestId('open-workflows').first().click();
    const first = await lastCatalogRequest(page, 1);

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult',
      requestId: first.requestId,
      ok: true,
      catalog: {
        reason: 'initial',
        workflows: [],
        diagnostics: [{
          file: 'broken',
          code: 'invalid_workflow_file',
          message: 'missing name',
        }],
      },
    });

    const panel = page.getByTestId('workflow-catalog-panel');
    await expect(panel).toHaveAttribute('data-state', 'diagnostics-only');
    await expect(page.getByTestId('workflow-catalog-empty')).toContainText('.muster/workflows/');
    await expect(page.getByTestId('workflow-catalog-diagnostics')).toBeVisible();
    await expect(page.getByTestId('workflow-catalog-diagnostic')).toHaveCount(1);
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
