/**
 * User-defined task type registry (type → backend/model presets).
 * Pure helpers — no VS Code / engine I/O.
 */

import type { TaskBriefKind, TaskRole } from './types';
import { isTaskBriefKind } from './brief';

export const TASK_TYPE_MAX = 32;
export const TASK_TYPE_ID_MAX = 64;
export const TASK_TYPE_DESCRIPTION_MAX = 200;
export const TASK_TYPE_STRING_MAX = 200;
/** Cap diagnostic count and message length (bounded MCP errors). */
export const TASK_TYPE_DIAGNOSTIC_MAX = 16;
export const TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX = 240;
export const RUNTIME_FALLBACK_MAX = 8;

/** Type id: lowercase letter, then alnum/_/- up to 63 more chars. */
export const TASK_TYPE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export type TaskTypeErrorCode =
  | 'task_types_not_configured'
  | 'invalid_task_type_config'
  | 'unknown_task_type'
  | 'backend_unsupported'
  | 'backend_not_mcp';

export interface TaskTypeDefinition {
  backend: string;
  model?: string;
  fallbacks?: RuntimeFallbackBinding[];
  role?: TaskRole;
  briefKind?: TaskBriefKind;
  description?: string;
}

export interface RuntimeFallbackBinding {
  backend: string;
  model?: string;
}

export interface TaskTypeDiagnostic {
  code: string;
  message: string;
}

export interface TaskTypeRegistryResult {
  status: 'ok' | 'empty' | 'invalid';
  /** Empty map when status is empty or invalid. */
  registry: ReadonlyMap<string, TaskTypeDefinition>;
  diagnostics: readonly TaskTypeDiagnostic[];
}

/** Agent-facing fields needed for resolve (subset of CreateChildSpec). */
export interface ResolveCreateChildInput {
  taskType: string;
  backend?: string;
  model?: string;
  role?: TaskRole;
  briefKind?: TaskBriefKind;
}

export interface ResolvedCreateChild {
  taskType: string;
  backend: string;
  model?: string;
  role: TaskRole;
  briefKind: TaskBriefKind;
}

export type ResolveCreateChildResult =
  | { ok: true; resolved: ResolvedCreateChild }
  | { ok: false; code: TaskTypeErrorCode; message: string };

function boundIdent(value: string, max = 80): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function boundMessage(message: string): string {
  if (message.length <= TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX) return message;
  return `${message.slice(0, TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX - 1)}…`;
}

function diag(code: string, message: string): TaskTypeDiagnostic {
  return { code, message: boundMessage(message) };
}

