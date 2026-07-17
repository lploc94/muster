import { describe, expect, it, vi } from 'vitest';

// protocol.ts transitively imports ./vscode, whose module body calls
// acquireVsCodeApi() (a webview-only global) at import time. Stub the module so
// the pure helpers under test can be imported in the node test environment.
// vi.mock is hoisted above the imports below, so it applies before protocol.ts
// (and thus ./vscode) is evaluated.
vi.mock('./vscode', () => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

import {
  PROTOCOL_VERSION,
  formatExportResultMessage,
  isExtMessage,
  isProtocolCompatible,
  isTaskScopedBannerVisible,
  post,
  type OutMessage,
  type RuntimeStorageSettingsSnapshot,
} from './protocol';
import { vscode } from './vscode';

describe('PROTOCOL_VERSION', () => {
  it('is exported as a finite integer (single source of truth)', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number');
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });
});

describe('isProtocolCompatible', () => {
  it('treats the same version as compatible', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  it('treats a newer peer version as incompatible', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION + 1)).toBe(false);
  });

  it('treats an older peer version as incompatible', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION - 1)).toBe(false);
  });

  it('treats an absent version (old peer predating stamping) as incompatible', () => {
    expect(isProtocolCompatible(undefined)).toBe(false);
    expect(isProtocolCompatible(null)).toBe(false);
  });

  it('treats a non-numeric version as incompatible', () => {
    expect(isProtocolCompatible(String(PROTOCOL_VERSION))).toBe(false);
    expect(isProtocolCompatible({})).toBe(false);
    expect(isProtocolCompatible(NaN)).toBe(false);
  });
});

const baseTaskSummary = {
  id: 'task-1',
  parentId: null,
  goal: 'Goal',
  role: 'worker',
  lifecycle: 'open',
  viewStatus: 'idle',
  currentTurnActivity: null,
  updatedAt: '2026-07-06T00:00:00.000Z',
  backend: 'claude-cli',
  model: 'sonnet',
};

