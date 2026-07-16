/**
 * Host-side read/write for muster.permissions.mode.
 * Fail-closed helper dedicated to the security-sensitive permission enum.
 * Modeled on retention-settings but not a generic settings registry.
 */

import packageJson from '../../package.json';
import type { PermissionMode } from '../backends/permission-policy';

export type PermissionModeRisk = 'recommended' | 'least-safe' | 'restricted';

export type PermissionSettingsErrorCode = 'invalidPayload' | 'unknownMode' | 'updateFailed';

export interface PermissionModeOption {
  mode: PermissionMode;
  label: string;
  description: string;
  risk: PermissionModeRisk;
}

export interface PermissionSettingsSnapshot {
  mode: PermissionMode;
  defaultMode: PermissionMode;
  options: readonly PermissionModeOption[];
  description: string;
}

export type PermissionSettingsValidationResult =
  | { ok: true; mode: PermissionMode }
  | { ok: false; code: PermissionSettingsErrorCode; message: string };

export interface PermissionSettingsConfiguration {
  update(key: 'mode', value: PermissionMode, target: unknown): Thenable<void> | Promise<void> | void;
}

export interface PermissionSettingsReadableConfiguration extends PermissionSettingsConfiguration {
  get(key: 'mode'): unknown;
}

export type PermissionSettingsHostMessage =
  | { type: 'permissionSettingsUpdateResult'; result: PermissionSettingsValidationResult }
  | { type: 'permissionSettingsSnapshot'; snapshot: PermissionSettingsSnapshot };

interface PermissionModeConfigProperty {
  readonly type: string;
  readonly enum: readonly string[];
  readonly default: string;
  readonly enumDescriptions: readonly string[];
  readonly description: string;
}

const properties = packageJson.contributes.configuration.properties;
const permissionModeProperty = properties['muster.permissions.mode'] as unknown as PermissionModeConfigProperty;

const MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'Ask',
  allow: 'Allow',
  readonly: 'Read only',
};

const MODE_RISKS: Record<PermissionMode, PermissionModeRisk> = {
  ask: 'recommended',
  allow: 'least-safe',
  readonly: 'restricted',
};

const MODE_ORDER = permissionModeProperty.enum as readonly PermissionMode[];

export const PERMISSION_MODE_DEFAULT: PermissionMode =
  permissionModeProperty.default === 'allow' || permissionModeProperty.default === 'readonly'
    ? permissionModeProperty.default
    : 'ask';

export const PERMISSION_MODE_OPTIONS: readonly PermissionModeOption[] = MODE_ORDER.map((mode, index) => ({
  mode,
  label: MODE_LABELS[mode],
  description: permissionModeProperty.enumDescriptions[index] ?? '',
  risk: MODE_RISKS[mode],
}));

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'allow' || value === 'readonly';
}

function normalizePermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : PERMISSION_MODE_DEFAULT;
}

export function buildPermissionSettingsSnapshot(
  readConfigValue: (key: 'mode') => unknown,
): PermissionSettingsSnapshot {
  return {
    mode: normalizePermissionMode(readConfigValue('mode')),
    defaultMode: PERMISSION_MODE_DEFAULT,
    options: PERMISSION_MODE_OPTIONS,
    description: permissionModeProperty.description,
  };
}

export function validatePermissionSettingsUpdate(input: unknown): PermissionSettingsValidationResult {
  if (typeof input !== 'object' || input === null) {
    return {
      ok: false,
      code: 'invalidPayload',
      message: 'Unsupported permission mode update.',
    };
  }

  const keys = Object.keys(input as object);
  if (keys.length !== 1 || keys[0] !== 'mode' || !Object.hasOwn(input, 'mode')) {
    return {
      ok: false,
      code: 'invalidPayload',
      message: 'Unsupported permission mode update.',
    };
  }

  const mode = (input as { mode: unknown }).mode;
  if (!isPermissionMode(mode)) {
    return {
      ok: false,
      code: 'unknownMode',
      message: 'Unsupported permission mode.',
    };
  }

  return { ok: true, mode };
}

export function sanitizePermissionSettingsError(_error: unknown): PermissionSettingsValidationResult {
  return {
    ok: false,
    code: 'updateFailed',
    message: 'Unable to update permission mode.',
  };
}

export async function persistPermissionSettingsUpdate(
  configuration: PermissionSettingsConfiguration,
  input: unknown,
  target: unknown,
): Promise<PermissionSettingsValidationResult> {
  const validation = validatePermissionSettingsUpdate(input);
  if (!validation.ok) {
    return validation;
  }

  try {
    await configuration.update('mode', validation.mode, target);
    return validation;
  } catch (error) {
    return sanitizePermissionSettingsError(error);
  }
}

export async function handlePermissionSettingsUpdateAction(
  configuration: PermissionSettingsReadableConfiguration,
  input: unknown,
  target: unknown,
): Promise<PermissionSettingsHostMessage[]> {
  const result = await persistPermissionSettingsUpdate(configuration, input, target);
  const messages: PermissionSettingsHostMessage[] = [
    { type: 'permissionSettingsUpdateResult', result },
  ];

  if (result.ok) {
    try {
      messages.push({
        type: 'permissionSettingsSnapshot',
        snapshot: buildPermissionSettingsSnapshot((key) => configuration.get(key)),
      });
    } catch {
      // Preserve the successful update result. The webview can display saved state
      // even when VS Code configuration cannot be read for a refreshed snapshot.
    }
  }

  return messages;
}
