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
  formatLiveInputDeliveredMessage,
  isExtMessage,
  isProtocolCompatible,
  isTaskScopedBannerVisible,
  post,
  type OutMessage,
  type RetentionSettingSnapshot,
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

describe('isExtMessage snapshot version tolerance', () => {
  const baseSnapshot = { type: 'snapshot', rootTasks: [], storeRevision: 0 };

  it('accepts a snapshot stamped with the current protocolVersion', () => {
    expect(isExtMessage({ ...baseSnapshot, protocolVersion: PROTOCOL_VERSION })).toBe(true);
  });

  it('accepts a snapshot without a protocolVersion (backward-tolerant shape)', () => {
    // The compatibility decision lives in isProtocolCompatible; the shape guard
    // itself stays tolerant so an unstamped snapshot is still recognized as one.
    expect(isExtMessage(baseSnapshot)).toBe(true);
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

const settingsSnapshot: RetentionSettingSnapshot = {
  settings: [
    {
      id: 'maxTurnsPerTask',
      label: 'Max turns per task',
      description: 'Maximum persisted turns retained per terminal task.',
      value: 200,
      defaultValue: 200,
      minimum: 1,
    },
    {
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
        result: { ok: true, settingId: 'maxTurnsPerTask', value: 50 },
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
  });

  it('rejects malformed settings update results from the host', () => {
    const malformedMessages = [
      { type: 'settingsUpdateResult', result: { ok: true, settingId: 'unknown', value: 10 } },
      { type: 'settingsUpdateResult', result: { ok: true, settingId: 'maxTurnsPerTask', value: '10' } },
      { type: 'settingsUpdateResult', result: { ok: true, settingId: 'maxTurnsPerTask', value: 1.5 } },
      { type: 'settingsUpdateResult', result: { ok: true, settingId: 'maxStoredOutputChars', value: 1023 } },
      { type: 'settingsUpdateResult', result: { ok: false, settingId: 'maxTurnsPerTask', code: 'raw-stack', message: 'x' } },
      { type: 'settingsUpdateResult', result: { ok: false, settingId: 'maxTurnsPerTask', code: 'invalidType' } },
      { type: 'settingsUpdateResult', result: { ok: false, settingId: 'unknown', code: 'unknownSetting', message: 'x' } },
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
        result: { ok: true, settingId: 'maxTurnsPerTask', value: 50 },
        extra: 'ignored?',
      },
      {
        type: 'settingsUpdateResult',
        result: { ok: false, code: 'unknownSetting', message: 'Unsupported retention setting.' },
        extra: 'ignored?',
      },
      { type: 'settingsUpdated', settingId: 'maxTurnsPerTask', value: 50 },
      { type: 'settingsError', settingId: 'maxTurnsPerTask', message: 'Host rejected update.' },
      { type: 'settingsSnapshot', snapshot: settingsSnapshot, result: { ok: true, settingId: 'maxTurnsPerTask', value: 50 } },
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

describe('live-input protocol', () => {
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

  it('accepts a delivered liveInputResult acknowledgement from the host', () => {
    expect(
      isExtMessage({
        type: 'liveInputResult',
        taskId: 'task-1',
        code: 'delivered',
        sessionId: 'sess-1',
      }),
    ).toBe(true);
  });

  it('rejects malformed liveInputResult shapes', () => {
    const malformed = [
      { type: 'liveInputResult', taskId: 'task-1', code: 'delivered' },
      { type: 'liveInputResult', taskId: 'task-1', code: 'unsupported', sessionId: 's' },
      { type: 'liveInputResult', taskId: 'task-1', code: 'delivered', sessionId: 's', extra: true },
      { type: 'liveInputResult', code: 'delivered', sessionId: 's' },
    ];
    for (const message of malformed) {
      expect(isExtMessage(message), JSON.stringify(message)).toBe(false);
    }
  });

  it('keeps commandError as the visible refusal channel for live-input failures', () => {
    expect(
      isExtMessage({
        type: 'commandError',
        taskId: 'task-1',
        message: 'Live input unsupported: backend kiro does not support live input',
      }),
    ).toBe(true);
  });

  it('formats a delivered live-input acknowledgement that is never empty', () => {
    const message = formatLiveInputDeliveredMessage('sess-1');
    expect(message.length).toBeGreaterThan(0);
    expect(message.toLowerCase()).toContain('live input');
    expect(message.toLowerCase()).toContain('delivered');
  });

  it('rejects blank session ids when formatting delivered acknowledgements', () => {
    expect(() => formatLiveInputDeliveredMessage('')).toThrow(/session/i);
    expect(() => formatLiveInputDeliveredMessage('   ')).toThrow(/session/i);
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
      { type: 'updateSetting', settingId: 'maxTurnsPerTask', value: 25 },
      { type: 'updateSetting', settingId: 'maxStoredOutputChars', value: 4096 },
    ];

    for (const message of messages) {
      post(message);
    }

    expect(vscode.postMessage).toHaveBeenNthCalledWith(1, { type: 'requestSettings' });
    expect(vscode.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'updateSetting',
      settingId: 'maxTurnsPerTask',
      value: 25,
    });
    expect(vscode.postMessage).toHaveBeenNthCalledWith(3, {
      type: 'updateSetting',
      settingId: 'maxStoredOutputChars',
      value: 4096,
    });
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
