import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import {
  setPermissionController,
  type PermissionController,
} from '../backends/acp-client';
import {
  resolvePolicy,
  type PermissionMode,
} from '../backends/permission-policy';
import {
  PERMISSION_MODE_OPTIONS,
  PERMISSION_MODE_DEFAULT,
  buildPermissionSettingsSnapshot,
  handlePermissionSettingsUpdateAction,
  isPermissionMode,
  persistPermissionSettingsUpdate,
  sanitizePermissionSettingsError,
  validatePermissionSettingsUpdate,
} from './permission-settings';

const configProperty = packageJson.contributes.configuration.properties['muster.permissions.mode'];

describe('permission settings helper', () => {
  it('defines the three permission modes from package configuration metadata with ask as default', () => {
    expect(PERMISSION_MODE_DEFAULT).toBe('ask');
    expect(PERMISSION_MODE_DEFAULT).toBe(configProperty.default);
    expect(PERMISSION_MODE_OPTIONS.map((option) => option.mode)).toEqual(['ask', 'allow', 'readonly']);
    expect(PERMISSION_MODE_OPTIONS).toEqual([
      {
        mode: 'ask',
        label: 'Ask',
        description: configProperty.enumDescriptions[0],
        risk: 'recommended',
      },
      {
        mode: 'allow',
        label: 'Allow',
        description: configProperty.enumDescriptions[1],
        risk: 'least-safe',
      },
      {
        mode: 'readonly',
        label: 'Read only',
        description: configProperty.enumDescriptions[2],
        risk: 'restricted',
      },
    ]);
  });

  it('narrows only ask, allow, and readonly as PermissionMode values', () => {
    expect(isPermissionMode('ask')).toBe(true);
    expect(isPermissionMode('allow')).toBe(true);
    expect(isPermissionMode('readonly')).toBe(true);
    expect(isPermissionMode('prompt')).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
    expect(isPermissionMode(1)).toBe(false);
  });

  it('builds a default snapshot when no stored value is present', () => {
    const snapshot = buildPermissionSettingsSnapshot(() => undefined);

    expect(snapshot).toEqual({
      mode: 'ask',
      defaultMode: 'ask',
      options: PERMISSION_MODE_OPTIONS,
      description: configProperty.description,
    });
  });

  it('builds a snapshot using a valid stored mode', () => {
    const snapshot = buildPermissionSettingsSnapshot(() => 'readonly');

    expect(snapshot.mode).toBe('readonly');
    expect(snapshot.defaultMode).toBe('ask');
    expect(snapshot.options).toEqual(PERMISSION_MODE_OPTIONS);
  });

  it('normalizes invalid stored values to the safe ask mode', () => {
    expect(buildPermissionSettingsSnapshot(() => 'prompt').mode).toBe('ask');
    expect(buildPermissionSettingsSnapshot(() => null).mode).toBe('ask');
    expect(buildPermissionSettingsSnapshot(() => 1).mode).toBe('ask');
    expect(buildPermissionSettingsSnapshot(() => ({ mode: 'allow' })).mode).toBe('ask');
    expect(buildPermissionSettingsSnapshot(() => 'ALLOW').mode).toBe('ask');
  });

  it('accepts exact-key valid mode updates', () => {
    for (const mode of ['ask', 'allow', 'readonly'] as PermissionMode[]) {
      expect(validatePermissionSettingsUpdate({ mode })).toEqual({ ok: true, mode });
    }
  });

  it('rejects null, wrong type, unknown mode, missing mode, and extra fields without accepting', () => {
    expect(validatePermissionSettingsUpdate(null)).toEqual({
      ok: false,
      code: 'invalidPayload',
      message: 'Unsupported permission mode update.',
    });
    expect(validatePermissionSettingsUpdate('allow')).toEqual({
      ok: false,
      code: 'invalidPayload',
      message: 'Unsupported permission mode update.',
    });
    expect(validatePermissionSettingsUpdate({})).toEqual({
      ok: false,
      code: 'invalidPayload',
      message: 'Unsupported permission mode update.',
    });
    expect(validatePermissionSettingsUpdate({ mode: 'prompt' })).toEqual({
      ok: false,
      code: 'unknownMode',
      message: 'Unsupported permission mode.',
    });
    expect(validatePermissionSettingsUpdate({ mode: 'allow', extra: true })).toEqual({
      ok: false,
      code: 'invalidPayload',
      message: 'Unsupported permission mode update.',
    });
    expect(validatePermissionSettingsUpdate({ mode: 1 })).toEqual({
      ok: false,
      code: 'unknownMode',
      message: 'Unsupported permission mode.',
    });
  });

  it('rejects inherited update payload fields without persisting', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const input = Object.create({ mode: 'allow' }) as unknown;

    await expect(
      persistPermissionSettingsUpdate({ update }, input, Symbol('workspace-target')),
    ).resolves.toEqual({
      ok: false,
      code: 'invalidPayload',
      message: 'Unsupported permission mode update.',
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('persists only validated modes using the package leaf key and workspace target', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const workspaceTarget = Symbol('workspace-target');

    await expect(
      persistPermissionSettingsUpdate({ update }, { mode: 'readonly' }, workspaceTarget),
    ).resolves.toEqual({ ok: true, mode: 'readonly' });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('mode', 'readonly', workspaceTarget);
  });

  it('fails closed without persisting malformed update payloads', async () => {
    const update = vi.fn().mockResolvedValue(undefined);

    await expect(
      persistPermissionSettingsUpdate({ update }, { mode: 'prompt' }, Symbol('workspace-target')),
    ).resolves.toEqual({
      ok: false,
      code: 'unknownMode',
      message: 'Unsupported permission mode.',
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('converts rejected update promises into sanitized error results', async () => {
    const update = vi.fn().mockRejectedValue(new Error('ENOENT /secret/path token=abc123'));

    await expect(
      persistPermissionSettingsUpdate({ update }, { mode: 'allow' }, Symbol('workspace-target')),
    ).resolves.toEqual({
      ok: false,
      code: 'updateFailed',
      message: 'Unable to update permission mode.',
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('converts thrown update failures into sanitized error results', () => {
    const raw = new Error('ENOENT /secret/path token=abc123');
    const sanitized = sanitizePermissionSettingsError(raw);

    expect(sanitized).toEqual({
      ok: false,
      code: 'updateFailed',
      message: 'Unable to update permission mode.',
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/ENOENT|\/secret\/|token=/);
  });

  it('returns an update result followed by a refreshed permission settings snapshot on success', async () => {
    let stored: unknown = 'ask';
    const configuration = {
      get: vi.fn(() => stored),
      update: vi.fn(async (_key: string, value: unknown) => {
        stored = value;
      }),
    };

    await expect(
      handlePermissionSettingsUpdateAction(configuration, { mode: 'allow' }, 'workspace'),
    ).resolves.toEqual([
      {
        type: 'permissionSettingsUpdateResult',
        result: { ok: true, mode: 'allow' },
      },
      {
        type: 'permissionSettingsSnapshot',
        snapshot: {
          mode: 'allow',
          defaultMode: 'ask',
          options: PERMISSION_MODE_OPTIONS,
          description: configProperty.description,
        },
      },
    ]);

    expect(configuration.update).toHaveBeenCalledWith('mode', 'allow', 'workspace');
  });

  it('does not refresh the snapshot after a failed update result', async () => {
    const configuration = {
      get: vi.fn(() => 'ask'),
      update: vi.fn().mockRejectedValue(new Error('permission denied token=abc123')),
    };

    await expect(
      handlePermissionSettingsUpdateAction(configuration, { mode: 'allow' }, 'workspace'),
    ).resolves.toEqual([
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to update permission mode.',
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
      handlePermissionSettingsUpdateAction(configuration, { mode: 'allow' }, 'workspace'),
    ).resolves.toEqual([
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to update permission mode.',
        },
      },
    ]);
  });

  it('preserves a successful update result when the refreshed snapshot read fails', async () => {
    const configuration = {
      get: vi.fn(() => {
        throw new Error('ENOENT /secret/path token=abc123');
      }),
      update: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      handlePermissionSettingsUpdateAction(configuration, { mode: 'readonly' }, 'workspace'),
    ).resolves.toEqual([
      {
        type: 'permissionSettingsUpdateResult',
        result: { ok: true, mode: 'readonly' },
      },
    ]);
  });
});

describe('M012 S03 flow: saved permission mode is read for the next runtime decision', () => {
  afterEach(() => {
    setPermissionController(null);
  });

  function makeMutableConfiguration(initial: PermissionMode = 'ask') {
    let stored: unknown = initial;
    return {
      get: vi.fn((_key: 'mode') => stored),
      update: vi.fn(async (_key: 'mode', value: PermissionMode) => {
        stored = value;
      }),
      readStored: () => stored as PermissionMode,
    };
  }

  function installLiveModeController(configuration: {
    get: (key: 'mode') => unknown;
  }): PermissionController {
    // Mirrors extension host wiring: mode is re-read on every request.
    const controller: PermissionController = {
      mode: () => {
        const value = configuration.get('mode');
        return value === 'allow' || value === 'readonly' ? value : 'ask';
      },
      isAllowlisted: () => false,
      remember: vi.fn(),
      audit: vi.fn(),
      prompt: vi.fn(async () => ({ allow: false, remember: false })),
    };
    setPermissionController(controller);
    return controller;
  }

  it('persists a validated mode then feeds the next policy decision from the live reader', async () => {
    const configuration = makeMutableConfiguration('ask');
    const controller = installLiveModeController(configuration);

    // Before save: ask auto-allows reads, prompts writes.
    expect(resolvePolicy(controller.mode(), 'read', false).decision).toBe('allow');
    expect(resolvePolicy(controller.mode(), 'write', false).decision).toBe('prompt');

    const messages = await handlePermissionSettingsUpdateAction(
      configuration,
      { mode: 'readonly' },
      'workspace',
    );
    expect(messages[0]).toEqual({
      type: 'permissionSettingsUpdateResult',
      result: { ok: true, mode: 'readonly' },
    });
    expect(configuration.update).toHaveBeenCalledWith('mode', 'readonly', 'workspace');
    expect(configuration.readStored()).toBe('readonly');

    // After save: live mode() re-reads stored value for the next permission request.
    expect(controller.mode()).toBe('readonly');
    expect(resolvePolicy(controller.mode(), 'read', false).decision).toBe('allow');
    expect(resolvePolicy(controller.mode(), 'write', false).decision).toBe('deny');

    // Failed updates do not change the stored mode used by runtime policy.
    configuration.update.mockRejectedValueOnce(new Error('ENOENT /secret/token=abc'));
    const failed = await handlePermissionSettingsUpdateAction(
      configuration,
      { mode: 'allow' },
      'workspace',
    );
    expect(failed).toEqual([
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to update permission mode.',
        },
      },
    ]);
    expect(JSON.stringify(failed)).not.toMatch(/ENOENT|token=|\/secret/);
    expect(configuration.readStored()).toBe('readonly');
    expect(controller.mode()).toBe('readonly');
    expect(resolvePolicy(controller.mode(), 'write', false).decision).toBe('deny');
  });

  it('re-reads allow after a successful save so new writes are auto-approved', async () => {
    const configuration = makeMutableConfiguration('ask');
    const controller = installLiveModeController(configuration);

    await handlePermissionSettingsUpdateAction(configuration, { mode: 'allow' }, 'workspace');
    expect(controller.mode()).toBe('allow');
    expect(resolvePolicy(controller.mode(), 'write', false).decision).toBe('allow');
    expect(resolvePolicy(controller.mode(), 'unknown', false).decision).toBe('allow');
  });
});
