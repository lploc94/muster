import { describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import {
  RETENTION_SETTING_DEFINITIONS,
  buildRetentionSettingsSnapshot,
  handleRetentionSettingUpdateAction,
  persistRetentionSettingUpdate,
  sanitizeRetentionSettingsError,
  validateRetentionSettingUpdate,
} from './retention-settings';

const configProperties = packageJson.contributes.configuration.properties;

describe('retention settings helper', () => {
  it('defines the two allowed retention settings from package configuration metadata', () => {
    expect(RETENTION_SETTING_DEFINITIONS).toEqual([
      {
        id: 'maxTurnsPerTask',
        configKey: 'maxTurnsPerTask',
        label: 'Max turns per task',
        description: configProperties['muster.retention.maxTurnsPerTask'].description,
        defaultValue: configProperties['muster.retention.maxTurnsPerTask'].default,
        minimum: configProperties['muster.retention.maxTurnsPerTask'].minimum,
      },
      {
        id: 'maxStoredOutputChars',
        configKey: 'maxStoredOutputChars',
        label: 'Max stored output characters',
        description: configProperties['muster.retention.maxStoredOutputChars'].description,
        defaultValue: configProperties['muster.retention.maxStoredOutputChars'].default,
        minimum: configProperties['muster.retention.maxStoredOutputChars'].minimum,
      },
    ]);
  });

  it('builds a settings snapshot using configured numeric values and package defaults', () => {
    const snapshot = buildRetentionSettingsSnapshot((key) => {
      if (key === 'maxTurnsPerTask') return 75;
      return undefined;
    });

    expect(snapshot.settings).toEqual([
      {
        id: 'maxTurnsPerTask',
        label: 'Max turns per task',
        description: configProperties['muster.retention.maxTurnsPerTask'].description,
        value: 75,
        defaultValue: 200,
        minimum: 1,
      },
      {
        id: 'maxStoredOutputChars',
        label: 'Max stored output characters',
        description: configProperties['muster.retention.maxStoredOutputChars'].description,
        value: 200000,
        defaultValue: 200000,
        minimum: 1024,
      },
    ]);
  });

  it('falls back to defaults when configured values would violate the protocol contract', () => {
    const snapshot = buildRetentionSettingsSnapshot((key) => {
      if (key === 'maxTurnsPerTask') return 0;
      return 1024.5;
    });

    expect(snapshot.settings.map((setting) => [setting.id, setting.value])).toEqual([
      ['maxTurnsPerTask', 200],
      ['maxStoredOutputChars', 200000],
    ]);
  });

  it('accepts valid integer updates for allowed setting IDs', () => {
    expect(validateRetentionSettingUpdate({ settingId: 'maxTurnsPerTask', value: 1 })).toEqual({
      ok: true,
      settingId: 'maxTurnsPerTask',
      value: 1,
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxStoredOutputChars', value: 4096 })).toEqual({
      ok: true,
      settingId: 'maxStoredOutputChars',
      value: 4096,
    });
  });

  it('returns sanitized validation errors for malformed update payloads', () => {
    expect(validateRetentionSettingUpdate({ settingId: 'unknown', value: 10 })).toEqual({
      ok: false,
      code: 'unknownSetting',
      message: 'Unsupported retention setting.',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxTurnsPerTask', value: '10' })).toEqual({
      ok: false,
      settingId: 'maxTurnsPerTask',
      code: 'invalidType',
      message: 'Max turns per task must be a number.',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxTurnsPerTask', value: Number.NaN })).toEqual({
      ok: false,
      settingId: 'maxTurnsPerTask',
      code: 'nonFinite',
      message: 'Max turns per task must be finite.',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxTurnsPerTask', value: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      settingId: 'maxTurnsPerTask',
      code: 'nonFinite',
      message: 'Max turns per task must be finite.',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxTurnsPerTask', value: 1.5 })).toEqual({
      ok: false,
      settingId: 'maxTurnsPerTask',
      code: 'nonInteger',
      message: 'Max turns per task must be an integer.',
    });
    expect(validateRetentionSettingUpdate({ settingId: 'maxStoredOutputChars', value: 1023 })).toEqual({
      ok: false,
      settingId: 'maxStoredOutputChars',
      code: 'belowMinimum',
      message: 'Max stored output characters must be at least 1024.',
    });
  });

  it('rejects inherited update payload fields without persisting', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const input = Object.create({ settingId: 'maxTurnsPerTask', value: 25 }) as unknown;

    await expect(
      persistRetentionSettingUpdate({ update }, input, Symbol('workspace-target')),
    ).resolves.toEqual({
      ok: false,
      code: 'unknownSetting',
      message: 'Unsupported retention setting.',
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('persists valid updates using the package leaf key and supplied workspace target', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const workspaceTarget = Symbol('workspace-target');

    await expect(
      persistRetentionSettingUpdate(
        { update },
        { settingId: 'maxStoredOutputChars', value: 4096 },
        workspaceTarget,
      ),
    ).resolves.toEqual({ ok: true, settingId: 'maxStoredOutputChars', value: 4096 });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('maxStoredOutputChars', 4096, workspaceTarget);
  });

  it('fails closed without persisting malformed update payloads', async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await expect(
      persistRetentionSettingUpdate({ update }, undefined, Symbol('workspace-target')),
    ).resolves.toEqual({
      ok: false,
      code: 'unknownSetting',
      message: 'Unsupported retention setting.',
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('fails closed without persisting below-minimum values', async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await expect(
      persistRetentionSettingUpdate(
        { update },
        { settingId: 'maxStoredOutputChars', value: 1023 },
        Symbol('workspace-target'),
      ),
    ).resolves.toEqual({
      ok: false,
      settingId: 'maxStoredOutputChars',
      code: 'belowMinimum',
      message: 'Max stored output characters must be at least 1024.',
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('converts rejected update promises into sanitized error results', async () => {
    const update = vi.fn().mockRejectedValue(new Error('ENOENT /secret/path token=abc123'));

    await expect(
      persistRetentionSettingUpdate(
        { update },
        { settingId: 'maxTurnsPerTask', value: 25 },
        Symbol('workspace-target'),
      ),
    ).resolves.toEqual({
      ok: false,
      settingId: 'maxTurnsPerTask',
      code: 'updateFailed',
      message: 'Unable to update Max turns per task.',
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('converts thrown update failures into sanitized error results', () => {
    const raw = new Error('ENOENT /secret/path token=abc123');

    const sanitized = sanitizeRetentionSettingsError('maxTurnsPerTask', raw);
    expect(sanitized).toEqual({
      ok: false,
      settingId: 'maxTurnsPerTask',
      code: 'updateFailed',
      message: 'Unable to update Max turns per task.',
    });
    // Sanitized Retention failure must never echo raw host paths or tokens.
    expect(JSON.stringify(sanitized)).not.toMatch(/ENOENT|\/secret\/|token=/);
  });

  it('returns an update result followed by a refreshed settings snapshot for update actions', async () => {
    const values = new Map([
      ['maxTurnsPerTask', 25],
      ['maxStoredOutputChars', 200000],
    ]);
    const configuration = {
      get: vi.fn((key: 'maxTurnsPerTask' | 'maxStoredOutputChars') => values.get(key)),
      update: vi.fn(async (key: 'maxTurnsPerTask' | 'maxStoredOutputChars', value: number) => {
        values.set(key, value);
      }),
    };

    await expect(
      handleRetentionSettingUpdateAction(
        configuration,
        { settingId: 'maxTurnsPerTask', value: 50 },
        'workspace',
      ),
    ).resolves.toEqual([
      {
        type: 'settingsUpdateResult',
        result: { ok: true, settingId: 'maxTurnsPerTask', value: 50 },
      },
      {
        type: 'settingsSnapshot',
        snapshot: expect.objectContaining({
          settings: expect.arrayContaining([
            expect.objectContaining({ id: 'maxTurnsPerTask', value: 50 }),
          ]),
        }),
      },
    ]);

    expect(configuration.update).toHaveBeenCalledWith('maxTurnsPerTask', 50, 'workspace');
  });

  it('does not refresh the settings snapshot after a failed update result', async () => {
    const configuration = {
      get: vi.fn(() => 200),
      update: vi.fn().mockRejectedValue(new Error('permission denied token=abc123')),
    };

    await expect(
      handleRetentionSettingUpdateAction(
        configuration,
        { settingId: 'maxTurnsPerTask', value: 50 },
        'workspace',
      ),
    ).resolves.toEqual([
      {
        type: 'settingsUpdateResult',
        result: {
          ok: false,
          settingId: 'maxTurnsPerTask',
          code: 'updateFailed',
          message: 'Unable to update Max turns per task.',
        },
      },
    ]);

    expect(configuration.get).not.toHaveBeenCalled();
  });

  it('still returns the sanitized update failure when refreshing the snapshot also fails', async () => {
    const configuration = {
      get: vi.fn(() => {
        throw new Error('ENOENT /secret/path token=abc123');
      }),
      update: vi.fn().mockRejectedValue(new Error('permission denied token=abc123')),
    };

    await expect(
      handleRetentionSettingUpdateAction(
        configuration,
        { settingId: 'maxTurnsPerTask', value: 50 },
        'workspace',
      ),
    ).resolves.toEqual([
      {
        type: 'settingsUpdateResult',
        result: {
          ok: false,
          settingId: 'maxTurnsPerTask',
          code: 'updateFailed',
          message: 'Unable to update Max turns per task.',
        },
      },
    ]);
  });
});