describe('isExtMessage snapshot version tolerance', () => {
  const baseSnapshot = {
    type: 'snapshot', rootTasks: [], storeRevision: 0, protocolVersion: PROTOCOL_VERSION,
  };

  it('accepts a snapshot stamped with the current protocolVersion', () => {
    expect(isExtMessage({ ...baseSnapshot, protocolVersion: PROTOCOL_VERSION })).toBe(true);
  });

  it('rejects a snapshot without a protocolVersion', () => {
    const { protocolVersion: _protocolVersion, ...unstamped } = baseSnapshot;
    expect(isExtMessage(unstamped)).toBe(false);
  });

  it('rejects a snapshot whose protocolVersion is not a number', () => {
    expect(isExtMessage({ ...baseSnapshot, protocolVersion: 'nope' })).toBe(false);
  });

  it('accepts optional queuedTurns FIFO projection entries', () => {
    expect(
      isExtMessage({
        ...baseSnapshot,
        activeTurnId: 'turn-live',
        queuedTurns: [
          {
            turnId: 'turn-q1',
            sequence: 2,
            status: 'queued',
            messageIds: ['msg-b'],
            createdAt: '2026-07-06T00:02:00.000Z',
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects malformed queuedTurns projection entries', () => {
    const malformed = [
      { ...baseSnapshot, queuedTurns: 'not-array' },
      {
        ...baseSnapshot,
        queuedTurns: [
          {
            turnId: 'turn-q1',
            sequence: 2,
            status: 'running',
            messageIds: ['msg-b'],
            createdAt: '2026-07-06T00:02:00.000Z',
          },
        ],
      },
      {
        ...baseSnapshot,
        queuedTurns: [
          {
            turnId: 'turn-q1',
            sequence: '2',
            status: 'queued',
            messageIds: ['msg-b'],
            createdAt: '2026-07-06T00:02:00.000Z',
          },
        ],
      },
      {
        ...baseSnapshot,
        queuedTurns: [
          {
            turnId: 'turn-q1',
            sequence: 2,
            status: 'queued',
            messageIds: [1],
            createdAt: '2026-07-06T00:02:00.000Z',
          },
        ],
      },
    ];
    for (const message of malformed) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});

describe('protocol v7 focused transcriptPage contract', () => {
  const baseSnapshot = {
    type: 'snapshot',
    rootTasks: [baseTaskSummary],
    storeRevision: 1,
    protocolVersion: PROTOCOL_VERSION,
  };
  const validPage = {
    hasMoreBefore: false,
    workspaceRevision: 1,
  };
  const focusedBase = {
    ...baseSnapshot,
    focusedTaskId: 'task-1',
    transcript: [],
    transcriptPage: validPage,
  };

  it('is exactly version 7', () => {
    expect(PROTOCOL_VERSION).toBe(7);
  });

  it('accepts focused snapshot with transcript + transcriptPage', () => {
    expect(isExtMessage(focusedBase)).toBe(true);
  });

  it('rejects focused snapshot missing transcript', () => {
    const { transcript: _t, ...rest } = focusedBase;
    expect(isExtMessage(rest)).toBe(false);
  });

  it('rejects focused snapshot missing transcriptPage', () => {
    const { transcriptPage: _p, ...rest } = focusedBase;
    expect(isExtMessage(rest)).toBe(false);
  });

  it('rejects no-focus snapshot that carries transcript', () => {
    expect(isExtMessage({ ...baseSnapshot, transcript: [] })).toBe(false);
  });

  it('rejects no-focus snapshot that carries transcriptPage', () => {
    expect(isExtMessage({ ...baseSnapshot, transcriptPage: validPage })).toBe(false);
  });

  it('requires beforeCursor when hasMoreBefore is true', () => {
    expect(
      isExtMessage({
        ...focusedBase,
        transcriptPage: { hasMoreBefore: true, workspaceRevision: 1 },
      }),
    ).toBe(false);
    expect(
      isExtMessage({
        ...focusedBase,
        transcriptPage: {
          hasMoreBefore: true,
          beforeCursor: 'v2.abc',
          workspaceRevision: 1,
        },
      }),
    ).toBe(true);
  });

  it('forbids beforeCursor when hasMoreBefore is false', () => {
    expect(
      isExtMessage({
        ...focusedBase,
        transcriptPage: {
          hasMoreBefore: false,
          beforeCursor: 'v2.abc',
          workspaceRevision: 1,
        },
      }),
    ).toBe(false);
  });

  it('rejects non-finite / negative / non-integer workspaceRevision', () => {
    for (const workspaceRevision of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        isExtMessage({
          ...focusedBase,
          transcriptPage: { hasMoreBefore: false, workspaceRevision },
        }),
        String(workspaceRevision),
      ).toBe(false);
    }
  });

  it('rejects malformed page metadata shapes', () => {
    for (const transcriptPage of [
      null,
      'page',
      { hasMoreBefore: 'yes', workspaceRevision: 1 },
      { hasMoreBefore: false },
      { workspaceRevision: 1 },
    ]) {
      expect(isExtMessage({ ...focusedBase, transcriptPage }), JSON.stringify(transcriptPage)).toBe(
        false,
      );
    }
  });
});

const settingsSnapshot: RuntimeStorageSettingsSnapshot = {
  settings: [
    {
      kind: 'enum',
      id: 'runLimit',
      label: 'Maximum uninterrupted agent run',
      description: 'Applies to newly promoted runs.',
      value: '2h',
      defaultValue: '2h',
      options: ['15m', '30m', '1h', '2h', '4h', '8h'],
    },
    {
      kind: 'number',
      id: 'maxRetainedTurnsPerTask',
      label: 'Max turns per task',
      description: 'Maximum persisted turns retained per terminal task.',
      value: 200,
      defaultValue: 200,
      minimum: 1,
    },
    {
      kind: 'number',
      id: 'maxStoredOutputChars',
      label: 'Max stored output characters',
      description: 'Maximum stored assistant output characters per settled turn on open tasks.',
      value: 200000,
      defaultValue: 200000,
      minimum: 1024,
    },
  ],
};

describe('settings protocol guard', () => {
  it('accepts a valid retention settings snapshot from the host', () => {
    expect(isExtMessage({ type: 'settingsSnapshot', snapshot: settingsSnapshot })).toBe(true);
  });

  it('rejects malformed settings snapshots from the host', () => {
    const malformedMessages = [
      { type: 'settingsSnapshot' },
      { type: 'settingsSnapshot', snapshot: { settings: 'not-array' } },
      { type: 'settingsSnapshot', snapshot: { settings: [{ ...settingsSnapshot.settings[0], id: 'unsupported' }] } },
      { type: 'settingsSnapshot', snapshot: { settings: [{ ...settingsSnapshot.settings[0], value: '200' }] } },
      { type: 'settingsSnapshot', snapshot: { settings: [{ ...settingsSnapshot.settings[0], value: Number.NaN }] } },
      { type: 'settingsSnapshot', snapshot: { settings: [{ ...settingsSnapshot.settings[0], value: 1.5 }] } },
      { type: 'settingsSnapshot', snapshot: { settings: [{ ...settingsSnapshot.settings[0], value: 0 }] } },
      {
        type: 'settingsSnapshot',
        snapshot: { settings: [{ ...settingsSnapshot.settings[0], minimum: Number.POSITIVE_INFINITY }] },
      },
      { type: 'settingsSnapshot', snapshot: { settings: [{ ...settingsSnapshot.settings[0], minimum: 0 }] } },
      { type: 'settingsSnapshot', snapshot: { settings: [{ ...settingsSnapshot.settings[0], label: 42 }] } },
      { type: 'settingsSnapshot', snapshot: { settings: [settingsSnapshot.settings[0]] } },
      { type: 'settingsSnapshot', snapshot: { settings: [settingsSnapshot.settings[0], settingsSnapshot.settings[0]] } },
    ];

    for (const message of malformedMessages) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });

  it('accepts sanitized settings update results from the host', () => {
    expect(
      isExtMessage({
        type: 'settingsUpdateResult',
        result: { ok: true, settingId: 'runLimit', value: '4h' },
      }),
    ).toBe(true);
    expect(
      isExtMessage({
        type: 'settingsUpdateResult',
        result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 50 },
      }),
    ).toBe(true);

    expect(
      isExtMessage({
        type: 'settingsUpdateResult',
        result: {
          ok: false,
          settingId: 'maxStoredOutputChars',
          code: 'belowMinimum',
          message: 'Max stored output characters must be at least 1024.',
        },
      }),
    ).toBe(true);

    expect(
      isExtMessage({
        type: 'settingsUpdateResult',
        result: {
          ok: false,
          code: 'unknownSetting',
          message: 'Unsupported retention setting.',
        },
      }),
    ).toBe(true);

    // Host write failures travel as sanitized updateFailed results (no raw stack/path codes).
    expect(
      isExtMessage({
        type: 'settingsUpdateResult',
        result: {
          ok: false,
          settingId: 'maxRetainedTurnsPerTask',
          code: 'updateFailed',
          message: 'Unable to update Max turns per task.',
        },
      }),
    ).toBe(true);
  });

  it('rejects malformed settings update results from the host', () => {
    const malformedMessages = [
      { type: 'settingsUpdateResult', result: { ok: true, settingId: 'unknown', value: 10 } },
      { type: 'settingsUpdateResult', result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: '10' } },
      { type: 'settingsUpdateResult', result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 1.5 } },
      { type: 'settingsUpdateResult', result: { ok: true, settingId: 'maxStoredOutputChars', value: 1023 } },
      { type: 'settingsUpdateResult', result: { ok: false, settingId: 'maxRetainedTurnsPerTask', code: 'raw-stack', message: 'x' } },
      { type: 'settingsUpdateResult', result: { ok: false, settingId: 'maxRetainedTurnsPerTask', code: 'invalidType' } },
      { type: 'settingsUpdateResult', result: { ok: false, settingId: 'unknown', code: 'unknownSetting', message: 'x' } },
      // updateFailed without settingId is not a valid Retention failure shape
      { type: 'settingsUpdateResult', result: { ok: false, code: 'updateFailed', message: 'Unable to update.' } },
    ];

    for (const message of malformedMessages) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });

  it('rejects unsupported settings payload shapes and unrelated message types', () => {
    const unsupportedMessages = [
      { type: 'settingsSnapshot', snapshot: settingsSnapshot, extra: 'ignored?' },
      {
        type: 'settingsUpdateResult',
        result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 50 },
        extra: 'ignored?',
      },
      {
        type: 'settingsUpdateResult',
        result: { ok: false, code: 'unknownSetting', message: 'Unsupported retention setting.' },
        extra: 'ignored?',
      },
      { type: 'settingsUpdated', settingId: 'maxRetainedTurnsPerTask', value: 50 },
      { type: 'settingsError', settingId: 'maxRetainedTurnsPerTask', message: 'Host rejected update.' },
      { type: 'settingsSnapshot', snapshot: settingsSnapshot, result: { ok: true, settingId: 'maxRetainedTurnsPerTask', value: 50 } },
      { type: 'unrelatedSettingsMessage', snapshot: settingsSnapshot },
    ];

    for (const message of unsupportedMessages) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});

describe('file drop outbound protocol', () => {
  it('posts the bounded candidate payload without file contents or metadata', () => {
    const message: OutMessage = {
      type: 'resolveFileDrop',
      candidates: ['file:///workspace/a%20b.ts'],
    };

    post(message);

    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: 'resolveFileDrop',
      candidates: ['file:///workspace/a%20b.ts'],
    });
  });
});

describe('interrupt-and-send protocol', () => {
  it('posts sendLiveInput as a distinct OutMessage from continueTask', () => {
    vi.mocked(vscode.postMessage).mockClear();

    const live: OutMessage = {
      type: 'sendLiveInput',
      taskId: 'task-1',
      instruction: 'nudge the active turn',
    };
    const queued: OutMessage = {
      type: 'continueTask',
      taskId: 'task-1',
      instruction: 'queue a follow-up turn',
    };

    post(live);
    post(queued);

    expect(vscode.postMessage).toHaveBeenNthCalledWith(1, live);
    expect(vscode.postMessage).toHaveBeenNthCalledWith(2, queued);
    expect(live.type).not.toBe(queued.type);
  });






  it('scopes inject feedback banners to the focused task (or global when taskId is absent)', () => {
    expect(isTaskScopedBannerVisible(null, 'task-1')).toBe(true);
    expect(isTaskScopedBannerVisible(undefined, 'task-1')).toBe(true);
    expect(isTaskScopedBannerVisible('task-1', 'task-1')).toBe(true);
    expect(isTaskScopedBannerVisible('task-1', 'task-other')).toBe(false);
    expect(isTaskScopedBannerVisible('task-1', null)).toBe(false);
  });
});

describe('queued turn mutation protocol', () => {
  it('posts editQueuedTurn and deleteQueuedTurn as distinct OutMessages', () => {
    vi.mocked(vscode.postMessage).mockClear();

    const edit: OutMessage = {
      type: 'editQueuedTurn',
      taskId: 'task-1',
      turnId: 'turn-q',
      content: 'revised follow-up',
    };
    const del: OutMessage = {
      type: 'deleteQueuedTurn',
      taskId: 'task-1',
      turnId: 'turn-q',
    };
    const continueMsg: OutMessage = {
      type: 'continueTask',
      taskId: 'task-1',
      instruction: 'queue a follow-up turn',
    };

    post(edit);
    post(del);
    post(continueMsg);

    expect(vscode.postMessage).toHaveBeenNthCalledWith(1, edit);
    expect(vscode.postMessage).toHaveBeenNthCalledWith(2, del);
    expect(vscode.postMessage).toHaveBeenNthCalledWith(3, continueMsg);
    expect(edit.type).not.toBe(continueMsg.type);
    expect(del.type).not.toBe(continueMsg.type);
    expect(edit.type).not.toBe(del.type);
  });

  it('keeps commandError as the visible refusal channel for stale queued mutations', () => {
    expect(
      isExtMessage({
        type: 'commandError',
        taskId: 'task-1',
        message: 'Queued turn mutation refused: turn is not queued',
      }),
    ).toBe(true);
  });

  it('accepts prompt submission acknowledgements and rejects malformed ones', () => {
    expect(isExtMessage({
      type: 'askSubmissionResult',
      taskId: 'task-1',
      turnId: 'turn-1',
      askId: 'ask-1',
      ok: false,
      message: 'retry',
    })).toBe(true);
    expect(isExtMessage({
      type: 'elicitationSubmissionResult',
      promptId: 'prompt-1',
      ok: true,
    })).toBe(true);
    expect(isExtMessage({
      type: 'elicitationSubmissionResult',
      promptId: 'prompt-1',
      ok: 'yes',
    })).toBe(false);
  });
});

describe('settings outbound protocol', () => {
  it('posts explicit request and update messages to the extension host', () => {
    vi.mocked(vscode.postMessage).mockClear();
    const messages: OutMessage[] = [
      { type: 'requestSettings' },
      { type: 'updateSetting', settingId: 'maxRetainedTurnsPerTask', value: 25 },
      { type: 'updateSetting', settingId: 'maxStoredOutputChars', value: 4096 },
    ];

    for (const message of messages) {
      post(message);
    }

    expect(vscode.postMessage).toHaveBeenNthCalledWith(1, { type: 'requestSettings' });
    expect(vscode.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'updateSetting',
      settingId: 'maxRetainedTurnsPerTask',
      value: 25,
    });
    expect(vscode.postMessage).toHaveBeenNthCalledWith(3, {
      type: 'updateSetting',
      settingId: 'maxStoredOutputChars',
      value: 4096,
    });
  });
});


describe('permission settings protocol', () => {
  const permissionSnapshot = {
    mode: 'ask' as const,
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

  it('accepts a valid permission settings snapshot from the host', () => {
    expect(
      isExtMessage({ type: 'permissionSettingsSnapshot', snapshot: permissionSnapshot }),
    ).toBe(true);
  });

  it('rejects unknown modes, missing fields, extra keys, malformed options, and oversized copy', () => {
    const oversizedDescription = 'x'.repeat(513);
    const oversizedOptionDescription = 'y'.repeat(257);
    const oversizedLabel = 'z'.repeat(65);
    const malformed = [
      { type: 'permissionSettingsSnapshot' },
      { type: 'permissionSettingsSnapshot', snapshot: { ...permissionSnapshot, mode: 'prompt' } },
      { type: 'permissionSettingsSnapshot', snapshot: { ...permissionSnapshot, defaultMode: 'prompt' } },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: { ...permissionSnapshot, description: oversizedDescription },
      },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: {
          ...permissionSnapshot,
          options: [
            { ...permissionSnapshot.options[0], label: oversizedLabel },
            permissionSnapshot.options[1],
            permissionSnapshot.options[2],
          ],
        },
      },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: {
          ...permissionSnapshot,
          options: [
            { ...permissionSnapshot.options[0], description: oversizedOptionDescription },
            permissionSnapshot.options[1],
            permissionSnapshot.options[2],
          ],
        },
      },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: {
          ...permissionSnapshot,
          options: [
            { ...permissionSnapshot.options[0], risk: 'unsafe' },
            permissionSnapshot.options[1],
            permissionSnapshot.options[2],
          ],
        },
      },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: {
          ...permissionSnapshot,
          options: [permissionSnapshot.options[0], permissionSnapshot.options[1]],
        },
      },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: {
          ...permissionSnapshot,
          options: [
            permissionSnapshot.options[0],
            permissionSnapshot.options[0],
            permissionSnapshot.options[2],
          ],
        },
      },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: permissionSnapshot,
        extra: true,
      },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: { ...permissionSnapshot, secret: 'token=abc' },
      },
    ];

    for (const message of malformed) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });

  it('accepts sanitized permission settings update results and rejects raw failure shapes', () => {
    expect(
      isExtMessage({
        type: 'permissionSettingsUpdateResult',
        result: { ok: true, mode: 'readonly' },
      }),
    ).toBe(true);

    expect(
      isExtMessage({
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'invalidPayload',
          message: 'Unsupported permission mode update.',
        },
      }),
    ).toBe(true);

    expect(
      isExtMessage({
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'unknownMode',
          message: 'Unsupported permission mode.',
        },
      }),
    ).toBe(true);

    expect(
      isExtMessage({
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to update permission mode.',
        },
      }),
    ).toBe(true);

    const malformed = [
      {
        type: 'permissionSettingsUpdateResult',
        result: { ok: true, mode: 'prompt' },
      },
      {
        type: 'permissionSettingsUpdateResult',
        result: { ok: true },
      },
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'ENOENT',
          message: 'ENOENT /secret/path token=abc123',
        },
      },
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to update permission mode.',
          stack: 'Error: boom',
        },
      },
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'x'.repeat(257),
        },
      },
      {
        type: 'permissionSettingsUpdateResult',
        result: { ok: false, code: 'updateFailed' },
      },
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to update permission mode.',
        },
        extra: true,
      },
    ];

    for (const message of malformed) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });

  it('posts requestPermissionSettings and updatePermissionSettings as distinct OutMessages', () => {
    vi.mocked(vscode.postMessage).mockClear();

    const request: OutMessage = { type: 'requestPermissionSettings' };
    const update: OutMessage = { type: 'updatePermissionSettings', mode: 'allow' };
    const runtimeSubmit: OutMessage = {
      type: 'submitPermission',
      permissionId: 'perm-1',
      optionId: 'allow_once',
      remember: false,
    };

    post(request);
    post(update);
    post(runtimeSubmit);

    expect(vscode.postMessage).toHaveBeenNthCalledWith(1, { type: 'requestPermissionSettings' });
    expect(vscode.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'updatePermissionSettings',
      mode: 'allow',
    });
    expect(vscode.postMessage).toHaveBeenNthCalledWith(3, runtimeSubmit);
    expect(request.type).not.toBe(runtimeSubmit.type);
    expect(update.type).not.toBe('submitPermission');
    expect(update.type).not.toBe('permissionPending');
  });

  it('keeps runtime permissionPending messages distinct from configuration snapshots', () => {
    expect(
      isExtMessage({
        type: 'permissionPending',
        sessionId: 'sess-1',
        permissionId: 'perm-1',
        title: 'Write file',
        kind: 'edit',
        classification: 'write',
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      }),
    ).toBe(true);

    expect(
      isExtMessage({
        type: 'permissionSettingsSnapshot',
        snapshot: permissionSnapshot,
        permissionId: 'perm-1',
      }),
    ).toBe(false);
  });
});

