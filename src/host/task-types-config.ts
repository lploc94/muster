/**
 * Host-side read/write for muster.taskTypes (resource-scoped VS Code setting).
 * Pure relative to VS Code: callers inject raw readers / configuration writers.
 */

import packageJson from '../../package.json';
import {
  parseTaskTypeRegistry,
  TASK_TYPE_DESCRIPTION_MAX,
  TASK_TYPE_ID_RE,
  TASK_TYPE_MAX,
  type TaskTypeDefinition,
  type TaskTypeDiagnostic,
  type TaskTypeRegistryResult,
} from '../task/task-types';
import type { TaskBriefKind, TaskRole } from '../task/types';
import { TASK_BRIEF_KINDS } from '../task/brief';

export const TASK_TYPES_CONFIG_KEY = 'taskTypes';
export const TASK_TYPES_CONFIG_SECTION = 'muster';

/** Ship defaults from package.json contributes (no model pins). */
export const MUSTER_DEFAULT_TASK_TYPES: Readonly<Record<string, TaskTypeDefinition>> =
  (packageJson.contributes.configuration.properties['muster.taskTypes'] as {
    default: Record<string, TaskTypeDefinition>;
  }).default;

export type TaskTypesSettingsErrorCode =
  | 'invalid_task_type_config'
  | 'updateFailed';

export interface TaskTypeSettingsRow {
  id: string;
  backend: string;
  model?: string;
  role: TaskRole;
  briefKind: TaskBriefKind;
  description?: string;
}

export interface TaskTypesSettingsSnapshot {
  status: 'ok' | 'empty' | 'invalid';
  types: TaskTypeSettingsRow[];
  diagnostics: readonly TaskTypeDiagnostic[];
  /** Package ship defaults (for Reset). */
  defaults: TaskTypeSettingsRow[];
  constraints: {
    maxTypes: number;
    idPattern: string;
    descriptionMax: number;
    stringMax: number;
    roles: readonly TaskRole[];
    briefKinds: readonly TaskBriefKind[];
  };
}

export type TaskTypesSettingsUpdateResult =
  | { ok: true }
  | { ok: false; code: TaskTypesSettingsErrorCode; message: string; diagnostics?: readonly TaskTypeDiagnostic[] };

export type TaskTypesSettingsHostMessage =
  | { type: 'taskTypesSettingsSnapshot'; snapshot: TaskTypesSettingsSnapshot }
  | { type: 'taskTypesSettingsUpdateResult'; result: TaskTypesSettingsUpdateResult };

export interface TaskTypesSettingsConfiguration {
  update(
    key: string,
    value: unknown,
    target: unknown,
  ): Thenable<void> | Promise<void> | void;
  get?(key: string): unknown;
}

function definitionToRow(id: string, def: TaskTypeDefinition): TaskTypeSettingsRow {
  const row: TaskTypeSettingsRow = {
    id,
    backend: def.backend,
    role: def.role ?? 'worker',
    briefKind: def.briefKind ?? 'generic',
  };
  if (def.model !== undefined) row.model = def.model;
  if (def.description !== undefined) row.description = def.description;
  return row;
}

