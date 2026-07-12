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
  isExtMessage,
  isProtocolCompatible,
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