describe('composer selection protocol', () => {
  it('accepts host composerSelection messages', () => {
    expect(
      isExtMessage({ type: 'composerSelection', backend: 'grok', model: 'grok-4' }),
    ).toBe(true);
    expect(isExtMessage({ type: 'composerSelection', backend: 'claude', model: null })).toBe(true);
  });

  it('rejects malformed composerSelection messages', () => {
    expect(isExtMessage({ type: 'composerSelection', backend: 'grok' })).toBe(false);
    expect(isExtMessage({ type: 'composerSelection', backend: 1, model: null })).toBe(false);
    expect(
      isExtMessage({ type: 'composerSelection', backend: 'grok', model: null, extra: true }),
    ).toBe(false);
  });

  it('posts setComposerSelection to the host', () => {
    vi.mocked(vscode.postMessage).mockClear();
    const message: OutMessage = { type: 'setComposerSelection', backend: 'grok', model: 'm1' };
    post(message);
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: 'setComposerSelection',
      backend: 'grok',
      model: 'm1',
    });
  });
});

describe('skills protocol', () => {
  it('accepts host skillsAvailable messages (incl. empty cold-cache set)', () => {
    expect(
      // Host now sends the uniform `/` trigger prefix for every backend (Codex
      // included); the `$` injection prefix is applied host-side and is never sent
      // in the skillsAvailable webview message.
      isExtMessage({ type: 'skillsAvailable', backend: 'codex', prefix: '/', skills: ['plan'] }),
    ).toBe(true);
    expect(
      isExtMessage({ type: 'skillsAvailable', backend: 'claude', prefix: '/', skills: [] }),
    ).toBe(true);
  });

  it('rejects malformed skillsAvailable messages', () => {
    expect(isExtMessage({ type: 'skillsAvailable', backend: 'codex', prefix: '$' })).toBe(false);
    expect(
      isExtMessage({ type: 'skillsAvailable', backend: 'codex', prefix: 1, skills: [] }),
    ).toBe(false);
    expect(
      isExtMessage({ type: 'skillsAvailable', backend: 'codex', prefix: '$', skills: [1] }),
    ).toBe(false);
  });

  it('posts listSkills to the host', () => {
    vi.mocked(vscode.postMessage).mockClear();
    const message: OutMessage = { type: 'listSkills', backend: 'codex' };
    post(message);
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'listSkills', backend: 'codex' });
  });

  it('send OutMessage carries structured skills', () => {
    vi.mocked(vscode.postMessage).mockClear();
    const message: OutMessage = { type: 'send', text: 'hi', skills: ['plan', 'review'] };
    post(message);
    expect(vscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send', text: 'hi', skills: ['plan', 'review'] }),
    );
  });
});