function registryToRows(result: TaskTypeRegistryResult): TaskTypeSettingsRow[] {
  if (result.status !== 'ok') return [];
  const rows: TaskTypeSettingsRow[] = [];
  for (const [id, def] of result.registry) {
    rows.push(definitionToRow(id, def));
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

function defaultsAsRows(): TaskTypeSettingsRow[] {
  return Object.entries(MUSTER_DEFAULT_TASK_TYPES)
    .map(([id, def]) => definitionToRow(id, def))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Parse raw configuration value into a full TaskTypeRegistryResult.
 * Never collapses invalid → empty.
 */
export function readTaskTypeRegistryFromRaw(raw: unknown): TaskTypeRegistryResult {
  return parseTaskTypeRegistry(raw);
}

/**
 * cwd-aware registry load. `readRaw(cwd?)` should return the **unmerged**
 * raw value for that folder (or workspace/default when cwd omitted).
 * Callers must not use WorkspaceConfiguration.get() for object maps — VS Code
 * merges defaults into `{}` and defeats explicit-empty fail-closed.
 * Read failures → status invalid with diagnostics (not silent empty).
 */
export function loadTaskTypeRegistry(
  readRaw: (cwd?: string) => unknown,
  cwd?: string,
): TaskTypeRegistryResult {
  try {
    return parseTaskTypeRegistry(readRaw(cwd));
  } catch {
    return {
      status: 'invalid',
      registry: new Map(),
      diagnostics: [
        {
          code: 'read_failed',
          message: 'Failed to read muster.taskTypes configuration',
        },
      ],
    };
  }
}

/**
 * Pick the first explicitly defined object-setting value by scope priority.
 * Use with `WorkspaceConfiguration.inspect()` so workspace `{}` overrides
 * package defaults (VS Code `get()` merges object defaults into empty maps).
 *
 * When NO scope is set explicitly, fall back to the baked-in
 * `MUSTER_DEFAULT_TASK_TYPES` (derived from this build's package.json) rather
 * than `inspect().defaultValue`. A running extension host can report an
 * `undefined` defaultValue when its manifest is stale / not yet re-registered
 * after an update; that emptiness would otherwise block create/delegate and
 * render the Settings panel as "Invalid · 0 of 32". Seeding the shipped
 * defaults keeps the map usable and immune to manifest staleness, while an
 * explicit `{}` at any scope is still honored above (deliberate opt-out).
 */
export function pickExplicitTaskTypesValue(inspected: {
  workspaceFolderValue?: unknown;
  workspaceValue?: unknown;
  globalValue?: unknown;
  defaultValue?: unknown;
}): unknown {
  if (inspected.workspaceFolderValue !== undefined) return inspected.workspaceFolderValue;
  if (inspected.workspaceValue !== undefined) return inspected.workspaceValue;
  if (inspected.globalValue !== undefined) return inspected.globalValue;
  if (inspected.defaultValue !== undefined) return inspected.defaultValue;
  return MUSTER_DEFAULT_TASK_TYPES;
}

export function buildTaskTypesSettingsSnapshot(
  readRaw: () => unknown,
): TaskTypesSettingsSnapshot {
  const result = loadTaskTypeRegistry(readRaw);
  return {
    status: result.status,
    types: registryToRows(result),
    diagnostics: result.diagnostics,
    defaults: defaultsAsRows(),
    constraints: {
      maxTypes: TASK_TYPE_MAX,
      idPattern: TASK_TYPE_ID_RE.source,
      descriptionMax: TASK_TYPE_DESCRIPTION_MAX,
      stringMax: 200,
      roles: ['coordinator', 'worker'],
      briefKinds: [...TASK_BRIEF_KINDS],
    },
  };
}

/** Convert UI rows → plain object map for VS Code settings. */
export function rowsToTaskTypesMap(
  rows: readonly TaskTypeSettingsRow[],
): Record<string, TaskTypeDefinition> {
  // Null prototype: avoid special keys like __proto__ becoming silent no-ops / pollution.
  const map = Object.create(null) as Record<string, TaskTypeDefinition>;
  for (const row of rows) {
    const def: TaskTypeDefinition = { backend: row.backend };
    if (row.model !== undefined && row.model.trim().length > 0) {
      def.model = row.model.trim();
    }
    if (row.description !== undefined && row.description.trim().length > 0) {
      def.description = row.description.trim();
    }
    // Always persist role/briefKind so Settings round-trips are stable.
    def.role = row.role;
    def.briefKind = row.briefKind;
    map[row.id] = def;
  }
  return { ...map };
}

function invalidConfig(message: string): TaskTypesSettingsUpdateResult {
  return { ok: false, code: 'invalid_task_type_config', message };
}

/**
 * Validate candidate types map (object or rows-shaped array of entries).
 * Empty object is allowed (user explicit empty → fail-closed at create).
 * Rows: fail-closed on malformed fields — never silently normalize.
 */
export function validateTaskTypesUpdate(input: unknown): TaskTypesSettingsUpdateResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalidConfig('taskTypes must be an object map');
  }

  // Accept either { types: Row[] } or raw map Record<id, def>
  let rawMap: unknown = input;
  if ('types' in input && Array.isArray((input as { types: unknown }).types)) {
    const rows = (input as { types: unknown[] }).types;
    if (rows.length > TASK_TYPE_MAX) {
      return invalidConfig(`At most ${TASK_TYPE_MAX} task types`);
    }
    const asRows: TaskTypeSettingsRow[] = [];
    const seenIds = new Set<string>();
    for (const entry of rows) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return invalidConfig('Each task type row must be an object');
      }
      const r = entry as Record<string, unknown>;
      if (typeof r.id !== 'string' || r.id.trim().length === 0) {
        return invalidConfig('Each task type needs a non-empty id');
      }
      if (!TASK_TYPE_ID_RE.test(r.id)) {
        return invalidConfig(`Invalid task type id "${r.id}"`);
      }
      if (typeof r.backend !== 'string' || r.backend.trim().length === 0) {
        return invalidConfig(`Task type "${r.id}" needs a non-empty backend`);
      }
      if (r.role !== 'coordinator' && r.role !== 'worker') {
        return invalidConfig(`Task type "${r.id}" has invalid role`);
      }
      if (
        typeof r.briefKind !== 'string' ||
        !(TASK_BRIEF_KINDS as readonly string[]).includes(r.briefKind)
      ) {
        return invalidConfig(`Task type "${r.id}" has invalid briefKind`);
      }
      if ('model' in r && r.model !== undefined && typeof r.model !== 'string') {
        return invalidConfig(`Task type "${r.id}" model must be a string`);
      }
      if ('description' in r && r.description !== undefined && typeof r.description !== 'string') {
        return invalidConfig(`Task type "${r.id}" description must be a string`);
      }
      if (seenIds.has(r.id)) {
        return invalidConfig(`Duplicate task type id "${r.id}"`);
      }
      seenIds.add(r.id);

      const row: TaskTypeSettingsRow = {
        id: r.id,
        backend: r.backend,
        role: r.role,
        briefKind: r.briefKind as TaskBriefKind,
      };
      if (typeof r.model === 'string' && r.model.length > 0) row.model = r.model;
      if (typeof r.description === 'string' && r.description.length > 0) {
        row.description = r.description;
      }
      asRows.push(row);
    }
    rawMap = rowsToTaskTypesMap(asRows);
  }

  const parsed = parseTaskTypeRegistry(rawMap);
  if (parsed.status === 'invalid') {
    return {
      ok: false,
      code: 'invalid_task_type_config',
      message: parsed.diagnostics[0]?.message ?? 'muster.taskTypes is malformed',
      diagnostics: parsed.diagnostics,
    };
  }
  // empty and ok both allowed for persist
  return { ok: true };
}

