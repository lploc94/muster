import { describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_STORAGE_SETTING_DEFINITIONS,
  buildRetentionSettingsSnapshot,
  handleRetentionSettingUpdateAction,
  persistRetentionSettingUpdate,
  validateRetentionSettingUpdate,
} from './retention-settings';

describe('runtime & storage settings helper', () => {
  it('exposes one runtime enum and two advanced storage numbers', () => {
    expect(RUNTIME_STORAGE_SETTING_DEFINITIONS.map((entry) => [entry.id, entry.kind])).toEqual([
      ['runLimit', 'enum'],
      ['maxRetainedTurnsPerTask', 'number'],
      ['maxStoredOutputChars', 'number'],
    ]);
    expect(RUNTIME_STORAGE_SETTING_DEFINITIONS[0]).toMatchObject({
      label: 'Maximum uninterrupted agent run',
      defaultValue: '2h',
      options: ['15m', '30m', '1h', '2h', '4h', '8h'],
    });
  });

  it('hydrates valid configured values', () => {
    const snapshot = buildRetentionSettingsSnapshot((key) => ({
      runLimit: '4h',
      maxRetainedTurnsPerTask: 75,
      maxStoredOutputChars: 50_000,
    })[key]);
    expect(snapshot.settings.map(({ id, value }) => [id, value])).toEqual([
      ['runLimit', '4h'],
      ['maxRetainedTurnsPerTask', 75],
      ['maxStoredOutputChars', 50_000],
    ]);
  });

  it('falls back to manifest defaults for invalid reads', () => {
    const snapshot = buildRetentionSettingsSnapshot(() => null);
    expect(snapshot.settings.map(({ id, value }) => [id, value])).toEqual([
      ['runLimit', '2h'],
      ['maxRetainedTurnsPerTask', 200],
      ['maxStoredOutputChars', 200_000],
    ]);
  });

  it('validates runtime enum and numeric storage values', () => {
    expect(validateRetentionSettingUpdate({ settingId: 'runLimit', value: '8h' })).toEqual({
      ok: true,
      settingId: 'runLimit',
      value: '8h',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'runLimit', value: 'none' })).toMatchObject({
      ok: false,
      settingId: 'runLimit',
      code: 'invalidEnum',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxRetainedTurnsPerTask', value: 25 })).toEqual({
      ok: true,
      settingId: 'maxRetainedTurnsPerTask',
      value: 25,
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxStoredOutputChars', value: 1 })).toMatchObject({
      ok: false,
      code: 'belowMinimum',
    });
  });

  it('returns sanitized type/finite/integer validation errors', () => {
    expect(validateRetentionSettingUpdate(undefined)).toMatchObject({
      ok: false,
      code: 'unknownSetting',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'runLimit', value: 2 })).toMatchObject({
      ok: false,
      settingId: 'runLimit',
      code: 'invalidType',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxRetainedTurnsPerTask', value: '10' })).toMatchObject({
      ok: false,
      code: 'invalidType',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxRetainedTurnsPerTask', value: Number.NaN })).toMatchObject({
      ok: false,
      code: 'nonFinite',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxRetainedTurnsPerTask', value: 1.5 })).toMatchObject({
      ok: false,
      code: 'nonInteger',
    });
  });

  it('fails closed for inherited/unknown payload fields', async () => {
    const update = vi.fn();
    const inherited = Object.create({ settingId: 'runLimit', value: '2h' });
    await expect(persistRetentionSettingUpdate({ update }, inherited, 'workspace')).resolves.toMatchObject({
      ok: false,
      code: 'unknownSetting',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('sanitizes write errors', async () => {
    const update = vi.fn(async () => { throw new Error('secret stack'); });
    await expect(
      persistRetentionSettingUpdate(
        { update },
        { settingId: 'runLimit', value: '2h' },
        'workspace',
      ),
    ).resolves.toEqual({
      ok: false,
      settingId: 'runLimit',
      code: 'updateFailed',
      message: 'Unable to update Maximum uninterrupted agent run.',
    });
  });

  it('does not persist invalid values', async () => {
    const update = vi.fn();
    await expect(
      persistRetentionSettingUpdate(
        { update },
        { settingId: 'maxStoredOutputChars', value: 100 },
        'workspace',
      ),
    ).resolves.toMatchObject({ ok: false, code: 'belowMinimum' });
    expect(update).not.toHaveBeenCalled();
  });

  it('passes the validated id/value and target to configuration.update', async () => {
    const update = vi.fn(async () => undefined);
    const target = Symbol('workspace');
    await expect(
      persistRetentionSettingUpdate(
        { update },
        { settingId: 'maxRetainedTurnsPerTask', value: 50 },
        target,
      ),
    ).resolves.toEqual({
      ok: true,
      settingId: 'maxRetainedTurnsPerTask',
      value: 50,
    });
    expect(update).toHaveBeenCalledWith('maxRetainedTurnsPerTask', 50, target);
  });

  it('returns authoritative refreshed snapshot after a successful save', async () => {
    const values = new Map<string, unknown>([
      ['runLimit', '2h'],
      ['maxRetainedTurnsPerTask', 200],
      ['maxStoredOutputChars', 200_000],
    ]);
    const configuration = {
      get: (key: 'runLimit' | 'maxRetainedTurnsPerTask' | 'maxStoredOutputChars') => values.get(key),
      update: async (key: string, value: unknown) => { values.set(key, value); },
    };
    const messages = await handleRetentionSettingUpdateAction(
      configuration,
      { settingId: 'runLimit', value: '4h' },
      'workspace',
    );
    expect(messages[0]).toEqual({
      type: 'settingsUpdateResult',
      result: { ok: true, settingId: 'runLimit', value: '4h' },
    });
    expect(messages[1]?.type).toBe('settingsSnapshot');
    if (messages[1]?.type === 'settingsSnapshot') {
      expect(messages[1].snapshot.settings).toContainEqual(
        expect.objectContaining({ id: 'runLimit', value: '4h' }),
      );
    }
  });

  it('does not refresh after update failure', async () => {
    const get = vi.fn(() => '2h');
    const messages = await handleRetentionSettingUpdateAction(
      { get, update: async () => { throw new Error('/secret/path'); } },
      { settingId: 'runLimit', value: '4h' },
      'workspace',
    );
    expect(messages).toEqual([
      {
        type: 'settingsUpdateResult',
        result: {
          ok: false,
          settingId: 'runLimit',
          code: 'updateFailed',
          message: 'Unable to update Maximum uninterrupted agent run.',
        },
      },
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  it('preserves successful update result if authoritative refresh throws', async () => {
    const messages = await handleRetentionSettingUpdateAction(
      { get: () => { throw new Error('read failed'); }, update: async () => undefined },
      { settingId: 'runLimit', value: '1h' },
      'workspace',
    );
    expect(messages).toEqual([
      {
        type: 'settingsUpdateResult',
        result: { ok: true, settingId: 'runLimit', value: '1h' },
      },
    ]);
  });
});