describe('task export protocol', () => {
  it('posts exportTask as a distinct OutMessage with taskId only', () => {
    vi.mocked(vscode.postMessage).mockClear();

    const message: OutMessage = { type: 'exportTask', taskId: 'task-a' };
    post(message);

    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'exportTask', taskId: 'task-a' });
    expect(message.type).not.toBe('deleteTask');
    expect(message.type).not.toBe('clearHistory');
  });

  it('accepts a well-formed exportResult from the host (basename only)', () => {
    expect(
      isExtMessage({
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'ship-readable-export.md',
        sourceRevision: 11,
        exportedAt: '2026-07-14T12:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rejects malformed exportResult payloads', () => {
    const malformed = [
      { type: 'exportResult' },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'ship-readable-export.md',
        sourceRevision: 11,
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'ship-readable-export.md',
        sourceRevision: '11',
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 42,
        sourceRevision: 11,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'ship-readable-export.md',
        sourceRevision: 11,
        exportedAt: '2026-07-14T12:00:00.000Z',
        extra: true,
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        // Absolute path must not be accepted as a distinct path field.
        path: 'C:\\Users\\secret\\exports\\ship-readable-export.md',
        fileName: 'ship-readable-export.md',
        sourceRevision: 11,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      // Path-like / blank basenames — drop before formatExportResultMessage.
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'C:\\Users\\secret\\export.md',
        sourceRevision: 11,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: '/tmp/export.md',
        sourceRevision: 11,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'nested/export.md',
        sourceRevision: 11,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: '   ',
        sourceRevision: 11,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      // Non-integer / non-finite revisions.
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'export.md',
        sourceRevision: 11.5,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'export.md',
        sourceRevision: Number.NaN,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'export.md',
        sourceRevision: Number.POSITIVE_INFINITY,
        exportedAt: '2026-07-14T12:00:00.000Z',
      },
      // Malformed timestamps.
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'export.md',
        sourceRevision: 11,
        exportedAt: '',
      },
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'export.md',
        sourceRevision: 11,
        exportedAt: 'not-an-iso-timestamp',
      },
    ];
    for (const message of malformed) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });

  it('keeps commandError as the visible refusal channel for export failures', () => {
    expect(
      isExtMessage({
        type: 'commandError',
        taskId: 'task-a',
        message: 'Unable to write the exported Markdown file.',
      }),
    ).toBe(true);
  });

  it('formats a task-scoped export success notice with basename and source revision', () => {
    const message = formatExportResultMessage('ship-readable-export.md', 11);
    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain('ship-readable-export.md');
    expect(message).toContain('11');
    expect(message.toLowerCase()).toMatch(/export|saved/);
    // Never surface path separators or absolute destinations in the notice.
    expect(message).not.toMatch(/[\\/]/);
    expect(message).not.toMatch(/[A-Za-z]:/);
  });

  it('rejects blank file names and absolute-path-like values when formatting export notices', () => {
    expect(() => formatExportResultMessage('', 1)).toThrow(/fileName/i);
    expect(() => formatExportResultMessage('   ', 1)).toThrow(/fileName/i);
    expect(() => formatExportResultMessage('C:\\Users\\secret\\export.md', 1)).toThrow(/fileName/i);
    expect(() => formatExportResultMessage('/tmp/export.md', 1)).toThrow(/fileName/i);
    expect(() => formatExportResultMessage('nested/export.md', 1)).toThrow(/fileName/i);
  });

  it('rejects non-finite source revisions when formatting export notices', () => {
    expect(() => formatExportResultMessage('export.md', Number.NaN)).toThrow(/sourceRevision/i);
    expect(() => formatExportResultMessage('export.md', Number.POSITIVE_INFINITY)).toThrow(
      /sourceRevision/i,
    );
  });
});