function pushDiag(
  diagnostics: TaskTypeDiagnostic[],
  code: string,
  message: string,
): void {
  if (diagnostics.length >= TASK_TYPE_DIAGNOSTIC_MAX) return;
  diagnostics.push(diag(code, message));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampOrRejectString(
  value: unknown,
  field: string,
  max: number,
  diagnostics: TaskTypeDiagnostic[],
): string | undefined {
  if (typeof value !== 'string') {
    pushDiag(diagnostics, 'invalid_field', `${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    pushDiag(diagnostics, 'invalid_field', `${field} must be non-empty`);
    return undefined;
  }
  if (trimmed.length > max) {
    pushDiag(diagnostics, 'invalid_field', `${field} exceeds ${max} characters`);
    return undefined;
  }
  return trimmed;
}

function parseRole(value: unknown, field: string, diagnostics: TaskTypeDiagnostic[]): TaskRole | undefined {
  if (value === undefined) return undefined;
  if (value === 'coordinator' || value === 'worker') return value;
  pushDiag(diagnostics, 'invalid_field', `${field} must be "coordinator" or "worker"`);
  return undefined;
}

function parseBriefKind(
  value: unknown,
  field: string,
  diagnostics: TaskTypeDiagnostic[],
): TaskBriefKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && isTaskBriefKind(value)) return value;
  pushDiag(diagnostics, 'invalid_field', `${field} is not a valid brief kind`);
  return undefined;
}

const ALLOWED_ENTRY_KEYS = new Set(['backend', 'model', 'fallbacks', 'role', 'briefKind', 'description']);
const ALLOWED_FALLBACK_KEYS = new Set(['backend', 'model']);

function parseRuntimeFallbackChainInto(
  value: unknown,
  field: string,
  diagnostics: TaskTypeDiagnostic[],
): RuntimeFallbackBinding[] | undefined {
  if (!Array.isArray(value)) {
    pushDiag(diagnostics, 'invalid_field', `${field} must be an array`);
    return undefined;
  }
  if (value.length > RUNTIME_FALLBACK_MAX) {
    pushDiag(diagnostics, 'invalid_field', `${field} exceeds ${RUNTIME_FALLBACK_MAX} entries`);
    return undefined;
  }
  const bindings: RuntimeFallbackBinding[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryField = `${field}[${index}]`;
    if (!isPlainObject(entry)) {
      pushDiag(diagnostics, 'invalid_field', `${entryField} must be an object`);
      return undefined;
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_FALLBACK_KEYS.has(key)) {
        pushDiag(diagnostics, 'unknown_key', `${entryField} has unknown key "${boundIdent(key, 40)}"`);
      }
    }
    const backend = clampOrRejectString(
      entry.backend,
      `${entryField}.backend`,
      TASK_TYPE_STRING_MAX,
      diagnostics,
    );
    if (backend === undefined) return undefined;
    const binding: RuntimeFallbackBinding = { backend };
    if (entry.model !== undefined) {
      const model = clampOrRejectString(
        entry.model,
        `${entryField}.model`,
        TASK_TYPE_STRING_MAX,
        diagnostics,
      );
      if (model === undefined) return undefined;
      binding.model = model;
    }
    bindings.push(binding);
  }
  return bindings;
}

/** Parse the global execution fallback setting. Invalid input fails closed. */
export function parseRuntimeFallbackChain(raw: unknown): readonly RuntimeFallbackBinding[] {
  const diagnostics: TaskTypeDiagnostic[] = [];
  const parsed = parseRuntimeFallbackChainInto(raw, 'muster.execution.fallbacks', diagnostics);
  return diagnostics.length === 0 ? (parsed ?? []) : [];
}

/**
 * Parse raw VS Code / JSON setting value into a registry result.
 * Fail-closed: unknown keys, bad types, oversize → status invalid.
 * Missing / null / {} → status empty.
 */
export function parseTaskTypeRegistry(raw: unknown): TaskTypeRegistryResult {
  if (raw === undefined || raw === null) {
    return { status: 'empty', registry: new Map(), diagnostics: [] };
  }

  if (!isPlainObject(raw)) {
    return {
      status: 'invalid',
      registry: new Map(),
      diagnostics: [diag('invalid_shape', 'muster.taskTypes must be an object map')],
    };
  }

  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return { status: 'empty', registry: new Map(), diagnostics: [] };
  }

  if (keys.length > TASK_TYPE_MAX) {
    return {
      status: 'invalid',
      registry: new Map(),
      diagnostics: [
        diag('too_many_types', `muster.taskTypes exceeds max of ${TASK_TYPE_MAX} types`),
      ],
    };
  }

  const diagnostics: TaskTypeDiagnostic[] = [];
  const registry = new Map<string, TaskTypeDefinition>();

  for (const id of keys) {
    const idLabel = boundIdent(id);
    if (!TASK_TYPE_ID_RE.test(id)) {
      pushDiag(
        diagnostics,
        'invalid_type_id',
        `task type id "${idLabel}" must match ${TASK_TYPE_ID_RE.source}`,
      );
      continue;
    }

    const entry = raw[id];
    if (!isPlainObject(entry)) {
      pushDiag(diagnostics, 'invalid_entry', `task type "${idLabel}" must be an object`);
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (!ALLOWED_ENTRY_KEYS.has(key)) {
        pushDiag(
          diagnostics,
          'unknown_key',
          `task type "${idLabel}" has unknown key "${boundIdent(key, 40)}"`,
        );
      }
    }

    const backend = clampOrRejectString(
      entry.backend,
      `task type "${idLabel}".backend`,
      TASK_TYPE_STRING_MAX,
      diagnostics,
    );
    if (backend === undefined) continue;

    let model: string | undefined;
    if (entry.model !== undefined) {
      model = clampOrRejectString(
        entry.model,
        `task type "${idLabel}".model`,
        TASK_TYPE_STRING_MAX,
        diagnostics,
      );
      if (model === undefined) continue;
    }

    let fallbacks: RuntimeFallbackBinding[] | undefined;
    if (entry.fallbacks !== undefined) {
      fallbacks = parseRuntimeFallbackChainInto(
        entry.fallbacks,
        `task type "${idLabel}".fallbacks`,
        diagnostics,
      );
      if (fallbacks === undefined) continue;
    }

    const role = parseRole(entry.role, `task type "${idLabel}".role`, diagnostics);
    if (entry.role !== undefined && role === undefined) continue;

    const briefKind = parseBriefKind(
      entry.briefKind,
      `task type "${idLabel}".briefKind`,
      diagnostics,
    );
    if (entry.briefKind !== undefined && briefKind === undefined) continue;

    let description: string | undefined;
    if (entry.description !== undefined) {
      description = clampOrRejectString(
        entry.description,
        `task type "${idLabel}".description`,
        TASK_TYPE_DESCRIPTION_MAX,
        diagnostics,
      );
      if (description === undefined) continue;
    }

    const def: TaskTypeDefinition = { backend };
    if (model !== undefined) def.model = model;
    if (fallbacks !== undefined) def.fallbacks = fallbacks;
    if (role !== undefined) def.role = role;
    if (briefKind !== undefined) def.briefKind = briefKind;
    if (description !== undefined) def.description = description;
    registry.set(id, def);
  }

  if (diagnostics.length > 0) {
    return { status: 'invalid', registry: new Map(), diagnostics };
  }

  if (registry.size === 0) {
    return { status: 'empty', registry: new Map(), diagnostics: [] };
  }

  return { status: 'ok', registry, diagnostics: [] };
}

/**
 * Resolve create/delegate routing from a registry result + agent overrides.
 * Does not construct backends — caller validates factory allowlist.
 */
export function resolveCreateChildSpec(
  input: ResolveCreateChildInput,
  result: TaskTypeRegistryResult,
): ResolveCreateChildResult {
  if (result.status === 'invalid') {
    const first = result.diagnostics[0];
    return {
      ok: false,
      code: 'invalid_task_type_config',
      message: first?.message ?? 'muster.taskTypes is malformed',
    };
  }

  if (result.status === 'empty' || result.registry.size === 0) {
    return {
      ok: false,
      code: 'task_types_not_configured',
      message: 'No task types configured. Set muster.taskTypes in workspace settings.',
    };
  }

  const taskType = typeof input.taskType === 'string' ? input.taskType.trim() : '';
  if (!taskType) {
    return {
      ok: false,
      code: 'unknown_task_type',
      message: 'taskType is required',
    };
  }

  const preset = result.registry.get(taskType);
  if (!preset) {
    return {
      ok: false,
      code: 'unknown_task_type',
      message: boundMessage(`Unknown task type "${boundIdent(taskType)}"`),
    };
  }

  const explicitBackend =
    typeof input.backend === 'string' && input.backend.trim().length > 0
      ? input.backend.trim()
      : undefined;
  const explicitModel =
    typeof input.model === 'string' && input.model.trim().length > 0
      ? input.model.trim()
      : undefined;

  const backend = explicitBackend ?? preset.backend;
  // Changing backend without explicit model drops preset model (no Codex id on Grok).
  const model =
    explicitModel ?? (backend === preset.backend ? preset.model : undefined);
  const role = input.role ?? preset.role ?? 'worker';
  const briefKind = input.briefKind ?? preset.briefKind ?? 'generic';

  const resolved: ResolvedCreateChild = {
    taskType,
    backend,
    role,
    briefKind,
  };
  if (model !== undefined) resolved.model = model;

  return { ok: true, resolved };
}

/** Compact summary row for list_task_types / host context. */
export interface TaskTypeSummary {
  id: string;
  description?: string;
  backend: string;
  model?: string;
  defaultRole: TaskRole;
  defaultBriefKind: TaskBriefKind;
  availability: 'available' | 'unavailable' | 'unknown';
}

export function summarizeTaskTypes(
  result: TaskTypeRegistryResult,
  availabilityOf?: (backend: string) => 'available' | 'unavailable' | 'unknown',
): { taskTypes: TaskTypeSummary[]; diagnostics: readonly TaskTypeDiagnostic[] } {
  if (result.status !== 'ok') {
    return { taskTypes: [], diagnostics: result.diagnostics };
  }

  const taskTypes: TaskTypeSummary[] = [];
  for (const [id, def] of result.registry) {
    const row: TaskTypeSummary = {
      id,
      backend: def.backend,
      defaultRole: def.role ?? 'worker',
      defaultBriefKind: def.briefKind ?? 'generic',
      availability: availabilityOf?.(def.backend) ?? 'unknown',
    };
    if (def.model !== undefined) row.model = def.model;
    if (def.description !== undefined) row.description = def.description;
    taskTypes.push(row);
  }
  taskTypes.sort((a, b) => a.id.localeCompare(b.id));
  return { taskTypes, diagnostics: result.diagnostics };
}
