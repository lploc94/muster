import packageJson from '../../package.json';
import {
  DEFAULT_RUN_LIMIT,
  parseRunLimit,
  type RunLimitSetting,
} from '../task/execution-policy';

export type RuntimeStorageSettingId =
  | 'runLimit'
  | 'maxRetainedTurnsPerTask'
  | 'maxStoredOutputChars';
/** Compatibility export for existing host/webview plumbing. */
export type RetentionSettingId = RuntimeStorageSettingId;

export type RuntimeStorageSettingErrorCode =
  | 'unknownSetting'
  | 'invalidType'
  | 'invalidEnum'
  | 'nonFinite'
  | 'nonInteger'
  | 'belowMinimum'
  | 'updateFailed';
export type RetentionSettingErrorCode = RuntimeStorageSettingErrorCode;

interface EnumDefinition {
  kind: 'enum';
  id: 'runLimit';
  configKey: 'runLimit';
  label: string;
  description: string;
  defaultValue: RunLimitSetting;
  options: RunLimitSetting[];
}

interface NumberDefinition {
  kind: 'number';
  id: 'maxRetainedTurnsPerTask' | 'maxStoredOutputChars';
  configKey: 'maxRetainedTurnsPerTask' | 'maxStoredOutputChars';
  label: string;
  description: string;
  defaultValue: number;
  minimum: number;
}

export type RuntimeStorageSettingDefinition = EnumDefinition | NumberDefinition;
export type RetentionSettingDefinition = RuntimeStorageSettingDefinition;

export type RuntimeStorageSettingValue =
  | (Omit<EnumDefinition, 'configKey'> & { value: RunLimitSetting })
  | (Omit<NumberDefinition, 'configKey'> & { value: number });
export type RetentionSettingValue = RuntimeStorageSettingValue;

export interface RuntimeStorageSettingsSnapshot {
  settings: RuntimeStorageSettingValue[];
}
export type RetentionSettingSnapshot = RuntimeStorageSettingsSnapshot;

export type RuntimeStorageSettingsValidationResult =
  | { ok: true; settingId: 'runLimit'; value: RunLimitSetting }
  | {
      ok: true;
      settingId: 'maxRetainedTurnsPerTask' | 'maxStoredOutputChars';
      value: number;
    }
  | {
      ok: false;
      settingId?: RuntimeStorageSettingId;
      code: RuntimeStorageSettingErrorCode;
      message: string;
    };
export type RetentionSettingsValidationResult = RuntimeStorageSettingsValidationResult;

export interface RuntimeStorageSettingsConfiguration {
  update(
    key: RuntimeStorageSettingId,
    value: number | RunLimitSetting,
    target: unknown,
  ): Thenable<void> | Promise<void> | void;
}

export interface RuntimeStorageSettingsReadableConfiguration
  extends RuntimeStorageSettingsConfiguration {
  get(key: RuntimeStorageSettingId): unknown;
}
export type RetentionSettingsConfiguration = RuntimeStorageSettingsConfiguration;
export type RetentionSettingsReadableConfiguration = RuntimeStorageSettingsReadableConfiguration;

export type RuntimeStorageSettingsHostMessage =
  | { type: 'settingsUpdateResult'; result: RuntimeStorageSettingsValidationResult }
  | { type: 'settingsSnapshot'; snapshot: RuntimeStorageSettingsSnapshot };
export type RetentionSettingsHostMessage = RuntimeStorageSettingsHostMessage;

const properties = packageJson.contributes.configuration.properties;
const runProperty = properties['muster.execution.runLimit'];
const retainedProperty = properties['muster.retention.maxRetainedTurnsPerTask'];
const outputProperty = properties['muster.retention.maxStoredOutputChars'];

export const RUNTIME_STORAGE_SETTING_DEFINITIONS: RuntimeStorageSettingDefinition[] = [
  {
    kind: 'enum',
    id: 'runLimit',
    configKey: 'runLimit',
    label: 'Maximum uninterrupted agent run',
    description: runProperty.description,
    defaultValue: DEFAULT_RUN_LIMIT,
    options: [...runProperty.enum] as RunLimitSetting[],
  },
  {
    kind: 'number',
    id: 'maxRetainedTurnsPerTask',
    configKey: 'maxRetainedTurnsPerTask',
    label: 'Retained turns per completed task',
    description: retainedProperty.description,
    defaultValue: retainedProperty.default,
    minimum: retainedProperty.minimum,
  },
  {
    kind: 'number',
    id: 'maxStoredOutputChars',
    configKey: 'maxStoredOutputChars',
    label: 'Stored output per turn',
    description: outputProperty.description,
    defaultValue: outputProperty.default,
    minimum: outputProperty.minimum,
  },
];
export const RETENTION_SETTING_DEFINITIONS = RUNTIME_STORAGE_SETTING_DEFINITIONS;

/** New explicit value wins; legacy explicit value is the one-release fallback. */
export function selectRetainedTurnsValue(
  nextExplicit: unknown,
  legacyExplicit: unknown,
  configuredDefault: unknown,
): unknown {
  return nextExplicit !== undefined
    ? nextExplicit
    : legacyExplicit !== undefined
      ? legacyExplicit
      : configuredDefault;
}