export function sanitizeTaskTypesUpdateError(_error: unknown): TaskTypesSettingsUpdateResult {
  return {
    ok: false,
    code: 'updateFailed',
    message: 'Unable to update muster.taskTypes.',
  };
}

export async function persistTaskTypesUpdate(
  configuration: TaskTypesSettingsConfiguration,
  input: unknown,
  target: unknown,
): Promise<TaskTypesSettingsUpdateResult> {
  const validation = validateTaskTypesUpdate(input);
  if (!validation.ok) return validation;

  let valueToWrite: unknown = input;
  if (
    typeof input === 'object' &&
    input !== null &&
    'types' in input &&
    Array.isArray((input as { types: unknown }).types)
  ) {
    const rows = (input as { types: TaskTypeSettingsRow[] }).types;
    valueToWrite = rowsToTaskTypesMap(rows);
  }

  try {
    await configuration.update(TASK_TYPES_CONFIG_KEY, valueToWrite, target);
    return { ok: true };
  } catch (error) {
    return sanitizeTaskTypesUpdateError(error);
  }
}

export async function handleTaskTypesSettingsUpdateAction(
  configuration: TaskTypesSettingsConfiguration,
  input: unknown,
  target: unknown,
  readRaw: () => unknown,
): Promise<TaskTypesSettingsHostMessage[]> {
  const result = await persistTaskTypesUpdate(configuration, input, target);
  const messages: TaskTypesSettingsHostMessage[] = [
    { type: 'taskTypesSettingsUpdateResult', result },
  ];
  if (result.ok) {
    try {
      messages.push({
        type: 'taskTypesSettingsSnapshot',
        snapshot: buildTaskTypesSettingsSnapshot(readRaw),
      });
    } catch {
      // keep update result
    }
  }
  return messages;
}