describe('runtime handoff protocol', () => {
  it('posts requestRuntimeHandoff as a distinct OutMessage with target labels only', () => {
    vi.mocked(vscode.postMessage).mockClear();

    const message: OutMessage = {
      type: 'requestRuntimeHandoff',
      taskId: 'task-1',
      targetBackend: 'codex',
      targetModel: 'gpt-5',
    };
    post(message);

    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: 'requestRuntimeHandoff',
      taskId: 'task-1',
      targetBackend: 'codex',
      targetModel: 'gpt-5',
    });
    expect(message.type).not.toBe('exportTask');
    expect(message.type).not.toBe('setComposerSelection');
    expect(message.type).not.toBe('continueTask');
    // Labels only — never session ids on the outbound switch request.
    expect(JSON.stringify(message)).not.toContain('sessionId');
  });

  it('keeps commandError as the visible refusal channel for handoff failures', () => {
    expect(
      isExtMessage({
        type: 'commandError',
        taskId: 'task-1',
        message: 'Target backend/model is already bound; switch is unchanged.',
      }),
    ).toBe(true);
  });
});

describe('file mention suggestion protocol', () => {
  it('posts a bounded requestFileMentionSuggestions OutMessage', () => {
    vi.mocked(vscode.postMessage).mockClear();

    const message: OutMessage = {
      type: 'requestFileMentionSuggestions',
      requestId: 'req-1',
      taskId: 'task-1',
      parentDepth: 0,
      relativeQuery: 'src',
    };
    post(message);

    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: 'requestFileMentionSuggestions',
      requestId: 'req-1',
      taskId: 'task-1',
      parentDepth: 0,
      relativeQuery: 'src',
    });
    // Webview must never send a cwd or absolute path for listing.
    expect(JSON.stringify(message)).not.toContain('cwd');
    expect(JSON.stringify(message)).not.toContain('/workspace');
  });

  it('allows parentDepth 1 and 2 on request and success responses', () => {
    for (const parentDepth of [1, 2] as const) {
      const request: OutMessage = {
        type: 'requestFileMentionSuggestions',
        requestId: `req-depth-${parentDepth}`,
        parentDepth,
        relativeQuery: parentDepth === 1 ? '' : 'lib/',
      };
      expect(JSON.stringify(request)).not.toContain('cwd');

      expect(
        isExtMessage({
          type: 'fileMentionSuggestions',
          requestId: `req-depth-${parentDepth}`,
          parentDepth,
          relativeQuery: parentDepth === 1 ? '' : 'lib/',
          items: [
            {
              id: parentDepth === 1 ? 'dir:../sibling' : 'file:../../lib/util.ts',
              kind: parentDepth === 1 ? 'directory' : 'file',
              label: parentDepth === 1 ? 'sibling' : 'util.ts',
              insertionPath: parentDepth === 1 ? '../sibling' : '../../lib/util.ts',
            },
          ],
        }),
      ).toBe(true);
    }
  });

  it('allows optional taskId omission for draft composer scope', () => {
    vi.mocked(vscode.postMessage).mockClear();

    const message: OutMessage = {
      type: 'requestFileMentionSuggestions',
      requestId: 'req-draft',
      parentDepth: 0,
      relativeQuery: '',
    };
    post(message);

    expect(vscode.postMessage).toHaveBeenCalledWith(message);
  });

  it('accepts a successful fileMentionSuggestions response with relative items only', () => {
    expect(
      isExtMessage({
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: '',
        items: [
          {
            id: 'dir:src',
            kind: 'directory',
            label: 'src',
            insertionPath: 'src',
          },
          {
            id: 'file:README.md',
            kind: 'file',
            label: 'README.md',
            insertionPath: 'README.md',
          },
        ],
      }),
    ).toBe(true);
  });

  it('accepts a failed fileMentionSuggestions response with bounded error codes', () => {
    for (const code of ['invalidRequest', 'unavailable', 'listingFailed'] as const) {
      expect(
        isExtMessage({
          type: 'fileMentionSuggestions',
          requestId: 'req-1',
          ok: false,
          code,
        }),
      ).toBe(true);
    }
  });

  it('accepts the explicit success envelope with ok: true', () => {
    expect(
      isExtMessage({
        type: 'fileMentionSuggestions',
        ok: true,
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: 're',
        items: [
          {
            id: 'file:README.md',
            kind: 'file',
            label: 'README.md',
            insertionPath: 'README.md',
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects malformed fileMentionSuggestions payloads', () => {
    const bad = [
      { type: 'fileMentionSuggestions' },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: '',
        // missing items
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 3, // depth > 2 rejected at the wire guard
        relativeQuery: '',
        items: [],
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: -1,
        relativeQuery: '',
        items: [],
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: '',
        items: [
          {
            id: 'file:a',
            kind: 'file',
            label: 'a',
            insertionPath: '/etc/passwd', // absolute rejected
          },
        ],
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: '',
        items: [
          {
            id: 'file:a',
            kind: 'file',
            label: 'a',
            insertionPath: 'C:\\Windows\\a', // drive path rejected
          },
        ],
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: '',
        items: [
          {
            id: 'file:a',
            kind: 'file',
            label: 'a',
            insertionPath: '../../../secret', // depth > 2 rejected
          },
        ],
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: '',
        items: [
          {
            id: 'file:a',
            kind: 'symlink',
            label: 'a',
            insertionPath: 'a',
          },
        ],
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        ok: false,
        code: 'ENOENT', // raw fs codes rejected
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        ok: false,
        code: 'invalidRequest',
        message: 'boom', // no free-form message channel
      },
      {
        type: 'fileMentionSuggestions',
        requestId: 'req-1',
        parentDepth: 0,
        relativeQuery: '',
        items: [],
        cwd: '/workspace', // host must never echo cwd
      },
    ];

    for (const message of bad) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});

describe('protocol v7 loadTranscriptPage / transcriptPageResult', () => {
  const validSuccess = {
    type: 'transcriptPageResult',
    requestId: 'req-1',
    taskId: 'task-1',
    ok: true as const,
    items: [{ id: 'u1', kind: 'user' as const, content: 'older' }],
    transcriptPage: {
      hasMoreBefore: true,
      beforeCursor: 'v2.next',
      workspaceRevision: 3,
    },
  };

  it('accepts valid success with <=100 items and page metadata', () => {
    expect(isExtMessage(validSuccess)).toBe(true);
    expect(
      isExtMessage({
        ...validSuccess,
        items: Array.from({ length: 100 }, (_, i) => ({
          id: `u${i}`,
          kind: 'user',
          content: `m${i}`,
        })),
      }),
    ).toBe(true);
  });

  it('accepts each fixed failure code', () => {
    for (const code of [
      'invalidRequest',
      'staleFocus',
      'taskNotFound',
      'invalidCursor',
      'unavailable',
    ] as const) {
      expect(
        isExtMessage({
          type: 'transcriptPageResult',
          requestId: 'req-1',
          taskId: 'task-1',
          ok: false,
          code,
        }),
        code,
      ).toBe(true);
    }
  });

  it('rejects oversized/missing requestId and malformed taskId', () => {
    expect(isExtMessage({ ...validSuccess, requestId: '' })).toBe(false);
    expect(isExtMessage({ ...validSuccess, requestId: 'x'.repeat(129) })).toBe(false);
    expect(isExtMessage({ ...validSuccess, taskId: '' })).toBe(false);
    expect(isExtMessage({ ...validSuccess, taskId: 't'.repeat(513) })).toBe(false);
  });

  it('rejects more than 100 items and malformed page metadata', () => {
    expect(
      isExtMessage({
        ...validSuccess,
        items: Array.from({ length: 101 }, (_, i) => ({
          id: `u${i}`,
          kind: 'user',
          content: `m${i}`,
        })),
      }),
    ).toBe(false);
    expect(
      isExtMessage({
        ...validSuccess,
        transcriptPage: { hasMoreBefore: true, workspaceRevision: 1 },
      }),
    ).toBe(false);
  });

  it('rejects success missing items/page and error with free-form message/unknown code', () => {
    const { items: _i, ...noItems } = validSuccess;
    expect(isExtMessage(noItems)).toBe(false);
    const { transcriptPage: _p, ...noPage } = validSuccess;
    expect(isExtMessage(noPage)).toBe(false);
    expect(
      isExtMessage({
        type: 'transcriptPageResult',
        requestId: 'req-1',
        taskId: 'task-1',
        ok: false,
        code: 'unavailable',
        message: 'boom',
      }),
    ).toBe(false);
    expect(
      isExtMessage({
        type: 'transcriptPageResult',
        requestId: 'req-1',
        taskId: 'task-1',
        ok: false,
        code: 'ENOENT',
      }),
    ).toBe(false);
  });

  it('posts loadTranscriptPage outbound shape without history aliases', () => {
    vi.mocked(vscode.postMessage).mockClear();
    const message: OutMessage = {
      type: 'loadTranscriptPage',
      requestId: 'req-1',
      taskId: 'task-1',
      beforeCursor: 'v2.cursor',
    };
    post(message);
    expect(vscode.postMessage).toHaveBeenCalledWith(message);
    expect(message).not.toHaveProperty('type', 'loadHistory');
    expect(JSON.stringify(message)).not.toContain('historyChunk');
  });

  it('rejects user items with wrong optional types or extra fields', () => {
    expect(
      isExtMessage({
        ...validSuccess,
        items: [{ id: 'u1', kind: 'user', content: 'ok', turnId: 123 }],
      }),
    ).toBe(false);
    expect(
      isExtMessage({
        ...validSuccess,
        items: [{ id: 'u1', kind: 'user', content: 'ok', order: 'bad' }],
      }),
    ).toBe(false);
    expect(
      isExtMessage({
        ...validSuccess,
        items: [{ id: 'u1', kind: 'user', content: 'ok', extra: true }],
      }),
    ).toBe(false);
  });

  it('rejects host error transcript items and transcriptPage extra fields', () => {
    expect(
      isExtMessage({
        ...validSuccess,
        items: [{ id: 'e1', kind: 'error', content: { message: 'x' } }],
      }),
    ).toBe(false);
    expect(
      isExtMessage({
        ...validSuccess,
        transcriptPage: {
          hasMoreBefore: false,
          workspaceRevision: 1,
          leaked: true,
        },
      }),
    ).toBe(false);
  });

  it('rejects invalid tool status/toolKind and nested extra fields', () => {
    const baseTool = {
      id: 'tool-1',
      kind: 'tool' as const,
      turnId: 't1',
      order: 1,
      content: {
        toolCallId: 'c1',
        name: 'bash',
        status: 'success' as const,
      },
    };
    expect(isExtMessage({ ...validSuccess, items: [baseTool] })).toBe(true);
    expect(
      isExtMessage({
        ...validSuccess,
        items: [{ ...baseTool, content: { ...baseTool.content, status: 'pending' } }],
      }),
    ).toBe(false);
    expect(
      isExtMessage({
        ...validSuccess,
        items: [{ ...baseTool, content: { ...baseTool.content, toolKind: 'shell' } }],
      }),
    ).toBe(false);
    expect(
      isExtMessage({
        ...validSuccess,
        items: [{ ...baseTool, content: { ...baseTool.content, nestedExtra: 1 } }],
      }),
    ).toBe(false);
  });
});