export function isRetentionSettingId(value: unknown): value is RuntimeStorageSettingId {
  return value === 'runLimit' ||
    value === 'maxRetainedTurnsPerTask' ||
    value === 'maxStoredOutputChars';
}

export function retentionSettingDefinition(
  settingId: RuntimeStorageSettingId,
): RuntimeStorageSettingDefinition {
  return RUNTIME_STORAGE_SETTING_DEFINITIONS.find((definition) => definition.id === settingId)!;
}

export function buildRetentionSettingsSnapshot(
  readConfigValue: (key: RuntimeStorageSettingId) => unknown,
): RuntimeStorageSettingsSnapshot {
  return {
    settings: RUNTIME_STORAGE_SETTING_DEFINITIONS.map((definition) => {
      const configuredValue = readConfigValue(definition.configKey);
      if (definition.kind === 'enum') {
        const value = parseRunLimit(configuredValue);
        return {
          kind: definition.kind,
          id: definition.id,
          label: definition.label,
          description: definition.description,
          defaultValue: definition.defaultValue,
          options: definition.options,
          value,
        };
      }
      const value =
        typeof configuredValue === 'number' &&
        Number.isFinite(configuredValue) &&
        Number.isInteger(configuredValue) &&
        configuredValue >= definition.minimum
          ? configuredValue
          : definition.defaultValue;
      return {
        kind: definition.kind,
        id: definition.id,
        label: definition.label,
        description: definition.description,
        defaultValue: definition.defaultValue,
        minimum: definition.minimum,
        value,
      };
    }),
  };
}

export function validateRetentionSettingUpdate(
  input: unknown,
): RuntimeStorageSettingsValidationResult {
  if (typeof input !== 'object' || input === null || !Object.hasOwn(input, 'settingId')) {
    return { ok: false, code: 'unknownSetting', message: 'Unsupported runtime or storage setting.' };
  }
  const candidate = input as { settingId?: unknown; value?: unknown };
  if (!isRetentionSettingId(candidate.settingId)) {
    return { ok: false, code: 'unknownSetting', message: 'Unsupported runtime or storage setting.' };
  }
  const definition = retentionSettingDefinition(candidate.settingId);
  if (!Object.hasOwn(input, 'value')) {
    return {
      ok: false,
      settingId: definition.id,
      code: 'invalidType',
      message: `${definition.label} has an invalid value.`,
    };
  }
  if (definition.kind === 'enum') {
    if (typeof candidate.value !== 'string') {
      return { ok: false, settingId: definition.id, code: 'invalidType', message: `${definition.label} must be a duration.` };
    }
    if (!definition.options.includes(candidate.value as RunLimitSetting)) {
      return { ok: false, settingId: definition.id, code: 'invalidEnum', message: `${definition.label} is not supported.` };
    }
    return { ok: true, settingId: definition.id, value: candidate.value as RunLimitSetting };
  }
  if (typeof candidate.value !== 'number') {
    return { ok: false, settingId: definition.id, code: 'invalidType', message: `${definition.label} must be a number.` };
  }
  if (!Number.isFinite(candidate.value)) {
    return { ok: false, settingId: definition.id, code: 'nonFinite', message: `${definition.label} must be finite.` };
  }
  if (!Number.isInteger(candidate.value)) {
    return { ok: false, settingId: definition.id, code: 'nonInteger', message: `${definition.label} must be an integer.` };
  }
  if (candidate.value < definition.minimum) {
    return { ok: false, settingId: definition.id, code: 'belowMinimum', message: `${definition.label} must be at least ${definition.minimum}.` };
  }
  return { ok: true, settingId: definition.id, value: candidate.value };
}

export function sanitizeRetentionSettingsError(
  settingId: RuntimeStorageSettingId,
  _error: unknown,
): RuntimeStorageSettingsValidationResult {
  const definition = retentionSettingDefinition(settingId);
  return {
    ok: false,
    settingId,
    code: 'updateFailed',
    message: `Unable to update ${definition.label}.`,
  };
}

export async function persistRetentionSettingUpdate(
  configuration: RuntimeStorageSettingsConfiguration,
  input: unknown,
  target: unknown,
): Promise<RuntimeStorageSettingsValidationResult> {
  const validation = validateRetentionSettingUpdate(input);
  if (!validation.ok) return validation;
  try {
    await configuration.update(validation.settingId, validation.value, target);
    return validation;
  } catch (error) {
    return sanitizeRetentionSettingsError(validation.settingId, error);
  }
}

export async function handleRetentionSettingUpdateAction(
  configuration: RuntimeStorageSettingsReadableConfiguration,
  input: unknown,
  target: unknown,
): Promise<RuntimeStorageSettingsHostMessage[]> {
  const result = await persistRetentionSettingUpdate(configuration, input, target);
  const messages: RuntimeStorageSettingsHostMessage[] = [
    { type: 'settingsUpdateResult', result },
  ];
  if (result.ok) {
    try {
      messages.push({
        type: 'settingsSnapshot',
        snapshot: buildRetentionSettingsSnapshot((key) => configuration.get(key)),
      });
    } catch {
      // Successful write remains authoritative even if refresh fails.
    }
  }
  return messages;
}
